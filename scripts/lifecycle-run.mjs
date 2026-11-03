/** Ordered configured-source reload/relaunch verification and task-owned cleanup. */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_LIFECYCLE_MODEL, DEFAULT_TIMEOUT_MS } from "./lifecycle-defaults.mjs";
import {
	copyPackageSource,
	createFakeAgentBrowserBinary,
	lifecycleSentinelCommand,
	pathExists,
	writeLifecycleSentinel,
	writeSettings,
} from "./lifecycle-fixture.mjs";
import { fakeAgentBrowserScript } from "./lifecycle-fake-browser.mjs";
import {
	agentBrowserResults,
	collectFullOutputPaths,
	matchesSuccessfulPageResult,
	readEntries,
	record,
	resultText,
	sessionHeaderId,
	sleep,
	waitFor,
	waitForAgentBrowserResult,
	waitForAssistantFinal,
	waitForSentinel,
} from "./lifecycle-transcript.mjs";
import {
	capturePane,
	capturePaneText,
	createLifecycleSessionId,
	killTmuxSession,
	launchPiInTmux,
	paneLooksReady,
	sendLine,
} from "./lifecycle-tmux.mjs";

const EXPECTED_URL = "https://react.dev/";
const CODE_URL = "https://react.dev/learn";

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function assertFileExists(filePath, label) {
	assert(await pathExists(filePath), `${label} does not exist: ${filePath}`);
}

function buildToolInputPrompt(params, extra = "", tool = "agent_browser") {
	return `Use exactly one ${tool} tool call with input ${JSON.stringify(params)}${extra} Do not use bash. After the tool result, briefly report the result.`;
}

function buildPrompt(args, extra = "") {
	return buildToolInputPrompt({ args }, extra);
}

async function runPromptAndWaitForResult({
	describe,
	prompt,
	sessionFile,
	timeoutMs,
	tmuxSession,
	predicate,
	verbose,
}) {
	const beforeEntries = await readEntries(sessionFile);
	const beforeResults = agentBrowserResults(beforeEntries).length;
	if (verbose) {
		console.log(`→ ${describe}`);
	}
	await sendLine(tmuxSession, prompt);
	const report = await waitForAgentBrowserResult({
		describe,
		sessionFile,
		timeoutMs,
		sinceCount: beforeResults,
		predicate,
	});
	await waitForAssistantFinal({
		describe,
		sessionFile,
		sinceEntryCount: beforeEntries.length,
		timeoutMs,
	});
	return report;
}

async function waitForPrompt(runtime, describe) {
	await waitFor({
		describe,
		timeoutMs: runtime.timeoutMs,
		predicate: async () => {
			const pane = await capturePaneText(runtime.tmuxSession);
			return paneLooksReady(pane) ? pane : undefined;
		},
	});
}

async function initialLifecycle(runtime) {
	const {
		packageDir,
		repoRoot,
		artifactsDir,
		agentDir,
		sessionDir,
		fakeBinDir,
		timeoutMs,
		tmuxSession,
		sessionId,
		verbose,
	} = runtime;
	await mkdir(artifactsDir, { recursive: true });
	await mkdir(sessionDir, { recursive: true });
	await copyPackageSource({ packageDir, repoRoot });
	await writeLifecycleSentinel({ packageDir, token: "v1" });
	await createFakeAgentBrowserBinary(fakeBinDir, fakeAgentBrowserScript());
	const settings = await writeSettings({ agentDir, packageDir, sessionDir });
	assert(
		settings.packages.length === 1 && settings.packages[0] === packageDir,
		"Isolated settings must use exactly one configured package source.",
	);
	assert(
		settings.extensions.length === 0 &&
			settings.skills.length === 0 &&
			settings.prompts.length === 0 &&
			settings.themes.length === 0,
		"Isolated settings must clear local resource arrays.",
	);
	if (verbose) {
		console.log(`Temp root: ${runtime.tempRoot}`);
		console.log(`Launching Pi in tmux with model ${runtime.model} and session id ${sessionId}...`);
	}
	await launchPiInTmux({
		...runtime,
		cwd: repoRoot,
		paneLogPath: join(artifactsDir, "initial-pane-stream.txt"),
	});
	await waitForPrompt(runtime, "Pi prompt readiness");
	await sleep(1000);
	if (verbose) {
		console.log("→ initial managed open");
	}
	await sendLine(
		tmuxSession,
		buildToolInputPrompt({ args: ["open", EXPECTED_URL], sessionMode: "fresh" }),
	);
	return waitForAgentBrowserResult({
		describe: "initial managed open result",
		sessionDir,
		timeoutMs,
		sinceCount: 0,
		predicate: (result) => matchesSuccessfulPageResult(result, "open", EXPECTED_URL),
	});
}

