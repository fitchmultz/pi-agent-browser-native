import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";

import { startRelayServer, type RelayServer } from "../chrome-relay/server.js";

// ---- helpers ----------------------------------------------------------------

interface TestServer {
	srv: RelayServer;
	port: number;
}

async function startTestServer(opts: { token?: string } = {}): Promise<TestServer> {
	const srv = startRelayServer({ port: 0, ...(opts.token ? { token: opts.token } : {}) });
	await srv.ready;
	return { srv, port: srv.port };
}

interface HttpResponse {
	status: number;
	body: any;
}

async function fetchJson(port: number, path: string, init: RequestInit = {}): Promise<HttpResponse> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		// non-JSON body (404/405 plain text) is fine
	}
	return { status: res.status, body };
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - started > 2_000) return reject(new Error(`timeout waiting for ${label}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

interface FakeTab {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	groupId: number;
}

function fakeTab(tabId: number, url: string): FakeTab {
	return { tabId, url, title: `Tab ${tabId}`, active: true, windowId: 1, pinned: false, groupId: -1 };
}

/** Fake chrome.debugger peer: speaks the relay extension protocol on /ext. */
class FakeRelayExtension {
	readonly received: Array<Record<string, any>> = [];
	private socket: WebSocket | null = null;
	autoReplySend = true;

	constructor(
		private readonly url: string,
		private readonly opts: { token?: string; origin?: string } = {},
	) {}

	connect(): Promise<void> {
		const suffix = this.opts.token ? `?token=${encodeURIComponent(this.opts.token)}` : "";
		const headers: Record<string, string> = {};
		if (this.opts.origin) headers.origin = this.opts.origin;
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${this.url}${suffix}`, { headers });
			ws.on("open", () => {
				this.socket = ws;
				resolve();
			});
			ws.on("message", raw => {
				const msg = JSON.parse(String(raw)) as Record<string, any>;
				this.received.push(msg);
				if (this.autoReplySend && msg.t === "rpc") {
					// Attach/detach/send/group rpcs all just need a successful result.
					ws.send(JSON.stringify({ t: "rpcResult", id: msg.id, ok: true, result: {} }));
				}
			});
			ws.on("error", reject);
		});
	}

	hello(tabs: FakeTab[] = [], attachedTabIds: number[] = []): void {
		this.send({
			t: "hello",
			userAgent: "Mozilla/5.0 FakeUA Chrome/153.0.0.0",
			browserVersion: "Chrome/153.0.0.0",
			tabs,
			attachedTabIds,
		});
	}

	send(msg: Record<string, unknown>): void {
		assert.ok(this.socket, "extension socket not connected");
		this.socket.send(JSON.stringify(msg));
	}

	cdpEvents(): Array<Record<string, any>> {
		return this.received.filter(m => m.t === "cdpEvent");
	}

	rpcs(): Array<Record<string, any>> {
		return this.received.filter(m => m.t === "rpc");
	}

	close(): void {
		this.socket?.close();
	}
}

/** Fake downstream CDP client (the shape agent-browser/Playwright uses). */
class FakeCdpClient {
	readonly events: Array<Record<string, any>> = [];
	private socket: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

	constructor(private readonly url: string) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url);
			ws.on("open", () => {
				this.socket = ws;
				resolve();
			});
			ws.on("message", raw => {
				const msg = JSON.parse(String(raw)) as Record<string, any>;
				if (typeof msg.id === "number") {
					const pending = this.pending.get(msg.id);
					if (pending) {
						this.pending.delete(msg.id);
						if (msg.error) pending.reject(new Error(msg.error.message ?? "cdp error"));
						else pending.resolve(msg.result ?? {});
					}
				} else if (msg.method) {
					this.events.push(msg);
				}
			});
			ws.on("error", reject);
		});
	}

	call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket!.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
		});
	}

	close(): void {
		this.socket?.close();
	}
}

/** Expect a WebSocket upgrade to fail with the given HTTP status. */
function expectUpgradeStatus(url: string, status: number, headers: Record<string, string> = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers });
		ws.on("open", () => reject(new Error("upgrade unexpectedly succeeded")));
		ws.on("error", (err: Error) => {
			if (err.message.endsWith(`: ${status}`)) resolve();
			else reject(new Error(`expected status ${status}, got ${err.message}`));
		});
	});
}

// ---- tests --------------------------------------------------------------------

test("sidecar server binds loopback only", async t => {
	const { srv } = await startTestServer();
	t.after(() => srv.stop());
	assert.equal(srv.address()?.address, "127.0.0.1");
});

test("discovery: 503 before extension hello, 200 with ws url after", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());

	const before = await fetchJson(port, "/json/version");
	assert.equal(before.status, 503);
	assert.equal(before.body.extensionSeen, false);
	assert.ok(typeof before.body.uptimeMs === "number");

	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`);
	await ext.connect();
	ext.hello([fakeTab(42, "https://example.com/")]);
	await waitFor(() => srv.bridge.ready, "bridge ready");

	const after = await fetchJson(port, "/json/version");
	assert.equal(after.status, 200);
	assert.match(String(after.body.Browser), /Chrome\/153/);
	assert.equal(after.body.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/cdp`);
	ext.close();
});

