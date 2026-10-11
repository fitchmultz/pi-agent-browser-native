/**
 * Purpose: Verify the release/package gate helpers that protect the published tarball contract.
 * Responsibilities: Assert CLI option parsing, failure aggregation, publish-contract derivation, and required/forbidden package invariants for the verify-package maintainer script.
 * Scope: Focused unit coverage for `scripts/verify-package.mjs` helper behavior only; full package verification still runs through `npm run verify -- package` and `npm run verify -- release`.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: The retired `.pi/extensions/agent-browser.ts` autoload shim must stay forbidden, and required packed files must be derived from the canonical publish contract rather than duplicated in tests.
 */

import assert from "node:assert/strict";
import { readRecord, readString } from "./helpers/assertions.js";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";

// Native execFile returns ChildProcess and supplies custom promisify; the ambient callback expects void.
// oxlint-disable-next-line typescript/strict-void-return
const execFile = promisify(execFileCallback);
import {
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
	verifyPackageRelease,
} from "../scripts/verify-package.mjs";

before(async () => {
	await execFile(process.execPath, ["scripts/build.mjs"], { maxBuffer: 10 * 1024 * 1024 });
});

test("parseCliArgs supports help, list-files, and smoke-pi modes", () => {
	assert.deepEqual(parseCliArgs([]), { listFiles: false, showHelp: false, smokePi: false });
	assert.deepEqual(parseCliArgs(["--list-files"]), {
		listFiles: true,
		showHelp: false,
		smokePi: false,
	});
	assert.deepEqual(parseCliArgs(["--smoke-pi"]), {
		listFiles: false,
		showHelp: false,
		smokePi: true,
	});
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
					sourceInfo: { path: "/tmp/pkg/package/dist/extensions/agent-browser/index.js" },
				},
				{
					name: "agent_browser_web_search",
					sourceInfo: { path: "/tmp/pkg/package/dist/extensions/agent-browser/index.js" },
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
			tools: [
				{ name: "agent_browser", sourceInfo: { path: "/repo/extensions/agent-browser/index.ts" } },
			],
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
	const calls: Array<{
		ctx: unknown;
		params: Readonly<{ args: readonly string[] }>;
		toolCallId: string;
	}> = [];
	const context = { cwd: "/tmp/pkg/package" };
	const report = await executePackagedAgentBrowserSmoke({
		packageDir: "/tmp/pkg/package",
		session: {
			createReplacedSessionContext: () => context,
			getToolDefinition: (name: string) =>
				name === "agent_browser"
					? {
							execute: async (
								toolCallId: string,
								params: Readonly<{ args: readonly string[] }>,
								_signal: AbortSignal | undefined,
								onUpdate: ((update: unknown) => void) | undefined,
								ctx: unknown,
							) => {
								onUpdate?.({
									content: [{ type: "text", text: "Running agent-browser --version" }],
								});
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

test("package metadata keeps Pi peers host-provided and declares the qualified runtime graph", async () => {
	const packageJson = readRecord(JSON.parse(await readFile("package.json", "utf8")));

	assert.equal(
		readRecord(packageJson.dependencies)["cross-spawn"],
		"7.0.6",
		"the spawner must not rely on Pi's private transitive dependencies",
	);
	assert.equal(
		readRecord(packageJson.dependencies)["path-key"],
		"3.1.1",
		"launcher PATH selection must match cross-spawn 7",
	);
	assert.equal(
		readRecord(packageJson.dependencies).which,
		"2.0.2",
		"launcher resolution must match cross-spawn 7",
	);
	assert.equal(readRecord(packageJson.engines).node, ">=24.21.0");
	assert.equal(packageJson.packageManager, "npm@12.2.0");
	assert.equal(
		packageJson.overrides,
		undefined,
		"transitive owners should select their compatible dependency versions",
	);
	for (const packageName of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	]) {
		// All four literal Pi peer names are checked; no peer-dependent branch skips a row.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			readRecord(packageJson.peerDependencies)[packageName],
			"*",
			`${packageName} should stay host-provided per Pi package docs`,
		);
	}
	assert.equal(
		readRecord(packageJson.scripts).prepare,
		"node ./scripts/prepare.mjs",
		"Packed and GitHub/source installs must build the ignored dist entrypoint before Pi loads it, even when Pi installs with --omit=dev",
	);
	assert.equal(
		readRecord(packageJson.scripts).prepack,
		undefined,
		"npm pack must not duplicate the prepare-owned build",
	);
});

test("publish contract derives required packed files from package.json", async () => {
	const publishContract = await loadPublishContract();

	assert.equal(FORBIDDEN_REPO_FILES.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(FORBIDDEN_PACKED_FILES.includes(".pi/extensions/agent-browser.ts"), true);
	assert.equal(FORBIDDEN_PACKED_FILES.includes("docs/plans/"), true);
	assert.equal(FORBIDDEN_PACKED_FILES.includes("extensions/agent-browser/index.ts"), true);
	assert.equal(
		publishContract.forbiddenRepoFiles.includes(".pi/extensions/agent-browser.ts"),
		true,
	);
	assert.equal(
		publishContract.forbiddenPackedFiles.includes(".pi/extensions/agent-browser.ts"),
		true,
	);
	assert.equal(publishContract.requiredPackedFiles.includes("package.json"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("scripts/doctor.mjs"), true);
	assert.equal(publishContract.requiredPackedFiles.includes("scripts/prepare.mjs"), true);
	assert.equal(
		publishContract.requiredPackedFiles.includes("scripts/agent-browser-capability-baseline.mjs"),
		true,
	);
	assert.equal(publishContract.requiredPackedFiles.includes("docs/COMMAND_REFERENCE.md"), true);
	assert.equal(
		publishContract.requiredPackedFiles.includes("dist/extensions/agent-browser/index.js"),
		true,
	);
	assert.equal(
		publishContract.requiredPackedFiles.includes("dist/extensions/agent-browser/script-worker.js"),
		true,
	);
	assert.equal(
		publishContract.requiredPackedFiles.includes("dist/extensions/agent-browser/lib/parsing.js"),
		true,
	);
	assert.equal(
		publishContract.requiredPackedFiles.includes("dist/extensions/agent-browser/lib/playbook.js"),
		true,
	);
	assert.equal(
		publishContract.requiredPackedFiles.includes(
			"dist/extensions/agent-browser/lib/results/snapshot.js",
		),
		true,
	);
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
		// Every literal platform publish path is required by this nonempty contract table.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(
			publishContract.requiredPackedFiles.includes(path),
			`expected publish contract to require ${path}`,
		);
	}
	assert.equal(
		publishContract.requiredPackedFiles.includes("extensions/agent-browser/index.ts"),
		false,
	);
});

test("loadPublishContract reports missing package.json files entries clearly", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "publish-contract-test-"));
	try {
		await writeFile(
			join(tempDir, "package.json"),
			JSON.stringify({ files: ["missing.md"] }),
			"utf8",
		);
		await assert.rejects(
			() => loadPublishContract({ cwd: tempDir }),
			/package\.json files entry "missing\.md" does not exist/,
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("collectPackedMarkdownLinkFailures reports local links absent from the packed tarball", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "packed-doc-links-test-"));
	try {
		await writeFile(
			join(tempDir, "README.md"),
			"[ok](docs/TOOL_CONTRACT.md) [missing](docs/support-notes.md) [anchor](#usage) [external](https://example.com)\n" +
				"![art](.github/readme/flow.png) ![missing art](.github/readme/missing.png) " +
				"[ordinary link](.github/readme/flow.png) ![other image](docs/missing.png)\n",
			"utf8",
		);
		await writeFile(join(tempDir, "CHANGELOG.md"), "[root](README.md)\n", "utf8");
		await mkdir(join(tempDir, "docs"));
		await writeFile(join(tempDir, "docs", "TOOL_CONTRACT.md"), "# Contract\n", "utf8");
		await mkdir(join(tempDir, ".github", "readme"), { recursive: true });
		await writeFile(join(tempDir, ".github", "readme", "flow.png"), "repo-only artwork", "utf8");

		const failures = await collectPackedMarkdownLinkFailures({
			cwd: tempDir,
			packedPaths: new Set(["README.md", "CHANGELOG.md", "docs/TOOL_CONTRACT.md"]),
		});

		assert.deepEqual(failures, [
			"Packed Markdown link README.md -> docs/support-notes.md resolves to missing packed file docs/support-notes.md.",
			"Packed Markdown link README.md -> .github/readme/flow.png resolves to missing packed file .github/readme/flow.png.",
			"Packed Markdown link README.md -> docs/missing.png resolves to missing packed file docs/missing.png.",
			"README artwork is missing from the repository: .github/readme/missing.png.",
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

test("evaluatePackResult rejects private paths and tarballs without rejecting neighboring names", async () => {
	const publishContract = await loadPublishContract();
	for (const [path, forbidden] of [
		["docs/plans/internal.md", ["docs/plans/"]],
		["docs/plans/.secret.md", ["docs/plans/"]],
		["AGENTS.md", ["AGENTS.md"]],
		[".artifacts/nested/report.json", [".artifacts/"]],
		[".artifacts/.hidden/foo", [".artifacts/"]],
		[".crabbox/lease.json", [".crabbox/"]],
		[".crabbox/.lease", [".crabbox/"]],
		[".debug/log.txt", [".debug/"]],
		[".github/readme/flow.png", [".github/readme/"]],
		[".debug/.hidden/log.txt", [".debug/"]],
		[".platform-smoke-runs/report.json", [".platform-smoke-runs/"]],
		[".platform-smoke-runs/.receipt", [".platform-smoke-runs/"]],
		[".env", [".env*"]],
		[".env.local", [".env*"]],
		[".env-fixture/private.txt", [".env*"]],
		[".env-dir/.secret", [".env*"]],
		["package.tgz", ["**/*.tgz"]],
		["nested/package.tgz", ["**/*.tgz"]],
		[".tgz", ["**/*.tgz"]],
		[".hidden.tgz", ["**/*.tgz"]],
		["nested/.hidden.tgz", ["**/*.tgz"]],
		["nested/.hidden/file.tgz", ["**/*.tgz"]],
		["docs/plans-public.md", []],
		["docs/AGENTS.md", []],
		[".artifacts-public.json", []],
		["docs/env.md", []],
		["archive.tgz.md", []],
	] as const) {
		const report = evaluatePackResult({
			forbiddenRepoFiles: [],
			missingRepoFiles: [],
			packResult: {
				entryCount: 2,
				filename: "fixture.tgz",
				files: [{ path: "package.json" }, { path }],
				size: 123,
				unpackedSize: 456,
			},
			publishContract: {
				forbiddenPackedFiles: publishContract.forbiddenPackedFiles,
				requiredPackedFiles: ["package.json"],
			},
		});
		// Each literal allowed/forbidden path row checks both classification and failures.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(report.forbiddenPackedFiles, [...forbidden], path);
		// Each literal allowed/forbidden path row checks both classification and failures.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(
			report.failures,
			forbidden.length > 0 ? [`Forbidden packed file present: ${forbidden.join(", ")}`] : [],
			path,
		);
	}
});

test("verifyPackageRelease lets prepare create a missing dist directory", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-build-owner-"));
	try {
		await writeFile(join(tempDir, "LICENSE"), "fixture\n", "utf8");
		await writeFile(
			join(tempDir, "build.mjs"),
			'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/index.js", "export {};\\n");\n',
			"utf8",
		);
		await writeFile(
			join(tempDir, "package.json"),
			`${JSON.stringify({ name: "pi-agent-browser-package-build-owner-fixture", version: "1.0.0", type: "module", files: ["dist"], scripts: { prepare: "node build.mjs" } }, null, 2)}\n`,
			"utf8",
		);

		await assert.rejects(access(join(tempDir, "dist")));
		const report = await verifyPackageRelease({ cwd: tempDir });
		assert.deepEqual(report.failures, []);
		await access(join(tempDir, "dist", "index.js"));
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("packToTemporaryPackageDir writes a tarball even under npm publish dry-run env", async () => {
	const previousDryRun = process.env.npm_config_dry_run;
	process.env.npm_config_dry_run = "true";
	let packed: Awaited<ReturnType<typeof packToTemporaryPackageDir>> | undefined;

	try {
		packed = await packToTemporaryPackageDir();
		await access(join(packed.packageDir, "package.json"));
		assert.match(
			readString(readRecord(packed.packResult).filename),
			/^pi-agent-browser-native-.*\.tgz$/,
		);
		const report = evaluatePackResult({
			forbiddenRepoFiles: [],
			missingRepoFiles: [],
			packResult: readRecord(packed.packResult),
			publishContract: await loadPublishContract(),
		});
		assert.deepEqual(
			report.failures,
			[],
			"real tarball must satisfy the canonical required and forbidden paths",
		);
	} finally {
		if (previousDryRun === undefined) {
			delete process.env.npm_config_dry_run;
		} else {
			process.env.npm_config_dry_run = previousDryRun;
		}
		await packed?.cleanup();
	}
});
