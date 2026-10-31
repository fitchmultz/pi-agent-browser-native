/**
 * Purpose: Avoid fresh native identity probes for immutable predecessors confirmed released.
 * Responsibilities: Force real release-after-scan races and retain conservative unknown-presence checks.
 * Scope: Acquisition ordering only; no identity results, process generations or native absence are fabricated.
 */
import assert from "node:assert/strict";
import childProcess, { spawn, type execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	acquireManagedSessionPolicyLock,
	getBrowserExecutionLockPath,
	resolveBrowserExecutionIdentity,
} from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { readProcessStartIdentity } from "../extensions/agent-browser/lib/process-identity.js";
import { readArray, readNumber, hasErrorCode } from "./helpers/assertions.js";
import { readChildStdoutJsonLine, stopChildProcess } from "./helpers/agent-browser-harness.js";

const nativeReadFile = fs.readFile;
const nativeLstat = fs.lstat;
const nativeExecFile = childProcess.execFile;
const moduleUrl = new URL(
	"../dist/extensions/agent-browser/lib/managed-session-policy-lock.js",
	import.meta.url,
).href;
const identityUrl = new URL(
	"../dist/extensions/agent-browser/lib/process-identity.js",
	import.meta.url,
).href;

interface PresenceObservation {
	readonly acquired: boolean;
	readonly ticketReads: number;
	readonly foreignProbes: number;
	readonly presenceFaults: number;
	readonly confirmedAbsences: number;
	readonly ownerBytes: Buffer;
	readonly ticketBytes: Buffer;
	readonly retainedOwner: Buffer | undefined;
	readonly retainedTicket: Buffer | undefined;
}

