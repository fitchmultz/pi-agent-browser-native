/** Ordered native target/suite runner with shared lease and evidence ownership. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSuiteDir, writeCommand, writeExitCode } from "./artifacts.mjs";
import { cleanupStaleTargetState, runOnLease, stopLease, warmupLease } from "./crabbox-runner.mjs";
import { buildBrowserDogfoodCommand, buildPlatformBuildCommand } from "./commands.mjs";
import { createLeaseCleanupResult, createLeaseWarmupFailureResult } from "./lease-evidence.mjs";
import { browserDogfoodChecks, commonChecks, platformBuildChecks } from "./suite-checks.mjs";
import {
	COMMON_EVIDENCE_FILES,
	STOP_EVIDENCE_FILES,
	finalizeSuite,
	makeRunId,
	secretValuesFor,
	secretViolationsFor,
	writeDogfoodExtracts,
	writePlatformExtracts,
	writeProcessReceipt,
	writeRunReceipt,
	writeTargetEvidence,
} from "./suite-evidence.mjs";

export { buildBrowserDogfoodCommand, buildPlatformBuildCommand } from "./commands.mjs";
export { createLeaseCleanupResult, createLeaseWarmupFailureResult } from "./lease-evidence.mjs";
export { nodeVersionAtLeast } from "./suite-checks.mjs";
export { platformFor } from "./suite-evidence.mjs";

/** @import { PlatformSmokeConfig } from "../../platform-smoke.config.mjs" */
/** @import { ProcessResult } from "./crabbox-runner.mjs" */
/** @import { ReleaseCandidate } from "./commands.mjs" */
/** @import { SuiteCheck } from "./suite-evidence.mjs" */
/** @typedef {Readonly<Awaited<ReturnType<typeof warmupLease>>> & {readonly dependenciesReady?: boolean; readonly sync?: boolean; readonly candidate?: ReleaseCandidate | undefined}} LeaseSession */
/** @typedef {{readonly config: PlatformSmokeConfig; readonly targetName: string; readonly suiteName: string; readonly leaseSession?: LeaseSession | undefined; readonly runId?: string}} SuiteOptions */
/** @typedef {{readonly command: string; readonly timeout: number; readonly metadata: Readonly<Record<string, unknown>>; readonly evidenceFiles: readonly string[]; readonly extract: (suiteDir: string, result: ProcessResult, secretValues: readonly string[]) => unknown; readonly checks: (result: ProcessResult, report: unknown) => SuiteCheck[]}} SuiteDefinition */

/** @param {SuiteOptions} options
 * @returns {SuiteDefinition}
 */
function suiteDefinition({ config, targetName, suiteName, leaseSession }) {
	if (suiteName === "platform-build") {
		return {
			command: buildPlatformBuildCommand(
				targetName,
				config.packageName,
				config.nodeValidationVersion,
				leaseSession?.candidate,
			),
			timeout: 1_500_000,
			metadata: { suiteName, modelCalls: 0 },
			evidenceFiles: [
				"node-version.txt",
				"packed-tarball.txt",
				"packed-node-install.stdout.txt",
				"packed-node-install.stderr.txt",
				"pi-install.stdout.txt",
				"pi-install.stderr.txt",
				"pi-list.stdout.txt",
				"pi-list.stderr.txt",
			],
			extract: (suiteDir, result, secretValues) => {
				writePlatformExtracts(suiteDir, result.stdout, secretValues);
			},
			checks: (result) => platformBuildChecks(config, result, leaseSession?.candidate),
		};
	}
	if (suiteName === "browser-dogfood-smoke") {
		return {
			command: buildBrowserDogfoodCommand(
				targetName,
				config.agentBrowserVersion,
				leaseSession?.dependenciesReady === true,
			),
			timeout: 900_000,
			metadata: { suiteName, modelCalls: 0, realBrowser: true },
			evidenceFiles: [
				"node-version.txt",
				"dogfood-artifacts.txt",
				"dogfood.stdout.txt",
				"dogfood.stderr.txt",
				"dogfood-report.json",
			],
			extract: (suiteDir, result, secretValues) =>
				writeDogfoodExtracts(suiteDir, result.stdout, secretValues),
			checks: (result, report) => browserDogfoodChecks(targetName, result, report),
		};
	}
	throw new Error(`unknown suite: ${suiteName}`);
}

/** @param {string} suiteDir
 * @param {LeaseSession} lease
 * @param {Readonly<Record<string, unknown>>} summary
 */
