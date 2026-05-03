#!/usr/bin/env node
/**
 * Purpose: Diagnose first-run pi-agent-browser-native setup without mutating Pi or agent-browser state.
 * Responsibilities: Check upstream agent-browser PATH/version, inspect Pi settings for duplicate package/checkout sources, and print actionable remediation.
 * Scope: Read-only package diagnostics only; upstream browser runtime health remains the responsibility of upstream `agent-browser doctor`.
 * Usage: Run via `pi-agent-browser-doctor`, `npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor`, or `npm run doctor` from this repository.
 * Invariants/Assumptions: The wrapper targets CAPABILITY_BASELINE.targetVersion, does not bundle agent-browser, and must not edit Pi settings or run fixing commands.
 */

import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CAPABILITY_BASELINE, CAPABILITY_BASELINE_SOURCE } from "./agent-browser-capability-baseline.mjs";

const execFile = promisify(execFileCallback);
const PACKAGE_NAME = "pi-agent-browser-native";
const REPO_URL_FRAGMENT = "github.com/fitchmultz/pi-agent-browser-native";
const EXTENSION_ENTRYPOINT = "extensions/agent-browser/index.ts";
const EXPECTED_VERSION = CAPABILITY_BASELINE.targetVersion;
const DEFAULT_AGENT_DIR = resolve(homedir(), ".pi/agent");
const THIS_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeAgentBrowserVersion(output) {
	return String(output ?? "").trim().replace(/^agent-browser\s+/, "");
}

