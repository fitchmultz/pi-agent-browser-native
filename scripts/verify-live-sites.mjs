#!/usr/bin/env node
/** Interactive, isolated real-site release smoke through Pi's native browser tools. */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	agentBrowserResults,
	matchesSuccessfulPageResult,
	readEntries,
	record,
	sessionHeaderId,
	sleep,
	waitFor,
	waitForAgentBrowserResult,
} from "./lifecycle-transcript.mjs";
import {
	capturePane,
	capturePaneText,
	killTmuxSession,
	launchPiInTmux,
	paneLooksReady,
	sendLine,
} from "./lifecycle-tmux.mjs";
import { packToTemporaryPackageDir } from "./package-pack.mjs";
import { installRuntimeConsumer } from "./package-pi.mjs";
import { parseCliArgs as lifecycleDefaults } from "./verify-lifecycle.mjs";

const execFile = promisify(execFileCallback);
const STATIC = "https://info.cern.ch/";
const DOCS = "https://react.dev/learn";
const model = process.env.PIAB_LIVE_MODEL || "zai/glm-5.3-flash";
const timeoutMs = lifecycleDefaults([]).timeoutMs;

function prompt(tool, input, suffix = "Briefly report the result.") {
	return `Use exactly one ${tool} tool call with input ${JSON.stringify(input)}. Do not use bash. ${suffix}`;
}

function textOfMessage(message) {
	return (message?.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function awaitFinal(sessionFile, toolCallId) {
	return waitFor({
		describe: `final response after ${toolCallId}`,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			const index = entries.findIndex(
				(entry) => entry.type === "message" && entry.message?.toolCallId === toolCallId,
			);
			if (index < 0) {
				return;
			}
			const final = entries
				.slice(index + 1)
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "assistant" &&
						entry.message.stopReason === "stop",
				);
			return final ? { entries, text: textOfMessage(final.message) } : undefined;
		},
	});
}

async function runPrompt(runtime, { description, tool, input, predicate, suffix }) {
	const { state } = runtime;
	const before = state.sessionFile ? await readEntries(state.sessionFile) : [];
	const count = agentBrowserResults(before).length;
	console.log(`→ ${description}`);
	await sendLine(runtime.tmuxSession, prompt(tool, input, suffix));
	const observed = await waitForAgentBrowserResult({
		describe: description,
		sessionFile: state.sessionFile,
		sessionDir: runtime.sessionDir,
		timeoutMs,
		sinceCount: count,
		predicate: (result) => result.toolName === tool && predicate(result),
	});
	state.sessionFile = observed.sessionFile;
	assert.equal(sessionHeaderId(observed.entries), runtime.sessionId, "Unexpected Pi session");
	const final = await awaitFinal(observed.sessionFile, observed.result.toolCallId);
	assert.equal(
		agentBrowserResults(final.entries).length,
		count + 1,
		"Prompt made unexpected browser calls",
	);
	return { ...observed, entries: final.entries, finalText: final.text };
}

function successful(result, command) {
	return (
		result.isError === false &&
		result.details?.resultCategory === "success" &&
		result.details.command === command
	);
}

function assertSameSession(result, sessionName) {
	assert.equal(
		result.details?.sessionName,
		sessionName,
		"Browser session changed during the smoke",
	);
}

function linkRef(snapshot) {
	const refs = record(record(snapshot.details?.refSnapshot)?.refs);
	const match = Object.entries(refs ?? {}).find(
		([, value]) =>
			record(value)?.role === "link" && record(value)?.name === "Browse the first website",
	);
	assert.ok(match, "Static-site snapshot did not expose its first-website link");
	return `@${match[0]}`;
}

function aggregateCode(baseline, screenshot) {
	return `const first = await browser({args:["open",${JSON.stringify(STATIC)}]});
const title = await browser({args:["get","title"]});
const baselineMatches = title.data?.title === ${JSON.stringify(baseline)};
const second = await browser({args:["open",${JSON.stringify(DOCS)}]});
const shot = await browser({args:["screenshot",${JSON.stringify(screenshot)}]});
globalThis.piabLiveMarker = true;
if (first.success && title.success && baselineMatches && second.success && shot.success && shot.artifactVerification?.verified && shot.imageObservations?.length) {
  emit({branch:"matched", baselineMatches, staticUrl:first.data.url, docsUrl:second.data.url, screenshotVerified:true});
  emitImage(shot.imageObservations[0]);
} else {
  emit({branch:"failed", first, title, baselineMatches, second, shot});
}`;
}