function warmupFailure(suiteDir, lease, summary) {
	writeExitCode(suiteDir, lease.code, lease.signal);
	writeFileSync(resolve(suiteDir, "crabbox.stdout.txt"), lease.stdout);
	writeFileSync(resolve(suiteDir, "crabbox.stderr.txt"), lease.stderr);
	const { assertions } = finalizeSuite(
		suiteDir,
		[{ id: "crabbox-warmup", fn: () => false, error: "Crabbox warmup failed" }],
		summary,
		COMMON_EVIDENCE_FILES,
	);
	return { ok: false, suiteDir, assertions };
}

/** @param {SuiteOptions} options */
export async function runTargetSuite({
	config,
	targetName,
	suiteName,
	leaseSession,
	runId = makeRunId(),
}) {
	const definition = suiteDefinition({ config, targetName, suiteName, leaseSession });
	const suiteDir = createSuiteDir(config.artifactRoot, runId, targetName, suiteName);
	const startedAt = Date.now();
	const slug = `${config.packageName}-${targetName}`;
	writeTargetEvidence(suiteDir, { config, targetName, runId, slug }, definition.metadata);
	writeCommand(suiteDir, definition.command);
	const lease = leaseSession ?? (await warmupLease(targetName, slug, config));
	if (!lease.ok) {
		return warmupFailure(suiteDir, lease, {
			target: targetName,
			suite: suiteName,
			elapsedMs: Date.now() - startedAt,
		});
	}
	const secretValues = secretValuesFor(config);
	const result = await runOnLease(targetName, lease.leaseId, definition.command, {
		timeout: definition.timeout,
		sync: leaseSession?.sync,
		config,
	});
	const elapsedMs = Date.now() - startedAt;
	writeRunReceipt(suiteDir, result, elapsedMs, secretValues);
	const report = definition.extract(suiteDir, result, secretValues);
	let stopResult;
	if (!leaseSession) {
		stopResult = await stopLease(targetName, lease.leaseId, config);
		writeProcessReceipt(suiteDir, "crabbox.stop", stopResult, secretValues);
	}
	const checks = commonChecks(
		result,
		secretViolationsFor(suiteDir, result, secretValues),
		stopResult,
	);
	const expectedFiles = [
		...COMMON_EVIDENCE_FILES.filter((file) => file !== "assertions.json"),
		"crabbox.timing.json",
		...definition.evidenceFiles,
		"assertions.json",
		...(stopResult ? STOP_EVIDENCE_FILES : []),
	];
	const { assertions } = finalizeSuite(
		suiteDir,
		[checks[0], ...definition.checks(result, report), ...checks.slice(1)],
		{
			target: targetName,
			suite: suiteName,
			elapsedMs,
			exitCode: result.code,
			signal: result.signal,
		},
		expectedFiles,
	);
	return { ok: assertions.ok, suiteDir, assertions };
}

/** @param {PlatformSmokeConfig} config
 * @param {string} targetName
 * @param {readonly string[]} suiteNames
 * @param {ReleaseCandidate} [candidate]
 */
export async function runTargetSuites(config, targetName, suiteNames, candidate) {
	const slug = `${config.packageName}-${targetName}`;
	const runId = makeRunId();
	const lease = await warmupLease(targetName, slug, config);
	if (!lease.ok) {
		const warmupFailureResult = createLeaseWarmupFailureResult(config, targetName, lease, runId);
		return { ok: false, results: [warmupFailureResult] };
	}
	const results = [];
	let stopResult;
	let staleCleanupResult;
	try {
		let sync = true;
		let dependenciesReady = false;
		for (const suiteName of suiteNames) {
			console.log(`  Suite: ${suiteName}`);
			// Suites share one native lease; build results determine dependency reuse and later sync policy.
			const result = await runTargetSuite({
				config,
				targetName,
				suiteName,
				leaseSession: { ...lease, dependenciesReady, sync, candidate },
				runId,
			});
			results.push(result);
			console.log(`  ${result.ok ? "PASS" : "FAIL"} ${suiteName} on ${targetName}`);
			sync = false;
			if (result.ok && suiteName === "platform-build") {
				dependenciesReady = true;
			}
			if (!result.ok) {
				break;
			}
		}
	} finally {
		stopResult = await stopLease(targetName, lease.leaseId, config);
		staleCleanupResult = await cleanupStaleTargetState(targetName, config);
	}
	results.push(
		createLeaseCleanupResult({
			config,
			targetName,
			leaseId: lease.leaseId,
			stopResult,
			staleCleanupResult,
			runId,
		}),
	);
	return { ok: results.every((result) => result.ok), results };
}
