/**
 * Purpose: Verify cross-process serialization for wrapper-owned daemon policy decisions.
 * Responsibilities: Assert bounded async contention, immutable-claim release, and proven-dead owner recovery.
 * Scope: The lock primitive only; browser orchestration coverage lives in extension tests.
 */

import assert from "node:assert/strict";
import {
	readRecord,
	readString,
	readNumber,
	readArray,
	hasErrorCode,
} from "./helpers/assertions.js";
import childProcess, { spawn, type execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net, { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	acquireManagedSessionPolicyLock,
	getBrowserExecutionLockPath,
	resolveBrowserExecutionIdentity,
} from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import {
	openClaimEndpoint,
	subscribeClaimEndpoint,
} from "../extensions/agent-browser/lib/browser-execution-claim-endpoint.js";
import { cleanDeadPolicyArtifacts } from "../extensions/agent-browser/lib/browser-execution-claim-storage.js";
import { getErrorCode } from "../extensions/agent-browser/lib/process-errors.js";
import {
	ensureCoordinationDirectory,
	getCoordinationDirectory,
} from "../extensions/agent-browser/lib/browser-execution-identity.js";
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

// Every process's opportunistic GC sweeps the shared coordination directory, so other test runs
// and Pi sessions can reclaim a dead-owner fixture there first. GC rule tests run the production
// sweep on a private directory instead.
async function privateGcDirectory(t: TestContext): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "piab-policy-gc-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	return directory;
}

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
	const directory = await privateGcDirectory(t);
	const malformedTokens = [
		`../../../piab-${randomUUID()}`,
		`..\\..\\..\\piab-${randomUUID()}`,
		`piab-${randomUUID()}\0suffix`,
	];
	const orphanPath = join(directory, ".pi-agent-browser-policy-remove-test");
	const malformedPaths = malformedTokens.map((_, index) =>
		join(directory, `.pi-agent-browser-policy-remove-malformed-${index}`),
	);
	const fixtures = [
		{ path: orphanPath, token: "orphan" },
		...malformedPaths.map((path, index) => ({ path, token: malformedTokens[index] })),
	];
	const ownerContents = new Map<string, string>();
	for (const fixture of fixtures) {
		// Publish each complete owner fixture in order within the private GC directory.
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
		for (let pass = 0; pass < fixtures.length && inspected.size < fixturePaths.size; pass += 1) {
			// Each production sweep advances the process-wide bounded GC cursor.
			// oxlint-disable-next-line no-await-in-loop
			await cleanDeadPolicyArtifacts(directory, {});
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
			renamed.some(({ source }) => source === orphanPath),
			"an ordinary opaque token still uses native rename cleanup",
		);
		await assert.rejects(stat(orphanPath), (error: unknown) => hasErrorCode(error, "ENOENT"));
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const { destination } of renamed) {
			if (!destination.includes("\0")) {
				// A regression could rename a malformed token outside the private directory.
				// oxlint-disable-next-line no-await-in-loop
				await rm(destination, { force: true, recursive: true });
			}
		}
	}
});

