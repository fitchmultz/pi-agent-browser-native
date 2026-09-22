import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { acquireManagedSessionPolicyLock, getBrowserExecutionLockPath, resolveBrowserExecutionIdentity, withBrowserExecutionLock } from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { resolveAgentBrowserSocketDir } from "../extensions/agent-browser/lib/process.js";
import { withAgentBrowserProcessEnvironment } from "../extensions/agent-browser/lib/process-environment.js";

type WorkerOptions = { identities?: Array<{ socketDir: string; namespace?: string; sessionName?: string }>; socketDir: string; namespace?: string; sessionName?: string; mode: string; statePath?: string; logPath?: string; timeoutMs?: number; ablate?: boolean };
const workerCleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();
function worker(t: TestContext, options: WorkerOptions) {
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./helpers/browser-execution-lock-worker.ts", import.meta.url)), JSON.stringify(options)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	const messages: Array<{ event: string; data?: unknown }> = [];
	let stderr = "";
	child.stderr!.on("data", chunk => { stderr += chunk; });
	child.on("message", message => { messages.push(message as typeof messages[number]); });
	const exit = once(child, "exit");
	const identities = Promise.all((options.identities ?? [options]).map(selection => resolveBrowserExecutionIdentity({ ...selection, env: { AGENT_BROWSER_SOCKET_DIR: selection.socketDir } })));
	const cleanups = workerCleanups.get(t) ?? [];
	workerCleanups.set(t, cleanups);
	cleanups.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exit;
		for (const identity of await identities) {
			const base = getBrowserExecutionLockPath(identity);
			for (const name of await readdir(dirname(base))) {
				if (name.startsWith(`${basename(base)}.claim-`)) await rm(join(dirname(base), name), { recursive: true, force: true });
			}
		}
	});
	return {
		child, messages,
		send(message: string) { child.send(message); },
		async event(event: string) {
			await until(() => messages.some(message => message.event === event), () => `waiting for ${event}: ${JSON.stringify(messages)} ${stderr}`);
			return messages.find(message => message.event === event)!;
		},
		async done() { const [code] = await exit; assert.equal(code, 0, stderr); },
	};
}
async function until(check: () => boolean | Promise<boolean>, diagnostic: () => string) {
	const deadline = Date.now() + 15_000;
	while (!await check()) {
		assert.ok(Date.now() < deadline, diagnostic());
		await delay(10);
	}
}
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "piab-execution-"));
	// Unique namespace also isolates the Windows native TCP identity (which ignores storage roots).
	const namespace = basename(root);
	const identity = await resolveBrowserExecutionIdentity({ env: { AGENT_BROWSER_SOCKET_DIR: root }, namespace, sessionName: "one" });
	const base = getBrowserExecutionLockPath(identity);
	const claims = async () => (await readdir(dirname(base))).filter(name => name.startsWith(`${basename(base)}.claim-`));
	t.after(async () => {
		const cleanups = workerCleanups.get(t) ?? [];
		workerCleanups.delete(t);
		// Reap every worker before removing fixtures or abandoned claims.
		await Promise.all(cleanups.map(cleanup => cleanup()));
		for (const name of await claims()) await rm(join(dirname(base), name), { force: true, recursive: true });
		await rm(root, { recursive: true, force: true });
	});
	const published = async (count: number) => {
		const names = await claims();
		return names.length === count && (await Promise.all(names.map(name => readFile(join(dirname(base), name, "ticket.json"), "utf8").catch(() => "")))).every(Boolean);
	};
	return { root, namespace, identity, claims, published, options: { socketDir: root, namespace, sessionName: "one", mode: "hold" } };
}

test("direct-call lock waiting leaves execution to native watchdogs", async t => {
	const f = await fixture(t);
	await withBrowserExecutionLock({ identity: f.identity, deadline: Date.now() + 1_000, waitOnly: true }, async signal => {
		await delay(1_100);
		assert.equal(signal.aborted, false, "the queue deadline must not truncate a native command budget");
	});
	assert.deepEqual(await f.claims(), []);
});

