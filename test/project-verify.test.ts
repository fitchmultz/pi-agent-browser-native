/**
 * Purpose: Lock the maintainer npm verification facade so queue/release gates do not silently drop required checks.
 * Responsibilities: Assert lockfile URL hygiene and that `npm run verify` orchestration keeps docs drift, typecheck, unit/fake tests, command-reference, pre-pr, safe startup profiling, real-upstream, package Pi smoke, platform-target, and platform smoke steps wired to their focused scripts.
 * Scope: Package-lock policy and unit coverage for scripts/project.mjs command planning; focused scripts own their own runtime behavior.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: The default gate is local and deterministic except for live command-reference sampling; real-upstream and platform diagnostics stay explicit modes while release composes the required platform gate.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	docsSteps,
	hostToolPath,
	main,
	parseVerifyArgs,
	testSteps,
	verifySteps,
} from "../scripts/project.mjs";
import { readArray, readRecord, readString } from "./helpers/assertions.js";

const TSX_CLI = fileURLToPath(import.meta.resolve("tsx/cli"));

const DEFAULT_STEPS = [
	"./scripts/build.mjs",
	"./scripts/prepare-quality-checker.mjs",
	"./scripts/code-quality.mjs lint",
	"--check .",
	"--noEmit",
	`${TSX_CLI} --test test/**/!(*.serial).test.ts`,
	`${TSX_CLI} --test --test-concurrency=1 test/**/*.serial.test.ts`,
	"./scripts/check-playbook-drift.ts --check",
	"./scripts/check-command-reference-baseline.mjs --check",
	"./scripts/verify-command-reference.mjs",
];

function labels(steps: unknown): string[] {
	return readArray(steps).map((step) => readArray(readRecord(step).args).map(readString).join(" "));
}

test("facade labels retain native CLI paths, including Windows spaces and parenthesized extglobs", () => {
	const cli = "C:\\Program Files\\tsx (fixture)\\cli.mjs";
	const glob = "test/**/!(*.serial).test.ts";
	assert.deepEqual(labels([{ args: [cli, "--test", glob] }]), [`${cli} --test ${glob}`]);
});

test("package lock excludes WorkOS URLs", () => {
	assert.doesNotMatch(
		readFileSync("package-lock.json", "utf8"),
		/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"]*(?:workos|socket-firewall)/i,
	);
});

test("typecheck gate covers shared JavaScript config policy implementation", () => {
	const tsconfig = readRecord(JSON.parse(readFileSync("tsconfig.json", "utf8")));
	const compilerOptions = readRecord(tsconfig.compilerOptions);
	assert.equal(compilerOptions.allowJs, true);
	assert.equal(compilerOptions.noUnusedLocals, true);
	assert.ok(readArray(tsconfig.include).includes("extensions/agent-browser/lib/config-policy.js"));
	assert.equal(existsSync("extensions/agent-browser/lib/config-policy.d.ts"), false);
});

test("verify facade default gate keeps docs, typecheck, unit/fake, and command-reference drift checks", () => {
	const steps: unknown = verifySteps({ mode: "default", passthrough: [], showHelp: false });
	const stepLabels = labels(steps);
	assert.equal(
		readRecord(readArray(steps)[3]).command,
		join(
			process.cwd(),
			"node_modules",
			".bin",
			process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
		),
	);

	assert.deepEqual(
		labels(verifySteps({ mode: "quality", passthrough: [], showHelp: false })),
		stepLabels,
	);
	assert.deepEqual(stepLabels, DEFAULT_STEPS);
});

test("verify facade pre-pr mode composes default verification with package-content checks", () => {
	const steps: unknown = verifySteps({ mode: "pre-pr", passthrough: [], showHelp: false });
	assert.deepEqual(labels(steps), [...DEFAULT_STEPS, "./scripts/verify-package.mjs"]);
});

test("verify facade opt-in modes keep startup-profile, real-upstream, dogfood, package-pi, platform-target, and platform smoke gates explicit", () => {
	const startupProfile: unknown = verifySteps({
		mode: "startup-profile",
		passthrough: ["--samples", "3", "--json"],
		showHelp: false,
	});
	assert.deepEqual(labels(startupProfile), ["./scripts/profile-startup.mjs --samples 3 --json"]);

	const realUpstream: unknown = verifySteps({
		mode: "real-upstream",
		passthrough: [],
		showHelp: false,
	});
	assert.deepEqual(labels(realUpstream), [
		"--test --test-force-exit --test-name-pattern plugin list stays sessionless test/agent-browser.real-upstream-contract.test.ts",
		"--test --test-force-exit --test-skip-pattern plugin list stays sessionless test/agent-browser.real-upstream-contract.test.ts",
		"--test --test-force-exit test/agent-browser.batch-fidelity.test.ts",
		"--test --test-force-exit test/agent-browser.overlay-real-upstream.test.ts",
	]);
	assert.equal(
		readArray(realUpstream).every(
			(step) => readRecord(readRecord(step).env).PI_AGENT_BROWSER_REAL_UPSTREAM === "1",
		),
		true,
	);

	const dogfood: unknown = verifySteps({
		mode: "dogfood",
		passthrough: ["--keep-artifacts"],
		showHelp: false,
	});
	assert.deepEqual(labels(dogfood), [
		"./scripts/build.mjs",
		"./scripts/verify-agent-browser-dogfood.ts --keep-artifacts",
	]);

	const packagePi: unknown = verifySteps({ mode: "package-pi", passthrough: [], showHelp: false });
	assert.deepEqual(labels(packagePi), ["./scripts/verify-package.mjs --smoke-pi"]);

	const platformTarget: unknown = verifySteps({
		mode: "platform-target",
		passthrough: [],
		showHelp: false,
	});
	assert.deepEqual(labels(platformTarget), [
		"./scripts/build.mjs",
		"./scripts/prepare-quality-checker.mjs",
		"./scripts/code-quality.mjs lint",
		"--check .",
		"--noEmit",
		"--test --test-concurrency=1 test/code-quality*.test.ts test/project-verify.test.ts test/platform-smoke.test.ts test/verify-package.test.ts test/agent-browser.runtime.test.ts test/agent-browser.windows-argv.test.ts",
		"./scripts/check-playbook-drift.ts --check",
		"./scripts/check-command-reference-baseline.mjs --check",
	]);

	const platformSmoke: unknown = verifySteps({
		mode: "platform-smoke",
		passthrough: ["run", "--target", "macos", "--suite", "platform-build"],
		showHelp: false,
	});
	assert.deepEqual(labels(platformSmoke), [
		"./scripts/platform-smoke.mjs run --target macos --suite platform-build",
	]);
});

test("verify facade release gate composes default verification, lifecycle, packaged Pi smoke, and platform smoke", () => {
	const release: unknown = verifySteps({ mode: "release", passthrough: [], showHelp: false });
	assert.deepEqual(labels(release), [
		...DEFAULT_STEPS,
		"./scripts/verify-lifecycle.mjs",
		"./scripts/verify-package.mjs --smoke-pi",
		"./scripts/platform-smoke.mjs doctor",
		"./scripts/platform-smoke.mjs run",
	]);
});

test("verify facade docs mode checks both generated playbook and command-reference blocks", () => {
	assert.deepEqual(labels(docsSteps({ mode: "check", target: "all" })), [
		"./scripts/check-playbook-drift.ts --check",
		"./scripts/check-command-reference-baseline.mjs --check",
	]);
});

test("verify facade rejects unsupported options before running a partial gate", () => {
	assert.throws(
		() => verifySteps({ mode: "real-upstream", passthrough: ["--list-files"], showHelp: false }),
		/Option --list-files is not supported for verify mode real-upstream/,
	);
	assert.throws(
		() => verifySteps({ mode: "pre-pr", passthrough: ["--list-files"], showHelp: false }),
		/Option --list-files is not supported for verify mode pre-pr/,
	);
	assert.throws(
		() => verifySteps({ mode: "dogfood", passthrough: ["--artifact-dir"], showHelp: false }),
		/--artifact-dir requires a path/,
	);
	assert.throws(
		() => verifySteps({ mode: "startup-profile", passthrough: ["--samples"], showHelp: false }),
		/--samples requires a value/,
	);
	assert.throws(
		() =>
			verifySteps({
				mode: "startup-profile",
				passthrough: ["--timeout-ms", "1000"],
				showHelp: false,
			}),
		/Option --timeout-ms is not supported for verify mode startup-profile/,
	);
	assert.throws(
		() =>
			verifySteps({ mode: "platform-smoke", passthrough: ["run", "--target"], showHelp: false }),
		/--target requires a value/,
	);
	assert.deepEqual(parseVerifyArgs(["package", "--list-files"]), {
		mode: "package",
		passthrough: ["--list-files"],
		showHelp: false,
	});
});

test("verify facade lifecycle mode passes --model and other allowed flags through to verify-lifecycle.mjs", () => {
	const steps: unknown = verifySteps({
		mode: "lifecycle",
		passthrough: [
			"--model",
			"openai-codex/gpt-5.5:minimal",
			"--keep-artifacts",
			"--verbose",
			"--timeout-ms",
			"600000",
		],
		showHelp: false,
	});
	assert.deepEqual(labels(steps), [
		"./scripts/verify-lifecycle.mjs --model openai-codex/gpt-5.5:minimal --keep-artifacts --verbose --timeout-ms 600000",
	]);
	assert.equal(readRecord(readRecord(readArray(steps)[0]).env).PATH, hostToolPath());
	assert.equal(
		hostToolPath(["/repo/node_modules/.bin", "/global/bin", "/usr/bin"].join(delimiter)),
		["/global/bin", "/usr/bin"].join(delimiter),
	);
});

test("verify facade lifecycle mode rejects --model without a value", () => {
	assert.throws(
		() => verifySteps({ mode: "lifecycle", passthrough: ["--model"], showHelp: false }),
		/--model requires a value/,
	);
	assert.throws(
		() =>
			verifySteps({
				mode: "lifecycle",
				passthrough: ["--model", "--keep-artifacts"],
				showHelp: false,
			}),
		/--model requires a value/,
	);
});

const TAP_CONTRACT_STEPS = [
	"--test --test-reporter=tap test/**/!(*.serial).test.ts",
	"--test --test-reporter=tap --test-concurrency=1 test/**/*.serial.test.ts",
];
const POLICY_DEBUG = { NODE_DEBUG: "pi-agent-browser-policy" };

test("npm test keeps build, checker preparation, complete parallel TAP and complete serial TAP stages", () => {
	const pkg = readRecord(JSON.parse(readFileSync("package.json", "utf8")));
	assert.equal(readRecord(pkg.scripts).test, "node ./scripts/project.mjs test");
	assert.deepEqual(labels(testSteps()), [
		"./scripts/build.mjs",
		"./scripts/prepare-quality-checker.mjs",
		...TAP_CONTRACT_STEPS.map((label) => `${TSX_CLI} ${label}`),
	]);
	assert.equal(
		testSteps()
			.slice(2)
			.every((step) => step.command === process.execPath),
		true,
	);
	assert.deepEqual(
		readArray(testSteps())
			.slice(2)
			.map(readRecord)
			.map((step) => readArray(step.args)),
		[
			[TSX_CLI, "--test", "--test-reporter=tap", "test/**/!(*.serial).test.ts"],
			[
				TSX_CLI,
				"--test",
				"--test-reporter=tap",
				"--test-concurrency=1",
				"test/**/*.serial.test.ts",
			],
		],
	);
});

test("Windows test children receive only the exact policy debug override in every composed verification gate", () => {
	const windows = readArray(testSteps("win32")).map(readRecord);
	assert.deepEqual(
		windows.map((step) => step.env),
		[undefined, undefined, POLICY_DEBUG, POLICY_DEBUG],
	);
	for (const platform of ["linux", "darwin", "android"] as const) {
		// Every non-Windows planner branch must leave debug enablement absent.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			testSteps(platform).every((step) => step.env === undefined),
			true,
		);
	}
	for (const mode of ["default", "quality", "pre-pr", "release"]) {
		const contracts = readArray(verifySteps({ mode, passthrough: [], showHelp: false }, "win32"))
			.map(readRecord)
			.filter((step) => readArray(step.args).includes("--test"));
		// Each complete composed gate must retain both full contract stages and the narrow environment.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(labels(contracts), DEFAULT_STEPS.slice(5, 7));
		// Every composed contract child must use the exact channel, never NODE_OPTIONS or wildcard debug.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(
			contracts.map((step) => step.env),
			[POLICY_DEBUG, POLICY_DEBUG],
		);
	}
});

test("the complete test facade rejects filtered paths and options before launching a partial gate", async () => {
	await assert.rejects(
		main(["test", "--test-name-pattern", "partial"]),
		/complete test gate does not accept/,
	);
});

function facadeFixture(t: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "piab project (facade)-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "scripts"));
	copyFileSync(
		new URL("../scripts/project.mjs", import.meta.url),
		join(directory, "scripts", "project.mjs"),
	);
	mkdirSync(join(directory, "node_modules", "tsx"), { recursive: true });
	writeFileSync(
		join(directory, "node_modules", "tsx", "package.json"),
		JSON.stringify({
			type: "module",
			exports: { "./cli": "./cli with (spaces).mjs" },
		}),
	);
	mkdirSync(join(directory, "test", "nested"), { recursive: true });
	const receipt = `const record = (stage, args = []) => appendFileSync("calls.jsonl", JSON.stringify({ stage, args, debug: process.env.NODE_DEBUG ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null }) + "\\n");`;
	for (const [file, stage] of [
		["build.mjs", "build"],
		["prepare-quality-checker.mjs", "prepare"],
	]) {
		writeFileSync(
			join(directory, "scripts", file),
			`import { appendFileSync } from "node:fs";
