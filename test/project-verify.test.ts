/**
 * Purpose: Lock the maintainer npm verification facade so queue/release gates do not silently drop required checks.
 * Responsibilities: Assert `npm run verify` orchestration keeps docs drift, typecheck, unit/fake tests, command-reference, real-upstream, package Pi smoke, platform-target, and platform smoke steps wired to their focused scripts.
 * Scope: Unit coverage for scripts/project.mjs command planning only; the focused scripts own their own runtime behavior.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: The default gate is local and deterministic except for live command-reference sampling; real-upstream and platform diagnostics stay explicit modes while release composes the required platform gate.
 */

import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error scripts/project.mjs is an executable ESM maintainer script without a .d.ts surface.
const projectModule = (await import("../scripts/project.mjs")) as {
	docsSteps: (options: { mode: string; target: string }) => Array<{ command: string; args: string[]; env?: Record<string, string> }>;
	parseVerifyArgs: (argv?: string[]) => { mode: string; passthrough: string[]; showHelp: boolean };
	verifySteps: (options: { mode: string; passthrough: string[]; showHelp: boolean }) => Array<{ command: string; args: string[]; env?: Record<string, string> }>;
};
const { docsSteps, parseVerifyArgs, verifySteps } = projectModule;

function labels(steps: Array<{ args: string[]; env?: Record<string, string> }>): string[] {
	return steps.map((step) => step.args.join(" "));
}

test("verify facade default gate keeps docs, typecheck, unit/fake, and command-reference drift checks", () => {
	const steps = verifySteps({ mode: "default", passthrough: [], showHelp: false });
	const stepLabels = labels(steps);

	assert.deepEqual(stepLabels, [
		"./scripts/check-playbook-drift.ts --check",
		"--noEmit",
		"--test --test-concurrency=1 test/**/*.test.ts",
		"./scripts/check-command-reference-baseline.mjs --check",
		"./scripts/verify-command-reference.mjs",
	]);
});

test("verify facade opt-in modes keep real-upstream, dogfood, package-pi, platform-target, and platform smoke gates explicit", () => {
	const realUpstream = verifySteps({ mode: "real-upstream", passthrough: [], showHelp: false });
	assert.deepEqual(labels(realUpstream), ["--test test/agent-browser.real-upstream-contract.test.ts"]);
	assert.equal(realUpstream[0]?.env?.PI_AGENT_BROWSER_REAL_UPSTREAM, "1");

	const dogfood = verifySteps({ mode: "dogfood", passthrough: ["--keep-artifacts"], showHelp: false });
	assert.deepEqual(labels(dogfood), ["./scripts/verify-agent-browser-dogfood.ts --keep-artifacts"]);

	const packagePi = verifySteps({ mode: "package-pi", passthrough: [], showHelp: false });
	assert.deepEqual(labels(packagePi), ["./scripts/verify-package.mjs --smoke-pi"]);

	const platformTarget = verifySteps({ mode: "platform-target", passthrough: [], showHelp: false });
	assert.deepEqual(labels(platformTarget), [
		"./scripts/check-playbook-drift.ts --check",
		"./scripts/check-command-reference-baseline.mjs --check",
		"--noEmit",
		"--test --test-concurrency=1 test/project-verify.test.ts test/platform-smoke.test.ts test/verify-package.test.ts test/agent-browser.runtime.test.ts",
	]);

	const platformSmoke = verifySteps({ mode: "platform-smoke", passthrough: ["run", "--target", "macos", "--suite", "platform-build"], showHelp: false });
	assert.deepEqual(labels(platformSmoke), ["./scripts/platform-smoke.mjs run --target macos --suite platform-build"]);
});

test("verify facade release gate composes default verification, packaged Pi smoke, and platform smoke", () => {
	const release = verifySteps({ mode: "release", passthrough: [], showHelp: false });
	assert.deepEqual(labels(release), [
		"./scripts/check-playbook-drift.ts --check",
		"--noEmit",
		"--test --test-concurrency=1 test/**/*.test.ts",
		"./scripts/check-command-reference-baseline.mjs --check",
		"./scripts/verify-command-reference.mjs",
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
		() => verifySteps({ mode: "dogfood", passthrough: ["--artifact-dir"], showHelp: false }),
		/--artifact-dir requires a path/,
	);
	assert.throws(
		() => verifySteps({ mode: "platform-smoke", passthrough: ["run", "--target"], showHelp: false }),
		/--target requires a value/,
	);
	assert.deepEqual(parseVerifyArgs(["package", "--list-files"]), {
		mode: "package",
		passthrough: ["--list-files"],
		showHelp: false,
	});
});

test("verify facade lifecycle mode passes --model and other allowed flags through to verify-lifecycle.mjs", () => {
	const steps = verifySteps({
		mode: "lifecycle",
		passthrough: ["--model", "openai-codex/gpt-5.5:minimal", "--keep-artifacts", "--verbose", "--timeout-ms", "600000"],
		showHelp: false,
	});
	assert.deepEqual(labels(steps), [
		"./scripts/verify-lifecycle.mjs --model openai-codex/gpt-5.5:minimal --keep-artifacts --verbose --timeout-ms 600000",
	]);
});

test("verify facade lifecycle mode rejects --model without a value", () => {
	assert.throws(
		() => verifySteps({ mode: "lifecycle", passthrough: ["--model"], showHelp: false }),
		/--model requires a value/,
	);
	assert.throws(
		() => verifySteps({ mode: "lifecycle", passthrough: ["--model", "--keep-artifacts"], showHelp: false }),
		/--model requires a value/,
	);
});