test("bounded policy GC passes rotate without reclaiming live, young or ambiguous claims", async (t) => {
	const directory = await privateGcDirectory(t);
	const first = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(first);
	const liveOwner = readRecord(
		JSON.parse(await readFile(join(await onlyClaimPath(), "owner.json"), "utf8")),
	);
	await first.release();
	const paths: string[] = [];
	const old = new Date(Date.now() - 31 * 60 * 1_000);
	for (let index = 0; index < 16; index += 1) {
		const token = randomUUID();
		const path = join(directory, `${basename(lockBasePath)}.claim-${token}`);
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
	try {
		let remaining = 12;
		for (let pass = 0; pass < 32 && remaining > 0; pass += 1) {
			inspected.clear();
			// Each production sweep advances one shared bounded GC experiment.
			// oxlint-disable-next-line no-await-in-loop
			await cleanDeadPolicyArtifacts(directory, {});
			// Every pass must respect its independent inspection budget.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(
				inspected.size <= 8,
				"each pass inspects at most eight GC candidates, including retained ones",
			);
			// Observe this completed pass before advancing the shared GC experiment.
			// oxlint-disable-next-line no-await-in-loop
			const after = (await Promise.all(paths.slice(4).map(exists))).filter(Boolean).length;
			// Every pass must also respect its deletion budget; final checks require collection.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(remaining - after <= 8, "each pass may reclaim at most eight GC candidates");
			remaining = after;
		}
		assert.equal(remaining, 0, "rotating passes must eventually collect old dead claims");
		assert.deepEqual(await Promise.all(paths.slice(0, 4).map(exists)), [true, true, true, true]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("an uncontended acquisition survives opportunistic GC that outlasts its wait budget", async (t) => {
	// Loaded hosts can make native GC probes outlast the default wait; model that with one slow
	// inspection of an unrelated entry, longer than the requested budget. GC never reclaims a young
	// claim, so no process can remove this unrelated fixture while the test runs.
	const unrelatedToken = randomUUID();
	const unrelatedClaimPath = `${getBrowserExecutionLockPath({ socketContext: join(socketDir, "gc-fixture") })}.claim-${unrelatedToken}`;
	await mkdir(unrelatedClaimPath, { mode: 0o700 });
	await writeFile(
		join(unrelatedClaimPath, "owner.json"),
		JSON.stringify({
			pid: 2_147_483_647,
			startIdentity: "dead",
			token: unrelatedToken,
			sessionNames: null,
			version: 4,
		}),
		{ mode: 0o600 },
	);
	const coordinationDirectory = dirname(lockBasePath);
	const ownLockFamily = basename(lockBasePath);
	const nativeLstat = fs.lstat;
	const gc = { acquiring: false, slowInspections: 0 };
	t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
		const path = String(args[0]);
		// While acquiring, only GC reads entries outside this claim's lock family.
		if (
			gc.acquiring &&
			gc.slowInspections === 0 &&
			dirname(path) === coordinationDirectory &&
			!basename(path).startsWith(ownLockFamily)
		) {
			gc.slowInspections += 1;
			await delay(150);
		}
		return nativeLstat(...args);
	});
	syncBuiltinESMExports();
	try {
		// GC inspects up to eight shared candidates per acquisition, at most one in this lock family.
		for (let attempt = 0; attempt < 16 && gc.slowInspections === 0; attempt += 1) {
			gc.acquiring = true;
			// Each acquisition advances the shared GC cursor before the next attempt.
			// oxlint-disable-next-line no-await-in-loop
			const lock = await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 });
			gc.acquiring = false;
			// Every uncontended pass must acquire, including the one whose GC overran the budget.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(lock, "opportunistic GC must not revoke an uncontended acquisition");
			// Release before the next GC pass.
			// oxlint-disable-next-line no-await-in-loop
			await lock.release();
		}
		assert.equal(gc.slowInspections, 1, "GC must reach a slow unrelated entry");
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(unrelatedClaimPath, { force: true, recursive: true });
	}
});

test("short-lived processes randomize GC past retained removal artifacts", async (t) => {
	const directory = await privateGcDirectory(t);
	const tag = randomUUID();
	const paths: string[] = [];
	for (let index = 0; index < 12; index += 1) {
		const token = `${tag}-${index}`;
		const path = join(
			directory,
			`.pi-agent-browser-policy-remove-${index < 8 ? "000" : "zzzz"}-${token}`,
		);
		paths.push(path);
		// Publish each GC candidate's directory before its owner record.
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
				const { cleanDeadPolicyArtifacts } = await import("./dist/extensions/agent-browser/lib/browser-execution-claim-storage.js");
				await cleanDeadPolicyArtifacts(${JSON.stringify(directory)}, {});
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
	await assert.rejects(stat(endpointPath(staleClaimPath)), { code: "ENOENT" });
	assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 50 }), undefined);
	assert.deepEqual(await claimPaths(), [liveClaimPath]);
	child.stdin.end("release");
	assert.equal(readArray(await childExit)[0], 0);
	const recovered = await acquireManagedSessionPolicyLock({ sessionName });
	assert.ok(recovered);
	await recovered.release();
	assert.deepEqual(await claimPaths(), []);
});

function endpointPath(claimPath: string): string {
	const token = basename(claimPath).slice(claimPrefix.length);
	return join(dirname(claimPath), `.l-${token}`);
}

