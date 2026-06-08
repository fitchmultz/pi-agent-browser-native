/** Target/suite runner for pi-agent-browser-native platform smoke. */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
	collectSecretValues,
	createSuiteDir,
	redactSecrets,
	scanArtifactTextFiles,
	scanForSecrets,
	writeCommand,
	writeExitCode,
	writeManifest,
	writeSummary,
} from "./artifacts.mjs";
import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";
import { cleanupStaleTargetState, crabboxBin, describeTarget, runOnLease, stopLease, warmupLease } from "./crabbox-runner.mjs";

export function platformFor(targetName) {
	return targetName === "windows-native" ? "powershell" : "posix";
}

function makeRunId() {
	return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psSingleQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function authEnvAllowList(config = {}) {
	const raw = process.env.PLATFORM_SMOKE_AUTH_ENV;
	const names = raw ? raw.split(",") : (config.defaultAuthEnv ?? []);
	return names.map((name) => String(name).trim()).filter(Boolean);
}

function packageVersion() {
	try {
		return JSON.parse(readFileSync("package.json", "utf8")).version ?? null;
	} catch {
		return null;
	}
}

function crabboxVersion() {
	try {
		return execFileSync(crabboxBin(), ["--version"], { encoding: "utf8", stdio: "pipe", timeout: 10_000 }).trim().split(/\r?\n/)[0] ?? null;
	} catch {
		return null;
	}
}

function targetEvidence(config, targetName, runId, slug) {
	const target = describeTarget(targetName, config);
	return {
		targetName,
		platform: platformFor(targetName),
		runId,
		slug,
		packageName: config.packageName,
		packageVersion: packageVersion(),
		crabbox: {
			binary: crabboxBin(),
			version: crabboxVersion(),
			provider: target.provider,
			target: target.crabboxTarget,
			workRoot: target.workRoot,
			image: target.image,
			windowsMode: target.windowsMode,
			sourceVm: target.sourceVm,
			snapshot: target.snapshot,
		},
	};
}

function writeRedacted(path, text, secretValues) {
	writeFileSync(path, redactSecrets(text ?? "", secretValues));
}

function section(text, name) {
	const start = `--- ${name} START ---`;
	const end = `--- ${name} END ---`;
	const startIndex = text.indexOf(start);
	if (startIndex === -1) return "";
	const contentStart = startIndex + start.length;
	const endIndex = text.indexOf(end, contentStart);
	return (endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex)).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function marker(text, name) {
	return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

function parseJsonObject(text) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed);
	} catch {
		const first = trimmed.indexOf("{");
		const last = trimmed.lastIndexOf("}");
		if (first !== -1 && last > first) {
			try {
				return JSON.parse(trimmed.slice(first, last + 1));
			} catch {
				return {};
			}
		}
		return {};
	}
}

function writePlatformExtracts(suiteDir, stdout, secretValues = []) {
	writeFileSync(resolve(suiteDir, "node-version.txt"), `${marker(stdout, "PLATFORM_NODE_VERSION")}\n`);
	writeRedacted(resolve(suiteDir, "packed-tarball.txt"), `${marker(stdout, "PLATFORM_PACKED_TARBALL")}\n`, secretValues);
	writeRedacted(resolve(suiteDir, "packed-node-install.stdout.txt"), section(stdout, "PACKED_NODE_INSTALL_STDOUT"), secretValues);
	writeRedacted(resolve(suiteDir, "packed-node-install.stderr.txt"), section(stdout, "PACKED_NODE_INSTALL_STDERR"), secretValues);
	writeRedacted(resolve(suiteDir, "pi-install.stdout.txt"), section(stdout, "PI_INSTALL_STDOUT"), secretValues);
	writeRedacted(resolve(suiteDir, "pi-install.stderr.txt"), section(stdout, "PI_INSTALL_STDERR"), secretValues);
	writeRedacted(resolve(suiteDir, "pi-list.stdout.txt"), section(stdout, "PI_LIST_STDOUT"), secretValues);
	writeRedacted(resolve(suiteDir, "pi-list.stderr.txt"), section(stdout, "PI_LIST_STDERR"), secretValues);
}