test("cancelled execution can lend an already-held claim to independently bounded cleanup", async t => {
	const f = await fixture(t);
	const controller = new AbortController();
	await withAgentBrowserProcessEnvironment({ PI_AGENT_BROWSER_SOCKET_DIR: f.root, AGENT_BROWSER_SOCKET_DIR: f.root }, () =>
		withBrowserExecutionLock({ identity: f.identity, signal: controller.signal, deadline: Date.now() + 5_000 }, async signal => {
			controller.abort();
			assert.equal(signal.aborted, true);
			const cleanup = await acquireManagedSessionPolicyLock({ sessionName: "one", namespace: f.namespace, signal: new AbortController().signal });
			assert.ok(cleanup, "cleanup borrows the covered claim until the callback drains");
			assert.equal(await acquireManagedSessionPolicyLock({ sessionName: "other", namespace: f.namespace }), undefined, "cleanup cannot upgrade identity");
			await cleanup.release();
			assert.equal((await f.claims()).length, 1, "borrowing does not release the outer claim");
		}));
	assert.deepEqual(await f.claims(), []);
});

for (const ablate of [true, false]) {
	test(`two processes ${ablate ? "reproduce the uncoordinated" : "prevent the"} verify-then-action race`, { timeout: 30_000 }, async t => {
		const f = await fixture(t);
		const statePath = join(f.root, "page");
		const logPath = join(f.root, "clicks");
		await writeFile(statePath, "A");
		const a = worker(t, { ...f.options, mode: "read-action", statePath, logPath, ablate });
		assert.equal((await a.event("verified")).data, "A");
		const b = worker(t, { ...f.options, mode: "navigate", statePath, ablate });
		await b.event("ready");
		if (ablate) await b.done();
		else {
			await until(async () => (await f.claims()).length === 2, () => "B never published its waiting claim");
			assert.ok(!b.messages.some(message => message.event === "navigated"));
		}
		a.send("release");
		await Promise.all([a.done(), b.done()]);
		assert.equal(await readFile(logPath, "utf8"), ablate ? "click:B\n" : "click:A\n");
		assert.deepEqual(await f.claims(), []);
	});
}

test("different sessions and native socket roots execute concurrently across processes", { timeout: 30_000 }, async t => {
	const f = await fixture(t);
	const a = worker(t, f.options);
	await a.event("acquired");
	const b = worker(t, { ...f.options, sessionName: "two" });
	await b.event("acquired"); // Must enter while A still owns its claim.
	if (process.platform !== "win32") {
		const second = await fixture(t);
		const c = worker(t, { ...f.options, socketDir: second.root });
		await c.event("acquired");
		c.send("release");
		await c.done();
	}
	a.send("release"); b.send("release");
	await Promise.all([a.done(), b.done()]);
});

test("namespace close drains earlier sessions and excludes later arrivals without blocking another namespace", { timeout: 30_000 }, async t => {
	const f = await fixture(t);
	const a = worker(t, f.options);
	const b = worker(t, { ...f.options, sessionName: "two" });
	await Promise.all([a.event("acquired"), b.event("acquired")]);
	const close = worker(t, { ...f.options, sessionName: undefined });
	await until(() => f.published(3), () => "close ticket missing");
	const later = worker(t, { ...f.options, sessionName: "three" });
	await until(async () => (await f.claims()).length === 4, () => "later claim missing");
	const separate = worker(t, { ...f.options, namespace: `${f.namespace}-other` });
	await separate.event("acquired");
	separate.send("release"); await separate.done();
	a.send("release"); await a.done();
	assert.ok(!close.messages.some(message => message.event === "acquired"));
	b.send("release"); await b.done();
	await close.event("acquired");
	assert.ok(!later.messages.some(message => message.event === "acquired"));
	close.send("release"); await close.done();
	await later.event("acquired"); later.send("release"); await later.done();
});