const windowsSkip =
	process.platform === "win32"
		? "Windows keeps polling: busy named-pipe connects are uncancellable"
		: false;

/** Binds a real endpoint-length socket at the actual coordination root; skips only if native binding fails. */
async function endpointBindingSkip(): Promise<string | false> {
	const directory = getCoordinationDirectory();
	assert.ok(await ensureCoordinationDirectory(directory, process.platform));
	const server = createServer();
	const error = await new Promise<unknown>((resolve) => {
		server.once("error", resolve);
		server.listen(join(directory, `.l-${randomUUID()}`), () => {
			resolve(undefined);
		});
	});
	if (error === undefined) {
		server.close();
		return false;
	}
	const code = getErrorCode(error) ?? "unknown error";
	return `endpoint binding unavailable in ${directory} (${code}); waiters keep polling`;
}

const endpointSkip = windowsSkip === false ? await endpointBindingSkip() : windowsSkip;

/** Forwards the waiter's real endpoint connections and resolves once one is established. */
function forwardEndpointConnections(t: TestContext): Promise<void> {
	const nativeCreateConnection = net.createConnection;
	const connection = new Promise<void>((resolve) => {
		t.mock.method(net, "createConnection", (path: string) => {
			const socket = nativeCreateConnection(path);
			socket.once("connect", () => {
				resolve();
			});
			return socket;
		});
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return connection;
}

async function awaitSubscription(connection: Promise<void>): Promise<void> {
	const settled = new AbortController();
	const deadline = async (): Promise<never> => {
		await delay(5_000, undefined, { signal: settled.signal });
		throw new Error("the waiter never connected to the holder's endpoint");
	};
	try {
		await Promise.race([connection, deadline()]);
	} finally {
		settled.abort();
	}
}

function spawnHolder(t: TestContext): ReturnType<typeof spawn> {
	const moduleUrl = new URL(
		"../dist/extensions/agent-browser/lib/managed-session-policy-lock.js",
		import.meta.url,
	).href;
	const script = `import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)};
const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} });
if (!lock) process.exit(2);
console.log(JSON.stringify({ acquired: true }));
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "spawn") {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    console.log(JSON.stringify({ grandchild: child.pid }));
  } else if (line === "release") {
    await lock.release();
    console.log(JSON.stringify({ released: true }));
  }
}`;
	const holder = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	t.after(async () => {
		await stopChildProcess(holder);
	});
	return holder;
}

test(
	"a waiter sleeps on a live holder without identity polling and wakes on its release",
	{ skip: endpointSkip },
	async (t) => {
		const connection = forwardEndpointConnections(t);
		const holder = spawnHolder(t);
		assert.deepEqual(await readChildStdoutJsonLine(holder), { acquired: true });
		const holderPid = String(readNumber(holder.pid));
		const nativeExecFile = childProcess.execFile;
		let holderProbes = 0;
		t.mock.method(
			childProcess,
			"execFile",
			(
				file: string,
				args: readonly string[],
				options: Parameters<typeof execFile>[2],
				callback: Parameters<typeof execFile>[3],
			) => {
				holderProbes += args[0] === "-p" && args[1] === holderPid ? 1 : 0;
				// Forward the real identity query; only its count is observed.
				return nativeExecFile(file, args, options, callback);
			},
		);
		const nativeReadFile = fs.readFile;
		// Linux reads the holder's kernel start ticks directly instead of launching ps.
		t.mock.method(fs, "readFile", async (...args: Readonly<Parameters<typeof fs.readFile>>) => {
			holderProbes += args[0] === `/proc/${holderPid}/stat` ? 1 : 0;
			return await nativeReadFile(...args);
		});
		syncBuiltinESMExports();
		const waiting = acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 10_000 });
		await awaitSubscription(connection);
		const subscribedProbes = holderProbes;
		assert.ok(subscribedProbes > 0, "the waiter must confirm the live holder before subscribing");
		// One arbitration follows the subscription; every further probe would be polling.
		await delay(500);
		assert.ok(
			holderProbes <= subscribedProbes + 1,
			`a subscribed waiter re-probed its holder ${holderProbes - subscribedProbes} times`,
		);
		const acknowledgement = readChildStdoutJsonLine(holder);
		holder.stdin?.write("release\n");
		assert.deepEqual(await acknowledgement, { released: true });
		const lock = await waiting;
		assert.ok(lock);
		await lock.release();
	},
);

