/**
 * Purpose: Verify cross-process serialization for wrapper-owned daemon policy decisions.
 * Responsibilities: Assert bounded async contention, immutable-claim release, and proven-dead owner recovery.
 * Scope: The lock primitive only; browser orchestration coverage lives in extension tests.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
	acquireManagedSessionPolicyLock,
	getBrowserExecutionLockPath,
	resolveBrowserExecutionIdentity,
} from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { buildProcessStartIdentityCommands } from "../extensions/agent-browser/lib/process-identity.js";

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

test("managed session policy lock cleans dead removal artifacts", async () => {
	await mkdir(testOrphanPath, { mode: 0o700 });
	await writeFile(join(testOrphanPath, "owner.json"), JSON.stringify({ pid: 2_147_483_647, startIdentity: "dead", token: "orphan", sessionNames: null, version: 4 }), { mode: 0o600 });
	const lock = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(lock);
	await assert.rejects(stat(testOrphanPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	await lock.release();
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

for (const publication of ["later", "earlier", "disappearance", "cleanup-disappearance", "cleanup-live", "unknown", "malformed", "mismatch", "abort"] as const) {
	test(`managed session policy lock handles ${publication} during a distinct live owner's native identity query`, { timeout: 15_000 }, async (t) => {
		const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-policy-lock.ts", import.meta.url).href;
		const script = `import fs from "node:fs/promises"; import { basename, dirname, join } from "node:path"; import { acquireManagedSessionPolicyLock, resolveBrowserExecutionIdentity, getBrowserExecutionLockPath } from ${JSON.stringify(moduleUrl)}; const sessionName = ${JSON.stringify(sessionName)}; const seed = await acquireManagedSessionPolicyLock({ sessionName }); if (!seed) process.exit(2); const base = getBrowserExecutionLockPath(await resolveBrowserExecutionIdentity({ sessionName, ownedManagedSession: true })); const path = (await fs.readdir(dirname(base))).find(name => name.startsWith(basename(base) + ".claim-")); const owner = JSON.parse(await fs.readFile(join(dirname(base), path, "owner.json"), "utf8")); await seed.release(); process.send(owner); await new Promise(resolve => process.stdin.once("data", resolve));`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
		const exit = once(child, "exit");
		let stderr = "";
		child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exit;
		});
		const [owner] = await Promise.race([once(child, "message"), exit.then(([code]) => assert.fail(`seed owner exited ${code}: ${stderr}`))]) as [{ pid: number; token: string; startIdentity: string }];
		assert.notEqual(owner.pid, process.pid);
		assert.deepEqual(await claimPaths(), []);
		const choosingPath = publication.startsWith("cleanup-") ? testOrphanPath : `${lockBasePath}.claim-${owner.token}`;
		await mkdir(choosingPath, { mode: 0o700 });
		const ownerContent = JSON.stringify(owner);
		await writeFile(join(choosingPath, "owner.json"), ownerContent, { mode: 0o600 });
		if (publication === "earlier") await writeFile(join(choosingPath, "ticket.json"), JSON.stringify({ ticket: 1, token: owner.token, version: 4 }), { mode: 0o600 });
		const nativeExecFile = childProcess.execFile;
		const ownerCommands = buildProcessStartIdentityCommands(owner.pid);
		let queryStarted!: () => void;
		const startedQuery = new Promise<void>(resolve => { queryStarted = resolve; });
		const queries: Array<{ error: string | number | null; errorName?: string; signal?: string; stdout: string; elapsed: number; timeout?: number }> = [];
		const queryCompletions: Promise<void>[] = [];
		t.mock.method(childProcess, "execFile", (file: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding, callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
			if (!ownerCommands.some(command => command.file === file && command.args.length === args.length
				&& command.args.every((arg, index) => arg === args[index]))) return nativeExecFile(file, args, options, callback);
			// Delay only the predecessor's real native helper, retaining execFile's
			// deadline/AbortSignal and genuine PID/start output (never a supplied identity).
			const source = `setTimeout(() => { const { execFileSync } = require("node:child_process"); process.stdout.write(execFileSync(${JSON.stringify(file)}, ${JSON.stringify(args)})); }, 1250);`;
			const started = Date.now();
			const query = nativeExecFile(process.execPath, ["--eval", source], options, (error, stdout, stderr) => {
				queries.push({ error: error?.code ?? null, errorName: error?.name, signal: error?.signal ?? undefined, stdout, elapsed: Date.now() - started, timeout: options.timeout });
				callback(error, stdout, stderr);
			});
			queryCompletions.push(new Promise(resolve => query.once("close", () => resolve())));
			queryStarted();
			return query;
		});
		syncBuiltinESMExports();
		const controller = new AbortController();
		let lock;
		try {
			const started = Date.now();
			const waiting = acquireManagedSessionPolicyLock({ sessionName, signal: controller.signal }); // Public default 1,000ms.
			await Promise.race([startedQuery, waiting.then(() => assert.fail("the predecessor native query was not reached"))]);
			if (publication === "disappearance" || publication === "cleanup-disappearance") await rm(choosingPath, { recursive: true });
			else if (publication === "abort") controller.abort();
			else if (publication !== "unknown" && publication !== "cleanup-live") {
				const candidate = join(choosingPath, ".ticket.tmp");
				await writeFile(candidate, publication === "malformed" ? "{" : JSON.stringify({
					ticket: publication === "earlier" ? 1 : 2,
					token: publication === "mismatch" ? "different-token" : owner.token,
					version: 4,
				}), { mode: 0o600 });
				if (publication === "earlier") {
					const ownPath = (await claimPaths()).find(path => path !== choosingPath)!;
					const ownTicket = JSON.parse(await readFile(join(ownPath, "ticket.json"), "utf8"));
					assert.ok(ownTicket.ticket > 1, "the live control must actually precede the waiter");
				}
				await fs.rename(candidate, join(choosingPath, "ticket.json"));
			}
			lock = await waiting;
			const elapsed = Date.now() - started;
			t.diagnostic(JSON.stringify({ publication, elapsed, acquired: !!lock, owner, queries }));
			if (publication === "later" || publication === "disappearance" || publication === "cleanup-disappearance") {
				assert.ok(lock, "an obsolete predecessor query must not consume the default acquisition budget");
				assert.ok(elapsed < 1_000, `acquisition took ${elapsed}ms`);
				assert.equal(queries[0]?.error, "ABORT_ERR");
			} else {
				assert.equal(lock, undefined);
				if (publication !== "abort") assert.ok(elapsed >= 1_000, "unvalidated or preceding claims must not cancel the query");
			}
			assert.ok(queries.length > 0);
			assert.equal(queries[0]?.stdout, "");
			process.kill(owner.pid, 0);
			await lock?.release();
			lock = undefined;
			if (publication === "disappearance" || publication === "cleanup-disappearance") {
				assert.deepEqual(await claimPaths(), []);
				await assert.rejects(stat(choosingPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
			} else {
				assert.deepEqual(await claimPaths(), publication === "cleanup-live" ? [] : [choosingPath]);
				assert.equal(await readFile(join(choosingPath, "owner.json"), "utf8"), ownerContent);
			}
		} finally {
			controller.abort();
			await Promise.all(queryCompletions);
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await lock?.release();
			child.stdin!.end("done");
			await exit;
		}
	});
}

// Windows controls require the actual native sharing conflict, not an injected EPERM.
for (const outcome of process.platform === "win32" ? ["released", "aborted", "token-changed", "malformed", "destination", "busy"] : ["released"]) {
	test(`managed session policy lock handles ${outcome} during native publication sharing contention`, async (t) => {
		const nativeWriteFile = fs.writeFile;
		const nativeRename = fs.rename;
		const controller = new AbortController();
		let reader: Awaited<ReturnType<typeof fs.open>> | undefined;
		let candidatePath: string | undefined;
		let collisionPath: string | undefined;
		let nativeConflict = false;
		t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
			await nativeWriteFile(...args);
			const path = String(args[0]);
			if (path.startsWith(`${lockBasePath}.candidate-`) && path.endsWith("owner.json")) {
				candidatePath = dirname(path);
				reader = await fs.open(path, "r"); // A concurrent cleanup scan reads this same file.
			}
		});
		t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
			try { return await nativeRename(...args); } catch (error) {
				if (String(args[0]) === candidatePath && (error as NodeJS.ErrnoException).code === "EPERM") {
					nativeConflict = true;
					if (outcome !== "busy") await reader!.close();
					if (outcome === "aborted") controller.abort();
					if (outcome === "token-changed" || outcome === "malformed") {
						const path = join(candidatePath!, "owner.json");
						const owner = JSON.parse(await readFile(path, "utf8"));
						await nativeWriteFile(path, outcome === "malformed" ? "{" : JSON.stringify({ ...owner, token: "replacement" }));
					}
					if (outcome === "destination") {
						collisionPath = String(args[1]);
						await mkdir(collisionPath);
						await nativeWriteFile(join(collisionPath, "collision"), "untouched");
					}
				}
				throw error; // Preserve the actual native conflict, not a supplied result.
			}
		});
		syncBuiltinESMExports();
		let lock;
		try {
			lock = await acquireManagedSessionPolicyLock({ sessionName, signal: controller.signal }); // Unchanged default 1,000ms.
			if (outcome === "released") {
				assert.ok(lock, "publication must survive a competing reader finishing within the deadline");
				await lock.release();
			} else assert.equal(lock, undefined, "unsafe, cancelled or still-busy publication must not admit execution");
			if (process.platform === "win32") assert.equal(nativeConflict, true, "the real native conflict must be reached");
			if (collisionPath) assert.equal(await readFile(join(collisionPath, "collision"), "utf8"), "untouched");
			else assert.deepEqual(await claimPaths(), []);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await reader?.close();
			await lock?.release();
			if (candidatePath) await rm(candidatePath, { recursive: true, force: true });
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

// Model Windows startup latency on POSIX; Windows already uses real PowerShell.
for (const identityDelayMs of process.platform === "win32" ? [0] : [0, 350, 550]) {
	test(`competing cross-process reclaimers stay serialized after a stale claim with ${identityDelayMs}ms native identity startup`, async () => {
		const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-policy-lock.ts", import.meta.url).href;
		const staleScript = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2);`;
		const stale = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", staleScript], { stdio: "ignore" });
		const [staleCode] = await once(stale, "exit") as [number | null];
		assert.equal(staleCode, 0);
		await onlyClaimPath();

		const logPath = join(dirname(lockBasePath), `${basename(lockBasePath)}.critical.log`);
		const contenderScript = `import fs from "node:fs"; import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const started = Date.now(); const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)}, timeoutMs: 1000 }); if (!lock) { console.error(JSON.stringify({ phase: "acquisition", pid: process.pid, elapsed: Date.now() - started })); process.exit(2); } fs.appendFileSync(${JSON.stringify(logPath)}, "start:" + process.pid + "\\n"); await new Promise((resolve) => setTimeout(resolve, 25)); fs.appendFileSync(${JSON.stringify(logPath)}, "end:" + process.pid + "\\n"); await lock.release();`;
		try {
			const contenders = Array.from({ length: 4 }, () => {
				const child = spawn(process.execPath, ["--import", "tsx", "--import", new URL("./helpers/native-identity-startup.mjs", import.meta.url).href, "--input-type=module", "--eval", contenderScript], {
					env: { ...process.env, PIAB_TEST_IDENTITY_DELAY_MS: String(identityDelayMs) },
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
				return { exit: once(child, "exit"), getStderr: () => stderr };
			});
			const exits = await Promise.all(contenders.map(contender => contender.exit));
			for (const [index, [code]] of exits.entries()) {
				assert.equal(code, 0, contenders[index]?.getStderr());
			}
			const lines = (await readFile(logPath, "utf8")).trim().split("\n");
			assert.equal(lines.length, 8, "all four contenders must enter and leave");
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
}

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