test("multi-browser operations acquire canonical context order, dedupe session claims, and borrow every managed policy", { timeout: 30_000 }, async t => {
	const f = await fixture(t);
	const second = { ...f.options, namespace: `zzz-${f.namespace}` };
	const sameContext = { ...f.options, sessionName: "two" };
	const owner = worker(t, { ...f.options, identities: [second, f.options, sameContext, f.options], mode: "nested" });
	await owner.event("nested");
	assert.equal((await f.claims()).length, 1, "one set-valued claim must cover both same-context sessions");
	const unrelated = worker(t, { ...f.options, sessionName: "three" });
	await unrelated.event("acquired");
	unrelated.send("release"); await unrelated.done();
	const reversed = worker(t, { ...f.options, identities: [sameContext, f.options, second], mode: "nested" });
	await until(() => f.published(2), () => "reversed multi-identity waiter missing");
	assert.ok(!reversed.messages.some(message => message.event === "acquired"));
	const close = worker(t, { ...f.options, sessionName: undefined });
	await until(() => f.published(3), () => "namespace close waiter missing");
	owner.send("release"); await owner.done();
	await reversed.event("nested");
	assert.ok(!close.messages.some(message => message.event === "acquired"));
	reversed.send("release"); await reversed.done();
	await close.event("acquired"); close.send("release"); await close.done();
});

test("aborting multi-context acquisition releases earlier claims without disturbing the blocking owner", { timeout: 30_000 }, async t => {
	const f = await fixture(t);
	const later = { ...f.options, namespace: `zzz-${f.namespace}` };
	const owner = worker(t, later);
	await owner.event("acquired");
	const waiting = worker(t, { ...f.options, identities: [later, f.options] });
	await until(() => f.published(1), () => "first context was not acquired");
	waiting.send("abort");
	assert.equal(((await waiting.event("failed")).data as { name: string }).name, "AbortError");
	await waiting.done();
	assert.deepEqual(await f.claims(), []);
	const next = worker(t, f.options);
	await next.event("acquired"); next.send("release"); await next.done();
	assert.ok(!owner.messages.some(message => message.event === "done"));
	owner.send("release"); await owner.done();
});

test("abort and deadline withdraw only the waiter; cancellation retains a running callback until cleanup", { timeout: 30_000 }, async t => {
	const f = await fixture(t);
	const owner = worker(t, f.options);
	await owner.event("acquired");
	const waiter = worker(t, f.options);
	await until(async () => (await f.claims()).length === 2, () => "waiter claim missing");
	waiter.send("abort");
	assert.equal(((await waiter.event("failed")).data as { name: string }).name, "AbortError");
	await waiter.done();
	const expired = worker(t, { ...f.options, timeoutMs: 100 });
	assert.equal(((await expired.event("failed")).data as { name: string }).name, "TimeoutError");
	await expired.done();
	assert.equal((await f.claims()).length, 1);
	owner.send("abort"); await owner.event("cancelled");
	const next = worker(t, f.options);
	await until(async () => (await f.claims()).length === 2, () => "next claim missing");
	assert.ok(!next.messages.some(message => message.event === "acquired"));
	owner.send("release"); await owner.done();
	await next.event("acquired"); next.send("release"); await next.done();
	assert.deepEqual(await f.claims(), []);
});

test("recursive calls borrow policy ownership and process death releases the shared identity", { timeout: 30_000 }, async t => {
	const f = await fixture(t);
	const owner = worker(t, { ...f.options, mode: "nested" });
	await owner.event("nested");
	assert.equal((await f.claims()).length, 1);
	const waiter = worker(t, f.options);
	await until(async () => (await f.claims()).length === 2, () => "waiter claim missing");
	assert.ok(!waiter.messages.some(message => message.event === "acquired"));
	owner.child.kill("SIGKILL");
	await waiter.event("acquired");
	assert.equal((await f.claims()).length, 1);
	waiter.send("release"); await waiter.done();
	assert.deepEqual(await f.claims(), []);
});

