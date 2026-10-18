#!/usr/bin/env node
/**
 * Purpose: Diagnose first-run pi-agent-browser-native setup without mutating Pi or agent-browser state.
 * Responsibilities: Check upstream agent-browser PATH/version, inspect Pi settings for duplicate package/checkout sources, and print actionable remediation.
 * Scope: Read-only package diagnostics only; upstream browser runtime health remains the responsibility of upstream `agent-browser doctor`.
 * Usage: Run via `pi-agent-browser-doctor`, `npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor`, or `npm run doctor` from this repository.
 * Invariants/Assumptions: The wrapper recommends TARGET_AGENT_BROWSER_VERSION, enforces the configured stable version floor, does not bundle agent-browser, and must not edit Pi settings or run fixing commands.
 */

import { execFile as execFileCallback } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CAPABILITY_BASELINE_SOURCE } from "./agent-browser-capability-baseline.mjs";
import { checkPiSources } from "./doctor-sources.mjs";
import {
	MINIMUM_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_SOURCE,
	TARGET_AGENT_BROWSER_VERSION,
	isSupportedAgentBrowserVersion,
} from "./agent-browser-target.mjs";

const execFile = promisify(execFileCallback);
const RECOMMENDED_VERSION = TARGET_AGENT_BROWSER_VERSION;
export const MINIMUM_PI_VERSION = "1.0.0";
const DEFAULT_AGENT_DIR = resolve(homedir(), ".pi/agent");

/** @typedef {{readonly status: "pass" | "warn" | "fail", readonly title: string, readonly lines: readonly string[], readonly warnings?: readonly string[]}} DoctorCheck */
/** @typedef {{readonly checks: readonly DoctorCheck[], readonly failures: readonly DoctorCheck[], readonly warnings: readonly string[]}} DoctorReport */
/** @typedef {{readonly cwd?: string, readonly agentDir?: string, readonly settingsPaths?: readonly string[], readonly skipSourceCheck?: boolean, readonly readText?: (path: string) => Promise<string | undefined>, readonly pathExists?: (path: string) => Promise<boolean>, readonly runAgentBrowser?: (args: readonly string[]) => Promise<string>, readonly runPi?: (args: readonly string[]) => Promise<string>}} DoctorOptions */

function normalizeAgentBrowserVersion(output) {
	return String(output ?? "")
		.trim()
		.replace(/^agent-browser\s+/, "");
}

function normalizePiVersion(output) {
	return String(output ?? "")
		.trim()
		.replace(/^pi\s+/, "");
}

