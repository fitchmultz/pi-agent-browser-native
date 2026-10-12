/**
 * Purpose: Verify cross-process serialization for wrapper-owned daemon policy decisions.
 * Responsibilities: Assert bounded async contention, immutable-claim release, and proven-dead owner recovery.
 * Scope: The lock primitive only; browser orchestration coverage lives in extension tests.
 */

import assert from "node:assert/strict";
import { readRecord, readString, readArray, hasErrorCode } from "./helpers/assertions.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	acquireManagedSessionPolicyLock,
	getBrowserExecutionLockPath,
	resolveBrowserExecutionIdentity,
} from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { readChildStdoutJsonLine, stopChildProcess } from "./helpers/agent-browser-harness.js";

const sessionName = `piab-policy-lock-${process.pid}`;
const originalSocketDir = process.env.PI_AGENT_BROWSER_SOCKET_DIR;
const socketDir = await fs.mkdtemp(join(tmpdir(), "piab-policy-"));
process.env.PI_AGENT_BROWSER_SOCKET_DIR = socketDir;
const lockBasePath = getBrowserExecutionLockPath(
	await resolveBrowserExecutionIdentity({ sessionName, ownedManagedSession: true }),
);
test.after(async () => {
	if (originalSocketDir === undefined) {
		delete process.env.PI_AGENT_BROWSER_SOCKET_DIR;
	} else {
		process.env.PI_AGENT_BROWSER_SOCKET_DIR = originalSocketDir;
	}
	await rm(socketDir, { recursive: true, force: true });
});
const claimPrefix = `${basename(lockBasePath)}.claim-`;
const testOrphanPath = join(
	dirname(lockBasePath),
	`.pi-agent-browser-policy-remove-test-${process.pid}`,
);

async function claimPaths(): Promise<string[]> {
	try {
		return (await readdir(dirname(lockBasePath)))
			.filter((name) => name.startsWith(claimPrefix))
			.map((name) => join(dirname(lockBasePath), name));
	} catch {
		return [];
	}
}

async function onlyClaimPath(): Promise<string> {
	const paths = await claimPaths();
	assert.equal(paths.length, 1);
	return paths[0];
}

test.afterEach(async () => {
	for (const path of await claimPaths()) {
		// Finish task-owned native claim cleanup before subsequent acquisitions.
		// oxlint-disable-next-line no-await-in-loop
		await rm(path, { force: true, recursive: true });
	}
	await rm(testOrphanPath, { force: true, recursive: true });
});

test("managed session policy lock waits asynchronously and releases only its immutable claim", async () => {
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	let timerRan = false;
	const waiting = acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 });
	setTimeout(() => {
		timerRan = true;
	}, 5);
	assert.equal(await waiting, undefined);
	assert.equal(timerRan, true);

	const claimPath = await onlyClaimPath();
	const ownerPath = join(claimPath, "owner.json");
	const original = await readFile(ownerPath, "utf8");
	const replacement = JSON.stringify({
		...readRecord(JSON.parse(original)),
		token: "replacement-token",
	});
	await writeFile(ownerPath, replacement, "utf8");
	await first.release();
	assert.equal(await readFile(ownerPath, "utf8"), replacement);
	await rm(claimPath, { force: true, recursive: true });

	const next = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(next);
	await next.release();
	assert.deepEqual(await claimPaths(), []);
});

