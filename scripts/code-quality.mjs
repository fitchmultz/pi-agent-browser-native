#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyScope } from "./code-quality-policy.mjs";

/** @param {string} inventory
 * @returns {Promise<void>} */
function printInventory(inventory) {
	return new Promise((fulfill) => {
		process.stdout.write(`${inventory}\n`, (error) => {
			if (error !== undefined && error !== null) {
				// A closed stdout reader must not prevent lint from reporting its verdict.
				process.stdout.once("error", () => {
					fulfill();
				});
			}
			fulfill();
		});
	});
}

const [mode = "check", ...args] = process.argv.slice(2);
if (mode === "--help" || mode === "-h") {
	console.log("Usage: node scripts/code-quality.mjs [check|scope|lint] [--fix|--format=agent]");
} else {
	const validMode = mode === "check" || mode === "scope" || mode === "lint";
	if (
		!validMode ||
		args.some((arg) => mode !== "lint" || !["--fix", "--format=agent"].includes(arg))
	) {
		throw new Error("Unsupported quality mode/argument; use --help");
	}
	let policyFailed = false;
	try {
		const scope = verifyScope(process.cwd());
		await printInventory(
			`Policy: ${scope.files.length} maintained files; ${scope.projects.length} compiler projects; ${scope.exceptions.length} qualified directives.`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		policyFailed = true;
	}
	if (mode === "lint") {
		const child = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./oxlint.mjs", import.meta.url)), "--deny-warnings", ...args, "."],
			{ stdio: "inherit" },
		);
		if (child.error !== undefined) {
			throw child.error;
		}
		process.exitCode = policyFailed || child.status !== 0 ? 1 : 0;
	} else {
		process.exitCode = policyFailed ? 1 : 0;
	}
}
