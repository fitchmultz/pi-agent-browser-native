#!/usr/bin/env node
/**
 * Purpose: Provide the small public npm-script facade for maintainer docs and verification workflows.
 * Responsibilities: Dispatch consolidated `npm run docs -- ...` and `npm run verify -- ...` commands to the underlying focused scripts, preserve exit codes, and print discoverable help.
 * Scope: Local maintainer orchestration only; individual verifier scripts continue to own their domain-specific checks.
 * Usage: Called from package.json scripts (`npm run docs`, `npm run verify -- package-pi`) or directly as `node scripts/project.mjs <docs|verify> ...`.
 * Invariants/Assumptions: `npm install` has populated local `node_modules/.bin` tools, and Pi/tmux are available in the maintainer environment only for lifecycle/package smoke modes.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const nodeCommand = process.execPath;
const binSuffix = process.platform === "win32" ? ".cmd" : "";

class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function printTopLevelHelp() {
	console.log(`project.mjs

Usage:
  node scripts/project.mjs <docs|verify> [mode] [options]

Public npm entrypoints:
  npm run docs                 Check generated documentation blocks.
  npm run docs -- write        Rewrite generated documentation blocks.
  npm run verify               Run the default local verification gate.
  npm run verify -- release    Run release verification.

Exit codes:
  0  Requested workflow passed or help was shown.
  1  Requested workflow failed.
  2  Usage error.`);
}

function printDocsHelp() {
	console.log(`npm run docs -- [target] [mode]

Targets:
  all                 Playbook and command-reference generated blocks (default).
  playbook            Only generated playbook blocks.
  command-reference   Only command-reference baseline blocks.

Modes:
  check               Verify generated blocks are current (default).
  write               Rewrite generated blocks in place.

Examples:
  npm run docs
  npm run docs -- write
  npm run docs -- playbook write
  npm run docs -- command-reference check

Exit codes:
  0  Documentation blocks matched, were rewritten, or help was shown.
  1  Drift found or rewrite failed.
  2  Usage error.`);
}

function printVerifyHelp() {
	console.log(`npm run verify -- [mode] [options]

Modes:
  default             Docs check, typecheck, unit tests, and live command-reference check (default).
  typecheck           Run TypeScript typecheck only.
  command-reference   Check generated command-reference block and live upstream help drift.
  real-upstream       Run the opt-in real upstream browser contract suite.
  package             Verify package contents.
  package-pi          Verify package contents plus isolated Pi package smoke.
  lifecycle           Run the tmux-driven configured-source lifecycle harness.
  release             Run default verification plus package-pi.

Options:
  --keep-artifacts    With lifecycle mode, preserve lifecycle temp artifacts.
  --verbose           With lifecycle mode, print progress details.
  --timeout-ms <ms>   With lifecycle mode, override the per-step wait timeout.
  --list-files        With package mode, print every packed file path.

Examples:
  npm run verify
  npm run verify -- command-reference
  npm run verify -- real-upstream
  npm run verify -- package --list-files
  npm run verify -- package-pi
  npm run verify -- lifecycle --keep-artifacts --verbose
  npm run verify -- release

Exit codes:
  0  Verification passed or help was shown.
  1  Verification failed.
  2  Usage error.`);
}

function commandLabel(command, args) {
	return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		console.log(`\n> ${commandLabel(command, args)}`);
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env: { ...process.env, ...options.env },
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal) {
				reject(new Error(`${commandLabel(command, args)} was terminated by ${signal}`));
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${commandLabel(command, args)} exited with code ${code ?? "unknown"}`));
		});
	});
}

async function runSteps(steps) {
	for (const step of steps) {
		await run(step.command, step.args, { env: step.env });
	}
}

function scriptStep(args, env) {
	return { command: nodeCommand, args, env };
}

function localToolStep(command, args, env) {
	return { command: join(process.cwd(), "node_modules", ".bin", `${command}${binSuffix}`), args, env };
}

function parseDocsArgs(argv) {
	if (argv.includes("-h") || argv.includes("--help")) return { showHelp: true };

	let target = "all";
	let mode = "check";
	for (const rawArg of argv) {
		const arg = rawArg.startsWith("--") ? rawArg.slice(2) : rawArg;
		if (["all", "playbook", "command-reference"].includes(arg)) {
			target = arg;
			continue;
		}
		if (["check", "write"].includes(arg)) {
			mode = arg;
			continue;
		}
		throw new UsageError(`Unknown docs argument: ${rawArg}`);
	}
	return { mode, showHelp: false, target };
}

function docsSteps(options) {
	const modeFlag = `--${options.mode}`;
	const steps = [];
	if (options.target === "all" || options.target === "playbook") {
		steps.push(localToolStep("tsx", ["./scripts/check-playbook-drift.ts", modeFlag]));
	}
	if (options.target === "all" || options.target === "command-reference") {
		steps.push(scriptStep(["./scripts/check-command-reference-baseline.mjs", modeFlag]));
	}
	return steps;
}

function parseVerifyArgs(argv) {
	if (argv.includes("-h") || argv.includes("--help")) return { mode: "default", passthrough: [], showHelp: true };
	const [rawMode, ...rest] = argv;
	const mode = rawMode ?? "default";
	const supportedModes = new Set([
		"default",
		"typecheck",
		"command-reference",
		"real-upstream",
		"package",
		"package-pi",
		"lifecycle",
		"release",
	]);
	if (!supportedModes.has(mode)) {
		throw new UsageError(`Unknown verify mode: ${mode}`);
	}
	return { mode, passthrough: rest, showHelp: false };
}

function validatePassthrough(mode, passthrough) {
	const allowedByMode = {
		default: new Set(),
		typecheck: new Set(),
		"command-reference": new Set(),
		"real-upstream": new Set(),
		package: new Set(["--list-files"]),
		"package-pi": new Set(["--list-files"]),
		lifecycle: new Set(["--keep-artifacts", "--verbose", "--timeout-ms"]),
		release: new Set(),
	};
	const allowed = allowedByMode[mode];
	for (let index = 0; index < passthrough.length; index += 1) {
		const arg = passthrough[index];
		if (!allowed.has(arg)) {
			throw new UsageError(`Option ${arg} is not supported for verify mode ${mode}.`);
		}
		if (arg === "--timeout-ms") {
			const value = passthrough[index + 1];
			if (!value) throw new UsageError("--timeout-ms requires a value.");
			index += 1;
		}
	}
}

function commandReferenceSteps() {
	return [
		...docsSteps({ mode: "check", target: "command-reference" }),
		scriptStep(["./scripts/verify-command-reference.mjs"]),
	];
}

function verifySteps(options) {
	validatePassthrough(options.mode, options.passthrough);
	switch (options.mode) {
		case "default":
			return [
				...docsSteps({ mode: "check", target: "playbook" }),
				localToolStep("tsc", ["--noEmit"]),
				localToolStep("tsx", ["--test", "test/**/*.test.ts"]),
				...commandReferenceSteps(),
			];
		case "typecheck":
			return [localToolStep("tsc", ["--noEmit"])];
		case "command-reference":
			return commandReferenceSteps();
		case "real-upstream":
			return [localToolStep("tsx", ["--test", "test/agent-browser.real-upstream-contract.test.ts"], { PI_AGENT_BROWSER_REAL_UPSTREAM: "1" })];
		case "package":
			return [scriptStep(["./scripts/verify-package.mjs", ...options.passthrough])];
		case "package-pi":
			return [scriptStep(["./scripts/verify-package.mjs", "--smoke-pi", ...options.passthrough])];
		case "lifecycle":
			return [scriptStep(["./scripts/verify-lifecycle.mjs", ...options.passthrough])];
		case "release":
			return [
				...verifySteps({ mode: "default", passthrough: [], showHelp: false }),
				...verifySteps({ mode: "package-pi", passthrough: [], showHelp: false }),
			];
	}
}

async function main(argv = process.argv.slice(2)) {
	const [command, ...rest] = argv;
	if (!command || command === "-h" || command === "--help") {
		printTopLevelHelp();
		return 0;
	}
	if (command === "docs") {
		const options = parseDocsArgs(rest);
		if (options.showHelp) {
			printDocsHelp();
			return 0;
		}
		await runSteps(docsSteps(options));
		return 0;
	}
	if (command === "verify") {
		const options = parseVerifyArgs(rest);
		if (options.showHelp) {
			printVerifyHelp();
			return 0;
		}
		await runSteps(verifySteps(options));
		return 0;
	}
	throw new UsageError(`Unknown project command: ${command}`);
}

main().then(
	(exitCode) => {
		process.exitCode = exitCode;
	},
	(error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = error instanceof UsageError ? 2 : 1;
	},
);
