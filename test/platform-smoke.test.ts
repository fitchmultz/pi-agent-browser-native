import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import config from "../platform-smoke.config.mjs";
import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";
import {
	buildBrowserDogfoodCommand,
	buildPlatformBuildCommand,
} from "../scripts/platform-smoke/commands.mjs";
import { nodeVersionAtLeast } from "../scripts/platform-smoke/suite-checks.mjs";
import { platformFor } from "../scripts/platform-smoke/suite-evidence.mjs";
import {
	createLeaseCleanupResult,
	createLeaseWarmupFailureResult,
} from "../scripts/platform-smoke/lease-evidence.mjs";
import {
	collectSecretValues,
	redactSecrets,
	scanForSecrets,
	writeManifest,
} from "../scripts/platform-smoke/artifacts.mjs";

test("platform smoke CLI has working help without dogfood host bootstrap", () => {
	const powershell = readFileSync("scripts/platform-smoke/browser-dogfood-windows.ps1", "utf8");
	assert.doesNotMatch(powershell, /npm\s+install\s+-g/);
	assert.doesNotMatch(powershell, /agent-browser\s+install/);
	const help = spawnSync(process.execPath, ["scripts/platform-smoke.mjs", "--help"], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(help.error);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /windows-native/);
	assert.match(help.stdout, /PLATFORM_SMOKE_CRABBOX/);
	assert.match(help.stdout, /platform-build/);
	assert.match(help.stdout, /browser-dogfood-smoke/);
	assert.match(help.stdout, /agent-browser/);
});

test("platform smoke config and package scripts require macOS, Ubuntu, and native Windows", () => {
	const packageJson = readRecord(JSON.parse(readFileSync("package.json", "utf8")));
	const scripts = readRecord(packageJson.scripts);
	assert.match(readString(scripts["check:platform-smoke"]), /test\/platform-smoke\.test\.ts/);
	assert.equal(scripts["smoke:platform:doctor"], "node scripts/platform-smoke.mjs doctor");
	assert.match(readString(scripts["smoke:platform:ubuntu-image"]), /build-ubuntu-image\.mjs/);
	assert.match(readString(scripts["smoke:platform:all"]), /smoke:platform:doctor/);
	assert.match(readString(scripts["smoke:platform:all"]), /macos,ubuntu,windows-native/);
	assert.match(readString(scripts["smoke:platform:windows-native"]), /windows-native/);
	const linuxImage = readFileSync("scripts/platform-smoke/linux-image/Dockerfile", "utf8");
	for (const dependency of ["libvulkan1", "mesa-vulkan-drivers", "xvfb"]) {
		// Every required Ubuntu graphics dependency must remain in the image.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(linuxImage, new RegExp(`\\b${dependency}\\b`));
	}
	assert.equal(config.packageName, "pi-agent-browser-native");
	assert.equal(
		config.nodeValidationVersion,
		readString(readRecord(packageJson.engines).node).replace(/^>=/, ""),
	);
	assert.ok(config.ubuntuContainerImage.includes(`agent-browser${config.agentBrowserVersion}`));
	assert.match(config.agentBrowserVersion, /^\d+\.\d+\.\d+$/);
	assert.deepEqual(config.requiredSuites, ["platform-build", "browser-dogfood-smoke"]);
	assert.deepEqual(config.requiredTargets, ["macos", "ubuntu", "windows-native"]);
});

test("platform command rendering uses POSIX and PowerShell without source-extension shortcuts", () => {
	const posix = buildPlatformBuildCommand("ubuntu", "pi-agent-browser-native", "24.21.0");
	const macos = buildPlatformBuildCommand("macos", "pi-agent-browser-native", "24.21.0");
	const powershell = buildPlatformBuildCommand(
		"windows-native",
		"pi-agent-browser-native",
		"24.21.0",
	);
	const powershellScript = readFileSync(
		"scripts/platform-smoke/platform-build-windows.ps1",
		"utf8",
	);
	const dogfoodPosix = buildBrowserDogfoodCommand("ubuntu");
	const dogfoodWarmPosix = buildBrowserDogfoodCommand(
		"ubuntu",
		CAPABILITY_BASELINE.targetVersion,
		true,
	);
	const dogfoodWindows = buildBrowserDogfoodCommand("windows-native");
	const dogfoodWarmWindows = buildBrowserDogfoodCommand(
		"windows-native",
		CAPABILITY_BASELINE.targetVersion,
		true,
	);
	assert.equal(platformFor("macos"), "posix");
	assert.equal(platformFor("ubuntu"), "posix");
	assert.equal(platformFor("windows-native"), "powershell");
	assert.equal(nodeVersionAtLeast("v24.20.9", "24.21.0"), false);
	assert.equal(nodeVersionAtLeast("v24.3.0", "24.21.0"), false);
	assert.equal(nodeVersionAtLeast("v24.21.0", "24.21.0"), true);
	assert.equal(nodeVersionAtLeast("v24.100.0", "24.21.0"), true);
	assert.equal(nodeVersionAtLeast("v25.0.0", "24.21.0"), true);
	assert.equal(nodeVersionAtLeast("", "24.21.0"), false);
	assert.ok(posix.includes("'24.21.0'"));
	assert.ok(powershell.includes("-NodeValidationVersion '24.21.0'"));
	assert.match(posix, /npm run verify -- platform-target/);
	assert.match(posix, /install -l --approve \.\/node_modules\/pi-agent-browser-native/);
	assert.match(posix, /list --approve/);
	assert.doesNotMatch(posix, /\bpi\s+(?:-e|--extension)\s+\./);
	assert.doesNotMatch(posix, /cp -R src prompts/);
	assert.match(macos, /npm run verify -- platform-target/);
	assert.match(powershell, /platform-build-windows\.ps1/);
	assert.match(powershell, /pi-agent-browser-native/);
	assert.match(powershellScript, /install -l --approve/);
	assert.match(powershellScript, /list --approve/);
	assert.doesNotMatch(powershell, /\bpi\s+(?:-e|--extension)\s+\./);
	assert.match(dogfoodPosix, /verify-agent-browser-dogfood\.ts/);
	assert.ok(
		dogfoodPosix.includes(
			`EXPECTED_AGENT_BROWSER_VERSION='agent-browser ${CAPABILITY_BASELINE.targetVersion}'`,
		),
	);
	assert.match(dogfoodPosix, /PLATFORM_AGENT_BROWSER_READY_EXIT/);
	assert.match(dogfoodPosix, /--artifact-dir/);
	assert.match(dogfoodPosix, /npm ci 2>&1/);
	assert.doesNotMatch(dogfoodPosix, /PLATFORM_NPM_CI_SKIPPED=1/);
	assert.match(dogfoodWarmPosix, /PLATFORM_NPM_CI_SKIPPED=1/);
	assert.match(dogfoodWarmWindows, /-SkipNpmCi/);
	assert.doesNotMatch(dogfoodWindows, /-SkipNpmCi/);
	assert.match(dogfoodWindows, /browser-dogfood-windows\.ps1/);
	assert.ok(dogfoodWindows.includes(`-AgentBrowserVersion '${CAPABILITY_BASELINE.targetVersion}'`));
	assert.ok(
		dogfoodWarmWindows.includes(`-AgentBrowserVersion '${CAPABILITY_BASELINE.targetVersion}'`),
	);
	assert.doesNotMatch(dogfoodWindows, /npm install -g|agent-browser install/);
});

