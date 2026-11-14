#!/usr/bin/env node
/**
 * Purpose: Provide the small public npm-script facade for maintainer docs and verification workflows.
 * Responsibilities: Dispatch `npm test`, consolidated `npm run docs -- ...` and `npm run verify -- ...` commands to the underlying focused scripts, preserve exit codes, and print discoverable help. Default/pre-pr/release/docs verify step wiring is regression-locked in `test/project-verify.test.ts`.
 * Scope: Local maintainer orchestration only; individual verifier scripts continue to own their domain-specific checks.
 * Usage: Called from package.json scripts (`npm run docs`, `npm run verify -- package-pi`) or directly as `node scripts/project.mjs <test|docs|verify> ...`.
 * Invariants/Assumptions: `npm install` has populated local `node_modules/.bin` tools, and Pi/tmux are available in the maintainer environment only for lifecycle/package smoke modes.
 * Related: `docs/SUPPORT_MATRIX.md` maps `npm run verify` / `npm run docs` modes to the release-readiness gates maintainers re-run before shipping.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { printTopLevelHelp, printDocsHelp, printVerifyHelp } from "./project-help.mjs";

/** @typedef {"build" | "check" | "built"} StepPhase */
/** @typedef {{ readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv | undefined; readonly phase: StepPhase }} ProjectStep */
/** @typedef {{ readonly mode: string; readonly passthrough: readonly string[]; readonly showHelp: boolean }} VerifyOptions */
/** @typedef {{ readonly target: string; readonly mode: string }} DocsOptions */

const nodeCommand = process.execPath;
const binSuffix = process.platform === "win32" ? ".cmd" : "";

class UsageError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

class CommandFailure extends Error {
	/** @param {string} message
	 * @param {number | null | undefined} exitCode */
	constructor(message, exitCode) {
		super(message);
		this.exitCode = exitCode ?? 1;
	}
}

/** @param {string} command
 * @param {readonly string[]} args */
function commandLabel(command, args) {
	return [command, ...args].join(" ");
}