async function reloadLifecycle(runtime, openReport) {
	const { sessionFile } = openReport;
	const { timeoutMs, tmuxSession, packageDir } = runtime;
	assert(sessionFile, "Pi did not create a session file.");
	assert(
		sessionHeaderId(openReport.entries) === runtime.sessionId,
		`Pi session header id ${JSON.stringify(sessionHeaderId(openReport.entries))} did not match requested lifecycle session id ${JSON.stringify(runtime.sessionId)}.`,
	);
	await waitForAssistantFinal({
		describe: "initial managed open",
		sessionFile,
		sinceEntryCount: 0,
		timeoutMs,
	});
	const sessionName = openReport.result.details?.sessionName;
	assert(
		typeof sessionName === "string" && sessionName.length > 0,
		"Initial open did not report details.sessionName.",
	);
	assert(
		record(openReport.result.details?.managedSessionOutcome)?.status === "created",
		"Initial fresh open did not create a managed session.",
	);
	const common = { sessionFile, timeoutMs, tmuxSession, verbose: runtime.verbose };
	const codeNavigation = await runPromptAndWaitForResult({
		...common,
		describe: "persistent code navigation before reload",
		prompt: buildToolInputPrompt(
			{ code: `emit((await browser({args:["open",${JSON.stringify(CODE_URL)}]})).data);` },
			"",
			"agent_browser_code",
		),
		predicate: (result) =>
			result.isError === false &&
			record(result.details?.data)?.url === CODE_URL &&
			record(result.details?.codeRun)?.callCount === 1,
	});
	assert(
		codeNavigation.result.details?.sessionName === sessionName,
		"Code navigation used a different browser.",
	);
	await sendLine(tmuxSession, `/${lifecycleSentinelCommand("v1")}`);
	await waitForSentinel({ sessionFile, timeoutMs, token: "v1" });
	await writeLifecycleSentinel({ packageDir, token: "v2" });
	await sendLine(tmuxSession, "/reload");
	await sleep(3000);
	const reloadSnapshot = await runPromptAndWaitForResult({
		...common,
		describe: "post-reload same-page snapshot",
		prompt: buildPrompt(["snapshot", "-i"]),
		predicate: (result) => matchesSuccessfulPageResult(result, "snapshot", CODE_URL),
	});
	assert(
		reloadSnapshot.result.details?.sessionName === sessionName,
		"Post-reload snapshot used a different managed session name.",
	);
	assert(
		reloadSnapshot.result.details?.usedImplicitSession === true,
		"Post-reload snapshot did not reuse the managed session.",
	);
	const largeReport = await runPromptAndWaitForResult({
		...common,
		describe: "large eval output spill",
		prompt: buildPrompt(["eval", "--stdin"], " and stdin set to document.body.innerText."),
		predicate: (result) => collectFullOutputPaths([result]).length > 0,
	});
	const [fullOutputPath] = collectFullOutputPaths([largeReport.result]);
	assert(typeof fullOutputPath === "string", "Large eval did not expose details.fullOutputPath.");
	await assertFileExists(fullOutputPath, "Large-output fullOutputPath");
	return { sessionFile, sessionName, fullOutputPath };
}

