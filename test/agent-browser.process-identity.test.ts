import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { acquireManagedSessionPolicyLock, getBrowserExecutionLockPath, resolveBrowserExecutionIdentity } from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { normalizeProcessStartIdentity, readProcessStartIdentity } from "../extensions/agent-browser/lib/process-identity.js";

for (const cancel of [false, true]) {
	test(`process identity probes honor ${cancel ? "abort" : "the shared deadline"} while a native helper is stalled`, async t => {
		const original = childProcess.execFile;
		let launched = 0;
		const probes: ReturnType<typeof execFile>[] = [];
		t.mock.method(childProcess, "execFile", (_file: string, _args: string[], options: Parameters<typeof execFile>[2], callback: Parameters<typeof execFile>[3]) => {
			launched++;
			// Substitute only the slow helper executable; Node owns real timeout/abort termination.
			const child = original(process.execPath, ["-e", "setTimeout(() => console.log('late identity'), 10000)"], options, callback);
			probes.push(child);
			return child;
		});
		syncBuiltinESMExports();
		const controller = new AbortController();
		const timer = cancel ? setTimeout(() => controller.abort(), 50) : undefined;
		const started = Date.now();
		try {
			assert.equal(await readProcessStartIdentity(process.pid, process.platform, { signal: controller.signal, deadline: started + (cancel ? 2_000 : 50) }), undefined);
			assert.equal(launched, 1, "exhausted budget must not launch fallback helpers");
			assert.ok(Date.now() - started < 1_000, "coordination must not wait for the helper's ten-second run");
			assert.ok(probes.every(probe => probe.killed));
		} finally {
			clearTimeout(timer);
			t.mock.restoreAll();
			syncBuiltinESMExports();
			for (const probe of probes) if (probe.exitCode === null) probe.kill("SIGKILL");
		}
	});
}

const systemPs = ["/bin/ps", "/usr/bin/ps"].find(existsSync);
// Explicit modes verify the layout when run in a disposable Linux environment.
const psLocation = process.env.PI_AGENT_BROWSER_TEST_PS ?? (systemPs ? "system" : "path");

test(`real POSIX ${psLocation} ps preserves process identity and lock integrity`, { skip: !["darwin", "linux"].includes(process.platform) }, async () => {
	assert.ok(["system", "path", "missing"].includes(psLocation));
	assert.equal(Boolean(systemPs), psLocation === "system", "test environment must have the requested real ps layout");
	const originalPath = process.env.PATH;
	if (psLocation !== "path") process.env.PATH = "";
	const sessionName = `piab-ps-${psLocation}-${process.pid}`;
	const namespace = sessionName;
	let lock: Awaited<ReturnType<typeof acquireManagedSessionPolicyLock>>;
	let recovered: typeof lock;
	try {
		if (psLocation === "missing") {
			assert.equal(await readProcessStartIdentity(process.pid), undefined);
			assert.equal(await acquireManagedSessionPolicyLock({ sessionName, namespace }), undefined);
			return;
		}
		const { stdout } = await promisify(execFile)(systemPs ?? "ps", ["-p", String(process.pid), "-o", "lstart="]);
		const expected = normalizeProcessStartIdentity(stdout);
		assert.ok(expected);
		const identity = await readProcessStartIdentity(process.pid);
		lock = await acquireManagedSessionPolicyLock({ sessionName, namespace });
		assert.deepEqual({ identity, lockAcquired: Boolean(lock) }, { identity: expected, lockAcquired: true });
		assert.equal(await readProcessStartIdentity(0), undefined);
		assert.equal(await acquireManagedSessionPolicyLock({ sessionName, namespace, timeoutMs: 25 }), undefined, "a live owner must remain exclusive");

		const basePath = getBrowserExecutionLockPath(await resolveBrowserExecutionIdentity({ sessionName, namespace, ownedManagedSession: true }));
		const claimNames = (await readdir(dirname(basePath))).filter((name) => name.startsWith(`${basename(basePath)}.claim-`));
		assert.equal(claimNames.length, 1);
		const ownerPath = join(dirname(basePath), claimNames[0]!, "owner.json");
		const owner = JSON.parse(await readFile(ownerPath, "utf8"));
		assert.equal(owner.startIdentity, expected);
		// A live PID with a different recorded start time represents PID reuse, not a live lock owner.
		await writeFile(ownerPath, JSON.stringify({ ...owner, startIdentity: "different-process-start" }));
		recovered = await acquireManagedSessionPolicyLock({ sessionName, namespace });
		assert.ok(recovered, "a mismatched start identity must not strand the lock");
		assert.equal(existsSync(ownerPath), false);
	} finally {
		await recovered?.release();
		await lock?.release();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});
