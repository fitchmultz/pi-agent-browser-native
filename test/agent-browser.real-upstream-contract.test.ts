/**
 * Purpose: Validate the pi wrapper against the real installed upstream agent-browser binary.
 * Responsibilities: Run opt-in deterministic runtime contract checks for version, open, snapshot, eval stdin, batch stdin, wait-download, and managed-session reuse shapes.
 * Scope: Integration-only tests gated by PI_AGENT_BROWSER_REAL_UPSTREAM=1; the default fast test loop must not require a browser or upstream binary.
 * Usage: Run `npm run verify -- real-upstream` after installing the canonical target agent-browser version.
 * Invariants/Assumptions: The installed upstream version must match scripts/agent-browser-capability-baseline.mjs and all pages are served from a local fixture server.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import { CAPABILITY_BASELINE, expectedVersionLabel } from "../scripts/agent-browser-capability-baseline.mjs";
import {
	createExtensionHarness,
	DOWNLOAD_FIXTURE_CONTENT,
	DOWNLOAD_FIXTURE_FILENAME,
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

async function removeDefaultFixtureDownloadIfPresent(): Promise<void> {
	const defaultDownloadPath = join(homedir(), "Downloads", DOWNLOAD_FIXTURE_FILENAME);
	if ((await readFileIfPresent(defaultDownloadPath)) !== DOWNLOAD_FIXTURE_CONTENT) return;
	await rm(defaultDownloadPath, { force: true });
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

async function listProcessTable(): Promise<Map<number, { command: string; ppid: number }>> {
	try {
		const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 10 * 1024 * 1024, timeout: 10_000 });
		const processes = new Map<number, { command: string; ppid: number }>();
		for (const line of stdout.split("\n")) {
			const match = /^(\s*\d+)\s+(\d+)\s+(.+)$/.exec(line);
			if (!match) continue;
			processes.set(Number.parseInt(match[1], 10), { command: match[3], ppid: Number.parseInt(match[2], 10) });
		}
		return processes;
	} catch {
		return new Map();
	}
}

function collectAgentBrowserRootPids(processes: Map<number, { command: string; ppid: number }>): Set<number> {
	const pids = new Set<number>();
	for (const [pid, entry] of processes) {
		if (entry.command.includes("/agent-browser/bin/agent-browser") || entry.command.includes("agent-browser-darwin")) {
			pids.add(pid);
		}
	}
	return pids;
}

async function terminateNewAgentBrowserProcesses(previousRoots: Set<number>): Promise<void> {
	const processes = await listProcessTable();
	const roots = [...collectAgentBrowserRootPids(processes)].filter((pid) => !previousRoots.has(pid));
	if (roots.length === 0) return;
	const targets = new Set(roots);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, entry] of processes) {
			if (!targets.has(pid) && targets.has(entry.ppid)) {
				targets.add(pid);
				changed = true;
			}
		}
	}
	for (const pid of [...targets].reverse()) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// The process may have already exited after the close command.
		}
	}
	await delay(500);
	for (const pid of [...targets].reverse()) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, 0);
			process.kill(pid, "SIGKILL");
		} catch {
			// The process exited after SIGTERM or before the liveness check.
		}
	}
}

if (!REAL_UPSTREAM_ENABLED) {
	test("real upstream agent-browser contract suite is opt-in", { skip: "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run against the installed upstream binary." }, () => undefined);
} else {
	test("real upstream agent-browser contract suite matches wrapper and browser-session expectations", { timeout: 120_000 }, async () => {
		await assertInstalledAgentBrowserVersion();
		const shapes = await readOutputShapesFixture();
		assert.equal(shapes.targetVersion, CAPABILITY_BASELINE.targetVersion, "output-shape fixture must track the canonical target version");

		const agentBrowserRootsBeforeTest = collectAgentBrowserRootPids(await listProcessTable());
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-upstream-"));
		const socketDir = join(tempDir, "sockets");
		let fixtureServer: FixtureServer | undefined;
		let managedSessionName: string | undefined;
		try {
			fixtureServer = await startAgentBrowserContractFixtureServer();
			await withPatchedEnv(
				{
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SCREENSHOT_DIR: join(tempDir, "screenshots"),
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
					assert.match(JSON.stringify(snapshotDetails.data), /Agent Browser Contract Fixture|mark-ready|Ready for real upstream/);

					const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([["eval", "document.getElementById('status').textContent"], ["get", "title"]]),
					});
					const batchDetails = assertSuccessfulResult(batch, shapes.commands.batch, "batch via stdin");
					assert.equal(batchDetails.sessionName, managedSessionName);
					assert.equal(batchDetails.usedImplicitSession, true);
					assert.match(JSON.stringify(batchDetails.data), /Ready for real upstream contract validation|Agent Browser Contract Fixture/);

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
					// Current upstream agent-browser 0.26.0 reports the requested saveAs path but leaves the
					// file in the browser's default download directory. Keep this explicit so release docs do
					// not overstate savedFilePath as a verified on-disk artifact.
					const artifacts = waitDownloadDetails.artifacts as Array<{ exists?: boolean; path?: string; sizeBytes?: number }> | undefined;
					assert.equal(artifacts?.[0]?.path, downloadPath);
					assert.equal(artifacts?.[0]?.exists, false);
					assert.equal(
						await readFileIfPresent(downloadPath),
						undefined,
						"agent-browser 0.26.0 reports the requested wait --download path but does not persist the file there; update this contract if upstream saveAs persistence becomes reliable",
					);
				},
			);
		} finally {
			await closeManagedSessionIfPresent({ cwd: tempDir, sessionName: managedSessionName, socketDir });
			await terminateNewAgentBrowserProcesses(agentBrowserRootsBeforeTest);
			await fixtureServer?.close();
			await removeDefaultFixtureDownloadIfPresent();
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}