function writeDogfoodExtracts(suiteDir, stdout, secretValues = []) {
	writeFileSync(resolve(suiteDir, "node-version.txt"), `${marker(stdout, "PLATFORM_NODE_VERSION")}\n`);
	writeRedacted(resolve(suiteDir, "dogfood-artifacts.txt"), `${marker(stdout, "PLATFORM_DOGFOOD_ARTIFACT_DIR")}\n`, secretValues);
	const dogfoodStdout = section(stdout, "DOGFOOD_STDOUT");
	writeRedacted(resolve(suiteDir, "dogfood.stdout.txt"), dogfoodStdout, secretValues);
	writeRedacted(resolve(suiteDir, "dogfood.stderr.txt"), section(stdout, "DOGFOOD_STDERR"), secretValues);
	const report = parseJsonObject(dogfoodStdout);
	writeRedacted(resolve(suiteDir, "dogfood-report.json"), JSON.stringify(report, null, 2), secretValues);
	return report;
}

function assertionsFromChecks(checks) {
	const evaluated = checks.map((check) => {
		let ok = false;
		let error = check.error;
		try {
			ok = check.fn() === true;
		} catch (err) {
			error = err.message;
		}
		return { id: check.id, ok, ...(ok ? {} : { error: error ?? `${check.id} failed` }) };
	});
	return { ok: evaluated.every((check) => check.ok), checks: evaluated, writtenAt: new Date().toISOString() };
}

function writeAssertions(suiteDir, checks) {
	const assertions = assertionsFromChecks(checks);
	writeFileSync(resolve(suiteDir, "assertions.json"), JSON.stringify(assertions, null, 2));
	if (!assertions.ok) {
		writeFileSync(resolve(suiteDir, "failures.md"), [
			"# Platform smoke failures",
			"",
			...assertions.checks.filter((check) => !check.ok).map((check) => `- ${check.id}: ${check.error ?? "failed"}`),
			"",
			"Inspect command.txt, crabbox.stdout.txt, and crabbox.stderr.txt in this suite directory.",
			"",
		].join("\n"));
	}
	return assertions;
}

function finalizeSuite(suiteDir, checks, summary, expectedFiles) {
	const assertions = writeAssertions(suiteDir, checks);
	writeSummary(suiteDir, { ...summary, ok: assertions.ok });
	const expected = assertions.ok ? expectedFiles : [...expectedFiles, "failures.md"];
	const manifest = writeManifest(suiteDir, expected);
	if (manifest.missing.length === 0) return { assertions, manifest };
	const finalAssertions = writeAssertions(suiteDir, [
		...checks,
		{ id: "artifact-manifest-complete", fn: () => false, error: `missing required artifact(s): ${manifest.missing.join(", ")}` },
	]);
	writeSummary(suiteDir, { ...summary, ok: false });
	return { assertions: finalAssertions, manifest: writeManifest(suiteDir, [...expectedFiles, "failures.md"]) };
}

export function createLeaseCleanupResult(config, targetName, leaseId, stopResult, staleCleanupResult = null, runId = makeRunId()) {
	const suiteName = "lease-cleanup";
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	const secretValues = collectSecretValues(authEnvAllowList(config));
	writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify(targetEvidence(config, targetName, runId, `${config.packageName}-${targetName}`), null, 2));
	writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, leaseId, modelCalls: 0 }, null, 2));
	writeCommand(suiteDir, `crabbox stop ${targetName} --id ${leaseId}`);
	writeExitCode(suiteDir, stopResult.code, stopResult.signal);
	writeRedacted(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout ?? "", secretValues);
	writeRedacted(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr ?? "", secretValues);
	writeFileSync(resolve(suiteDir, "crabbox.stop.exit-code.txt"), `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`);
	if (staleCleanupResult) {
		writeRedacted(resolve(suiteDir, "crabbox.cleanup.stdout.txt"), staleCleanupResult.stdout ?? "", secretValues);
		writeRedacted(resolve(suiteDir, "crabbox.cleanup.stderr.txt"), staleCleanupResult.stderr ?? "", secretValues);
		writeFileSync(resolve(suiteDir, "crabbox.cleanup.exit-code.txt"), `code=${staleCleanupResult.code}\nsignal=${staleCleanupResult.signal ?? "none"}\n`);
	}
	const secretViolations = [
		...scanForSecrets(`${stopResult.stdout ?? ""}\n${stopResult.stderr ?? ""}`, secretValues),
		...scanArtifactTextFiles(suiteDir, secretValues).map((finding) => `${finding.file}: ${finding.violation}`),
	];
	const { assertions } = finalizeSuite(
		suiteDir,
		[
			{ id: "lease-cleanup", fn: () => stopResult.code === 0, error: `Crabbox stop failed with exit ${stopResult.code}` },
			{ id: "stale-cleanup", fn: () => !staleCleanupResult || staleCleanupResult.code === 0, error: `Crabbox cleanup failed with exit ${staleCleanupResult?.code}` },
			{ id: "no-secret-artifacts", fn: () => secretViolations.length === 0, error: secretViolations.join(", ") },
		],
		{ target: targetName, suite: suiteName, exitCode: stopResult.code, signal: stopResult.signal, elapsedMs: 0 },
		[
			"summary.json", "artifact-manifest.json", "target.json", "suite.json", "command.txt", "exit-code.txt",
			"crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt",
			...(staleCleanupResult ? ["crabbox.cleanup.stdout.txt", "crabbox.cleanup.stderr.txt", "crabbox.cleanup.exit-code.txt"] : []),
			"assertions.json",
		],
	);
	return { ok: assertions.ok, suiteDir, assertions };
}

