import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function run(command: string, args: string[]) {
	return spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		shell: process.platform === "win32" && command === "npm",
	});
}

test("platform smoke scripts have working syntax and help", () => {
	for (const path of [
		"platform-smoke.config.mjs",
		"scripts/platform-smoke.mjs",
		"scripts/platform-smoke/artifacts.mjs",
		"scripts/platform-smoke/crabbox-runner.mjs",
		"scripts/platform-smoke/doctor.mjs",
		"scripts/platform-smoke/targets.mjs",
	]) {
		assert.equal(run(process.execPath, ["--check", path]).status, 0, path);
	}

	for (const path of [
		"scripts/platform-smoke/platform-build-windows.ps1",
		"scripts/platform-smoke/browser-dogfood-windows.ps1",
	]) {
		assert.ok(existsSync(path), `${path} should exist`);
		const powershellScript = readFileSync(path, "utf8");
		assert.match(powershellScript, /PLATFORM_/);
		if (path.endsWith("browser-dogfood-windows.ps1")) {
			assert.doesNotMatch(powershellScript, /npm\s+install\s+-g/);
			assert.doesNotMatch(powershellScript, /agent-browser\s+install/);
		}
	}

	const help = run(process.execPath, ["scripts/platform-smoke.mjs", "--help"]);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /windows-native/);
	assert.match(help.stdout, /PLATFORM_SMOKE_CRABBOX/);
	assert.match(help.stdout, /platform-build/);
	assert.match(help.stdout, /browser-dogfood-smoke/);
	assert.match(help.stdout, /agent-browser/);
});

test("platform smoke config and package scripts require macOS, Ubuntu, and native Windows", () => {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
		files?: string[];
		scripts?: Record<string, string>;
	};
	assert.ok(packageJson.files?.includes("platform-smoke.config.mjs"));
	assert.ok(packageJson.files?.includes("scripts/platform-smoke.mjs"));
	assert.ok(packageJson.files?.includes("scripts/platform-smoke"));
	assert.ok(packageJson.files?.includes("docs/platform-smoke.md"));
	assert.match(packageJson.scripts?.["check:platform-smoke"] ?? "", /node --check scripts\/platform-smoke\.mjs/);
	assert.match(packageJson.scripts?.["check:platform-smoke"] ?? "", /test\/platform-smoke\.test\.ts/);
	assert.equal(packageJson.scripts?.["smoke:platform:doctor"], "node scripts/platform-smoke.mjs doctor");
	assert.match(packageJson.scripts?.["smoke:platform:ubuntu-image"] ?? "", /docker build/);
	assert.match(packageJson.scripts?.["smoke:platform:all"] ?? "", /smoke:platform:doctor/);
	assert.match(packageJson.scripts?.["smoke:platform:all"] ?? "", /macos,ubuntu,windows-native/);
	assert.match(packageJson.scripts?.["smoke:platform:windows-native"] ?? "", /windows-native/);

	const code = String.raw`
import config from "./platform-smoke.config.mjs";
const result = {
  agentBrowserVersion: config.agentBrowserVersion,
  nodeValidationMajor: config.nodeValidationMajor,
  packageName: config.packageName,
  ubuntuContainerImage: config.ubuntuContainerImage,
  suites: config.requiredSuites,
  targets: config.requiredTargets,
};
console.log(JSON.stringify(result));
if (result.packageName !== "pi-agent-browser-native") process.exit(1);
if (result.nodeValidationMajor !== 22) process.exit(1);
if (!result.ubuntuContainerImage.includes("agent-browser0.27.1")) process.exit(1);
if (!/^\d+\.\d+\.\d+$/.test(result.agentBrowserVersion)) process.exit(1);
if (result.suites.join(",") !== "platform-build,browser-dogfood-smoke") process.exit(1);
if (result.targets.join(",") !== "macos,ubuntu,windows-native") process.exit(1);
`;
	const result = run(process.execPath, ["--input-type=module", "-e", code]);
	assert.equal(result.status, 0, result.stderr);
});