test("artifact manifests and lease cleanup failures are enforced", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-browser-platform-smoke-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const suiteDir = join(root, "suite");
	mkdirSync(suiteDir);
	writeFileSync(join(suiteDir, "present.txt"), "ok");
	const manifest = writeManifest(suiteDir, [
		"artifact-manifest.json",
		"present.txt",
		"missing.txt",
	]);
	const packageConfig = { artifactRoot: root, packageName: "pi-agent-browser-native" };
	const cleanup = createLeaseCleanupResult({
		config: packageConfig,
		targetName: "ubuntu",
		leaseId: "cbx_failed",
		stopResult: {
			stdout: "",
			stderr: "stop failed",
			code: 1,
			signal: null,
		},
	});
	const cleanupSuccess = createLeaseCleanupResult({
		config: packageConfig,
		targetName: "ubuntu",
		leaseId: "cbx_ok",
		stopResult: {
			stdout: "stopped",
			stderr: "",
			code: 0,
			signal: null,
		},
		staleCleanupResult: {
			stdout: "cleaned stale clones",
			stderr: "",
			code: 0,
			signal: null,
		},
	});
	const warmupFailure = createLeaseWarmupFailureResult(packageConfig, "ubuntu", {
		stdout: "",
		stderr: "warmup failed",
		code: 1,
		signal: null,
	});
	const assertions = readRecord(
		JSON.parse(readFileSync(join(cleanup.suiteDir, "assertions.json"), "utf8")),
	);
	const successManifest = readRecord(
		JSON.parse(readFileSync(join(cleanupSuccess.suiteDir, "artifact-manifest.json"), "utf8")),
	);
	const successTarget = readRecord(
		JSON.parse(readFileSync(join(cleanupSuccess.suiteDir, "target.json"), "utf8")),
	);
	assert.ok(manifest.present.includes("artifact-manifest.json"));
	assert.deepEqual(manifest.missing, ["missing.txt"]);
	assert.equal(cleanup.ok, false);
	assert.equal(assertions.ok, false);
	assert.ok(
		readArray(assertions.checks)
			.map(readRecord)
			.some((check) => check.id === "lease-cleanup" && check.ok === false),
	);
	assert.equal(cleanupSuccess.ok, true);
	assert.ok(readArray(successManifest.present).includes("crabbox.stop.stdout.txt"));
	assert.ok(readArray(successManifest.present).includes("crabbox.cleanup.stdout.txt"));
	assert.equal(successTarget.packageName, "pi-agent-browser-native");
	assert.equal(readRecord(successTarget.crabbox).provider, "local-container");
	assert.equal(readRecord(successTarget.crabbox).workRoot, "/work/crabbox");
	assert.equal(warmupFailure.ok, false);
	assert.match(readFileSync(join(warmupFailure.suiteDir, "failures.md"), "utf8"), /lease-warmup/);
	const env = { ZAI_API_KEY: "zai-secret-value-1234567890" };
	const secrets = collectSecretValues(["ZAI_API_KEY"], env);
	const redacted = redactSecrets(`token=${env.ZAI_API_KEY}`, secrets);
	assert.ok(
		scanForSecrets(`token=${env.ZAI_API_KEY}`, secrets).includes("raw forwarded secret value"),
	);
	assert.ok(!redacted.includes(env.ZAI_API_KEY));
	assert.match(redacted, /\[REDACTED_SECRET\]/);
});
