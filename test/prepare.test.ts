import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const buildModules = ["typescript", "typebox", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

for (const [description, missingPath] of [
	["builds without installing when import-only dependencies exist", undefined],
	["installs before building when a dependency is missing", "node_modules/typescript"],
	["installs before building when an exported target is missing", "node_modules/@earendil-works/pi-coding-agent/index.js"],
] as const) {
	test(`prepare ${description}`, async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-prepare-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		await mkdir(join(tempDir, "scripts"));
		await copyFile(new URL("../scripts/prepare.mjs", import.meta.url), join(tempDir, "scripts", "prepare.mjs"));
		await writeFile(join(tempDir, "package.json"), JSON.stringify({
			type: "module",
			devDependencies: Object.fromEntries(buildModules.map((name) => [name, "1.0.0"])),
		}));
		for (const name of buildModules) {
			const moduleDir = join(tempDir, "node_modules", name);
			await mkdir(moduleDir, { recursive: true });
			await writeFile(join(moduleDir, "package.json"), JSON.stringify({
				name,
				version: "1.0.0",
				type: "module",
				exports: { ".": { import: "./index.js" } },
			}));
			await writeFile(join(moduleDir, "index.js"), "export {};\n");
		}
		if (missingPath) await rm(join(tempDir, missingPath), { recursive: true });

		const npmExecPath = join(tempDir, "npm.mjs");
		await writeFile(npmExecPath, `
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
`);
		await writeFile(join(tempDir, "scripts", "build.mjs"), `
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify(["build"]) + "\\n");
`);

		await execFile(process.execPath, [join(tempDir, "scripts", "prepare.mjs")], {
			cwd: tempDir,
			env: { ...process.env, npm_execpath: npmExecPath },
			timeout: 10_000,
		});
		const calls = (await readFile(join(tempDir, "calls.jsonl"), "utf8"))
			.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls, missingPath ? [["install", "--include=dev", "--ignore-scripts"], ["build"]] : [["build"]]);
	});
}