test(
	"a subscribed waiter reclaims a killed holder whose surviving child inherited nothing",
	{ skip: endpointSkip },
	async (t) => {
		const connection = forwardEndpointConnections(t);
		const holder = spawnHolder(t);
		assert.deepEqual(await readChildStdoutJsonLine(holder), { acquired: true });
		const holderClaim = await onlyClaimPath();
		const waiting = acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 10_000 });
		await awaitSubscription(connection);
		// Spawn after the waiter connected so both listening and accepted endpoints could leak.
		const spawned = readChildStdoutJsonLine(holder);
		holder.stdin?.write("spawn\n");
		const grandchild = readNumber(readRecord(await spawned).grandchild);
		t.after(() => {
			try {
				process.kill(grandchild, "SIGKILL");
			} catch {
				/* Already gone. */
			}
		});
		const killed = Date.now();
		holder.kill("SIGKILL");
		const lock = await waiting;
		assert.ok(lock);
		assert.ok(
			Date.now() - killed < 2_000,
			"holder exit must wake its subscriber, not its deadline",
		);
		assert.doesNotThrow(
			() => process.kill(grandchild, 0),
			"the holder's child must still be running",
		);
		await assert.rejects(stat(holderClaim), { code: "ENOENT" });
		await assert.rejects(stat(endpointPath(holderClaim)), { code: "ENOENT" });
		await lock.release();
	},
);

test(
	"a choosing predecessor that publishes a later ticket never puts the earlier waiter to sleep",
	{ skip: windowsSkip },
	async () => {
		const seed = await acquireManagedSessionPolicyLock({ sessionName });
		assert.ok(seed);
		const owner = readRecord(
			JSON.parse(await readFile(join(await onlyClaimPath(), "owner.json"), "utf8")),
		);
		await seed.release();
		owner.token = randomUUID();
		const choosingPath = `${lockBasePath}.claim-${readString(owner.token)}`;
		await mkdir(choosingPath, { mode: 0o700 });
		await writeFile(join(choosingPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
		// A live choosing owner listens before its ticket exists, exactly like a real contender.
		const endpoint = openClaimEndpoint(choosingPath, readString(owner.token));
		try {
			const started = Date.now();
			const waiting = acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 3_000 });
			await delay(150);
			const candidate = join(choosingPath, ".ticket.tmp");
			await writeFile(candidate, JSON.stringify({ ticket: 2, token: owner.token, version: 4 }), {
				mode: 0o600,
			});
			await fs.rename(candidate, join(choosingPath, "ticket.json"));
			const lock = await waiting;
			assert.ok(lock, "the earlier ticket must acquire once the choosing claim publishes later");
			assert.ok(
				Date.now() - started < 1_500,
				"the earlier waiter must keep polling a choosing claim",
			);
			await lock.release();
		} finally {
			endpoint?.close();
		}
	},
);

async function endpointFixtureRoot(t: TestContext): Promise<string> {
	// The product's own coordination parent: /tmp on macOS/Linux, the private tmpdir on Android.
	const root = await fs.mkdtemp(join(dirname(getCoordinationDirectory()), "piab-ep-"));
	t.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	return root;
}

test(
	"a short endpoint path binds and accepts a subscription",
	{ skip: endpointSkip },
	async (t) => {
		const claimPath = join(await endpointFixtureRoot(t), "claim");
		const token = randomUUID();
		const endpoint = openClaimEndpoint(claimPath, token);
		const subscription = await subscribeClaimEndpoint(
			claimPath,
			token,
			undefined,
			Date.now() + 2_000,
		);
		try {
			assert.equal(subscription?.connected(), true);
		} finally {
			subscription?.close();
			endpoint?.close();
		}
	},
);

