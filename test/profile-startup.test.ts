import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readArray, readBoolean, readNumber, readRecord } from "./helpers/assertions.js";

test("startup profiler preserves all fresh sample receipts when the strict budget fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-startup-report-"));
	try {
		await mkdir(join(directory, "scripts"));
		await Promise.all([
			copyFile("scripts/profile-startup.mjs", join(directory, "scripts/profile-startup.mjs")),
			copyFile(
				"scripts/startup-measurement.mjs",
				join(directory, "scripts/startup-measurement.mjs"),
			),
			writeFile(
				join(directory, "package.json"),
				JSON.stringify({ type: "module", pi: { extensions: ["./entrypoint.mjs"] } }),
			),
			// This report test supplies JavaScript directly; package tests own the real compiler build.
			writeFile(join(directory, "scripts/build.mjs"), ""),
			writeFile(
				join(directory, "entrypoint.mjs"),
				`await new Promise((resolve) => setTimeout(resolve, 300));
export default function extension(pi) {
  pi.on("session_start", () => {});
  pi.registerTool({ name: "agent_browser" });
}
`,
			),
		]);
		const result = spawnSync(
			process.execPath,
			["scripts/profile-startup.mjs", "--samples", "3", "--json"],
			{
				cwd: directory,
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
				maxBuffer: 1024 * 1024,
				timeout: 20_000,
			},
		);
		assert.equal(result.status, 1, "a failed budget must retain its nonzero exit");
		assert.match(result.stderr, /Direct startup exceeded 250ms budget/);
		const artifact = resolve(directory, ".artifacts/startup-profile/latest.json");
		const stored = readRecord(JSON.parse(await readFile(artifact, "utf8")));
		const visible = readRecord(JSON.parse(result.stdout));
		assert.deepEqual(visible, stored, "the JSON report and saved failure receipt must agree");
		assert.equal(
			readBoolean(readRecord(readRecord(stored.summary).directImport).withinBudget),
			false,
		);
		const samples = readArray(readRecord(stored.samples).directImport).map(readRecord);
		assert.equal(samples.length, 3);
		assert.equal(
			new Set(samples.map((sample) => readNumber(readRecord(sample.diagnostics).pid))).size,
			3,
		);
		assert.ok(samples.every((sample) => readNumber(sample.totalMs) >= 250));
		assert.ok(
			samples.every(
				(sample) =>
					readNumber(readRecord(sample.diagnostics).mainThreadCpuMs) < readNumber(sample.totalMs),
			),
			"the deliberately idle import must report actual CPU, not copy elapsed wall time",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
