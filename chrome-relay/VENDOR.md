# Vendored: Chrome relay (browser-relay) from can1357/oh-my-pi

The relay lets `agent-browser` drive the user's real, headed Chrome through an
MV3 extension instead of a Playwright-launched browser, with no
`--remote-debugging-port`. Upstream was written for Bun; the server runtime
here is a Node port.

- **Upstream:** https://github.com/Can1357/oh-my-pi (MIT License © Can Bölük /
  Stencil Labs)
- **Vendored:** 2026-09-22 from `main`
- **License:** MIT (`chrome-relay/LICENSE`, matching `packages/browser-relay/package.json` upstream)

## Files

| File | Status |
|---|---|
| `bridge.ts` | Vendored; single-line delta: `import type … from "./protocol"` → `"./protocol.js"` (Node ESM emit). |
| `protocol.ts` | Verbatim. |
| `server.ts` | **Node port** of upstream `server/server.ts` (Bun.serve → node:http + `ws`). Same routes, responses, limits (256 MiB max payload), 30 s ping keepalive, loopback-only bind. Node shape deltas: `startRelayServer` gains a `ready` promise and `address()` because `listen` is async; `port` is a getter. |
| `promises.d.ts` | Local: ES2024 `Promise.withResolvers` declaration (vendored code uses it; repo targets ES2022 lib). |
| `extension/manifest.json` | Verbatim. |
| `extension/background.ts` | Vendored + two deltas: the protocol import points at the vendored copy (`../protocol` instead of the upstream monorepo path), and the relay host is configurable (settings default `127.0.0.1`) so WSL2 NAT setups can point the extension at the Linux side. Host validated as a bare hostname/IP (no scheme/path/whitespace). |
| `extension/options.html`, `options.js` | Vendored + Host field. |
| `extension/background.js` | Built bundle of `background.ts` — **committed**; rebuild with `bunx esbuild chrome-relay/extension/background.ts --bundle --format=iife --platform=browser --outfile=chrome-relay/extension/background.js --log-level=warning`. |

Security invariants inherited from upstream and kept: loopback-only bind,
`Origin` rejection on `/cdp`, `chrome-extension://` origin + optional token on
`/ext`, `Browser.close` never forwarded to Chrome, `chrome://` pages
ineligible, 256 MiB max payload, 30 s ping keepalive.

Update by re-copying the upstream files and re-applying the deltas above, then
rebuilding `extension/background.js` and re-running `npm test`.