async function resumeLifecycle(runtime, observed) {
	const { artifactsDir, tmuxSession, timeoutMs } = runtime;
	const { sessionFile, sessionName, fullOutputPath } = observed;
	await capturePane(tmuxSession, join(artifactsDir, "before-restart-pane.txt"));
	await killTmuxSession(tmuxSession);
	if (runtime.verbose) {
		console.log("Relaunching Pi with exact prior session id...");
	}
	await launchPiInTmux({
		...runtime,
		cwd: runtime.repoRoot,
		paneLogPath: join(artifactsDir, "relaunch-pane-stream.txt"),
	});
	await waitForPrompt(runtime, "relaunched Pi prompt readiness");
	await sendLine(tmuxSession, `/${lifecycleSentinelCommand("v2")}`);
	await waitForSentinel({ sessionFile, timeoutMs, token: "v2" });
	const common = { sessionFile, timeoutMs, tmuxSession, verbose: runtime.verbose };
	const resumeSnapshot = await runPromptAndWaitForResult({
		...common,
		describe: "post-relaunch exact-session snapshot",
		prompt: buildPrompt(["snapshot", "-i"]),
		predicate: (result) => matchesSuccessfulPageResult(result, "snapshot", CODE_URL),
	});
	assert(
		resumeSnapshot.result.details?.sessionName === sessionName,
		"Post-relaunch snapshot used a different managed session name.",
	);
	assert(
		resumeSnapshot.result.details?.usedImplicitSession === true,
		"Post-relaunch snapshot did not reuse the managed session.",
	);
	await assertFileExists(fullOutputPath, "Previously persisted fullOutputPath after relaunch");
	const qaFailureReport = await runPromptAndWaitForResult({
		...common,
		describe: "qa reclassification failure patch",
		prompt: `First use agent_browser_tools with {"enable":["qa"]}. Then ${buildToolInputPrompt({ url: "https://fail.example.test/", expectedText: ["Welcome"], expectedSelector: "main" }, "", "agent_browser_qa")}`,
		predicate: (result) =>
			result?.details?.failureCategory === "qa-failure" &&
			result?.details?.resultCategory === "failure" &&
			result?.isError === true,
	});
	const qaText = resultText(qaFailureReport.result);
	assert(
		qaText.includes('"success":false') && qaText.includes('"failureCategory":"qa-failure"'),
		"QA failure was not visible in the canonical observation.",
	);
	assert(
		qaText.includes(
			"Result category: failure; failureCategory: qa-failure; Pi tool isError: true.",
		),
		"QA failure transcript row did not include the Pi isError patch notice.",
	);
	await capturePane(tmuxSession, join(artifactsDir, "success-pane.txt"));
}

async function captureFailure(runtime, sessionFile) {
	const { artifactsDir, tmuxSession } = runtime;
	await mkdir(artifactsDir, { recursive: true }).catch(() => {
		// Preserve the original failure if evidence storage cannot be created.
	});
	await capturePane(tmuxSession, join(artifactsDir, "failure-pane.txt"));
	if (sessionFile && (await pathExists(sessionFile))) {
		await cp(sessionFile, join(artifactsDir, basename(sessionFile))).catch(() => {
			// The original failure remains authoritative if its transcript copy fails.
		});
	}
}

async function cleanupLifecycle(runtime, failure) {
	const { artifactsDir, tmuxSession, tempRoot } = runtime;
	await capturePane(tmuxSession, join(artifactsDir, "final-pane.txt")).catch(() => {
		// Evidence capture must not prevent terminating the task-owned Pi session.
	});
	await killTmuxSession(tmuxSession);
	if (!runtime.keepArtifacts && !failure) {
		// Preserve Pi transcripts and evidence; remove only disposable runtime inputs.
		for (const path of [
			runtime.packageDir,
			runtime.fakeBinDir,
			runtime.fakeStateDir,
			runtime.agentDir,
		]) {
			// Remove one task-owned runtime tree at a time after Pi has stopped, bounding cleanup I/O.
			// oxlint-disable-next-line no-await-in-loop
			await rm(path, { force: true, recursive: true });
		}
	} else {
		console.error(
			`${failure ? "Lifecycle artifacts retained for debugging" : "Lifecycle artifacts retained"}: ${tempRoot}`,
		);
	}
}

export async function verifyLifecycle(options = {}) {
	const tempRoot = await mkdtemp(join(tmpdir(), "piab-lifecycle-"));
	const sessionId = createLifecycleSessionId(process.pid);
	const runtime = {
		repoRoot: options.repoRoot ?? process.cwd(),
		model: options.model ?? DEFAULT_LIFECYCLE_MODEL,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		keepArtifacts: options.keepArtifacts ?? false,
		verbose: options.verbose ?? false,
		tempRoot,
		artifactsDir: join(tempRoot, "artifacts"),
		agentDir: join(tempRoot, "agent"),
		sessionDir: join(tempRoot, "sessions"),
		packageDir: join(tempRoot, "package-under-test"),
		fakeBinDir: join(tempRoot, "fake-bin"),
		fakeStateDir: join(tempRoot, "fake-browser-state"),
		sessionId,
		tmuxSession: sessionId,
	};
	let sessionFile;
	let failure;
	try {
		const openReport = await initialLifecycle(runtime);
		sessionFile = openReport.sessionFile;
		const observed = await reloadLifecycle(runtime, openReport);
		await resumeLifecycle(runtime, observed);
		return { artifactsDir: runtime.artifactsDir, ...observed, sessionId, tempRoot };
	} catch (error) {
		failure = error;
		await captureFailure(runtime, sessionFile);
		throw error;
	} finally {
		await cleanupLifecycle(runtime, failure);
	}
}