function assertOrderedCodeTransitions(entries, toolCallId) {
	const events = entries.flatMap((entry) =>
		entry.type === "custom" &&
		entry.customType === "agent-browser-transition" &&
		entry.data?.event?.toolCallId === toolCallId
			? [entry.data.event]
			: [],
	);
	const beginnings = new Map();
	let completed = 0;
	for (const [index, event] of events.entries()) {
		if (event.phase === "begin") {
			beginnings.set(event.operationId, index);
		}
		if (event.phase === "finish") {
			assert.ok(beginnings.has(event.operationId), "Transition finished before it began");
			assert.ok(beginnings.get(event.operationId) < index, "Transition order is invalid");
			completed += 1;
		}
	}
	assert.ok(completed >= 4, "Code aggregation did not retain its inner browser transitions");
}

async function openStaticSite(runtime) {
	await waitFor({
		describe: "interactive Pi readiness",
		timeoutMs,
		predicate: async () => {
			const pane = await capturePaneText(runtime.tmuxSession);
			return paneLooksReady(pane) ? pane : undefined;
		},
	});
	const opened = await runPrompt(runtime, {
		description: "open the static site",
		tool: "agent_browser",
		input: { args: ["open", STATIC], sessionMode: "fresh" },
		predicate: (result) => matchesSuccessfulPageResult(result, "open", STATIC),
	});
	const sessionName = opened.result.details?.sessionName;
	assert.ok(
		typeof sessionName === "string" && sessionName.length > 0,
		"Missing owned browser session",
	);
	assert.equal(opened.result.details.managedSessionOutcome?.status, "created");
	const snapshot = await runPrompt(runtime, {
		description: "snapshot static-site controls",
		tool: "agent_browser",
		input: { args: ["snapshot", "-i"] },
		predicate: (result) => matchesSuccessfulPageResult(result, "snapshot", STATIC),
	});
	assertSameSession(snapshot.result, sessionName);
	const ref = linkRef(snapshot.result);
	const baseline = await runPrompt(runtime, {
		description: "capture direct title baseline",
		tool: "agent_browser",
		input: { args: ["get", "title"] },
		predicate: (result) => successful(result, "get"),
	});
	assertSameSession(baseline.result, sessionName);
	const baselineTitle = record(baseline.result.details.data)?.title;
	assert.equal(typeof baselineTitle, "string", "Missing direct title baseline");
	const clicked = await runPrompt(runtime, {
		description: "follow the observed link",
		tool: "agent_browser",
		input: { args: ["click", ref] },
		predicate: (result) => successful(result, "click"),
	});
	assertSameSession(clicked.result, sessionName);
	const destination = await runPrompt(runtime, {
		description: "verify link navigation",
		tool: "agent_browser",
		input: { args: ["get", "url"] },
		predicate: (result) => successful(result, "get"),
	});
	assertSameSession(destination.result, sessionName);
	const destinationUrl = record(destination.result.details.data)?.url;
	assert.ok(
		typeof destinationUrl === "string" &&
			destinationUrl !== STATIC &&
			destinationUrl.includes("info.cern.ch"),
		"The observed link did not navigate within the first-website archive",
	);
	return { sessionName, baselineTitle };
}

async function verifySelectedScreenshot(code, screenshot) {
	const image = code.result.content?.find(
		(part) => part.type === "image" && typeof part.data === "string",
	);
	assert.ok(image, "The selected screenshot bytes did not reach the Pi tool result");
	assert.match(
		code.finalText,
		/quick\s+start/i,
		"The vision model did not identify the displayed docs heading",
	);
	assertOrderedCodeTransitions(code.entries, code.result.toolCallId);
	const screenshotBytes = await readFile(screenshot);
	const screenshotSha256 = createHash("sha256").update(screenshotBytes).digest("hex");
	assert.equal(
		createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"),
		screenshotSha256,
		"Pi's image content differs from the verified screenshot",
	);
	return screenshotSha256;
}