test(
	"an endpoint path beyond the Unix socket limit falls back without an unhandled error",
	{ skip: windowsSkip },
	async (t) => {
		// The parent exists, so a native bind of this path fails only for its length.
		const longParent = join(await endpointFixtureRoot(t), "x".repeat(110));
		await mkdir(longParent);
		const token = randomUUID();
		const probe = createServer();
		const bindError = await new Promise<unknown>((resolve) => {
			probe.once("error", resolve);
			probe.listen(join(longParent, `.l-${token}`));
		});
		assert.ok(hasErrorCode(bindError, "EINVAL"), "the native bind must fail for path length");
		const claimPath = join(longParent, "claim");
		const endpoint = openClaimEndpoint(claimPath, token);
		try {
			const started = Date.now();
			const subscription = await subscribeClaimEndpoint(
				claimPath,
				token,
				undefined,
				Date.now() + 2_000,
			);
			assert.equal(subscription, undefined);
			assert.ok(
				Date.now() - started < 1_000,
				"an unusable endpoint must not spend the wait budget",
			);
			// The listener reports its bind failure asynchronously; an unhandled one fails the run.
			await delay(10);
		} finally {
			endpoint?.close();
		}
	},
);

async function readCriticalJournal(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return "<journal not created>";
		}
		throw error;
	}
}

function assertSerializedJournal(journal: string, pids: readonly number[]): void {
	const lines = journal.trim().split("\n");
	assert.equal(lines.length, 8, journal);
	const observed = Array.from({ length: 4 }, (_, index) => {
		const start = lines[index * 2];
		assert.match(start, /^start:\d+$/, journal);
		assert.equal(lines[index * 2 + 1], start.replace("start:", "end:"), journal);
		return start.slice("start:".length);
	});
	assert.deepEqual(observed.sort(), pids.map(String).sort(), journal);
	let active = 0;
	let maxActive = 0;
	for (const line of lines) {
		active += line.startsWith("start:") ? 1 : -1;
		maxActive = Math.max(maxActive, active);
		// Every journal transition must keep ownership nonnegative; final checks require balance.
		assert.ok(active >= 0, journal);
	}
	assert.equal(active, 0, journal);
	assert.equal(maxActive, 1, journal);
}

