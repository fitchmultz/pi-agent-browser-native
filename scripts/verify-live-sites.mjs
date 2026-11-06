#!/usr/bin/env node
/** Interactive, isolated real-site release smoke through Pi's native browser tools. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { matchesSuccessfulPageResult, record, sleep, waitFor } from "./lifecycle-transcript.mjs";
import { capturePaneText, paneLooksReady, sendLine } from "./lifecycle-tmux.mjs";
import { packToTemporaryPackageDir } from "./package-pack.mjs";
import { installRuntimeConsumer } from "./package-pi.mjs";
import { parseCliArgs as lifecycleDefaults } from "./verify-lifecycle.mjs";

import { createLiveSiteRun } from "./live-site-runtime.mjs";
/** @import {LiveSiteRun} from "./live-site-runtime.mjs" */
/** @import {LifecycleToolResult} from "./lifecycle-transcript.mjs" */
/** @typedef {Awaited<ReturnType<LiveSiteRun["prompt"]>>} LiveResult */
/** @typedef {Awaited<ReturnType<typeof packToTemporaryPackageDir>> & {sha256: string}} LiveCandidate */
const STATIC = "https://info.cern.ch/";
const DOCS = "https://react.dev/learn";
const configuredModel = process.env.PIAB_LIVE_MODEL;
const model =
	configuredModel === undefined || configuredModel === "" ? "zai/glm-5.3-flash" : configuredModel;
const timeoutMs = lifecycleDefaults([]).timeoutMs;

/** @param {LifecycleToolResult} result @param {string} command */
function successful(result, command) {
	return (
		result.isError === false &&
		result.details?.resultCategory === "success" &&
		result.details.command === command
	);
}

/** @param {LifecycleToolResult} result @param {string} sessionName */
function assertSameSession(result, sessionName) {
	assert.equal(
		result.details?.sessionName,
		sessionName,
		"Browser session changed during the smoke",
	);
}

/** @param {LifecycleToolResult} snapshot */
function linkRef(snapshot) {
	const refs = record(record(snapshot.details?.refSnapshot)?.refs);
	const match = Object.entries(refs ?? {}).find(
		([, value]) =>
			record(value)?.role === "link" && record(value)?.name === "Browse the first website",
	);
	assert.ok(match, "Static-site snapshot did not expose its first-website link");
	return `@${match[0]}`;
}

/** @param {string} baseline @param {string} screenshot */
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

/** @param {readonly unknown[]} entries @param {string} toolCallId */
function assertOrderedCodeTransitions(entries, toolCallId) {
	const events = entries.flatMap((entry) => {
		const row = record(entry);
		const event = record(record(row?.data)?.event);
		return row?.type === "custom" &&
			row.customType === "agent-browser-transition" &&
			event?.toolCallId === toolCallId
			? [event]
			: [];
	});
	/** @type {Map<unknown, number>} */
	const beginnings = new Map();
	let completed = 0;
	for (const [index, event] of events.entries()) {
		if (event.phase === "begin") {
			beginnings.set(event.operationId, index);
		}
		if (event.phase === "finish") {
			assert.ok(beginnings.has(event.operationId), "Transition finished before it began");
			const beginIndex = beginnings.get(event.operationId);
			assert.ok(beginIndex !== undefined && beginIndex < index, "Transition order is invalid");
			completed += 1;
		}
	}
	assert.ok(completed >= 4, "Code aggregation did not retain its inner browser transitions");
}

/** @param {LiveSiteRun} runtime */
async function openStaticSite(runtime) {
	await waitFor({
		describe: "interactive Pi readiness",
		timeoutMs,
		predicate: async () => {
			const pane = await capturePaneText(runtime.tmuxSession);
			return paneLooksReady(pane) ? pane : undefined;
		},
	});
	const opened = await runtime.prompt({
		description: "open the static site",
		tool: "agent_browser",
		input: { args: ["open", STATIC], sessionMode: "fresh" },
		predicate: (result) => matchesSuccessfulPageResult(result, "open", STATIC),
	});
	const details = opened.result.details;
	assert.ok(details, "Missing fresh-open details");
	const sessionName = details.sessionName;
	assert.ok(
		typeof sessionName === "string" && sessionName.length > 0,
		"Missing owned browser session",
	);
	assert.equal(record(details.managedSessionOutcome)?.status, "created");
	const snapshot = await runtime.prompt({
		description: "snapshot static-site controls",
		tool: "agent_browser",
		input: { args: ["snapshot", "-i"] },
		predicate: (result) => matchesSuccessfulPageResult(result, "snapshot", STATIC),
	});
	assertSameSession(snapshot.result, sessionName);
	const ref = linkRef(snapshot.result);
	const baseline = await runtime.prompt({
		description: "capture direct title baseline",
		tool: "agent_browser",
		input: { args: ["get", "title"] },
		predicate: (result) => successful(result, "get"),
	});
	assertSameSession(baseline.result, sessionName);
	const baselineTitle = record(baseline.result.details?.data)?.title;
	assert.ok(typeof baselineTitle === "string", "Missing direct title baseline");
	const clicked = await runtime.prompt({
		description: "follow the observed link",
		tool: "agent_browser",
		input: { args: ["click", ref] },
		predicate: (result) => successful(result, "click"),
	});
	assertSameSession(clicked.result, sessionName);
	const destination = await runtime.prompt({
		description: "verify link navigation",
		tool: "agent_browser",
		input: { args: ["get", "url"] },
		predicate: (result) => successful(result, "get"),
	});
	assertSameSession(destination.result, sessionName);
	const destinationUrl = record(destination.result.details?.data)?.url;
	assert.ok(
		typeof destinationUrl === "string" &&
			destinationUrl !== STATIC &&
			destinationUrl.includes("info.cern.ch"),
		"The observed link did not navigate within the first-website archive",
	);
	return { sessionName, baselineTitle };
}

