import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import childProcess, { ChildProcess, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { main as platformMain } from "../scripts/platform-smoke.mjs";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
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
import { checkForbiddenProjectFiles } from "../scripts/platform-smoke/doctor-support.mjs";
import {
	collectSecretValues,
	redactSecrets,
	scanForSecrets,
	writeManifest,
} from "../scripts/platform-smoke/artifacts.mjs";

test("platform doctor detects forbidden files in the actual npm package", (t) => {
	const root = mkdtempSync(join(tmpdir(), "platform-doctor-pack-"));
	const cwd = process.cwd();
	t.after(() => {
		process.chdir(cwd);
		rmSync(root, { recursive: true, force: true });
	});
	mkdirSync(join(root, "lib", "nested"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "platform-doctor-pack", version: "1.0.0", files: ["lib"] }),
	);
	writeFileSync(join(root, "lib", "nested", ".env.local"), "not-a-real-secret");
	process.chdir(root);
	const failures: string[] = [];
	const successes: string[] = [];
	checkForbiddenProjectFiles({
		ok(message: string) {
			successes.push(message);
		},
		fail(message: string) {
			failures.push(message);
		},
	});
	assert.ok(successes.includes("no local .env or package tarball artifacts at repo top level"));
	assert.ok(
		failures.some((message) =>
			message.includes("forbidden npm package path(s): lib/nested/.env.local"),
		),
		`Expected packed forbidden file to be rejected; failures: ${JSON.stringify(failures)}`,
	);
});

// The CLI honors maintainer PLATFORM_SMOKE_* overrides; fixtures for its defaults must not inherit them.
function clearPlatformSmokeOverrides(t: TestContext): void {
	const inherited = new Map<string, string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (name.startsWith("PLATFORM_SMOKE_") && value !== undefined) {
			inherited.set(name, value);
			delete process.env[name];
		}
	}
	t.after(() => {
		for (const [name, value] of inherited) {
			process.env[name] = value;
		}
	});
}

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

