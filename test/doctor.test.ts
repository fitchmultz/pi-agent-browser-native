/**
 * Purpose: Verify the package-level first-run doctor for pi-agent-browser-native.
 * Responsibilities: Assert CLI parsing, PATH/version diagnostics, duplicate-source remediation text, and read-only injected I/O behavior.
 * Scope: Focused unit coverage for `scripts/doctor.mjs`; real upstream and Pi smoke validation remain in verifier scripts and manual release workflow.
 * Usage: Run with `npm test -- test/doctor.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: The doctor is read-only, distinct from upstream `agent-browser doctor`, and compares upstream version to the canonical capability baseline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";

const doctorModulePath = "../scripts/doctor.mjs";
const doctorModule = (await import(doctorModulePath)) as {
	evaluateDoctor: (options?: {
		agentDir?: string;
		cwd?: string;
		pathExists?: (path: string) => Promise<boolean>;
		readText?: (path: string) => Promise<string | undefined>;
		runAgentBrowser?: (args: string[]) => Promise<string>;
		settingsPaths?: string[];
		skipSourceCheck?: boolean;
	}) => Promise<{ checks: Array<{ status: string; title: string; lines?: string[] }>; failures: unknown[]; warnings: string[] }>;
	formatDoctorReport: (report: { checks: Array<{ status: string; title: string; lines?: string[] }>; failures: unknown[]; warnings?: string[] }) => string;
	normalizeAgentBrowserVersion: (output: string) => string;
	parseCliArgs: (argv?: string[]) => { agentDir?: string; cwd?: string; settingsPaths: string[]; showHelp: boolean; skipSourceCheck: boolean };
};
const { evaluateDoctor, formatDoctorReport, normalizeAgentBrowserVersion, parseCliArgs } = doctorModule;

function passingVersion() {
	return `agent-browser ${CAPABILITY_BASELINE.targetVersion}\n`;
}

test("normalizeAgentBrowserVersion strips the upstream binary label", () => {
	assert.equal(normalizeAgentBrowserVersion("agent-browser 0.26.0\n"), "0.26.0");
	assert.equal(normalizeAgentBrowserVersion("0.26.0\n"), "0.26.0");
});

test("doctor reports missing agent-browser with actionable install guidance", async () => {
	const missing = Object.assign(new Error("spawn agent-browser ENOENT"), { code: "ENOENT" });
	const report = await evaluateDoctor({
		runAgentBrowser: async () => {
			throw missing;
		},
		skipSourceCheck: true,
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 1);
	assert.match(text, /agent-browser is required but was not found on PATH/);
	assert.match(text, /does not bundle agent-browser/);
	assert.match(text, /agent-browser --version/);
	assert.match(text, /https:\/\/agent-browser\.dev\//);
	assert.match(text, /https:\/\/github\.com\/vercel-labs\/agent-browser/);
});

test("doctor reports version drift from the canonical baseline", async () => {
	const report = await evaluateDoctor({
		runAgentBrowser: async () => "agent-browser 0.25.0\n",
		skipSourceCheck: true,
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 1);
	assert.match(text, /agent-browser version drift/);
	assert.match(text, new RegExp(`expected ${CAPABILITY_BASELINE.targetVersion}`));
	assert.match(text, /found 0\.25\.0/);
	assert.match(text, /backwards-compatibility shims/);
	assert.match(text, /scripts\/agent-browser-capability-baseline\.mjs/);
});

test("doctor reports duplicate package and checkout sources with remediation", async () => {
	const settingsByPath = new Map([
		["/agent/settings.json", JSON.stringify({ packages: ["npm:pi-agent-browser-native"] })],
		["/repo/.pi/settings.json", JSON.stringify({ extensions: ["/repo/extensions/agent-browser/index.ts"] })],
	]);
	const report = await evaluateDoctor({
		agentDir: "/agent",
		cwd: "/repo",
		pathExists: async (path) => settingsByPath.has(path),
		readText: async (path) => settingsByPath.get(path),
		runAgentBrowser: async () => passingVersion(),
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 1);
	assert.match(text, /Duplicate pi-agent-browser-native sources detected/);
	assert.match(text, /`agent_browser`/);
	assert.match(text, /npm:pi-agent-browser-native/);
	assert.match(text, /extensions\/agent-browser\/index\.ts/);
	assert.match(text, /pi --no-extensions -e <source>/);
	assert.match(text, /keep exactly one active source/i);
});

test("doctor passes the source check when exactly one configured source is active", async () => {
	const settingsByPath = new Map([["/agent/settings.json", JSON.stringify({ packages: ["npm:pi-agent-browser-native"] })]]);
	const report = await evaluateDoctor({
		agentDir: "/agent",
		cwd: "/repo",
		pathExists: async (path) => settingsByPath.has(path),
		readText: async (path) => settingsByPath.get(path),
		runAgentBrowser: async () => passingVersion(),
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 0);
	assert.match(text, /No duplicate pi-agent-browser-native sources detected/);
	assert.match(text, /Detected source: npm:pi-agent-browser-native/);
});

test("doctor treats no configured source as an informational warning, not a failure", async () => {
	const report = await evaluateDoctor({
		agentDir: "/agent",
		cwd: "/repo",
		pathExists: async () => false,
		readText: async () => undefined,
		runAgentBrowser: async () => passingVersion(),
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 0);
	assert.match(text, /No configured pi-agent-browser-native source was found/);
	assert.match(text, /Doctor passed/);
});

test("doctor remains read-only through injected I/O", async () => {
	const calls: string[] = [];
	const settingsByPath = new Map([["/agent/settings.json", JSON.stringify({ packages: ["npm:pi-agent-browser-native"] })]]);
	const report = await evaluateDoctor({
		agentDir: "/agent",
		cwd: "/repo",
		pathExists: async (path) => {
			calls.push(`exists:${path}`);
			return settingsByPath.has(path);
		},
		readText: async (path) => {
			calls.push(`read:${path}`);
			return settingsByPath.get(path);
		},
		runAgentBrowser: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return passingVersion();
		},
	});

	assert.equal(report.failures.length, 0);
	assert.deepEqual(calls.filter((call) => call.startsWith("run:")), ["run:--version"]);
	assert.equal(calls.some((call) => /write|fix|doctor/.test(call)), false);
});

test("parseCliArgs supports help, paths, repeated settings, and skip-source-check", () => {
	assert.deepEqual(parseCliArgs([]), {
		agentDir: undefined,
		cwd: undefined,
		settingsPaths: [],
		showHelp: false,
		skipSourceCheck: false,
	});
	assert.deepEqual(parseCliArgs(["--help"]), {
		agentDir: undefined,
		cwd: undefined,
		settingsPaths: [],
		showHelp: true,
		skipSourceCheck: false,
	});
	assert.deepEqual(parseCliArgs(["--cwd", "/repo", "--agent-dir", "/agent", "--settings", "/a.json", "--settings", "/b.json", "--skip-source-check"]), {
		agentDir: "/agent",
		cwd: "/repo",
		settingsPaths: ["/a.json", "/b.json"],
		showHelp: false,
		skipSourceCheck: true,
	});
});

test("parseCliArgs rejects unknown options and missing option values", () => {
	assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
	assert.throws(() => parseCliArgs(["--cwd"]), /requires a value/);
});
