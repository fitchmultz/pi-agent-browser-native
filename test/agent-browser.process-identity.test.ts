import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { acquireManagedSessionPolicyLock, getManagedSessionPolicyLockPath } from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { normalizeProcessStartIdentity, readProcessStartIdentity } from "../extensions/agent-browser/lib/process-identity.js";

const systemPs = ["/bin/ps", "/usr/bin/ps"].find(existsSync);
// Explicit modes verify the layout when run in a disposable Linux environment.
const psLocation = process.env.PI_AGENT_BROWSER_TEST_PS ?? (systemPs ? "system" : "path");

test(`real POSIX ${psLocation} ps preserves process identity and lock integrity`, { skip: !["darwin", "linux"].includes(process.platform) }, async () => {
	assert.ok(["system", "path", "missing"].includes(psLocation));
	assert.equal(Boolean(systemPs), psLocation === "system", "test environment must have the requested real ps layout");
	const originalPath = process.env.PATH;
	if (psLocation !== "path") process.env.PATH = "";
	const sessionName = `piab-ps-${psLocation}-${process.pid}`;
	let lock: Awaited<ReturnType<typeof acquireManagedSessionPolicyLock>>;
	let recovered: typeof lock;
	try {
		if (psLocation === "missing") {
			assert.equal(await readProcessStartIdentity(process.pid), undefined);
			assert.equal(await acquireManagedSessionPolicyLock({ sessionName }), undefined);
			return;
		}
		const { stdout } = await promisify(execFile)(systemPs ?? "ps", ["-p", String(process.pid), "-o", "lstart="]);
		const expected = normalizeProcessStartIdentity(stdout);
		assert.ok(expected);
		const identity = await readProcessStartIdentity(process.pid);
		lock = await acquireManagedSessionPolicyLock({ sessionName });
		assert.deepEqual({ identity, lockAcquired: Boolean(lock) }, { identity: expected, lockAcquired: true });
		assert.equal(await readProcessStartIdentity(0), undefined);
		assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined, "a live owner must remain exclusive");

		const basePath = getManagedSessionPolicyLockPath(sessionName);
		const claimNames = (await readdir(dirname(basePath))).filter((name) => name.startsWith(`${basename(basePath)}.claim-`));
		assert.equal(claimNames.length, 1);
		const ownerPath = join(dirname(basePath), claimNames[0]!, "owner.json");
		const owner = JSON.parse(await readFile(ownerPath, "utf8"));
		assert.equal(owner.startIdentity, expected);
		// A live PID with a different recorded start time represents PID reuse, not a live lock owner.
		await writeFile(ownerPath, JSON.stringify({ ...owner, startIdentity: "different-process-start" }));
		recovered = await acquireManagedSessionPolicyLock({ sessionName });
		assert.ok(recovered, "a mismatched start identity must not strand the lock");
		assert.equal(existsSync(ownerPath), false);
	} finally {
		await recovered?.release();
		await lock?.release();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});
