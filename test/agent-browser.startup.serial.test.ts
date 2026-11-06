/**
 * Purpose: Guard the native extension cold-start path for issue #84.
 * Responsibilities: Measure the package extension entrypoint import plus extension factory registration in fresh Node processes.
 * Scope: Startup budget only; schema compatibility and runtime behavior have dedicated tests.
 */

import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { readFile } from "node:fs/promises";
import { test as nodeTest } from "node:test";

import { DIRECT_IMPORT_BUDGET_MS, measureColdStartup } from "../scripts/startup-measurement.mjs";

const STARTUP_BUDGET_MS = process.platform === "android" ? 1_000 : DIRECT_IMPORT_BUDGET_MS;

async function getPackageExtensionEntrypoint(): Promise<string> {
	const packageJson = readRecord(JSON.parse(await readFile("package.json", "utf8")));
	const entrypoint = readArray(readRecord(packageJson.pi).extensions)[0];
	assert.equal(
		typeof entrypoint,
		"string",
		"package.json pi.extensions[0] should name the packaged extension entrypoint",
	);
	return readString(entrypoint);
}

nodeTest("agent_browser cold startup stays below the issue #84 regression budget", async (t) => {
	const entrypoint = await getPackageExtensionEntrypoint();
	assert.equal(entrypoint, "./dist/extensions/agent-browser/index.js");
	// Measure one cold Pi extension load at a time on every platform. Parallel
	// samples compete for the hosted runner's CPU; each sample still imports in
	// a fresh process and every result must meet the unchanged startup budget.
	const measurements = [
		await measureColdStartup(entrypoint),
		await measureColdStartup(entrypoint),
		await measureColdStartup(entrypoint),
	];
	const totals = measurements.map((measurement) => measurement.totalMs);
	const maxTotal = Math.max(...totals);
	t.diagnostic(`Cold startup evidence: ${JSON.stringify(measurements)}`);
	assert.equal(
		new Set(measurements.map((measurement) => measurement.diagnostics.pid)).size,
		3,
		"all three cold samples must use distinct fresh children",
	);

	assert.deepEqual(
		measurements.map((measurement) => ({
			handlersRegistered: measurement.events > 0,
			browserRegistered: measurement.tools.includes("agent_browser"),
		})),
		[
			{ handlersRegistered: true, browserRegistered: true },
			{ handlersRegistered: true, browserRegistered: true },
			{ handlersRegistered: true, browserRegistered: true },
		],
	);
	assert.ok(
		maxTotal < STARTUP_BUDGET_MS,
		`cold startup exceeded ${STARTUP_BUDGET_MS}ms: ${totals.map((value) => value.toFixed(1)).join(", ")}`,
	);
});