test("platform command rendering uses POSIX and PowerShell without source-extension shortcuts", () => {
	const code = String.raw`
import { buildBrowserDogfoodCommand, buildPlatformBuildCommand, platformFor } from "./scripts/platform-smoke/targets.mjs";
const posix = buildPlatformBuildCommand("ubuntu", "pi-agent-browser-native", 22);
const macos = buildPlatformBuildCommand("macos", "pi-agent-browser-native", 22);
const powershell = buildPlatformBuildCommand("windows-native", "pi-agent-browser-native", 22);
const dogfoodPosix = buildBrowserDogfoodCommand("ubuntu");
const dogfoodWindows = buildBrowserDogfoodCommand("windows-native");
const result = {
  macosPlatform: platformFor("macos") === "posix",
  ubuntuPlatform: platformFor("ubuntu") === "posix",
  windowsPlatform: platformFor("windows-native") === "powershell",
  posixHasVerify: posix.includes("npm run verify -- platform-target"),
  posixHasPackedInstall: posix.includes("install -l ./node_modules/pi-agent-browser-native"),
  posixNoExtensionShortcut: !/\bpi\s+(?:-e|--extension)\s+\./.test(posix),
  posixNoFixtureCopy: !posix.includes("cp -R src prompts"),
  macosHasVerify: macos.includes("npm run verify -- platform-target"),
  powershellUsesScript: powershell.includes("platform-build-windows.ps1"),
  powershellHasPackage: powershell.includes("pi-agent-browser-native"),
  powershellNoExtensionShortcut: !/\bpi\s+(?:-e|--extension)\s+\./.test(powershell),
  dogfoodRunsScript: dogfoodPosix.includes("verify-agent-browser-dogfood.ts"),
  dogfoodChecksBaseline: dogfoodPosix.includes("EXPECTED_AGENT_BROWSER_VERSION='agent-browser 0.27.1'") && dogfoodPosix.includes("PLATFORM_AGENT_BROWSER_READY_EXIT"),
  dogfoodKeepsArtifacts: dogfoodPosix.includes("--artifact-dir"),
  dogfoodWindowsUsesScript: dogfoodWindows.includes("browser-dogfood-windows.ps1") && dogfoodWindows.includes("-AgentBrowserVersion '0.27.1'"),
  dogfoodWindowsDoesNotBootstrap: !dogfoodWindows.includes("npm install -g") && !dogfoodWindows.includes("agent-browser install"),
};
console.log(JSON.stringify(result));
if (!Object.values(result).every(Boolean)) process.exit(1);
`;
	const result = run(process.execPath, ["--input-type=module", "-e", code]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("artifact manifests and lease cleanup failures are enforced", () => {
	const code = String.raw`
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSecretValues, redactSecrets, scanForSecrets, writeManifest } from "./scripts/platform-smoke/artifacts.mjs";
import { createLeaseCleanupFailureResult, createLeaseCleanupResult, createLeaseWarmupFailureResult } from "./scripts/platform-smoke/targets.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-agent-browser-platform-smoke-test-"));
try {
  const suiteDir = join(root, "suite");
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(join(suiteDir, "present.txt"), "ok");
  const manifest = writeManifest(suiteDir, ["artifact-manifest.json", "present.txt", "missing.txt"]);
  const cleanup = createLeaseCleanupFailureResult({ artifactRoot: root, packageName: "pi-agent-browser-native" }, "ubuntu", "cbx_failed", {
    stdout: "",
    stderr: "stop failed",
    code: 1,
    signal: null,
  });
  const cleanupSuccess = createLeaseCleanupResult({ artifactRoot: root, packageName: "pi-agent-browser-native" }, "ubuntu", "cbx_ok", {
    stdout: "stopped",
    stderr: "",
    code: 0,
    signal: null,
  }, {
    stdout: "cleaned stale clones",
    stderr: "",
    code: 0,
    signal: null,
  });
  const warmupFailure = createLeaseWarmupFailureResult({ artifactRoot: root, packageName: "pi-agent-browser-native" }, "ubuntu", {
    stdout: "",
    stderr: "warmup failed",
    code: 1,
    signal: null,
  });
  const assertions = JSON.parse(readFileSync(join(cleanup.suiteDir, "assertions.json"), "utf8"));
  const successManifest = JSON.parse(readFileSync(join(cleanupSuccess.suiteDir, "artifact-manifest.json"), "utf8"));
  const env = { ZAI_API_KEY: "zai-secret-value-1234567890" };
  const secrets = collectSecretValues(["ZAI_API_KEY"], env);
  const redacted = redactSecrets("token=" + env.ZAI_API_KEY, secrets);
  const result = {
    manifestIncludesSelf: manifest.present.includes("artifact-manifest.json"),
    missingRecorded: manifest.missing.includes("missing.txt"),
    cleanupOk: cleanup.ok,
    cleanupSuccessOk: cleanupSuccess.ok,
    cleanupSuccessRecorded: successManifest.present.includes("crabbox.stop.stdout.txt") && successManifest.present.includes("crabbox.cleanup.stdout.txt"),
    warmupFailureRecorded: warmupFailure.ok === false && readFileSync(join(warmupFailure.suiteDir, "failures.md"), "utf8").includes("lease-warmup"),
    assertionsOk: assertions.ok,
    leaseCleanupFailed: assertions.checks.some((check) => check.id === "lease-cleanup" && check.ok === false),
    secretDetected: scanForSecrets("token=" + env.ZAI_API_KEY, secrets).includes("raw forwarded secret value"),
    secretRedacted: !redacted.includes(env.ZAI_API_KEY) && redacted.includes("[REDACTED_SECRET]"),
  };
  console.log(JSON.stringify(result));
  if (!result.manifestIncludesSelf || !result.missingRecorded || result.cleanupOk || !result.cleanupSuccessOk || !result.cleanupSuccessRecorded || !result.warmupFailureRecorded || result.assertionsOk || !result.leaseCleanupFailed || !result.secretDetected || !result.secretRedacted) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`;
	const result = run(process.execPath, ["--input-type=module", "-e", code]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("npm pack includes platform smoke docs and scripts", () => {
	const result = run("npm", ["pack", "--dry-run", "--json"]);
	assert.equal(result.status, 0, result.stderr);
	const packs = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
	const paths = new Set(packs[0]?.files.map((file) => file.path) ?? []);
	for (const path of [
		"docs/platform-smoke.md",
		"platform-smoke.config.mjs",
		"scripts/platform-smoke.mjs",
		"scripts/platform-smoke/artifacts.mjs",
		"scripts/platform-smoke/crabbox-runner.mjs",
		"scripts/platform-smoke/doctor.mjs",
		"scripts/platform-smoke/targets.mjs",
		"scripts/platform-smoke/platform-build-windows.ps1",
		"scripts/platform-smoke/browser-dogfood-windows.ps1",
		"scripts/platform-smoke/linux-image/Dockerfile",
	]) {
		assert.ok(paths.has(path), `expected npm pack to include ${path}`);
	}
	for (const forbidden of [".artifacts/", ".crabbox/", ".debug/", ".platform-smoke-runs/", ".env", ".env."]) {
		assert.equal([...paths].some((path) => path === forbidden || path.startsWith(forbidden)), false);
	}
	assert.equal([...paths].some((path) => path.endsWith(".tgz")), false);
});