export function createLeaseCleanupFailureResult(config, targetName, leaseId, stopResult, runId) {
	return createLeaseCleanupResult(config, targetName, leaseId, stopResult, null, runId);
}

export function createLeaseWarmupFailureResult(config, targetName, warmupResult, runId = makeRunId()) {
	const suiteName = "lease-warmup";
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	const secretValues = collectSecretValues(authEnvAllowList(config));
	writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify(targetEvidence(config, targetName, runId, `${config.packageName}-${targetName}`), null, 2));
	writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, modelCalls: 0 }, null, 2));
	writeCommand(suiteDir, `crabbox warmup ${targetName}`);
	writeExitCode(suiteDir, warmupResult.code, warmupResult.signal);
	writeRedacted(resolve(suiteDir, "crabbox.stdout.txt"), warmupResult.stdout ?? "", secretValues);
	writeRedacted(resolve(suiteDir, "crabbox.stderr.txt"), warmupResult.stderr ?? "", secretValues);
	const secretViolations = [
		...scanForSecrets(`${warmupResult.stdout ?? ""}\n${warmupResult.stderr ?? ""}`, secretValues),
		...scanArtifactTextFiles(suiteDir, secretValues).map((finding) => `${finding.file}: ${finding.violation}`),
	];
	const { assertions } = finalizeSuite(
		suiteDir,
		[
			{ id: "lease-warmup", fn: () => false, error: `Crabbox warmup failed with exit ${warmupResult.code}` },
			{ id: "no-secret-artifacts", fn: () => secretViolations.length === 0, error: secretViolations.join(", ") },
		],
		{ target: targetName, suite: suiteName, exitCode: warmupResult.code, signal: warmupResult.signal, elapsedMs: 0, ok: false },
		["summary.json", "artifact-manifest.json", "target.json", "suite.json", "command.txt", "exit-code.txt", "crabbox.stdout.txt", "crabbox.stderr.txt", "assertions.json"],
	);
	return { ok: false, suiteDir, assertions };
}

