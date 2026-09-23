# Phase 1 — Chrome relay sidecar ("Rung 2" of the relay evaluation)

**Duration:** ~9 hours (1–1.5 days)
**Depends on:** Completed spike (2026-09-22, `~/projects/chrome-relay-spike`): oh-my-pi's browser-relay proven end-to-end against this wrapper with **zero wrapper changes** — `agent_browser connect ws://127.0.0.1:9224/cdp` drove a real Chrome (no debug port) through the MV3 `chrome.debugger` extension; connect / tab list / open / snapshot -i / eval / screenshot / click all passed on Chrome for Testing 153 headless.
**Blocks:** Nothing (optional follow-ups: managed sidecar auto-start, tab grouping — both deliberately deferred).
**Risk Level:** MEDIUM — the core interop risk was retired by the spike; what remains is a Node port, a small extension fork delta, packaging, and docs-lockstep, each independently verifiable.
**Stack:** typescript
**Runner:** pi (repo checkout at `~/projects/pi-agent-browser-native`)

---

## Objective

Productize the proven relay spike as an opt-in sidecar in this package: a vendored, MIT-attributed copy of oh-my-pi's browser-relay (Chrome MV3 extension + CDP-façade bridge + HTTP/WS server, ported from Bun to Node) exposed through a new `pi-agent-browser-chrome-relay` bin, plus the docs an agent and operator need to drive the user's **real, logged-in Chrome** — the one leg upstream CDP cannot do since Chrome 136 blocked `--remote-debugging-port` on the default profile.

Non-goals (AGENTS.md "thin, don't overengineer"): no config-policy integration, no auto-start broker/leases, no tab grouping, no new tool input modes, no changes to the `agent_browser` tool contract. The upstream `connect <ws-url>` path is already the entire integration surface.

## What Success Looks Like

1. `npm run build` compiles `chrome-relay/` TS into `dist/chrome-relay/`; `npm test` (default offline gate, `tsx --test --test-concurrency=1`) exits 0 including the new `test/chrome-relay.sidecar.test.ts` (no Chrome, no upstream binary required).
2. `pi-agent-browser-chrome-relay start` binds **127.0.0.1 only**, prints the port, and `curl -s http://127.0.0.1:<port>/json/version` returns **503** before the extension connects and **200** with a `webSocketDebuggerUrl` after a fake (test) or real extension hello.
3. With the extension loaded in a Chrome and the sidecar running, `agent_browser` `{ "args": ["connect", "ws://127.0.0.1:<port>/cdp"], "sessionMode": "fresh" }` → `snapshot -i` returns real refs from a real tab (spike gauntlet re-run through the packaged sidecar).
4. `pi-agent-browser-chrome-relay status` reports server/extension state; `stop` terminates cleanly; `--token` mode rejects the extension without the matching `?token=`.
5. `docs/CHROME_RELAY.md` exists with Linux/macOS/Windows-WSL setup (including the NAT `netsh portproxy` path), security notes, and the exact `chrome://extensions` Load-unpacked steps; README links it; `docs/SUPPORT_MATRIX.md` gains one RQ row; `docs/COMMAND_REFERENCE.md` connect section cross-links it (human-authored region only).

**Good:** "`curl http://127.0.0.1:9224/json/version` returns 200 `{\"Browser\":\"Chrome/153…\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:9224/cdp\"}` after `extension connected` appears in the sidecar log"
**Bad:** "The relay works"

## Architecture / Key Design Decisions