test("platform smoke config requires macOS/Ubuntu and keeps explicit best-effort Windows", () => {
	const packageJson = readRecord(JSON.parse(readFileSync("package.json", "utf8")));
	const scripts = readRecord(packageJson.scripts);
	assert.match(readString(scripts["check:platform-smoke"]), /test\/platform-smoke\.test\.ts/);
	assert.equal(scripts["smoke:platform:doctor"], "node scripts/platform-smoke.mjs doctor");
	assert.match(readString(scripts["smoke:platform:ubuntu-image"]), /build-ubuntu-image\.mjs/);
	assert.match(readString(scripts["smoke:platform:all"]), /smoke:platform:doctor/);
	assert.equal(
		scripts["smoke:platform:all"],
		"npm run smoke:platform:doctor && node scripts/platform-smoke.mjs run",
	);
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
	assert.deepEqual(config.requiredTargets, ["macos", "ubuntu"]);
	assert.deepEqual(config.optionalTargets, ["windows-native"]);
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

// Authoring gate: default/explicit target and provisioning contracts belong to this CLI owner.
// Old config inventories cannot detect doctor probing optional providers or real failure propagation.
// Public Node subprocess mocks exercise that boundary without a production seam or native qualification.
test("platform CLI defaults to required targets and preserves an explicitly selected Windows provider failure", async (t) => {
	clearPlatformSmokeOverrides(t);
	const root = mkdtempSync(join(tmpdir(), "platform-selection-"));
	const cwd = process.cwd();
	const calls: string[][] = [];
	t.after(() => {
		process.chdir(cwd);
		t.mock.restoreAll();
		syncBuiltinESMExports();
		rmSync(root, { recursive: true, force: true });
	});
	t.mock.method(childProcess, "spawn", (_command: unknown, args: unknown) => {
		calls.push(readArray(args).map(readString));
		const child = new ChildProcess();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdout = stdout;
		child.stderr = stderr;
		queueMicrotask(() => {
			stdout.end();
			stderr.end("controlled provider unavailable");
			child.emit("close", 23, null);
		});
		return child;
	});
	syncBuiltinESMExports();
	process.chdir(root);
	assert.equal(await platformMain(["run", "--suite", "platform-build"]), 1);
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.includes("ssh"), true);
	assert.equal(calls[1]?.includes("local-container"), true);
	assert.equal(calls.flat().includes("parallels"), false);
	calls.length = 0;
	assert.equal(
		await platformMain(["run", "--target", "windows-native", "--suite", "platform-build"]),
		1,
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.includes("parallels"), true);
	assert.equal(calls[0]?.includes("windows"), true);
	await assert.rejects(platformMain(["run", "--target", "not-a-target"]), /unknown target/);
	await assert.rejects(platformMain(["doctor", "--target", ","]), /Select at least one target/);
});

test("default platform doctor needs no Windows credentials/provider and keeps selected provisioning failures strict", async (t) => {
	clearPlatformSmokeOverrides(t);
	const root = mkdtempSync(join(tmpdir(), "platform-doctor-selection-"));
	const cwd = process.cwd();
	const exitCode = process.exitCode;
	const calls: string[] = [];
	let missingMac = false;
	let missingDocker = false;
	t.after(() => {
		process.chdir(cwd);
		process.exitCode = exitCode;
		t.mock.restoreAll();
		syncBuiltinESMExports();
		rmSync(root, { recursive: true, force: true });
	});
	t.mock.method(childProcess, "execFileSync", (command: unknown, args: unknown) => {
		const name = readString(command);
		const words = readArray(args).map(readString);
		calls.push([name, ...words].join(" "));
		if (name === "which") {
			return Buffer.from(words[0] === "prlctl" ? "" : readString(words[0]));
		}
		if (name === "crabbox" && words[0] === "--version") {
			return Buffer.from("0.26.0");
		}
		if (name === "crabbox" && words[0] === "providers") {
			return Buffer.from('[{"name":"ssh"},{"name":"local-container"}]');
		}
		if (name === "crabbox" && words[0] === "doctor") {
			return Buffer.from('{"ok":true}');
		}
		if (name === "npm") {
			return Buffer.from('[{"files":[]}]');
		}
		throw new Error("unexpected doctor command");
	});
	t.mock.method(childProcess, "execSync", (command: unknown) => {
		const text = readString(command);
		calls.push(text);
		if (text.startsWith("ssh ") && missingMac) {
			throw new Error("controlled SSH unavailable");
		}
		if (text.startsWith("ssh ")) {
			return Buffer.from(`v24.21.0 agent-browser ${CAPABILITY_BASELINE.targetVersion}`);
		}
		if (text.startsWith("docker info")) {
			if (missingDocker) {
				throw new Error("controlled Docker unavailable");
			}
			return Buffer.from("28.0.0");
		}
		const versions = new Map<string, string>(
			Object.entries({
				"node --version": "v24.21.0",
				"npm --version": "12.2.0",
				"git --version": "2.50.0",
				"tar --version": "1.0",
				"agent-browser --version": `agent-browser ${CAPABILITY_BASELINE.targetVersion}`,
			}),
		);
		return Buffer.from(versions.get(text) ?? "");
	});
	syncBuiltinESMExports();
	process.chdir(root);
	process.exitCode = 0;
	assert.equal(await platformMain(["doctor"]), 0);
	assert.equal(
		calls.some((call) => call.includes("parallels") || call.includes("prlctl")),
		false,
	);
	assert.equal(
		calls.some((call) => call.startsWith("ssh ")),
		true,
	);
	assert.equal(
		calls.some((call) => call.startsWith("docker info")),
		true,
	);
	calls.length = 0;
	assert.equal(await platformMain(["doctor", "--target", "windows-native"]), 1);
	assert.equal(calls.includes("which prlctl"), true);
	assert.equal(
		calls.some((call) => call.startsWith("ssh ") || call.startsWith("docker info")),
		false,
	);
	process.exitCode = 0;
	missingMac = true;
	assert.equal(await platformMain(["doctor", "--target", "macos"]), 1);
	process.exitCode = 0;
	missingDocker = true;
	assert.equal(await platformMain(["doctor", "--target", "ubuntu"]), 1);
});
