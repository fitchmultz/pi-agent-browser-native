/**
 * Purpose: Verify the release/package gate helpers that protect the published tarball contract.
 * Responsibilities: Assert CLI option parsing, failure aggregation, and required/forbidden package invariants for the verify-package maintainer script.
 * Scope: Focused unit coverage for `scripts/verify-package.mjs` helper behavior only; full package verification still runs through `npm run verify:package` and `npm run verify:release`.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: The retired `.pi/extensions/agent-browser.ts` autoload shim must stay forbidden, and the split result-rendering source files must remain required in the published package.
 */

import assert from "node:assert/strict";
import test from "node:test";

const verifyPackageModulePath = "../scripts/verify-package.mjs";
const verifyPackageModule = (await import(verifyPackageModulePath)) as {
	FORBIDDEN_PACKED_FILES: string[];
	FORBIDDEN_REPO_FILES: string[];
	REQUIRED_PACKED_FILES: string[];
	collectVerificationFailures: (options: {
		forbiddenPackedFiles: string[];
		forbiddenRepoFiles: string[];
		missingPackedFiles: string[];
		missingRepoFiles: string[];
	}) => string[];
	evaluatePackResult: (options: {
		forbiddenRepoFiles: string[];
		missingRepoFiles: string[];
		packResult: {
			entryCount: number;
			filename: string;
			files: Array<{ path: string }>;
			size: number;
			unpackedSize: number;
		};
	}) => {
		failures: string[];
		forbiddenPackedFiles: string[];
		missingPackedFiles: string[];
	};
	parseCliArgs: (argv?: string[]) => { listFiles: boolean; showHelp: boolean };
};
const {
	FORBIDDEN_PACKED_FILES,
	FORBIDDEN_REPO_FILES,
	REQUIRED_PACKED_FILES,
	collectVerificationFailures,
	evaluatePackResult,
	parseCliArgs,
} = verifyPackageModule;

test("parseCliArgs supports help and list-files modes", () => {
	assert.deepEqual(parseCliArgs([]), { listFiles: false, showHelp: false });
	assert.deepEqual(parseCliArgs(["--list-files"]), { listFiles: true, showHelp: false });
	assert.deepEqual(parseCliArgs(["--help"]), { listFiles: false, showHelp: true });
	assert.deepEqual(parseCliArgs(["-h"]), { listFiles: false, showHelp: true });
});

test("parseCliArgs rejects unknown options with a usage error", () => {
	assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
});

test("collectVerificationFailures reports each repo and packed invariant breach", () => {
	const failures = collectVerificationFailures({
		forbiddenPackedFiles: ["AGENTS.md"],
		forbiddenRepoFiles: [".pi/extensions/agent-browser.ts"],
		missingPackedFiles: ["extensions/agent-browser/lib/results/snapshot.ts"],
		missingRepoFiles: ["LICENSE"],
	});

	assert.equal(failures.length, 4);
	assert.match(failures[0] ?? "", /Missing required repo file/);
	assert.match(failures[1] ?? "", /Forbidden repo file present/);
	assert.match(failures[2] ?? "", /Missing required packed file/);
	assert.match(failures[3] ?? "", /Forbidden packed file present/);
});

test("evaluatePackResult preserves the retired autoload-shim ban and split-result module requirements", () => {
	assert.equal(FORBIDDEN_REPO_FILES.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(FORBIDDEN_PACKED_FILES.includes(".pi/extensions/agent-browser.ts"), true);
	for (const requiredPath of [
		"extensions/agent-browser/lib/results.ts",
		"extensions/agent-browser/lib/results/envelope.ts",
		"extensions/agent-browser/lib/results/presentation.ts",
		"extensions/agent-browser/lib/results/shared.ts",
		"extensions/agent-browser/lib/results/snapshot.ts",
	] as const) {
		assert.equal(REQUIRED_PACKED_FILES.includes(requiredPath), true);
	}

	const report = evaluatePackResult({
		forbiddenRepoFiles: [],
		missingRepoFiles: [],
		packResult: {
			entryCount: REQUIRED_PACKED_FILES.length,
			filename: "pi-agent-browser-native-0.1.5.tgz",
			files: REQUIRED_PACKED_FILES.map((path: string) => ({ path })),
			size: 123,
			unpackedSize: 456,
		},
	});

	assert.deepEqual(report.failures, []);
	assert.deepEqual(report.missingPackedFiles, []);
	assert.deepEqual(report.forbiddenPackedFiles, []);
});