```
┌────────────────────────┐         ┌─────────────────────────────────────────────┐
│ Chrome (any profile)   │         │ pi-agent-browser-chrome-relay (Node, WSL/PC)│
│  MV3 extension         │  WS     │                                             │
│  chrome.debugger ──────┼────────►│ /ext  ─► RelayBridge ◄─► /cdp (WS, Origin-  │
│  chrome.tabs events    │         │                  │            rejected)     │
└────────────────────────┘         │  /json/version + /json/list (CDP discovery) │
        ▲ attaches per tab,        │  loopback bind ONLY · optional token        │
        │ no debug port needed     └──────────────────┬──────────────────────────┘
        │                                             │ ws://127.0.0.1:<port>/cdp
┌───────┴──────────────────────────────────────────────▼──────────────────────┐
│ agent-browser (Playwright CDP client)  ◄──  agent_browser connect <ws-url>  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Model Strategy

| Layer | Type | Why |
|-------|------|-----|
| Vendored `protocol.ts` / `bridge.ts` | `interface` + `class`, unchanged from upstream | They are MIT-vendored verbatim; diverging only costs review time. Keep the delta in `server.ts` and the extension only. |
| Ported server (`chrome-relay/server.ts`) | `interface RelayServerOptions` kept identical to upstream's | Same surface so `spike-server.ts`-style entries keep working; only the transport (Bun.serve → node:http + ws) changes. |
| Sidecar CLI state | plain JSON file in `os.tmpdir()` (pid, port, token fingerprint) | A sidecar is process state, not user config. No `config-policy.js` integration — that path carries locked tests + 5-doc tax this phase does not need. |
| CLI args | `node:util.parseArgs`, flags only | No new config schema, no env overrides beyond what upstream already reads. |

**Other critical rules for this phase (inherited + repo rules):**
- Security invariants carried from omp, enforced in code: bind `127.0.0.1` only; reject any `Origin` header on `/cdp`; on `/ext` reject non-`chrome-extension://` origins; optional token via `?token=`; `Browser.close` refused in the bridge (vendored, already enforced); `chrome://`-family URLs ineligible (vendored).
- Do **not** modify `lib/config-policy.js` / `lib/config.ts` / tool input modes / `index.ts` tool behavior. The only allowed wrapper-side edits are: `package.json` (bin/files/dependencies), a new `chrome-relay/` directory, a new test file, and docs.
- Keep the vendored `bridge.ts`/`protocol.ts` byte-identical to upstream `main` (as of 2026-09-22); record the upstream commit in `chrome-relay/VENDOR.md` alongside the MIT NOTICE.
- The extension fork delta (configurable host, Task 2) stays minimal and documented; default `127.0.0.1` preserves upstream behavior. Worth upstreaming to can1357/oh-my-pi as a PR after merge.
- Windows-WSL reality: WSL is in **NAT** mode, so Windows Chrome's `127.0.0.1:<port>` cannot reach the WSL sidecar. Two supported answers, both documented: (a) the extension's new host field pointing at the WSL eth0 IP, or (b) `netsh interface portproxy` on Windows. Neither is code in this repo.

## Tasks

### Task 1.1 — Port the relay server from Bun to Node (1.5h)

Recreate `server.ts` as `chrome-relay/server.ts` with identical HTTP routes and semantics on `node:http` + `ws`.

```ts
// Confirmed: ws v8 official docs (npmjs.com/package/ws, github.com/websockets/ws doc/ws.md), 2026-09-22
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
const server = createServer(requestHandler);           // /json/version, /json, /json/list
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {           // route by url.pathname: /cdp | /ext
  // Origin checks here, BEFORE handleUpgrade
  wss.handleUpgrade(req, socket, head, ws => { /* role: cdp | ext */ });
});
// keepalive: setInterval(() => ws.ping(), 30_000) over all sockets; no idleTimeout needed
```

