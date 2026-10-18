/**
 * Purpose: Verify the package-level first-run doctor for pi-agent-browser-native.
 * Responsibilities: Assert CLI parsing, PATH/version diagnostics, duplicate-source remediation text, and read-only injected I/O behavior.
 * Scope: Focused unit coverage for `scripts/doctor.mjs`; real upstream and Pi smoke validation remain in verifier scripts and manual release workflow.
 * Usage: Run with `npx tsx --test test/doctor.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: The doctor is read-only, distinct from upstream `agent-browser doctor`, and compares upstream version to the canonical capability baseline.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("doctor exec options route npm global shims through a shell only on Windows", () => {
	assert.deepEqual(buildNpmShimExecOptions("win32"), { shell: true });
	assert.deepEqual(buildNpmShimExecOptions("darwin"), {});
	assert.deepEqual(buildNpmShimExecOptions("linux"), {});
});

import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";

import {
	buildNpmShimExecOptions,
	evaluateDoctor,
	formatDoctorReport,
	isDirectRun,
	parseCliArgs,
} from "../scripts/doctor.mjs";

function passingVersion() {
	return `agent-browser ${CAPABILITY_BASELINE.targetVersion}\n`;
}

function passingPiVersion() {
	return "1.0.0\n";
}

function evaluateDoctorWithPi(options: Parameters<typeof evaluateDoctor>[0] = {}) {
	return evaluateDoctor({ runPi: async () => passingPiVersion(), ...options });
}

test("doctor reports missing agent-browser with actionable install guidance", async () => {
	const missing = Object.assign(new Error("spawn agent-browser ENOENT"), { code: "ENOENT" });
	const report = await evaluateDoctorWithPi({
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

test("doctor accepts the supported floor and newer stable versions", async () => {
	for (const [version, upstreamOutput, piOutput] of [
		["0.35.0", "agent-browser 0.35.0\n", "pi 1.0.0\n"],
		["0.35.0", "0.35.0\n", "1.0.0\n"],
		["0.35.2", "agent-browser 0.35.2\n", "1.0.0\n"],
		["1.0.0", "agent-browser 1.0.0\n", "1.0.0\n"],
	]) {
		// Each injected version/source case completes and is asserted before the next begins.
		// oxlint-disable-next-line no-await-in-loop
		const report = await evaluateDoctorWithPi({
			runAgentBrowser: async () => upstreamOutput,
			runPi: async () => piOutput,
			skipSourceCheck: true,
		});
		const text = formatDoctorReport(report);

		// All fixed version/source variants must pass; the loop has no result-based filtering.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(report.failures.length, 0);
		// Every version spelling must produce the recognized Pi floor, not an unparseable warning.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(text, /Pi version satisfies the minimum runtime floor: 1\.0\.0/);
		// Every supported-version fixture must report its exact detected version.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(
			text,
			new RegExp(`version meets supported floor: ${version.replaceAll(".", "\\.")}`),
		);
		// Every supported-version fixture still reports the current recommendation.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(text, new RegExp(`recommended ${CAPABILITY_BASELINE.targetVersion}`));
	}
});

test("doctor reports versions below the supported floor", async () => {
	const report = await evaluateDoctorWithPi({
		runAgentBrowser: async () => "agent-browser 0.25.0\n",
		skipSourceCheck: true,
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 1);
	assert.match(text, /agent-browser version drift/);
	assert.match(text, /minimum supported 0\.35\.0/);
	assert.match(text, /found 0\.25\.0/);
	assert.match(text, /stable agent-browser versions at or above 0\.35\.0/);
	assert.match(text, /scripts\/agent-browser-target\.mjs/);
	assert.match(text, /scripts\/agent-browser-capability-baseline\.mjs/);
	assert.match(text, /npm run docs -- command-reference write/);
	assert.match(text, /npm run verify -- command-reference/);
	assert.match(text, /npm run verify -- real-upstream/);
	assert.match(text, /test\/fixtures\/agent-browser-real-output-shapes\.json/);
});

test("doctor fails when Pi is below the minimum runtime floor", async () => {
	const report = await evaluateDoctor({
		runAgentBrowser: async () => passingVersion(),
		runPi: async () => "0.99.2\n",
		skipSourceCheck: true,
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 1);
	assert.match(text, /Pi 1\.0\.0 or newer is required; found 0\.99\.2/);
	assert.match(text, /enforces the Pi 1\.0\.0 runtime floor/);
	assert.match(text, /Doctor found setup failures/);
});

test("doctor warns instead of failing when Pi version cannot be inspected", async () => {
	const report = await evaluateDoctor({
		runAgentBrowser: async () => passingVersion(),
		runPi: async () => {
			throw Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
		},
		skipSourceCheck: true,
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 0);
	assert.match(text, /Could not inspect pi --version/);
	assert.match(text, /Pi 1\.0\.0 or newer is required/);
	assert.match(text, /Doctor passed/);
});

test("doctor reports duplicate package and checkout sources with remediation", async () => {
	const settingsByPath = new Map([
		[
			resolve("/agent/settings.json"),
			JSON.stringify({ packages: ["npm:pi-agent-browser-native"] }),
		],
		[
			resolve("/repo/.pi/settings.json"),
			JSON.stringify({ extensions: [resolve("/repo/extensions/agent-browser/index.ts")] }),
		],
	]);
	const report = await evaluateDoctorWithPi({
		agentDir: "/agent",
		cwd: "/repo",
		pathExists: async (path: string) => settingsByPath.has(path),
		readText: async (path: string) => settingsByPath.get(path),
		runAgentBrowser: async () => passingVersion(),
	});
	const text = formatDoctorReport(report);

	assert.equal(report.failures.length, 1);
	assert.match(text, /Duplicate pi-agent-browser-native sources detected/);
	assert.match(text, /`agent_browser`/);
	assert.match(text, /npm:pi-agent-browser-native/);
	assert.ok(text.includes(resolve("/repo/extensions/agent-browser/index.ts")));
	assert.match(text, /pi --approve --no-extensions -e <source>/);
	assert.match(text, /keep exactly one active source/i);
});

test("doctor resolves relative sources from their settings file directory", async () => {
	// The compiled `dist/` entrypoint row protects packaged installs whose configured source points at build output.
	for (const [settingsKey, source] of [
		["packages", "../../Projects/AI/pi-agent-browser"],
		["extensions", "../../Projects/AI/pi-agent-browser/extensions/agent-browser/index.ts"],
		["extensions", "../../Projects/AI/pi-agent-browser/dist/extensions/agent-browser/index.js"],
	] as const) {
		const settingsByPath = new Map([
			[resolve("/home/user/.pi/agent/settings.json"), JSON.stringify({ [settingsKey]: [source] })],
		]);
		// Each injected version/source case completes and is asserted before the next begins.
		// oxlint-disable-next-line no-await-in-loop
		const report = await evaluateDoctorWithPi({
			agentDir: "/home/user/.pi/agent",
			cwd: "/home/user/Projects/AI/pi-agent-browser",
			pathExists: async (path: string) => settingsByPath.has(path),
			readText: async (path: string) => settingsByPath.get(path),
			runAgentBrowser: async () => passingVersion(),
		});
		const text = formatDoctorReport(report);

		// All fixed version/source variants must pass; the loop has no result-based filtering.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(report.failures.length, 0);
		// Each fixed relative source must resolve without creating duplicate installations.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(text, /No duplicate pi-agent-browser-native sources detected/);
		// Each fixed relative-source variant must retain its configured spelling.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(text.includes(`Detected source: ${source}`), source);
	}
});

test("doctor treats no configured source as an informational warning, not a failure", async () => {
	const report = await evaluateDoctorWithPi({
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

test("doctor invokes upstream only for the read-only version probe", async () => {
	const calls: string[] = [];
	const settingsByPath = new Map([
		[
			resolve("/agent/settings.json"),
			JSON.stringify({ packages: ["npm:pi-agent-browser-native"] }),
		],
	]);
	const report = await evaluateDoctorWithPi({
		agentDir: "/agent",
		cwd: "/repo",
		pathExists: async (path: string) => {
			calls.push(`exists:${path}`);
			return settingsByPath.has(path);
		},
		readText: async (path: string) => {
			calls.push(`read:${path}`);
			return settingsByPath.get(path);
		},
		runAgentBrowser: async (args: readonly string[]) => {
			calls.push(`run:${args.join(" ")}`);
			return passingVersion();
		},
	});

	assert.equal(report.failures.length, 0);
	const text = formatDoctorReport(report);
	assert.match(text, /No duplicate pi-agent-browser-native sources detected/);
	assert.match(text, /Detected source: npm:pi-agent-browser-native/);
	// The only agent-browser invocation is the read-only --version probe: the doctor never shells out
	// to `agent-browser doctor` or any fix/write command through the injected seam.
	assert.deepEqual(
		calls.filter((call) => call.startsWith("run:")),
		["run:--version"],
	);
});

test("isDirectRun resolves npm bin symlinks before comparing the entrypoint", () => {
	const entrypoint = resolve("/package with spaces/#tools/scripts/doctor.mjs");
	const binPath = resolve("/tmp/node_modules/.bin/pi-agent-browser-doctor");
	const metaUrl = pathToFileURL(entrypoint).href;
	const resolveRealPath = (path: string) => (path === binPath ? entrypoint : path);

	assert.equal(isDirectRun(metaUrl, binPath, resolveRealPath), true);
	assert.equal(isDirectRun(metaUrl, entrypoint, resolveRealPath), true);
	assert.equal(isDirectRun(metaUrl, resolve("/other/script.mjs"), resolveRealPath), false);
	assert.equal(isDirectRun(metaUrl, undefined, resolveRealPath), false);
	assert.equal(
		isDirectRun(metaUrl, binPath, () => {
			throw new Error("missing entrypoint");
		}),
		false,
	);
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
	assert.deepEqual(
		parseCliArgs([
			"--cwd",
			"/repo",
			"--agent-dir",
			"/agent",
			"--settings",
			"/a.json",
			"--settings",
			"/b.json",
			"--skip-source-check",
		]),
		{
			agentDir: "/agent",
			cwd: "/repo",
			settingsPaths: ["/a.json", "/b.json"],
			showHelp: false,
			skipSourceCheck: true,
		},
	);
});

test("parseCliArgs rejects unknown options and missing option values", () => {
	assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
	assert.throws(() => parseCliArgs(["--cwd"]), /requires a value/);
});
