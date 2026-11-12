#!/usr/bin/env node
/**
 * Purpose: Provide the Crabbox-backed platform smoke CLI for pi-agent-browser-native releases.
 * Responsibilities: Load the project platform smoke config, validate target/suite names, run doctor, and fan out target suites.
 * Scope: Maintainer release verification only; target command rendering and artifact assertions live under scripts/platform-smoke/.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @import { PlatformSmokeConfig } from "../platform-smoke.config.mjs" */
/** @import { ReleaseCandidate } from "./platform-smoke/commands.mjs" */
/** @typedef {{command: "doctor" | "run" | "help" | null; target: string | null; suite: string | null}} ParsedArgs */
/** @typedef {Awaited<ReturnType<typeof import("./platform-smoke/targets.mjs").runTargetSuites>>} TargetRun */

/** @type {PlatformSmokeConfig | null} */
let loadedConfig;
try {
	loadedConfig = (await import("../platform-smoke.config.mjs")).default;
} catch {
	loadedConfig = null;
}

function printHelp() {
	console.log(`Usage: node scripts/platform-smoke.mjs <command> [options]

Commands:
  doctor [--target <names>]  Validate prerequisites for selected targets (required by default)
  run [--target <names>]    Run required or explicitly selected targets concurrently
  run --suite <name>         Run one suite on required or specified targets

Package scripts:
  check:platform-smoke       Syntax-check harness scripts and run cheap harness invariant tests
  smoke:platform:ubuntu-image Build the local Ubuntu image used by default
  smoke:platform:all         Runs doctor first, then required macOS/Ubuntu targets

Targets:
  macos (Apple Silicon), ubuntu (required)

Suites:
  platform-build             npm ci, npm run verify -- platform-target, npm pack, packed pi install --approve, pi list --approve
  browser-dogfood-smoke      model-free native agent_browser smoke with real agent-browser/browser

Options:
  --target <names>           Comma-separated target names; defaults to configured required targets
  --suite <name>             Suite name; defaults to configured required suites
  --help, -h                 Show this help

Examples:
  npm run check:platform-smoke
  npm run smoke:platform:doctor
  npm run smoke:platform:all
  node scripts/platform-smoke.mjs doctor
  node scripts/platform-smoke.mjs run --target macos
  node scripts/platform-smoke.mjs run --target ubuntu --suite platform-build
  node scripts/platform-smoke.mjs run --target macos,ubuntu

Environment:
  PLATFORM_SMOKE_CRABBOX              Optional Crabbox binary override; defaults to crabbox on PATH
  PLATFORM_SMOKE_MAC_HOST             macOS SSH host; default localhost
  PLATFORM_SMOKE_MAC_USER             macOS SSH user; default $USER
  PLATFORM_SMOKE_MAC_WORK_ROOT        macOS Crabbox work root
  PLATFORM_SMOKE_MAC_PORT             macOS SSH port; default 22
  PLATFORM_SMOKE_UBUNTU_IMAGE         Ubuntu local-container image; default ${loadedConfig?.ubuntuContainerImage ?? "pi-agent-browser-native-platform:node24-agent-browser<target>"}
  PLATFORM_SMOKE_AUTH_ENV             Optional comma-separated secret env names to redact/forward for future live suites
`);
}