[Implementation notes: preserve upstream's exact responses — `/json/version` 503 body `{error, extensionSeen, uptimeMs}` before hello; `webSocketDebuggerUrl` built from a validated `Host` header (port the `isWsAuthority` guard); `/json/list` page-targets only. Replace `Bun.ServerWebSocket` typing with a local `RelaySocket` interface (`send`/`close`/`ping`). Add `ws` as a runtime `dependency` (it is needed from installed packages too, not dev-only).]

**Sanity check:** `bun test`-free — `npx tsx -e "import {startRelayServer} from './chrome-relay/server'; console.log(startRelayServer({port:0}).port)"` prints an ephemeral port.

### Task 1.2 — Extension fork delta: configurable host + committed build (1h)

Add an optional **Host** field to the extension options (default `127.0.0.1`), used by `background.ts` when dialing `ws://<host>:<port>/ext`. Validate the host value (no scheme, no path, no whitespace — reuse an `isWsAuthority`-style guard). Build `background.js` with esbuild:

```sh
# Confirmed working 2026-09-22 (spike):
bunx esbuild chrome-relay/extension/background.ts --bundle --format=iife \
  --platform=browser --outfile=chrome-relay/extension/background.js --log-level=warning
```

[Notes: options storage gains `host` next to `port`/`token`; service-worker restart reads it back like the others. Commit the built `background.js` (the package must not require esbuild at install time); add a `prepare`-adjacent build step only if trivial.]

**Sanity check:** `grep -o "ws://\${" chrome-relay/extension/background.js` no longer shows a hardcoded `127.0.0.1` literal outside the default.

### Task 1.3 — Sidecar CLI `pi-agent-browser-chrome-relay` (2h)

**Depends on:** 1.1

New bin (follow the existing `pi-agent-browser-doctor` / `pi-agent-browser-config` bin + files patterns in `package.json`). Subcommands:

- `start [--port <n>] [--token <secret>|--token-gen] [--no-group-notice]` — starts the server (default port 9224, fail if taken, like upstream), writes `{pid, port}` state JSON to `os.tmpdir()/pi-agent-browser-chrome-relay.json`, prints the connect URL and the Load-unpacked path.
- `status` — reads state, probes `GET /json/version`, reports server + extension (`extensionSeen`, `ready`) state.
- `stop` — kills the recorded pid, removes state.
- `token` — prints a generated secret for the options page.
- `extension-path` — prints the absolute path of the bundled `chrome-relay/extension/` for `chrome://extensions` → Load unpacked.

[Notes: enforce loopback bind in code regardless of flags; never log the token; no daemon supervision — this is start/stop, not a broker (AGENTS.md no-overengineering).]

**Sanity check:** `pi-agent-browser-chrome-relay start && pi-agent-browser-chrome-relay status && pi-agent-browser-chrome-relay stop` round-trips.

### Task 1.4 — Offline test `test/chrome-relay.sidecar.test.ts` (2h)

**Depends on:** 1.1, 1.2

Default-gate test (must not launch Chrome or `agent-browser`): start the server on port 0, connect a **fake extension client** (a `ws` client speaking `protocol.ts`: `hello` with two fake `TabSnapshot`s, then answering `rpc`s), connect a **fake CDP client**, and assert:

1. `/json/version` → 503 pre-hello, 200 with `webSocketDebuggerUrl` post-hello.
2. `/json/list` returns exactly the eligible fake page targets (minted `PAGE<tabId>` ids).
3. CDP `Browser.getVersion` returns the hello's UA/product; `Target.getTargets` reflects the fake tabs; a forwarded page command (e.g. `Runtime.evaluate`) round-trips through an `rpc {op:"send"}` reply from the fake extension.
4. `Browser.close` is acknowledged but refused (no `rpc` reaches the extension); `/cdp` upgrade with an `Origin` header is rejected 403.

[Notes: use the `ws` client package in tests; ephemeral ports; `t.after` cleanup like neighboring tests.]

**Sanity check:** `npx tsx --test test/chrome-relay.sidecar.test.ts` exits 0 offline.

### Task 1.5 — Docs + packaging lockstep (1.5h)

**Depends on:** 1.3

- New `docs/CHROME_RELAY.md`: what it is, threat model (loopback exposure = any local process can drive the logged-in browser; token; infobar; one-debugger-per-tab; `chrome://` ineligible), Linux/macOS setup, **Windows-WSL section** (NAT: extension host field = WSL eth0 IP, or admin `netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=9224 connectaddress=<WSL_IP> connectport=9224`; WSL IP changes on reboot), exact `chrome://extensions` → Developer mode → Load unpacked steps, and the `agent_browser connect ws://…/cdp` recipe.
- README: short section linking the doc. `docs/COMMAND_REFERENCE.md`: cross-link from the human-authored `connect` row area. `docs/ARCHITECTURE.md`: one paragraph (sidecar is process-external, wrapper unchanged). `docs/SUPPORT_MATRIX.md`: one RQ row. `chrome-relay/VENDOR.md`: upstream commit, file list, delta list, MIT NOTICE text.
- `package.json`: bin, files, `ws` dependency.

**Sanity check:** `npm run docs -- command-reference check` still green; `npm run typecheck` green.

### Task 1.6 — Dogfood through the packaged sidecar (1h)

**Depends on:** 1.3, 1.5

Re-run the spike gauntlet against the packaged build (this box: WSL Chrome for Testing 153, headless=new, `--load-extension`): start → connect `ws://127.0.0.1:9224/cdp` (`sessionMode: "fresh"`) → `tab list` → `open https://example.com` → `snapshot -i` (refs) → `eval` → `screenshot` → `click` → `close --all`, `sidecar stop`. On the operator's Windows Chrome, the manual Load-unpacked + host-field/portproxy path validates the NAT section of the doc.

**Sanity check:** sidecar log shows `cdp client connected` + `extension connected`; snapshot refs match the live tab.

## Deliverables

```
pi-agent-browser-native/
├── chrome-relay/
│   ├── server.ts              # Node port of upstream server.ts (http + ws, same routes/responses)
│   ├── bridge.ts              # VENDORED verbatim (upstream main, 2026-09-22)
│   ├── protocol.ts            # VENDORED verbatim
│   ├── VENDOR.md              # upstream commit, delta list, MIT NOTICE
│   └── extension/
│       ├── manifest.json      # VENDORED (unchanged)
│       ├── background.ts      # VENDORED + host-field delta (~15 lines)
│       ├── background.js      # committed esbuild bundle
│       ├── options.html/.js   # VENDORED + host-field delta
├── scripts/chrome-relay.mjs   # CLI implementation behind the new bin
├── test/chrome-relay.sidecar.test.ts   # offline fake-extension/fake-CDP contract test
├── docs/CHROME_RELAY.md       # setup, security, Windows-WSL NAT
└── docs/SUPPORT_MATRIX.md     # +1 RQ row (plus README/COMMAND_REFERENCE/ARCHITECTURE touches)
```

## Exit Criteria

- [ ] `npm run build` emits `dist/chrome-relay/` and `npm test` exits 0 including `test/chrome-relay.sidecar.test.ts` (offline: no Chrome, no `agent-browser` on PATH required)
- [ ] `pi-agent-browser-chrome-relay start` → `curl /json/version` gives 503 pre-hello / 200 + `webSocketDebuggerUrl` post-hello; `status`/`stop` round-trip; `--token` mismatch is rejected
- [ ] `/cdp` upgrade with any `Origin` header returns 403; server never binds non-loopback
- [ ] Dogfood gauntlet passes through the packaged sidecar (`snapshot -i` refs, eval, screenshot, click on a real tab)
- [ ] `docs/CHROME_RELAY.md`, README link, COMMAND_REFERENCE cross-link, ARCHITECTURE paragraph, SUPPORT_MATRIX RQ row, `VENDOR.md` all present; `npm run docs -- command-reference check` and `npm run typecheck` green

## Execution Prompt

Copy everything between the `---` lines into a new pi session (run inside `~/projects/pi-agent-browser-native`):

---
You are building Phase 1 of pi-agent-browser-native — the Chrome relay sidecar.

### What This Project Is
A Pi extension that wraps the upstream `agent-browser` CLI (Playwright-based, installed separately, currently 0.38.1 recommended / 0.35.0 floor) as a native `agent_browser` tool. Thin integration is the product boundary: no bundling upstream, no wrapper-owned authorization gates, no overengineering. Repo rules live in AGENTS.md — read it first; docs changes ship in lockstep (README, docs/COMMAND_REFERENCE.md, docs/ARCHITECTURE.md, docs/SUPPORT_MATRIX.md).

### Established by the Spike (2026-09-22, ~/projects/chrome-relay-spike — do not re-litigate)
- oh-my-pi's browser-relay (MIT) works against this wrapper with ZERO wrapper changes: `agent-browser connect ws://127.0.0.1:9224/cdp` drives a real Chrome (no debug port) through a MV3 `chrome.debugger` extension. Full gauntlet passed on Chrome for Testing 153: connect, tab list, open, snapshot -i, eval, screenshot (base64), click (real navigation).
- The bridge (`RelayBridge`) emulates the CDP browser target + `Target.*` domain and multiplexes downstream clients over the single `chrome.debugger` attachment per tab; Playwright's handshake passes unmodified.
- Vendored sources already exist verbatim in `~/projects/chrome-relay-spike/` (extension/manifest.json, extension/background.ts, extension/options.html, extension/options.js, server/bridge.ts, server/protocol.ts, server/server.ts). Copy them into `chrome-relay/` — do NOT fetch again, do NOT modify bridge.ts/protocol.ts. Record upstream commit in `chrome-relay/VENDOR.md` with the MIT NOTICE (© Can Bölük / Stencil Labs, github.com/can1357/oh-my-pi).
- `server.ts` is Bun-only (`Bun.serve` WebSocket API). Your job is the Node port (Task 1.1 pattern below).
- This box: WSL, NAT mode (WSL eth0 IP ≠ reachable from Windows Chrome via 127.0.0.1); bun + node v24 + Chrome for Testing 153 at ~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome.

### Your Goal for This Phase
Ship the relay as an opt-in sidecar: `chrome-relay/` (Node server + vendored bridge/protocol + extension with a configurable-host delta), a `pi-agent-browser-chrome-relay` bin (start/status/stop/token/extension-path), one offline test, and lockstep docs. NO changes to `lib/config-policy.js`, `lib/config.ts`, tool input modes, or `extensions/agent-browser/index.ts` behavior.

### Data Model Rules (follow exactly)
- Vendored `protocol.ts`/`bridge.ts`: byte-identical to upstream; `interface`/`class` as upstream wrote them.
- Ported `chrome-relay/server.ts`: keep upstream's `RelayServerOptions`/`RelayServer`/`RelayUnavailableInfo` interface shapes; only the transport layer changes (node:http + ws).
- Sidecar CLI state: plain JSON `{pid, port}` in `os.tmpdir()`; parse CLI args with `node:util.parseArgs`; no config-schema integration.
- New code in this repo follows existing TS conventions (`strict`, no `any` unless neighboring code does).

### Architecture
```
Chrome(MV3 ext, chrome.debugger) --WS /ext--> RelayBridge <--WS /cdp-- agent-browser (Playwright)
loopback bind ONLY · /cdp rejects any Origin · /ext allows chrome-extension:// · optional ?token=
/json/version 503 pre-hello, 200 + webSocketDebuggerUrl post-hello · Browser.close refused in bridge
```

### Confirmed Library APIs
```ts
// ws v8 (official docs, confirmed 2026-09-22) — server side:
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
const server = createServer(requestHandler);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/cdp") return socket.destroy();
  if (req.headers.origin) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => { ws.on("message", d => {}); });
});
// keepalive: setInterval(() => ws.ping(), 30_000)
```
```sh
# esbuild extension bundle — confirmed working 2026-09-22:
bunx esbuild chrome-relay/extension/background.ts --bundle --format=iife \
  --platform=browser --outfile=chrome-relay/extension/background.js --log-level=warning
```

### Files to Create
#### chrome-relay/server.ts
Node port of the vendored `server/server.ts`. Same routes (`/json/version`, `/json`, `/json/list`, WS `/cdp`, WS `/ext`), same status codes and JSON bodies, same Origin/token checks, same 30s ping keepalive, same `DEFAULT_GROUP = {title:"omp", color:"cyan"}` option passthrough to `RelayBridge`. Replace Bun socket typing with a local `interface RelaySocket { send(t:string):void; close():void; ping?():void }`. Do not change `bridge.ts` imports — compile both under the repo tsconfig so `dist/chrome-relay/` emerges from `npm run build`.
#### chrome-relay/extension/ (background.ts, options.html, options.js, manifest.json, background.js)
Vendored + ONE delta: options gain a `host` field (default `127.0.0.1`, validated: no scheme/path/whitespace) that `background.ts` uses in `ws://${host}:${port}/ext`. Commit the esbuild-built `background.js`. Never log the token.
#### scripts/chrome-relay.mjs (+ package.json bin `pi-agent-browser-chrome-relay`, files, `ws` runtime dependency)
Subcommands: `start [--port N=9224] [--token S|--token-gen]`, `status`, `stop`, `token`, `extension-path`. start: fail if port taken; write `{pid,port}` state JSON to `os.tmpdir()/pi-agent-browser-chrome-relay.json`; print the connect URL `ws://127.0.0.1:<port>/cdp` and the extension path. status: probe `/json/version`, report `extensionSeen`/ready. stop: kill recorded pid. Import the server from `../dist/chrome-relay/server.js` (build first), matching how other scripts resolve dist.
#### test/chrome-relay.sidecar.test.ts
Offline contract test per Task 1.4 (fake extension WS client + fake CDP client over `ws`; assert 503→200 discovery, minted `PAGE<tabId>` targets, Browser.getVersion passthrough shape, Runtime.evaluate round-trip via an extension `rpc {op:"send"}` reply, Browser.close refusal, Origin-403). Port 0. Cleanup in `t.after`.
#### docs/CHROME_RELAY.md + doc touches + chrome-relay/VENDOR.md
Per Task 1.5. Include the Windows-WSL NAT section verbatim from the plan's design-decisions section, and the exact chrome://extensions Load-unpacked steps.

### Success Criteria
- All five Exit Criteria in plan/phase-1.md are met (build+offline tests, sidecar round-trip with 503/200 discovery, Origin-403 + loopback-only, packaged dogfood gauntlet, docs lockstep incl. `npm run docs -- command-reference check` + `npm run typecheck` green)
- `npm test` (default gate) exits 0
- No diffs outside: `chrome-relay/`, `scripts/chrome-relay.mjs`, `test/chrome-relay.sidecar.test.ts`, `docs/`, `README.md`, `package.json`(+lockfile)

### Expected File Structure at End
See "Deliverables" in plan/phase-1.md (same tree).
---

## Readiness Check

- [PASS] All inputs from prior phases are listed and available — spike workspace `~/projects/chrome-relay-spike/` holds verbatim vendored sources; repo checkout exists; Chrome for Testing 153 + bun + node v24 confirmed present
- [PASS] Every sub-task has a clear, testable completion condition — each task ends in a runnable sanity check
- [PASS] Execution prompt is self-contained — includes (a) spike-established facts inline (no "see spike"), (b) confirmed ws + esbuild snippets, (c) Data Model Rules, (d) per-file guidance, (e) observable success criteria
- [PASS] Exit criteria map 1:1 to deliverables — every file in the tree is exercised by a criterion
- [PASS] Heavy external dependency strategy — no Chrome/upstream binary in the default gate (fake extension + fake CDP clients); the only new runtime dep is `ws` (small, vendored-free)
- [PASS] New libraries have a confirmed usage snippet — `ws` v8 noServer/handleUpgrade/maxPayload/ping confirmed against official docs 2026-09-22; esbuild flags confirmed live in the spike