async function openDocumentation(runtime, { sessionName, baselineTitle }) {
	const screenshot = join(runtime.outputDir, "react-docs.png");
	const code = await runPrompt(runtime, {
		description: "aggregate two sites and send the screenshot to the model",
		tool: "agent_browser_code",
		input: { code: aggregateCode(baselineTitle, screenshot) },
		predicate: (result) =>
			result.isError === false && record(result.details?.data)?.branch === "matched",
		suffix: "State the main heading visible in the attached screenshot, not the page title.",
	});
	assertSameSession(code.result, sessionName);
	const data = record(code.result.details.data);
	assert.equal(data?.baselineMatches, true);
	assert.equal(data?.staticUrl, STATIC);
	assert.equal(data?.docsUrl, DOCS);
	assert.equal(data?.screenshotVerified, true);
	const screenshotSha256 = await verifySelectedScreenshot(code, screenshot);
	const docs = await runPrompt(runtime, {
		description: "snapshot the documentation site",
		tool: "agent_browser",
		input: { args: ["snapshot", "-i"] },
		predicate: (result) => matchesSuccessfulPageResult(result, "snapshot", DOCS),
	});
	assertSameSession(docs.result, sessionName);
	assert.ok(
		Object.keys(record(record(docs.result.details.refSnapshot)?.refs) ?? {}).length > 0,
		"Documentation snapshot had no interactive refs",
	);
	return screenshotSha256;
}

async function verifyReloadAndClose(runtime, sessionName) {
	await sendLine(runtime.tmuxSession, "/reload");
	await sleep(3000);
	const afterReload = await runPrompt(runtime, {
		description: "verify the page after reload",
		tool: "agent_browser",
		input: { args: ["get", "url"] },
		predicate: (result) => successful(result, "get"),
	});
	assertSameSession(afterReload.result, sessionName);
	assert.equal(record(afterReload.result.details.data)?.url, DOCS);
	const freshCode = await runPrompt(runtime, {
		description: "verify fresh JavaScript and persistent browser state",
		tool: "agent_browser_code",
		input: {
			code: 'const current = await browser({args:["get","url"]}); emit({fresh:typeof globalThis.piabLiveMarker === "undefined", current:current.data, success:current.success});',
		},
		predicate: (result) => result.isError === false && record(result.details?.data)?.fresh === true,
	});
	assertSameSession(freshCode.result, sessionName);
	assert.equal(record(record(freshCode.result.details.data)?.current)?.url, DOCS);
	assert.equal(record(freshCode.result.details.data)?.success, true);
	const closed = await runPrompt(runtime, {
		description: "close the owned browser",
		tool: "agent_browser",
		input: { args: ["close"] },
		predicate: (result) => successful(result, "close"),
	});
	assertSameSession(closed.result, sessionName);
	assert.equal(closed.result.details.managedSessionOutcome?.status, "closed");
	const { state } = runtime;
	state.closed = true;
}

async function smoke(runtime) {
	const identity = await openStaticSite(runtime);
	const screenshotSha256 = await openDocumentation(runtime, identity);
	await verifyReloadAndClose(runtime, identity.sessionName);
	return {
		model,
		staticUrl: STATIC,
		docsUrl: DOCS,
		sessionName: identity.sessionName,
		sessionId: runtime.sessionId,
		screenshotSha256,
	};
}

async function cleanup(runtime) {
	await capturePane(runtime.tmuxSession, join(runtime.outputDir, "final-pane.txt"));
	await killTmuxSession(runtime.tmuxSession);
	if (!runtime.state.closed) {
		// The socket directory is created exclusively for this run; never touch another browser.
		await execFile("agent-browser", ["--json", "close", "--all"], {
			env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: runtime.socketDir },
		});
	}
	await rm(runtime.socketDir, { recursive: true, force: true });
}