${receipt}
record(${JSON.stringify(stage)}, process.argv.slice(2));
if (process.env.FIXTURE_FAIL_STAGE === ${JSON.stringify(stage)}) process.exitCode = 23;
`,
		);
	}
	const runner = join(directory, "node_modules", "tsx", "cli with (spaces).mjs");
	writeFileSync(
		runner,
		`import {appendFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
${receipt}
const args = process.argv.slice(2);
record(args.includes("--test-concurrency=1") ? "serial" : "parallel", args);
const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
	);
	for (const [file, id] of [
		["parallel-flat.test.ts", "parallel-flat"],
		["nested/parallel-nested.test.ts", "parallel-nested"],
		["serial-flat.serial.test.ts", "serial-flat"],
		["nested/serial-nested.serial.test.ts", "serial-nested"],
	]) {
		writeFileSync(
			join(directory, "test", file),
			`import assert from "node:assert/strict";
import {appendFileSync} from "node:fs";
import test from "node:test";
import {debuglog} from "node:util";
${receipt}
test(${JSON.stringify("fixture-" + id)}, () => {
record(${JSON.stringify(id)});
debuglog("pi-agent-browser-policy")(${JSON.stringify(id)});
debuglog("pi-agent-browser-other")("UNEXPECTED_BROAD_DEBUG");
assert.equal(process.env.FIXTURE_FAIL_STAGE === "parallel" && ${JSON.stringify(id)}.startsWith("parallel"), false, "fixture parallel failure");
});
`,
		);
	}
	const facade = pathToFileURL(join(directory, "scripts", "project.mjs")).href;
	writeFileSync(
		join(directory, "windows-policy.mjs"),
		`import {appendFileSync} from "node:fs";
import {runSteps, testSteps} from ${JSON.stringify(facade)};
${receipt}
record("isolated-parent");
// Exercise only the Windows environment policy on the real host; no native-platform spoof.
await runSteps(testSteps("win32"));
`,
	);
	return directory;
}