function parseVersionParts(version) {
	const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/);
	if (!match) {
		return;
	}
	return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function versionAtLeast(actual, minimum) {
	const actualParts = parseVersionParts(actual);
	const minimumParts = parseVersionParts(minimum);
	if (!actualParts || !minimumParts) {
		return;
	}
	for (let index = 0; index < minimumParts.length; index += 1) {
		if (actualParts[index] > minimumParts[index]) {
			return true;
		}
		if (actualParts[index] < minimumParts[index]) {
			return false;
		}
	}
	return true;
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
  2. agent-browser --version is supported by this package.
  3. pi --version is at least the minimum Pi runtime version for this release.
  4. Pi settings and repo-local autoload locations do not point at multiple active pi-agent-browser-native sources.

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
		if (["-h", "--help"].includes(arg)) {
			parsed.showHelp = true;
			continue;
		}
		if (arg === "--skip-source-check") {
			parsed.skipSourceCheck = true;
			continue;
		}
		if (["--cwd", "--agent-dir", "--settings"].includes(arg)) {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${arg} requires a value. Run with --help for usage.`);
			}
			index += 1;
			if (arg === "--settings") {
				parsed.settingsPaths.push(value);
			} else {
				parsed[arg === "--cwd" ? "cwd" : "agentDir"] = value;
			}
			continue;
		}
		throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
	}

	return parsed;
}

async function defaultRunAgentBrowser(args) {
	const { stdout, stderr } = await execFile("agent-browser", args, {
		maxBuffer: 1024 * 1024,
		...buildNpmShimExecOptions(process.platform),
	});
	return `${stdout}${stderr}`;
}

async function defaultRunPi(args) {
	const { stdout, stderr } = await execFile("pi", args, {
		maxBuffer: 1024 * 1024,
		...buildNpmShimExecOptions(process.platform),
	});
	return `${stdout}${stderr}`;
}

/**
 * npm's global bin shims on Windows are `.cmd` files that `execFile` cannot launch without a
 * shell. Doctor only passes fixed flag arrays here, so shell composition stays safe.
 */
export function buildNpmShimExecOptions(platform = process.platform) {
	return platform === "win32" ? { shell: true } : {};
}

async function defaultPathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function checkPiVersion({ runPi }) {
	try {
		const rawOutput = await runPi(["--version"]);
		const version = normalizePiVersion(rawOutput);
		const supported = versionAtLeast(version, MINIMUM_PI_VERSION);
		if (supported === false) {
			return {
				status: "fail",
				title: `Pi ${MINIMUM_PI_VERSION} or newer is required; found ${version || "<empty>"}.`,
				lines: [
					`This release enforces the Pi ${MINIMUM_PI_VERSION} runtime floor through the read-only doctor and release/package validation because it depends on native tool activation/history, prompt sections, and structured tool behavior from that baseline.`,
					"Update Pi before using this package or running lifecycle/package validation.",
				],
			};
		}
		if (supported === undefined) {
			return {
				status: "warn",
				title: `Could not parse pi --version output: ${version || "<empty>"}.`,
				lines: [
					`Pi ${MINIMUM_PI_VERSION} or newer is required for this release; run this doctor from the same shell that launches Pi so the setup gate can verify the host runtime.`,
				],
			};
		}
		return {
			status: "pass",
			title: `Pi version satisfies the minimum runtime floor: ${version}`,
			lines: [],
		};
	} catch (error) {
		const code = error && typeof error === "object" ? error.code : undefined;
		return {
			status: "warn",
			title: "Could not inspect pi --version.",
			lines: [
				`Pi ${MINIMUM_PI_VERSION} or newer is required for this release; run this doctor from the same shell that launches Pi so the setup gate can verify the host runtime.`,
				"Make sure the same shell that launches pi can run `pi --version` when debugging lifecycle or package-install behavior.",
				code && code !== "ENOENT" ? `Spawn error: ${String(code)}` : undefined,
			].filter(Boolean),
		};
	}
}

async function checkAgentBrowserVersion({ runAgentBrowser }) {
	try {
		const rawOutput = await runAgentBrowser(["--version"]);
		const version = normalizeAgentBrowserVersion(rawOutput);
		if (!isSupportedAgentBrowserVersion(version)) {
			return {
				status: "fail",
				title: `agent-browser version drift: minimum supported ${MINIMUM_AGENT_BROWSER_VERSION}; found ${version || "<empty>"}.`,
				lines: [
					`This wrapper supports stable agent-browser versions at or above ${MINIMUM_AGENT_BROWSER_VERSION}; ${RECOMMENDED_VERSION} is the current recommendation from ${TARGET_AGENT_BROWSER_SOURCE}.`,
					`Update upstream agent-browser to ${RECOMMENDED_VERSION}, or if you intentionally re-baselined upstream, update ${TARGET_AGENT_BROWSER_SOURCE} plus ${CAPABILITY_BASELINE_SOURCE}, run \`npm run docs -- command-reference write\`, refresh docs/COMMAND_REFERENCE.md, and rerun \`npm run verify -- command-reference\` plus \`npm run verify -- real-upstream\` with test/fixtures/agent-browser-real-output-shapes.json aligned to the new target version.`,
				],
			};
		}
		return {
			status: "pass",
			title:
				version === RECOMMENDED_VERSION
					? `agent-browser version matches recommended baseline: ${version}`
					: `agent-browser version meets supported floor: ${version} (recommended ${RECOMMENDED_VERSION})`,
			lines: [],
		};
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

function doctorIo(options) {
	return {
		readText: options.readText ?? ((path) => readFile(path, "utf8")),
		pathExists: options.pathExists ?? defaultPathExists,
		runAgentBrowser: options.runAgentBrowser ?? defaultRunAgentBrowser,
		runPi: options.runPi ?? defaultRunPi,
	};
}

/** @param {DoctorOptions} [options] @returns {Promise<DoctorReport>} */
export async function evaluateDoctor(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? DEFAULT_AGENT_DIR);
	const settingsPaths = Array.from(options.settingsPaths ?? [], (path) => resolve(cwd, path));
	const { readText, pathExists, runAgentBrowser, runPi } = doctorIo(options);
	const checks = [];

	const warnings = [];

	const versionCheck = await checkAgentBrowserVersion({ runAgentBrowser });
	checks.push(versionCheck);

	const piVersionCheck = await checkPiVersion({ runPi });
	checks.push(piVersionCheck);

	if (!options.skipSourceCheck) {
		const sourceCheck = await checkPiSources({
			cwd,
			agentDir,
			settingsPaths,
			readText,
			pathExists,
		});
		checks.push(sourceCheck);

		warnings.push(...(sourceCheck.warnings ?? []));
	}

	return { checks, failures: checks.filter((check) => check.status === "fail"), warnings };
}

/** @param {DoctorReport} report @returns {string} */
export function formatDoctorReport(report) {
	const lines = ["pi-agent-browser-native doctor", ""];
	for (const check of report.checks) {
		const prefix = { pass: "✓", warn: "!", fail: "✗" }[check.status];
		lines.push(`${prefix} ${check.title}`);
		for (const line of check.lines ?? []) {
			lines.push(`  ${line}`);
		}
		lines.push("");
	}
	for (const warning of report.warnings ?? []) {
		lines.push(`! ${warning}`);
	}
	if ((report.warnings ?? []).length > 0) {
		lines.push("");
	}
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

/** @param {string} metaUrl @param {string | undefined} [argv1] @param {(path: string) => string} [resolveRealPath] @returns {boolean} */
export function isDirectRun(metaUrl, argv1 = process.argv[1], resolveRealPath = realpathSync) {
	if (!argv1) {
		return false;
	}
	try {
		return resolveRealPath(argv1) === fileURLToPath(metaUrl);
	} catch {
		return false;
	}
}

if (isDirectRun(import.meta.url)) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
