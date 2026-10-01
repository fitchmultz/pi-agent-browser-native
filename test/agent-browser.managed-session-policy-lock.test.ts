/**
 * Purpose: Verify cross-process serialization for wrapper-owned daemon policy decisions.
 * Responsibilities: Assert bounded async contention, immutable-claim release, and proven-dead owner recovery.
 * Scope: The lock primitive only; browser orchestration coverage lives in extension tests.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

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
const lockBasePath = getBrowserExecutionLockPath(await resolveBrowserExecutionIdentity({ sessionName, ownedManagedSession: true }));
test.after(async () => {
	if (originalSocketDir === undefined) delete process.env.PI_AGENT_BROWSER_SOCKET_DIR;
	else process.env.PI_AGENT_BROWSER_SOCKET_DIR = originalSocketDir;
	await rm(socketDir, { recursive: true, force: true });
});
const claimPrefix = `${basename(lockBasePath)}.claim-`;
const testOrphanPath = join(dirname(lockBasePath), `.pi-agent-browser-policy-remove-test-${process.pid}`);

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
	return paths[0] as string;
}

test.afterEach(async () => {
	for (const path of await claimPaths()) await rm(path, { force: true, recursive: true });
	await rm(testOrphanPath, { force: true, recursive: true });
});

test("managed session policy lock waits asynchronously and releases only its immutable claim", async () => {
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	let timerRan = false;
	const waiting = acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 });
	setTimeout(() => { timerRan = true; }, 5);
	assert.equal(await waiting, undefined);
	assert.equal(timerRan, true);

	const claimPath = await onlyClaimPath();
	const ownerPath = join(claimPath, "owner.json");
	const original = await readFile(ownerPath, "utf8");
	const replacement = JSON.stringify({ ...JSON.parse(original), token: "replacement-token" });
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
	const malformedPaths = malformedTokens.map((_, index) => join(dirname(lockBasePath), `.pi-agent-browser-policy-remove-malformed-${process.pid}-${index}-${randomUUID()}`));
	const fixtures = [{ path: testOrphanPath, token: "orphan" }, ...malformedPaths.map((path, index) => ({ path, token: malformedTokens[index]! }))];
	const ownerContents = new Map<string, string>();
	for (const fixture of fixtures) {
		await mkdir(fixture.path, { mode: 0o700 });
		const content = JSON.stringify({ pid: 2_147_483_647, startIdentity: "dead", token: fixture.token, sessionNames: null, version: 4 });
		ownerContents.set(fixture.path, content);
		await writeFile(join(fixture.path, "owner.json"), content, { mode: 0o600 });
	}

	const fixturePaths = new Set(fixtures.map(({ path }) => path));
	const inspected = new Set<string>();
	const renamed: Array<{ source: string; destination: string }> = [];
	const nativeLstat = fs.lstat;
	const nativeRename = fs.rename;
	t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		if (fixturePaths.has(String(args[0]))) inspected.add(String(args[0]));
		return nativeLstat(...args);
	});
	t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
		const source = String(args[0]);
		const destination = String(args[1]);
		if (fixturePaths.has(source)) renamed.push({ source, destination });
		return nativeRename(...args);
	});
	syncBuiltinESMExports();
	try {
		const candidates = (await readdir(dirname(lockBasePath))).filter((name) => name.startsWith(".pi-agent-browser-policy-remove-")
			|| /^\.pi-agent-browser-policy-[a-f0-9]{64}\.lock-v4\.(?:candidate|claim)-/.test(name));
		const maxAttempts = Math.ceil((candidates.length + 1) / 7) + 4;
		for (let attempt = 0; attempt < maxAttempts && inspected.size < fixturePaths.size; attempt += 1) {
			const lock = await acquireManagedSessionPolicyLock({ sessionName });
			assert.ok(lock);
			await lock.release();
		}
		assert.deepEqual([...inspected].sort(), [...fixturePaths].sort(), "GC must inspect every fixture before their outcomes are checked");
		assert.deepEqual(renamed.filter(({ source }) => malformedPaths.includes(source)), [], "malformed tokens must never reach native rename");
		for (const path of malformedPaths) {
			assert.equal(await readFile(join(path, "owner.json"), "utf8"), ownerContents.get(path));
			await stat(path);
		}
		assert.ok(renamed.some(({ source }) => source === testOrphanPath), "an ordinary opaque token still uses native rename cleanup");
		await assert.rejects(stat(testOrphanPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const { destination } of renamed) {
			if (!destination.includes("\0")) await rm(destination, { force: true, recursive: true });
		}
		for (const { path } of fixtures) await rm(path, { force: true, recursive: true });
	}
});

test("unrelated lock acquisitions bound and rotate GC without reclaiming live, young or ambiguous claims", async (t) => {
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	const liveOwner = JSON.parse(await readFile(join(await onlyClaimPath(), "owner.json"), "utf8"));
	await first.release();
	const paths: string[] = [];
	const old = new Date(Date.now() - 31 * 60 * 1_000);
	const triggerNamespace = `${sessionName}-gc`;
	try {
		for (let index = 0; index < 16; index += 1) {
			const token = randomUUID();
			const path = `${lockBasePath}.claim-${token}`;
			paths.push(path);
			await mkdir(path, { mode: 0o700 });
			const owner = { ...liveOwner, pid: index === 0 ? process.pid : 2_147_483_647, token };
			if (index === 2) owner.version = 2;
			if (index === 3) owner.startIdentity = "";
			await writeFile(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
			if (index !== 1) await utimes(path, old, old);
		}
		const exists = (path: string) => stat(path).then(() => true, () => false);
		const inspected = new Set<string>();
		const nativeLstat = fs.lstat;
		t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
			if (paths.includes(String(args[0]))) inspected.add(String(args[0]));
			return nativeLstat(...args);
		});
		syncBuiltinESMExports();
		let remaining = 12;
		for (let attempt = 0; attempt < 32 && remaining > 0; attempt += 1) {
			inspected.clear();
			const lock = await acquireManagedSessionPolicyLock({ sessionName, namespace: triggerNamespace });
			assert.ok(lock, "stale claims must not block a different session");
			await lock.release();
			assert.ok(inspected.size <= 8, "each acquisition inspects at most eight GC candidates, including retained ones");
			const after = (await Promise.all(paths.slice(4).map(exists))).filter(Boolean).length;
			assert.ok(remaining - after <= 8, "each acquisition may reclaim at most eight GC candidates");
			remaining = after;
		}
		assert.equal(remaining, 0, "unrelated acquisitions must eventually collect old dead claims");
		assert.deepEqual(await Promise.all(paths.slice(0, 4).map(exists)), [true, true, true, true]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const path of paths) await rm(path, { force: true, recursive: true });
	}
});

test("short-lived lock processes randomize GC past retained removal artifacts", async () => {
	const tag = randomUUID();
	const paths: string[] = [];
	try {
		for (let index = 0; index < 12; index += 1) {
			const token = `${tag}-${index}`;
			const path = join(dirname(lockBasePath), `.pi-agent-browser-policy-remove-${index < 8 ? "000" : "zzzz"}-${token}`);
			paths.push(path);
			await mkdir(path, { mode: 0o700 });
			await writeFile(join(path, "owner.json"), JSON.stringify({
				pid: 2_147_483_647, startIdentity: "dead", token, sessionNames: null, version: index < 8 ? 2 : 4,
			}), { mode: 0o600 });
		}
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
				import crypto from "node:crypto";
				import { syncBuiltinESMExports } from "node:module";
				// Control the random draw; assert actual reclamation below.
				crypto.randomInt = (max) => max - 1;
				syncBuiltinESMExports();
				const { acquireManagedSessionPolicyLock } = await import("./extensions/agent-browser/lib/managed-session-policy-lock.ts");
				const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} });
				if (!lock) throw new Error("unrelated acquisition failed");
				await lock.release();
				console.log(JSON.stringify({ done: true }));
			`], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
			const exited = once(child, "exit");
			try {
				assert.deepEqual(await readChildStdoutJsonLine(child), { done: true });
				assert.equal((await exited)[0], 0);
			} finally { await stopChildProcess(child); }
		}
		assert.deepEqual(await Promise.all(paths.map(path => stat(path).then(() => true, () => false))), [
			...Array(8).fill(true), ...Array(4).fill(false),
		]);
	} finally {
		for (const path of paths) await rm(path, { force: true, recursive: true });
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
		const owner = JSON.parse(await readFile(ownerPath, "utf8"));
		await writeFile(ownerPath, JSON.stringify({ ...owner, startIdentity: "" }));
	} else {
		await chmod(ownerPath, 0o644);
	}
	const unsafeOwner = await readFile(ownerPath, "utf8");
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined);
	assert.equal(await readFile(ownerPath, "utf8"), unsafeOwner);
	if (process.platform !== "win32") assert.equal((await stat(ownerPath)).mode & 0o777, 0o644);
	await first.release();
	await stat(claimPath);
});

test("managed session policy lock serializes concurrent contenders", async () => {
	let active = 0;
	let maxActive = 0;
	await Promise.all(Array.from({ length: 8 }, async () => {
		const lock = await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 1_000 });
		assert.ok(lock);
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;
		await lock.release();
	}));
	assert.equal(maxActive, 1);
});

for (const publicationRead of [1, 2]) {
	test(`managed session policy lock refreshes a choosing ticket published after missing read ${publicationRead}`, async (t) => {
		// Obtain real native owner identity, then model another live claim choosing
		// its ticket. Only filesystem interleaving is controlled, never identity results.
		const seed = await acquireManagedSessionPolicyLock({ sessionName });
		assert.ok(seed);
		const owner = JSON.parse(await readFile(join(await onlyClaimPath(), "owner.json"), "utf8"));
		await seed.release();
		owner.token = randomUUID();
		const choosingPath = `${lockBasePath}.claim-${owner.token}`;
		const ticketPath = join(choosingPath, "ticket.json");
		await mkdir(choosingPath, { mode: 0o700 });
		await writeFile(join(choosingPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
		const nativeLstat = fs.lstat;
		const nativeRename = fs.rename;
		let ownTicketPublished = false;
		let missingReads = 0;
		t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
			const result = await nativeRename(...args);
			if (String(args[1]).endsWith("ticket.json") && String(args[1]) !== ticketPath) ownTicketPublished = true;
			return result;
		});
		t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
			try { return await nativeLstat(...args); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" && String(args[0]) === ticketPath && ownTicketPublished) {
					missingReads += 1;
					if (missingReads === publicationRead) {
						const candidate = join(choosingPath, ".ticket.tmp");
						await writeFile(candidate, JSON.stringify({ ticket: 2, token: owner.token, version: 4 }), { mode: 0o600 });
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
			assert.equal(JSON.parse(await readFile(ticketPath, "utf8")).ticket, 2);
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
		if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
		const claimPath = await onlyClaimPath();
		const reader = await fs.open(join(claimPath, "owner.json"), "r");
		const nativeRename = fs.rename;
		let nativeConflict = false;
		t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
			try { return await nativeRename(...args); } catch (error) {
				if (String(args[0]) === claimPath && (error as NodeJS.ErrnoException).code === "EPERM") {
					nativeConflict = true;
					await reader.close(); // The actual competing reader finishes.
				}
				throw error; // Never fabricate or replace the native rename result.
			}
		});
		syncBuiltinESMExports();
		try {
			await lock.release();
			if (process.platform === "win32") assert.equal(nativeConflict, true);
			assert.deepEqual(await claimPaths(), []);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await reader.close();
		}
	});
}

test("managed session policy lock excludes a live owner in another process", async () => {
	const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-policy-lock.ts", import.meta.url).href;
	const script = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2); process.stdout.write("acquired\\n"); await new Promise((resolve) => process.stdin.once("data", resolve)); await lock.release();`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["pipe", "pipe", "pipe"] });
	const [chunk] = await once(child.stdout, "data") as [Buffer];
	assert.equal(chunk.toString("utf8"), "acquired\n");
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 }), undefined);
	child.stdin.end("release");
	const [code] = await once(child, "exit") as [number | null];
	assert.equal(code, 0);
	const recovered = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(recovered);
	await recovered.release();
});

test("competing cross-process reclaimers stay serialized after a stale claim", async () => {
	const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-policy-lock.ts", import.meta.url).href;
	const staleScript = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2);`;
	const stale = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", staleScript], { stdio: "ignore" });
	const [staleCode] = await once(stale, "exit") as [number | null];
	assert.equal(staleCode, 0);
	await onlyClaimPath();

	const logPath = join(dirname(lockBasePath), `${basename(lockBasePath)}.critical.log`);
	const contenderScript = `import fs from "node:fs"; import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)}, timeoutMs: 1000 }); if (!lock) process.exit(2); fs.appendFileSync(${JSON.stringify(logPath)}, "start:" + process.pid + "\\n"); await new Promise((resolve) => setTimeout(resolve, 25)); fs.appendFileSync(${JSON.stringify(logPath)}, "end:" + process.pid + "\\n"); await lock.release();`;
	try {
		const contenders = Array.from({ length: 4 }, () => {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", contenderScript], { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
			return { child, exit: once(child, "exit"), getStderr: () => stderr };
		});
		for (const contender of contenders) {
			const [code] = await contender.exit as [number | null];
			assert.equal(code, 0, contender.getStderr());
		}
		const lines = (await readFile(logPath, "utf8")).trim().split("\n");
		let active = 0;
		let maxActive = 0;
		for (const line of lines) {
			active += line.startsWith("start:") ? 1 : -1;
			maxActive = Math.max(maxActive, active);
			assert.ok(active >= 0);
		}
		assert.equal(active, 0);
		assert.equal(maxActive, 1);
	} finally {
		await rm(logPath, { force: true });
	}
});

test("managed session policy lock reclaims only the proven-dead immutable claim", async () => {
	const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-policy-lock.ts", import.meta.url).href;
	const script = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2); process.stdout.write("acquired");`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
	const [code] = await once(child, "exit") as [number | null];
	assert.equal(code, 0, stderr);
	assert.equal(stdout, "acquired");
	const staleClaimPath = await onlyClaimPath();

	const recovered = await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 250 });
	assert.ok(recovered);
	const liveClaimPath = await onlyClaimPath();
	assert.notEqual(liveClaimPath, staleClaimPath);
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 }), undefined);
	assert.deepEqual(await claimPaths(), [liveClaimPath]);
	await recovered.release();
});
