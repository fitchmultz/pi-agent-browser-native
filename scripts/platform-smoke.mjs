#!/usr/bin/env node
/**
 * Purpose: Provide the Crabbox-backed platform smoke CLI for pi-agent-browser-native releases.
 * Responsibilities: Load the project platform smoke config, validate target/suite names, run doctor, and fan out target suites.
 * Scope: Maintainer release verification only; target command rendering and artifact assertions live under scripts/platform-smoke/.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let config;
try {
	config = require(resolve(repoRoot, "platform-smoke.config.mjs"));
	if (config.default) config = config.default;
} catch {
	config = null;
}

function printHelp() {
	console.log(`Usage: node scripts/platform-smoke.mjs <command> [options]

Commands:
  doctor                     Validate Crabbox and platform prerequisites
  run --target <names>       Run one or more comma-separated targets concurrently
  run --suite <name>         Run one suite on all or specified targets

Package scripts:
  check:platform-smoke       Syntax-check harness scripts and run cheap harness invariant tests
  smoke:platform:ubuntu-image Build the local Ubuntu image used by default
  smoke:platform:all         Runs doctor first, then the full macOS/Ubuntu/Windows matrix

Targets:
  macos, ubuntu, windows-native

Suites:
  platform-build             npm ci, npm run verify -- platform-target, npm pack, packed pi install, pi list
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
  node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native

Environment:
  PLATFORM_SMOKE_CRABBOX              Optional Crabbox binary override; defaults to crabbox on PATH
  PLATFORM_SMOKE_MAC_HOST             macOS SSH host; default localhost
  PLATFORM_SMOKE_MAC_USER             macOS SSH user; default $USER
  PLATFORM_SMOKE_MAC_WORK_ROOT        macOS Crabbox work root
  PLATFORM_SMOKE_UBUNTU_IMAGE         Ubuntu local-container image; default pi-agent-browser-native-platform:node24-agent-browser0.27.1
  PLATFORM_SMOKE_WINDOWS_VM           Parallels Windows template VM
  PLATFORM_SMOKE_WINDOWS_SNAPSHOT     Parallels snapshot name
  PLATFORM_SMOKE_WINDOWS_USER         Windows SSH user
  PLATFORM_SMOKE_WINDOWS_WORK_ROOT    Windows work root, for example C:\\crabbox\\pi-agent-browser-native
  PLATFORM_SMOKE_AUTH_ENV             Optional comma-separated secret env names to redact/forward for future live suites
`);
}

export function parseArgs(argv = process.argv.slice(2)) {
	const parsed = { command: null, target: null, suite: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			parsed.command = "help";
			return parsed;
		}
		if (arg === "doctor" || arg === "run") {
			if (parsed.command) throw new Error(`multiple commands provided: ${parsed.command}, ${arg}`);
			parsed.command = arg;
			continue;
		}
		if (arg === "--target") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) throw new Error("--target requires a value");
			parsed.target = value;
			index += 1;
			continue;
		}
		if (arg === "--suite") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) throw new Error("--suite requires a value");
			parsed.suite = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return parsed;
}

function validateNames(kind, names, allowed) {
	const invalid = names.filter((name) => !allowed.includes(name));
	if (invalid.length > 0) throw new Error(`unknown ${kind}: ${invalid.join(", ")}`);
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (!args.command || args.command === "help") {
		printHelp();
		return args.command === "help" ? 0 : 2;
	}
	if (!config) throw new Error("platform-smoke.config.mjs not found or invalid");

	if (args.command === "doctor") {
		const { runDoctor } = await import("./platform-smoke/doctor.mjs");
		await runDoctor(config);
		return process.exitCode ?? 0;
	}

	if (args.command === "run") {
		const { runTargetSuite, runTargetSuites } = await import("./platform-smoke/targets.mjs");
		const targets = args.target ? args.target.split(",").map((name) => name.trim()).filter(Boolean) : config.requiredTargets;
		const suites = args.suite ? [args.suite] : config.requiredSuites;
		const supportedTargets = config.supportedTargets ?? config.requiredTargets;
		validateNames("target", targets, supportedTargets);
		validateNames("suite", suites, config.requiredSuites);
		const runs = targets.map(async (targetName) => {
			console.log(`\n=== Target: ${targetName} ===`);
			const result = args.suite
				? await runTargetSuite(config, targetName, suites[0])
				: await runTargetSuites(config, targetName, suites);
			return { targetName, result };
		});
		const results = await Promise.all(runs);
		const failed = results.filter(({ result }) => !result.ok);
		if (failed.length > 0) {
			console.error(`\nPlatform smoke failed for ${failed.map(({ targetName }) => targetName).join(", ")}. See ${config.artifactRoot}.`);
			return 1;
		}
		console.log(`\nPlatform smoke passed for ${results.map(({ targetName }) => targetName).join(", ")}.`);
		return 0;
	}

	throw new Error(`unknown command: ${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		},
	);
}