/** @param {readonly string[]} [argv] */
export function parseArgs(argv = process.argv.slice(2)) {
	/** @type {ParsedArgs} */
	const parsed = { command: null, target: null, suite: null };
	const words = argv.values();
	for (const arg of words) {
		switch (arg) {
			case "--help":
			case "-h":
				parsed.command = "help";
				return parsed;
			case "doctor":
			case "run":
				if (parsed.command !== null) {
					throw new Error(`multiple commands provided: ${parsed.command}, ${arg}`);
				}
				parsed.command = arg;
				break;
			case "--target":
			case "--suite": {
				const value = words.next().value;
				if (value === undefined || value.length === 0 || value.startsWith("-")) {
					throw new Error(`${arg} requires a value`);
				}
				parsed[arg === "--target" ? "target" : "suite"] = value;
				break;
			}
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return parsed;
}

/** @param {string} kind
 * @param {readonly string[]} names
 * @param {readonly string[]} allowed
 */
function validateNames(kind, names, allowed) {
	const invalid = names.filter((name) => !allowed.includes(name));
	if (invalid.length > 0) {
		throw new Error(`unknown ${kind}: ${invalid.join(", ")}`);
	}
}

/** @param {PlatformSmokeConfig} config
 * @param {Readonly<ParsedArgs>} args
 */
function selectedTargets(config, args) {
	const targets =
		args.target !== null && args.target.length > 0
			? args.target
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean)
			: config.requiredTargets;
	validateNames("target", targets, config.requiredTargets);
	if (targets.length === 0) {
		throw new Error("Select at least one target");
	}
	return targets;
}

/** @param {readonly PromiseSettledResult<{readonly targetName: string; readonly result: TargetRun}>[]} settled
 * @param {string} artifactRoot
 */
function summarizeTargets(settled, artifactRoot) {
	const results = [];
	/** @type {unknown[]} */
	const errors = [];
	for (const outcome of settled) {
		if (outcome.status === "rejected") {
			errors.push(outcome.reason);
		} else {
			results.push(outcome.value);
		}
	}
	if (errors.length > 0) {
		const messages = errors.map((reason) =>
			reason instanceof Error ? reason.message : String(reason),
		);
		throw new AggregateError(errors, `Platform smoke could not complete: ${messages.join("; ")}`);
	}
	const failed = results.filter(({ result }) => !result.ok);
	if (failed.length > 0) {
		console.error(
			`\nPlatform smoke failed for ${failed.map(({ targetName }) => targetName).join(", ")}. See ${artifactRoot}.`,
		);
		return 1;
	}
	console.log(
		`\nPlatform smoke passed for ${results.map(({ targetName }) => targetName).join(", ")}.`,
	);
	return 0;
}

/** @param {PlatformSmokeConfig} config
 * @param {Readonly<ParsedArgs>} args
 */
async function runTargets(config, args) {
	const { runTargetSuites } = await import("./platform-smoke/targets.mjs");
	const targets = selectedTargets(config, args);
	const suites =
		args.suite !== null && args.suite.length > 0 ? [args.suite] : config.requiredSuites;
	validateNames("suite", suites, config.requiredSuites);
	let candidateDirectory;
	try {
		/** @type {ReleaseCandidate | undefined} */
		let stagedCandidate;
		const candidatePath = process.env.PI_AGENT_BROWSER_RELEASE_TARBALL;
		if (candidatePath !== undefined && suites.includes("platform-build")) {
			if (candidatePath.trim().length === 0) {
				throw new Error("PI_AGENT_BROWSER_RELEASE_TARBALL must name a candidate tarball");
			}
			const bytes = await readFile(resolve(candidatePath));
			candidateDirectory = await mkdtemp(resolve(process.cwd(), ".npm-release-candidate-"));
			await writeFile(join(candidateDirectory, "candidate"), bytes, { flag: "wx", mode: 0o600 });
			stagedCandidate = {
				path: `${basename(candidateDirectory)}/candidate`,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		}
		const settled = await Promise.allSettled(
			targets.map(async (targetName) => {
				console.log(`\n=== Target: ${targetName} ===`);
				return {
					targetName,
					result: await runTargetSuites(config, targetName, suites, stagedCandidate),
				};
			}),
		);
		return summarizeTargets(settled, config.artifactRoot);
	} finally {
		if (candidateDirectory !== undefined) {
			await rm(candidateDirectory, { recursive: true, force: true });
		}
	}
}

/** @param {readonly string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
	const config = loadedConfig;
	const args = parseArgs(argv);
	if (args.command === null || args.command === "help") {
		printHelp();
		return args.command === "help" ? 0 : 2;
	}
	if (!config) {
		throw new Error("platform-smoke.config.mjs not found or invalid");
	}

	if (args.command === "doctor") {
		const { runDoctor } = await import("./platform-smoke/doctor.mjs");
		await runDoctor({ ...config, requiredTargets: selectedTargets(config, args) });
		return process.exitCode ?? 0;
	}

	return runTargets(config, args);
}

if (
	process.argv[1] !== undefined &&
	process.argv[1].length > 0 &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((/** @type {unknown} */ error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