export function buildPlatformBuildCommand(targetName, packageName = "pi-agent-browser-native", nodeValidationMajor = 22) {
	if (platformFor(targetName) === "powershell") {
		return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\platform-build-windows.ps1 -PackageName ${psSingleQuote(packageName)} -NodeValidationMajor ${nodeValidationMajor}`;
	}

	const lines = [];
	lines.push(`echo "Starting platform-build in $(pwd) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`);
	lines.push(`RUN_ROOT=".platform-smoke-runs/platform-build-$(date -u +%Y%m%dT%H%M%SZ)-$$"`);
	lines.push(`SOURCE_ROOT="$(pwd)"`);
	lines.push(`PACK_DIR="$SOURCE_ROOT/$RUN_ROOT/pack"`);
	lines.push(`PI_PROJECT="$SOURCE_ROOT/$RUN_ROOT/pi-project"`);
	lines.push(`mkdir -p "$PACK_DIR" "$PI_PROJECT"`);
	lines.push(`echo "PLATFORM_RUN_ROOT=$RUN_ROOT"`);
	lines.push(`NODE_VERSION=$(node --version)`);
	lines.push(`NODE_MAJOR="${"${NODE_VERSION#v}"}"`);
	lines.push(`NODE_MAJOR="${"${NODE_MAJOR%%.*}"}"`);
	lines.push(`echo "PLATFORM_NODE_VERSION=$NODE_VERSION"`);
	lines.push(`if [ "$NODE_MAJOR" -ge ${nodeValidationMajor} ]; then NODE_VERSION_EXIT=0; else NODE_VERSION_EXIT=1; fi`);
	lines.push(`echo "PLATFORM_NODE_VERSION_EXIT=$NODE_VERSION_EXIT"`);
	lines.push(`npm ci 2>&1`);
	lines.push(`NPM_CI_EXIT=$?`);
	lines.push(`echo "PLATFORM_NPM_CI_EXIT=$NPM_CI_EXIT"`);
	lines.push(`npm run verify -- platform-target 2>&1`);
	lines.push(`VERIFY_EXIT=$?`);
	lines.push(`echo "PLATFORM_VERIFY_EXIT=$VERIFY_EXIT"`);
	lines.push(`PACK_TARBALL=$(npm pack --silent --pack-destination "$PACK_DIR" 2>"$PACK_DIR/npm-pack.stderr.txt")`);
	lines.push(`PACK_EXIT=$?`);
	lines.push(`cat "$PACK_DIR/npm-pack.stderr.txt"`);
	lines.push(`PACK_FILE="$PACK_DIR/$PACK_TARBALL"`);
	lines.push(`echo "PLATFORM_NPM_PACK_EXIT=$PACK_EXIT"`);
	lines.push(`echo "PLATFORM_PACKED_TARBALL=$PACK_FILE"`);
	lines.push(`PI_CLI="$SOURCE_ROOT/node_modules/.bin/pi"`);
	lines.push(`if [ ! -x "$PI_CLI" ]; then PI_CLI="$(command -v pi || true)"; fi`);
	lines.push(`echo "PLATFORM_PI_CLI=$PI_CLI"`);
	lines.push(`if [ -n "$PACK_TARBALL" ] && [ -f "$PACK_FILE" ]; then (cd "$PI_PROJECT" && npm init -y >"$PACK_DIR/packed-node-install.stdout.txt" 2>"$PACK_DIR/packed-node-install.stderr.txt" && npm install --no-save "$PACK_FILE" >>"$PACK_DIR/packed-node-install.stdout.txt" 2>>"$PACK_DIR/packed-node-install.stderr.txt"); PACKED_NODE_INSTALL_EXIT=$?; else echo "missing tarball" >"$PACK_DIR/packed-node-install.stderr.txt"; PACKED_NODE_INSTALL_EXIT=1; fi`);
	lines.push(`echo "PLATFORM_PACKED_NODE_INSTALL_EXIT=$PACKED_NODE_INSTALL_EXIT"`);
	lines.push(`echo "--- PACKED_NODE_INSTALL_STDOUT START ---"; cat "$PACK_DIR/packed-node-install.stdout.txt" 2>/dev/null || true; echo "--- PACKED_NODE_INSTALL_STDOUT END ---"`);
	lines.push(`echo "--- PACKED_NODE_INSTALL_STDERR START ---"; cat "$PACK_DIR/packed-node-install.stderr.txt" 2>/dev/null || true; echo "--- PACKED_NODE_INSTALL_STDERR END ---"`);
	lines.push(`if [ "$PACKED_NODE_INSTALL_EXIT" -eq 0 ] && [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" install -l --approve ./node_modules/${packageName} >"$PACK_DIR/pi-install.stdout.txt" 2>"$PACK_DIR/pi-install.stderr.txt"); PI_INSTALL_EXIT=$?; else echo "missing pi cli or packed install" >"$PACK_DIR/pi-install.stderr.txt"; PI_INSTALL_EXIT=1; fi`);
	lines.push(`echo "PLATFORM_PI_INSTALL_EXIT=$PI_INSTALL_EXIT"`);
	lines.push(`echo "--- PI_INSTALL_STDOUT START ---"; cat "$PACK_DIR/pi-install.stdout.txt" 2>/dev/null || true; echo "--- PI_INSTALL_STDOUT END ---"`);
	lines.push(`echo "--- PI_INSTALL_STDERR START ---"; cat "$PACK_DIR/pi-install.stderr.txt" 2>/dev/null || true; echo "--- PI_INSTALL_STDERR END ---"`);
	lines.push(`if [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" list --approve >"$PACK_DIR/pi-list.stdout.txt" 2>"$PACK_DIR/pi-list.stderr.txt"); PI_LIST_EXIT=$?; else echo "missing pi cli" >"$PACK_DIR/pi-list.stderr.txt"; PI_LIST_EXIT=1; fi`);
	lines.push(`echo "PLATFORM_PI_LIST_EXIT=$PI_LIST_EXIT"`);
	lines.push(`echo "--- PI_LIST_STDOUT START ---"; cat "$PACK_DIR/pi-list.stdout.txt" 2>/dev/null || true; echo "--- PI_LIST_STDOUT END ---"`);
	lines.push(`echo "--- PI_LIST_STDERR START ---"; cat "$PACK_DIR/pi-list.stderr.txt" 2>/dev/null || true; echo "--- PI_LIST_STDERR END ---"`);
	lines.push(`if [ "$NODE_VERSION_EXIT" -ne 0 ] || [ "$NPM_CI_EXIT" -ne 0 ] || [ "$VERIFY_EXIT" -ne 0 ] || [ "$PACK_EXIT" -ne 0 ] || [ "$PACKED_NODE_INSTALL_EXIT" -ne 0 ] || [ "$PI_INSTALL_EXIT" -ne 0 ] || [ "$PI_LIST_EXIT" -ne 0 ]; then echo "PLATFORM_BUILD_FAILED"; exit 1; fi`);
	lines.push(`echo "PLATFORM_BUILD_OK"`);
	return lines.join("\n");
}

export function buildBrowserDogfoodCommand(targetName, agentBrowserVersion = CAPABILITY_BASELINE.targetVersion) {
	if (platformFor(targetName) === "powershell") {
		return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\browser-dogfood-windows.ps1 -AgentBrowserVersion ${psSingleQuote(agentBrowserVersion)}`;
	}

	const lines = [];
	lines.push(`echo "Starting browser-dogfood-smoke in $(pwd) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`);
	lines.push(`RUN_ROOT=".platform-smoke-runs/browser-dogfood-$(date -u +%Y%m%dT%H%M%SZ)-$$"`);
	lines.push(`SOURCE_ROOT="$(pwd)"`);
	lines.push(`DOGFOOD_DIR="$SOURCE_ROOT/$RUN_ROOT/dogfood"`);
	lines.push(`DOGFOOD_ARTIFACT_DIR="$DOGFOOD_DIR/artifacts"`);
	lines.push(`mkdir -p "$DOGFOOD_ARTIFACT_DIR"`);
	lines.push(`echo "PLATFORM_RUN_ROOT=$RUN_ROOT"`);
	lines.push(`echo "PLATFORM_DOGFOOD_ARTIFACT_DIR=$DOGFOOD_ARTIFACT_DIR"`);
	lines.push(`NODE_VERSION=$(node --version)`);
	lines.push(`NODE_MAJOR="${"${NODE_VERSION#v}"}"`);
	lines.push(`NODE_MAJOR="${"${NODE_MAJOR%%.*}"}"`);
	lines.push(`echo "PLATFORM_NODE_VERSION=$NODE_VERSION"`);
	lines.push(`EXPECTED_AGENT_BROWSER_VERSION=${shellQuote(`agent-browser ${agentBrowserVersion}`)}`);
	lines.push(`AGENT_BROWSER_VERSION_OUTPUT=$(agent-browser --version 2>&1)`);
	lines.push(`AGENT_BROWSER_VERSION_COMMAND_EXIT=$?`);
	lines.push(`echo "PLATFORM_AGENT_BROWSER_VERSION=$AGENT_BROWSER_VERSION_OUTPUT"`);
	lines.push(`if [ "$AGENT_BROWSER_VERSION_COMMAND_EXIT" -eq 0 ] && [ "$AGENT_BROWSER_VERSION_OUTPUT" = "$EXPECTED_AGENT_BROWSER_VERSION" ]; then AGENT_BROWSER_READY_EXIT=0; else AGENT_BROWSER_READY_EXIT=1; fi`);
	lines.push(`echo "PLATFORM_AGENT_BROWSER_READY_EXIT=$AGENT_BROWSER_READY_EXIT"`);
	lines.push(`npm ci 2>&1`);
	lines.push(`NPM_CI_EXIT=$?`);
	lines.push(`echo "PLATFORM_NPM_CI_EXIT=$NPM_CI_EXIT"`);
	lines.push(`TSX_CLI="$SOURCE_ROOT/node_modules/.bin/tsx"`);
	lines.push(`if [ ! -x "$TSX_CLI" ]; then TSX_CLI="$(command -v tsx || true)"; fi`);
	lines.push(`echo "PLATFORM_TSX_CLI=$TSX_CLI"`);
	lines.push(`if [ "$NPM_CI_EXIT" -eq 0 ] && [ "$AGENT_BROWSER_READY_EXIT" -eq 0 ] && [ -n "$TSX_CLI" ]; then "$TSX_CLI" scripts/verify-agent-browser-dogfood.ts --artifact-dir "$DOGFOOD_ARTIFACT_DIR" --json >"$DOGFOOD_DIR/dogfood.stdout.txt" 2>"$DOGFOOD_DIR/dogfood.stderr.txt"; DOGFOOD_EXIT=$?; else echo "missing tsx, npm ci failed, or agent-browser baseline mismatch" >"$DOGFOOD_DIR/dogfood.stderr.txt"; DOGFOOD_EXIT=1; fi`);
	lines.push(`echo "PLATFORM_DOGFOOD_EXIT=$DOGFOOD_EXIT"`);
	lines.push(`echo "--- DOGFOOD_STDOUT START ---"; cat "$DOGFOOD_DIR/dogfood.stdout.txt" 2>/dev/null || true; echo "--- DOGFOOD_STDOUT END ---"`);
	lines.push(`echo "--- DOGFOOD_STDERR START ---"; cat "$DOGFOOD_DIR/dogfood.stderr.txt" 2>/dev/null || true; echo "--- DOGFOOD_STDERR END ---"`);
	lines.push(`if [ "$NPM_CI_EXIT" -ne 0 ] || [ "$AGENT_BROWSER_READY_EXIT" -ne 0 ] || [ "$DOGFOOD_EXIT" -ne 0 ]; then echo "PLATFORM_BROWSER_DOGFOOD_FAILED"; exit 1; fi`);
	lines.push(`echo "PLATFORM_BROWSER_DOGFOOD_OK"`);
	return lines.join("\n");
}

async function runBrowserDogfoodSuite(config, targetName, suiteName, leaseSession, runId = makeRunId()) {
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	const startedAt = Date.now();
	const platform = platformFor(targetName);
	const slug = `${config.packageName}-${targetName}`;
	const command = buildBrowserDogfoodCommand(targetName, config.agentBrowserVersion);
	writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify(targetEvidence(config, targetName, runId, slug), null, 2));
	writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, modelCalls: 0, realBrowser: true }, null, 2));
	writeCommand(suiteDir, command);

	let lease = leaseSession;
	const ownsLease = !lease;
	if (!lease) lease = await warmupLease(targetName, slug, config);
	if (!lease.ok) {
		writeExitCode(suiteDir, lease.code, lease.signal);
		writeFileSync(resolve(suiteDir, "crabbox.stdout.txt"), lease.stdout ?? "");
		writeFileSync(resolve(suiteDir, "crabbox.stderr.txt"), lease.stderr ?? "");
		const { assertions } = finalizeSuite(suiteDir, [{ id: "crabbox-warmup", fn: () => false, error: "Crabbox warmup failed" }], { target: targetName, suite: suiteName, elapsedMs: Date.now() - startedAt }, ["summary.json", "artifact-manifest.json", "target.json", "suite.json", "command.txt", "exit-code.txt", "crabbox.stdout.txt", "crabbox.stderr.txt", "assertions.json"]);
		return { ok: false, suiteDir, assertions };
	}

	const secretValues = collectSecretValues(authEnvAllowList(config));
	const result = await runOnLease(targetName, lease.leaseId, command, { timeout: 900_000, sync: leaseSession?.sync, config });
	const elapsedMs = Date.now() - startedAt;
	writeRedacted(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout, secretValues);
	writeRedacted(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr, secretValues);
	writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({ elapsedMs, code: result.code, signal: result.signal }, null, 2));
	writeExitCode(suiteDir, result.code, result.signal);
	const dogfoodReport = writeDogfoodExtracts(suiteDir, result.stdout, secretValues);
	let stopResult;
	if (ownsLease) {
		stopResult = await stopLease(targetName, lease.leaseId, config);
		writeRedacted(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout, secretValues);
		writeRedacted(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr, secretValues);
		writeFileSync(resolve(suiteDir, "crabbox.stop.exit-code.txt"), `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`);
	}

	const secretViolations = [
		...scanForSecrets(`${result.stdout}\n${result.stderr}`, secretValues),
		...scanArtifactTextFiles(suiteDir, secretValues).map((finding) => `${finding.file}: ${finding.violation}`),
	];
	const reportIds = new Set((dogfoodReport.reports ?? []).map((report) => report.id));
	const checks = [
		{ id: "command-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
		{ id: "browser-dogfood-marker", fn: () => result.stdout.includes("PLATFORM_BROWSER_DOGFOOD_OK") },
		{ id: "npm-ci", fn: () => /PLATFORM_NPM_CI_EXIT=0/.test(result.stdout) },
		{ id: "agent-browser-baseline", fn: () => /PLATFORM_AGENT_BROWSER_READY_EXIT=0/.test(result.stdout) },
		{ id: "agent-browser-browser-cache", fn: () => platform !== "powershell" || /PLATFORM_AGENT_BROWSER_BROWSER_CACHE_EXIT=0/.test(result.stdout) },
		{ id: "agent-browser-prewarm", fn: () => platform !== "powershell" || /PLATFORM_AGENT_BROWSER_PREWARM_EXIT=0/.test(result.stdout) },
		{ id: "dogfood-exit-zero", fn: () => /PLATFORM_DOGFOOD_EXIT=0/.test(result.stdout) },
		{ id: "dogfood-report", fn: () => Array.isArray(dogfoodReport.reports) && dogfoodReport.reports.length >= 5 },
		{ id: "dogfood-qa", fn: () => reportIds.has("qa-url") },
		{ id: "dogfood-session-close", fn: () => reportIds.has("close-session") },
		{ id: "no-secret-artifacts", fn: () => secretViolations.length === 0, error: secretViolations.join(", ") },
	];
	if (stopResult) checks.push({ id: "lease-cleanup", fn: () => stopResult.code === 0, error: `stop exit ${stopResult.code}` });
	const expectedFiles = [
		"summary.json", "artifact-manifest.json", "target.json", "suite.json", "command.txt", "exit-code.txt", "crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json",
		"node-version.txt", "dogfood-artifacts.txt", "dogfood.stdout.txt", "dogfood.stderr.txt", "dogfood-report.json", "assertions.json",
	];
	if (stopResult) expectedFiles.push("crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt");
	const { assertions } = finalizeSuite(suiteDir, checks, { target: targetName, suite: suiteName, elapsedMs, exitCode: result.code, signal: result.signal }, expectedFiles);
	return { ok: assertions.ok, suiteDir, assertions };
}

