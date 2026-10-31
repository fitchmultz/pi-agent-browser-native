#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyScope } from "./code-quality-policy.mjs";
import { readonlyBoundaries, mutationBoundaries } from "./code-quality-boundaries.mjs";

const [mode = "check", ...args] = process.argv.slice(2);
if (mode === "--help" || mode === "-h") {
	console.log(`Usage: node scripts/code-quality.mjs [check|scope|lint] [--write|--fix|--format=agent]

check   Verify compiler/lint scope and comment-aware suppression policy.
scope   Same check; --write regenerates the final root unchecked-JS override.
lint    Run policy checks, then the locked Oxlint CLI over all maintained code.

Examples: npm run lint; npm run lint:agent; npm run quality:scope -- --write`);
} else {
	const allowed = { check: [], scope: ["--write"], lint: ["--fix", "--format=agent"] };
	if (!Object.hasOwn(allowed, mode) || args.some((arg) => !allowed[mode].includes(arg))) {
		throw new Error("Unsupported quality mode/argument; use --help");
	}
	const result = verifyScope(process.cwd(), mode === "scope" && args.includes("--write"));
	if (args.includes("--write")) {
		// Generated ownership boundaries immediately precede the final language override.
		const firstGenerated = result.config.overrides.findIndex(
			(override) => override.rules["typescript/prefer-readonly-parameter-types"] !== undefined,
		);
		const keep = firstGenerated < 0 ? result.config.overrides.length - 1 : firstGenerated;
		result.config.overrides = [
			...result.config.overrides.slice(0, keep),
			...result.boundaries,
			result.expected,
		];
		writeFileSync(".oxlintrc.json", `${JSON.stringify(result.config, null, "\t")}\n`);
		const formatter = spawnSync(
			process.execPath,
			[resolve("node_modules/oxfmt/bin/oxfmt"), "--write", ".oxlintrc.json"],
			{ stdio: "inherit" },
		);
		if (formatter.error !== undefined) {
			throw formatter.error;
		}
		if (formatter.status !== 0) {
			process.exit(formatter.status ?? 1);
		}
	}
	const inventory = JSON.stringify({
		projects: result.scope.projects,
		maintained: result.scope.files.length,
		uncheckedJavaScript: result.scope.unchecked,
		exceptions: result.scope.exceptions,
		readonlyBoundaries,
		mutationBoundaries,
	});
	// POSIX pipe writes finish asynchronously and spawnSync blocks the event loop, so
	// flush the whole inventory line before Oxlint writes diagnostics to this stdout.
	// Like console.log, carry on when stdout cannot be written (for example, a reader
	// that already closed): the stream emits that error after this callback, so absorb
	// it there instead of crashing before lint runs and reports its own verdict.
	await new Promise((fulfill) => {
		process.stdout.write(`${inventory}\n`, (error) => {
			if (error) {
				process.stdout.once("error", fulfill);
			}
			fulfill();
		});
	});
	if (mode === "lint") {
		const child = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./oxlint.mjs", import.meta.url)), "--deny-warnings", ...args, "."],
			{
				stdio: "inherit",
			},
		);
		if (child.error !== undefined) {
			throw child.error;
		}
		process.exitCode = child.status ?? 1;
	}
}
