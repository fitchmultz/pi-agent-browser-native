/**
 * Purpose: Exercise the configured-source pi-agent-browser lifecycle path through a real tmux-driven Pi process.
 * Responsibilities: Create isolated Pi settings and a temporary package source, inject a deterministic reload sentinel, drive `/reload` plus restart/`/resume`, assert managed browser-session continuity and persisted artifact survival, capture transcripts, and clean up side effects.
 * Scope: Opt-in maintainer regression harness only; normal unit/package verification remains in the standard npm scripts.
 * Usage: Run with `node scripts/verify-lifecycle.mjs`, `npm run verify -- lifecycle`, or `node scripts/verify-lifecycle.mjs --keep-artifacts --verbose`.
 * Invariants/Assumptions: `pi` and `tmux` are available on PATH, the configured model can follow explicit tool-use prompts, and the temporary configured package path is the only active Pi package source.
 */

import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 180_000;
const EXPECTED_URL = "https://react.dev/";
const SENTINEL_CUSTOM_TYPE = "piab-lifecycle-sentinel";
const SENTINEL_MARKER_START = "// PIAB_LIFECYCLE_SENTINEL_START";
const SENTINEL_MARKER_END = "// PIAB_LIFECYCLE_SENTINEL_END";
const PROMPT_SUBMIT_PAUSE_MS = 250;