test("discovery: /json/list exposes only eligible page targets with minted ids", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`);
	await ext.connect();
	ext.hello([fakeTab(42, "https://example.com/"), fakeTab(43, "chrome://settings")]);
	await waitFor(() => srv.bridge.ready, "bridge ready");

	const list = await fetchJson(port, "/json/list");
	assert.equal(list.status, 200);
	assert.deepEqual(
		list.body.map((t: any) => t.id),
		["PAGE42"],
	);
	ext.close();
});

test("cdp: Target.getTargets and attachToTarget emulate the Chrome hierarchy", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`);
	await ext.connect();
	ext.hello([fakeTab(42, "https://example.com/")]);
	await waitFor(() => srv.bridge.ready, "bridge ready");

	const cdp = new FakeCdpClient(`ws://127.0.0.1:${port}/cdp`);
	await cdp.connect();
	t.after(() => cdp.close());

	const version = await cdp.call("Browser.getVersion");
	assert.match(String(version.product), /Chrome\/153/);
	assert.match(String(version.userAgent), /FakeUA/);

	const contexts = await cdp.call("Target.getBrowserContexts");
	assert.deepEqual(contexts.browserContextIds, []);

	const targets = await cdp.call("Target.getTargets");
	assert.deepEqual(
		targets.targetInfos.map((t: any) => t.targetId),
		["PAGE42"],
	);
	assert.equal(targets.targetInfos[0].type, "page");
	assert.equal(targets.targetInfos[0].url, "https://example.com/");

	const attached = await cdp.call("Target.attachToTarget", { targetId: "PAGE42" });
	assert.match(String(attached.sessionId), /^SP42\./);
	const info = await cdp.call("Target.getTargetInfo");
	assert.equal(info.targetInfo.targetId, "relay-browser");
	assert.equal(info.targetInfo.type, "browser");
	ext.close();
});

test("cdp: page commands round-trip through the extension rpc channel", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`);
	await ext.connect();
	ext.hello([fakeTab(42, "https://example.com/")]);
	await waitFor(() => srv.bridge.ready, "bridge ready");

	const cdp = new FakeCdpClient(`ws://127.0.0.1:${port}/cdp`);
	await cdp.connect();
	t.after(() => cdp.close());

	const attached = await cdp.call("Target.attachToTarget", { targetId: "PAGE42" });
	const sessionId = String(attached.sessionId);

	// Runtime.enable is intercepted by the bridge: it cycles the shared root session
	// through the extension (Runtime.disable + Runtime.enable) before replying.
	await cdp.call("Runtime.enable", undefined, sessionId);
	const enableRpcs = ext.rpcs().filter(m => m.op === "send" && m.method === "Runtime.enable");
	assert.ok(enableRpcs.length >= 1, "expected the root Runtime.enable cycle through chrome.debugger");

	const evaluated = await cdp.call("Runtime.evaluate", { expression: "1+1" }, sessionId);
	assert.deepEqual(evaluated, {});
	const evaluateRpcs = ext.rpcs().filter(m => m.op === "send" && m.method === "Runtime.evaluate");
	assert.equal(evaluateRpcs.length, 1);
	assert.equal(evaluateRpcs[0].params.expression, "1+1");
	ext.close();
});

test("safety: Browser.close is acknowledged but never forwarded", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`);
	await ext.connect();
	ext.hello([fakeTab(42, "https://example.com/")]);
	await waitFor(() => srv.bridge.ready, "bridge ready");

	const cdp = new FakeCdpClient(`ws://127.0.0.1:${port}/cdp`);
	await cdp.connect();
	t.after(() => cdp.close());

	const result = await cdp.call("Browser.close");
	assert.deepEqual(result, {});
	assert.equal(ext.rpcs().length, 0, "no rpc may reach the extension for Browser.close");
	ext.close();
});

test("safety: /cdp rejects websocket upgrades bearing an Origin header", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	await expectUpgradeStatus(`ws://127.0.0.1:${port}/cdp`, 403, { origin: "https://evil.example" });
});

test("safety: /ext enforces the shared token when configured", async t => {
	const { srv, port } = await startTestServer({ token: "sekrit" });
	t.after(() => srv.stop());
	await expectUpgradeStatus(`ws://127.0.0.1:${port}/ext`, 401);

	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`, { token: "sekrit" });
	await ext.connect();
	ext.hello();
	await waitFor(() => srv.bridge.ready, "bridge ready");
	ext.close();
});

test("http fallbacks: unknown paths 404, non-GET on discovery 405", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	const missing = await fetchJson(port, "/nope");
	assert.equal(missing.status, 404);
	const post = await fetchJson(port, "/json/version", { method: "POST" });
	assert.equal(post.status, 405);
});

test("extension events: tab upserts reach discovering CDP clients", async t => {
	const { srv, port } = await startTestServer();
	t.after(() => srv.stop());
	const ext = new FakeRelayExtension(`ws://127.0.0.1:${port}/ext`);
	await ext.connect();
	ext.hello([]);
	await waitFor(() => srv.bridge.ready, "bridge ready");

	const cdp = new FakeCdpClient(`ws://127.0.0.1:${port}/cdp`);
	await cdp.connect();
	t.after(() => cdp.close());
	await cdp.call("Target.setDiscoverTargets");

	ext.send({ t: "tabCreated", tab: fakeTab(77, "https://new.example/") });
	await waitFor(
		() => cdp.events.some(m => m.method === "Target.targetCreated" && m.params?.targetInfo?.targetId === "PAGE77"),
		"targetCreated for PAGE77",
	);
	ext.close();
});
