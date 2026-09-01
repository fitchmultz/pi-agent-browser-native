/**
 * Purpose: Validate the pi wrapper against the real installed upstream agent-browser binary.
 * Responsibilities: Run opt-in deterministic runtime contract checks for inspection and skills (stateless JSON), fresh `open` plus implicit managed-session reuse, caller-owned local-daemon pass-through, nested batch-attachment isolation, cross-harness restore persistence, and symlinked managed-storage fail-closed behavior, a broad interaction and navigation matrix on localhost fixtures (including `batch` stdin, `pushstate`, `vitals`, `network route`, `cookies set --curl`), a `react tree` missing-renderer failure shape, `wait --download` artifact reporting versus on-disk presence, and a focused sessionless `plugin list` output-shape probe.
 * Scope: Integration-only tests gated by PI_AGENT_BROWSER_REAL_UPSTREAM=1; the default fast test loop must not require a browser or upstream binary.
 * Usage: Run `npm run verify -- real-upstream` after installing the canonical target agent-browser version.
 * Invariants/Assumptions: The installed upstream version must match scripts/agent-browser-capability-baseline.mjs and all pages are served from a local fixture server.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createManagedSessionRestoreKey, getManagedSessionRestoreScope } from "../extensions/agent-browser/lib/managed-session-restore.js";
import { getAgentBrowserSocketDir, runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";
import { MINIMUM_AGENT_BROWSER_VERSION, isSupportedAgentBrowserVersion } from "../scripts/agent-browser-target.mjs";
import {
	createExtensionHarness,
	executeRegisteredTool,
	runExtensionEvent,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	type FixtureServer,
} from "./helpers/agent-browser-harness.js";

const execFileAsync = promisify(execFile);
const REAL_UPSTREAM_ENABLED = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";
const REAL_UPSTREAM_SKIP_REASON = "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run against the installed upstream binary.";
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

function getResultValue(details: Record<string, unknown>, keys: readonly string[]): unknown {
	const data = details.data;
	if (data && typeof data === "object") {
		const record = data as Record<string, unknown>;
		for (const key of keys) {
			if (Object.hasOwn(record, key)) return record[key];
		}
	}
	return data;
}

function assertCoreCommandResult(
	result: Awaited<ReturnType<typeof executeRegisteredTool>>,
	shape: { dataKeys?: string[]; detailKeys: string[] },
	label: string,
	managedSessionName: string,
): Record<string, unknown> {
	const details = assertSuccessfulResult(result, shape, label);
	assert.equal(details.sessionName, managedSessionName, `${label} sessionName`);
	assert.equal(details.usedImplicitSession, true, `${label} usedImplicitSession`);
	return details;
}

async function runCoreCommand(
	harness: ReturnType<typeof createExtensionHarness>,
	args: string[],
	shape: { dataKeys?: string[]; detailKeys: string[] },
	managedSessionName: string,
	label = args.join(" "),
): Promise<Record<string, unknown>> {
	const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
	return assertCoreCommandResult(result, shape, label, managedSessionName);
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

async function assertInstalledAgentBrowserVersion(): Promise<string> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("agent-browser", ["--version"], { timeout: 10_000 }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert.fail(`agent-browser ${MINIMUM_AGENT_BROWSER_VERSION} or newer is required on PATH for real-upstream tests: ${message}`);
	}
	const installedVersion = stdout.trim().replace(/^agent-browser\s+/, "");
	assert.ok(
		isSupportedAgentBrowserVersion(installedVersion),
		`real-upstream tests require agent-browser ${MINIMUM_AGENT_BROWSER_VERSION} or newer; found ${installedVersion}`,
	);
	return installedVersion;
}

async function initializeGitProject(path: string): Promise<void> {
	await execFileAsync("git", ["init", "-q", path]);
}

async function closeManagedSessionIfPresent(options: { cwd: string; sessionName?: string }): Promise<void> {
	if (!options.sessionName) return;
	await runAgentBrowserProcess({
		args: ["--json", "--namespace", "", "--session", options.sessionName, "close"],
		cwd: options.cwd,
		env: { AGENT_BROWSER_SOCKET_DIR: getAgentBrowserSocketDir() },
	}).catch(() => undefined);
}

async function assertRealUpstreamUnrecordedDaemonReuseFailsClosed(): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-orphan-daemon-"));
	const socketDir = join(tempDir, "sockets");
	let sessionName: string | undefined;
	try {
		await initializeGitProject(tempDir);
		await withPatchedEnv({
			AGENT_BROWSER_CONFIG: undefined,
			AGENT_BROWSER_ENCRYPTION_KEY: process.platform === "win32" ? "a".repeat(64) : undefined,
			AGENT_BROWSER_SOCKET_DIR: socketDir,
			HOME: tempDir,
			USERPROFILE: tempDir,
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
		}, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);
			const opened = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, { args: ["open", "about:blank"] });
			assert.equal(opened.isError, false, `orphan-daemon setup open failed: ${opened.content[0]?.text ?? ""}`);
			sessionName = typeof opened.details?.sessionName === "string" ? opened.details.sessionName : undefined;

			const emptyTranscriptHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(emptyTranscriptHarness.handlers, "session_start", { reason: "new" }, emptyTranscriptHarness.ctx);
			const blocked = await executeRegisteredTool(emptyTranscriptHarness.tool, emptyTranscriptHarness.ctx, {
				args: ["--proxy", "http://127.0.0.1:8080", "open", "about:blank"],
			});
			assert.equal(blocked.isError, true);
			assert.match(String(blocked.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			assert.equal(blocked.details?.exitCode, undefined);

			const closed = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, { args: ["close"] });
			assert.equal(closed.isError, false, `orphan-daemon cleanup close failed: ${closed.content[0]?.text ?? ""}`);
			sessionName = undefined;
		});
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName });
		await rm(tempDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamRestoreStorageSymlinkFailsClosed(): Promise<void> {
	if (process.platform === "win32") return;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-symlink-"));
	const socketDir = join(tempDir, "sockets");
	const targetDir = join(tempDir, "outside-state-target");
	await initializeGitProject(tempDir);
	await mkdir(join(tempDir, ".agent-browser"), { recursive: true, mode: 0o700 });
	await mkdir(targetDir);
	await symlink(targetDir, join(tempDir, ".agent-browser", "sessions"), "dir");
	let sessionName: string | undefined;
	try {
		await withPatchedEnv({
			AGENT_BROWSER_CONFIG: undefined,
			AGENT_BROWSER_ENCRYPTION_KEY: undefined,
			AGENT_BROWSER_SOCKET_DIR: socketDir,
			HOME: tempDir,
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "about:blank"], sessionMode: "fresh" });
			assert.equal(opened.isError, false, `symlink fail-closed open should succeed without restore: ${opened.content[0]?.text ?? ""}`);
			assert.equal(opened.details?.managedSessionRestoreDisabled, true);
			sessionName = typeof opened.details?.sessionName === "string" ? opened.details.sessionName : undefined;
			const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(closed.isError, false, `symlink fail-closed close should succeed: ${closed.content[0]?.text ?? ""}`);
			sessionName = undefined;
		});
		assert.deepEqual(await readdir(targetDir), [], "real upstream must not write restore state through the sessions symlink, including on close");
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName });
		await rm(tempDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamNestedRestoreStorageSymlinkFailsClosed(): Promise<void> {
	if (process.platform === "win32") return;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-nested-symlink-"));
	const socketDir = join(tempDir, "sockets");
	const outsideStateFile = join(tempDir, "outside-candidate.json");
	const temporaryDirectory = join(tempDir, ".agent-browser", "sessions", ".tmp");
	await initializeGitProject(tempDir);
	await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
	await writeFile(outsideStateFile, "unchanged");
	await symlink(outsideStateFile, join(temporaryDirectory, "candidate.json"), "file");
	let sessionName: string | undefined;
	try {
		await withPatchedEnv({
			AGENT_BROWSER_CONFIG: undefined,
			AGENT_BROWSER_ENCRYPTION_KEY: undefined,
			AGENT_BROWSER_SOCKET_DIR: socketDir,
			HOME: tempDir,
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "about:blank"], sessionMode: "fresh" });
			assert.equal(opened.isError, false, `nested symlink fail-closed open should succeed without restore: ${opened.content[0]?.text ?? ""}`);
			assert.equal(opened.details?.managedSessionRestoreDisabled, true);
			sessionName = typeof opened.details?.sessionName === "string" ? opened.details.sessionName : undefined;
			const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(closed.isError, false, `nested symlink fail-closed close should succeed: ${closed.content[0]?.text ?? ""}`);
			sessionName = undefined;
		});
		assert.equal(await readFile(outsideStateFile, "utf8"), "unchanged");
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName });
		await rm(tempDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamRelativeHomeFailsClosed(): Promise<void> {
	if (process.platform === "win32") return;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-relative-home-"));
	const socketDir = join(tempDir, "sockets");
	let sessionName: string | undefined;
	try {
		await initializeGitProject(tempDir);
		await withPatchedEnv({
			AGENT_BROWSER_CONFIG: undefined,
			AGENT_BROWSER_ENCRYPTION_KEY: undefined,
			AGENT_BROWSER_SOCKET_DIR: socketDir,
			HOME: "relative-home",
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "about:blank"], sessionMode: "fresh" });
			assert.equal(opened.isError, false, `relative-home fail-closed open should succeed without restore: ${opened.content[0]?.text ?? ""}`);
			assert.equal(opened.details?.managedSessionRestoreDisabled, true);
			sessionName = typeof opened.details?.sessionName === "string" ? opened.details.sessionName : undefined;
			const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(closed.isError, false, `relative-home fail-closed close should succeed: ${closed.content[0]?.text ?? ""}`);
			sessionName = undefined;
		});
		await assert.rejects(readdir(join(tempDir, "relative-home", ".agent-browser")));
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName });
		await rm(tempDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamLocalDaemonPassesThrough(): Promise<void> {
	if (process.platform === "win32") return;
	const shortTempRoot = dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab"));
	const tempDir = await mkdtemp(join(shortTempRoot, "u-"));
	const socketDir = join(tempDir, "sockets");
	const configPath = join(tempDir, "empty.json");
	const sessionName = `unsafe-${process.pid}`;
	const safeSessionName = `piab-safe-${process.pid}`;
	const upstreamEnv = {
		...process.env,
		AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
		AGENT_BROWSER_IDLE_TIMEOUT_MS: "900000",
		AGENT_BROWSER_SOCKET_DIR: socketDir,
		HOME: tempDir,
	};
	try {
		await mkdir(join(tempDir, ".agent-browser"), { recursive: true });
		await mkdir(socketDir, { mode: 0o700 });
		await writeFile(configPath, "{}\n");
		const protectedFile = join(tempDir, ".agent-browser", "review-state.txt");
		await writeFile(protectedFile, "fixture-value\n");
		const fixturePath = join(tempDir, "fixture.html");
		await writeFile(fixturePath, `<!doctype html><title>PENDING</title><script>fetch(${JSON.stringify(pathToFileURL(protectedFile).href)}).then(r => r.text()).then(() => document.title = "READABLE").catch(() => document.title = "BLOCKED");</script>`);
		await execFileAsync("agent-browser", ["--json", "--config", configPath, "--session", sessionName, "--allow-file-access", "true", "open", "about:blank"], {
			cwd: tempDir,
			env: upstreamEnv,
			timeout: 30_000,
		});
		await execFileAsync("agent-browser", ["--json", "--config", configPath, "--session", sessionName, "open", pathToFileURL(fixturePath).href], {
			cwd: tempDir,
			env: upstreamEnv,
			timeout: 30_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const control = await execFileAsync("agent-browser", ["--json", "--config", configPath, "--session", sessionName, "get", "title"], {
			cwd: tempDir,
			env: upstreamEnv,
			timeout: 30_000,
		});
		const controlData = (JSON.parse(control.stdout) as { data?: { result?: string; title?: string } }).data;
		assert.equal(controlData?.title ?? controlData?.result, "READABLE", "control must prove the reused unsafe daemon can read protected agent-browser storage");
		await execFileAsync("agent-browser", ["--json", "--config", configPath, "--session", sessionName, "open", "about:blank"], {
			cwd: tempDir,
			env: upstreamEnv,
			timeout: 30_000,
		});
		await withPatchedEnv({
			AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
			AGENT_BROWSER_IDLE_TIMEOUT_MS: "900000",
			HOME: tempDir,
			PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
		}, async () => {
			const opened = await runAgentBrowserProcess({ args: ["--json", "--session", sessionName, "open", pathToFileURL(fixturePath).href], cwd: tempDir });
			assert.equal(opened.exitCode, 0, opened.spawnError?.message ?? opened.stderr);

			const safeOpen = await runAgentBrowserProcess({
				args: ["--json", "--session", safeSessionName, "open", pathToFileURL(fixturePath).href],
				cwd: tempDir,
				ownedManagedSession: true,
			});
			assert.equal(safeOpen.exitCode, 0, safeOpen.spawnError?.message ?? safeOpen.stderr);
		});
	} finally {
		for (const name of [sessionName, safeSessionName]) {
			await execFileAsync("agent-browser", ["--json", "--config", configPath, "--session", name, "close"], {
				cwd: tempDir,
				env: upstreamEnv,
				timeout: 30_000,
			}).catch(() => undefined);
		}
		await rm(tempDir, { force: true, recursive: true });
	}
}

if (!REAL_UPSTREAM_ENABLED) {
	test("real upstream agent-browser contract suite is opt-in", { skip: REAL_UPSTREAM_SKIP_REASON }, () => undefined);
	test("real upstream agent-browser plugin list probe is opt-in", { skip: REAL_UPSTREAM_SKIP_REASON }, () => undefined);
} else {
	test("real upstream agent-browser contract suite matches wrapper and browser-session expectations", { timeout: 180_000 }, async () => {
		const installedVersion = await assertInstalledAgentBrowserVersion();
		const shapes = await readOutputShapesFixture();
		assert.equal(shapes.targetVersion, CAPABILITY_BASELINE.targetVersion, "output-shape fixture must track the canonical target version");

		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-upstream-"));
		const socketDir = join(tempDir, "sockets");
		const downloadDir = join(tempDir, "Downloads");
		await initializeGitProject(tempDir);
		await mkdir(downloadDir, { recursive: true });
		let fixtureServer: FixtureServer | undefined;
		let managedSessionName: string | undefined;
		try {
			fixtureServer = await startAgentBrowserContractFixtureServer();
			await withPatchedEnv(
				{
					AGENT_BROWSER_DOWNLOAD_PATH: downloadDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SCREENSHOT_DIR: join(tempDir, "screenshots"),
					HOME: tempDir,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
					const contractUrl = `${fixtureServer?.baseUrl}/contract`;

					await withPatchedEnv({ AGENT_BROWSER_DOWNLOAD_PATH: undefined, AGENT_BROWSER_SCREENSHOT_DIR: undefined }, async () => {
						const profileHarness = createExtensionHarness({ cwd: tempDir, sessionId: "12345678123456781234567812345678" });
						await runExtensionEvent(profileHarness.handlers, "session_start", { reason: "new" }, profileHarness.ctx);
						await mkdir(join(tempDir, "profile-continuity"));
						try {
							const profileOpen = await executeRegisteredTool(profileHarness.tool, profileHarness.ctx, {
								args: ["--profile", join(tempDir, "profile-continuity"), "--user-agent", "Profile Continuity/1", "open", contractUrl],
								sessionMode: "fresh",
							});
							assertSuccessfulResult(profileOpen, shapes.commands.open, "profile continuity open");
							const profileUrl = await executeRegisteredTool(profileHarness.tool, profileHarness.ctx, { args: ["get", "url"] });
							const profileUrlDetails = assertSuccessfulResult(profileUrl, shapes.commands.coreSubcommand, "profile continuity get url");
							assert.equal((profileUrlDetails.data as { url?: string }).url, contractUrl, "profile and user-agent launch settings must not be re-emitted on active follow-ups");
						} finally {
							await executeRegisteredTool(profileHarness.tool, profileHarness.ctx, { args: ["close"] });
						}
					});

					const version = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--version"] });
					const versionDetails = assertSuccessfulResult(version, shapes.commands.version, "--version");
					assert.equal(versionDetails.stdout, `agent-browser ${installedVersion}`);
					assert.equal(versionDetails.inspection, true);
					assert.deepEqual(versionDetails.effectiveArgs, ["--version"]);

					const rootHelp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--help"] });
					const rootHelpDetails = assertSuccessfulResult(rootHelp, shapes.commands.rootHelp, "--help");
					assert.equal(rootHelpDetails.inspection, true);
					assert.deepEqual(rootHelpDetails.effectiveArgs, ["--help"]);
					assert.match(rootHelp.content[0]?.text ?? "", /Usage: agent-browser/);

					const commandHelp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "--help"] });
					const commandHelpDetails = assertSuccessfulResult(commandHelp, shapes.commands.commandHelp, "snapshot --help");
					assert.equal(commandHelpDetails.inspection, true);
					assert.deepEqual(commandHelpDetails.effectiveArgs, ["snapshot", "--help"]);
					assert.match(commandHelp.content[0]?.text ?? "", /snapshot/);

					const skillsList = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "list"] });
					const skillsListDetails = assertSuccessfulResult(skillsList, shapes.commands.skillsList, "skills list");
					assert.equal(skillsListDetails.sessionName, undefined);
					assert.equal(skillsListDetails.usedImplicitSession, undefined);
					assert.deepEqual(skillsListDetails.effectiveArgs, ["--json", "skills", "list"]);
					assert.match(skillsList.content[0]?.text ?? "", /core/);
					if (installedVersion === CAPABILITY_BASELINE.targetVersion) assert.match(skillsList.content[0]?.text ?? "", /webmcp-gen/);

					const skillsGetFull = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "get", "core", "--full"] });
					const skillsGetFullDetails = assertSuccessfulResult(skillsGetFull, shapes.commands.skillsGetFull, "skills get core --full");
					assert.equal(skillsGetFullDetails.sessionName, undefined);
					assert.equal(skillsGetFullDetails.usedImplicitSession, undefined);
					assert.deepEqual(skillsGetFullDetails.effectiveArgs, ["--json", "skills", "get", "core", "--full"]);
					assert.match(skillsGetFull.content[0]?.text ?? "", /agent_browser/);

					const protectedVercelSkill = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "get", "protected-vercel-deployments", "--full"] });
					const protectedVercelDetails = assertSuccessfulResult(protectedVercelSkill, shapes.commands.skillsGetFull, "skills get protected-vercel-deployments --full");
					assert.equal(protectedVercelDetails.sessionName, undefined);
					assert.match(protectedVercelSkill.content[0]?.text ?? "", /x-vercel-trusted-oidc-idp-token/);

					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						const webMcpSkill = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "get", "webmcp-gen", "--full"] });
						const webMcpSkillDetails = assertSuccessfulResult(webMcpSkill, shapes.commands.skillsGetFull, "skills get webmcp-gen --full");
						assert.equal(webMcpSkillDetails.sessionName, undefined);
						assert.match(webMcpSkill.content[0]?.text ?? "", /webmcp\.init\.js/);
					}

					const skillsPath = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "path", "core"] });
					const skillsPathDetails = assertSuccessfulResult(skillsPath, shapes.commands.skillsPath, "skills path core");
					assert.equal(skillsPathDetails.sessionName, undefined);
					assert.equal(skillsPathDetails.usedImplicitSession, undefined);
					assert.deepEqual(skillsPathDetails.effectiveArgs, ["--json", "skills", "path", "core"]);
					assert.match(skillsPath.content[0]?.text ?? "", /core/);

					const webMcpUrl = `${fixtureServer?.baseUrl}/webmcp`;
					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						const disabledHarness = createExtensionHarness({ cwd: tempDir, sessionId: "87654321876543218765432187654321" });
						await runExtensionEvent(disabledHarness.handlers, "session_start", { reason: "new" }, disabledHarness.ctx);
						try {
							const disabledOpen = await executeRegisteredTool(disabledHarness.tool, disabledHarness.ctx, {
								args: ["--no-webmcp", "open", webMcpUrl],
								sessionMode: "fresh",
							});
							assertSuccessfulResult(disabledOpen, shapes.commands.open, "open with --no-webmcp");
							assert.ok(disabledOpen.details?.effectiveArgs instanceof Array && disabledOpen.details.effectiveArgs.includes("--no-webmcp"));
							const disabledList = await executeRegisteredTool(disabledHarness.tool, disabledHarness.ctx, { args: ["webmcp", "list"] });
							const disabledListDetails = assertSuccessfulResult(disabledList, shapes.commands.coreSubcommand, "webmcp list with feature disabled");
							assert.deepEqual((disabledListDetails.data as { tools?: unknown[] }).tools, []);
						} finally {
							await executeRegisteredTool(disabledHarness.tool, disabledHarness.ctx, { args: ["close"] });
						}
					}

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
					assert.equal((evalDetails.data as { origin?: string }).origin, contractUrl);
					assert.equal((evalDetails.data as { result?: string }).result, "Agent Browser Contract Fixture");

					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
					const snapshotDetails = assertSuccessfulResult(snapshot, shapes.commands.snapshot, "snapshot -i");
					assert.equal(snapshotDetails.sessionName, managedSessionName);
					assert.equal(snapshotDetails.usedImplicitSession, true);
					assertJsonIncludes(snapshotDetails.data, ["Agent Browser Contract Fixture"], "snapshot data");
					const flavorRef = Object.entries((snapshotDetails.data as { refs?: Record<string, { name?: string; role?: string }> }).refs ?? {})
						.find(([, ref]) => ref.role === "combobox" && ref.name === "Flavor")?.[0];
					assert.ok(flavorRef, "snapshot should expose the Flavor combobox ref");
					await runCoreCommand(harness, ["select", `@${flavorRef}`, "chocolate"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#flavor-select"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"chocolate",
					);

					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						await runCoreCommand(harness, ["open", webMcpUrl], shapes.commands.open, managedSessionName, "open WebMCP fixture");
						const webMcpList = await runCoreCommand(harness, ["webmcp", "list"], shapes.commands.coreSubcommand, managedSessionName);
						assert.equal((webMcpList.sessionTabTarget as { url?: string } | undefined)?.url, webMcpUrl);
						const tools = (webMcpList.data as { tools?: Array<{ frameId?: string; name?: string }> }).tools ?? [];
						const setMessageFrame = tools.find((tool) => tool.name === "set_message")?.frameId;
						assert.ok(setMessageFrame, "webmcp list should expose set_message and its frame id");

						const webMcpInvoke = await runCoreCommand(harness, [
							"webmcp", "invoke", "set_message", "--params", '{"message":"WebMCP changed"}', "--frame", setMessageFrame, "--timeout", "5000",
						], shapes.commands.coreSubcommand, managedSessionName);
						assert.equal((webMcpInvoke.data as { status?: string }).status, "completed");
						assert.equal((webMcpInvoke.data as { navigationSummary?: { url?: string } }).navigationSummary?.url, webMcpUrl);
						assert.equal((webMcpInvoke.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "page-transition");
						assert.deepEqual((webMcpInvoke.nextActions as Array<{ id?: string }> | undefined)?.map((action) => action.id), ["inspect-after-mutation"]);
						assert.equal(
							getResultValue(await runCoreCommand(harness, ["get", "text", "#webmcp-result"], shapes.commands.coreSubcommand, managedSessionName), ["text"]),
							"WebMCP changed",
						);

						const detached = await runCoreCommand(harness, ["webmcp", "invoke", "wait_for_cancel", "--detach"], shapes.commands.coreSubcommand, managedSessionName);
						const invocationId = (detached.data as { invocationId?: string }).invocationId;
						assert.ok(invocationId, "detached WebMCP invoke should return an invocation id");
						assert.equal(detached.sessionTabTarget, undefined);
						assert.equal(detached.sessionTabTargetUnknown, true);
						assert.deepEqual((detached.nextActions as Array<{ id?: string }> | undefined)?.map((action) => action.id), ["verify-page-target-after-pending-webmcp"]);
						const canceled = await runCoreCommand(harness, ["webmcp", "cancel", invocationId], shapes.commands.coreSubcommand, managedSessionName);
						assert.equal((canceled.data as { status?: string }).status, "canceled");
						const canceledResult = await runCoreCommand(harness, ["webmcp", "result", invocationId], shapes.commands.coreSubcommand, managedSessionName);
						assert.equal((canceledResult.data as { status?: string }).status, "canceled");
						await runCoreCommand(harness, ["open", contractUrl], shapes.commands.open, managedSessionName, "restore contract fixture after WebMCP");
					}

					const readResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["read", contractUrl] });
					const readDetails = assertSuccessfulResult(readResult, shapes.commands.read, "read URL");
					assert.equal(readDetails.sessionName, managedSessionName);
					assert.equal(readDetails.usedImplicitSession, true);
					assert.match(readResult.content[0]?.text ?? "", /Agent Browser Contract Fixture/);
					assert.match((readDetails.data as { content?: string }).content ?? "", /Ready for real upstream contract validation/);

					const uploadPath = join(tempDir, "upload-fixture.txt");
					const screenshotPath = join(tempDir, "contract.png");
					const pdfPath = join(tempDir, "contract.pdf");
					await writeFile(uploadPath, "upload contract fixture\n");

					await runCoreCommand(harness, ["click", "#mark-ready"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "text", "#status"], shapes.commands.coreSubcommand, managedSessionName), ["text"]),
						"Clicked",
					);
					await runCoreCommand(harness, ["dblclick", "#double-action"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "text", "#status"], shapes.commands.coreSubcommand, managedSessionName), ["text"]),
						"Double clicked",
					);
					await runCoreCommand(harness, ["fill", "#name-input", "Ada"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["type", "#name-input", " Lovelace"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#name-input"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"Ada Lovelace",
					);
					await runCoreCommand(harness, ["type", "#name-input", "Curie", "--clear", "--delay", "1"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#name-input"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"Curie",
					);
					await runCoreCommand(harness, ["focus", "#notes-input"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["keyboard", "type", "keyboard text"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["keyboard", "inserttext", " inserted"], shapes.commands.coreSubcommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#notes-input"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"keyboard text inserted",
					);
					await runCoreCommand(harness, ["press", "Tab"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["hover", "#hover-target"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["eval", "document.body.dataset.hovered"], shapes.commands.eval, managedSessionName), ["result"]),
						"yes",
					);
					await runCoreCommand(harness, ["check", "#agree-checkbox"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["is", "checked", "#agree-checkbox"], shapes.commands.coreSubcommand, managedSessionName), ["checked"]),
						true,
					);
					await runCoreCommand(harness, ["uncheck", "#agree-checkbox"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["is", "checked", "#agree-checkbox"], shapes.commands.coreSubcommand, managedSessionName), ["checked"]),
						false,
					);
					await runCoreCommand(harness, ["select", "#flavor-select", "chocolate"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#flavor-select"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"chocolate",
					);
					const missingSelectOption = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["select", "#flavor-select", "mint"] });
					assert.equal(missingSelectOption.isError, true, `select should fail when no option matches: ${missingSelectOption.content[0]?.text ?? ""}`);
					assert.match(missingSelectOption.content[0]?.text ?? "", /option|mint/i);
					const semanticSelect = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: { action: "select", selector: "#flavor-select", value: "vanilla" },
					});
					assertCoreCommandResult(semanticSelect, shapes.commands.coreCommand, "semanticAction select", managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#flavor-select"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"vanilla",
					);
					const jobSelect = await executeRegisteredTool(harness.tool, harness.ctx, {
						job: { steps: [{ action: "select", selector: "#flavor-select", value: "chocolate" }] },
					});
					assertCoreCommandResult(jobSelect, shapes.commands.batch, "job select", managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#flavor-select"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"chocolate",
					);
					await runCoreCommand(harness, ["upload", "#file-input", uploadPath], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["eval", "document.querySelector('#file-input').files[0]?.name"], shapes.commands.eval, managedSessionName), ["result"]),
						"upload-fixture.txt",
					);
					await runCoreCommand(harness, ["drag", "#drag-source", "#drop-target"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "text", "#drop-target"], shapes.commands.coreSubcommand, managedSessionName), ["text"]),
						"Dropped",
					);
					await runCoreCommand(harness, ["mouse", "move", "20", "20"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["mouse", "down"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["mouse", "up"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["mouse", "wheel", "240"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["scroll", "down", "400"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["click", "#far-click-target"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "text", "#status"], shapes.commands.coreSubcommand, managedSessionName), ["text"]),
						"Far clicked",
					);
					await runCoreCommand(harness, ["scrollintoview", "#far-target"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["wait", "#far-target"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["frame", "#contract-frame"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["wait", "#frame-button"], shapes.commands.coreCommand, managedSessionName);
					await runCoreCommand(harness, ["click", "#frame-button"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "text", "#frame-status"], shapes.commands.coreSubcommand, managedSessionName), ["text"]),
						"Frame clicked",
					);
					await runCoreCommand(harness, ["frame", "main"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["find", "label", "Name", "fill", "Grace"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["find", "label", "Codename", "fill", "Lovelace"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["find", "label", "Alias Name", "fill", "Analyst"], shapes.commands.coreSubcommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#name-input"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"Grace",
					);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#aria-label-input"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"Lovelace",
					);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "value", "#aria-labelledby-input"], shapes.commands.coreSubcommand, managedSessionName), ["value"]),
						"Analyst",
					);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "attr", "#mark-ready", "id"], shapes.commands.coreSubcommand, managedSessionName), ["value", "attribute"]),
						"mark-ready",
					);
					await runCoreCommand(harness, ["get", "html", "#main"], shapes.commands.coreSubcommand, managedSessionName);
					assert.equal(
						getResultValue(await runCoreCommand(harness, ["get", "count", "button"], shapes.commands.coreSubcommand, managedSessionName), ["count"]),
						6,
					);
					await runCoreCommand(harness, ["get", "box", "#mark-ready"], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["get", "styles", "#far-target"], shapes.commands.coreSubcommand, managedSessionName);
					assert.equal(getResultValue(await runCoreCommand(harness, ["is", "visible", "#mark-ready"], shapes.commands.coreSubcommand, managedSessionName), ["visible"]), true);
					assert.equal(getResultValue(await runCoreCommand(harness, ["is", "enabled", "#mark-ready"], shapes.commands.coreSubcommand, managedSessionName), ["enabled"]), true);
					await runCoreCommand(harness, ["screenshot", screenshotPath], shapes.commands.coreFileArtifact, managedSessionName);
					await runCoreCommand(harness, ["pdf", pdfPath], shapes.commands.coreFileArtifact, managedSessionName);
					assert.ok(await readFileIfPresent(screenshotPath), "screenshot should be saved");
					assert.ok(await readFileIfPresent(pdfPath), "PDF should be saved");

					await runCoreCommand(harness, ["click", "#next-link"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "title"], shapes.commands.coreSubcommand, managedSessionName), ["title"]), "Next Contract Fixture");
					await runCoreCommand(harness, ["back"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "url"], shapes.commands.coreSubcommand, managedSessionName), ["url"]), contractUrl);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "title"], shapes.commands.coreSubcommand, managedSessionName), ["title"]), "Agent Browser Contract Fixture");
					await runCoreCommand(harness, ["forward"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "url"], shapes.commands.coreSubcommand, managedSessionName), ["url"]), `${fixtureServer?.baseUrl}/next`);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "title"], shapes.commands.coreSubcommand, managedSessionName), ["title"]), "Next Contract Fixture");
					await runCoreCommand(harness, ["reload"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "url"], shapes.commands.coreSubcommand, managedSessionName), ["url"]), `${fixtureServer?.baseUrl}/next`);
					const initialTabs = (await runCoreCommand(harness, ["tab", "list"], shapes.commands.coreSubcommand, managedSessionName)).data as {
						tabs?: Array<{ active?: boolean; tabId?: string }>;
					};
					const initialTabId = initialTabs.tabs?.find((tab) => tab.active)?.tabId;
					assert.ok(initialTabId, "tab list should expose the active tab id");
					await runCoreCommand(harness, ["tab", "new", "--label", "contract-copy", contractUrl], shapes.commands.coreSubcommand, managedSessionName);
					await runCoreCommand(harness, ["tab", initialTabId], shapes.commands.coreSubcommand, managedSessionName);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "url"], shapes.commands.coreSubcommand, managedSessionName), ["url"]), `${fixtureServer?.baseUrl}/next`);
					assert.equal(getResultValue(await runCoreCommand(harness, ["get", "title"], shapes.commands.coreSubcommand, managedSessionName), ["title"]), "Next Contract Fixture");
					await runCoreCommand(harness, ["tab", "contract-copy"], shapes.commands.coreSubcommand, managedSessionName);
					const tabCloseDetails = await runCoreCommand(harness, ["tab", "close"], shapes.commands.coreSubcommand, managedSessionName);
					assert.equal((tabCloseDetails.sessionTabTarget as { url?: string } | undefined)?.url, `${fixtureServer?.baseUrl}/next`);
					await runCoreCommand(harness, ["open", contractUrl], shapes.commands.open, managedSessionName);

					const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([["get", "text", "#status"], ["get", "title"]]),
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
					const vitalsData = vitalsDetails.data as { fcp?: number; ttfb?: number; url?: string };
					assert.match(vitalsData.url ?? "", /\/contract\/?$/);
					assert.equal(typeof vitalsData.fcp, "number");
					assert.equal(typeof vitalsData.ttfb, "number");

					const networkRoute = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["network", "route", "**/*.js", "--abort", "--resource-type", "script"],
					});
					const networkRouteDetails = assertSuccessfulResult(networkRoute, shapes.commands.networkRoute, "network route --resource-type");
					assert.equal((networkRouteDetails.data as { routed?: string }).routed, "**/*.js");
					await runCoreCommand(harness, ["network", "requests"], shapes.commands.nonCoreStatus, managedSessionName, "network requests");
					await runCoreCommand(harness, ["network", "har", "start"], shapes.commands.nonCoreStatus, managedSessionName, "network har start");
					const harPath = join(tempDir, "contract.har");
					await runCoreCommand(harness, ["network", "har", "stop", harPath], shapes.commands.nonCoreArtifact, managedSessionName, "network har stop");
					assert.ok(await readFileIfPresent(harPath), "HAR should be saved");

					await runCoreCommand(harness, ["snapshot"], shapes.commands.snapshot, managedSessionName, "snapshot before diff");
					await runCoreCommand(harness, ["diff", "snapshot"], shapes.commands.nonCoreStatus, managedSessionName, "diff snapshot");
					await runCoreCommand(harness, ["diff", "screenshot", "--baseline", screenshotPath], shapes.commands.diffScreenshotArtifact, managedSessionName, "diff screenshot");
					await runCoreCommand(harness, ["diff", "url", contractUrl, `${fixtureServer?.baseUrl}/next`], shapes.commands.nonCoreStatus, managedSessionName, "diff url");

					await runCoreCommand(harness, ["trace", "start"], shapes.commands.nonCoreStatus, managedSessionName, "trace start");
					const tracePath = join(tempDir, "contract-trace.zip");
					await runCoreCommand(harness, ["trace", "stop", tracePath], shapes.commands.nonCoreArtifact, managedSessionName, "trace stop");
					assert.ok(await readFileIfPresent(tracePath), "trace should be saved");
					await runCoreCommand(harness, ["profiler", "start"], shapes.commands.nonCoreStatus, managedSessionName, "profiler start");
					const profilePath = join(tempDir, "contract.cpuprofile");
					await runCoreCommand(harness, ["profiler", "stop", profilePath], shapes.commands.nonCoreArtifact, managedSessionName, "profiler stop");
					assert.ok(await readFileIfPresent(profilePath), "profile should be saved");
					await runCoreCommand(harness, ["open", contractUrl], shapes.commands.open, managedSessionName, "restore contract fixture after diff/debug flows");
					await runCoreCommand(harness, ["console"], shapes.commands.nonCoreStatus, managedSessionName, "console");
					await runCoreCommand(harness, ["errors"], shapes.commands.nonCoreStatus, managedSessionName, "errors");
					await runCoreCommand(harness, ["highlight", "#mark-ready"], shapes.commands.nonCoreStatus, managedSessionName, "highlight");
					const priorStreamStatus = await runCoreCommand(harness, ["stream", "status"], shapes.commands.streamStatus, managedSessionName, "stream status preflight");
					if ((priorStreamStatus.data as { enabled?: boolean }).enabled === true) {
						await runCoreCommand(harness, ["stream", "disable"], shapes.commands.streamControl, managedSessionName, "stream disable preflight");
					}
					await runCoreCommand(harness, ["stream", "enable"], shapes.commands.streamControl, managedSessionName, "stream enable");
					await runCoreCommand(harness, ["stream", "status"], shapes.commands.streamStatus, managedSessionName, "stream status");
					await runCoreCommand(harness, ["stream", "disable"], shapes.commands.streamControl, managedSessionName, "stream disable");

					const cookieFile = join(tempDir, "cookies.curl");
					await writeFile(cookieFile, "Cookie: piab_session=abc; piab_theme=dark\n", "utf8");
					const cookiesCurl = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["cookies", "set", "--curl", cookieFile, "--url", contractUrl],
					});
					const cookiesCurlDetails = assertSuccessfulResult(cookiesCurl, shapes.commands.cookiesCurl, "cookies set --curl");
					assert.equal((cookiesCurlDetails.data as { set?: boolean }).set, true);

					const restoreMarker = "piab-real-upstream-restore";
					const seedRestoreState = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin"],
						stdin: `document.cookie = "piab_restore_cookie=${restoreMarker}; path=/"; localStorage.setItem("piab-restore-local", "${restoreMarker}"); sessionStorage.setItem("piab-restore-session", "${restoreMarker}"); true`,
					});
					assertSuccessfulResult(seedRestoreState, shapes.commands.eval, "seed managed restore state");

					for (const params of [
						{
							args: ["batch"],
							stdin: JSON.stringify([["connect", "wss://remote.example/devtools/browser/test"], ["snapshot", "-i"]]),
						},
						{ args: ["batch", "connect wss://remote.example/devtools/browser/test"] },
					]) {
						const blockedBatch = await executeRegisteredTool(harness.tool, harness.ctx, params);
						assert.equal(blockedBatch.isError, true);
						assert.equal(blockedBatch.details?.failureCategory, "validation-error", JSON.stringify(blockedBatch.details));
						assert.match(String(blockedBatch.details?.validationError ?? ""), /does not match the requested managed-restore policy|active page became unverified/);
						assert.equal(blockedBatch.details?.exitCode, undefined, "nested batch attachment must fail before upstream spawn");
					}
					for (const subcommand of ["start", "restart"]) {
						const blockedRecordingAfterClose = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["batch"],
							stdin: JSON.stringify([["close"], ["record", subcommand, join(tempDir, `after-close-${subcommand}.webm`)]]),
						});
						assert.equal(blockedRecordingAfterClose.isError, true);
						assert.equal(blockedRecordingAfterClose.details?.failureCategory, "validation-error");
						assert.match(blockedRecordingAfterClose.content[0]?.text ?? "", new RegExp(`record ${subcommand} cannot follow close`));
						assert.equal(blockedRecordingAfterClose.details?.exitCode, undefined, "recording after close must fail before upstream spawn");
					}
					const lateConfigPath = join(tempDir, "agent-browser.json");
					await writeFile(lateConfigPath, JSON.stringify({ restore: "replacement-close-key" }), "utf8");
					const firstClose = await (async () => {
						try {
							return await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "redirected" }, async () =>
								await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["--session", managedSessionName ?? "", "--config", lateConfigPath, "--restore", "replacement-close-key", "close"],
								}));
						} finally {
							await rm(lateConfigPath, { force: true });
						}
					})();
					assert.equal(firstClose.isError, false, `first managed close should persist restore state despite late config: ${firstClose.content[0]?.text ?? ""}`);
					await new Promise((resolve) => setTimeout(resolve, 200));
					const closedInfo = await execFileAsync("agent-browser", ["--json", "--namespace", "", "--session", managedSessionName ?? "", "session", "info"], {
						cwd: tempDir,
						env: { ...process.env, AGENT_BROWSER_NAMESPACE: "redirected", AGENT_BROWSER_SOCKET_DIR: getAgentBrowserSocketDir() ?? socketDir, HOME: tempDir },
					});
					assert.equal((JSON.parse(closedInfo.stdout) as { data?: { active?: boolean } }).data?.active, false, "owned close must override a redirecting namespace environment");

					const restoreScope = getManagedSessionRestoreScope(managedSessionName ?? "");
					const managedRestoreKey = createManagedSessionRestoreKey(tempDir, restoreScope);
					const foreignRestoreKey = createManagedSessionRestoreKey(tempDir, `${restoreScope}-foreign-chat`);
					assert.notEqual(foreignRestoreKey, managedRestoreKey, "concurrent Pi chats must not share an upstream newest-file-wins restore pool");
					const restoreSessionsDirectory = join(tempDir, ".agent-browser", "sessions");
					await writeFile(join(restoreSessionsDirectory, `${foreignRestoreKey}-newer-empty.json`), JSON.stringify({ cookies: [], origins: [] }), "utf8");

					const sameExtensionRestoredOpen = await (async () => {
						try {
							await writeFile(lateConfigPath, JSON.stringify({ restore: foreignRestoreKey }), "utf8");
							return await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", contractUrl] });
						} finally {
							await rm(lateConfigPath, { force: true });
						}
					})();
					assertSuccessfulResult(sameExtensionRestoredOpen, shapes.commands.open, "reopen restored managed session after close in same extension");
					const sameExtensionRestoreState = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin"],
						stdin: `JSON.stringify({ cookiePresent: document.cookie.includes("piab_restore_cookie=${restoreMarker}"), local: localStorage.getItem("piab-restore-local"), session: sessionStorage.getItem("piab-restore-session") })`,
					});
					const sameExtensionRestoreDetails = assertSuccessfulResult(sameExtensionRestoreState, shapes.commands.eval, "read same-extension restored managed state");
					const sameExtensionRestoredValue = JSON.parse(String((sameExtensionRestoreDetails.data as { result?: string }).result ?? "{}")) as { cookiePresent?: boolean; local?: string; session?: string };
					assert.equal(sameExtensionRestoredValue.cookiePresent, true);
					assert.equal(sameExtensionRestoredValue.local, restoreMarker);
					assert.equal(sameExtensionRestoredValue.session, restoreMarker);
					const sameExtensionRestoredClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
					assert.equal(sameExtensionRestoredClose.isError, false, `same-extension restored managed close should succeed: ${sameExtensionRestoredClose.content[0]?.text ?? ""}`);

					const restoredHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(restoredHarness.handlers, "session_start", { reason: "resume" }, restoredHarness.ctx);
					let restoredValueText: string | undefined;
					try {
						const restoredOpen = await executeRegisteredTool(restoredHarness.tool, restoredHarness.ctx, { args: ["open", contractUrl] });
						assertSuccessfulResult(restoredOpen, shapes.commands.open, "open restored managed session");
						const readRestoreState = await executeRegisteredTool(restoredHarness.tool, restoredHarness.ctx, {
							args: ["eval", "--stdin"],
							stdin: `JSON.stringify({ cookiePresent: document.cookie.includes("piab_restore_cookie=${restoreMarker}"), local: localStorage.getItem("piab-restore-local"), session: sessionStorage.getItem("piab-restore-session") })`,
						});
						const restoredDetails = assertSuccessfulResult(readRestoreState, shapes.commands.eval, "read restored managed state");
						restoredValueText = String((restoredDetails.data as { result?: string }).result);
					} finally {
						const restoredClose = await executeRegisteredTool(restoredHarness.tool, restoredHarness.ctx, { args: ["close"] });
						assert.equal(restoredClose.isError, false, `restored managed close should succeed: ${restoredClose.content[0]?.text ?? ""}`);
					}
					const restoredValue = JSON.parse(restoredValueText ?? "{}") as { cookiePresent?: boolean; local?: string; session?: string };
					assert.equal(restoredValue.cookiePresent, true);
					assert.equal(restoredValue.local, restoreMarker);
					assert.equal(restoredValue.session, restoreMarker);

					const isolatedHarness = createExtensionHarness({ cwd: tempDir, sessionId: "87654321876543218765432187654321" });
					await runExtensionEvent(isolatedHarness.handlers, "session_start", { reason: "new" }, isolatedHarness.ctx);
					let isolatedValueText: string | undefined;
					try {
						const isolatedOpen = await executeRegisteredTool(isolatedHarness.tool, isolatedHarness.ctx, { args: ["open", contractUrl] });
						assertSuccessfulResult(isolatedOpen, shapes.commands.open, "open distinct-transcript managed session");
						const isolatedState = await executeRegisteredTool(isolatedHarness.tool, isolatedHarness.ctx, {
							args: ["eval", "--stdin"],
							stdin: `JSON.stringify({ cookiePresent: document.cookie.includes("piab_restore_cookie=${restoreMarker}"), local: localStorage.getItem("piab-restore-local"), session: sessionStorage.getItem("piab-restore-session") })`,
						});
						const isolatedDetails = assertSuccessfulResult(isolatedState, shapes.commands.eval, "read distinct-transcript managed state");
						isolatedValueText = String((isolatedDetails.data as { result?: string }).result);
					} finally {
						const isolatedClose = await executeRegisteredTool(isolatedHarness.tool, isolatedHarness.ctx, { args: ["close"] });
						assert.equal(isolatedClose.isError, false, `distinct-transcript managed close should succeed: ${isolatedClose.content[0]?.text ?? ""}`);
					}
					const isolatedValue = JSON.parse(isolatedValueText ?? "{}") as { cookiePresent?: boolean; local?: string | null; session?: string | null };
					assert.equal(isolatedValue.cookiePresent, false);
					assert.equal(isolatedValue.local, null);
					assert.equal(isolatedValue.session, null);

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
					assert.equal(waitedDownload.isError, true, `wait --download should fail closed when the reported file is missing: ${waitedDownload.content[0]?.text ?? ""}`);
					assertHasKeys(waitedDownload.details, shapes.commands.waitDownload.detailKeys, "wait --download details");
					const waitDownloadDetails = waitedDownload.details ?? {};
					assert.equal(waitDownloadDetails.resultCategory, "failure");
					assert.equal(waitDownloadDetails.failureCategory, "artifact-missing");
					assert.equal(waitDownloadDetails.sessionName, managedSessionName);
					assert.equal(waitDownloadDetails.usedImplicitSession, true);
					assert.equal(waitDownloadDetails.savedFilePath, downloadPath);
					assert.equal((waitDownloadDetails.savedFile as { path?: string } | undefined)?.path, downloadPath);
					assert.match(waitedDownload.content[0]?.text ?? "", /Artifact verification failed/);
					assert.match(waitedDownload.content[0]?.text ?? "", /Download event reported; file not verified/);

					// Upstream tracking: https://github.com/vercel-labs/agent-browser/issues/1300.
					// Current upstream reports the requested saveAs path but leaves the file in the
					// browser's default download directory. The wrapper must fail closed so release
					// docs do not overstate savedFilePath as a verified on-disk artifact.
					const artifacts = waitDownloadDetails.artifacts as Array<{ exists?: boolean; path?: string; sizeBytes?: number }> | undefined;
					assert.equal(artifacts?.[0]?.path, downloadPath);
					assert.equal(artifacts?.[0]?.exists, false);
					assert.equal(
						await readFileIfPresent(downloadPath),
						undefined,
						"current upstream reports the requested wait --download path but does not persist the file there; update this contract if upstream saveAs persistence becomes reliable",
					);
				},
			);
		} finally {
			await closeManagedSessionIfPresent({ cwd: tempDir, sessionName: managedSessionName });
			await fixtureServer?.close();
			await rm(tempDir, { force: true, recursive: true });
		}
		await assertRealUpstreamLocalDaemonPassesThrough();
		await assertRealUpstreamUnrecordedDaemonReuseFailsClosed();
		await assertRealUpstreamRestoreStorageSymlinkFailsClosed();
		await assertRealUpstreamNestedRestoreStorageSymlinkFailsClosed();
		await assertRealUpstreamRelativeHomeFailsClosed();
	});

	test("real upstream agent-browser plugin list stays sessionless", { timeout: 60_000 }, async () => {
		await assertInstalledAgentBrowserVersion();
		const shapes = await readOutputShapesFixture();
		assert.equal(shapes.targetVersion, CAPABILITY_BASELINE.targetVersion, "output-shape fixture must track the canonical target version");

		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-upstream-plugins-"));
		try {
			await withPatchedEnv({ HOME: tempDir, AGENT_BROWSER_PLUGINS: "[]" }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const pluginList = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["plugin", "list"] });
				const pluginListDetails = assertSuccessfulResult(pluginList, shapes.commands.pluginList, "plugin list empty");
				assert.equal(pluginListDetails.sessionName, undefined);
				assert.equal(pluginListDetails.usedImplicitSession, undefined);
				assert.deepEqual(pluginListDetails.effectiveArgs, ["--json", "plugin", "list"]);
				assert.deepEqual((pluginListDetails.data as { plugins?: unknown[] }).plugins, []);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}