test("managed session policy lock retains malformed removal tokens and reclaims valid orphan artifacts", async (t) => {
	const malformedTokens = [
		`../../../piab-${randomUUID()}`,
		`..\\..\\..\\piab-${randomUUID()}`,
		`piab-${randomUUID()}\0suffix`,
	];
	const malformedPaths = malformedTokens.map((_, index) =>
		join(
			dirname(lockBasePath),
			`.pi-agent-browser-policy-remove-malformed-${process.pid}-${index}-${randomUUID()}`,
		),
	);
	const fixtures = [
		{ path: testOrphanPath, token: "orphan" },
		...malformedPaths.map((path, index) => ({ path, token: malformedTokens[index] })),
	];
	const ownerContents = new Map<string, string>();
	for (const fixture of fixtures) {
		// Publish each complete owner fixture in order within the shared GC namespace.
		// oxlint-disable-next-line no-await-in-loop
		await mkdir(fixture.path, { mode: 0o700 });
		const content = JSON.stringify({
			pid: 2_147_483_647,
			startIdentity: "dead",
			token: fixture.token,
			sessionNames: null,
			version: 4,
		});
		ownerContents.set(fixture.path, content);
		// Finish this directory's owner record before publishing the next GC candidate.
		// oxlint-disable-next-line no-await-in-loop
		await writeFile(join(fixture.path, "owner.json"), content, { mode: 0o600 });
	}

	const fixturePaths = new Set(fixtures.map(({ path }) => path));
	const inspected = new Set<string>();
	const renamed: Array<{ source: string; destination: string }> = [];
	const nativeLstat = fs.lstat;
	const nativeRename = fs.rename;
	t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
		if (fixturePaths.has(String(args[0]))) {
			inspected.add(String(args[0]));
		}
		return nativeLstat(...args);
	});
	t.mock.method(fs, "rename", async (...args: Readonly<Parameters<typeof fs.rename>>) => {
		const source = String(args[0]);
		const destination = String(args[1]);
		if (fixturePaths.has(source)) {
			renamed.push({ source, destination });
		}
		return nativeRename(...args);
	});
	syncBuiltinESMExports();
	try {
		const candidates = (await readdir(dirname(lockBasePath))).filter(
			(name) =>
				name.startsWith(".pi-agent-browser-policy-remove-") ||
				/^\.pi-agent-browser-policy-[a-f0-9]{64}\.lock-v4\.(?:candidate|claim)-/.test(name),
		);
		const maxAttempts = Math.ceil((candidates.length + 1) / 7) + 4;
		for (
			let attempt = 0;
			attempt < maxAttempts && inspected.size < fixturePaths.size;
			attempt += 1
		) {
			// Each acquisition/release advances the same bounded GC cursor.
			// oxlint-disable-next-line no-await-in-loop
			const lock = await acquireManagedSessionPolicyLock({ sessionName });
			// Every GC pass must acquire its lock; the final check requires all fixtures inspected.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(lock);
			// Release this acquisition before advancing the GC cursor again.
			// oxlint-disable-next-line no-await-in-loop
			await lock.release();
		}
		assert.deepEqual(
			[...inspected].sort(),
			[...fixturePaths].sort(),
			"GC must inspect every fixture before their outcomes are checked",
		);
		assert.deepEqual(
			renamed.filter(({ source }) => malformedPaths.includes(source)),
			[],
			"malformed tokens must never reach native rename",
		);
		for (const path of malformedPaths) {
			// Read each preserved owner before checking its bytes and existence.
			// oxlint-disable-next-line no-await-in-loop
			const ownerContent = await readFile(join(path, "owner.json"), "utf8");
			// Every fixed malformed owner must preserve its original bytes.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(ownerContent, ownerContents.get(path));
			// Complete this owner observation before inspecting the next fixture.
			// oxlint-disable-next-line no-await-in-loop
			await stat(path);
		}
		assert.ok(
			renamed.some(({ source }) => source === testOrphanPath),
			"an ordinary opaque token still uses native rename cleanup",
		);
		await assert.rejects(stat(testOrphanPath), (error: unknown) => hasErrorCode(error, "ENOENT"));
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const { destination } of renamed) {
			if (!destination.includes("\0")) {
				// Finish task-owned rename-destination cleanup before fixture-root cleanup.
				// oxlint-disable-next-line no-await-in-loop
				await rm(destination, { force: true, recursive: true });
			}
		}
		for (const { path } of fixtures) {
			// Remove task-owned fixtures after native mocks have been restored.
			// oxlint-disable-next-line no-await-in-loop
			await rm(path, { force: true, recursive: true });
		}
	}
});

