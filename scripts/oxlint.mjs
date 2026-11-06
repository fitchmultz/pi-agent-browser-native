#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
for (const name of Object.keys(env)) {
	if (
		name.toUpperCase() === "OXLINT_TSGOLINT_PATH" ||
		name.toUpperCase() === "OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS"
	) {
		delete env[name];
	}
}
const child = crossSpawn.spawn(
	process.execPath,
	[join(root, "node_modules", "oxlint", "bin", "oxlint"), ...process.argv.slice(2)],
	{ cwd: process.cwd(), env, stdio: "inherit" },
);
child.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.on("close", (code, signal) => {
	process.exitCode = signal === null ? (code ?? 1) : 1;
});
