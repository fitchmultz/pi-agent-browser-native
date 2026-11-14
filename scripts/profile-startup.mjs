#!/usr/bin/env node
/**
 * Purpose: Safely profile this package's extension startup path without launching Pi, tmux, browsers, or shell shims.
 * Responsibilities: Clean-build the compiled runtime, measure package entrypoint import plus extension factory registration in fresh Node processes, summarize samples, and write a local artifact.
 * Scope: Maintainer startup diagnostics only. Full Pi TUI ready-prompt profiling is intentionally excluded because repeated real Pi/tmux launches can leave host processes behind and interfere with the operator's shell/mise environment.
 * Usage: `npm run verify -- startup-profile`, `npm run startup-profile -- --samples 10 --json`.
 * Invariants/Assumptions: The package entrypoint is the source of truth for installed/package startup tax; no `pi`, `tmux`, `npm`, `mise`, browser, or `agent-browser` subprocess is launched by this script. It may run the local TypeScript compiler through `scripts/build.mjs` before measuring so stale generated output is impossible.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs, promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { DIRECT_IMPORT_BUDGET_MS, measureColdStartup } from "./startup-measurement.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLES = 10;
const BUILD_SCRIPT = "./scripts/build.mjs";

class UsageError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function usage() {
	return `profile-startup.mjs

Usage:
  node scripts/profile-startup.mjs [options]

Options:
  --samples <n>  Fresh Node import/factory samples (default ${DEFAULT_SAMPLES}).
  --json         Print machine-readable JSON only.
  -h, --help     Show this help text.

Measures:
  - package extension entrypoint import time
  - extension.default(pi) factory registration time
  - registered tool/event counts from a minimal fake Pi API

Safety:
  This script clean-builds dist first, then measures the compiled entrypoint.
  It does not launch pi, tmux, mise, npm, browsers, or agent-browser.
  It intentionally avoids full Pi TUI ready-prompt profiling because that workflow
  proved too invasive for routine verification on the operator machine.
`;
}

/** @param {string | undefined} value */
function parseSampleCount(value) {
	if (value === undefined || value.length === 0 || value.startsWith("-")) {
		throw new UsageError("--samples requires a positive integer.");
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new UsageError("--samples requires a positive integer.");
	}
	return parsed;
}

/** @param {unknown} error
 * @returns {never}
 */
function rethrowStartupParseError(error) {
	if (error instanceof Error && "code" in error) {
		if (error.message.includes("--timeout-ms")) {
			throw new UsageError(
				"--timeout-ms was removed: startup-profile no longer launches full Pi/tmux sessions.",
			);
		}
		if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
			throw new UsageError("--samples requires a positive integer.");
		}
		const prefix = error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? "" : "Unknown option: ";
		throw new UsageError(`${prefix}${error.message}`);
	}
	throw error instanceof Error ? error : new Error(String(error));
}

function parseArgs(argv = process.argv.slice(2)) {
	let values;
	try {
		({ values } = parseNodeArgs({
			args: argv,
			options: {
				help: { type: "boolean", short: "h", default: false },
				json: { type: "boolean", default: false },
				samples: { type: "string" },
			},
			strict: true,
		}));
	} catch (error) {
		rethrowStartupParseError(error);
	}
	if (values.help) {
		return { json: false, samples: DEFAULT_SAMPLES, showHelp: true };
	}
	return {
		json: values.json,
		samples: values.samples === undefined ? DEFAULT_SAMPLES : parseSampleCount(values.samples),
		showHelp: false,
	};
}

async function buildPackageRuntime() {
	await execFile(process.execPath, [BUILD_SCRIPT], {
		cwd: repoRoot,
		maxBuffer: 10 * 1024 * 1024,
		timeout: 60_000,
	});
}

async function readPackageEntrypoint() {
	/** @type {unknown} */
	const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
	const manifestSchema = Type.Object({
		pi: Type.Object({ extensions: Type.Array(Type.Unknown()) }),
	});
	const extensionPath = Check(manifestSchema, packageJson)
		? packageJson.pi.extensions[0]
		: undefined;
	if (typeof extensionPath !== "string" || extensionPath.length === 0) {
		throw new Error("package.json pi.extensions[0] must point at the extension entrypoint.");
	}
	return extensionPath;
}

/** @param {string} entrypoint
 * @param {number} sampleCount
 */
