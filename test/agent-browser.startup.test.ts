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

const STARTUP_BUDGET_MS = 250;

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
const pi = {
  events: [],
  tools: [],
  on(...args) { this.events.push(args); },
  registerTool(tool) { this.tools.push(tool); },
};
extension.default(pi);
const registered = performance.now();
console.log(JSON.stringify({
  events: pi.events.length,
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

test("agent_browser cold startup stays below the issue #84 regression budget", async () => {
	const entrypoint = await getPackageExtensionEntrypoint();
	assert.equal(entrypoint, "./dist/extensions/agent-browser/index.js");
	const measurements = await Promise.all([measureColdStartup(entrypoint), measureColdStartup(entrypoint), measureColdStartup(entrypoint)]);
	const totals = measurements.map((measurement) => measurement.totalMs);
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