async function createRuntime() {
	const outputDir = resolve(
		process.env.PIAB_LIVE_OUTPUT || (await mkdtemp("/tmp/piab-live-evidence-")),
	);
	const socketDir = await mkdtemp("/tmp/pb-");
	const sessionId = `piab-live-${process.pid}`;
	const runtime = {
		outputDir,
		socketDir,
		sessionId,
		tmuxSession: sessionId,
		agentDir: join(outputDir, "agent"),
		sessionDir: join(outputDir, "sessions"),
		state: { closed: false },
	};
	await mkdir(runtime.agentDir, { recursive: true });
	await mkdir(runtime.sessionDir, { recursive: true });
	await writeFile(
		join(runtime.agentDir, "settings.json"),
		JSON.stringify(
			{
				sessionDir: runtime.sessionDir,
				packages: [],
				extensions: [],
				skills: [],
				prompts: [],
				themes: [],
			},
			null,
			2,
		),
	);
	process.env.PI_AGENT_BROWSER_SOCKET_DIR = socketDir;
	return runtime;
}

async function prepareCandidate() {
	const tarball = process.env.PI_AGENT_BROWSER_RELEASE_TARBALL;
	if (!tarball) {
		return { extensionPath: "." };
	}
	const candidate = await packToTemporaryPackageDir(process.cwd(), tarball);
	try {
		candidate.sha256 = createHash("sha256")
			.update(await readFile(candidate.tarballPath))
			.digest("hex");
		const extensionPath = await installRuntimeConsumer(candidate.tarballPath);
		return { candidate, extensionPath };
	} catch (error) {
		await candidate.cleanup();
		throw error;
	}
}

async function launch(runtime, extensionPath) {
	await launchPiInTmux({
		...runtime,
		cwd: process.cwd(),
		model,
		piCommand: process.env.PIAB_LIVE_PI || "pi",
		paneLogPath: join(runtime.outputDir, "pane-stream.txt"),
		launchArgs: [
			"--approve",
			"--no-extensions",
			"--no-skills",
			"-e",
			extensionPath,
			"--tools",
			"agent_browser,agent_browser_code",
			"--model",
			model,
			"--session-id",
			runtime.sessionId,
		],
	});
}

async function candidateEvidence(candidate, extensionPath) {
	if (!candidate) {
		return {};
	}
	assert.equal(
		createHash("sha256")
			.update(await readFile(candidate.tarballPath))
			.digest("hex"),
		candidate.sha256,
		"Retained candidate changed during the live-site smoke",
	);
	return {
		candidate: {
			sha256: candidate.sha256,
			integrity: candidate.packResult.integrity,
			package: candidate.packResult.name,
			version: candidate.packResult.version,
			extensionPath,
		},
	};
}

async function attemptCleanup(label, action, failure) {
	try {
		await action();
	} catch (error) {
		if (!failure) {
			return error;
		}
		console.error(
			`${label} also failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return failure;
}

async function finish(runtime, candidate, initialFailure) {
	let failure = await attemptCleanup("Cleanup", () => cleanup(runtime), initialFailure);
	failure = await attemptCleanup("Candidate cleanup", () => candidate?.cleanup(), failure);
	if (runtime.state.sessionFile) {
		console.log(`Session transcript: ${runtime.state.sessionFile}`);
	}
	console.log(`Evidence directory: ${basename(runtime.outputDir)} at ${runtime.outputDir}`);
	return failure;
}

async function main() {
	const runtime = await createRuntime();
	let candidate;
	let failure;
	try {
		const prepared = await prepareCandidate();
		candidate = prepared.candidate;
		await launch(runtime, prepared.extensionPath);
		const report = {
			...(await smoke(runtime)),
			...(await candidateEvidence(candidate, prepared.extensionPath)),
		};
		await writeFile(
			join(runtime.outputDir, "summary.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
	} catch (error) {
		failure = error;
	}
	failure = await finish(runtime, candidate, failure);
	if (failure) {
		throw failure;
	}
	console.log(`Live-site Pi smoke passed: ${runtime.outputDir}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