test("unrelated lock acquisitions bound and rotate GC without reclaiming live, young or ambiguous claims", async (t) => {
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	const liveOwner = readRecord(
		JSON.parse(await readFile(join(await onlyClaimPath(), "owner.json"), "utf8")),
	);
	await first.release();
	const paths: string[] = [];
	const old = new Date(Date.now() - 31 * 60 * 1_000);
	const triggerNamespace = `${sessionName}-gc`;
	try {
		for (let index = 0; index < 16; index += 1) {
			const token = randomUUID();
			const path = `${lockBasePath}.claim-${token}`;
			paths.push(path);
			// Publish native GC candidates in directory/owner/timestamp order.
			// oxlint-disable-next-line no-await-in-loop
			await mkdir(path, { mode: 0o700 });
			const owner: Record<string, unknown> = {
				...liveOwner,
				pid: index === 0 ? process.pid : 2_147_483_647,
				token,
			};
			if (index === 2) {
				owner.version = 2;
			}
			if (index === 3) {
				owner.startIdentity = "";
			}
			// The owner must exist before this candidate can receive its stale timestamp.
			// oxlint-disable-next-line no-await-in-loop
			await writeFile(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
			if (index !== 1) {
				// Complete this stale candidate before publishing the next one.
				// oxlint-disable-next-line no-await-in-loop
				await utimes(path, old, old);
			}
		}
		const exists = (path: string) =>
			stat(path).then(
				() => true,
				() => false,
			);
		const inspected = new Set<string>();
		const nativeLstat = fs.lstat;
		t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
			if (paths.includes(String(args[0]))) {
				inspected.add(String(args[0]));
			}
			return nativeLstat(...args);
		});
		syncBuiltinESMExports();
		let remaining = 12;
		for (let attempt = 0; attempt < 32 && remaining > 0; attempt += 1) {
			inspected.clear();
			// Each acquisition advances one shared bounded GC experiment.
			// oxlint-disable-next-line no-await-in-loop
			const lock = await acquireManagedSessionPolicyLock({
				sessionName,
				namespace: triggerNamespace,
			});
			// Every pass must acquire; the final assertion requires eventual collection.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(lock, "stale claims must not block a different session");
			// Release the current lock before observing or starting the next GC pass.
			// oxlint-disable-next-line no-await-in-loop
			await lock.release();
			// Every pass must respect its independent inspection budget.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(
				inspected.size <= 8,
				"each acquisition inspects at most eight GC candidates, including retained ones",
			);
			// Observe this completed pass before advancing the shared GC experiment.
			// oxlint-disable-next-line no-await-in-loop
			const after = (await Promise.all(paths.slice(4).map(exists))).filter(Boolean).length;
			// Every pass must also respect its deletion budget; final checks require collection.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(remaining - after <= 8, "each acquisition may reclaim at most eight GC candidates");
			remaining = after;
		}
		assert.equal(remaining, 0, "unrelated acquisitions must eventually collect old dead claims");
		assert.deepEqual(await Promise.all(paths.slice(0, 4).map(exists)), [true, true, true, true]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const path of paths) {
			// Remove task-owned candidates after native mocks and acquisitions have finished.
			// oxlint-disable-next-line no-await-in-loop
			await rm(path, { force: true, recursive: true });
		}
	}
});

