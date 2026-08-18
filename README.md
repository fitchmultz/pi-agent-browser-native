# pi-agent-browser-native

A Pi extension that lets coding agents drive real browser sessions with a native `agent_browser` tool instead of brittle shell commands.

It is for Pi users who want agents to browse sites, inspect pages, click through flows, capture screenshots, use persistent profiles, and handle authenticated web apps without spending context on `agent-browser` CLI ceremony.

## Source-of-truth map

Start here for install and common usage. For deeper work, use the active docs by purpose:

| Need | Read |
| --- | --- |
| Command workflows and upstream CLI coverage | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md) |
| Native tool input/output contract and `details` fields | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) |
| Runtime design and package config policy | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Electron desktop lifecycle | [`docs/ELECTRON.md`](docs/ELECTRON.md) |
| Release gates and targeted upstream support | [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) |
| Maintainer release process | [`docs/RELEASE.md`](docs/RELEASE.md) |

The complete documentation ownership map lives in the repository source at [`docs/SOURCE_OF_TRUTH.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/docs/SOURCE_OF_TRUTH.md).

## What this looks like in Pi

You prompt the agent in plain English:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

The agent gets a native tool, not a bash workaround:

```json
{ "args": ["open", "https://react.dev"] }
{ "args": ["snapshot", "-i"] }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Learn React" } }
```

The last form compiles to upstream `find` argv; see [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) for the full field rules and for using raw `args` when you need anything outside that shorthand.

The result is optimized for agent work:

- compact page snapshots that lead with useful page content instead of chrome/sidebar noise
- interactive `@eN` refs for follow-up clicks and form fills
- screenshots and downloaded files surfaced as Pi artifacts
- structured details for titles, URLs, saved files, sessions, and errors
- spill files for oversized raw output instead of dumping pages into context
- compact, colorized Pi TUI rows that can be expanded without changing what the agent receives
- recovery hints when a tab, selector, stale `@ref`, or launch mode needs a different next step

## Who this is for

- **Pi users** who want browser automation available as a normal tool beside `read`, `write`, and `bash`.
- **Coding agents** that need low-context browser workflows for docs, QA, research, dashboards, provider-backed browsers, and web apps.
- **Maintainers** who want a thin integration that tracks the current upstream [`agent-browser`](https://agent-browser.dev/) CLI without bundling or re-implementing it.

## The problem

`agent-browser` is powerful, but plain CLI use is awkward inside an agent harness:

- shell strings are easy for agents to quote wrong
- large page snapshots can waste model context
- screenshots and downloads need artifact metadata, not just text paths
- implicit browser sessions need predictable reuse and cleanup
- profile/debug launches need a clear way to start fresh after public browsing
- secrets and auth material must not be echoed into model-visible output
- stale element refs need actionable recovery guidance, not generic failures

`pi-agent-browser-native` keeps upstream `agent-browser` as the browser engine and adds the Pi-native wrapper behavior needed for reliable agent use.

## What it does

| Pain | Native wrapper capability | Proof surface |
|---|---|---|
| Agents build fragile shell commands or repeat browser calls for loops and branches | Exposes `agent_browser` with one-shot sandboxed `script` orchestration, exact `args`, an optional `semanticAction` shorthand for common `find` flows and native `select`, constrained `job` / `qa` presets, experimental `sourceLookup` / `networkSourceLookup` that compile short workflows to `batch`, top-level `electron` for desktop lifecycle, plus controlled `stdin` and `sessionMode` | `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/input-modes/`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) |
| Page snapshots are too large or viewport-blind | Shows compact, main-content-first summaries, surfaces an `Omitted high-value controls` section (plus `details.data.highValueControlRefIds`) when dense pages or desktop host screens hide editables, named surfaces/tabs, primary action buttons, and high-signal named links such as repository results from the trimmed ref lists, supports wrapper-side `snapshot -i --search <text>` / `--filter role=<role>` to trim dense pages while preserving full `details.refSnapshot`, supports `snapshot --viewport` for scroll/viewport metadata, supports `snapshot --diff` for quick ref-map deltas versus the prior tracked snapshot, and stores full raw output in spill files when needed | `extensions/agent-browser/lib/results/snapshot.ts`, `extensions/agent-browser/lib/orchestration/browser-run/prepare.ts`, `test/agent-browser.presentation.test.ts`, `test/agent-browser.extension-validation.test.ts` |
| Screenshots/downloads get lost in text | Normalizes artifact paths, creates missing parent directories, saves simple loopback anchor downloads to the requested path when possible, and reports existence, size, cwd, session, and repair status | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#download-screenshot-and-pdf-files) |
| Profile restores and tab drift confuse agents | Tracks managed sessions, keeps every upstream helper probe on the same idle-timeout launch configuration so the background browser is not restarted between a snapshot and action, re-selects target tabs after observed drift, refreshes the active target after `tab close`, rehydrates branch-backed session state on Pi session-tree changes, and pins later commands only for sessions with drift/restored-session risk | generated tab-recovery notes below; `test/agent-browser.extension-tab-recovery.test.ts` (drift and about:blank recovery), `test/agent-browser.extension-tabs.test.ts` (post-close target), `test/agent-browser.extension-ref-guards.test.ts` (snapshot/action environment and session-tree rehydration), `test/agent-browser.resume-state.test.ts` (persisted session / resume planning) |
| Auth/profile workflows can leak secrets | Supports `auth save --password-stdin`, redacts sensitive args, URLs, stdout/stderr, and details, and discards malformed oversized stdout instead of persisting a parse-failure spill | `test/agent-browser.extension-security-redaction.test.ts` |
| Stateful cookies/storage/auth output bloats or leaks context | Presentation layer redacts `details.data` for cookies and credential-like storage values while keeping low-risk local QA values such as `theme: dark` readable; recursively scrubs other structured upstream JSON (network, diff, trace/profiler, stream, dashboard, chat, auth, dialog, frame, state, and similar) using sensitive key names plus string heuristics; masks sensitive argv flags and positionals; scrubs secrets from failed batch step errors; and exposes a compact redacted `batch` matrix on top-level `details.data` | `extensions/agent-browser/lib/results/presentation.ts`, `extensions/agent-browser/lib/results/presentation/diagnostics.ts`, `extensions/agent-browser/lib/runtime.ts`, `test/agent-browser.presentation-diagnostics.test.ts` |
| Stale `@eN` refs fail mysteriously | Records per-session `details.refSnapshot`, rejects mismatched URLs / unknown refs / unsafe `batch` stdin ordering before spawn, adds recovery guidance to rerun `snapshot -i` or use stable `find` locators | `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/session-page-state.ts`, `test/agent-browser.session-page-state.test.ts`, `test/agent-browser.results.test.ts`, `test/agent-browser.extension-ref-guards.test.ts`, `test/agent-browser.extension-semantic-recovery.test.ts` |
| Agents need stable success/failure buckets | Exposes bounded `resultCategory`, `successCategory`, and `failureCategory` on tool `details` for branching without parsing prose; a `tool_result` hook also aligns real Pi `isError` semantics, naming `Pi tool isError: true` in prose output while preserving parseable caller-requested `--json` output | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/results/categories.ts`, `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/pi-tool-rendering.ts`, `test/agent-browser.results.test.ts`, `test/agent-browser.extension-validation.test.ts`, `test/agent-browser.pi-pipeline.test.ts` |
| Clicks can report success without the page receiving the event | Top-level non-Electron direct `click` calls on `xpath=` targets or role-gated current `@e…` refs (`button`, `checkbox`, `menuitem`, `radio`, `switch`, `tab`) install a bounded target-specific DOM-event probe; eligible `@e…` refs use the latest snapshot role/name metadata, and duplicate-name refs use snapshot-order `duplicateIndex` rather than requiring a unique name. If upstream reports success but no trusted event reaches the resolved target, the wrapper fails the tool, exposes `details.clickDispatch`, and suggests explicit retry/inspect next actions (no in-page replay), including a nested-scroll `scrollintoview` action when the probe sees the target outside a scroll container or viewport. Unresolved locator clicks such as raw `find … click` are left upstream-owned to avoid false failures for frame-scoped targets. Other click results still expose `details.pageChangeSummary`, and unchanged-URL clicks can surface evidence-backed `details.overlayBlockers` candidates. | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.ts`, `extensions/agent-browser/lib/results/presentation/navigation.ts`, `test/agent-browser.presentation.test.ts`, `test/agent-browser.extension-click-dispatch.test.ts` |
| Dashboard scroll commands can look successful while nothing moves | Handles standard `scroll <dir> [px]` against the document first (including pages whose smooth-scroll CSS defeats upstream wheel timing), falls back upstream when the document cannot move, and samples viewport/containers around the fallback; unchanged positions fail as `upstream-error` with `details.scrollNoop`, visible recovery guidance, and exact snapshot/screenshot checks | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#core-page-and-element-commands), `test/agent-browser.extension-validation.test.ts` |
| Dropdown/combobox clicks can focus or hit native option box-model errors | Adds first-class `select <selector> <value...>` paths through raw `args`, `job`, and `semanticAction`; semantic role/name or label select resolves exactly one current visible combobox/listbox ref before action. Custom combobox clicks still detect focused controls with explicit `aria-expanded` state but no visible options and return `details.comboboxFocus` plus exact recovery `nextActions` | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#core-page-and-element-commands), `extensions/agent-browser/lib/input-modes/semantic-action.ts`, `test/agent-browser.extension-input-modes.test.ts`, `test/agent-browser.extension-validation.test.ts` |
| Recording workflows fail late when `ffmpeg` is missing or report stale lifecycle state | After successful `record start` / `record restart`, reports `successCategory: "artifact-pending"`, returns an exact `stop-pending-recording` action, warns when `ffmpeg` is unavailable, and tells agents that `record start` switches to a fresh active page whose in-page state does not carry over while invalidating prior page-scoped `@e…` refs on every executed start attempt (even a failed already-active one) and on URL-bearing `record restart` (stale-ref until a fresh snapshot); an unbounded transcript-backed namespace/session index reserves active destinations across aliases, serializes artifact lifecycle and explicit wait/output writes, persists cross-branch close tombstones, retires every successful close path (including every matching namespace owner for `close --all`), rejects missing/stale restart output, coalesces terminal batch state, keeps only the newest pending path per identity, rejects recording starts after a nested close, folds Unicode path aliases, and retains exact cleanup actions with visible guidance on any later same-session failure | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#diff-debug-and-streaming), `test/agent-browser.extension-validation.test.ts`, `test/agent-browser.presentation-artifacts-batch.test.ts` |
| Upstream CLI drift can silently invalidate wrapper behavior | Publishes a repo-readable command reference, verifies it against the target, and probes browser-backed calls once per cwd/PATH so anything other than exact `agent-browser 0.34.0` fails before browser launch with installed/expected version evidence | `npm run verify` |
| Desktop Electron apps need discovery, CDP attach, and safe teardown | Top-level `electron` runs host `list` / isolated `launch` (temp profile, OS-chosen debug port) / `status` / `probe` / `cleanup`, merges `launchId` plus managed `sessionName`, supports `handoff` `snapshot` / `tabs` / `connect`, and surfaces mismatch and post-command health guidance; wrapper cleanup applies only to launches it created | `extensions/agent-browser/lib/electron/discovery.ts`, `launch.ts`, `cleanup.ts`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#electron), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#electron-desktop-apps) |
| Agents need bundled `skills` text and local setup/status commands without touching the live session | Treats `skills list`, `skills get …`, `skills path …`, local auth profile management (`auth save/list/show/delete/remove`), `profiles`, `dashboard`, `device list`, `doctor`, `install`, `upgrade`, `session list` (with wrapper-managed rows hidden), `session id`, `session info`, `plugin add/list/show/run`, `mcp --help`, and caller-owned saved-state inspection/targeted maintenance (`state list/show/rename` or named clear) as sessionless reads/actions: no implicit managed `--session` under default `sessionMode: "auto"`; broad clear/clean and managed-state targets are rejected before spawn (same session-ownership goal as plain-text `--help` / `--version`), while bare `mcp` server calls are blocked and provider/browser-backed workflows stay thin passthroughs that require upstream setup and credentials | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#built-in-skills), `extensions/agent-browser/lib/command-policy.ts`, `extensions/agent-browser/lib/runtime.ts` |

## Fastest way to try it

Use Pi 0.84.0 or newer. This package keeps optional Pi core imports as wildcard `peerDependencies` because Pi package docs require the host Pi install to provide those packages, pins its direct Pi validation dependencies to 0.84.0, and makes older hosts a setup failure through `pi-agent-browser-doctor`. Version 0.3.0 intentionally provides no compatibility shims for older Pi releases.

Install upstream `agent-browser` first and make sure it is on `PATH`:

- https://agent-browser.dev/
- https://github.com/vercel-labs/agent-browser

Optional external tools unlock the full command surface:

| Dependency | Required for | macOS install example |
| --- | --- | --- |
| `agent-browser` | All browser automation through this extension | See upstream install docs |
| `ffmpeg` | `record stop` WebM encoding after `record start` / `record restart` | `brew install ffmpeg` or `brew install ffmpeg-full` |

Keep both binaries on `PATH`. This package targets exactly `agent-browser 0.34.0`; browser-backed calls fail fast on a different installed version while local inspection/setup commands remain available for diagnosis. `record start` can begin without a file on disk, but `record stop` needs `ffmpeg` to encode the WebM.

The native tool also gives agents absolute installed-package doc paths in its compact runtime guidance. Raw `args` are the 1:1 upstream CLI coverage path for the targeted `agent-browser` release; `script` adds bounded one-shot orchestration, while typed modes such as `semanticAction`, `job`, `qa`, source lookups, and Electron lifecycle helpers are reliability shorthands layered on top. Agents should read `README.md` for setup/dependencies, `docs/COMMAND_REFERENCE.md` for targeted command workflows, and `docs/TOOL_CONTRACT.md` for result/detail contracts only when deeper guidance is needed.

Then install this Pi package:

```bash
pi install npm:pi-agent-browser-native
```

Start Pi and ask for a browser action:

```text
Use the agent_browser tool to open https://example.com and then take an interactive snapshot.
```

For a one-off trial that does not touch your configured Pi extensions:

```bash
pi --no-extensions -e npm:pi-agent-browser-native
```

Pi 0.84.0+ may ask whether to trust the current project before loading project-local instructions, settings, or resources. This extension treats its own project-local package config as developer-trusted by default; use `--no-approve` when you intentionally want Pi and this extension to ignore project-local inputs for that run.

For a specific published version:

```bash
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

To install directly from source instead of npm:

```bash
pi install https://github.com/fitchmultz/pi-agent-browser-native
```

For a temporary source trial, keep it isolated from your normal package sources:

```bash
pi --no-extensions -e https://github.com/fitchmultz/pi-agent-browser-native
```

## First-run health check

Run the read-only doctor when installing, upgrading, or debugging missing/duplicated tools:

```bash
pi-agent-browser-doctor
# one-off without permanent install:
npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
# from this checkout:
npm run doctor
```

The doctor checks:

- upstream `agent-browser` exists on `PATH`
- the installed upstream version matches this wrapper's command-reference baseline
- `pi --version` meets the minimum Pi runtime floor for this release; older Pi versions are setup failures
- Pi settings do not point at multiple active `pi-agent-browser-native` sources

It does **not** edit Pi settings and does **not** run upstream `agent-browser doctor --fix`.

Pi hosts that run as uid 0 should set `PI_AGENT_BROWSER_SOCKET_DIR` to a short absolute directory under private root-owned ancestry, create it with mode `0700`, and keep it owned by the Pi user. The extension validates that directory and forwards it as upstream `AGENT_BROWSER_SOCKET_DIR`; ambient upstream socket overrides remain ignored.

## Optional package config and web search

`pi-agent-browser-native` also reads package-owned config under Pi-scoped paths:

- global user config: `~/.pi/config/pi-agent-browser-native/config.json`
- project config: `.pi/config/pi-agent-browser-native/config.json`
- explicit override: `PI_AGENT_BROWSER_CONFIG=/path/to/config.json`

`pi install npm:pi-agent-browser-native` loads the extension, but it does **not** usually put the package helper on your shell `PATH`. You can configure web search by writing the config file directly, or run the helper through `npm exec` when you want a command to write it for you.

Inspect paths/status with the helper when available on `PATH`, or through npm:

```bash
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config paths
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config show
```

The optional `agent_browser_web_search` companion tool is available when a usable Exa or Brave credential source is configured or resolvable from startup config or trusted session config. It is not an `agent_browser` input mode and does not launch a browser; agents may use it whenever current/live external web information helps, then use `agent_browser` when they need page interaction, screenshots, authenticated/profile content, or DOM inspection. Prefer it over automating public search-engine forms such as Google in headless browser jobs: those flows may be redirected to anti-bot or CAPTCHA pages, and this wrapper does not provide or recommend CAPTCHA bypass. If both keys are available, the default provider is Exa because its `/search` endpoint returns agent-friendly highlights and search modes; set `webSearch.preferredProvider` to `"brave"` when you prefer Brave Search.

Get an Exa API key from the [Exa dashboard](https://dashboard.exa.ai/api-keys) or a Brave Search API key from the [Brave Search API dashboard](https://api-dashboard.search.brave.com/). Most users can simply export `EXA_API_KEY` or `BRAVE_API_KEY` in the environment that launches `pi`; config is only needed when you want Pi-scoped secret references, a preferred provider, or to disable this built-in search tool.

Most config users should store env-var references in the Pi-scoped config:

```bash
mkdir -p ~/.pi/config/pi-agent-browser-native
cat > ~/.pi/config/pi-agent-browser-native/config.json <<'JSON'
{
  "version": 1,
  "webSearch": {
    "enabled": true,
    "preferredProvider": "exa",
    "exaApiKey": "$EXA_API_KEY",
    "braveApiKey": "$BRAVE_API_KEY"
  }
}
JSON
```

`pi install` does not add package helper binaries to your shell `PATH`. Use direct JSON config edits, or run the helper only through `npm exec`:

```bash
# Store env-var references in global config.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env EXA_API_KEY --global
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env BRAVE_API_KEY --global

# Store an env-var reference in project config.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env EXA_API_KEY --project

# Prefer Brave when both Exa and Brave keys are available, or clear with "auto".
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search prefer brave --global

# Disable this package's built-in web-search tool in global config even if API keys are in the environment.
# Global disable applies to normal runs unless a project config or PI_AGENT_BROWSER_CONFIG override explicitly re-enables it.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search disable --global

# Hard-disable web search for one run, regardless of project config, by using the highest-priority override layer.
cat > /tmp/pi-agent-browser-disable-web-search.json <<'JSON'
{ "version": 1, "webSearch": { "enabled": false } }
JSON
PI_AGENT_BROWSER_CONFIG=/tmp/pi-agent-browser-disable-web-search.json pi

# Store a plaintext key in Pi-scoped user config; output stays redacted.
printf '%s' "$EXA_API_KEY" | npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-key --provider exa --stdin

# Store a secret-manager command source. Add --project when you want the repo config to own the source.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-command "op read 'op://Private/Brave Search/API Key'" --provider brave --global
```

Config merges in this order: global → project → `PI_AGENT_BROWSER_CONFIG` override. Under Pi 0.84.0+, the globally installed or CLI-loaded extension still loads project-local `.pi/config/pi-agent-browser-native/config.json` when Pi trust allows that project layer; it skips that project layer when Pi reports the project is untrusted or when Pi is launched with `--no-approve`. `webSearch.enabled` is evaluated after the loaded layers merge. Use `web-search disable --global` for a user default, `web-search disable --project` for one repo, and a `PI_AGENT_BROWSER_CONFIG` override with `{ "webSearch": { "enabled": false } }` when web search must stay off even if project config exists. Loaded config may use plaintext, custom environment aliases, interpolation literals, malformed-or-late-bound `$` values, and `!command` credential sources; the resolved secret is passed to the provider request while tool content, details, status output, and docs examples stay redacted. `web-search set-key`, `set-command`, and `clear` require `--provider`; `set-env` infers Exa/Brave from `EXA_API_KEY` or `BRAVE_API_KEY` unless you pass `--provider`.

For Exa, the tool defaults to `searchType: "auto"` with `contents.highlights: true`. Agents may pass `searchType` (`fast`, `instant`, `deep-lite`, `deep`, or `deep-reasoning`) only when the task needs that latency/depth tradeoff; structured output schemas are intentionally not exposed yet.

The same config file can record conservative browser defaults such as a profile hint or a Chromium-compatible executable path:

```bash
# Ask the agent to use this profile for signed-in/account-specific work.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile set "Profile 1" --policy authenticated-only

# Ask the agent to launch a different Chromium-compatible browser executable.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable set "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
```

This adds agent guidance for signed-in/account-specific tasks; current releases do not auto-inject `--profile` or `--executable-path` for every launch. Configure profile/executable guidance globally, in trusted project config, or through `PI_AGENT_BROWSER_CONFIG`. Ask the agent to run `agent_browser` with `args: ["profiles"]` and `args: ["doctor"]` when profile resolution fails. The upstream `profiles` command lists Chrome profiles from Chrome's user data directory; `Default` is not canonical on every machine. Use the displayed profile directory name, a full profile/user-data directory path when upstream accepts one, or a configured `browser.executablePath` plus `sessionMode: "fresh"` for a different Chromium-compatible browser.

## Common agent calls

You usually prompt the agent in natural language. These JSON snippets show the exact native tool shape the agent should use.

Open a page and inspect it (first-call recipe: open → snapshot -i → interact with current `@refs` → snapshot -i after changes). Do not pass `--json` in `args`; the wrapper injects it.

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
```

Watch a browser window during a demo or QA run by adding upstream's global `--headed` flag on the first launch. Use `sessionMode: "fresh"` if a managed session may already exist, because headed/headless state is launch-scoped. A successful tool call means upstream opened a browser context; it does **not** prove the OS window is visible on the user's display, especially under remote, container, or virtual-display setups.

```json
{ "args": ["--headed", "open", "https://example.com"], "sessionMode": "fresh" }
{ "args": ["screenshot", "/tmp/agent-browser-headed-check.png"] }
```

For wrapper-owned headed launches, the extension disables upstream 0.33.2 periodic restore autosave by default because its multi-origin collector opens visible temporary tabs and can delay daemon policy inspection. The extension records the effective launch-time interval and reapplies it to every helper and follow-up subprocess, including still-owned off-current sessions (also after failed replacement cleanup), Electron cleanup closes, and reload/resume, so the receiving daemon does not see changing configuration. Native `close` still saves, but upstream exempts headed browsers from idle shutdown, so closing the window by hand can lose newer state. Set `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS` before launch when periodic preservation matters; changing it on a running wrapper-owned headed daemon is rejected until you close that session and launch fresh.

Render a WebGPU page by enabling upstream's WebGPU launch preset on a fresh local browser:

```json
{ "args": ["--webgpu", "open", "https://webgpu.github.io/webgpu-samples/?sample=helloTriangle"], "sessionMode": "fresh" }
{ "args": ["screenshot", "/tmp/webgpu.png"] }
```

`--webgpu` is also available as `AGENT_BROWSER_WEBGPU`; `--webgpu false` overrides an enabled environment default. Standalone upstream supports `"webgpu": true` in `agent-browser.json`, but browser-backed native calls reject upstream config files as described below. It cannot be combined while enabled with `--cdp`, `--auto-connect`, or provider launches. Run `{ "args": ["doctor", "--webgpu"] }` to pixel-check rendering and capture. macOS supports headless WebGPU screenshots; upstream requires a logged-in headed desktop on Windows and `--headed` plus Vulkan loader/Mesa packages on Linux (automatic Xvfb unless `AGENT_BROWSER_NO_XVFB=1`).

Restrict browser and `read` traffic with upstream's domain containment on a fresh local Chrome context:

```json
{ "args": ["--allowed-domains", "example.com,*.example.org", "open", "https://example.com"], "sessionMode": "fresh" }
```

In `agent-browser 0.32.0`, the allowlist also covers workers and popups and disables Chromium `RTCPeerConnection` while active. Upstream rejects `--allowed-domains` with CDP/auto-connect, profiles, restore/state replay, direct-page providers, iOS/Safari, and startup/profile Chrome args because those paths cannot guarantee containment. The wrapper's final-URL check remains defense in depth and reports escapes as `failureCategory: "policy-blocked"`.

On `https://example.com/`, the main link label is **Learn more**—use exact visible text from your snapshot, not guessed copy such as `More information...`.

Click a visible ref, then refresh refs after navigation or a DOM update:

```json
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

Run a multi-step flow in one tool call:

```json
{ "args": ["batch", "--bail"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

Use exact `batch --bail` when a later content step assumes an earlier navigation succeeded. Without fail-fast behavior, a failed navigation can leave the prior page active; the wrapper rejects the batch when that retained page could be local or unverified. Non-bail continuation remains available when every possible retained page is already verified safe. Splitting navigation and content into separate calls is the other safe option.

If the same `batch` stdin later uses `@e…` on interaction commands after a step that can navigate or mutate the page (`open`, non-form `click`, `reload`, and similar), insert a `snapshot` step whose first argv token is `snapshot` (for example `["snapshot","-i"]`) between those phases. Multiple same-snapshot `fill @e…` steps and native form-control steps (`check`/`uncheck` on checkbox or radio refs, checkbox/radio `click`/`tap` refs, and `select` on combobox refs) may be batched before a final click/submit step. Dynamic or autosubmit forms should still use stable locators or split with a fresh snapshot. The wrapper rejects unsafe ordering with `failureCategory: "stale-ref"` before upstream runs; full rules are under `refSnapshot` in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).

Read documentation or other unstructured text without launching Chrome, or omit the URL to read the rendered DOM of the current tab:

```json
{ "args": ["read", "https://example.com/docs", "--filter", "authentication"] }
{ "args": ["read"] }
```

Explicit URL reads prefer `text/markdown`, then try a `.md` path and nearby `llms.txt` links before falling back to readable HTML text. Use `--outline`, `--llms index|full`, `--require-md`, `--raw`, or `--timeout <ms>` when needed. The wrapper renders upstream `data.content` first, preserves metadata in `details.data`, keeps fetched URLs from replacing the active browser tab target, and budgets explicit long read timeouts across upstream's `.md` and ancestor-`llms.txt` request fallbacks.

Evaluate page JavaScript through stdin. Put the script in the top-level `stdin` field, not as an extra `args` token after `--stdin`. Return the value you want as an expression; `eval --stdin` may warn with `details.evalStdinHint` when a function-shaped snippet serializes to `{}` instead of being invoked:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
{ "args": ["eval", "--stdin"], "stdin": "({ title: document.title, url: location.href })" }
{ "args": ["eval", "--stdin"], "stdin": "({ title: document.title, url: location.href })", "outputPath": "logs/page-state.json" }
```

Use `outputPath` when `eval`, `get`, `snapshot`, or another extraction should be saved as a durable workspace file. Keep it distinct from screenshot, download, recording, and other browser artifact destinations; preflight rejects known same-call aliases before browser activity, and the result writer preserves the browser artifact if an alias becomes apparent only afterward. The wrapper writes `details.data` when present, otherwise the model-facing text content, and returns `details.outputFile` with the saved path and byte count. Explicit upstream `--json` content stays parseable; in that case the save notice lives only in `details.outputFile`.

Extract several known refs or selectors in one `batch` call instead of many serial getter calls:

```json
{ "args": ["batch"], "stdin": "[[\"get\",\"text\",\"@e64\"],[\"get\",\"text\",\"@e65\"]]" }
```

Save an auth profile without putting the password in `args`:

```json
{ "args": ["auth", "save", "demo", "--password-stdin"], "stdin": "<password>" }
```

Download a file from a known link or control:

```json
{ "args": ["download", "@e5", "/tmp/report.pdf"] }
```

### One-shot code mode (`script`)

Use top-level `script` when the browser work needs a loop, a conditional page branch, or multi-page aggregation that would otherwise require several `agent_browser` calls. The source is an async JavaScript body with only two task-specific globals:

- `await browser({ args, stdin?, timeoutMs? })` runs one ordinary native browser call through the same validation, policy, redaction, presentation, artifact, and timeout pipeline as top-level `args`. It resolves to `{ ok, data, details?, error?, failureCategory?, nextActions?, resultCategory, successCategory?, summary, text }`; check `ok` before consuming `data`. Script-visible browser `nextActions` keep only policy-compatible calls with the wrapper-owned isolated identity prefix removed, so their `params` can be passed back to `browser()`.
- `emit(value)` adds a JSON-compatible output value. One emission is returned directly; multiple emissions are returned as an array. With no emission, the async body’s return value is used; when it returns nothing, `details.data` is omitted.

```json
{
  "script": "const rows = [];\nfor (const page of [1, 2]) {\n  const opened = await browser({ args: [\"open\", `https://news.ycombinator.com/news?p=${page}`] });\n  if (!opened.ok) throw new Error(opened.error);\n  const extracted = await browser({ args: [\"eval\", \"--stdin\"], stdin: \"({ hasBanner: Boolean(document.querySelector('[role=dialog]')), rows: [...document.querySelectorAll('tr.athing')].slice(0, 30).map(row => ({ id: row.id, title: row.querySelector('.titleline > a')?.textContent ?? '' })) })\" });\n  if (!extracted.ok) throw new Error(extracted.error);\n  if (extracted.data.result.hasBanner) {\n    const dismissed = await browser({ args: [\"click\", \"[role=dialog] button\"] });\n    if (!dismissed.ok) throw new Error(dismissed.error);\n  }\n  rows.push(...extracted.data.result.rows);\n}\nemit(rows);"
}
```

This mode is intentionally one-shot, not a reusable recipe runtime. Each invocation gets a unique non-profile browser session, never touches the implicit conversation session, serializes inner calls, and closes the isolated session in `finally`. It rejects caller `--session` / `--namespace`, browser lifecycle and attachment commands, persistent launch/profile/restore controls, nested `batch`, local/sessionless commands, and every other top-level input mode. Every script-owned helper and cleanup subprocess also clears ambient `AGENT_BROWSER_*` and standard proxy variables before the wrapper reapplies its own isolated-session controls, so shell defaults cannot attach, restore, or select a profile behind the script’s back. The sandbox has no imports, `require`, process, filesystem, network, timers, dynamic code generation, or host object/function references.

Limits are fixed: 25 attempted `browser()` calls, 64 KiB source, 64 KiB final emitted JSON, a 120-second default timeout, and a 300-second hard timeout ceiling. Final data is redacted, serialized compactly, and checked again before presentation; unsafe depth or post-redaction growth becomes a structured validation failure rather than unbounded prose. One approved top-level `agent_browser` call can authorize all 25 inner calls, so inspect the visible script source before approving it: the collapsed Pi tool row shows a bounded terminal-safe preview with source line breaks marked as `↵`, and expanding that row shows the full terminal-safe source with JavaScript line terminators preserved as visible newlines and removed controls marked visibly. The extension rehydrates only wrapper-verified parse-valid compact-result spills before returning inner `data`; ordinary result redaction still applies. Inner `summary` and `text` are bounded, and a complete envelope that still exceeds the IPC message cap becomes a handleable `upstream-error` browser result instead of breaking the sandbox bridge. Pi session persistence is required so the wrapper can append a model-invisible cleanup lease before the first browser launch and retry a failed close after restart. A rejected inner policy/validation call fails the top-level result even when source handles its returned envelope; an uncaught source exception returns `failureCategory: "script-error"`; a failed cleanup overrides any script outcome with `failureCategory: "cleanup-failed"`, `details.scriptSession.closeCommandArgs`, and an exact `close-script-session-after-cleanup-failure` next action. Compact prose confirms a successful isolated-session close after browser-bearing runs. Pi branch changes, quit, and reload abort active scripts, wait for isolated-session cleanup, and reap the sandbox child before restoring branch-visible state.

Use normal `args`, `job`, or `qa` for linear work. Use ordinary profile/attached flows for authenticated browser state. Do not store code mode source under a name or treat it as shared workflow configuration.

### Locator shorthand (`semanticAction`)

For supported upstream `find` flows, direct selector/ref `click` / `check` / `fill`, and native dropdown selection you can omit hand-built `args` and pass a top-level `semanticAction` object instead. The wrapper compiles locator actions to the same `find` argv upstream already understands, direct selector/ref actions to matching upstream commands, or `action: "select"` to upstream `select <selector> <value...>`; compiled argv is echoed as `details.compiledSemanticAction` when the unified result includes that field. Full field rules live in [`docs/TOOL_CONTRACT.md#semanticaction`](docs/TOOL_CONTRACT.md#semanticaction).

```json
{ "semanticAction": { "action": "click", "locator": "text", "value": "Submit" } }
{ "semanticAction": { "action": "click", "locator": "role", "role": "button", "name": "Continue without Signing In" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "semanticAction": { "action": "fill", "selector": "@e1", "text": "prompt text" } }
{ "semanticAction": { "action": "click", "selector": "#submit" } }
{ "semanticAction": { "action": "select", "selector": "#flavor", "value": "chocolate" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close", "session": "named-browser" } }
```

Typical pitfalls:

- Supply **exactly one** of `script`, `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron` per call (not more, not none). Prefer `script` only for one-shot loops/branches/aggregation, `args` for routine browse; `semanticAction` for stable locators; `job`/`qa` for multi-step checks; `electron` for desktop apps; treat `sourceLookup` / `networkSourceLookup` as experimental candidates-only.
- Do not pass `--json` in `args`; the wrapper injects it automatically.
- `semanticAction` and `job` are **not** valid inside `batch` stdin; batch steps stay upstream argv string arrays (spell a `find` step as tokens there if you need it in a batch).
- Commands or locators outside the supported shorthand still require explicit `args`. Common page getters are grouped under `get`: use `get title`, `get url`, or `get text <selector>` rather than shortcut commands such as `title` or `url`; unknown getter shortcuts can return read-only `details.nextActions` like `use-get-title`.
- For `locator: "role"`, pass either `value: "button"` or `role: "button"`; if both are present they must match.
- Use `semanticAction.session` to target a named upstream browser session; the wrapper prepends `--session <name>` before the compiled `find` or `select` argv and keeps that prefix on retry/candidate actions. In active sessions, role/name click/check/fill shorthands may resolve through the current `snapshot -i` refs before execution so hidden duplicate matches do not steal the action; fill only resolves when the current snapshot has one exact editable ref match. `details.effectiveArgs` shows the exact executed argv.
- Do not reuse `@e…` refs across navigation or in-place rerenders. The wrapper records the latest snapshot refs per session and fails stale/recycled getter and mutation refs, including batched getters, before upstream can silently read or hit a different current-page element; use the session-aware `refresh-interactive-refs` next action.
- If upstream classifies the failure as `stale-ref` and `details.compiledSemanticAction` is present for a compiled `find` action, `details.nextActions` may list `retry-semantic-action-after-stale-ref` after `refresh-interactive-refs`, carrying the same compiled `find` argv so you can retry the locator-stable target once it is safe to do so. `select` calls that used stale `@refs` only get refresh guidance; use a fresh snapshot or stable selector before retrying (contract in [`docs/TOOL_CONTRACT.md#semanticaction`](docs/TOOL_CONTRACT.md#semanticaction)).
- If the failure is `selector-not-found`, the wrapper may take one fresh snapshot and add `Current snapshot ref fallback` when that snapshot has exact visible role/name matches for the failed `find` / `semanticAction` target. Non-fill targets can include direct `try-current-visible-ref*` next actions, and semantic click misses can still add bounded `Agent-browser candidate fallbacks` such as `button`/`link` role retries for `text` clicks. `semanticAction` does not expose `uncheck` while upstream `find ... uncheck` is not runtime-supported; use raw `args: ["uncheck", <selector-or-ref>]` after a stable selector or fresh snapshot ref. For semantic `fill` misses on desktop or host-controlled rich inputs, prefer `details.richInputRecovery`: refresh refs, choose the current editable `@ref`, focus or click it, then use `keyboard inserttext` or `keyboard type` with the intended text. Direct contenteditable fills are verified with `get text` when snapshot metadata proves the target is contenteditable; if replacement did not happen, `details.fillVerification` warns before any submit step. Those recovery nextActions do not copy the fill text and do not press `Enter` or submit; only submit when the user flow explicitly calls for it (same contract link).
- A successful upstream `click` is not proof that the web app handled the event or changed state. For top-level non-Electron direct clicks on `xpath=` targets and eligible current `@e…` refs, the wrapper may fail the tool with `details.clickDispatch` and a `Click dispatch diagnostic` line when upstream reported success but no trusted DOM event reached the resolved target. Raw `find … click` locator calls are not probed because the wrapper has no concrete element before upstream resolves the locator, and document-level probes can falsely fail frame-scoped clicks. `@e…` ref click probes are limited to current snapshot refs with accessible role `button`, `checkbox`, `menuitem`, `radio`, `switch`, or `tab`, using duplicate-name snapshot order when needed. Use the suggested `inspect-click-dispatch-miss` / `retry-click-after-dispatch-miss` next actions instead of assuming the click mutated the page; when `details.clickDispatch.scrollContainer` is present, use `scroll-target-into-view-after-dispatch-miss` first. When the task depends on a mutation, follow `inspect-after-mutation` / `pageChangeSummary` evidence with a wait, URL/text check, or fresh snapshot before trusting the result; if the target still did not change, retry with a current visible ref or stable selector and report the workflow issue instead of silently continuing. For static local fixtures where the user only needs to exercise app code, an explicit `eval --stdin` programmatic click such as `document.querySelector("#demo").click()` can be a diagnostic workaround, but treat it as an untrusted scripted activation rather than proof a real user click works, and never use it to bypass user instructions. Respect explicit user stop boundaries yourself: if the user says to stop before order/post/purchase/submit, gather evidence on that page and do not click the final action. The wrapper does not parse broad prompt text into business-intent action blocks; `details.promptGuard` is reserved for concrete artifact-before-close checks.
- A successful `snapshot -i` can surface `Possible overlay blockers` immediately when refs already contain strong dialog/alertdialog evidence plus close/dismiss controls. If a **top-level** `@e…`/`ref=` click succeeds (unified command `click`, not a `batch` step), upstream reports `data.clicked`, and `details.navigationSummary.url` stays on the same tab URL under the same normalization as ref preflight (fragment-insensitive), the wrapper may take one extra `snapshot -i` and add `Possible overlay blockers` with `details.overlayBlockers` (`candidates`, `summary`, optional `snapshot` refresh for refs) plus session-aware `inspect-overlay-state` / bounded `try-overlay-blocker-candidate-*` next actions when that snapshot shows strong modal context (`dialog` / `alertdialog`) and close/dismiss-like controls. Page-wide words like privacy, sign in, or banner alone do not trigger this diagnostic. The unchanged-URL check compares the prior pinned tab target with `details.navigationSummary.url`; CSS selector clicks do not run this overlay probe. Also skipped when tab correction or about-blank recovery already ran on that result.
- If `get text <selector>` reads a non-ref, non-simple-id CSS selector with multiple matches or a hidden first match while visible matches exist, including successful `batch` steps, the wrapper may add `Selector text visibility warning`, `details.selectorTextVisibility` (plus `selectorTextVisibilityAll` for multiple batched warnings), and `inspect-visible-text-candidates` next actions; the warning names the matching `details.nextActions` id. Prefer a visible `@ref`, a scoped selector, or a targeted `eval --stdin` over hidden tab content.
- In wrapper-tracked attached Electron sessions, broad selectors such as `body`, `html`, `main`, or `[role=application]` may read the whole app shell. The wrapper may add `Broad Electron get text selector warning`, `details.electronGetTextScopeWarning`, and `snapshot-for-electron-text-scope`; ordinary browser pages do not qualify without Electron launch provenance, and local `file://` page follow-ups are blocked before this diagnostic. Prefer `snapshot -i`, a current `@ref`, or a narrower panel selector.

### Constrained browser jobs

For short repeatable workflows, pass a top-level `job` instead of hand-writing `batch` stdin. Keep dynamic app jobs short around navigation, click, and rerender boundaries; avoid packing a whole checkout into one job. The wrapper only supports constrained steps (`open`, `click`, `fill`, `type`, `select`, `wait`, `assertText`, `assertUrl`, `waitForDownload`, `snapshot`, and `screenshot`), compiles them to existing upstream `batch` commands, and echoes the compiled commands as `details.compiledJob` for auditability. `open` steps can include `loadState` (`domcontentloaded`, `load`, or `networkidle`) to insert a readiness wait before the next step. `click` and `fill` steps can use either CSS `selector` or semantic locator fields (`locator`, `role`/`value`, optional `name`) so a job can express flows like role/name search without brittle selectors. `type` can use `selector`, `text`, optional `delayMs` for per-character pacing, and optional `press` for a final key such as `Enter`; paced type compiles to existing `focus`, `keyboard type`, `wait`, and `press` batch rows, is capped at 200 characters per delayed step, and compacts model-visible batch text while full rows remain in `details.batchSteps`. The same compile path backs top-level `qa`, so long `qa` runs surface the same timeout evidence shape. If a long `job`, `qa`, or `batch` hits the wrapper watchdog, `details.timeoutPartialProgress` may recover per-step status (`completed`, `failed`, `pending`, or `unknown`), current page URL plus a title only after a non-file URL is verified, declared artifact paths that already exist on disk, and either a `retry-timeout-step` next action for the first incomplete read-only or idempotent step or `inspect-current-page-after-timeout` when the first incomplete step may be mutating and needs state inspection before a shorter follow-up flow (see [`docs/TOOL_CONTRACT.md#details`](docs/TOOL_CONTRACT.md#details)). There is no separate catalog of reusable named browser recipes above one-shot ad hoc `script`, `job`, `qa`, and raw `batch`; `script` has no names, registry, or persistent workflow state; see [`docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet`](docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet) for the closed `RQ-0068` decision and when to revisit it.

**Navigation inside `job` is explicit.** A successful `click` does not prove the next page loaded; add `assertUrl` and/or `assertText` after navigation-prone clicks (forms, checkout, tabs, submit buttons) before screenshots or steps that assume the new page. `assertUrl` accepts exact URLs and `*` / `**` glob-style patterns and now compiles directly to upstream `wait --url` for both forms.

```json
{
  "job": {
    "steps": [
      { "action": "open", "url": "https://example.com" },
      { "action": "assertText", "text": "Example Domain" },
      { "action": "screenshot", "path": ".dogfood/example.png" }
    ]
  }
}
```

```json
{
  "job": {
    "steps": [
      { "action": "open", "url": "https://shop.example/checkout" },
      { "action": "fill", "selector": "#email", "text": "user@example.com" },
      { "action": "click", "selector": "#continue" },
      { "action": "assertUrl", "url": "**/shipping" },
      { "action": "assertText", "text": "Shipping address" },
      { "action": "screenshot", "path": ".dogfood/shipping.png" }
    ]
  }
}
```

On app pages that expose a native dropdown, add a `select` step such as `{ "action": "select", "selector": "#flavor", "value": "chocolate" }` before the assertion that depends on it. On locator-friendly pages, use semantic job steps such as `{ "action": "fill", "locator": "role", "role": "searchbox", "name": "Search", "text": "agent browser" }` and `{ "action": "click", "locator": "role", "role": "button", "name": "Search" }`.

Use raw `args`/`stdin` when you need full upstream `batch` power, custom flags, or commands outside the constrained job schema. Do not pass top-level `stdin` with `script`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron`; script puts inner stdin on `browser({ stdin })`, while the other modes generate or manage their own input.

### Electron desktop apps

The dedicated guide for this section is [`docs/ELECTRON.md`](docs/ELECTRON.md); it covers intended users, the full lifecycle, wrapper-owned vs manually launched apps, action reference, safety/ownership, `qa.attached`, `sourceLookup` context, troubleshooting, and cleanup. Read it first if Electron support is what brought you here.

For desktop Electron apps, use top-level `electron` to avoid hand-building the discover → launch with CDP → connect → inspect → cleanup sequence. The wrapper owns only apps it launched, uses an isolated temp profile and OS-chosen debug port, and reports exact cleanup/status next actions. It does **not** reuse the app's normal signed-in profile or attach to an already-running authenticated app, so launching Slack/Obsidian/VS Code this way may show first-run or sign-in UI instead of the user's live local state. When the explicit goal is signed-in local app state and host tools are available, launch the normal app with a debug port first (for example `open -a Slack --args --remote-debugging-port=9222 --remote-allow-origins='*'`), then attach with `{ "args": ["connect", "9222"], "sessionMode": "fresh" }`; if the app is already running without a debug port, ask before relaunching it. `electron.list` may annotate likely private apps (for example notes, chat, mail, developer workspaces, or password/auth tools) as `[likely sensitive: …]`; those are hints only, so use caller-owned `allow` / `deny` policy before launching sensitive apps.

```json
{ "electron": { "action": "list", "query": "code" } }
{ "electron": { "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" } }
{ "electron": { "action": "probe", "timeoutMs": 5000 } }
{ "electron": { "action": "cleanup", "launchId": "electron-…" } }
```

`electron.probe.timeoutMs` bounds each underlying read subprocess when dense desktop apps need a shorter or longer probe budget (omit for the normal tool subprocess default). `electron.cleanup.timeoutMs` caps upstream `close` plus host profile/process teardown and defaults to the implicit session close budget unless overridden; if the managed-session close step succeeds but host cleanup is partial, later default browser calls still rotate away from that closed wrapper-managed session. `electron.status.timeoutMs` only tightens managed-session title/url reads used for mismatch checks. Pass `electron.probe.launchId` when you want the probe tied to a wrapper-tracked launch instead of only the current managed session. Launch/status/probe results show both `launchId` (for status/cleanup/probe) and `sessionName` (for browser `snapshot`/`tab` commands); if the managed session drifts to `about:blank` while wrapper status still sees a live renderer, Electron-specific mismatch warnings and `status`/`probe`/`reattach`/`snapshot` next actions replace generic tab guidance. `/reload` preserves the current branch-visible active Electron launch and its isolated temp `userDataDir` for continuity, and cleans off-branch owned Electron launches; if cleanup is partial and skips or fails profile removal, the generic temp sweep preserves that `userDataDir` across reload, quit, later temp cleanup, process exit, and stale temp-root pruning after restart. If the app process/debug port dies after a successful-looking mutation, the wrapper reports `details.electronPostCommandHealth` and fails with `tab-drift` instead of quietly continuing on `about:blank`. Launch timeouts expose `details.electron.failure.diagnostics` for PID, profile, DevToolsActivePort, and timing evidence.

`launch.handoff` still defaults to `"snapshot"`; it retries briefly when the first Electron snapshot has no refs. Use `handoff: "tabs"` as a safer diagnostic starting point when you only need target discovery and do not want interactive refs captured yet, or `handoff: "connect"` when you want attach-only and will run your own `snapshot -i` / tab commands next. For Electron quick inputs that rerender in place, a successful `fill` may include `details.fillVerification` if `get value` still disagrees; re-snapshot and use focus plus keyboard typing before submitting.

For an app you launched yourself with remote debugging enabled, use raw upstream attach instead and clean it up yourself. After attach, inspect targets before assuming the app is ready:

```json
{ "args": ["connect", "9222"], "sessionMode": "fresh" }
{ "args": ["tab", "list"] }
{ "args": ["tab", "t2"] }
{ "args": ["snapshot", "-i"] }
```

`connect` success means the debug endpoint accepted the session, not that an active page is ready. Use the returned `verify-connected-session-url` (`get url`) action before page-content reads, then inspect/select a stable tab and verify its URL. If a snapshot says `No active page`, the wrapper clears prior refs for that session; choose a stable `t<N>` tab and retry a condition wait or fresh `snapshot -i` before using `@e…` refs. Close commands (`close`, `quit`, or `exit`) only close the browser/CDP session; manually launched apps, their profiles, and explicit screenshots/downloads/HARs/traces/recordings remain host-owned.

After either path, use `qa: { "attached": true, ... }` for a current-session smoke check without opening a URL. Attached QA preserves existing network/console/page-error buffers instead of clearing them, so it can catch errors raised before the check started; visible output and `details.compiledQaPreset.checks.diagnosticsResetAtStart` identify that scope. Prefer condition waits (`wait --text`, `wait --url`, `wait --fn`, `wait --load <state>`, `wait --download`), `qa.attached`, `electron.probe` / `electron.status`, `tab list` → `tab t<N>`, fresh snapshots, or screenshots over blind sleeps. Fixed waits are a last resort: use explicit `--timeout` or top-level `timeoutMs` for legitimately slow waits, and treat a result like `"waited":"timeout"` as elapsed time only.

### Lightweight QA preset

For a quick smoke/QA pass, use top-level `qa`. It compiles to the same batch path as `job` and uses `batch --bail` so failed readiness/text/selector assertions stop before slower diagnostics can burn the wrapper watchdog. The URL form clears enabled network/console buffers and snapshots any page-error residue after the unreliable upstream clear, then opens the target URL and gives immediate post-load console/page-error callbacks a bounded 150 ms settle, waits for page readiness, checks optional expected text or selector, inspects fresh network requests, console messages, and page errors when preceding assertions pass, and can capture an evidence screenshot. Successful reset rows are labeled as reset-scoped output. Only page-error residue still present after the clear can be ignored when it remains unchanged; a matching error that reappears after a successful clear still fails the target page. Expected text is checked with bounded visible-text `wait --fn … --timeout 5000` predicates after the requested load state so dense pages can pass on visible headings/copy and missing text becomes crisp QA evidence. The attached form (`qa: { "attached": true }`) runs checks against the current managed session, such as an attached Electron app, rejects `url`, and deliberately preserves existing diagnostics instead of clearing evidence; its diagnostic reads default off so stale buffers do not fail a current-page smoke unless `checkNetwork`, `checkConsole`, or `checkErrors` is explicitly `true`. `loadState` defaults to `"domcontentloaded"`; set it to `"load"` or `"networkidle"` only when the stricter state is useful and the site is not expected to keep background requests alive. For URL-opening QA, `checkNetwork`, `checkConsole`, and `checkErrors` default to true; set one to `false` to skip that diagnostic read. Network failures are classified by likely impact and failed rows are listed first in network previews: actionable document/script/API-style failures still fail QA, while some low-impact browser icon asset misses (for example certain `favicon` or `apple-touch-icon` paths when upstream marks the row failed and resource metadata looks image-like) surface only as warnings instead of failing an otherwise healthy smoke check (`details.qaPreset.warnings`, with human-readable `details.qaPreset.summary` when the preset still passes). Exact predicates live in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#qa) and `classifyNetworkRequestFailure` in `extensions/agent-browser/lib/results/network.ts`.

```json
{
  "qa": {
    "url": "https://example.com",
    "expectedText": "Example Domain",
    "screenshotPath": ".dogfood/qa-example.png"
  }
}
```

Use custom `job` or raw `batch` when you need a different check sequence. `job` defaults to `batch --bail` (`failFast: true`) so later mutating steps do not run after an earlier required step fails; set `failFast: false` only when later diagnostics remain safe if an earlier navigation fails; navigation-dependent content may require fail-fast behavior or split calls. `qa` always uses fail-fast assertion behavior; omit expected text/selector when you want load-plus-diagnostics only.

### Experimental source lookup

For local app debugging, `sourceLookup` can gather candidate component/file locations for a visible UI element. It is explicit and evidence-based: pass a `selector`, `reactFiberId`, and/or `componentName`; the wrapper compiles those inputs to existing batch steps (`is visible`, `get html` when `includeDomHints` is not `false`, `react inspect`, `react tree`) and a bounded local workspace scan under the Pi session cwd (`maxWorkspaceFiles` defaults to 2000 and cannot exceed 5000; the scan records at most ten `workspace-search` candidates). Results appear in `details.sourceLookup` with `status`, `candidates`, `limitations`, and `summary`. Unlike `qa`, the wrapper does not mark the tool failed on an otherwise successful batch solely because `status` is `no-candidates` or because React metadata was missing; failed upstream steps (for example `react inspect` without DevTools) still fail the batch normally.

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

This is an experiment, not a guarantee. React hints require a session opened with `--enable react-devtools`, and many builds do not expose useful sourcemap/source metadata; `status: "no-candidates"` is common when nothing matched, and `status: "unsupported"` only when no candidates were found **and** a compiled `react` batch step failed (if DOM or workspace search still produced candidates, you get `candidates-found` instead). For wrapper-tracked packaged Electron apps, a no-candidate result includes `details.sourceLookup.workspaceRoot`, optional `details.sourceLookup.electronContext`, limitations explaining that the scan is limited to the Pi cwd and does not unpack app bundles/`app.asar`, plus Electron snapshot/probe/tab next actions when a launch is known.

`networkSourceLookup` is the matching failed-request experiment. It runs `network request <id>` when `requestId` is present and/or `network requests --filter …` when `filter` or `url` is present (`url` supplies the filter pattern when `filter` is omitted); add `namespace` / `session` when the generated batch should target an explicit upstream namespace/session (`namespace: ""` explicitly selects the default namespace and overrides an ambient namespace). It merges failed-request rows from the batch JSON with initiator-style hints and a bounded workspace literal scan (`maxWorkspaceFiles` defaults to 2000, cap 5000), surfaces everything under `details.networkSourceLookup`, and avoids automatic blame or edits. Compact `network requests` results with safe request IDs also add `details.nextActions` for request details, bounded `networkSourceLookup` on actionable failures, path filtering, diagnostic-buffer clearing before a repro, or HAR capture so agents can branch without guessing request-id syntax. For noisy aggregate buffers, wrapper-side `network requests --current-page` / `--current-origin` keeps only rows matching the active page origin, while `--current-url` keeps exact active-document URL rows and reports counts in `details.networkRequestsPageFilter`. When the wrapper has seen `network route` in the same session, pending fetch/XHR rows or CORS-looking errors that match the route surface `details.networkRouteDiagnostics` plus executable follow-ups to inspect the request or start HAR capture; same-origin/CORS-correct fixture retry guidance stays in prose. Network diagnostics are read-only for wrapper page state: request URLs in `network request` or generated `networkSourceLookup` batches do not replace the session’s active page target or invalidate page-scoped refs from the app page.

```json
{ "networkSourceLookup": { "requestId": "req-1", "url": "/api/fail" } }
```

For asynchronous exports, click first and then wait for the download:

```json
{ "args": ["click", "@export"] }
{ "args": ["wait", "--download", "/tmp/report.csv"] }
```

When a user gives exact artifact paths for screenshots, recordings, downloads, PDFs, traces, or HAR files, use those paths or explicitly report why the artifact was unavailable; do not silently substitute a different path in the final report. The wrapper creates missing parent directories for direct artifact paths such as `state save`, screenshots, PDFs, downloads, and `wait --download`. For simple loopback `download <selector> <path>` anchor links with HTTP(S) `href`, it can save the in-page response directly to the requested path before falling back to upstream click/download behavior; non-loopback/profile downloads stay upstream-owned. With current upstream `agent-browser`, treat `details.savedFilePath` as upstream-reported metadata and confirm `details.artifacts[].exists` / `details.artifactVerification.verified` before relying on the requested `wait --download <path>` file being present on disk; non-file download payloads such as `data:` URLs are not verified local artifacts.

For evidence-only screenshots or QA captures, branch on `details.artifactVerification` and `details.artifacts` before reporting PASS/FAIL; a pre-existing path from an artifact-producing command that was not updated during the command fails as `status: "stale"` instead of being accepted as fresh evidence (`wait --download` remains observational). Inline image attachments are optional when size limits allow—do not require vision review unless the user asked for visual inspection. If the latest prompt names exact required artifact paths, browser close can be blocked with `details.promptGuard` until those artifacts are saved and verified.

Artifact cleanup is host-owned, not a browser command. Close commands (`close`, `quit`, or `exit`) shut down the browser session but do **not** delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings saved to paths you chose. When the session’s non-empty `details.artifactManifest` is in scope, a successful close command appends a compact `Artifact lifecycle` note and sets `details.artifactCleanup` with the same retention summary as `details.artifactRetentionSummary`, a fixed `note` about host-owned cleanup, and `explicitArtifactPaths`: up to ten distinct paths from manifest rows whose `storageScope` is `explicit-path` (this list can be empty if the recent window only holds spills or other non-explicit inventory). Remove any listed paths with normal file tools after inspection.

Start a fresh profiled browser after the implicit public-browsing session already exists:

```json
{ "args": ["--profile", "Profile 1", "open", "https://example.com/account"], "sessionMode": "fresh" }
```

Start a fresh launch with a different Chromium-compatible executable:

```json
{
  "args": ["--executable-path", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "open", "https://example.com/account"],
  "sessionMode": "fresh"
}
```

After a successful unnamed fresh launch, later default `sessionMode: "auto"` calls follow that browser automatically. If the fresh launch fails or times out, `details.managedSessionOutcome` records whether the previous managed session was preserved or the attempted fresh session was abandoned before any managed session became current; a `Managed session outcome: …` line is appended only when the failing call used `sessionMode: "fresh"`. If you explicitly close the current wrapper-managed session with `--session <name> close`, later default auto calls rotate to a new wrapper-generated session instead of reusing that closed name, and repeated closes keep reserving fresh names across resume/branch restore.

## Authenticated/profile workflows

The wrapper does not clone profiles or hide what upstream Chrome/Chromium profile or executable you chose. Passing `--profile` or `--executable-path` is an explicit upstream `agent-browser` choice. Visible page content from real profiles is model-visible and may persist in transcripts or saved artifacts; redaction protects credential-like cookie/storage/auth values, not ordinary page text you asked the browser to read.

Use these rules:

- Use public/temp profiles for tests and examples.
- Do not assume `--profile Default` is correct. Ask the agent to run `profiles` to list Chrome profile directory names, then `doctor` if profile/user-data-dir resolution still fails. On macOS, a copied Chrome profile may omit Keychain-encrypted cookies, so profile selection is not proof that the target page is authenticated; verify the page and use a user-approved headed login once when needed.
- For non-Chrome Chromium browsers such as Brave, Edge, Arc, or Vivaldi, use `--executable-path <path>` when upstream can launch that executable. If you need that browser's existing login state, use the browser's real profile/user-data directory path when upstream accepts it, or attach with `--auto-connect` / `connect` to a debug-enabled running browser when appropriate.
- Use `sessionMode: "fresh"` when switching from public browsing to `--allowed-domains`, `--profile`, `--executable-path`, `--webgpu`, `--restore`, `--restore-save`, restore check flags, `--namespace`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device`.
- Use `--session` when you want to manage a live upstream session name yourself. For CDP, connect once, verify with `get url`, keep using that session without repeating `--cdp`, and close it explicitly when done. The wrapper preserves the established attachment across follow-ups instead of resending local-launch defaults, and live-checks the URL before later page reads or interactions because an attached browser can change tabs outside Pi.
- Do not treat an arbitrary `--session` name alone as persisted auth after `close`, `quit`, or `exit`. Wrapper-owned managed sessions automatically set a Pi-transcript- and Git-checkout-generation-scoped `AGENT_BROWSER_RESTORE` key so cookies/localStorage/sessionStorage survive browser relaunches, reloads, and `/resume` for that transcript. Different Pi chats use different restore pools because upstream 0.33.2 loads the newest file for a key regardless of browser-session suffix; this prevents concurrent chats from clobbering or inheriting each other's state. The Git generation identity survives a checkout rename, but the full key also binds the transcript's cwd-derived managed-session base name, so renaming the checkout or running the same transcript from a different working directory starts a fresh key fail-closed (re-authenticate once); the key also changes when that path is replaced/copied or the Pi transcript changes, and automatic restore fails closed outside a Git checkout. The wrapper combines the checkout-root and Git-admin filesystem identities, a generation UUID in the Git admin directory, and the transcript's cwd-derived managed-session base name, and never adopts older cwd-only keys; a bare caller `--session` name does not get that injection, and the wrapper reserves `piab-*` names case-insensitively so another Pi process cannot attach to a managed authenticated browser through a case alias. Disable with `PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE=0`. For explicit non-managed sessions use `--session <id> --restore`, `--profile`, or `--state`. SSO/2FA such as Okta Touch ID may still need one human approval (often `--headed` the first time); after that, managed restore should keep the session without a manual `state save` dance. Passive project/user upstream `agent-browser.json` files are ignored because accepted browser-backed spawns pin a process-private empty config to close config-creation races. Explicit `AGENT_BROWSER_CONFIG` or `--config` overrides still block browser-backed native calls without reading caller-selected content. This is separate from this package's trusted Pi-scoped config; sessionless local/setup commands retain upstream config behavior. Raw batch argv, batch stdin containing nested `connect`/`batch`, browser mutation flag, or matching launch-mutation env disables automatic managed restore rather than risking restored auth in a caller-customized or attached browser. Every accepted browser-backed subprocess, including wrapper-owned close, pins `AGENT_BROWSER_CONFIG` to that process-private empty config (`0400` on POSIX) in the marked secure-temp lifecycle so a project or user config created between planning and spawn cannot change the browser. A user-private immutable ticket-claim lock serializes each same-identity daemon inspection through the receiving spawn and bridges the pre-update v2 lock path; every lock winner re-inspects the live daemon, and abandoned v2 locks fail closed rather than being reclaimed unsafely. POSIX process identity probes use absolute `/bin/ps` then `/usr/bin/ps` paths. Before an incompatible call, the wrapper inspects the actual same-identity daemon and blocks when it retains any restore key, cannot be inspected, or reports restore-disabled policy without current-process provenance, including daemons missing from transcript state and sessions launched with explicit restore keys. Same-process `session_tree` transitions retain recorded provenance; extension reload, restart, and `/resume` deliberately do not trust transcript-only provenance for a still-live restore-disabled daemon, so close it first, omit the explicit session and use `sessionMode: "fresh"`, or choose a distinct explicit session. If inspection instead proves the old daemon inactive, the next owned no-restore spawn records that null policy so subsequent follow-ups remain usable. Wrapper-owned subprocesses pin the canonical namespace, including an explicit empty default, so a parent `AGENT_BROWSER_NAMESPACE` cannot redirect close or helper calls; Electron status target reads and current-managed probes also acquire the same daemon-policy lock, verify the live URL before title/content reads, and apply the same restore decision to every underlying read. A probe whose reads all fail is an `upstream-error`, not a successful empty partial result. Current-managed probe results persist their namespace and ref state for Pi reload/branch replay. Upstream restore files live under `~/.agent-browser/` and are plaintext unless you set `AGENT_BROWSER_ENCRYPTION_KEY`; on POSIX the wrapper canonicalizes and pins `HOME` after caller env merging, requires owner-trusted non-writable ancestry, requires stable device/inode/birth-time metadata for both checkout and Git-admin directories, enforces mode `0700` without silently tightening unsafe existing directories, and rejects symlinks/non-directories along the exact restore `sessions` path and its `.tmp` write area before automatic managed restore. Windows automatic managed restore requires an absolute `USERPROFILE` and the documented 64-character hex `AGENT_BROWSER_ENCRYPTION_KEY` because POSIX mode checks cannot verify profile ACLs. Wrapper-owned close commands discard caller config/restore globals, preserve the live daemon's existing restore key instead of injecting one derived from a possibly replaced checkout, and record a returned old-generation snapshot against that observed wrapper key. If a fresh command starts agent-browser but then fails, the wrapper probes that exact identity and retains a live or uninspectable daemon for shutdown cleanup instead of abandoning it. After a wrapper-owned managed session closes successfully, the wrapper persists the returned state path as an atomic record in a lockless convergent per-key ownership directory (`0700`, with `0600` records, on POSIX), keeps the two newest proven snapshots for its exact restore key across Pi restarts, self-heals malformed regular records, removes additional proven snapshots older than 30 days, expires ownership-proven snapshots and empty manifests from older restore-key generations only when a private lineage record proves the same canonical checkout path, after 30 days, and caps young close churn at 256 records per restore key; unrecorded matching files and the current checkout key remain untouched. Managed restore keys and key-bearing paths are redacted from tool output and transcripts. `session list` and `state list` hide wrapper-managed rows; cross-checkout managed `--restore` / `--state` / state-file access, broad `state clear`, `state clean`, and managed save/rename targets are rejected before spawn. Browser access to `.agent-browser` storage is blocked through command-specific file operands (including dash-prefixed values), every path-bearing upstream environment mirror (including state/profile/config, executable/extension/init-script, action-policy, artifact, skills, and socket paths), encoded, nested-file-scheme, Windows-aliased, or symlinked targets (including not-yet-created descendants of symlinked directories), content-returning local-URL commands, protected artifact destinations and top-level `outputPath`, local-page follow-ups, and persisted unverified top-level or batch tab/attachment/script/state-load transitions. Raw batch command strings are split on literal ASCII spaces exactly like upstream and inspected recursively just like batch stdin arrays; Electron launch handoffs, probes, and later capture share the same boundary: snapshot/tabs handoff and probes verify the live URL before tab/title/content helpers, and cancellation during handoff closes the managed session plus process/profile. The wrapper rejects enabled `--allow-file-access` argv/env plus file-access-enabling or protected-path `--args` / `AGENT_BROWSER_ARGS` values, removes caller file-access occurrences, clears raw-args env, and adds canonical `--allow-file-access false` on local-browser spawns. Routine HTTP(S) work relies on the protected empty config and cleared raw-args environment instead of sending `--args ""`, which `agent-browser 0.34.0` treats as a launch override that can replace a profiled browser with `about:blank`. Local-file navigation is limited to wrapper-managed local browsers; caller-owned and attached browsers are blocked because their file-access launch provenance is unknown. A fixed non-empty `--args` value is added only for wrapper user-agent compatibility sessions; attached-session follow-ups omit launch-only flags, and an explicit validated safe CLI `--args` remains usable. Post-transition summaries, including after arbitrary `eval`, verify the live URL before title and fail implicit transitions to local file pages; failed navigation attempts remain unverified, and stale concurrent completions cannot overwrite newer unknown page state. `get url`, `tab list`, non-content `tab <id>` selection, explicit safe navigation away, and session/tab close remain available for recovery; tab selection stays unverified until `get url` succeeds. The wrapper repeats checkout, storage, environment, managed-session ownership, and managed-state access validation after async config/socket setup immediately before spawn. On POSIX the selected daemon socket directory must be absolute, current-user-owned, mode `0700`, under trusted ancestry, and free of symlink, foreign-owner, or special planted entries. Pre-existing unsafe modes are rejected rather than repaired, and the check is repeated immediately before spawn. On native Windows, command-first launcher reordering moves only syntactically valid leading globals, rewrites a valued `--restore <name>` as `--restore=<name>` to preserve upstream optional-value semantics, and leaves invalid or command-scoped leading tokens untouched. Upstream periodically saves restore-enabled cookies/localStorage while the browser is open; `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS` defaults to `30000`, `0` disables periodic saves but keeps save-on-close, and the `never` value for `--restore-save` disables automatic saves for that restore session.
- Caller-owned explicit sessions are live-checked with `get url` before content-bearing reads or interactions. Missing or stale transcript page state is not treated as proof of a safe target; if the live URL cannot be verified, the requested content command does not run. Calls to the same effective canonical namespace/session are serialized inside one extension instance; explicit namespace argv overrides `AGENT_BROWSER_NAMESPACE`, including an explicit empty default from that probe through any semantic-action snapshot and the requested command, while different caller-owned sessions remain independent. Raw non-bail batches are rejected when a failed navigation could expose prior local or unverified page content; use exact `batch --bail` or split navigation from content. Protected Windows paths include drive-relative forms such as `C:.agent-browser\\state\\...`. Nested `batch` steps are rejected, and raw batch command strings mirror upstream's ASCII-space tokenizer, including its single/double-quote and backslash handling, without splitting on other Unicode whitespace.
- Prefer page actions and storage checks over cookie dumps. `cookies get` can expose real profile cookies.
- Prefer `auth save --password-stdin` over putting passwords in `args`; the wrapper only accepts caller `stdin` for `batch`, `eval --stdin`, and `auth save --password-stdin` (top-level `job` and `qa` compile to `batch` and supply their own stdin).
- Use `state save <path>` / `state load <path>` for portable test state. `state save` is reported as a file artifact with verification metadata; if an upstream-successful artifact command reports a non-pending file path that the wrapper cannot find or did not update during this command, the tool fails with `failureCategory: "artifact-missing"` instead of treating missing/stale evidence as durable. `state load` may mention a path but is not treated as a newly saved artifact.
- Treat `cookies get`, `storage local|session`, `state show`, and `auth show` output as sensitive. `state show` is presented as saved-state metadata only, and cookie/localStorage/sessionStorage values are redacted from structured details. The native presentation summarizes and redacts credential-like values while allowing benign primitive storage values to aid local QA, but avoid requesting broad dumps unless the task needs them.
- Use `dialog status`, `dialog accept [text]`, `dialog dismiss`, and `frame <selector|main>` through native `args`; dialog commands use a shorter wrapper timeout and timed-out interactions add `inspect-dialog-after-timeout` / `dismiss-dialog-after-timeout` / fresh-session recovery actions so a blocking alert/prompt does not burn the full default watchdog. Use exact `confirm <id>` / `deny <id>` next actions for guarded-action confirmations.

Safe stateful examples:

```json
{ "args": ["auth", "save", "demo", "--password-stdin"], "stdin": "password from the user-approved secret source" }
{ "args": ["auth", "login", "demo"] }
{ "args": ["state", "save", "/tmp/demo-state.json"] }
{ "args": ["state", "load", "/tmp/demo-state.json"], "sessionMode": "fresh" }
{ "args": ["cookies", "set", "theme", "dark", "--url", "https://example.com"] }
{ "args": ["storage", "local", "get", "theme"] }
{ "args": ["dialog", "accept", "prompt text"] }
{ "args": ["frame", "main"] }
```

Example explicit session plus profile launch:

```json
{
  "args": ["--session", "auth-flow", "--profile", "Default", "open", "https://example.com/account"]
}
```

## React, SPA, and first-navigation setup

React and SPA tooling from upstream `agent-browser` is passed through directly.

Launch React introspection before first navigation:

```json
{ "args": ["open", "--enable", "react-devtools", "https://example.com"], "sessionMode": "fresh" }
{ "args": ["react", "tree"] }
{ "args": ["react", "inspect", "<fiberId>"] }
{ "args": ["react", "renders", "start"] }
{ "args": ["react", "renders", "stop"] }
{ "args": ["react", "suspense", "--only-dynamic"] }
```

Use SPA and Web Vitals helpers as normal command tokens:

```json
{ "args": ["pushstate", "/dashboard"] }
{ "args": ["vitals", "https://example.com"] }
```

For setup that must happen before first navigation, open a blank fresh page, stage routes/cookies/scripts, then navigate:

```json
{ "args": ["open"], "sessionMode": "fresh" }
{ "args": ["network", "route", "**/*.js", "--abort", "--resource-type", "script"] }
{ "args": ["cookies", "set", "--curl", "/path/to/cookies.txt", "--domain", "example.com"] }
{ "args": ["navigate", "https://example.com"] }
```

## Proof and verification

`npm run docs` checks that generated playbook fragments and command-reference baseline blocks match their canonical sources (`extensions/agent-browser/lib/playbook.ts` and `scripts/agent-browser-capability-baseline.mjs`) without invoking upstream `agent-browser`.

The local verification gate is:

```bash
npm run verify
```

For a fast TypeScript-only iteration loop (same `tsc --noEmit` as the default gate, without docs drift checks, unit tests, or live upstream command-reference sampling):

```bash
npm run typecheck
```

The full `npm run verify` gate runs:

- generated playbook/documentation drift checks
- a clean build of generated `dist/` runtime files
- `tsc --noEmit`
- the test suite
- command-reference baseline checks
- live command-reference verification against the targeted installed upstream `agent-browser`

Step order and which subprocesses run live in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs); [`test/project-verify.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/project-verify.test.ts) locks default, `pre-pr`, `release`, `startup-profile`, `real-upstream`, `dogfood`, `platform-target`, `platform-smoke`, `package-pi`, and combined-docs orchestration so a gate cannot disappear accidentally. Run `npm run verify -- --help` for opt-in modes and supported passthrough flags.

For larger local handoffs or PR-ready confidence before expensive release/lifecycle/platform gates, run:

```bash
npm run verify -- pre-pr
```

That mode composes the full default gate with `npm run verify -- package`, so package contents and forbidden repo-only files are checked without launching Pi lifecycle, Crabbox, or live dogfood flows. Package modes build through npm `prepare`; lifecycle and startup-profile build in their focused scripts; default and platform-target build before consuming `dist/`, so clean checkouts do not validate stale or missing compiled output. The same `prepare` script owns GitHub/source installs; when Pi installs with `npm install --omit=dev`, it installs the source-build dev dependencies with lifecycle scripts disabled before building the ignored `dist/` entrypoint that Pi loads.

The opt-in startup profiler measures only the package extension entrypoint import plus factory registration in fresh Node processes. It intentionally does **not** launch Pi, tmux, mise, npm, browsers, or `agent-browser`; full Pi TUI ready-prompt profiling proved too invasive for routine verification on the operator machine. Run it after package entrypoint, generated runtime, or top-level import changes:

```bash
npm run build
npm run verify -- startup-profile --samples 3
```

Reports are written to `.artifacts/startup-profile/latest.json` and include a safety block confirming no Pi, tmux, mise, npm, browser, or `agent-browser` subprocesses were launched.

The opt-in real-upstream suite is separate because it drives a real browser installation:

```bash
npm run verify -- real-upstream
```

That mode sets `PI_AGENT_BROWSER_REAL_UPSTREAM=1` and runs `test/agent-browser.real-upstream-contract.test.ts` against the real `agent-browser` on `PATH` (version must match the capability baseline). It covers inspection, skills, a broad core interaction and navigation matrix on localhost fixtures (including off-viewport click, frame-scoped selector/wait/click behavior, form command fixes, `batch` stdin, and `pushstate`), plus `vitals`, network route/requests/HAR, diff snapshot/screenshot/url, trace/profiler, console/errors/highlight, stream enable/status/disable, `cookies set --curl`, a `react tree` missing-renderer path, and `wait --download` with the on-disk caveat documented in release notes. The harness uses a throwaway temp `HOME` and dedicated socket/screenshot directories so the run does not touch your normal browser profile paths. Browser-opening or credential-dependent families such as `inspect`, `dashboard`, `chat`, provider clouds, and OS clipboard flows stay in fake-upstream or manual validation unless a safe deterministic fixture is added. For prerequisites, isolation details, and troubleshooting, see [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-contract-validation).

A deterministic host-only live-browser wrapper smoke is available without an LLM choosing tool calls:

```bash
npm run verify -- dogfood
```

That mode clean-builds the package, then drives the native wrapper through top-level `script` branching/aggregation, `qa`, `semanticAction`, constrained `job`, screenshot artifact verification, and session close against a deterministic local fixture. It complements, but does not replace, the interactive Pi/tmux release dogfood in [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks).

Cross-platform release coverage uses Crabbox to run macOS, Ubuntu Linux, and native Windows target suites; see [`docs/platform-smoke.md`](docs/platform-smoke.md) for the required matrix, standalone coverage (`npm run smoke:platform:all` and per-target `smoke:platform:macos` / `:ubuntu` / `:windows-native`), and artifact/lease inspection. The release gate is:

```bash
npm run doctor
npm run check:platform-smoke
npm run smoke:platform:ubuntu-image
npm run smoke:platform:doctor
npm run verify -- release
```

`npm run verify -- release` includes the default verification gate, packaged Pi smoke coverage, and the release-blocking Crabbox platform matrix (the same matrix `npm run smoke:platform:all` runs standalone). For the full maintainer release flow, follow [`docs/RELEASE.md`](docs/RELEASE.md). The package also has a `prepublishOnly` hook that runs the same release gate and `npm pack --dry-run` during `npm publish`.

## How it works

`pi-agent-browser-native` is intentionally thin:

1. Pi loads the compiled `dist/extensions/agent-browser/index.js` entrypoint from the package manifest; TypeScript under `extensions/` remains the source of truth and `npm run build` regenerates `dist/` before packing.
2. The extension registers one native tool named `agent_browser`.
3. Tool calls are translated into upstream `agent-browser` CLI invocations with controlled args, stdin, environment, timeout, and session planning.
4. Upstream JSON/plain-text output is parsed into model-friendly content and structured details.
5. Screenshots, downloads, recordings, traces, profiles, and spill files are normalized as Pi-visible artifacts where possible.
6. Generated playbook text in docs and tool metadata stays aligned with `extensions/agent-browser/lib/playbook.ts`.

The upstream browser engine remains [`agent-browser`](https://agent-browser.dev/). This package does not bundle it and does not maintain compatibility shims for old upstream versions.

## Current limits

- Published pre-1.0 package.
- Targets the current locally installed upstream `agent-browser` version only.
- Does not bundle `agent-browser`; users install it separately.
- Does not provide a human browser UI inside Pi; the primary UX is agent-invoked tool calls. `--headed` asks upstream to show a browser window, but the wrapper cannot yet prove that the window is visible on the user's desktop.
- Localhost means the browser host's loopback, not necessarily the shell/Pi host. If `http://localhost:<port>` or `http://127.0.0.1:<port>` fails with errors such as `ERR_EMPTY_RESPONSE`, use an environment-specific host-reachable HTTP(S) address. Do not switch the native wrapper to a `file://` fixture: follow-up inspection and interaction on local file pages is blocked to protect authenticated `.agent-browser` state.
- A successful upstream `click` is not proof that the app handled the event. For state-changing flows, verify with a fresh snapshot, text/URL assertion, screenshot, or `pageChangeSummary` before reporting success.
- Real authenticated profile use is powerful but sensitive. Treat profile and cookie access as user-approved, task-specific behavior.
- Wrapper tab/session recovery is best effort around observed upstream behavior, not a replacement for explicit profile/session design.

## Local development

Install upstream `agent-browser`, then install dependencies:

```bash
npm install
```

Use the npm version declared in `package.json` `packageManager` when refreshing `package-lock.json` (for example `npx -y npm@11.14.0 install`) so optional-platform lockfile metadata does not drift. Align the global `pi` CLI with this repo’s `pi-coding-agent` devDependency range before lifecycle or interactive browser smokes. See [Environment and automation pitfalls](docs/RELEASE.md#environment-and-automation-pitfalls) in `docs/RELEASE.md`.

Quick isolated checkout smoke test:

```bash
pi --approve --no-extensions -e .
```

This bypasses Pi settings and configured extensions while explicitly trusting this checkout's project-local inputs for the run. Omit `--approve` when you want to exercise Pi's interactive Project Trust prompt instead. After editing extension code, restart that Pi process to test the new checkout.

For a concrete expanded native-tool smoke matrix (version/help/skills through dashboard/chat families), see [Local development validation](docs/RELEASE.md#local-development-validation) in `docs/RELEASE.md`. For bounded release smokes that should validate this extension rather than skill routing, use the [Sauce Demo smoke prompt](docs/RELEASE.md#public-sauce-demo-checkout-smoke-prompt), which adds `--no-skills`. When changes affect dense dashboards, diagnostics, artifacts, recording, scroll, or combobox behavior, use the public [Grafana stress checklist](docs/RELEASE.md#public-grafana-stress-checklist) for repeatable release dogfood without bundling private skills or recipes.

Configured-source lifecycle validation:

```bash
npm run verify -- lifecycle
```

The harness defaults to Pi model `zai/glm-5.2` and **180000 ms** per-step tmux waits; pass `--model <id>` and/or `--timeout-ms <ms>` after `lifecycle` when you need different settings (see [Configured-source lifecycle validation](docs/RELEASE.md#configured-source-lifecycle-validation) in `docs/RELEASE.md`). It launches the supported Pi runtime with `--approve` and a deterministic `--session-id`, drives `/reload`, closes Pi, relaunches the exact same session, asserts the JSONL header id, and checks managed-session continuity, compiled-entrypoint pickup after process restart, persisted spill reachability, and real Pi `tool_result` failure-patch behavior.

Use lifecycle validation when testing `/reload`, exact-session relaunch, `/resume`, managed-session continuity, or persisted artifact behavior. Branch-backed state and `session_tree` cleanup ownership are covered by focused extension harness tests. Maintainers must run the lifecycle harness before every publish; see [Pre-release checks](docs/RELEASE.md#pre-release-checks).

Installed-package validation after publish:

```bash
npm run verify -- package-pi
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

## Generated native-tool playbook notes

These sections are generated from `extensions/agent-browser/lib/playbook.ts`. Run `npm run docs -- playbook write` after changing the canonical playbook source.

<!-- agent-browser-playbook:start inspection -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
Native inspection calls use the `agent_browser` tool shape, not shell-like direct-binary commands:

- { "args": ["--help"] }
- { "args": ["--version"] }

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, auto-connect, or provider-backed launches.
<!-- agent-browser-playbook:end inspection -->

<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- After open/goto/navigate calls with --profile, --restore, --session-name, or --state, agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch or reconnect.
- After the wrapper observes tab-drift risk for a session (for example open correction, overlapping stale opens, or resumed session state), later active-tab commands best-effort pin that tab inside the same upstream invocation. Routine same-session commands are not preflighted with tab list just because a target tab or ref snapshot is known.
- For sessions with observed tab-drift risk, after a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes. Routine same-session commands skip this post-command tab-list probe.
- If a known session target unexpectedly reports about:blank, agent_browser best-effort re-selects the prior intended target when it still exists; if recovery fails, it records the observed about:blank target and reports exact recovery guidance instead of treating the prior page as active.
- If upstream reports tab_gone, the pinned bound tab is gone; use details.nextActions (tab list / tab new) instead of assuming another tab is yours.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->

## Project map

| Path | Purpose |
|---|---|
| `extensions/agent-browser/index.ts` | TypeScript source for the Pi extension entrypoint; packed installs load compiled `dist/extensions/agent-browser/index.js` |
| `extensions/agent-browser/lib/runtime.ts` | Argv parsing, session planning, redaction, and execution-plan helpers (pure planning; subprocess wiring lives beside the entrypoint) |
| `extensions/agent-browser/lib/results/` | Model-facing result rendering and error guidance |
| `extensions/agent-browser/lib/playbook.ts` | Canonical generated agent/browser guidance |
| `scripts/agent-browser-target.mjs` | Canonical target upstream version shared by runtime and build-time checks |
| `scripts/agent-browser-capability-baseline.mjs` | Help samples and doc/token inventory for drift checks; imports the canonical target version |
| `scripts/check-command-reference-baseline.mjs` | Regenerates or verifies HTML-bounded baseline blocks in `docs/COMMAND_REFERENCE.md` (via `npm run docs -- command-reference …`) |
| `docs/COMMAND_REFERENCE.md` | Repo-readable native command reference |
| `docs/TOOL_CONTRACT.md` | Tool parameters, result shape, and behavior contract |
| `docs/ELECTRON.md` | Dedicated public guide for Electron desktop-app support |
| `docs/ARCHITECTURE.md` | Design decisions and implementation structure |
| `docs/REQUIREMENTS.md` | Product requirements and constraints |
| `docs/RELEASE.md` | Release, package, and lifecycle verification workflow |
| `docs/platform-smoke.md` | Crabbox macOS, Ubuntu, and native Windows release gate |
| `docs/SUPPORT_MATRIX.md` | Current upstream support audit and release-readiness matrix |
| `test/` | Wrapper, runtime, presentation, lifecycle, and package tests |

## More docs

- [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) — maintainer and agent runbooks, including upstream capability baseline rebaselining and Pi smoke testing in `tmux`
- [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md) — full native command reference and upstream capability baseline
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — exact tool contract
- [`docs/ELECTRON.md`](docs/ELECTRON.md) — Electron desktop-app guide
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the wrapper is designed
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — product constraints and non-goals
- [`docs/RELEASE.md`](docs/RELEASE.md) — maintainer release workflow
- [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) — current upstream support matrix and closure evidence

## Where to go next

If you are a user, install the package and ask Pi to open a public page with `agent_browser`.

If you are evaluating the implementation, read [`extensions/agent-browser/index.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/extensions/agent-browser/index.ts), then run `npm run verify`.
