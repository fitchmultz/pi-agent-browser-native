#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the published Pi package loads.
 * Responsibilities: Remove stale dist output, emit all checkout runtime assets, bundle the packaged entrypoints, and fail with clear build output.
 * Scope: Maintainer/package build only; runtime behavior remains in extensions/agent-browser TypeScript sources.
 * Usage: `npm run build` before package verification, lifecycle validation, and npm pack/publish.
 * Invariants/Assumptions: `node_modules` provides `typescript` and `esbuild`; Termux supplies Android-native `tsgo` on PATH. `dist/` is generated output.
 */

import { execFile as execFileCallback } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

const packagedLibraries = [
	"lib/config-policy",
	"lib/browser-session-conversion",
	"lib/parsing",
	"lib/playbook",
	"lib/results/snapshot",
	"lib/runtime",
];

/** @param {unknown} error */
function printCompilerOutput(error) {
	if (error === null || typeof error !== "object") {
		return;
	}
	if ("stdout" in error && typeof error.stdout === "string") {
		process.stdout.write(error.stdout);
	}
	if ("stderr" in error && typeof error.stderr === "string") {
		process.stderr.write(error.stderr);
	}
}

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
		if (stdout.length > 0) {
			process.stdout.write(stdout);
		}
		if (stderr.length > 0) {
			process.stderr.write(stderr);
		}
	} catch (error) {
		printCompilerOutput(error);
		throw error;
	}
	// Raw checkout libraries share module-owned state; package-only bundles must not overwrite them.
	const distDirectory = join(process.cwd(), "dist");
	const runtimeDirectory = join(process.cwd(), "dist", "extensions", "agent-browser");
	await build({
		allowOverwrite: true,
		bundle: true,
		entryPoints: [
			{ in: join(runtimeDirectory, "index.js"), out: "extensions/agent-browser/index" },
			...packagedLibraries.map((path) => ({
				in: join(runtimeDirectory, `${path}.js`),
				out: `packaged/${path}`,
			})),
		],
		format: "esm",
		outdir: distDirectory,
		packages: "external",
		platform: "node",
		target: "node24.21",
	});
	await Promise.all(
		packagedLibraries.map(async (path) => {
			const declaration = join(distDirectory, "packaged", `${path}.d.ts`);
			const source = relative(dirname(declaration), join(runtimeDirectory, `${path}.js`));
			await writeFile(
				declaration,
				`export * from ${JSON.stringify(source.replaceAll("\\", "/"))};\n`,
			);
		}),
	);
}

main().catch((/** @type {unknown} */ error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