function runFixture(directory: string, windowsPolicy: boolean, failStage?: string) {
	// Model the pinned qualifier's loss of outer NODE_DEBUG/NODE_OPTIONS before the owned launcher.
	const isolatedEnv = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !["NODE_DEBUG", "NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(name.toUpperCase()),
		),
	);
	const entry = windowsPolicy
		? join(directory, "windows-policy.mjs")
		: join(directory, "scripts", "project.mjs");
	const result = spawnSync(process.execPath, [entry, ...(windowsPolicy ? [] : ["test"])], {
		cwd: directory,
		env: { ...isolatedEnv, FIXTURE_FAIL_STAGE: failStage },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	const calls = readFileSync(join(directory, "calls.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => readRecord(JSON.parse(line)));
	return { result, calls };
}

function assertCompleteFixtureCalls(
	calls: readonly Readonly<Record<string, unknown>>[],
	debug: string | null,
): void {
	assert.deepEqual(
		calls.slice(0, 3).map((call) => call.stage),
		["build", "prepare", "parallel"],
	);
	assert.deepEqual(
		calls
			.filter((call) => call.stage === "parallel" || call.stage === "serial")
			.map((call) => readArray(call.args).map(readString).join(" ")),
		TAP_CONTRACT_STEPS,
	);
	const serial = calls.findIndex((call) => call.stage === "serial");
	assert.deepEqual(
		calls
			.slice(3, serial)
			.map((call) => readString(call.stage))
			.sort((left, right) => left.localeCompare(right)),
		["parallel-flat", "parallel-nested"],
	);
	assert.deepEqual(
		calls
			.slice(serial + 1)
			.map((call) => readString(call.stage))
			.sort((left, right) => left.localeCompare(right)),
		["serial-flat", "serial-nested"],
	);
	assert.deepEqual(
		calls.slice(0, 2).map((call) => call.debug),
		[null, null],
	);
	assert.equal(
		calls.slice(2).every((call) => call.debug === debug),
		true,
	);
	assert.equal(
		calls.every((call) => call.nodeOptions === null),
		true,
	);
}

test("real facade subprocess restores exact Windows policy debug after isolation and runs all TAP contracts", (t) => {
	const { result, calls } = runFixture(facadeFixture(t), true);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(calls[0], {
		stage: "isolated-parent",
		args: [],
		debug: null,
		nodeOptions: null,
	});
	assert.match(result.stdout, /# Subtest: fixture-parallel-flat/, result.stdout + result.stderr);
	assertCompleteFixtureCalls(calls.slice(1), "pi-agent-browser-policy");
	assert.match(result.stdout, /# PI-AGENT-BROWSER-POLICY [0-9]+: parallel-flat/);
	assert.match(result.stdout, /# PI-AGENT-BROWSER-POLICY [0-9]+: serial-nested/);
	assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_BROAD_DEBUG/);
	assert.equal((result.stdout.match(/TAP version 13/g) ?? []).length, 2);
});

test("npm test's actual facade command runs the same complete ordered contract gate", (t) => {
	const { result, calls } = runFixture(facadeFixture(t), false);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assertCompleteFixtureCalls(
		calls,
		process.platform === "win32" ? "pi-agent-browser-policy" : null,
	);
});

test("a real failed parallel TAP child propagates failure and blocks every serial child", (t) => {
	const { result, calls } = runFixture(facadeFixture(t), true, "parallel");
	assert.equal(result.status, 1);
	assert.match(result.stdout, /not ok .*fixture-parallel/);
	assert.match(result.stderr, /exited with code 1/);
	assert.deepEqual(
		calls.slice(0, 4).map((call) => call.stage),
		["isolated-parent", "build", "prepare", "parallel"],
	);
	assert.equal(
		calls.some((call) => readString(call.stage).startsWith("serial")),
		false,
	);
});

for (const stage of ["build", "prepare"]) {
	test(`a real failed ${stage} prerequisite preserves its exit status and blocks the remaining complete test gate`, (t) => {
		const { result, calls } = runFixture(facadeFixture(t), false, stage);
		assert.equal(result.status, 23);
		assert.match(result.stderr, /exited with code 23/);
		assert.deepEqual(
			calls.map((call) => call.stage),
			stage === "build" ? ["build"] : ["build", "prepare"],
		);
	});
}
