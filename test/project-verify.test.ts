/**
 * Purpose: Lock the maintainer npm verification facade so queue/release gates do not silently drop required checks.
 * Responsibilities: Assert lockfile URL hygiene and that `npm run verify` orchestration keeps docs drift, typecheck, unit/fake tests, command-reference, pre-pr, safe startup profiling, real-upstream, package Pi smoke, platform-target, and platform smoke steps wired to their focused scripts.
 * Scope: Package-lock policy and unit coverage for scripts/project.mjs command planning; focused scripts own their own runtime behavior.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: The default gate is local and deterministic except for live command-reference sampling; real-upstream and platform diagnostics stay explicit modes while release composes the required platform gate.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";

import { docsSteps, hostToolPath, parseVerifyArgs, verifySteps } from "../scripts/project.mjs";
import { readArray, readRecord, readString } from "./helpers/assertions.js";

const DEFAULT_STEPS = [
	"./scripts/build.mjs",
	"./scripts/prepare-quality-checker.mjs",
	"./scripts/code-quality.mjs lint",
	"--check .",
	"--noEmit",
	"--test test/**/!(*.serial).test.ts",
	"--test --test-concurrency=1 test/**/*.serial.test.ts",
	"./scripts/check-playbook-drift.ts --check",
	"./scripts/check-command-reference-baseline.mjs --check",
	"./scripts/verify-command-reference.mjs",
];

function labels(steps: unknown): string[] {
	return readArray(steps).map((step) => readArray(readRecord(step).args).map(readString).join(" "));
}

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
		"./scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native",
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
