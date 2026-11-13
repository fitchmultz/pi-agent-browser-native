#!/usr/bin/env node
/**
 * Purpose: Build generated dist output for GitHub/source installs even when Pi invokes npm install --omit=dev.
 * Responsibilities: Detect missing source-build dependencies, temporarily install dev dependencies with lifecycle scripts disabled, run the canonical build, and prune those temporary dev dependencies afterward while leaving pre-existing checkout dev dependencies intact.
 * Scope: Package install lifecycle only; npm tarball contents and runtime behavior remain owned by scripts/build.mjs.
 * Usage: package.json prepare script.
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const REQUIRED_SOURCE_BUILD_MODULES = [
	"typescript",
	"esbuild",
	"typebox",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];
const INHERITED_NPM_OMIT_ENV_PATTERN =
	/^npm_config_(?:also|dev|dry[-_]run|include|omit|only|production)$/iu;
const INSTALL_DEV_DEPENDENCIES_ARGS = [
	"install",
	"--include=dev",
	"--legacy-peer-deps",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
];
const PRUNE_DEV_DEPENDENCIES_ARGS = [
	"prune",
	"--omit=dev",
	"--legacy-peer-deps",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
];

function canResolveBuildDependencies() {
	return REQUIRED_SOURCE_BUILD_MODULES.every((moduleName) => {
		try {
			return existsSync(new URL(import.meta.resolve(moduleName)));
		} catch {
			return false;
		}
	});
}

function buildNpmEnv() {
	/** @type {NodeJS.ProcessEnv} */
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!INHERITED_NPM_OMIT_ENV_PATTERN.test(key)) {
			env[key] = value;
		}
	}
	return env;
}

/** @param {readonly string[]} args */
async function runNpm(args) {
	const npmExecPath = process.env.npm_execpath;
	const baseOptions = {
		cwd: process.cwd(),
		env: buildNpmEnv(),
		maxBuffer: 20 * 1024 * 1024,
	};
	if (npmExecPath !== undefined && npmExecPath.length > 0) {
		await execFile(process.execPath, [npmExecPath, ...args], baseOptions);
		return;
	}
	await execFile(process.platform === "win32" ? "npm.cmd" : "npm", [...args], {
		...baseOptions,
		...(process.platform === "win32" ? { shell: true } : {}),
	});
}

/** @param {unknown} error */
function reportError(error) {
	if (error !== null && typeof error === "object") {
		if ("stdout" in error && typeof error.stdout === "string" && error.stdout.length > 0) {
			process.stdout.write(error.stdout);
		}
		if ("stderr" in error && typeof error.stderr === "string" && error.stderr.length > 0) {
			process.stderr.write(error.stderr);
		}
	}
	console.error(error instanceof Error ? error.message : String(error));
}

/** @param {boolean} buildFailed */
async function pruneAfterBuild(buildFailed) {
	try {
		await runNpm(PRUNE_DEV_DEPENDENCIES_ARGS);
	} catch (error) {
		if (!buildFailed) {
			throw error;
		}
		reportError(error);
	}
}

async function main() {
	const installedTemporaryDevDependencies = !canResolveBuildDependencies();
	if (installedTemporaryDevDependencies) {
		await runNpm(INSTALL_DEV_DEPENDENCIES_ARGS);
	}
	let buildFailed = false;
	try {
		await execFile(process.execPath, [join(process.cwd(), "scripts", "build.mjs")], {
			cwd: process.cwd(),
			maxBuffer: 20 * 1024 * 1024,
		});
	} catch (error) {
		buildFailed = true;
		throw error;
	} finally {
		if (installedTemporaryDevDependencies) {
			await pruneAfterBuild(buildFailed);
		}
	}
}

main().catch((/** @type {unknown} */ error) => {
	reportError(error);
	process.exitCode = 1;
});