test("nested siblings serialize, throws release, and scope upgrades or escaped callbacks fail without waiting", async t => {
	const f = await fixture(t);
	const options = { identity: f.identity, deadline: Date.now() + 10_000 };
	let active = 0;
	let maximum = 0;
	let escaped!: () => Promise<void>;
	await assert.rejects(withBrowserExecutionLock(options, async () => {
		await Promise.all([1, 2, 3].map(() => withBrowserExecutionLock(options, async () => {
			maximum = Math.max(maximum, ++active);
			await delay(10);
			active--;
		})));
		await assert.rejects(withBrowserExecutionLock({ ...options, identity: { socketContext: f.identity.socketContext } }, async () => undefined), /change or upgrade/);
		// AsyncResource captures the scope like a deferred IPC callback would.
		const { AsyncResource } = await import("node:async_hooks");
		escaped = AsyncResource.bind(() => withBrowserExecutionLock(options, async () => undefined));
		throw new Error("callback failure");
	}), /callback failure/);
	assert.equal(maximum, 1);
	await assert.rejects(escaped(), /already finished/);
	await withBrowserExecutionLock({ ...options, identity: { socketContext: f.identity.socketContext } }, async () => {
		await withBrowserExecutionLock(options, async () => {
			await withBrowserExecutionLock({ ...options, identity: { ...f.identity, sessionName: "two" } }, async () => undefined);
		});
	});
	// A callback that returns without awaiting an already-started inner operation
	// must not release its claim while that operation still uses the browser.
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	let started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; });
	const outer = withBrowserExecutionLock(options, async () => {
		void withBrowserExecutionLock(options, async () => { started(); await pending; });
	});
	await entered;
	assert.equal((await f.claims()).length, 1);
	release(); await outer;
	await assert.rejects(withBrowserExecutionLock({ ...options, identity: { ...f.identity, sessionName: "x".repeat(1_048_576) } }, async () => assert.fail("unreadable ownership metadata must never be published")), /unavailable or busy/);
	assert.deepEqual(await f.claims(), []);
});

test("execution identity shares process socket precedence and native namespace/path aliases", async t => {
	const f = await fixture(t);
	const parentEnv = { AGENT_BROWSER_SOCKET_DIR: "/native", PI_AGENT_BROWSER_SOCKET_DIR: "/pi" };
	assert.equal(resolveAgentBrowserSocketDir({ parentEnv }), "/pi");
	assert.equal(resolveAgentBrowserSocketDir({ parentEnv, env: { AGENT_BROWSER_SOCKET_DIR: "/call" } }), "/call");
	assert.equal(resolveAgentBrowserSocketDir({ parentEnv: { AGENT_BROWSER_SOCKET_DIR: "/native" } }), "/native");
	assert.notEqual(resolveAgentBrowserSocketDir({ parentEnv: { AGENT_BROWSER_SOCKET_DIR: "/native" }, ownedManagedSession: true }), "/native");
	const alias = await resolveBrowserExecutionIdentity({ env: { AGENT_BROWSER_SOCKET_DIR: join(f.root, ".") }, namespace: " Team / Space ", sessionName: "one" });
	const canonical = await resolveBrowserExecutionIdentity({ env: { AGENT_BROWSER_SOCKET_DIR: f.root }, namespace: "team-space", sessionName: "one" });
	assert.deepEqual(alias, canonical);
	const scoped = await withAgentBrowserProcessEnvironment({ PI_AGENT_BROWSER_SOCKET_DIR: f.root }, () => resolveBrowserExecutionIdentity({ namespace: f.namespace, sessionName: "one" }));
	assert.deepEqual(scoped, f.identity);
	if (process.platform === "darwin") {
		const tmpAlias = await resolveBrowserExecutionIdentity({ env: { AGENT_BROWSER_SOCKET_DIR: f.root.replace(/^\/var\//, "/private/var/") }, namespace: f.namespace, sessionName: "ONE" });
		assert.deepEqual(tmpAlias, f.identity);
	}
});