class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function printHelp() {
	console.log(`verify-lifecycle.mjs

Usage:
  node scripts/verify-lifecycle.mjs [options]

Options:
  --keep-artifacts    Keep the temporary Pi config, fake browser state, session files, and transcripts.
  --timeout-ms <ms>   Override per-step wait timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --verbose           Print progress while driving tmux.
  -h, --help          Show this help text.

Examples:
  npm run verify -- lifecycle
  npm run verify -- lifecycle --keep-artifacts
  node scripts/verify-lifecycle.mjs --keep-artifacts --verbose

Exit codes:
  0  Lifecycle verification passed.
  1  Lifecycle verification failed.
  2  Usage error.
`);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
	const options = {
		keepArtifacts: false,
		showHelp: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		verbose: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			return { ...options, showHelp: true };
		}
		if (arg === "--keep-artifacts") {
			options.keepArtifacts = true;
			continue;
		}
		if (arg === "--verbose") {
			options.verbose = true;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = argv[index + 1];
			if (!value) throw new UsageError("--timeout-ms requires a positive integer value.");
			index += 1;
			const timeoutMs = Number(value);
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
				throw new UsageError(`--timeout-ms must be a positive integer; received ${JSON.stringify(value)}.`);
			}
			options.timeoutMs = timeoutMs;
			continue;
		}
		throw new UsageError(`Unknown option: ${arg}`);
	}

	return options;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function run(command, args, options = {}) {
	return await execFile(command, args, {
		maxBuffer: 20 * 1024 * 1024,
		...options,
	});
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function normalizeComparableUrl(url) {
	if (typeof url !== "string" || url.trim().length === 0) return undefined;
	try {
		const parsed = new URL(url.trim());
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return url.trim();
	}
}

export function parseJsonl(text) {
	const entries = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid JSONL at line ${index + 1}: ${message}`);
		}
	}
	return entries;
}

async function readJsonlFile(filePath) {
	return parseJsonl(await readFile(filePath, "utf8"));
}

function isRecord(value) {
	return typeof value === "object" && value !== null;
}

export function agentBrowserResults(entries) {
	return entries
		.filter((entry) => entry?.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "agent_browser")
		.map((entry) => entry.message);
}

export function sentinelTokens(entries) {
	return entries
		.filter((entry) => entry?.type === "custom" && entry.customType === SENTINEL_CUSTOM_TYPE)
		.map((entry) => entry.data?.token)
		.filter((token) => typeof token === "string");
}

export function collectFullOutputPaths(results) {
	const paths = [];
	for (const result of results) {
		const details = isRecord(result?.details) ? result.details : undefined;
		if (typeof details?.fullOutputPath === "string") paths.push(details.fullOutputPath);
		if (Array.isArray(details?.fullOutputPaths)) {
			paths.push(...details.fullOutputPaths.filter((path) => typeof path === "string"));
		}
	}
	return [...new Set(paths)];
}

export function buildSettingsPayload({ packageDir, sessionDir }) {
	return {
		quietStartup: false,
		sessionDir,
		packages: [packageDir],
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
		enableInstallTelemetry: false,
	};
}

async function writeSettings({ agentDir, packageDir, sessionDir }) {
	await mkdir(agentDir, { recursive: true });
	const settings = buildSettingsPayload({ packageDir, sessionDir });
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	return settings;
}

async function copyPackageSource({ packageDir, repoRoot }) {
	await mkdir(packageDir, { recursive: true });
	await cp(resolve(repoRoot, "extensions"), resolve(packageDir, "extensions"), { recursive: true });
	await cp(resolve(repoRoot, "package.json"), resolve(packageDir, "package.json"));
	const repoNodeModules = resolve(repoRoot, "node_modules");
	const tempNodeModules = resolve(packageDir, "node_modules");
	if (await pathExists(repoNodeModules)) {
		await symlink(repoNodeModules, tempNodeModules, "dir").catch(() => undefined);
	}
}

export function injectLifecycleSentinelSource(source, token) {
	const withoutOldSentinel = source.replace(
		new RegExp(`\\n\\t${SENTINEL_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?\\n\\t${SENTINEL_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`),
		"\n",
	);
	const marker = "export default function agentBrowserExtension(pi: ExtensionAPI) {";
	const snippet = `
	${SENTINEL_MARKER_START}
	pi.registerCommand("piab-lifecycle-sentinel", {
		description: "Append the pi-agent-browser lifecycle sentinel token.",
		handler: async () => {
			pi.appendEntry("${SENTINEL_CUSTOM_TYPE}", { token: ${JSON.stringify(token)} });
		},
	});
	${SENTINEL_MARKER_END}
`;
	if (!withoutOldSentinel.includes(marker)) {
		throw new Error("Could not locate extension factory marker for lifecycle sentinel injection.");
	}
	return withoutOldSentinel.replace(marker, `${marker}${snippet}`);
}

async function writeLifecycleSentinel({ packageDir, token }) {
	const indexPath = resolve(packageDir, "extensions/agent-browser/index.ts");
	const source = await readFile(indexPath, "utf8");
	await writeFile(indexPath, injectLifecycleSentinelSource(source, token), "utf8");
}

function fakeAgentBrowserScript() {
	return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateDir = process.env.AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR;
if (!stateDir) {
  console.error("AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR is required");
  process.exit(64);
}
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.mkdirSync(stateDir, { recursive: true });
function valueAfter(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function commandTokens() {
  const tokens = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--session") { index += 1; continue; }
    tokens.push(arg);
  }
  return tokens;
}
const sessionName = valueAfter("--session") || "default";
const statePath = path.join(stateDir, encodeURIComponent(sessionName) + ".json");
function load() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "Blank", url: "about:blank", activeTab: "t1" }; } }
function save(state) { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function tabList(state) { return { tabs: [{ tabId: "t1", label: "t1", index: 0, title: state.title, url: state.url, active: true }] }; }
function execute(tokens) {
  let state = load();
  const [command, ...rest] = tokens;
  if (command === "open") {
    const url = rest[rest.length - 1] || "about:blank";
    state = { ...state, title: url.includes("react.dev") ? "React" : "Lifecycle Page", url, activeTab: "t1" };
    save(state);
    return { result: { title: state.title, url: state.url } };
  }
  if (command === "snapshot") {
    return { result: { origin: state.url, refs: { e1: { role: "heading", name: state.title } }, snapshot: '- heading "' + state.title + '" [ref=e1]' } };
  }
  if (command === "get" && rest.includes("url")) return { result: state.url };
  if (command === "get" && rest.includes("title")) return { result: state.title };
  if (command === "eval") return { result: "PIAB-LIFECYCLE-LARGE-OUTPUT\\n" + "x".repeat(700 * 1024) };
  if (command === "tab" && rest.includes("list")) return { result: tabList(state) };
  if (command === "tab") return { result: { selectedTab: rest[0] || "t1", ...state } };
  if (command === "close") return { result: { closed: true, sessionName } };
  return { result: { ok: true, command, args: rest, stdin, state } };
}
const tokens = commandTokens();
let data;
if (tokens[0] === "batch") {
  let steps;
  try { steps = JSON.parse(stdin || "[]"); } catch (error) { throw new Error("Invalid batch stdin: " + error.message); }
  data = steps.map((step) => {
    const { result } = execute(step);
    return { command: step, success: true, result };
  });
} else {
  data = execute(tokens).result;
}
process.stdout.write(JSON.stringify({ success: true, data }));
`;
}

async function createFakeAgentBrowserBinary(binDir) {
	await mkdir(binDir, { recursive: true });
	const scriptPath = join(binDir, "agent-browser");
	await writeFile(scriptPath, fakeAgentBrowserScript(), "utf8");
	await chmod(scriptPath, 0o755);
	await writeFile(join(binDir, "agent-browser.cmd"), `@echo off\n${JSON.stringify(process.execPath)} "%~dp0agent-browser" %*\n`, "utf8");
}

async function capturePaneText(tmuxSession) {
	const { stdout } = await run("tmux", ["capture-pane", "-p", "-S", "-2000", "-t", `${tmuxSession}:0.0`]);
	return stdout;
}

async function capturePane(tmuxSession, artifactPath) {
	try {
		const stdout = await capturePaneText(tmuxSession);
		await mkdir(dirname(artifactPath), { recursive: true });
		await writeFile(artifactPath, stdout, "utf8");
		return stdout;
	} catch (error) {
		await writeFile(artifactPath, `Could not capture pane: ${error instanceof Error ? error.message : String(error)}\n`, "utf8").catch(() => undefined);
		return "";
	}
}

async function killTmuxSession(tmuxSession) {
	await run("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
}

async function launchPiInTmux(options) {
	const { agentDir, cwd, fakeBinDir, fakeStateDir, tmuxSession } = options;
	await killTmuxSession(tmuxSession);
	await run("tmux", [
		"new-session",
		"-d",
		"-s",
		tmuxSession,
		"-c",
		cwd,
		"env",
		`PI_CODING_AGENT_DIR=${agentDir}`,
		`AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR=${fakeStateDir}`,
		`PATH=${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
		"pi",
	]);
}

async function sendLine(tmuxSession, text) {
	await run("tmux", ["send-keys", "-t", `${tmuxSession}:0.0`, "-l", text]);
	await sleep(PROMPT_SUBMIT_PAUSE_MS);
	await run("tmux", ["send-keys", "-t", `${tmuxSession}:0.0`, "Enter"]);
}

async function listSessionFiles(sessionDir) {
	const { stdout } = await run("find", [sessionDir, "-type", "f", "-name", "*.jsonl"]);
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.sort();
}

async function newestSessionFile(sessionDir) {
	const files = await listSessionFiles(sessionDir);
	if (files.length === 0) return undefined;
	let newest;
	let newestMtime = -1;
	for (const file of files) {
		const { stdout } = await run("stat", ["-f", "%m", file]).catch(async () => run("stat", ["-c", "%Y", file]));
		const mtime = Number(stdout.trim());
		if (mtime >= newestMtime) {
			newest = file;
			newestMtime = mtime;
		}
	}
	return newest;
}

async function waitFor({ describe, predicate, timeoutMs, intervalMs = 1000, onPoll }) {
	const start = Date.now();
	let lastError;
	while (Date.now() - start <= timeoutMs) {
		try {
			const result = await predicate();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		if (onPoll) await onPoll();
		await sleep(intervalMs);
	}
	const suffix = lastError ? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : "";
	throw new Error(`Timed out waiting for ${describe} after ${timeoutMs}ms.${suffix}`);
}

function findResult(results, predicate) {
	for (let index = results.length - 1; index >= 0; index -= 1) {
		const result = results[index];
		if (predicate(result)) return result;
	}
	return undefined;
}

function resultText(result) {
	return Array.isArray(result?.content)
		? result.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n")
		: "";
}

function resultUrl(result) {
	const details = isRecord(result?.details) ? result.details : undefined;
	const target = isRecord(details?.sessionTabTarget) ? details.sessionTabTarget : undefined;
	if (typeof target?.url === "string") return target.url;
	const text = resultText(result);
	const match = text.match(/https?:\/\/[^\s)]+/);
	return match?.[0];
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function assertFileExists(filePath, label) {
	assert(await pathExists(filePath), `${label} does not exist: ${filePath}`);
}

async function readEntries(sessionFile) {
	return await readJsonlFile(sessionFile);
}

async function waitForSentinel({ sessionFile, timeoutMs, token }) {
	return await waitFor({
		describe: `sentinel token ${token}`,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			return sentinelTokens(entries).includes(token) ? entries : undefined;
		},
	});
}

async function waitForAgentBrowserResult({ describe, sessionFile, timeoutMs, sinceCount, predicate }) {
	return await waitFor({
		describe,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			const results = agentBrowserResults(entries);
			const newResults = results.slice(sinceCount);
			const result = findResult(newResults, predicate);
			return result ? { entries, result, results } : undefined;
		},
	});
}

async function waitForAssistantFinal({ describe, sessionFile, sinceEntryCount, timeoutMs }) {
	return await waitFor({
		describe: `${describe} final assistant response`,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			const finalMessage = entries.slice(sinceEntryCount).find((entry) => {
				const message = entry?.message;
				return (
					entry?.type === "message" &&
					message?.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some((item) => item?.type === "text" && typeof item.text === "string")
				);
			});
			return finalMessage ? entries : undefined;
		},
	});
}

async function runPromptAndWaitForResult({ describe, prompt, sessionFile, timeoutMs, tmuxSession, predicate, verbose }) {
	const beforeEntries = await readEntries(sessionFile);
	const beforeResults = agentBrowserResults(beforeEntries).length;
	if (verbose) console.log(`→ ${describe}`);
	await sendLine(tmuxSession, prompt);
	const report = await waitForAgentBrowserResult({ describe, sessionFile, timeoutMs, sinceCount: beforeResults, predicate });
	await waitForAssistantFinal({ describe, sessionFile, sinceEntryCount: beforeEntries.length, timeoutMs });
	return report;
}

function buildPrompt(args, extra = "") {
	return `Use exactly one agent_browser tool call with args ${JSON.stringify(args)}${extra} Do not use bash. After the tool result, briefly report the result.`;
}

async function verifyLifecycle(options = {}) {
	const repoRoot = options.repoRoot ?? process.cwd();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const keepArtifacts = options.keepArtifacts ?? false;
	const verbose = options.verbose ?? false;
	const tempRoot = await mkdtemp(join(tmpdir(), "piab-lifecycle-"));
	const artifactsDir = join(tempRoot, "artifacts");
	const agentDir = join(tempRoot, "agent");
	const sessionDir = join(tempRoot, "sessions");
	const packageDir = join(tempRoot, "package-under-test");
	const fakeBinDir = join(tempRoot, "fake-bin");
	const fakeStateDir = join(tempRoot, "fake-browser-state");
	const tmuxSession = `piab-lifecycle-${process.pid}`;
	let sessionFile;
	let firstFullOutputPath;
	let failure;

	const log = (message) => {
		if (verbose) console.log(message);
	};

	try {
		await mkdir(artifactsDir, { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		await copyPackageSource({ packageDir, repoRoot });
		await writeLifecycleSentinel({ packageDir, token: "v1" });
		await createFakeAgentBrowserBinary(fakeBinDir);
		const settings = await writeSettings({ agentDir, packageDir, sessionDir });
		assert(settings.packages.length === 1 && settings.packages[0] === packageDir, "Isolated settings must use exactly one configured package source.");
		assert(settings.extensions.length === 0 && settings.skills.length === 0 && settings.prompts.length === 0 && settings.themes.length === 0, "Isolated settings must clear local resource arrays.");

		log(`Temp root: ${tempRoot}`);
		log("Launching Pi in tmux...");
		await launchPiInTmux({ agentDir, cwd: repoRoot, fakeBinDir, fakeStateDir, tmuxSession });
		await waitFor({
			describe: "Pi prompt readiness",
			timeoutMs,
			predicate: async () => {
				const pane = await capturePaneText(tmuxSession);
				return pane.includes("0.0%/") ? pane : undefined;
			},
		});
		await sleep(1000);
		if (verbose) console.log("→ initial managed open");
		await sendLine(tmuxSession, buildPrompt(["open", EXPECTED_URL]));
		const openReport = await waitFor({
			describe: "initial managed open result",
			timeoutMs,
			predicate: async () => {
				sessionFile = sessionFile ?? (await newestSessionFile(sessionDir));
				if (!sessionFile) return undefined;
				const entries = await readEntries(sessionFile);
				const results = agentBrowserResults(entries);
				const result = findResult(
					results,
					(candidate) => candidate?.details?.command === "open" && normalizeComparableUrl(resultUrl(candidate)) === EXPECTED_URL,
				);
				return result ? { entries, result, results } : undefined;
			},
		});
		assert(sessionFile, "Pi did not create a session file.");
		await waitForAssistantFinal({ describe: "initial managed open", sessionFile, sinceEntryCount: 0, timeoutMs });
		const firstSessionName = openReport.result.details?.sessionName;
		assert(typeof firstSessionName === "string" && firstSessionName.length > 0, "Initial open did not report details.sessionName.");
		assert(openReport.result.details?.usedImplicitSession === true, "Initial open did not use the implicit managed session.");

		await sendLine(tmuxSession, "/piab-lifecycle-sentinel");
		await waitForSentinel({ sessionFile, timeoutMs, token: "v1" });

		await writeLifecycleSentinel({ packageDir, token: "v2" });
		await sendLine(tmuxSession, "/reload");
		await sleep(3000);
		await sendLine(tmuxSession, "/piab-lifecycle-sentinel");
		await waitForSentinel({ sessionFile, timeoutMs, token: "v2" });

		const reloadSnapshot = await runPromptAndWaitForResult({
			describe: "post-reload same-page snapshot",
			prompt: buildPrompt(["snapshot", "-i"]),
			sessionFile,
			timeoutMs,
			tmuxSession,
			verbose,
			predicate: (result) => normalizeComparableUrl(resultUrl(result)) === EXPECTED_URL || resultText(result).includes(EXPECTED_URL),
		});
		assert(reloadSnapshot.result.details?.sessionName === firstSessionName, "Post-reload snapshot used a different managed session name.");

		const largeReport = await runPromptAndWaitForResult({
			describe: "large eval output spill",
			prompt: buildPrompt(["eval", "--stdin"], " and stdin set to document.body.innerText."),
			sessionFile,
			timeoutMs,
			tmuxSession,
			verbose,
			predicate: (result) => collectFullOutputPaths([result]).length > 0,
		});
		[firstFullOutputPath] = collectFullOutputPaths([largeReport.result]);
		assert(typeof firstFullOutputPath === "string", "Large eval did not expose details.fullOutputPath.");
		await assertFileExists(firstFullOutputPath, "Large-output fullOutputPath");

		await capturePane(tmuxSession, join(artifactsDir, "before-restart-pane.txt"));
		await killTmuxSession(tmuxSession);
		log("Relaunching Pi and resuming prior session...");
		await launchPiInTmux({ agentDir, cwd: repoRoot, fakeBinDir, fakeStateDir, tmuxSession });
		await waitFor({
			describe: "relaunched Pi prompt readiness",
			timeoutMs,
			predicate: async () => {
				const pane = await capturePaneText(tmuxSession);
				return pane.includes("0.0%/") ? pane : undefined;
			},
		});
		await sendLine(tmuxSession, "/resume");
		await sleep(1000);
		await run("tmux", ["send-keys", "-t", `${tmuxSession}:0.0`, "Enter"]);

		const resumeSnapshot = await runPromptAndWaitForResult({
			describe: "post-resume same-page snapshot",
			prompt: buildPrompt(["snapshot", "-i"]),
			sessionFile,
			timeoutMs,
			tmuxSession,
			verbose,
			predicate: (result) => normalizeComparableUrl(resultUrl(result)) === EXPECTED_URL || resultText(result).includes(EXPECTED_URL),
		});
		assert(resumeSnapshot.result.details?.sessionName === firstSessionName, "Post-resume snapshot used a different managed session name.");
		await assertFileExists(firstFullOutputPath, "Previously persisted fullOutputPath after resume");

		await capturePane(tmuxSession, join(artifactsDir, "success-pane.txt"));
		return {
			artifactsDir,
			fullOutputPath: firstFullOutputPath,
			sessionFile,
			sessionName: firstSessionName,
			tempRoot,
		};
	} catch (error) {
		failure = error;
		await mkdir(artifactsDir, { recursive: true }).catch(() => undefined);
		await capturePane(tmuxSession, join(artifactsDir, "failure-pane.txt"));
		if (sessionFile && (await pathExists(sessionFile))) {
			await cp(sessionFile, join(artifactsDir, basename(sessionFile))).catch(() => undefined);
		}
		throw error;
	} finally {
		await capturePane(tmuxSession, join(artifactsDir, "final-pane.txt")).catch(() => undefined);
		await killTmuxSession(tmuxSession);
		if (!keepArtifacts && !failure) {
			await rm(tempRoot, { force: true, recursive: true });
		} else {
			console.error(`${failure ? "Lifecycle artifacts retained for debugging" : "Lifecycle artifacts retained"}: ${tempRoot}`);
		}
	}
}

export async function main(argv = process.argv.slice(2)) {
	try {
		const options = parseCliArgs(argv);
		if (options.showHelp) {
			printHelp();
			return 0;
		}
		const report = await verifyLifecycle(options);
		console.log("Lifecycle verification passed.");
		console.log(`Session: ${report.sessionFile}`);
		console.log(`Managed browser session: ${report.sessionName}`);
		console.log(`Persisted full output verified before cleanup: ${report.fullOutputPath}`);
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			console.error("Run with --help for usage.");
			return 2;
		}
		console.error("Lifecycle verification failed:");
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		return 1;
	}
}

export function isDirectRun(metaUrl, argv = process.argv) {
	return Boolean(argv[1]) && metaUrl === pathToFileURL(argv[1]).href;
}

if (isDirectRun(import.meta.url)) {
	main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