function printHelp() {
	console.log(`pi-agent-browser-doctor

Usage:
  pi-agent-browser-doctor [options]

Options:
  --cwd <path>              Project directory used for project Pi settings and local source detection. Defaults to process.cwd().
  --agent-dir <path>        Pi global agent directory. Defaults to ~/.pi/agent.
  --settings <path>         Additional Pi settings JSON/JSONC file to inspect. Repeatable.
  --skip-source-check       Only check upstream agent-browser PATH/version.
  -h, --help                Show help.

Checks:
  1. agent-browser is installed on PATH.
  2. agent-browser --version matches the package capability baseline.
  3. Pi settings and repo-local autoload locations do not point at multiple active pi-agent-browser-native sources.

Examples:
  pi-agent-browser-doctor
  npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
  npm run doctor
  pi-agent-browser-doctor --cwd /path/to/project --settings /tmp/pi-settings.json

Exit codes:
  0  Doctor passed.
  1  Doctor found setup failures.
  2  Usage error.
`);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
	const parsed = {
		agentDir: undefined,
		cwd: undefined,
		settingsPaths: [],
		showHelp: false,
		skipSourceCheck: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			parsed.showHelp = true;
			continue;
		}
		if (arg === "--skip-source-check") {
			parsed.skipSourceCheck = true;
			continue;
		}
		if (arg === "--cwd" || arg === "--agent-dir" || arg === "--settings") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${arg} requires a value. Run with --help for usage.`);
			}
			index += 1;
			if (arg === "--cwd") parsed.cwd = value;
			if (arg === "--agent-dir") parsed.agentDir = value;
			if (arg === "--settings") parsed.settingsPaths.push(value);
			continue;
		}
		throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
	}

	return parsed;
}

async function defaultRunAgentBrowser(args) {
	const { stdout, stderr } = await execFile("agent-browser", args, { maxBuffer: 1024 * 1024 });
	return `${stdout}${stderr}`;
}

async function defaultPathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isInsidePath(childPath, parentPath) {
	const child = resolve(childPath);
	const parent = resolve(parentPath);
	return child === parent || child.startsWith(`${parent}${sep}`);
}

function expandUserPath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function isPathLikeSource(source) {
	return source.startsWith("/") || source.startsWith("./") || source.startsWith("../") || source.startsWith("~");
}

function sourceLooksLikeThisPackage(source, cwd, sourceBaseDir = cwd) {
	const text = String(source ?? "").trim();
	if (text.length === 0) return false;
	if (/^npm:pi-agent-browser-native(?:@|$)/.test(text)) return true;
	if (text === PACKAGE_NAME) return true;
	if (text.includes(REPO_URL_FRAGMENT)) return true;

	if (!isPathLikeSource(text)) return false;
	const resolvedSource = resolve(sourceBaseDir, expandUserPath(text));
	const cwdEntrypoint = resolve(cwd, EXTENSION_ENTRYPOINT);
	const packageEntrypoint = resolve(THIS_PACKAGE_ROOT, EXTENSION_ENTRYPOINT);
	return (
		resolvedSource === cwd ||
		resolvedSource === cwdEntrypoint ||
		resolvedSource === THIS_PACKAGE_ROOT ||
		resolvedSource === packageEntrypoint ||
		isInsidePath(cwdEntrypoint, resolvedSource) ||
		isInsidePath(packageEntrypoint, resolvedSource)
	);
}

function stripJsonComments(text) {
	let result = "";
	let inString = false;
	let quote = "";
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				result += char;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			result += char;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quote = char;
			result += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}
		result += char;
	}
	return result;
}

function parseSettingsText(text, path) {
	return JSON.parse(stripJsonComments(text));
}

function arrayEntries(value) {
	return Array.isArray(value) ? value.entries() : [];
}

function entrySource(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") return entry.source ?? entry.path ?? entry.package;
	return undefined;
}

function collectSettingsSources(settings, settingsPath, cwd) {
	const sources = [];
	const sourceBaseDir = dirname(settingsPath);
	for (const [index, entry] of arrayEntries(settings?.packages)) {
		const source = entrySource(entry);
		if (sourceLooksLikeThisPackage(source, cwd, sourceBaseDir)) {
			sources.push({ kind: "package", source: String(source), location: `${settingsPath} packages[${index}]` });
		}
	}
	for (const [index, entry] of arrayEntries(settings?.extensions)) {
		const source = entrySource(entry);
		if (sourceLooksLikeThisPackage(source, cwd, sourceBaseDir)) {
			sources.push({ kind: "extension", source: String(source), location: `${settingsPath} extensions[${index}]` });
		}
	}
	return sources;
}

function dedupe(paths) {
	return [...new Set(paths.map((path) => resolve(path)))];
}

async function inspectSettingsPath({ path, cwd, readText }) {
	try {
		const text = await readText(path);
		if (text === undefined) return { sources: [], warnings: [] };
		const settings = parseSettingsText(text, path);
		return { sources: collectSettingsSources(settings, path, cwd), warnings: [] };
	} catch (error) {
		return {
			sources: [],
			warnings: [`Could not inspect Pi settings ${path}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

async function collectRepoLocalSources({ cwd, pathExists }) {
	const candidates = [resolve(cwd, ".pi/extensions/agent-browser.ts"), resolve(cwd, ".pi/extensions/agent-browser/index.ts")];
	const sources = [];
	for (const candidate of candidates) {
		if (await pathExists(candidate)) {
			sources.push({ kind: "repo-local", source: candidate, location: `${candidate} repo-local autoload` });
		}
	}
	return sources;
}

async function checkAgentBrowserVersion({ runAgentBrowser }) {
	try {
		const rawOutput = await runAgentBrowser(["--version"]);
		const version = normalizeAgentBrowserVersion(rawOutput);
		if (version !== EXPECTED_VERSION) {
			return {
				status: "fail",
				title: `agent-browser version drift: expected ${EXPECTED_VERSION}, found ${version || "<empty>"}.`,
				lines: [
					`This wrapper targets the current baseline from ${CAPABILITY_BASELINE_SOURCE} and does not provide backwards-compatibility shims.`,
					`Update upstream agent-browser to ${EXPECTED_VERSION}, or if you intentionally re-baselined upstream, update ${CAPABILITY_BASELINE_SOURCE} and refresh docs.`,
				],
			};
		}
		return { status: "pass", title: `agent-browser version matches baseline: ${version}`, lines: [] };
	} catch (error) {
		const code = error && typeof error === "object" ? error.code : undefined;
		return {
			status: "fail",
			title: "agent-browser is required but was not found on PATH.",
			lines: [
				"This package does not bundle agent-browser.",
				"Install upstream agent-browser, then make sure `agent-browser --version` works in the same shell that launches pi.",
				"Upstream docs:",
				"- https://agent-browser.dev/",
				"- https://github.com/vercel-labs/agent-browser",
				code && code !== "ENOENT" ? `Spawn error: ${String(code)}` : undefined,
			].filter(Boolean),
		};
	}
}

async function checkPiSources({ cwd, agentDir, settingsPaths, readText, pathExists }) {
	const defaultSettingsPaths = [resolve(agentDir, "settings.json"), resolve(cwd, ".pi/settings.json")];
	const allSettingsPaths = dedupe([...defaultSettingsPaths, ...settingsPaths]);
	const sources = [];
	const warnings = [];

	for (const path of allSettingsPaths) {
		if (await pathExists(path)) {
			const result = await inspectSettingsPath({ path, cwd, readText });
			sources.push(...result.sources);
			warnings.push(...result.warnings);
		}
	}
	sources.push(...(await collectRepoLocalSources({ cwd, pathExists })));

	if (sources.length > 1) {
		return {
			status: "fail",
			title: "Duplicate pi-agent-browser-native sources detected.",
			lines: [
				"Pi may register multiple `agent_browser` tools when a checkout source and a package source are both active.",
				"Detected sources:",
				...sources.map((source) => `- ${source.source} from ${source.location}`),
				"Keep exactly one active source:",
				"- for normal use: keep `pi install npm:pi-agent-browser-native` and remove/disable checkout paths from Pi settings",
				"- for temporary package or checkout trials: use `pi --no-extensions -e <source>` so configured sources are bypassed",
				"- for configured-source lifecycle validation: keep exactly one checkout or package source, then launch plain `pi`",
			],
			warnings,
		};
	}
	if (sources.length === 1) {
		return {
			status: "pass",
			title: "No duplicate pi-agent-browser-native sources detected.",
			lines: [`Detected source: ${sources[0].source} from ${sources[0].location}`],
			warnings,
		};
	}
	return {
		status: "warn",
		title: "No configured pi-agent-browser-native source was found in inspected Pi settings.",
		lines: [
			"This is OK for isolated runs such as `pi --no-extensions -e npm:pi-agent-browser-native`, but normal package use should install exactly one source with `pi install npm:pi-agent-browser-native`.",
		],
		warnings,
	};
}

export async function evaluateDoctor(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? DEFAULT_AGENT_DIR);
	const settingsPaths = (options.settingsPaths ?? []).map((path) => resolve(cwd, path));
	const readText = options.readText ?? ((path) => readFile(path, "utf8"));
	const pathExists = options.pathExists ?? defaultPathExists;
	const runAgentBrowser = options.runAgentBrowser ?? defaultRunAgentBrowser;
	const checks = [];
	const failures = [];
	const warnings = [];

	const versionCheck = await checkAgentBrowserVersion({ runAgentBrowser });
	checks.push(versionCheck);
	if (versionCheck.status === "fail") failures.push(versionCheck);

	if (!options.skipSourceCheck) {
		const sourceCheck = await checkPiSources({ cwd, agentDir, settingsPaths, readText, pathExists });
		checks.push(sourceCheck);
		if (sourceCheck.status === "fail") failures.push(sourceCheck);
		warnings.push(...(sourceCheck.warnings ?? []));
	}

	return { checks, failures, warnings };
}

export function formatDoctorReport(report) {
	const lines = ["pi-agent-browser-native doctor", ""];
	for (const check of report.checks) {
		const prefix = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
		lines.push(`${prefix} ${check.title}`);
		for (const line of check.lines ?? []) {
			lines.push(`  ${line}`);
		}
		lines.push("");
	}
	for (const warning of report.warnings ?? []) {
		lines.push(`! ${warning}`);
	}
	if ((report.warnings ?? []).length > 0) lines.push("");
	lines.push(report.failures.length > 0 ? "Doctor found setup failures." : "Doctor passed.");
	return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
	let args;
	try {
		args = parseCliArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (args.showHelp) {
		printHelp();
		return 0;
	}
	const report = await evaluateDoctor(args);
	const output = formatDoctorReport(report);
	if (report.failures.length > 0) {
		console.error(output);
		return 1;
	}
	console.log(output);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
