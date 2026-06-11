/**
 * Purpose: Verify the release/package gate helpers that protect the published tarball contract.
 * Responsibilities: Assert CLI option parsing, failure aggregation, publish-contract derivation, and required/forbidden package invariants for the verify-package maintainer script.
 * Scope: Focused unit coverage for `scripts/verify-package.mjs` helper behavior only; full package verification still runs through `npm run verify -- package` and `npm run verify -- release`.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: The retired `.pi/extensions/agent-browser.ts` autoload shim must stay forbidden, and required packed files must be derived from the canonical publish contract rather than duplicated in tests.
 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifyPackageModulePath = "../scripts/verify-package.mjs";

interface PublishContract {
	declaredPackageFiles: string[];
	forbiddenPackedFiles: string[];
	forbiddenRepoFiles: string[];
	requiredPackedFiles: string[];
	requiredRepoFiles: string[];
}

const verifyPackageModule = (await import(verifyPackageModulePath)) as {
	FORBIDDEN_PACKED_FILES: string[];
	FORBIDDEN_REPO_FILES: string[];
	collectPackedMarkdownLinkFailures: (options: { cwd?: string; packedPaths: Set<string> }) => Promise<string[]>;
	loadPublishContract: (options?: { cwd?: string }) => Promise<PublishContract>;
	packToTemporaryPackageDir: (cwd?: string) => Promise<{
		cleanup: () => Promise<void>;
		packageDir: string;
		packResult: { filename: string };
	}>;
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
		publishContract: Pick<PublishContract, "forbiddenPackedFiles" | "requiredPackedFiles">;
	}) => {
		failures: string[];
		forbiddenPackedFiles: string[];
		missingPackedFiles: string[];
	};
	evaluatePiSmokeResult: (options: {
		packageDir: string;
		tools: Array<{ name: string; path?: string; source?: { path?: string }; sourceInfo?: { path?: string } }>;
	}) => string[];
	executePackagedAgentBrowserSmoke: (options: {
		packageDir: string;
		session: {
			createReplacedSessionContext?: () => unknown;
			getToolDefinition?: (name: string) =>
				| {
						execute: (
							toolCallId: string,
							params: { args: string[] },
							signal: AbortSignal | undefined,
							onUpdate: ((update: unknown) => void) | undefined,
							ctx: unknown,
						) => Promise<unknown>;
				  }
				| undefined;
		};
	}) => Promise<{ failures: string[]; invocation?: unknown }>;
	parseCliArgs: (argv?: string[]) => { listFiles: boolean; showHelp: boolean; smokePi: boolean };
};
const {
	FORBIDDEN_PACKED_FILES,
	FORBIDDEN_REPO_FILES,
	collectPackedMarkdownLinkFailures,
	collectVerificationFailures,
	evaluatePackResult,
	evaluatePiSmokeResult,
	executePackagedAgentBrowserSmoke,
	loadPublishContract,
	packToTemporaryPackageDir,
	parseCliArgs,
} = verifyPackageModule;

test("parseCliArgs supports help, list-files, and smoke-pi modes", () => {
	assert.deepEqual(parseCliArgs([]), { listFiles: false, showHelp: false, smokePi: false });
	assert.deepEqual(parseCliArgs(["--list-files"]), { listFiles: true, showHelp: false, smokePi: false });
	assert.deepEqual(parseCliArgs(["--smoke-pi"]), { listFiles: false, showHelp: false, smokePi: true });
	assert.deepEqual(parseCliArgs(["--list-files", "--smoke-pi"]), {
		listFiles: true,
		showHelp: false,
		smokePi: true,
	});
	assert.deepEqual(parseCliArgs(["--help"]), { listFiles: false, showHelp: true, smokePi: false });
	assert.deepEqual(parseCliArgs(["-h"]), { listFiles: false, showHelp: true, smokePi: false });
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

test("evaluatePiSmokeResult requires exactly one packaged agent_browser source and allows optional companion tools", () => {
	assert.deepEqual(
		evaluatePiSmokeResult({
			packageDir: "/tmp/pkg/package",
			tools: [
				{
					name: "agent_browser",
					sourceInfo: { path: "/tmp/pkg/package/extensions/agent-browser/index.ts" },
				},
				{
					name: "agent_browser_web_search",
					sourceInfo: { path: "/tmp/pkg/package/extensions/agent-browser/index.ts" },
				},
			],
		}),
		[],
	);

	assert.match(
		evaluatePiSmokeResult({
			packageDir: "/tmp/pkg/package",
			tools: [],
		})[0] ?? "",
		/Expected exactly one/,
	);
	assert.match(
		evaluatePiSmokeResult({
			packageDir: "/tmp/pkg/package",
			tools: [{ name: "agent_browser", sourceInfo: { path: "/repo/extensions/agent-browser/index.ts" } }],
		})[0] ?? "",
		/expected a source inside packed package/,
	);
	assert.match(
		evaluatePiSmokeResult({
			packageDir: "/tmp/pkg/package",
			tools: [{ name: "agent_browser" }],
		})[0] ?? "",
		/source path metadata/,
	);
});

test("executePackagedAgentBrowserSmoke invokes the packaged agent_browser tool with deterministic version args", async () => {
	const calls: Array<{ ctx: unknown; params: { args: string[] }; toolCallId: string }> = [];
	const context = { cwd: "/tmp/pkg/package" };
	const report = await executePackagedAgentBrowserSmoke({
		packageDir: "/tmp/pkg/package",
		session: {
			createReplacedSessionContext: () => context,
			getToolDefinition: (name: string) =>
				name === "agent_browser"
					? {
							execute: async (toolCallId, params, _signal, onUpdate, ctx) => {
								onUpdate?.({ content: [{ type: "text", text: "Running agent-browser --version" }] });
								calls.push({ ctx, params, toolCallId });
								return {
									content: [{ type: "text", text: "agent-browser 0.0.0-packaged-smoke" }],
									details: {
										exitCode: 0,
										inspection: true,
										stdout: "agent-browser 0.0.0-packaged-smoke",
									},
									isError: false,
								};
							},
						}
					: undefined,
		},
	});

	assert.deepEqual(report.failures, []);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.toolCallId, "verify-package-agent-browser-smoke");
	assert.deepEqual(calls[0]?.params, { args: ["--version"] });
	assert.equal(calls[0]?.ctx, context);
});

test("executePackagedAgentBrowserSmoke reports a non-executable packaged tool definition", async () => {
	const report = await executePackagedAgentBrowserSmoke({
		packageDir: "/tmp/pkg/package",
		session: { getToolDefinition: () => undefined },
	});

	assert.match(report.failures[0] ?? "", /not executable/);
});

test("executePackagedAgentBrowserSmoke reports packaged invocation failures clearly", async () => {
	const report = await executePackagedAgentBrowserSmoke({
		packageDir: "/tmp/pkg/package",
		session: {
			getToolDefinition: () => ({
				execute: async () => ({
					content: [{ type: "text", text: "boom from fake binary" }],
					details: { exitCode: 64, inspection: true, stderr: "boom" },
					isError: true,
				}),
			}),
		},
	});

	const failures = report.failures.join("\n");
	assert.match(failures, /Packaged agent_browser invocation failed/);
	assert.match(failures, /--version/);
	assert.match(failures, /boom/);
});

test("package metadata keeps Pi core packages host-provided peers", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { peerDependencies?: Record<string, string> };

	for (const packageName of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(packageJson.peerDependencies?.[packageName], "*", `${packageName} should stay host-provided per Pi package docs`);
	}
});

test("publish contract derives required packed files from package.json", async () => {
	const publishContract = await loadPublishContract();

	assert.equal(FORBIDDEN_REPO_FILES.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(FORBIDDEN_PACKED_FILES.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(FORBIDDEN_PACKED_FILES.includes("docs/archive/v1-tool-contract.md"), true);
	assert.equal(publishContract.forbiddenRepoFiles.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(publishContract.forbiddenPackedFiles.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(publishContract.forbiddenPackedFiles.includes("docs/archive/v1-tool-contract.md"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("package.json"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("scripts/doctor.mjs"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("scripts/agent-browser-capability-baseline.mjs"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("docs/COMMAND_REFERENCE.md"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("extensions/agent-browser/index.ts"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("extensions/agent-browser/lib/parsing.ts"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("extensions/agent-browser/lib/playbook.ts"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("extensions/agent-browser/lib/results/snapshot.ts"), true);
});

test("loadPublishContract reports missing package.json files entries clearly", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "publish-contract-test-"));
	try {
		await writeFile(join(tempDir, "package.json"), JSON.stringify({ files: ["missing.md"] }), "utf8");
		await assert.rejects(() => loadPublishContract({ cwd: tempDir }), /package\.json files entry "missing\.md" does not exist/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("collectPackedMarkdownLinkFailures reports local links absent from the packed tarball", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "packed-doc-links-test-"));
	try {
		await writeFile(join(tempDir, "README.md"), "[ok](docs/TOOL_CONTRACT.md) [missing](docs/support-notes.md) [anchor](#usage) [external](https://example.com)\n", "utf8");
		await writeFile(join(tempDir, "CHANGELOG.md"), "[root](README.md)\n", "utf8");
		await mkdir(join(tempDir, "docs"));
		await writeFile(join(tempDir, "docs", "TOOL_CONTRACT.md"), "# Contract\n", "utf8");

		const failures = await collectPackedMarkdownLinkFailures({
			cwd: tempDir,
			packedPaths: new Set(["README.md", "CHANGELOG.md", "docs/TOOL_CONTRACT.md"]),
		});

		assert.deepEqual(failures, [
			"Packed Markdown link README.md -> docs/support-notes.md resolves to missing packed file docs/support-notes.md.",
		]);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("evaluatePackResult uses the shared publish contract", async () => {
	const publishContract = await loadPublishContract();
	const report = evaluatePackResult({
		forbiddenRepoFiles: [],
		missingRepoFiles: [],
		packResult: {
			entryCount: publishContract.requiredPackedFiles.length,
			filename: "pi-agent-browser-native-0.2.12.tgz",
			files: publishContract.requiredPackedFiles.map((path) => ({ path })),
			size: 123,
			unpackedSize: 456,
		},
		publishContract,
	});

	assert.deepEqual(report.failures, []);
	assert.deepEqual(report.missingPackedFiles, []);
	assert.deepEqual(report.forbiddenPackedFiles, []);
});

test("packToTemporaryPackageDir writes a tarball even under npm publish dry-run env", async () => {
	const previousDryRun = process.env.npm_config_dry_run;
	process.env.npm_config_dry_run = "true";
	let packed: Awaited<ReturnType<typeof packToTemporaryPackageDir>> | undefined;

	try {
		packed = await packToTemporaryPackageDir();
		await access(join(packed.packageDir, "package.json"));
		assert.match(packed.packResult.filename, /^pi-agent-browser-native-.*\.tgz$/);
	} finally {
		if (previousDryRun === undefined) {
			delete process.env.npm_config_dry_run;
		} else {
			process.env.npm_config_dry_run = previousDryRun;
		}
		await packed?.cleanup();
	}
});
