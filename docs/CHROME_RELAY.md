# Chrome relay sidecar

The optional Chrome relay lets the `agent_browser` tool drive the user's real,
headed Chrome — with all of its signed-in sessions, extensions, and cookies —
instead of a Playwright-launched browser. No `--remote-debugging-port` is
involved (Chrome 136+ refuses that flag on the default profile anyway); the
browser side is a small MV3 extension that proxies `chrome.debugger` over one
websocket to a local relay server, which impersonates Chrome's CDP discovery
endpoint so `connect` needs no special-casing.

The relay is vendored from [oh-my-pi](https://github.com/Can1357/oh-my-pi)
(MIT) with a Node server port and a configurable-host extension delta; see
[`chrome-relay/VENDOR.md`](../chrome-relay/VENDOR.md) for the exact deltas.

## Quick start

1. Build the relay server (once per checkout or after relay changes):

   ```sh
   npm run build
   ```

2. Start the sidecar in the foreground and generate a shared token:

   ```sh
   npx pi-agent-browser-chrome-relay start --token-gen
   # chrome relay listening on ws://127.0.0.1:9224/cdp
   # token (paste into the extension options): <printed once here>
   ```

3. Load the extension in the real Chrome: open `chrome://extensions`, enable
   Developer mode, **Load unpacked**, and pick the directory printed by
   `npx pi-agent-browser-chrome-relay extension-path`. Chrome shows the
   "started debugging this browser" infobar while the relay drives it.

4. Paste the printed token into the extension's options page (plus a different
   host/port if you changed them). The extension reconnects automatically.

5. Connect from the wrapper like any CDP browser:

   ```json
   { "args": ["connect", "ws://127.0.0.1:9224/cdp"], "sessionMode": "fresh" }
   ```

`status` reports whether the server is up and the extension has completed its
handshake; `stop` terminates the recorded `start`. State lives in the OS temp
directory, so `status`/`stop` work from other shells — and both act on the
most recent `start` (single state slot; a second instance on another port
overwrites it).

## Commands

| Command | Purpose |
|---|---|
| `start [--port N] [--token SECRET \| --token-gen]` | Run the relay in the foreground (default port 9224); Ctrl-C to stop |
| `status` | `{running, pid, port, extensionConnected, extensionSeen}` as JSON |
| `stop` | SIGTERM the recorded relay and clear state |
| `token` | Print a fresh random shared token |
| `extension-path` | Print the unpacked-extension directory for `chrome://extensions` |

## Windows Chrome + WSL2

Validated live (2026-09-22, WSL2 NAT with `localhostForwarding=true`, the
default): **nothing extra is needed.** Chrome on Windows dials
`127.0.0.1:<port>`; WSL localhost forwarding delivers the connection to the
relay's loopback socket; the extension's default Host (`127.0.0.1`) just
works. No portproxy, no host changes.

If localhost forwarding is off on your machine, bridge — don't re-point:

1. **Fallback: socat inside WSL.** Run
   `socat TCP-LISTEN:9224,bind=<WSL_IP>,fork,reuseaddr TCP:127.0.0.1:9224`
   (get `<WSL_IP>` from `ip -4 addr show eth0`; it changes on reboot), then
   set the extension's *Relay host* to `<WSL_IP>` via its options page. The
   relay itself keeps its loopback-only bind.
2. **Why not dial the WSL IP directly?** The relay binds `127.0.0.1` only, so
   connections addressed to the eth0 IP are refused by design — that is the
   security invariant, not a bug. Any forwarder (e.g. Windows `netsh`
   portproxy recipes) must ultimately land on a listener that hands off to
   `127.0.0.1` inside WSL, i.e. the socat bridge above.

## Driving your real browser: tab semantics

The wrapper's `open <url>` navigates the session's *current* tab, and
`tab close` with no argument closes that same tab — on an adopted browser
that tab may be one of the user's real tabs (learned in dogfood: this closed
an operator's live tab; Chrome's Ctrl+Shift+T restored it). The safe pattern:

- open pages in a fresh tab with `tab new <url>`;
- close tabs by explicit id: `tab close <tN>` (ids from `tab list`);
- `close --all` ends the wrapper session only — the user's tabs and the
  browser itself stay exactly as they were.

## Security model

## Security model

- The server binds `127.0.0.1` only, and rejects websocket upgrades bearing an
  `Origin` header on `/cdp`, so a web page cannot drive the relay. `/ext` only
  accepts `chrome-extension://` origins and, when configured, requires the
  shared token as `?token=`.
- Anything that *can* reach the port can drive the logged-in browser — read
  page content, click, exfiltrate cookies through pages. Start the relay only
  while using it, and prefer `--token-gen` whenever anything else runs on the
  machine.
- Inherited from upstream: `Browser.close` is acknowledged but never forwarded
  (the user's browser never dies), `chrome://` pages are ineligible targets,
  and payloads cap at 256 MiB.
- Chrome shows its debugging infobar while the extension holds a tab, and only
  one debugger may attach per tab; the extension reports detach/replace as
  events rather than failing silently.
