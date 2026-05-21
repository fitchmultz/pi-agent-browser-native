# Electron desktop apps

Related docs:
- [`../README.md`](../README.md)
- [`../AGENTS.md`](../AGENTS.md) — maintainer verification (`npm run verify`, lifecycle), Pi `tmux` smoke expectations, and upstream rebaselining
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md) — full `electron` and `qa.attached` field contracts
- [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md) — workflow snippets in the broader native command surface
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — wrapper design and the closed `RQ-0068` recipe-layer decision
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) — `RQ-0096` Electron support row and verification gates

## Purpose

This guide is the entry point for using `pi-agent-browser-native` against desktop **Electron** applications. The wrapper exposes a top-level `electron` shorthand that owns the awkward discover → launch → attach → probe → cleanup sequence so agents do not hand-build `--remote-debugging-port` argv, poll `DevToolsActivePort`, and `kill` profile directories. After attach, the rest of the native `agent_browser` surface (`snapshot`, `find`, `click`, `fill`, `get`, `eval --stdin`, `batch`, `qa.attached`, and similar) works the same way it does against a web page.

This document is structured for users, not implementers. Field-level rules live in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron); this guide focuses on **when** and **how** to use them, and on the safety and ownership boundary the wrapper enforces.

## Who this is for

- **Pi users** who want an agent to operate a local Electron app the same way it operates a web page.
- **Coding agents** that need a low-context lifecycle for desktop apps such as VS Code, Cursor, Obsidian, Slack, or any app built on Electron, without re-implementing the CDP attach dance every session.
- **Maintainers and reviewers** validating the wrapper's Electron behavior before release; verification evidence lives under `RQ-0096` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

It is **not** an upstream `agent-browser` reference and it does **not** replace the canonical [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron) for exact field semantics, validation rules, or failure categories.

## Mental model

```
electron.list       → discover Electron apps (host-only; no upstream spawn)
electron.launch     → launch a wrapper-owned isolated app, attach via CDP, hand off (snapshot|tabs|connect)
electron.status     → liveness, debug-port, and target inspection (read-only)
electron.probe      → compact one-call state read (title/url/focus/tabs/snapshot)
electron.cleanup    → close managed session, stop the tracked process, remove the temp profile
qa.attached         → smoke check against the currently attached session (no URL)
```

Two ownership modes coexist:

1. **Wrapper-owned launches** — `electron.launch` starts a brand-new app process with an **isolated temporary user-data-dir** and an **OS-chosen debug port**. The wrapper records a `launchId` for every such launch and `electron.cleanup` only operates on those `launchId`s.
2. **Manually launched apps** — you start the Electron app yourself (for example with `open -a Slack --args --remote-debugging-port=9222 --remote-allow-origins='*'`), then attach with `{ "args": ["connect", "9222"], "sessionMode": "fresh" }`. The wrapper does not own that process; **you** are responsible for shutting it down and cleaning its profile.

