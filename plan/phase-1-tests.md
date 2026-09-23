# Phase 1 Tests — Chrome relay sidecar

**Scope:** Offline contract tests for the vendored Node relay server (`chrome-relay/server.ts` + verbatim `bridge.ts`), the sidecar CLI wiring, and the extension host-field delta. No Chrome, no `agent-browser`, no network beyond loopback.
**Key Pattern:** Fake `chrome.debugger` peer — a fake extension WebSocket client speaks `protocol.ts` (hello/rpcResult/cdpEvent) and answers the bridge's RPCs; a fake CDP client exercises the Puppeteer/Playwright-facing surface. The bridge treats both identically to real peers, so the relay's full request path runs for real.
**Dependencies:** `ws` (client + server, runtime dep), `node:test` + `node:assert/strict` per repo convention. Heavy dependency faked: Chrome itself (the extension peer IS Chrome's proxy).
**User Stories:**

| # | User Story | Validation Check | Pass Condition |
|---|-----------|-----------------|----------------|
| US-1 | As an agent, I can discover the relay through Chrome's CDP discovery endpoint, so `connect` needs no special-casing | `test/chrome-relay.sidecar.test.ts` discovery assertions | `/json/version` 503 pre-hello → 200 + `webSocketDebuggerUrl` post-hello; `/json/list` lists minted `PAGE<tabId>` targets; test exits 0 |
| US-2 | As an agent, I can drive a tab through the façade exactly as through real Chrome | CDP round-trip assertions in the same file | `Browser.getVersion` reflects hello data; `Target.attachToTarget` on `PAGE42` mints a session; a forwarded page command round-trips through an extension RPC and back |
| US-3 | As the browser's owner, the relay cannot be hijacked or weaponized | safety assertions + structural greps | `Browser.close` acknowledged but never forwarded; `/cdp` upgrade with `Origin` rejected; `/ext` token enforced; bind address is `127.0.0.1`; test file contains no `spawn`/`--remote-debugging`/non-loopback host |
| US-4 | As an operator, I can start/inspect/stop the sidecar and locate the extension | CLI structural checks + dogfood | `scripts/chrome-relay.mjs` has `start/status/stop/token/extension-path` subcommands and writes state to `os.tmpdir()`; live round-trip verified at dogfood (Task 1.6, not in offline gate) |
| US-5 | As a maintainer, vendored code stays auditable | `chrome-relay/VENDOR.md` exists | Names upstream repo/commit, lists the extension delta, carries MIT NOTICE |

## 1. Component mock strategy

| Component | Mock | Assert | Protects |
|---|---|---|---|
| Relay HTTP discovery | real `startRelayServer` on port 0 + `node:http` fetch | 503 body shape `{error, extensionSeen, uptimeMs}`; 200 with `webSocketDebuggerUrl: ws://127.0.0.1:<port>/cdp`; 404/405 fallbacks | US-1 |
| Chrome extension peer | `FakeExtension` WS client on `/ext` (speaks `protocol.ts`) | hello accepted; `rpc {op:"send"}` replies routed back as CDP responses; detach RPC on last session release | US-2, US-3 |
| Downstream CDP client | raw `WebSocket` on `/cdp` (no Origin) | request/response id+sessionId framing; minted `ST/SP` session ids | US-2 |
| Bridge `Target.*` emulation | vendored verbatim — tested through the two fake peers above | `Target.getTargets`/`attachToTarget`/`getTargetInfo` shapes | US-2 |
| Safety invariants | adversarial clients | `Browser.close` no-op; Origin-403 on `/cdp`; 401 token mismatch on `/ext` | US-3 |
| Sidecar CLI | not unit-tested offline (thin `parseArgs` + tmpdir state) | structural grep for subcommands; live round-trip deferred to Task 1.6 dogfood | US-4 |
| Extension host delta | not unit-tested (browser-only code, esbuild bundle committed) | structural: `background.js` builds from the delta source; options page wires `host` | US-4 |

## 2. Test tiers

| Tier | Scope | Dependencies | When |
|---|---|---|---|
| Unit/offline (default gate) | `test/chrome-relay.sidecar.test.ts` — server + bridge via fake peers | `ws` loopback only | every `npm test` |
| Dogfood (manual/Task 1.6) | packaged sidecar + real Chrome for Testing + real `agent-browser` | Chrome, upstream CLI | release/PR evidence |

No integration tier beyond the default gate: the offline tier already runs the real bridge end-to-end against fake peers; a real-Chrome tier would duplicate Task 1.6 with flakiness the repo does not want in the default gate.

## 3. Fake/mock implementations

`FakeRelayExtension` (lives inside the test file — node:test has no conftest):

```ts
class FakeRelayExtension {
	socket: WebSocket | null = null;
	readonly received: Array<any> = [];
	constructor(readonly url: string, readonly opts: { token?: string; origin?: string } = {}) {}
	connect(): Promise<void> {
		const suffix = this.opts.token ? `?token=${encodeURIComponent(this.opts.token)}` : "";
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url + suffix, { headers: this.opts.origin ? { origin: this.opts.origin } : {} });
			ws.on("open", () => { this.socket = ws; resolve(); });
			ws.on("message", raw => this.received.push(JSON.parse(String(raw))));
			ws.on("error", reject);
		});
	}
	hello(tabs: unknown[] = [], attached: number[] = []): void {
		this.socket!.send(JSON.stringify({ t: "hello", userAgent: "FakeUA Chrome/153.0.0.0", browserVersion: "Chrome/153.0.0.0", tabs, attachedTabIds: attached }));
	}
	/** Reply to the next pending rpc matching op; resolves the reply for assertions. */
	reply(op: string, result: unknown): void {
		const req = this.received.find(m => m?.t === "rpc" && m.op === op && !m.__answered);
		assert.ok(req, `expected a pending ${op} rpc`);
		(req as any).__answered = true;
		this.socket!.send(JSON.stringify({ t: "rpcResult", id: req.id, ok: true, result }));
	}
	nextEvent(): Promise<any> { /* resolve on next outbound message */ }
	close(): void { this.socket?.close(); }
}
```

`cdpCall(client, {id, method, params, sessionId})` helper: send, await matching `id`, return `{result}` / throw `{error}`. No other fakes needed — the server and bridge run for real.

## 4. Test file list

```
test/
└── chrome-relay.sidecar.test.ts   # all offline coverage: discovery, targets, round-trip, safety, bind (one file, ~8 focused tests)
```

## 5. Test helpers / fixtures

node:test has no conftest; helpers live in the test file: `startTestServer({token?})` (port 0, awaits `ready`), `FakeRelayExtension`, `cdpConnect/Call`, `after` hooks that `stop()` servers and close sockets. The two fake tab fixtures mirror `TabSnapshot` (tabId 42 eligible `https://example.com/`; tabId 43 `chrome://settings` — must be hidden from `/json/list` and `Target.getTargets`).

## 6. Key testing decisions

| Decision | Approach | Rationale |
|---|---|---|
| Real bridge under test | fake peers, not a stubbed bridge | the bridge is vendored verbatim — its exact behavior IS the contract (US-2) |
| Port 0 | `startRelayServer({port: 0})` + `await ready` | no port collisions under `--test-concurrency=1` |
| No Chrome | fake extension answers RPCs | keeps default gate offline/fast; real-Chrome coverage is Task 1.6 dogfood |
| Safety tests use adversarial inputs | Origin-bearing upgrade, wrong token, `Browser.close` | these are the invariants omp ships and we must not regress (US-3) |
| CLI not unit-tested | thin arg parsing over the tested server | AGENTS.md: do not overengineer; dogfood covers it |

## 7. Example test case

```ts
test("discovery: 503 before extension hello, 200 with ws url after", async () => {
	const srv = await startTestServer();
	t.after(() => srv.stop());
	const before = await fetchJson(srv.port, "/json/version");
	assert.equal(before.status, 503);
	assert.equal(before.body.extensionSeen, false);

	const ext = new FakeRelayExtension(`ws://127.0.0.1:${srv.port}/ext`);
	await ext.connect();
	ext.hello([{ tabId: 42, url: "https://example.com/", title: "Example", active: true, windowId: 1, pinned: false, groupId: -1 }]);
	await waitFor(() => srv.bridge.ready);

	const after = await fetchJson(srv.port, "/json/version");
	assert.equal(after.status, 200);
	assert.match(String(after.body.Browser), /Chrome\/153/);
	assert.equal(after.body.webSocketDebuggerUrl, `ws://127.0.0.1:${srv.port}/cdp`);
	const list = await fetchJson(srv.port, "/json/list");
	assert.deepEqual(list.body.map(t => t.id), ["PAGE42"]);
	ext.close();
});
```

## 8. Execution prompt

Write `test/chrome-relay.sidecar.test.ts` per sections 1–7: node:test + assert/strict, ESM, `.js` import specifiers (`../chrome-relay/server.js`), port 0, fake extension + fake CDP clients, coverage = discovery (US-1), target listing + attach + forwarded-command round-trip (US-2), safety (US-3: Browser.close refusal, Origin-403, token-401, loopback bind), ineligible-URL hiding (`chrome://settings` absent). Do NOT spawn Chrome or `agent-browser`; do NOT test the CLI in this file. Run: `npx tsx --test test/chrome-relay.sidecar.test.ts`.

## 9. Run commands

```sh
npx tsx --test test/chrome-relay.sidecar.test.ts   # fast, this phase
npm test                                            # full default gate (builds dist first)
```