async function exercisePredecessorPresence(
	t: TestContext,
	presence: "released" | "EACCES" | "EPERM",
): Promise<PresenceObservation> {
	assert.equal(fs.readFile, nativeReadFile);
	assert.equal(fs.lstat, nativeLstat);
	assert.equal(childProcess.execFile, nativeExecFile);
	assert.ok((await readProcessStartIdentity(process.pid)) !== undefined);
	const sessionName = `piab-presence-${randomUUID()}`;
	const basePath = getBrowserExecutionLockPath(
		await resolveBrowserExecutionIdentity({
			sessionName,
			namespace: sessionName,
			ownedManagedSession: true,
		}),
	);
	const script = `
import assert from "node:assert/strict";
import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)};
import { readProcessStartIdentity } from ${JSON.stringify(identityUrl)};
const release = new Promise((resolve) => {
  let command = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    command += chunk;
    if (command.endsWith("\\n")) { assert.equal(command, "release\\n"); resolve(); }
  });
});
const ended = new Promise((resolve) => process.stdin.once("end", resolve));
assert.ok(await readProcessStartIdentity(process.pid));
const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)}, namespace: ${JSON.stringify(sessionName)}, timeoutMs: 1000 });
assert.ok(lock);
console.log(JSON.stringify({ acquired: true }));
await release;
await lock.release();
console.log(JSON.stringify({ released: true }));
// Stay alive after release so the old code must actually dispatch its needless generation query.
await ended;`;
	const holder = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = once(holder, "close");
	t.after(async () => {
		await stopChildProcess(holder);
		await closed;
		await Promise.all(
			(await fs.readdir(dirname(basePath)))
				.filter((name) => name.startsWith(`${basename(basePath)}.claim-`))
				.map(async (name) =>
					fs.rm(join(dirname(basePath), name), { recursive: true, force: true }),
				),
		);
	});
	assert.deepEqual(await readChildStdoutJsonLine(holder), { acquired: true });
	const holderPid = readNumber(holder.pid);
	const paths = (await fs.readdir(dirname(basePath)))
		.filter((name) => name.startsWith(`${basename(basePath)}.claim-`))
		.map((name) => join(dirname(basePath), name));
	assert.equal(paths.length, 1);
	const predecessor = paths[0];
	const ticketPath = join(predecessor, "ticket.json");
	const ownerBytes = await nativeReadFile(join(predecessor, "owner.json"));
	const ticketBytes = await nativeReadFile(ticketPath);
	let foreignProbes = 0;
	let ticketReads = 0;
	let releasePromise: Promise<void> | undefined;
	let pendingPresenceFault = false;
	let presenceFaults = 0;
	let confirmedAbsences = 0;
	let waiting: Awaited<ReturnType<typeof acquireManagedSessionPolicyLock>>;
	const releaseHolder = (): Promise<void> => {
		releasePromise ??= (async () => {
			const acknowledgement = readChildStdoutJsonLine(holder);
			holder.stdin.write("release\n");
			assert.deepEqual(await acknowledgement, { released: true });
		})();
		return releasePromise;
	};
	t.mock.method(
		childProcess,
		"execFile",
		(
			file: string,
			args: readonly string[],
			options: Parameters<typeof execFile>[2],
			callback: Parameters<typeof execFile>[3],
		) => {
			if (
				(args[0] === "-p" && args[1] === String(holderPid)) ||
				args.at(-1)?.includes(`Get-Process -Id ${holderPid} `) === true ||
				args.at(-1)?.includes(`GetProcessById(${holderPid})`) === true
			) {
				foreignProbes++;
			}
			// Forward all original arguments/results; no fabricated identity or helper executable.
			return nativeExecFile(file, args, options, callback);
		},
	);
	t.mock.method(fs, "readFile", async (...args: Readonly<Parameters<typeof fs.readFile>>) => {
		const value = await nativeReadFile(...args);
		// Linux reads the holder's kernel start ticks directly instead of launching ps.
		if (args[0] === `/proc/${String(holderPid)}/stat`) {
			foreignProbes++;
		}
		if (args[0] === ticketPath) {
			ticketReads++;
			// The first read is ticket publication's scan; the second is waitForTurn's scan.
			if (ticketReads >= 2) {
				if (presence === "released" && ticketReads === 2) {
					await releaseHolder();
					await assert.rejects(nativeLstat(predecessor), { code: "ENOENT" });
					assert.doesNotThrow(() => process.kill(holderPid, 0));
				} else if (presence !== "released") {
					pendingPresenceFault = true;
				}
			}
		}
		// Return the genuinely read ticket even though release may have completed meanwhile.
		return value;
	});
	t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
		if (args[0] === predecessor && pendingPresenceFault) {
			pendingPresenceFault = false;
			presenceFaults++;
			// Explicit fault injection only for unresolved metadata; ENOENT uses the real filesystem.
			throw Object.assign(new Error("controlled predecessor presence fault"), { code: presence });
		}
		try {
			return await nativeLstat(...args);
		} catch (error) {
			if (
				args[0] === predecessor &&
				presence === "released" &&
				ticketReads >= 2 &&
				hasErrorCode(error, "ENOENT")
			) {
				confirmedAbsences++;
			}
			throw error;
		}
	});
	syncBuiltinESMExports();
	try {
		waiting = await acquireManagedSessionPolicyLock({
			sessionName,
			namespace: sessionName,
			timeoutMs: 1000,
		});
		return {
			acquired: waiting !== undefined,
			ticketReads,
			foreignProbes,
			presenceFaults,
			confirmedAbsences,
			ownerBytes,
			ticketBytes,
			retainedOwner:
				presence === "released" ? undefined : await nativeReadFile(join(predecessor, "owner.json")),
			retainedTicket: presence === "released" ? undefined : await nativeReadFile(ticketPath),
		};
	} finally {
		t.mock.reset();
		fs.readFile = nativeReadFile;
		fs.lstat = nativeLstat;
		childProcess.execFile = nativeExecFile;
		syncBuiltinESMExports();
		await waiting?.release();
		await releaseHolder();
		holder.stdin.end();
		assert.equal(readArray(await closed)[0], 0);
	}
}

test("predecessor presence: confirmed native ENOENT skips a foreign probe", async (t) => {
	const observation = await exercisePredecessorPresence(t, "released");
	assert.ok(observation.ticketReads >= 2, "release must occur in the waiting scan");
	assert.equal(observation.acquired, true);
	assert.equal(observation.confirmedAbsences, 1);
	assert.equal(
		observation.foreignProbes,
		0,
		"an already released immutable predecessor needs no generation query",
	);
});

for (const code of ["EACCES", "EPERM"] as const) {
	test(`predecessor presence: ${code} remains conservative`, async (t) => {
		const observation = await exercisePredecessorPresence(t, code);
		assert.ok(observation.ticketReads >= 2, "the fault must occur after a complete waiting scan");
		assert.equal(observation.acquired, false);
		assert.ok(observation.presenceFaults > 0);
		assert.ok(
			observation.foreignProbes > 0,
			"unknown presence must not bypass fresh generation validation",
		);
		assert.deepEqual(observation.retainedOwner, observation.ownerBytes);
		assert.deepEqual(observation.retainedTicket, observation.ticketBytes);
	});
}
