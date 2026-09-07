import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
	buildOwnedManagedSessionRestoreContext,
	ManagedSessionRestoreState,
	withOwnedManagedSessionContext,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import { inspectManagedSessionDaemon } from "../extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.js";
import { getAgentBrowserSocketDir, getAgentBrowserSocketDirValidationError, runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";

// Run only inside the disposable Linux user/mount namespace described in docs/RELEASE.md.
test("native namespace accepts an unmapped filesystem root for private sockets", {
	skip: process.env.PI_AGENT_BROWSER_SOCKET_NAMESPACE !== "1",
	timeout: 20_000,
}, async (t) => {
	assert.equal(process.platform, "linux");
	const uid = process.getuid!();
	const root = await lstat("/");
	const temporary = await lstat("/tmp");
	assert.equal(root.uid, Number((await readFile("/proc/sys/kernel/overflowuid", "utf8")).trim()));
	assert.notEqual(root.uid, uid);
	assert.notEqual(root.uid, 0);
	assert.equal(root.mode & 0o7777, 0o755);
	assert.equal(temporary.uid, uid);
	assert.equal(temporary.mode & 0o7777, 0o700);
	assert.equal(process.env.PI_AGENT_BROWSER_SOCKET_DIR, undefined);
	t.diagnostic(JSON.stringify({ rootUid: root.uid, rootMode: "755", uid, tmpMode: "700" }));

	const socketDir = getAgentBrowserSocketDir()!;
	await mkdir(socketDir, { mode: 0o700 });
	t.after(() => rm(socketDir, { recursive: true, force: true }));
	const fixture = await mkdtemp("/tmp/root-anchor-");
	t.after(() => rm(fixture, { recursive: true, force: true }));
	const socketPath = join(socketDir, "native.sock");
	const server = createServer((client) => client.end("native-unix-socket-ok"));
	try {
		server.listen(socketPath);
		await once(server, "listening");
		const client = createConnection(socketPath);
		client.setTimeout(5_000, () => client.destroy(new Error("Unix socket exchange timed out")));
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of client) chunks.push(Buffer.from(chunk));
			assert.equal(Buffer.concat(chunks).toString(), "native-unix-socket-ok");
		} finally {
			client.destroy();
		}
	} finally {
		server.close();
		await once(server, "close");
	}
	t.diagnostic("native-unix-socket-ok");

	assert.equal(await getAgentBrowserSocketDirValidationError(socketDir), undefined);
	assert.equal((await lstat(socketDir)).mode & 0o777, 0o700);
	const version = await runAgentBrowserProcess({ args: ["--version"], cwd: fixture, timeoutMs: 5_000 });
	assert.equal(version.spawnError, undefined);
	assert.equal(version.agentBrowserStarted, true);
	assert.equal(version.exitCode, 0);
	assert.match(version.stdout, /^agent-browser \d+\.\d+\.\d+/);
	t.diagnostic(version.stdout.trim());

	const home = join(fixture, "home");
	const cwd = join(fixture, "project");
	await mkdir(home, { mode: 0o700 });
	await mkdir(cwd, { mode: 0o700 });
	await mkdir(join(cwd, ".git"), { mode: 0o700 });
	const sessionName = "piab-root-anchor";
	const context = buildOwnedManagedSessionRestoreContext({
		args: ["--session", sessionName, "session", "info"],
		cwd,
		managedSessionName: sessionName,
		parentEnv: { HOME: home },
		restoreState: new ManagedSessionRestoreState(),
	});
	assert.equal(context?.restoreDecision, "enabled");
	const inspection = await withOwnedManagedSessionContext(context, () => inspectManagedSessionDaemon({ cwd, sessionName, timeoutMs: 5_000 }));
	assert.deepEqual(inspection, { status: "inactive" });
	t.diagnostic("native-managed-inspection: restore enabled, daemon inactive");
});