/** @param {string} command */
function shouldUseShell(command) {
	return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/** @param {string} command
 * @param {readonly string[]} args
 * @param {{ readonly env?: NodeJS.ProcessEnv | undefined }} [options]
 * @returns {Promise<void>} */
async function run(command, args, options = {}) {
	console.log(`\n> ${commandLabel(command, args)}`);
	const child = spawn(command, args, {
		cwd: process.cwd(),
		env: { ...process.env, ...options.env },
		shell: shouldUseShell(command),
		stdio: "inherit",
	});
	/** @type {unknown[]} */
	const closed = await once(child, "close");
	const [code, signal] = closed;
	if (typeof signal === "string") {
		throw new Error(`${commandLabel(command, args)} was terminated by ${signal}`);
	}
	const exitCode = typeof code === "number" ? code : null;
	if (exitCode !== 0) {
		throw new CommandFailure(
			`${commandLabel(command, args)} exited with code ${exitCode ?? "unknown"}`,
			exitCode,
		);
	}
}

/** @param {readonly ProjectStep[]} steps */
export async function runSteps(steps) {
	/** @type {Error[]} */
	const failures = [];
	let buildFailed = false;
	for (const step of steps) {
		if (buildFailed && step.phase === "built") {
			console.error(`Blocked by failed build: ${commandLabel(step.command, step.args)}`);
			continue;
		}
		try {
			await run(step.command, step.args, { env: step.env });
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			failures.push(error);
			console.error(error.message);
			buildFailed ||= step.phase === "build";
		}
	}
	const [firstFailure] = failures;
	if (firstFailure !== undefined) {
		throw firstFailure;
	}
}

/** @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {StepPhase} [phase]
 * @returns {ProjectStep} */
function scriptStep(args, env, phase = "check") {
	return { command: nodeCommand, args, env, phase };
}

/** @param {string} [pathValue] */
export function hostToolPath(pathValue = process.env.PATH ?? "") {
	return pathValue
		.split(delimiter)
		.filter(
			(directory) => directory.length > 0 && !/(^|[\\/])node_modules[\\/]\.bin$/i.test(directory),
		)
		.join(delimiter);
}

/** @param {string} command
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {StepPhase} [phase]
 * @returns {ProjectStep} */
function localToolStep(command, args, env, phase = "check") {
	if (command === "tsc" && process.platform === "android") {
		return { command: "tsgo", args, env, phase };
	}
	return {
		command: join(process.cwd(), "node_modules", ".bin", `${command}${binSuffix}`),
		args,
		env,
		phase,
	};
}

/** @param {readonly string[]} argv
 * @returns {{ readonly showHelp: true } | (DocsOptions & { readonly showHelp: false })} */
export function parseDocsArgs(argv) {
	if (argv.includes("-h") || argv.includes("--help")) {
		return { showHelp: true };
	}

	let target = "all";
	let mode = "check";
	for (const rawArg of argv) {
		const arg = rawArg.startsWith("--") ? rawArg.slice(2) : rawArg;
		if (["all", "command-reference"].includes(arg)) {
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

/** @param {DocsOptions} options */
export function docsSteps(options) {
	const modeFlag = `--${options.mode}`;
	const steps = [];
	if (options.target === "all" || options.target === "command-reference") {
		steps.push(scriptStep(["./scripts/check-command-reference-baseline.mjs", modeFlag]));
	}
	return steps;
}

/** @param {readonly string[]} argv
 * @returns {VerifyOptions} */
export function parseVerifyArgs(argv) {
	if (argv.includes("-h") || argv.includes("--help")) {
		return { mode: "default", passthrough: [], showHelp: true };
	}
	const [rawMode, ...rest] = argv;
	const mode = rawMode ?? "default";
	const supportedModes = new Set([
		"default",
		"quality",
		"typecheck",
		"command-reference",
		"pre-pr",
		"startup-profile",
		"real-upstream",
		"dogfood",
		"package",
		"package-pi",
		"lifecycle",
		"platform-target",
		"platform-smoke",
		"release",
	]);
	if (!supportedModes.has(mode)) {
		throw new UsageError(`Unknown verify mode: ${mode}`);
	}
	return { mode, passthrough: rest, showHelp: false };
}

/** @param {readonly string[]} passthrough */
function validatePlatformSmokePassthrough(passthrough) {
	const allowedCommands = new Set(["doctor", "run"]);
	const allowedFlags = new Set(["--target", "--suite"]);
	let commandCount = 0;
	const args = passthrough.values();
	for (const arg of args) {
		if (allowedCommands.has(arg)) {
			commandCount += 1;
			if (commandCount > 1) {
				throw new UsageError("platform-smoke accepts one command: doctor or run.");
			}
			continue;
		}
		if (!allowedFlags.has(arg)) {
			throw new UsageError(`Option ${arg} is not supported for verify mode platform-smoke.`);
		}
		const value = args.next().value;
		if (value === undefined || value.length === 0 || value.startsWith("-")) {
			throw new UsageError(`${arg} requires a value.`);
		}
	}
}

/** @param {string} mode
 * @param {readonly string[]} passthrough */
function validatePassthrough(mode, passthrough) {
	if (mode === "platform-smoke") {
		validatePlatformSmokePassthrough(passthrough);
		return;
	}
	const lifecycleOptions = new Set(["--keep-artifacts", "--model", "--verbose", "--timeout-ms"]);
	/** @type {Readonly<Record<string, ReadonlySet<string>>>} */
	const allowedByMode = {
		default: new Set(),
		quality: new Set(),
		typecheck: new Set(),
		"command-reference": new Set(),
		"pre-pr": new Set(),
		"startup-profile": new Set(["--samples", "--json"]),
		"real-upstream": new Set(),
		dogfood: new Set(["--artifact-dir", "--keep-artifacts", "--json"]),
		package: new Set(["--list-files"]),
		"package-pi": new Set(["--list-files"]),
		lifecycle: lifecycleOptions,
		"platform-target": new Set(),
		// Release forwards these options only to its lifecycle step.
		release: lifecycleOptions,
	};
	const allowed = allowedByMode[mode];
	const args = passthrough.values();
	for (const arg of args) {
		if (allowed?.has(arg) !== true) {
			throw new UsageError(`Option ${arg} is not supported for verify mode ${mode}.`);
		}
		const valueFlags = new Map([
			["--model", "a value"],
			["--timeout-ms", "a value"],
			["--artifact-dir", "a path"],
			["--samples", "a value"],
		]);
		const requirement = valueFlags.get(arg);
		if (requirement !== undefined) {
			const value = args.next().value;
			if (
				value === undefined ||
				value.length === 0 ||
				(arg !== "--timeout-ms" && value.startsWith("-"))
			) {
				throw new UsageError(`${arg} requires ${requirement}.`);
			}
		}
	}
}

// verify-lifecycle.mjs owns lifecycle option values; release must reject them before earlier steps run.
/** @param {VerifyOptions} options */
async function validateLifecycleValues({ mode, passthrough }) {
	if (mode !== "lifecycle" && mode !== "release") {
		return;
	}
	const { parseCliArgs } = await import("./verify-lifecycle.mjs");
	try {
		parseCliArgs(passthrough);
	} catch (error) {
		if (error instanceof Error && error.name === "UsageError") {
			throw new UsageError(error.message);
		}
		throw error;
	}
}

function buildStep() {
	return scriptStep(["./scripts/build.mjs"], undefined, "build");
}

function commandReferenceSteps() {
	return [
		...docsSteps({ mode: "check", target: "command-reference" }),
		scriptStep(["./scripts/verify-command-reference.mjs"]),
	];
}

/** @param {boolean} [tap] */
function contractTestSteps(tap = false) {
	const cli = fileURLToPath(import.meta.resolve("tsx/cli"));
	const args = [cli, "--test", ...(tap ? ["--test-reporter=tap"] : [])];
	return [
		scriptStep([...args, "test/**/!(*.serial).test.ts"], undefined, "built"),
		scriptStep([...args, "--test-concurrency=1", "test/**/*.serial.test.ts"], undefined, "built"),
	];
}

export function testSteps() {
	return [buildStep(), ...contractTestSteps(true)];
}

function qualitySteps() {
	return [
		buildStep(),
		scriptStep(["./scripts/code-quality.mjs", "lint"]),
		localToolStep("oxfmt", ["--check", "."]),
	];
}

function realUpstreamSteps() {
	const file = "test/agent-browser.real-upstream-contract.test.ts";
	const env = { PI_AGENT_BROWSER_REAL_UPSTREAM: "1" };
	return [
		localToolStep(
			"tsx",
			["--test", "--test-force-exit", "--test-name-pattern", "plugin list stays sessionless", file],
			env,
		),
		localToolStep(
			"tsx",
			["--test", "--test-force-exit", "--test-skip-pattern", "plugin list stays sessionless", file],
			env,
		),
		localToolStep(
			"tsx",
			["--test", "--test-force-exit", "test/agent-browser.batch-fidelity.test.ts"],
			env,
		),
		localToolStep(
			"tsx",
			["--test", "--test-force-exit", "test/agent-browser.overlay-real-upstream.test.ts"],
			env,
		),
	];
}

function typecheckSteps() {
	return [
		localToolStep("tsc", ["--noEmit"]),
		localToolStep("tsc", ["--noEmit", "-p", "tsconfig.declarations.json"]),
	];
}

function platformTargetSteps() {
	return [
		...qualitySteps(),
		...typecheckSteps(),
		localToolStep(
			"tsx",
			[
				"--test",
				"--test-concurrency=1",
				"test/code-quality*.test.ts",
				"test/project-verify.test.ts",
				"test/platform-smoke.test.ts",
				"test/verify-package.test.ts",
				"test/agent-browser.runtime.test.ts",
			],
			undefined,
			"built",
		),
		...docsSteps({ mode: "check", target: "all" }),
	];
}

/** @param {VerifyOptions} options
 * @returns {ProjectStep[]} */
export function verifySteps(options) {
	validatePassthrough(options.mode, options.passthrough);
	switch (options.mode) {
		case "default":
		case "quality":
			return [
				...qualitySteps(),
				...typecheckSteps(),
				...contractTestSteps(),
				...commandReferenceSteps(),
			];
		case "typecheck":
			return typecheckSteps();
		case "command-reference":
			return commandReferenceSteps();
		case "pre-pr":
			return [
				...verifySteps({ mode: "default", passthrough: [], showHelp: false }),
				...verifySteps({ mode: "package", passthrough: [], showHelp: false }),
			];
		case "startup-profile":
			return [scriptStep(["./scripts/profile-startup.mjs", ...options.passthrough])];
		case "real-upstream":
			return realUpstreamSteps();
		case "dogfood":
			return [
				buildStep(),
				localToolStep(
					"tsx",
					["./scripts/verify-agent-browser-dogfood.ts", ...options.passthrough],
					undefined,
					"built",
				),
			];
		case "package":
			return [scriptStep(["./scripts/verify-package.mjs", ...options.passthrough])];
		case "package-pi":
			return [scriptStep(["./scripts/verify-package.mjs", "--smoke-pi", ...options.passthrough])];
		case "lifecycle":
			return [
				scriptStep(["./scripts/verify-lifecycle.mjs", ...options.passthrough], {
					PATH: hostToolPath(),
				}),
			];
		case "platform-target":
			return platformTargetSteps();
		case "platform-smoke":
			return [scriptStep(["./scripts/platform-smoke.mjs", ...options.passthrough])];
		case "release":
			return [
				...verifySteps({ mode: "default", passthrough: [], showHelp: false }),
				...verifySteps({ mode: "lifecycle", passthrough: options.passthrough, showHelp: false }),
				...verifySteps({ mode: "package-pi", passthrough: [], showHelp: false }),
				scriptStep(["./scripts/platform-smoke.mjs", "doctor"]),
				scriptStep(["./scripts/platform-smoke.mjs", "run"]),
			];
		default:
			throw new UsageError(`Unknown verify mode: ${options.mode}`);
	}
}

/** @param {readonly string[]} args */
async function runTestCommand(args) {
	if (args.length > 0) {
		throw new UsageError("The complete test gate does not accept options or filtered test paths.");
	}
	try {
		await runSteps(testSteps());
		return 0;
	} catch (error) {
		// Preserve npm test's former && chain status without changing verify/docs exits.
		if (error instanceof CommandFailure) {
			console.error(error.message);
			return error.exitCode;
		}
		throw error;
	}
}

/** @param {readonly string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
	const [command, ...rest] = argv;
	switch (command) {
		case undefined:
		case "":
		case "-h":
		case "--help":
			printTopLevelHelp();
			return 0;
		case "test":
			return runTestCommand(rest);
		case "docs": {
			const options = parseDocsArgs(rest);
			if (options.showHelp) {
				printDocsHelp();
				return 0;
			}
			await runSteps(docsSteps(options));
			return 0;
		}
		case "verify": {
			const options = parseVerifyArgs(rest);
			if (options.showHelp) {
				printVerifyHelp();
				return 0;
			}
			const steps = verifySteps(options);
			await validateLifecycleValues(options);
			await runSteps(steps);
			return 0;
		}
		default:
			throw new UsageError(`Unknown project command: ${command}`);
	}
}

if (import.meta.main) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((/** @type {unknown} */ error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = error instanceof UsageError ? 2 : 1;
		});
}
