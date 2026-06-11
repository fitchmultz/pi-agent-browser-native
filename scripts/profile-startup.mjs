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
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLES = 10;
const CHILD_TIMEOUT_MS = 10_000;
const DIRECT_IMPORT_BUDGET_MS = 250;
const BUILD_SCRIPT = "./scripts/build.mjs";

class UsageError extends Error {
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

function parseArgs(argv = process.argv.slice(2)) {
	const options = { json: false, samples: DEFAULT_SAMPLES, showHelp: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") return { ...options, showHelp: true };
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg === "--samples") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) throw new UsageError("--samples requires a positive integer.");
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError("--samples requires a positive integer.");
			options.samples = parsed;
			index += 1;
			continue;
		}
		if (arg === "--timeout-ms") {
			throw new UsageError("--timeout-ms was removed: startup-profile no longer launches full Pi/tmux sessions.");
		}
		throw new UsageError(`Unknown option: ${arg}`);
	}
	return options;
}

async function buildPackageRuntime() {
	await execFile(process.execPath, [BUILD_SCRIPT], {
		cwd: repoRoot,
		maxBuffer: 10 * 1024 * 1024,
		timeout: 60_000,
	});
}

async function readPackageEntrypoint() {
	const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
	const extensionPath = packageJson?.pi?.extensions?.[0];
	if (typeof extensionPath !== "string" || extensionPath.length === 0) {
		throw new Error("package.json pi.extensions[0] must point at the extension entrypoint.");
	}
	return extensionPath;
}

async function measureDirectImportSample(entrypoint, sampleIndex) {
	const script = `
const start = performance.now();
const extension = await import(${JSON.stringify(entrypoint)});
const imported = performance.now();
const pi = {
  events: [],
  tools: [],
  on(...args) { this.events.push(args); },
  registerTool(tool) { this.tools.push(tool.name); }
};
extension.default(pi);
const registered = performance.now();
console.log(JSON.stringify({
  events: pi.events.length,
  importMs: imported - start,
  sampleIndex: ${sampleIndex},
  tools: pi.tools,
  totalMs: registered - start
}));
`;
	const result = await execFile(process.execPath, ["--input-type=module", "-e", script], {
		cwd: repoRoot,
		maxBuffer: 1024 * 1024,
		timeout: CHILD_TIMEOUT_MS,
	});
	return { ...JSON.parse(result.stdout.trim()), ok: true };
}

async function measureDirectImportSamples(entrypoint, sampleCount) {
	const samples = [];
	for (let index = 0; index < sampleCount; index += 1) {
		samples.push(await measureDirectImportSample(entrypoint, index + 1));
	}
	return samples;
}

function summarize(samples) {
	const values = samples.filter((sample) => sample.ok).map((sample) => sample.totalMs).sort((a, b) => a - b);
	if (values.length === 0) return { n: 0 };
	const percentile = (p) => values[Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1))];
	return {
		budgetMs: DIRECT_IMPORT_BUDGET_MS,
		maxMs: values.at(-1),
		meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)),
		medianMs: percentile(50),
		minMs: values[0],
		n: values.length,
		p95Ms: percentile(95),
		withinBudget: values.at(-1) < DIRECT_IMPORT_BUDGET_MS,
	};
}

function formatHuman(report) {
	const direct = report.summary.directImport;
	return [
		"Safe startup profile",
		`Package entrypoint: ${report.packageEntrypoint}`,
		`Samples: ${report.samplesPerMode}`,
		`Direct entrypoint import + factory: n=${direct.n}, median=${direct.medianMs.toFixed(1)}ms, mean=${direct.meanMs}ms, p95=${direct.p95Ms.toFixed(1)}ms, max=${direct.maxMs.toFixed(1)}ms, budget<${direct.budgetMs}ms`,
		`Tools registered: ${report.tools.join(", ")}`,
		`Events registered: ${report.events}`,
		`Artifact: ${report.artifactPath}`,
		"Safety: did not launch pi, tmux, mise, npm, browsers, or agent-browser.",
	].join("\n");
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
	const directSummary = summarize(directImportSamples);
	if (!directSummary.withinBudget) {
		throw new Error(`Direct startup exceeded ${DIRECT_IMPORT_BUDGET_MS}ms budget: max ${directSummary.maxMs.toFixed(1)}ms.`);
	}
	const firstSample = directImportSamples[0] ?? { events: 0, tools: [] };
	const report = {
		artifactPath: resolve(repoRoot, ".artifacts", "startup-profile", "latest.json"),
		budgets: { directImportMaxMs: DIRECT_IMPORT_BUDGET_MS },
		entrypointKind: packageEntrypoint.endsWith(".js") ? "compiled-js" : "source-or-other",
		events: firstSample.events,
		packageEntrypoint,
		repoRoot,
		samples: { directImport: directImportSamples },
		samplesPerMode: options.samples,
		safety: {
			launchesAgentBrowser: false,
			launchesBrowsers: false,
			launchesMise: false,
			launchesNpm: false,
			launchesPi: false,
			runsCleanBuild: true,
			launchesTmux: false,
		},
		summary: { directImport: directSummary },
		tools: firstSample.tools,
	};
	await mkdir(dirname(report.artifactPath), { recursive: true });
	await writeFile(report.artifactPath, `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	console.log(options.json ? JSON.stringify(report, null, 2) : formatHuman(report));
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = error instanceof UsageError ? 2 : 1;
		},
	);
}

export { parseArgs, summarize };