test("an uncontended acquisition survives opportunistic GC that outlasts its wait budget", async (t) => {
	await mkdir(testOrphanPath, { mode: 0o700 });
	await writeFile(
		join(testOrphanPath, "owner.json"),
		JSON.stringify({
			pid: 2_147_483_647,
			startIdentity: "dead",
			token: "orphan",
			sessionNames: null,
			version: 4,
		}),
		{ mode: 0o600 },
	);
	// Loaded hosts can make native GC probes outlast the default wait; model that with a slow
	// inspection of one unrelated orphan, longer than the requested budget.
	const nativeLstat = fs.lstat;
	const gc = { orphanInspected: false };
	t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
		if (String(args[0]) === testOrphanPath) {
			gc.orphanInspected = true;
			await delay(150);
		}
		return nativeLstat(...args);
	});
	syncBuiltinESMExports();
	try {
		// GC rotates through at most eight shared candidates per acquisition.
		for (let attempt = 0; attempt < 16 && !gc.orphanInspected; attempt += 1) {
			// Each acquisition advances the shared GC cursor before the next attempt.
			// oxlint-disable-next-line no-await-in-loop
			const lock = await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 });
			// Every uncontended pass must acquire, including the one whose GC overran the budget.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(lock, "opportunistic GC must not revoke an uncontended acquisition");
			// Release before the next GC pass.
			// oxlint-disable-next-line no-await-in-loop
			await lock.release();
		}
		assert.equal(gc.orphanInspected, true, "GC must reach the slow orphan");
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("short-lived lock processes randomize GC past retained removal artifacts", async () => {
	const tag = randomUUID();
	const paths: string[] = [];
	try {
		for (let index = 0; index < 12; index += 1) {
			const token = `${tag}-${index}`;
			const path = join(
				dirname(lockBasePath),
				`.pi-agent-browser-policy-remove-${index < 8 ? "000" : "zzzz"}-${token}`,
			);
			paths.push(path);
			// Publish each shared GC candidate's directory before its owner record.
			// oxlint-disable-next-line no-await-in-loop
			await mkdir(path, { mode: 0o700 });
			// Complete this candidate before publishing the next native GC fixture.
			// oxlint-disable-next-line no-await-in-loop
			await writeFile(
				join(path, "owner.json"),
				JSON.stringify({
					pid: 2_147_483_647,
					startIdentity: "dead",
					token,
					sessionNames: null,
					version: index < 8 ? 2 : 4,
				}),
				{ mode: 0o600 },
			);
		}
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
				import crypto from "node:crypto";
				import { syncBuiltinESMExports } from "node:module";
				// Control the random draw; assert actual reclamation below.
				crypto.randomInt = (max) => max - 1;
				syncBuiltinESMExports();
				const { acquireManagedSessionPolicyLock } = await import("./dist/extensions/agent-browser/lib/managed-session-policy-lock.js");
				const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} });
				if (!lock) throw new Error("unrelated acquisition failed");
				await lock.release();
				console.log(JSON.stringify({ done: true }));
			`,
				],
				{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
			);
			const exited = once(child, "exit");
			try {
				// Read this GC process's receipt before starting its successor.
				// oxlint-disable-next-line no-await-in-loop
				const receipt = await readChildStdoutJsonLine(child);
				// Every one of the four fixed GC passes must report success.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(receipt, { done: true });
				// Join this GC process's exit before starting its successor.
				// oxlint-disable-next-line no-await-in-loop
				const [exitCode] = readArray(await exited);
				// Every one of the four fixed GC passes must exit successfully.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(exitCode, 0);
			} finally {
				// Reap this task-owned GC process before starting its successor.
				// oxlint-disable-next-line no-await-in-loop
				await stopChildProcess(child);
			}
		}
		assert.deepEqual(
			await Promise.all(
				paths.map((path) =>
					stat(path).then(
						() => true,
						() => false,
					),
				),
			),
			[...Array.from({ length: 8 }, () => true), ...Array.from({ length: 4 }, () => false)],
		);
	} finally {
		for (const path of paths) {
			// Remove task-owned candidates after all short-lived native processes have finished.
			// oxlint-disable-next-line no-await-in-loop
			await rm(path, { force: true, recursive: true });
		}
	}
});

test("managed session policy lock fails closed without repairing unsafe owner metadata or POSIX permissions", async () => {
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	const claimPath = await onlyClaimPath();
	const ownerPath = join(claimPath, "owner.json");
	if (process.platform === "win32") {
		// chmod cannot express POSIX group/world access on Windows. Corrupt
		// the required identity instead and retain the same fail-closed contract.
		const owner = readRecord(JSON.parse(await readFile(ownerPath, "utf8")));
		await writeFile(ownerPath, JSON.stringify({ ...owner, startIdentity: "" }));
	} else {
		await chmod(ownerPath, 0o644);
	}
	const unsafeOwner = await readFile(ownerPath, "utf8");
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined);
	assert.equal(await readFile(ownerPath, "utf8"), unsafeOwner);
	if (process.platform !== "win32") {
		// POSIX permissions must remain unchanged; Windows checks corrupt identity instead.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal((await stat(ownerPath)).mode & 0o777, 0o644);
	}
	await first.release();
	await stat(claimPath);
});

for (const publicationRead of [1, 2]) {
	test(`managed session policy lock refreshes a choosing ticket published after missing read ${publicationRead}`, async (t) => {
		// Obtain real native owner identity, then model another live claim choosing
		// its ticket. Only filesystem interleaving is controlled, never identity results.
		const seed = await acquireManagedSessionPolicyLock({ sessionName });
		assert.ok(seed);
		const owner = readRecord(
			JSON.parse(await readFile(join(await onlyClaimPath(), "owner.json"), "utf8")),
		);
		await seed.release();
		owner.token = randomUUID();
		const choosingPath = `${lockBasePath}.claim-${readString(owner.token)}`;
		const ticketPath = join(choosingPath, "ticket.json");
		await mkdir(choosingPath, { mode: 0o700 });
		await writeFile(join(choosingPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
		const nativeLstat = fs.lstat;
		const nativeRename = fs.rename;
		let ownTicketPublished = false;
		let missingReads = 0;
		t.mock.method(fs, "rename", async (...args: Readonly<Parameters<typeof fs.rename>>) => {
			await nativeRename(...args);
			if (String(args[1]).endsWith("ticket.json") && String(args[1]) !== ticketPath) {
				ownTicketPublished = true;
			}
			return;
		});
		t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
			try {
				return await nativeLstat(...args);
			} catch (error) {
				if (hasErrorCode(error, "ENOENT") && String(args[0]) === ticketPath && ownTicketPublished) {
					missingReads += 1;
					if (missingReads === publicationRead) {
						const candidate = join(choosingPath, ".ticket.tmp");
						await writeFile(
							candidate,
							JSON.stringify({ ticket: 2, token: owner.token, version: 4 }),
							{ mode: 0o600 },
						);
						await nativeRename(candidate, ticketPath);
					}
				}
				throw error; // Preserve the actual missing-file observation.
			}
		});
		syncBuiltinESMExports();
		try {
			// No waiting is needed once the later ticket is published. A stale
			// choosing snapshot must not consume even an immediate wait budget.
			const lock = await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 0 });
			assert.ok(lock, "a completed later ticket must not block the earlier ticket");
			assert.equal(missingReads, publicationRead);
			await lock.release();
			assert.deepEqual(await claimPaths(), [choosingPath]);
			assert.equal(readRecord(JSON.parse(await readFile(ticketPath, "utf8"))).ticket, 2);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});
}

for (const holdMs of [0, 1_100]) {
	test(`managed session policy lock releases after a native open-file rename conflict ${holdMs === 0 ? "within" : "after"} its acquisition wait`, async (t) => {
		const lock = await acquireManagedSessionPolicyLock({ sessionName });
		assert.ok(lock);
		// A protected native close can outlast the default 1,000 ms acquisition wait.
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() + holdMs });
		const claimPath = await onlyClaimPath();
		const reader = await fs.open(join(claimPath, "owner.json"), "r");
		const nativeRename = fs.rename;
		let nativeConflict = false;
		t.mock.method(fs, "rename", async (...args: Readonly<Parameters<typeof fs.rename>>) => {
			try {
				await nativeRename(...args);
				return;
			} catch (error) {
				if (String(args[0]) === claimPath && hasErrorCode(error, "EPERM")) {
					nativeConflict = true;
					await reader.close(); // The actual competing reader finishes.
				}
				throw error; // Never fabricate or replace the native rename result.
			}
		});
		syncBuiltinESMExports();
		try {
			await lock.release();
			if (process.platform === "win32") {
				// Windows native rename reports this conflict; common winner-ticket checks still run.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(nativeConflict, true);
			}
			assert.deepEqual(await claimPaths(), []);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await reader.close();
		}
	});
}

test("managed session policy lock replaces only a proven-dead claim and excludes its live successor", async (t) => {
	const moduleUrl = new URL(
		"../dist/extensions/agent-browser/lib/managed-session-policy-lock.js",
		import.meta.url,
	).href;
	const acquire = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2);`;
	const stale = spawn(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`${acquire} console.log(JSON.stringify({ acquired: true }));`,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(async () => {
		await stopChildProcess(stale);
	});
	const staleExit = once(stale, "exit");
	assert.deepEqual(await readChildStdoutJsonLine(stale), { acquired: true });
	assert.equal(readArray(await staleExit)[0], 0);
	const staleClaimPath = await onlyClaimPath();
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`${acquire} console.log(JSON.stringify({ acquired: true })); await new Promise((resolve) => process.stdin.once("data", resolve)); await lock.release();`,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	t.after(async () => {
		await stopChildProcess(child);
	});
	const childExit = once(child, "exit");
	assert.deepEqual(await readChildStdoutJsonLine(child), { acquired: true });
	const liveClaimPath = await onlyClaimPath();
	assert.notEqual(liveClaimPath, staleClaimPath);
	await assert.rejects(stat(staleClaimPath), { code: "ENOENT" });
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 }), undefined);
	assert.deepEqual(await claimPaths(), [liveClaimPath]);
	child.stdin.end("release");
	assert.equal(readArray(await childExit)[0], 0);
	const recovered = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(recovered);
	await recovered.release();
	assert.deepEqual(await claimPaths(), []);
});

