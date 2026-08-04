/**
 * Purpose: Verify cross-process serialization for wrapper-owned daemon policy decisions.
 * Responsibilities: Assert bounded async contention, immutable-claim release, and proven-dead owner recovery.
 * Scope: The lock primitive only; browser orchestration coverage lives in extension tests.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
	acquireManagedSessionPolicyLock,
	getLegacyManagedSessionPolicyLockPath,
	getManagedSessionPolicyLockPath,
} from "../extensions/agent-browser/lib/managed-session-policy-lock.js";

const sessionName = `piab-policy-lock-${process.pid}`;
const lockBasePath = getManagedSessionPolicyLockPath(sessionName);
const legacyLockPath = getLegacyManagedSessionPolicyLockPath(sessionName);
const claimPrefix = `${basename(lockBasePath)}.claim-`;
const testOrphanPath = join(dirname(lockBasePath), `.pi-agent-browser-policy-remove-test-${process.pid}`);
const legacyCandidatePath = `${legacyLockPath}.candidate-test-${process.pid}`;

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
	await rm(legacyLockPath, { force: true, recursive: true });
	await rm(legacyCandidatePath, { force: true, recursive: true });
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
	const bridgeOwner = JSON.parse(await readFile(join(legacyLockPath, "owner.json"), "utf8")) as { version?: number };
	assert.equal(bridgeOwner.version, 3);
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
	await assert.rejects(stat(legacyLockPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("managed session policy lock interlocks with a live v2 owner", async () => {
	await mkdir(dirname(legacyLockPath), { recursive: true, mode: 0o700 });
	const processIdentityUrl = new URL("../extensions/agent-browser/lib/process-identity.ts", import.meta.url).href;
	const script = `import fs from "node:fs"; import { readProcessStartIdentity } from ${JSON.stringify(processIdentityUrl)}; const path = ${JSON.stringify(legacyLockPath)}; const startIdentity = await readProcessStartIdentity(process.pid); if (!startIdentity) process.exit(2); fs.mkdirSync(path, { mode: 0o700 }); const owner = { pid: process.pid, startIdentity, token: "legacy-owner", version: 2 }; fs.writeFileSync(path + "/owner.json", JSON.stringify(owner), { mode: 0o600 }); process.stdout.write("ready"); process.stdin.once("data", () => { fs.rmSync(path, { force: true, recursive: true }); process.exit(0); });`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
	const exited = once(child, "exit") as Promise<[number | null]>;
	await new Promise<void>((resolve, reject) => {
		child.stdout.once("data", (chunk: Buffer) => chunk.toString("utf8") === "ready" ? resolve() : reject(new Error(`Unexpected child output: ${chunk.toString("utf8")}`)));
		child.once("error", reject);
	});
	try {
		assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 }), undefined);
	} finally {
		child.stdin.end("release\n");
	}
	const [code] = await exited;
	assert.equal(code, 0, stderr);
	const current = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(current);
	await current.release();
});

test("managed session policy lock leaves abandoned v2 owners fail-closed", async () => {
	await mkdir(legacyLockPath, { recursive: true, mode: 0o700 });
	await writeFile(join(legacyLockPath, "owner.json"), JSON.stringify({ pid: 2_147_483_647, startIdentity: "dead", token: "legacy-dead", version: 2 }), { mode: 0o600 });
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined);
	assert.equal(JSON.parse(await readFile(join(legacyLockPath, "owner.json"), "utf8")).version, 2);
});

test("managed session policy lock waits through v2 stale-reclaim gaps", async () => {
	await mkdir(legacyCandidatePath, { recursive: true, mode: 0o700 });
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined);
	await assert.rejects(stat(legacyLockPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	await rm(legacyCandidatePath, { force: true, recursive: true });
	const lock = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(lock);
	await lock.release();
});

test("managed session policy lock cleans dead removal artifacts", async () => {
	await mkdir(testOrphanPath, { mode: 0o700 });
	await writeFile(join(testOrphanPath, "owner.json"), JSON.stringify({ pid: 2_147_483_647, startIdentity: "dead", token: "orphan", version: 3 }), { mode: 0o600 });
	const lock = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(lock);
	await assert.rejects(stat(testOrphanPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	await lock.release();
});

test("managed session policy lock fails closed without repairing unsafe owner permissions", async () => {
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	const claimPath = await onlyClaimPath();
	const ownerPath = join(claimPath, "owner.json");
	await chmod(ownerPath, 0o644);
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined);
	assert.equal((await stat(ownerPath)).mode & 0o777, 0o644);
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
