/**
 * Purpose: Guard the native extension cold-start path for issue #84.
 * Responsibilities: Measure the package extension entrypoint import plus extension factory registration in fresh Node processes.
 * Scope: Startup budget only; schema compatibility and runtime behavior have dedicated tests.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cwd, execPath } from "node:process";
import { test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const STARTUP_BUDGET_MS = process.platform === "android" ? 1_000 : 250;

type StartupMeasurement = {
	events: number;
	importMs: number;
	tools: string[];
	totalMs: number;
};

async function getPackageExtensionEntrypoint(): Promise<string> {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { pi?: { extensions?: string[] } };
	const entrypoint = packageJson.pi?.extensions?.[0];
	assert.equal(typeof entrypoint, "string", "package.json pi.extensions[0] should name the packaged extension entrypoint");
	return entrypoint as string;
}

async function measureColdStartup(entrypoint: string): Promise<StartupMeasurement> {
	const script = `
const start = performance.now();
const extension = await import(${JSON.stringify(entrypoint)});
const imported = performance.now();
const registeredEvents = [];
const pi = {
  events: { on(...args) { registeredEvents.push(args); } },
  tools: [],
  on(...args) { registeredEvents.push(args); },
  registerTool(tool) { this.tools.push(tool); },
};
extension.default(pi);
const registered = performance.now();
console.log(JSON.stringify({
  events: registeredEvents.length,
  importMs: imported - start,
  tools: pi.tools.map((tool) => tool.name),
  totalMs: registered - start,
}));
`;
	const result = await execFile(execPath, ["--input-type=module", "-e", script], {
		cwd: cwd(),
		timeout: 10_000,
	});
	return JSON.parse(result.stdout.trim()) as StartupMeasurement;
}

test("agent_browser cold startup stays below the issue #84 regression budget", async (t) => {
	const entrypoint = await getPackageExtensionEntrypoint();
	assert.equal(entrypoint, "./dist/extensions/agent-browser/index.js");
	// Measure one cold Pi extension load at a time on every platform. Parallel
	// samples compete for the hosted runner's CPU; each sample still imports in
	// a fresh process and every result must meet the unchanged startup budget.
	const measurements = [await measureColdStartup(entrypoint), await measureColdStartup(entrypoint), await measureColdStartup(entrypoint)];
	const totals = measurements.map((measurement) => measurement.totalMs);
	t.diagnostic(JSON.stringify({ budgetMs: STARTUP_BUDGET_MS, measurements }));
	const maxTotal = Math.max(...totals);

	for (const measurement of measurements) {
		assert.ok(measurement.events > 0, "extension factory should register lifecycle handlers");
		assert.ok(measurement.tools.includes("agent_browser"), "extension factory should register the native browser tool");
	}
	assert.ok(
		maxTotal < STARTUP_BUDGET_MS,
		`cold startup exceeded ${STARTUP_BUDGET_MS}ms: ${totals.map((value) => value.toFixed(1)).join(", ")}`,
	);
});