/** @param {LiveResult} code @param {string} screenshot */
async function verifySelectedScreenshot(code, screenshot) {
	/** @type {readonly unknown[]} */
	const content = Array.isArray(code.result.content) ? code.result.content : [];
	const image = content
		.map(record)
		.find((part) => part?.type === "image" && typeof part.data === "string");
	assert.ok(
		typeof image?.data === "string",
		"The selected screenshot bytes did not reach the Pi tool result",
	);
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

/** @param {LiveSiteRun} runtime @param {{sessionName: string, baselineTitle: string}} identity */
async function openDocumentation(runtime, { sessionName, baselineTitle }) {
	const screenshot = join(runtime.outputDir, "react-docs.png");
	const code = await runtime.prompt({
		description: "aggregate two sites and send the screenshot to the model",
		tool: "agent_browser_code",
		input: { code: aggregateCode(baselineTitle, screenshot) },
		predicate: (result) =>
			result.isError === false && record(result.details?.data)?.branch === "matched",
		suffix: "State the main heading visible in the attached screenshot, not the page title.",
	});
	assertSameSession(code.result, sessionName);
	const data = record(code.result.details?.data);
	assert.equal(data?.baselineMatches, true);
	assert.equal(data.staticUrl, STATIC);
	assert.equal(data.docsUrl, DOCS);
	assert.equal(data.screenshotVerified, true);
	const screenshotSha256 = await verifySelectedScreenshot(code, screenshot);
	const docs = await runtime.prompt({
		description: "snapshot the documentation site",
		tool: "agent_browser",
		input: { args: ["snapshot", "-i"] },
		predicate: (result) => matchesSuccessfulPageResult(result, "snapshot", DOCS),
	});
	assertSameSession(docs.result, sessionName);
	assert.ok(
		Object.keys(record(record(docs.result.details?.refSnapshot)?.refs) ?? {}).length > 0,
		"Documentation snapshot had no interactive refs",
	);
	return screenshotSha256;
}

/** @param {LiveSiteRun} runtime @param {string} sessionName */
async function verifyReloadAndClose(runtime, sessionName) {
	await sendLine(runtime.tmuxSession, "/reload");
	await sleep(3000);
	const afterReload = await runtime.prompt({
		description: "verify the page after reload",
		tool: "agent_browser",
		input: { args: ["get", "url"] },
		predicate: (result) => successful(result, "get"),
	});
	assertSameSession(afterReload.result, sessionName);
	assert.equal(record(afterReload.result.details?.data)?.url, DOCS);
	const freshCode = await runtime.prompt({
		description: "verify fresh JavaScript and persistent browser state",
		tool: "agent_browser_code",
		input: {
			code: 'const current = await browser({args:["get","url"]}); emit({fresh:typeof globalThis.piabLiveMarker === "undefined", current:current.data, success:current.success});',
		},
		predicate: (result) => result.isError === false && record(result.details?.data)?.fresh === true,
	});
	assertSameSession(freshCode.result, sessionName);
	assert.equal(record(record(freshCode.result.details?.data)?.current)?.url, DOCS);
	assert.equal(record(freshCode.result.details?.data)?.success, true);
	await runtime.close(sessionName);
}

/** @param {LiveSiteRun} runtime */
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

async function prepareCandidate() {
	const tarball = process.env.PI_AGENT_BROWSER_RELEASE_TARBALL;
	if (tarball === undefined || tarball === "") {
		return { extensionPath: "." };
	}
	const candidate = await packToTemporaryPackageDir(process.cwd(), tarball);
	try {
		const sha256 = createHash("sha256")
			.update(await readFile(candidate.tarballPath))
			.digest("hex");
		const extensionPath = await installRuntimeConsumer(candidate.tarballPath);
		return { candidate: { ...candidate, sha256 }, extensionPath };
	} catch (error) {
		await candidate.cleanup();
		throw error;
	}
}

/** @param {LiveCandidate | undefined} candidate @param {string} extensionPath */
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

/** @param {string} label @param {() => Promise<void> | undefined} action @param {unknown} failure */
async function attemptCleanup(label, action, failure) {
	try {
		await action();
	} catch (error) {
		const hasFailure = Boolean(failure);
		if (!hasFailure) {
			return error;
		}
		console.error(
			`${label} also failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return failure;
}

/** @param {LiveSiteRun} runtime @param {LiveCandidate | undefined} candidate @param {unknown} initialFailure */
async function finish(runtime, candidate, initialFailure) {
	let failure = await attemptCleanup("Cleanup", () => runtime.cleanup(), initialFailure);
	failure = await attemptCleanup("Candidate cleanup", () => candidate?.cleanup(), failure);
	if (runtime.sessionFile !== undefined) {
		console.log(`Session transcript: ${runtime.sessionFile}`);
	}
	console.log(`Evidence directory: ${basename(runtime.outputDir)} at ${runtime.outputDir}`);
	return failure;
}

async function main() {
	const runtime = await createLiveSiteRun({ model, timeoutMs });
	/** @type {LiveCandidate | undefined} */
	let candidate;
	/** @type {unknown} */
	let failure;
	try {
		const prepared = await prepareCandidate();
		candidate = prepared.candidate;
		await runtime.launch(prepared.extensionPath);
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
	const hasFailure = Boolean(failure);
	if (hasFailure) {
		return Promise.reject(failure);
	}
	console.log(`Live-site Pi smoke passed: ${runtime.outputDir}`);
}

main().catch((/** @type {unknown} */ error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