test("competing cross-process reclaimers stay serialized after a stale claim", async (t) => {
	const moduleUrl = new URL(
		"../dist/extensions/agent-browser/lib/managed-session-policy-lock.js",
		import.meta.url,
	).href;
	const staleScript = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2);`;
	const stale = spawn(process.execPath, ["--input-type=module", "--eval", staleScript], {
		stdio: "ignore",
	});
	const [staleCode] = readArray(await once(stale, "exit"));
	assert.equal(staleCode, 0);
	await onlyClaimPath();

	const logPath = join(dirname(lockBasePath), `${basename(lockBasePath)}.critical.log`);
	const contenderScript = `import fs from "node:fs"; import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)}, timeoutMs: 1000 }); if (!lock) process.exit(2); fs.appendFileSync(${JSON.stringify(logPath)}, "start:" + process.pid + "\\n"); await new Promise((resolve) => setTimeout(resolve, 25)); fs.appendFileSync(${JSON.stringify(logPath)}, "end:" + process.pid + "\\n"); await lock.release();`;
	try {
		const contenders = Array.from({ length: 4 }, () => {
			const child = spawn(process.execPath, ["--input-type=module", "--eval", contenderScript], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk: unknown) => {
				assert.ok(Buffer.isBuffer(chunk));
				stderr += chunk.toString("utf8");
			});
			t.after(async () => {
				await stopChildProcess(child);
			});
			return { child, exit: once(child, "exit"), getStderr: () => stderr };
		});
		for (const contender of contenders) {
			// These contenders already run concurrently; join their exits before reading the journal.
			// oxlint-disable-next-line no-await-in-loop
			const [code] = readArray(await contender.exit);
			// Every fixed contender must exit successfully.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(code, 0, contender.getStderr());
		}
		const lines = (await readFile(logPath, "utf8")).trim().split("\n");
		let active = 0;
		let maxActive = 0;
		for (const line of lines) {
			active += line.startsWith("start:") ? 1 : -1;
			maxActive = Math.max(maxActive, active);
			// Every journal transition must keep ownership nonnegative; final checks require balance.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(active >= 0);
		}
		assert.equal(active, 0);
		assert.equal(maxActive, 1);
	} finally {
		await rm(logPath, { force: true });
	}
});