test("competing cross-process reclaimers stay serialized after a stale claim", async (t) => {
	const moduleUrl = new URL(
		"../dist/extensions/agent-browser/lib/managed-session-policy-lock.js",
		import.meta.url,
	).href;
	const identityUrl = new URL(
		"../dist/extensions/agent-browser/lib/process-identity.js",
		import.meta.url,
	).href;
	const staleScript = `import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)} }); if (!lock) process.exit(2);`;
	const stale = spawn(process.execPath, ["--input-type=module", "--eval", staleScript], {
		stdio: "ignore",
	});
	const [staleCode] = readArray(await once(stale, "exit"));
	assert.equal(staleCode, 0);
	const stalePath = await onlyClaimPath();
	const staleOwner = await readFile(join(stalePath, "owner.json"), "utf8");
	const staleTicket = await readFile(join(stalePath, "ticket.json"), "utf8");

	const logPath = join(dirname(lockBasePath), `${basename(lockBasePath)}.critical.log`);
	const contenderScript = `
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { acquireManagedSessionPolicyLock } from ${JSON.stringify(moduleUrl)};
import { readProcessStartIdentity } from ${JSON.stringify(identityUrl)};
// Buffer bounded timing metadata only; never retain argv, paths, output or generation values.
const probes = [];
let omitted = 0;
const nativeExecFile = childProcess.execFile;
childProcess.execFile = function(file, args, options, callback) {
  if (arguments.length !== 4 || !Array.isArray(args) || !options || typeof callback !== "function") return Reflect.apply(nativeExecFile, this, arguments);
  const command = args.at(-1);
  const windowsPid = typeof command === "string" ? command.match(/(?:Get-Process -Id |GetProcessById\\()(\\d+)/)?.[1] : undefined;
  const target = Number(args[0] === "-p" ? args[1] : windowsPid);
  if (!Number.isSafeInteger(target) || target <= 0) return Reflect.apply(nativeExecFile, this, arguments);
  const role = target === process.pid ? "self" : "other";
  const started = performance.now();
  return nativeExecFile.call(this, file, args, options, function(...values) {
    const error = values[0];
    const code = error?.code;
    const signal = error?.signal;
    const sample = {
      role,
      elapsedMs: Math.round(performance.now() - started),
      timeoutMs: Number.isFinite(options.timeout) ? options.timeout : null,
      success: error === null || error === undefined,
      code: typeof code === "string" && /^(?:E[A-Z0-9]{1,24}|ABORT_ERR|ERR_[A-Z_]{1,48})$/.test(code) ? code : "-",
      exit: Number.isSafeInteger(code) ? code : null,
      killed: error?.killed === true,
      signal: typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : "-",
    };
    if (probes.length < 16) probes.push(sample); else omitted++;
    return Reflect.apply(callback, this, values);
  });
};
syncBuiltinESMExports();
let goStarted;
let goToCriticalMs = null;
try {
  // Observe only this child's real identity outside the measured contention window. No lock warmup.
  const startIdentity = await readProcessStartIdentity(process.pid);
  assert.ok(typeof startIdentity === "string" && startIdentity.length > 0, "Own process-start identity unavailable before READY");
  const go = new Promise((resolve) => {
    let command = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { command += chunk; });
    process.stdin.once("end", () => { assert.equal(command, "go\\n"); goStarted = performance.now(); resolve(); });
  });
  console.log(JSON.stringify({ event: "ready", pid: process.pid }));
  await go;
  const lock = await acquireManagedSessionPolicyLock({ sessionName: ${JSON.stringify(sessionName)}, timeoutMs: 1000 });
  if (!lock) {
    process.exitCode = 2;
  } else {
    try {
      goToCriticalMs = Math.round(performance.now() - goStarted);
      fs.appendFileSync(${JSON.stringify(logPath)}, "start:" + process.pid + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 25));
      fs.appendFileSync(${JSON.stringify(logPath)}, "end:" + process.pid + "\\n");
    } finally {
      await lock.release();
    }
  }
} finally {
  childProcess.execFile = nativeExecFile;
  syncBuiltinESMExports();
  process.stderr.write(JSON.stringify({ event: "identity-timing", probes, omitted, goToCriticalMs }) + "\\n");
}`;
	const contenders = Array.from({ length: 4 }, () => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", contenderScript], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const closed = once(child, "close");
		const ready = readChildStdoutJsonLine(child).then(readRecord);
		return { child, closed, ready, getStderr: () => stderr };
	});
	const diagnostics = (journal: string): string =>
		JSON.stringify({
			contenders: contenders.map((contender) => ({
				pid: contender.child.pid,
				code: contender.child.exitCode,
				signal: contender.child.signalCode,
				stderr: contender.getStderr(),
			})),
			journal,
		});
	try {
		const ready = await Promise.all(contenders.map((contender) => contender.ready));
		const pids = contenders.map((contender) => readNumber(contender.child.pid));
		assert.equal(new Set(pids).size, 4);
		assert.deepEqual(
			ready,
			pids.map((pid) => ({ event: "ready", pid })),
		);
		// Own-identity preparation must neither acquire a lock nor reclaim the original stale owner.
		assert.deepEqual(await claimPaths(), [stalePath]);
		assert.equal(await readFile(join(stalePath, "owner.json"), "utf8"), staleOwner);
		assert.equal(await readFile(join(stalePath, "ticket.json"), "utf8"), staleTicket);
		for (const contender of contenders) {
			contender.child.stdin.end("go\n"); // Release all gates and close stdin before awaiting any completion.
		}
		const exits = await Promise.all(
			contenders.map(async (contender) => readArray(await contender.closed)),
		);
		const journal = await readCriticalJournal(logPath);
		assert.deepEqual(
			exits.map((values) => values[0]),
			[0, 0, 0, 0],
			diagnostics(journal),
		);
		assertSerializedJournal(journal, pids);
	} catch (error) {
		await Promise.all(
			contenders.map(async (contender) => {
				await stopChildProcess(contender.child);
				await contender.closed;
			}),
		);
		t.diagnostic(diagnostics(await readCriticalJournal(logPath)));
		throw error;
	} finally {
		await Promise.all(contenders.map(async (contender) => stopChildProcess(contender.child)));
		await rm(logPath, { force: true });
	}
});
