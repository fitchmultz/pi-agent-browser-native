/**
 * Purpose: Validate the pi wrapper against the real installed upstream agent-browser binary.
 * Responsibilities: Run opt-in deterministic runtime contract checks for version, open, snapshot, eval stdin, batch stdin, wait-download, and managed-session reuse shapes.
 * Scope: Integration-only tests gated by PI_AGENT_BROWSER_REAL_UPSTREAM=1; the default fast test loop must not require a browser or upstream binary.
 * Usage: Run `npm run verify -- real-upstream` after installing the canonical target agent-browser version.
 * Invariants/Assumptions: The installed upstream version must match scripts/agent-browser-capability-baseline.mjs and all pages are served from a local fixture server.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { CAPABILITY_BASELINE, expectedVersionLabel } from "../scripts/agent-browser-capability-baseline.mjs";
import {
	createExtensionHarness,
	executeRegisteredTool,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	type FixtureServer,
} from "./helpers/agent-browser-harness.js";

const execFileAsync = promisify(execFile);
const REAL_UPSTREAM_ENABLED = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";
const SHAPES_FIXTURE_PATH = new URL("./fixtures/agent-browser-real-output-shapes.json", import.meta.url);

interface RealOutputShapesFixture {
	targetVersion: string;
	commands: Record<string, { dataKeys?: string[]; detailKeys: string[] }>;
}

async function readOutputShapesFixture(): Promise<RealOutputShapesFixture> {
	return JSON.parse(await readFile(SHAPES_FIXTURE_PATH, "utf8")) as RealOutputShapesFixture;
}

function assertHasKeys(record: Record<string, unknown> | undefined, keys: readonly string[], label: string): void {
	assert.ok(record, `expected ${label} details`);
	for (const key of keys) {
		assert.ok(Object.hasOwn(record, key), `expected ${label} to include ${key}`);
	}
}

function assertJsonIncludes(value: unknown, tokens: readonly string[], label: string): void {
	const serialized = JSON.stringify(value) ?? "";
	for (const token of tokens) {
		assert.ok(serialized.includes(token), `expected ${label} to include ${token}`);
	}
}

function assertSuccessfulResult(
	result: Awaited<ReturnType<typeof executeRegisteredTool>>,
	shape: { dataKeys?: string[]; detailKeys: string[] },
	label: string,
): Record<string, unknown> {
	assert.equal(result.isError, false, `${label} should succeed: ${result.content[0]?.text ?? ""}`);
	assertHasKeys(result.details, shape.detailKeys, `${label} details`);
	assert.equal(result.details?.exitCode, 0, `${label} exit code`);
	if (shape.dataKeys) {
		assertHasKeys(result.details?.data as Record<string, unknown> | undefined, shape.dataKeys, `${label} data`);
	}
	return result.details ?? {};
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const errorWithCode = error as NodeJS.ErrnoException;
		if (errorWithCode.code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertInstalledAgentBrowserVersion(): Promise<void> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("agent-browser", ["--version"], { timeout: 10_000 }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert.fail(`agent-browser ${CAPABILITY_BASELINE.targetVersion} is required on PATH for real-upstream tests: ${message}`);
	}
	assert.equal(
		stdout.trim(),
		expectedVersionLabel(),
		`real-upstream tests require the canonical target upstream version from scripts/agent-browser-capability-baseline.mjs`,
	);
}

async function closeManagedSessionIfPresent(options: { cwd: string; sessionName?: string; socketDir: string }): Promise<void> {
	const sessionName = options.sessionName;
	if (!sessionName) return;
	await withPatchedEnv({ AGENT_BROWSER_SOCKET_DIR: options.socketDir }, async () => {
		const harness = createExtensionHarness({ cwd: options.cwd });
		await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", sessionName, "close"] }).catch(() => undefined);
	});
}

if (!REAL_UPSTREAM_ENABLED) {
	test("real upstream agent-browser contract suite is opt-in", { skip: "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run against the installed upstream binary." }, () => undefined);
} else {
	test("real upstream agent-browser contract suite matches wrapper and browser-session expectations", { timeout: 120_000 }, async () => {
		await assertInstalledAgentBrowserVersion();
		const shapes = await readOutputShapesFixture();
		assert.equal(shapes.targetVersion, CAPABILITY_BASELINE.targetVersion, "output-shape fixture must track the canonical target version");

		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-upstream-"));
		const socketDir = join(tempDir, "sockets");
		await mkdir(join(tempDir, "Downloads"), { recursive: true });
		let fixtureServer: FixtureServer | undefined;
		let managedSessionName: string | undefined;
		try {
			fixtureServer = await startAgentBrowserContractFixtureServer();
			await withPatchedEnv(
				{
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SCREENSHOT_DIR: join(tempDir, "screenshots"),
					HOME: tempDir,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					const contractUrl = `${fixtureServer?.baseUrl}/contract`;

					const version = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--version"] });
					const versionDetails = assertSuccessfulResult(version, shapes.commands.version, "--version");
					assert.equal(versionDetails.stdout, expectedVersionLabel());
					assert.equal(versionDetails.inspection, true);
					assert.deepEqual(versionDetails.effectiveArgs, ["--version"]);

					const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", contractUrl], sessionMode: "fresh" });
					const openDetails = assertSuccessfulResult(opened, shapes.commands.open, "open");
					managedSessionName = typeof openDetails.sessionName === "string" ? openDetails.sessionName : undefined;
					assert.ok(managedSessionName, "fresh open should allocate a managed session name");
					assert.equal(openDetails.sessionMode, "fresh");
					assert.equal(openDetails.usedImplicitSession, false);
					assert.equal((openDetails.data as { title?: string }).title, "Agent Browser Contract Fixture");

					const evaluated = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin"],
						stdin: "document.title",
					});
					const evalDetails = assertSuccessfulResult(evaluated, shapes.commands.eval, "eval --stdin");
					assert.equal(evalDetails.sessionName, managedSessionName);
					assert.equal(evalDetails.usedImplicitSession, true);
					assert.deepEqual(evalDetails.data, {
						origin: contractUrl,
						result: "Agent Browser Contract Fixture",
					});

					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
					const snapshotDetails = assertSuccessfulResult(snapshot, shapes.commands.snapshot, "snapshot -i");
					assert.equal(snapshotDetails.sessionName, managedSessionName);
					assert.equal(snapshotDetails.usedImplicitSession, true);
					assertJsonIncludes(snapshotDetails.data, ["Agent Browser Contract Fixture"], "snapshot data");

					const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([["eval", "document.getElementById('status').textContent"], ["get", "title"]]),
					});
					const batchDetails = assertSuccessfulResult(batch, shapes.commands.batch, "batch via stdin");
					assert.equal(batchDetails.sessionName, managedSessionName);
					assert.equal(batchDetails.usedImplicitSession, true);
					assertJsonIncludes(batchDetails.data, ["Ready for real upstream contract validation", "Agent Browser Contract Fixture"], "batch data");

					const pushstate = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pushstate", `${fixtureServer?.baseUrl}/spa-route`] });
					const pushstateDetails = assertSuccessfulResult(pushstate, shapes.commands.pushstate, "pushstate");
					assert.equal(pushstateDetails.sessionName, managedSessionName);
					assert.equal(pushstateDetails.usedImplicitSession, true);
					assert.equal((pushstateDetails.data as { url?: string }).url, `${fixtureServer?.baseUrl}/spa-route`);

					const vitals = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["vitals", contractUrl, "--json"] });
					const vitalsDetails = assertSuccessfulResult(vitals, shapes.commands.vitals, "vitals");
					assert.equal(vitalsDetails.sessionName, managedSessionName);
					assert.match((vitalsDetails.data as { report?: string }).report ?? "", /Core Web Vitals/);

					const networkRoute = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["network", "route", "**/*.js", "--abort", "--resource-type", "script"],
					});
					const networkRouteDetails = assertSuccessfulResult(networkRoute, shapes.commands.networkRoute, "network route --resource-type");
					assert.equal((networkRouteDetails.data as { routed?: string }).routed, "**/*.js");

					const cookieFile = join(tempDir, "cookies.curl");
					await writeFile(cookieFile, "Cookie: piab_session=abc; piab_theme=dark\n", "utf8");
					const cookiesCurl = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["cookies", "set", "--curl", cookieFile, "--url", contractUrl],
					});
					const cookiesCurlDetails = assertSuccessfulResult(cookiesCurl, shapes.commands.cookiesCurl, "cookies set --curl");
					assert.equal((cookiesCurlDetails.data as { set?: boolean }).set, true);

					const reactWithoutReactApp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "--enable", "react-devtools", contractUrl],
						sessionMode: "fresh",
					});
					const reactSessionName = typeof reactWithoutReactApp.details?.sessionName === "string" ? reactWithoutReactApp.details.sessionName : undefined;
					managedSessionName = reactSessionName ?? managedSessionName;
					const reactTree = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["react", "tree"] });
					assert.equal(reactTree.isError, true, `react tree should report missing React renderer on the non-React fixture: ${reactTree.content[0]?.text ?? ""}`);
					assertHasKeys(reactTree.details, shapes.commands.reactMissingRenderer.detailKeys, "react tree missing-renderer details");
					assert.equal(reactTree.details?.sessionName, reactSessionName);
					assert.match(String(reactTree.details?.error ?? reactTree.content[0]?.text ?? ""), /No React renderer|React DevTools hook/);

					const downloadPath = join(tempDir, "wait-download-report.txt");
					const downloadPage = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", `${fixtureServer?.baseUrl}/download`] });
					assertSuccessfulResult(downloadPage, shapes.commands.open, "open download fixture");
					const clickedExport = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "#delayed-anchor-download"] });
					assert.equal(clickedExport.isError, false, `click should start async download: ${clickedExport.content[0]?.text ?? ""}`);
					const waitedDownload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["wait", "--download", downloadPath] });
					const waitDownloadDetails = assertSuccessfulResult(waitedDownload, shapes.commands.waitDownload, "wait --download");
					assert.equal(waitDownloadDetails.sessionName, managedSessionName);
					assert.equal(waitDownloadDetails.usedImplicitSession, true);
					assert.equal(waitDownloadDetails.savedFilePath, downloadPath);
					assert.equal((waitDownloadDetails.savedFile as { path?: string } | undefined)?.path, downloadPath);
					assert.match(waitedDownload.content[0]?.text ?? "", /Download completed/);

					// Upstream tracking: https://github.com/vercel-labs/agent-browser/issues/1300.
					// Current upstream agent-browser 0.27.0 reports the requested saveAs path but leaves the
					// file in the browser's default download directory. Keep this explicit so release docs do
					// not overstate savedFilePath as a verified on-disk artifact.
					const artifacts = waitDownloadDetails.artifacts as Array<{ exists?: boolean; path?: string; sizeBytes?: number }> | undefined;
					assert.equal(artifacts?.[0]?.path, downloadPath);
					assert.equal(artifacts?.[0]?.exists, false);
					assert.equal(
						await readFileIfPresent(downloadPath),
						undefined,
						"agent-browser 0.27.0 reports the requested wait --download path but does not persist the file there; update this contract if upstream saveAs persistence becomes reliable",
					);
				},
			);
		} finally {
			await closeManagedSessionIfPresent({ cwd: tempDir, sessionName: managedSessionName, socketDir });
			await fixtureServer?.close();
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}