async function measureDirectImportSamples(entrypoint, sampleCount) {
	const samples = [];
	for (let index = 0; index < sampleCount; index += 1) {
		// Cold startup measurements must not compete for CPU with other samples.
		const sample = await measureColdStartup(entrypoint, repoRoot);
		samples.push({
			...sample,
			sampleIndex: index + 1,
			ok: true,
		});
	}
	return samples;
}

/** @typedef {Awaited<ReturnType<typeof measureDirectImportSamples>>[number]} StartupSample */

/** @param {readonly Pick<StartupSample, "ok" | "totalMs">[]} samples */
function summarize(samples) {
	const values = samples
		.filter((sample) => sample.ok)
		.map((sample) => sample.totalMs)
		.sort((a, b) => a - b);
	const minMs = values[0];
	const maxMs = values.at(-1);
	if (minMs === undefined || maxMs === undefined) {
		return { n: 0 };
	}
	/** @param {number} p */
	const percentile = (p) => values[Math.max(0, Math.ceil((p / 100) * values.length) - 1)] ?? maxMs;
	return {
		budgetMs: DIRECT_IMPORT_BUDGET_MS,
		maxMs,
		meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)),
		medianMs: percentile(50),
		minMs,
		n: values.length,
		p95Ms: percentile(95),
		withinBudget: maxMs < DIRECT_IMPORT_BUDGET_MS,
	};
}

/** @param {ReturnType<typeof startupReport>} report */
function formatHuman(report) {
	const direct = report.summary.directImport;
	const statistics =
		direct.maxMs === undefined
			? "n=0"
			: `n=${direct.n}, median=${direct.medianMs.toFixed(1)}ms, mean=${direct.meanMs}ms, p95=${direct.p95Ms.toFixed(1)}ms, max=${direct.maxMs.toFixed(1)}ms, budget<${direct.budgetMs}ms`;
	return [
		"Safe startup profile",
		`Package entrypoint: ${report.packageEntrypoint}`,
		`Samples: ${report.samplesPerMode}`,
		`Direct entrypoint import + factory: ${statistics}`,
		`Tools registered: ${report.tools.join(", ")}`,
		`Events registered: ${report.events}`,
		`Artifact: ${report.artifactPath}`,
		"Safety: did not launch pi, tmux, mise, npm, browsers, or agent-browser.",
	].join("\n");
}

/** @param {string} packageEntrypoint
 * @param {readonly StartupSample[]} directImportSamples
 * @param {number} samplesPerMode
 */
function startupReport(packageEntrypoint, directImportSamples, samplesPerMode) {
	const firstSample = directImportSamples[0] ?? { events: 0, tools: [] };
	return {
		artifactPath: resolve(repoRoot, ".artifacts", "startup-profile", "latest.json"),
		budgets: { directImportMaxMs: DIRECT_IMPORT_BUDGET_MS },
		entrypointKind: packageEntrypoint.endsWith(".js") ? "compiled-js" : "source-or-other",
		events: firstSample.events,
		packageEntrypoint,
		repoRoot,
		samples: { directImport: directImportSamples },
		samplesPerMode,
		safety: {
			launchesAgentBrowser: false,
			launchesBrowsers: false,
			launchesMise: false,
			launchesNpm: false,
			launchesPi: false,
			runsCleanBuild: true,
			launchesTmux: false,
		},
		summary: { directImport: summarize(directImportSamples) },
		tools: firstSample.tools,
	};
}

async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.showHelp) {
		console.log(usage());
		return 0;
	}
	await buildPackageRuntime();
	const packageEntrypoint = await readPackageEntrypoint();
	const directImportSamples = await measureDirectImportSamples(packageEntrypoint, options.samples);
	const report = startupReport(packageEntrypoint, directImportSamples, options.samples);
	await mkdir(dirname(report.artifactPath), { recursive: true });
	await writeFile(report.artifactPath, `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	console.log(options.json ? JSON.stringify(report, null, 2) : formatHuman(report));
	const directSummary = report.summary.directImport;
	if (directSummary.withinBudget !== true) {
		const maximum = directSummary.maxMs?.toFixed(1) ?? "unavailable";
		throw new Error(
			`Direct startup exceeded ${DIRECT_IMPORT_BUDGET_MS}ms budget: max ${maximum}ms.`,
		);
	}
	return 0;
}

if (import.meta.main) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((/** @type {unknown} */ error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = error instanceof UsageError ? 2 : 1;
		});
}

export { parseArgs, summarize };