Choosing between the two is a real decision, not a stylistic one. See [Wrapper-owned vs manually launched](#wrapper-owned-vs-manually-launched).

## Quick start

Discover the app, launch with the default snapshot handoff, work with current refs, then clean up:

```json
{ "electron": { "action": "list", "query": "code" } }
{ "electron": { "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" } }
{ "args": ["snapshot", "-i"] }
{ "electron": { "action": "probe", "timeoutMs": 5000 } }
{ "electron": { "action": "cleanup", "launchId": "electron-…" } }
```

The launch result carries both a `launchId` (used by `status`/`probe`/`cleanup`) and an attached `sessionName` (used by browser-style `snapshot`/`tab`/`click`/`find` calls). Read both from `details.electron.launch` and `details.electron.identifiers`. With default implicit session reuse, the quick-start `args: ["snapshot", "-i"]` line uses that attached session without an extra `--session` argument; pass `--session` explicitly when you target a named upstream session instead.

For a quick "is the app actually showing what we expect?" smoke check after attach:

```json
{ "qa": { "attached": true, "expectedText": "Explorer", "screenshotPath": ".dogfood/electron.png" } }
```

`qa.attached` runs against the **current managed session** without opening a URL, so it works for any attached app — wrapper-owned or manually launched.

## Wrapper-owned vs manually launched

Pick the mode that matches the **state you need**.

| | `electron.launch` (wrapper-owned) | `args: ["connect", …]` (manual host launch) |
|---|---|---|
| Profile | Isolated temporary `userDataDir` | The app's normal profile (your real signed-in state) |
| Debug port | OS-chosen via `--remote-debugging-port=0` and `DevToolsActivePort` | Caller-supplied port (for example `9222`) |
| Signed-in state | **No** — first-run or empty profile | **Yes** — whatever is in the launched profile |
| Already-running app | Cannot attach to it | Required (or relaunch yourself with a debug port) |
| Lifecycle ownership | Wrapper owns shutdown and profile cleanup | **You** own shutdown and profile cleanup |
| When to use | Anything you can do against a fresh app: tooling, UX flows, scripted local QA, exploring panels, packaged debugging | Tasks that explicitly need the user's signed-in Slack/Obsidian/VS Code state |
| How to clean up | `electron.cleanup` with the returned `launchId` | Close the app yourself; do **not** call `electron.cleanup` |

### Manual host-launch pattern

When the explicit goal is the user's signed-in local app state and the app is not already running:

```bash
# macOS example
open -a Slack --args --remote-debugging-port=9222 --remote-allow-origins='*'
```

Then attach and clean up yourself:

```json
{ "args": ["connect", "9222"], "sessionMode": "fresh" }
{ "args": ["snapshot", "-i"] }
{ "qa": { "attached": true, "expectedText": "Channels" } }
```

If the app is already running without a debug port, ask before relaunching it — relaunching may lose unsaved state and Electron's single-instance behavior will silently drop a second invocation's `--remote-debugging-port` flag.

## Action reference

The exact field schemas, validation rules, and `details.*` payload shapes live in [`TOOL_CONTRACT.md#electron`](TOOL_CONTRACT.md#electron). This section is a usage-oriented overview.

### `electron.list` — discover apps

Host-only scan; does not spawn upstream `agent-browser`. macOS (`/Applications/*.app`, `~/Applications/*.app`) and Linux (`.desktop` launchers under standard XDG, Flatpak, and Snap locations) are supported in v1. On Windows (and any non-macOS/non-Linux host), `list` returns `details.electron.platform: "unsupported"` with an empty `apps` array—use `executablePath` (or a host `appPath` that resolves to a verifiable Electron binary) for `launch` instead; `inspectElectronExecutablePath` in `extensions/agent-browser/lib/electron/discovery.ts` still gates Windows executables before spawn.

```json
{ "electron": { "action": "list", "query": "code", "maxResults": 25 } }
```

Returns app metadata under `details.electron.apps`: `name`, optional `bundleId`/`desktopId`, `appPath`, `executablePath`, `platform`, and optional non-blocking `sensitivity` annotations. Apps flagged as likely sensitive (categories such as `notes`, `chat`, `mail`, `developer-workspace`, or `passwords-auth`) are printed with `[likely sensitive: …]`. These are **advisory hints**, not enforcement; see [Safety and ownership](#safety-and-ownership) for the policy boundary.

### `electron.launch` — launch and attach

Pass **exactly one** target: `appPath`, `appName`, `bundleId`, or `executablePath`. The wrapper resolves the target, verifies Electron framework evidence, applies optional caller-owned `allow` / `deny` policy, creates an isolated temp `userDataDir`, launches with `--remote-debugging-port=0` plus safe defaults, reads `DevToolsActivePort`, then attaches through upstream `connect` as a fresh managed session.

```json
{
  "electron": {
    "action": "launch",
    "appName": "Visual Studio Code",
    "handoff": "snapshot",
    "targetType": "page",
    "timeoutMs": 30000,
    "appArgs": ["--disable-telemetry"]
  }
}
```

Handoff selection (`handoff` field):

| Value | Behavior | When to use |
|---|---|---|
| `"snapshot"` (default) | Attach, list targets, capture `snapshot -i` in one call | You need interactive refs immediately for clicks/fills |
| `"tabs"` | Attach and list targets only | Safer diagnostic start when you only need target discovery |
| `"connect"` | Attach and stop | You will run your own follow-up commands |

`targetType` defaults to `"page"`; use `"webview"` or `"any"` for apps whose useful UI is exposed as a webview target.

Wrapper-owned launches **always** use an isolated temp profile and an OS-chosen port. `--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-address`, `--remote-debugging-pipe`, and bare `--` in `appArgs` are rejected. There is no caller-supplied port and no way to make `electron.launch` reuse the app's normal signed-in profile or attach to an already-running app — by design. Use the manual path described above when those are the actual requirements.

### `electron.status` — liveness and targets

Read-only inspection of one or more tracked launches. Without `launchId` or `all`, it selects the single active wrapper launch when unambiguous.

```json
{ "electron": { "action": "status" } }
{ "electron": { "action": "status", "launchId": "electron-…" } }
{ "electron": { "action": "status", "all": true } }
```

Reports `cleanupState`, debug-port and PID liveness, and bounded CDP target metadata under `details.electron.statuses`. Mismatch fields surface when the current managed session or tab no longer matches a live wrapper launch target — typically the cue to follow `reattach-electron-launch` before trusting old refs.

### `electron.probe` — compact state read

`probe` collapses what would otherwise be separate `get title` / `get url` / focused-element `eval` / `tab list` / `snapshot -i` calls into one bounded result. Use it instead of chaining those reads when you just need a quick "where are we?" check.

```json
{ "electron": { "action": "probe" } }
{ "electron": { "action": "probe", "launchId": "electron-…", "timeoutMs": 5000 } }
```

Output appears under `details.electron.probe`: `title`, `url`, `focusedElement`, `activeTab`, `tabs`, compact `snapshot` metadata (`refCount`, `refIds`, optional text preview and omission counts), and `errors`. When `launchId` is given, the probe is tied to that tracked launch and will surface mismatch guidance if the wrapper sees a session or target drift; visible output also includes debug-port/pid liveness so a stale `about:blank` against a dead launch is unmistakable.

`timeoutMs` bounds each underlying read subprocess. Use it for dense desktop apps when the default budget is too short, or to fail fast when you suspect the app process is wedged.

### `electron.cleanup` — wrapper-owned only

Closes the tracked managed session, stops only the wrapper-tracked process, verifies that the debug port no longer serves `/json/version`, and removes the wrapper-created `userDataDir`. Cleanup partial failures fail the tool result with `failureCategory: "cleanup-failed"` and the `retry-electron-cleanup` next action references the same `launchId` so retries are bounded.

```json
{ "electron": { "action": "cleanup", "launchId": "electron-…" } }
{ "electron": { "action": "cleanup", "all": true } }
```

`electron.cleanup` **never** targets:

- manually launched apps
- externally supplied debug ports
- arbitrary Electron processes the wrapper did not start

For manual launches, close the app yourself and clean its profile/temp files with normal host tools.

On Pi session shutdown, active wrapper-owned Electron launches are best-effort cleaned. Stale restored records (PID gone, port dead) are **reported** instead of guessed at or killed.

## `qa.attached` — current-session smoke check

`qa` has two forms: the URL form (`qa: { url, … }`) and the attached form (`qa: { attached: true, … }`). The attached form is the right tool for Electron smoke checks after either launch path because it does not open a URL and runs all checks against the current managed session.

```json
{
  "qa": {
    "attached": true,
    "expectedText": "Explorer",
    "expectedSelector": "@e1",
    "checkConsole": true,
    "checkErrors": true,
    "screenshotPath": ".dogfood/electron.png"
  }
}
```

`qa.attached` rejects `url` and is incompatible with `sessionMode: "fresh"` — attach first with `electron.launch` or raw `connect`, then run `qa.attached`. The full field rules and pass/fail classification live in [`TOOL_CONTRACT.md#qa`](TOOL_CONTRACT.md#qa).

In attached Electron sessions, broad selectors such as `body`, `html`, `main`, or `[role=application]` can read the entire app shell. When `get text <selector>` looks too broad, the wrapper may attach `details.electronGetTextScopeWarning` and a `snapshot-for-electron-text-scope` next action; prefer a fresh `snapshot -i`, a current `@ref`, or a narrower panel selector.

## `sourceLookup` against packaged Electron apps

`sourceLookup` is an experiment for hinting at the source file/component behind a visible element. It is **opt-in** and **evidence-based**: it reports confidence and evidence rather than claiming a guaranteed mapping. The same experimental helper works against packaged Electron apps, but with two important boundaries:

1. **Scope of the workspace scan.** `sourceLookup` walks the Pi session **cwd** (default `maxWorkspaceFiles: 2000`, hard cap 5000). It does **not** unpack `app.asar` or installed app resources. For packaged apps where the source lives inside `Contents/Resources/app.asar`, the workspace-search lane will commonly return no candidates.
2. **React DevTools requirement.** `react inspect <id>` requires the session to have been launched with `--enable react-devtools` before first navigation. For Electron, the wrapper's `electron.launch` path does **not** inject `--enable react-devtools` into the Electron process; that flag belongs to upstream `agent-browser` Chromium launches. If the Electron app does not already expose a React DevTools backend, expect `react inspect` to fail; DOM-attribute and workspace-search candidates may still surface.

For wrapper-tracked packaged Electron sessions where `status` is `no-candidates`, the wrapper attaches `workspaceRoot` plus optional `electronContext` (`launchId?`, `appName?`, `appPath?`, `executablePath?`, `sessionName?`, `url?`) and limitations explaining the bundle/asar boundary, plus `snapshot-electron-session`, `probe-electron-launch`, and `list-electron-tabs` next actions so you can inspect the live app and decide whether to widen the workspace or pull source out-of-band before re-running the lookup.

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

Treat `sourceLookup` output as a starting point for navigation, not a substitute for reading code. Full contract: [`TOOL_CONTRACT.md#sourcelookup`](TOOL_CONTRACT.md#sourcelookup).

## Safety and ownership

Remote debugging exposes app content (DOM, network, JavaScript) to the attached browser tool. The wrapper ships **isolation defaults**; it does **not** classify any app as too-risky-to-launch.

### What the wrapper always does

- Launches with `--user-data-dir=<wrapper-created-temp>` and `--remote-debugging-port=0`.
- Reads the OS-chosen port from `DevToolsActivePort`.
- Adds `--disable-extensions`, `--no-first-run`, and `--no-default-browser-check` alongside sanitized caller `appArgs`.
- Rejects `appArgs` that try to override lifecycle/debug flags.
- Refuses to launch non-Electron targets (correctness gate, not a security gate).
- Treats `electron.cleanup` as wrapper-owned only; never touches manually launched apps.

### What the **caller** owns

- The decision to launch or attach to a sensitive app in the first place.
- Optional `allow` / `deny` policy lists when you want guardrails.
- Profile and process cleanup for manually launched apps.
- Host-file cleanup for any explicit screenshots, downloads, HARs, traces, or recordings saved to caller-chosen paths. `electron.cleanup` does not touch these.

### Caller-owned policy: `allow` / `deny`

Both lists match `appName`, `bundleId`, `desktopId`, `appPath`, or `executablePath` by substring.

```json
{
  "electron": {
    "action": "launch",
    "appName": "Slack",
    "allow": ["Slack"],
    "deny": ["1Password", "Bitwarden"]
  }
}
```

Rules:

- If `allow` is set, the target must match at least one entry.
- If `deny` is set, a matching target is rejected.
- `deny` wins on conflict.
- With neither set, launch is permitted.

Policy mismatches fail with `failureCategory: "policy-blocked"` and `details.electron.failure.policy` names the matched list and entry.

### Likely-sensitive annotations

`electron.list` may annotate common private-data apps (`notes`, `chat`, `mail`, `developer-workspace`, `passwords-auth`) with `sensitivity.level: "likely-sensitive"` and a visible `[likely sensitive: …]` marker. These are **advisory hints only**. They do not block `launch` and they do not replace caller `allow` / `deny`.

## Failure categories and recovery

`details.failureCategory` values you should expect from Electron flows, with the recovery move:

| Category | When | Recovery |
|---|---|---|
| `validation-error` | Bad input (missing target, conflicting fields, non-Electron target) | Fix the request; the message names the problem |
| `policy-blocked` | Caller `allow` / `deny` rejected the launch | Adjust the policy or pick a different target |
| `timeout` | `DevToolsActivePort` never appeared in time | Inspect `details.electron.failure.diagnostics` (PID, profile path, port file state, elapsed/timeout); retry with a higher `timeoutMs` if the app legitimately needs more time |
| `upstream-error` | Launch/attach/spawn/CDP failure that does not fit a more specific bucket | Inspect `details.electron.failure.diagnostics`; the app may be missing dependencies or hitting a CDP race |
| `tab-drift` | A successful-looking command was followed by a dead process / debug port / unrecoverable `about:blank` | Use the appended `status-electron-launch` / `probe-electron-launch` next actions, then decide whether to relaunch |
| `cleanup-failed` | Cleanup only partially succeeded | Inspect `details.electron.cleanup.results[].steps` for remaining process/port/profile state; `retry-electron-cleanup` references the same `launchId` |
| `stale-ref` | `@e…` ref reused after a navigation/rerender | Take a fresh `snapshot -i` (or follow `refresh-electron-refs-after-rerender` when the wrapper appends it) |

Single-instance Electron behavior is a common cause of `timeout` and `upstream-error`. Many Electron apps enforce a single running instance and silently drop a second invocation's `--remote-debugging-port` flag. If the app is already running without a debug port, quit it first or use the manual host-launch path against the existing instance instead.

## Troubleshooting

### Launch hangs and then times out
- The app is enforcing single-instance; quit the running copy first, then retry.
- The app may have moved its Electron framework directory; pass `executablePath` explicitly.
- `timeoutMs` is too short for a heavy app; raise it (`launch.timeoutMs` is bounded but generous).
- Read `details.electron.failure.diagnostics`: presence/absence of `DevToolsActivePort`, port number, PID liveness, and elapsed time usually identify the issue.

### `electron.list` returns nothing
- On Linux, the binary may be a custom rebrand without `chrome_*.pak` siblings, an AppImage without a `.desktop` entry, or a statically linked fork. Pass `executablePath` directly.
- On macOS, apps installed outside `/Applications` and `~/Applications` are not scanned in v1. Pass `appPath` or `executablePath` explicitly.
- Windows hosts report `platform: "unsupported"` from `electron.list`; always pass `executablePath` (or a resolvable `appPath`) for `launch`.

### Attach succeeds but `snapshot -i` returns no refs
- Some Electron apps take a beat to render. The default `handoff: "snapshot"` already retries briefly; if it still reports no refs, run `snapshot -i` once more before treating the UI as blank.
- For apps whose UI lives in a webview, switch `targetType` to `"webview"` or `"any"` so the wrapper attaches to the right CDP target.

### "I clicked, but nothing happened"
- A successful upstream `click` means the action was dispatched, not that the app handled it. Re-snapshot, check `details.pageChangeSummary`, or use `qa.attached` to verify.
- Electron apps frequently rerender in place (no URL change). The wrapper may attach `refresh-electron-refs-after-rerender` to remind you to re-snapshot before reusing `@e…` refs.

### `fill` looks fine but the field is empty
- Custom quick-input controls (VS Code's quick-pick, command palette, etc.) often need focus + keyboard typing rather than a direct `fill`. The wrapper attaches `details.fillVerification` when `get value` disagrees with the requested text; follow `inspect-after-fill-verification` and switch to focus + `keyboard type` before submitting.

### `get text` returns the whole app
- Broad selectors (`body`, `html`, `main`, `[role=application]`) read the entire shell. Use a current `@ref` or a narrower panel selector. The wrapper attaches `details.electronGetTextScopeWarning` and a `snapshot-for-electron-text-scope` next action when it detects this pattern.

### `sourceLookup` says `no-candidates` for a packaged app
- Expected when the app's source lives inside `app.asar`. The wrapper does not unpack bundles. Use `electron.probe` / `snapshot-electron-session` / `list-electron-tabs` next actions to inspect the live UI, or pull source separately into the Pi session cwd before re-running the lookup.

### Mismatch between `status` and the active session
- `electron.status` may report a live wrapper launch while the managed session has drifted to `about:blank`. Follow `reattach-electron-launch`, then refresh refs with `snapshot-electron-session` before continuing.

## Cleanup checklist

Before ending the task:

- Call `electron.cleanup` (or `electron.cleanup` with `all: true`) for every wrapper-owned `launchId` you started. The result reports per-step state for `managed-session`, `process`, `debug-port`, and `user-data-dir`.
- Confirm `details.electron.cleanup.summary` does not list remaining resources.
- For **manually launched** apps, close the app yourself and clean any profile or temp files you created. `electron.cleanup` will not (and should not) touch them.
- Remove any explicit screenshots, recordings, downloads, PDFs, traces, or HAR files you saved to caller-chosen paths. Artifact cleanup is host-owned; the wrapper only reports them under `details.artifacts` and `details.artifactCleanup`.

If `cleanup` returns `failureCategory: "cleanup-failed"`, inspect `details.electron.cleanup.results[].steps` and use `retry-electron-cleanup` for the same `launchId`. Do not invent new cleanup commands for processes the wrapper did not start.

## Verification and benchmarks

Electron support is gated by the same release evidence as the rest of the wrapper:

- `RQ-0096` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) records the contract, runtime, test, and verification coverage.
- `electron-lifecycle` and `electron-probe` scenarios in `scripts/agent-browser-efficiency-benchmark.mjs` track the token-efficiency claim deterministically (no real browser, no real launches).
- Fake-upstream coverage for Electron schema/probe/mismatch/post-command-health/fill-verification/broad-text/discovery-sensitivity lives in `test/agent-browser.extension-validation.test.ts`.
- Real-app validation is a manual `tmux` smoke pass per the maintainer notes in `AGENTS.md`; the 2026-05-21 dogfood result is recorded at the end of [`docs/plans/electron-extension-2026-05-20.md`](plans/electron-extension-2026-05-20.md).

Run the local gate the same way as the rest of the project:

```bash
npm run verify
```

The token-efficiency claim has its own opt-in run:

```bash
npm run benchmark:agent-browser
```

## Where to go next

- For exact field semantics, schemas, and `details.*` payloads: [`TOOL_CONTRACT.md#electron`](TOOL_CONTRACT.md#electron) and [`TOOL_CONTRACT.md#qa`](TOOL_CONTRACT.md#qa).
- For workflow examples woven into the broader command surface: [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md#electron-desktop-apps).
- For the closed `RQ-0068` recipe-layer decision that bounds why Electron support is a typed shorthand and not a generic recipe runtime: [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet).
- For the full release-readiness audit and the `RQ-0096` evidence row: [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).
