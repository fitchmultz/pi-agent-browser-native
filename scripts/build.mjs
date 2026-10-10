#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the published Pi package loads.
 * Responsibilities: Remove stale dist output, emit runtime assets, bundle the native entrypoint, and fail with clear build output.
 * Scope: Maintainer/package build only; runtime behavior remains in extensions/agent-browser TypeScript sources.
 * Usage: `npm run build` before package verification, lifecycle validation, and npm pack/publish.
 * Invariants/Assumptions: `node_modules` provides `typescript`; Termux supplies Android-native `tsgo` on PATH. `dist/` is generated output.
 */

import { execFile as execFileCallback } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFile = promisify(execFileCallback);
const binSuffix = process.platform === "win32" ? ".cmd" : "";
// TypeScript's npm binaries do not support Android; Termux supplies native tsgo.
const tscPath =
	process.platform === "android"
		? "tsgo"
		: join(process.cwd(), "node_modules", ".bin", `tsc${binSuffix}`);

async function main() {
	await rm(join(process.cwd(), "dist"), {
		force: true,
		maxRetries: 5,
		recursive: true,
		retryDelay: 100,
	});
	const options = process.platform === "win32" ? { shell: true } : {};
	try {
		const { stderr, stdout } = await execFile(tscPath, ["-p", "tsconfig.build.json"], {
			...options,
			cwd: process.cwd(),
			maxBuffer: 10 * 1024 * 1024,
		});
		if (stdout) {
			process.stdout.write(stdout);
		}
		if (stderr) {
			process.stderr.write(stderr);
		}
	} catch (error) {
		if (error?.stdout) {
			process.stdout.write(error.stdout);
		}
		if (error?.stderr) {
			process.stderr.write(error.stderr);
		}
		throw error;
	}
	// Retain emitted workers and CLI modules; only the extension's cold import graph is bundled.
	const entrypoint = join(process.cwd(), "dist", "extensions", "agent-browser", "index.js");
	await build({
		allowOverwrite: true,
		bundle: true,
		entryPoints: [entrypoint],
		format: "esm",
		outfile: entrypoint,
		packages: "external",
		platform: "node",
		target: "node24.21",
	});
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