async function runPlatformBuildSuite(config, targetName, suiteName, leaseSession, runId = makeRunId()) {
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	const startedAt = Date.now();
	const platform = platformFor(targetName);
	const slug = `${config.packageName}-${targetName}`;
	const command = buildPlatformBuildCommand(targetName, config.packageName, config.nodeValidationMajor);
	mkdirSync(dirname(suiteDir), { recursive: true });
	writeFileSync(resolve(suiteDir, "target.json"), JSON.stringify(targetEvidence(config, targetName, runId, slug), null, 2));
	writeFileSync(resolve(suiteDir, "suite.json"), JSON.stringify({ suiteName, modelCalls: 0 }, null, 2));
	writeCommand(suiteDir, command);

	let lease = leaseSession;
	const ownsLease = !lease;
	if (!lease) lease = await warmupLease(targetName, slug, config);
	if (!lease.ok) {
		writeExitCode(suiteDir, lease.code, lease.signal);
		writeFileSync(resolve(suiteDir, "crabbox.stdout.txt"), lease.stdout ?? "");
		writeFileSync(resolve(suiteDir, "crabbox.stderr.txt"), lease.stderr ?? "");
		const { assertions } = finalizeSuite(suiteDir, [{ id: "crabbox-warmup", fn: () => false, error: "Crabbox warmup failed" }], { target: targetName, suite: suiteName, elapsedMs: Date.now() - startedAt }, ["summary.json", "artifact-manifest.json", "target.json", "suite.json", "command.txt", "exit-code.txt", "crabbox.stdout.txt", "crabbox.stderr.txt", "assertions.json"]);
		return { ok: false, suiteDir, assertions };
	}

	const secretValues = collectSecretValues(authEnvAllowList(config));
	const result = await runOnLease(targetName, lease.leaseId, command, { timeout: 1_500_000, sync: leaseSession?.sync, config });
	const elapsedMs = Date.now() - startedAt;
	writeRedacted(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout, secretValues);
	writeRedacted(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr, secretValues);
	writeFileSync(resolve(suiteDir, "crabbox.timing.json"), JSON.stringify({ elapsedMs, code: result.code, signal: result.signal }, null, 2));
	writeExitCode(suiteDir, result.code, result.signal);
	writePlatformExtracts(suiteDir, result.stdout, secretValues);
	let stopResult;
	if (ownsLease) {
		stopResult = await stopLease(targetName, lease.leaseId, config);
		writeRedacted(resolve(suiteDir, "crabbox.stop.stdout.txt"), stopResult.stdout, secretValues);
		writeRedacted(resolve(suiteDir, "crabbox.stop.stderr.txt"), stopResult.stderr, secretValues);
		writeFileSync(resolve(suiteDir, "crabbox.stop.exit-code.txt"), `code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`);
	}

	const stdout = result.stdout;
	const listOutput = section(stdout, "PI_LIST_STDOUT");
	const nodeMajor = Number(marker(stdout, "PLATFORM_NODE_VERSION").replace(/^v/, "").split(".")[0] ?? 0);
	const secretViolations = [
		...scanForSecrets(`${result.stdout}\n${result.stderr}`, secretValues),
		...scanArtifactTextFiles(suiteDir, secretValues).map((finding) => `${finding.file}: ${finding.violation}`),
	];
	const checks = [
		{ id: "command-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
		{ id: "platform-marker", fn: () => stdout.includes("PLATFORM_BUILD_OK") },
		{ id: "node-version", fn: () => nodeMajor >= (config.nodeValidationMajor ?? 22), error: `Node major ${nodeMajor}` },
		{ id: "npm-ci", fn: () => /PLATFORM_NPM_CI_EXIT=0/.test(stdout) },
		{ id: "npm-run-verify", fn: () => /PLATFORM_VERIFY_EXIT=0/.test(stdout) },
		{ id: "npm-pack", fn: () => /PLATFORM_NPM_PACK_EXIT=0/.test(stdout) && marker(stdout, "PLATFORM_PACKED_TARBALL").length > 0 },
		{ id: "packed-node-install", fn: () => /PLATFORM_PACKED_NODE_INSTALL_EXIT=0/.test(stdout) },
		{ id: "pi-install-local-package", fn: () => /PLATFORM_PI_INSTALL_EXIT=0/.test(stdout) },
		{ id: "pi-list-local-package", fn: () => /PLATFORM_PI_LIST_EXIT=0/.test(stdout) && new RegExp(`Project packages:[\\s\\S]*${escapeRegExp(config.packageName)}`).test(listOutput) },
		{ id: "no-source-extension-shortcut", fn: () => !/\bpi\s+(?:-e|--extension)\s+\./.test(stdout) },
		{ id: "no-secret-artifacts", fn: () => secretViolations.length === 0, error: secretViolations.join(", ") },
	];
	if (stopResult) checks.push({ id: "lease-cleanup", fn: () => stopResult.code === 0, error: `stop exit ${stopResult.code}` });
	const expectedFiles = [
		"summary.json", "artifact-manifest.json", "target.json", "suite.json", "command.txt", "exit-code.txt", "crabbox.stdout.txt", "crabbox.stderr.txt", "crabbox.timing.json",
		"node-version.txt", "packed-tarball.txt", "packed-node-install.stdout.txt", "packed-node-install.stderr.txt", "pi-install.stdout.txt", "pi-install.stderr.txt", "pi-list.stdout.txt", "pi-list.stderr.txt", "assertions.json",
	];
	if (stopResult) expectedFiles.push("crabbox.stop.stdout.txt", "crabbox.stop.stderr.txt", "crabbox.stop.exit-code.txt");
	const { assertions } = finalizeSuite(suiteDir, checks, { target: targetName, suite: suiteName, elapsedMs, exitCode: result.code, signal: result.signal }, expectedFiles);
	return { ok: assertions.ok, suiteDir, assertions };
}

export async function runTargetSuite(config, targetName, suiteName, leaseSession, runId) {
	if (suiteName === "platform-build") return await runPlatformBuildSuite(config, targetName, suiteName, leaseSession, runId);
	if (suiteName === "browser-dogfood-smoke") return await runBrowserDogfoodSuite(config, targetName, suiteName, leaseSession, runId);
	throw new Error(`unknown suite: ${suiteName}`);
}

export async function runTargetSuites(config, targetName, suiteNames) {
	const slug = `${config.packageName}-${targetName}`;
	const runId = makeRunId();
	const lease = await warmupLease(targetName, slug, config);
	if (!lease.ok) {
		const warmupFailure = createLeaseWarmupFailureResult(config, targetName, lease, runId);
		return { ok: false, results: [warmupFailure] };
	}
	const results = [];
	let stopResult;
	let staleCleanupResult;
	try {
		let sync = true;
		for (const suiteName of suiteNames) {
			const result = await runTargetSuite(config, targetName, suiteName, { ...lease, sync }, runId);
			results.push(result);
			sync = false;
			if (!result.ok) break;
		}
	} finally {
		stopResult = await stopLease(targetName, lease.leaseId, config);
		staleCleanupResult = await cleanupStaleTargetState(targetName, config);
	}
	if (stopResult) {
		results.push(createLeaseCleanupResult(config, targetName, lease.leaseId, stopResult, staleCleanupResult, runId));
	}
	return { ok: results.every((result) => result.ok), results };
}
