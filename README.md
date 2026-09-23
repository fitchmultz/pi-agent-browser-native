# pi-agent-browser-native

A Pi extension that lets coding agents drive real browser sessions with a native `agent_browser` tool instead of brittle shell commands.

It is for Pi users who want agents to browse sites, inspect pages, click through flows, capture screenshots, use persistent profiles, and handle authenticated web apps without spending context on `agent-browser` CLI ceremony.

## Pi release qualification

Development host dependencies are pinned to official Pi **0.87.0**, with wildcard runtime peers. `npm run check:compat` checks the installed candidate SDK/CLI identity, typechecks, runs the existing offline tests (including the native Pi pipeline with a controlled provider and fake browser), and tests a packed runtime-only installation through both the SDK and the actual bundled RPC CLI. The fork lane additionally requires the native idle checkpoint hook. It does not substitute a fork SDK while leaving official types or child CLI installed.

Run in an empty HOME with a **short** TMPDIR outside your real home. Long temporary paths can exceed macOS's 103-byte Unix socket limit; keep the fixture's socket safety checks intact. Real-browser/checkpoint controls, live upstream help sampling, lifecycle dogfood, and platform qualification remain the separate gates documented below. A Pi-only compatibility run uses no live browser profiles, credentials, or agent-browser fork, and does not certify those external integrations.

For the 0.6.16 compatibility rollout, the owner explicitly waived Windows qualification on 2026-09-21. Windows diagnostics and failures remain visible but nonblocking; this is **not** a Windows full-suite pass. Linux/macOS, declared Node floors, official/fork host and consumer-artifact checks remain required. Known Windows failures and follow-up are tracked in [#191](https://github.com/fitchmultz/pi-agent-browser-native/issues/191); see the [current support evidence](docs/SUPPORT_MATRIX.md#current-0616-rollout).

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

Embedding Pi in another host? The extension factory accepts an optional awaited [`beforeExecute` callback](docs/TOOL_CONTRACT.md#host-execution-hook) for saving host state before browser dispatch. Ordinary Pi installation needs no callback.

## What this looks like in Pi

You prompt the agent in plain English:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

The agent gets a native tool, not a bash workaround:

```json
{ "args": ["open", "https://react.dev"] }
{ "args": ["snapshot", "-i"] }
{ "args": ["find", "text", "Learn React", "click"] }
```

Use native commands for individual actions, `batch --bail` for fixed sequences, and `agent_browser_code` for loops or branches. Specialized tools are available through `agent_browser_tools`; see [common calls](#common-agent-calls).

The result is optimized for agent work:

- compact page snapshots that lead with useful page content instead of chrome/sidebar noise
- interactive `@eN` refs for follow-up clicks and form fills
- screenshots and downloaded files surfaced as Pi artifacts
- structured details for titles, URLs, saved files, sessions, and errors
- spill files for full redacted output instead of dumping oversized pages into context
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
| Agents build fragile shell commands or repeat browser calls for loops and branches | Exposes compact `agent_browser` for native commands and batch, `agent_browser_code` for fresh JavaScript against the same persistent browser, and discoverable action, QA, Electron, and source tools | `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/input-modes/`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) |
| Page snapshots are too large or viewport-blind | Shows compact, main-content-first summaries, surfaces an `Omitted high-value controls` section (plus `details.data.highValueControlRefIds`) when dense pages or desktop host screens hide editables, named surfaces/tabs, primary action buttons, and high-signal named links such as repository results from the trimmed ref lists, supports wrapper-side `snapshot -i --search <text>` / `--filter role=<role>` to trim dense pages while preserving full `details.refSnapshot`, supports `snapshot --viewport` for scroll/viewport metadata, supports `snapshot --diff` for quick ref-map deltas versus the prior tracked snapshot, and stores full redacted output in spill files when needed | `extensions/agent-browser/lib/results/snapshot.ts`, `extensions/agent-browser/lib/orchestration/browser-run/prepare.ts`, `test/agent-browser.presentation.test.ts`, `test/agent-browser.extension-validation.test.ts` |
| Screenshots/downloads get lost in text | Normalizes artifact paths, creates missing parent directories, leaves click/download execution to native download, and reports existence, size, cwd, session, and repair status | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#download-screenshot-and-pdf-files) |
| Profile restores and tab drift confuse agents | Tracks managed sessions, keeps every upstream helper probe on the same idle-timeout launch configuration so the background browser is not restarted between a snapshot and action, re-selects target tabs after observed drift, live-verifies the active target and refreshes its title after successful tab selection or `tab close` (while retaining deliberate `about:blank` selections and post-close blank targets), rehydrates branch-backed session state on Pi session-tree changes, and pins later commands only for sessions with drift/restored-session risk | generated tab-recovery notes below; `test/agent-browser.extension-tab-recovery.test.ts` (drift and about:blank recovery), `test/agent-browser.extension-tabs.test.ts` (post-close target), `test/agent-browser.extension-ref-guards.test.ts` (snapshot/action environment and session-tree rehydration), `test/agent-browser.resume-state.test.ts` (persisted session / resume planning) |
| Auth/profile workflows can leak secrets | Supports `auth save --password-stdin`, redacts sensitive args, SAML/OAuth-bearing URLs, stdout/stderr, details, and snapshot spills, and discards malformed oversized stdout instead of persisting a parse-failure spill | `test/agent-browser.extension-security-redaction.test.ts` |
| Stateful cookies/storage/auth output bloats or leaks context | Presentation layer redacts `details.data` for cookies and credential-like storage values while keeping low-risk local QA values such as `theme: dark` readable; recursively scrubs other structured upstream JSON (network, diff, trace/profiler, stream, dashboard, chat, auth, dialog, frame, state, and similar) using sensitive key names plus string heuristics; masks sensitive argv flags and positionals, including raw batch rows and ordered code journals; scrubs secrets from failed batch step errors; and exposes a compact redacted `batch` matrix on top-level `details.data` | `extensions/agent-browser/lib/results/presentation.ts`, `extensions/agent-browser/lib/results/presentation/diagnostics.ts`, `extensions/agent-browser/lib/runtime.ts`, `test/agent-browser.presentation-diagnostics.test.ts` |
| Stale `@eN` refs fail mysteriously | Records per-session `details.refSnapshot`, rejects mismatched URLs / unknown refs / unsafe `batch` stdin ordering before spawn, adds recovery guidance to rerun `snapshot -i` or use stable `find` locators | `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/session-page-state.ts`, `test/agent-browser.session-page-state.test.ts`, `test/agent-browser.results.test.ts`, `test/agent-browser.extension-ref-guards.test.ts`, `test/agent-browser.extension-semantic-recovery.test.ts` |
| Agents need stable success/failure buckets | Exposes bounded `resultCategory`, `successCategory`, and `failureCategory` on tool `details` for branching without parsing prose; a `tool_result` hook also aligns real Pi `isError` semantics, naming `Pi tool isError: true` in prose output while preserving parseable caller-requested `--json` output | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/results/categories.ts`, `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/pi-tool-rendering.ts`, `test/agent-browser.results.test.ts`, `test/agent-browser.extension-validation.test.ts`, `test/agent-browser.pi-pipeline.test.ts` |
| Clicks can report success without the page receiving the event | Top-level non-Electron direct `click` calls on `xpath=` targets or role-gated current `@e…` refs (`button`, `checkbox`, `menuitem`, `radio`, `switch`, `tab`) install a bounded target-specific DOM-event probe; eligible `@e…` refs require a unique role/name in both the latest snapshot and the live candidates. A per-probe temporary DOM marker must be read back by native `get attr <original-selector> <marker>` before the candidate can verify dispatch, including XPath scope. Missing or mismatched identity cleans up the probe and leaves the native click unverified, not failed. Duplicate-name refs pass through without a probe: their old ordinal cannot prove which element received the click. If upstream reports success but no trusted event reaches the resolved target, the wrapper fails the tool, exposes `details.clickDispatch`, and suggests explicit retry/inspect next actions (no in-page replay), including a nested-scroll `scrollintoview` action when the probe sees the target outside a scroll container or viewport. Unresolved locator clicks such as raw `find … click` are left upstream-owned to avoid false failures for frame-scoped targets. Other click results still expose `details.pageChangeSummary`; `observed: false` explicitly marks dispatch-only mutation summaries and adds a visible `Action dispatched; application change unverified` warning. Unchanged-URL clicks can surface evidence-backed `details.overlayBlockers` candidates. | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.ts`, `extensions/agent-browser/lib/results/presentation/navigation.ts`, `test/agent-browser.presentation.test.ts`, `test/agent-browser.extension-click-dispatch.test.ts` |
| Dashboard scroll commands can look successful while nothing moves | Handles standard `scroll <dir> [px]` against the document first (including pages whose smooth-scroll CSS defeats upstream wheel timing), falls back upstream when the document cannot move, and samples viewport/containers around the fallback; explicit CSS-container scrolling uses instant movement so smooth-scroll CSS cannot cause a premature no-movement failure; unchanged positions fail as `upstream-error` with `details.scrollNoop`, visible recovery guidance, and exact snapshot/screenshot checks. Unsupported `scrollintoview text=...` fails before dispatch, including inside effective batch rows, and shows exact native `find text ... hover` and snapshot/ref recovery payloads; help remains native pass-through. | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#core-page-and-element-commands), `test/agent-browser.extension-validation.test.ts` |
| Dropdown/combobox clicks can focus or hit native option box-model errors | Adds first-class `select <selector> <value...>` paths through native `args` and `agent_browser_action`; semantic role/name or label select resolves exactly one current visible combobox/listbox ref before action. Custom combobox clicks still detect focused controls with explicit `aria-expanded` state but no visible options and return `details.comboboxFocus` plus exact recovery `nextActions` | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#core-page-and-element-commands), `extensions/agent-browser/lib/input-modes/semantic-action.ts`, `test/agent-browser.extension-input-modes.test.ts`, `test/agent-browser.extension-validation.test.ts` |
| Recording workflows fail late when `ffmpeg` is missing or report stale lifecycle state | After successful `record start` / `record restart`, reports `successCategory: "artifact-pending"`, returns an exact `stop-pending-recording` action, warns when older natives report pending output without `ffmpeg`, and conservatively invalidates prior page-scoped `@e…` refs on every executed start attempt and URL-bearing restart to protect older supported natives. This is not evidence of a page change: 0.37 records the active page unless a URL is supplied; FPS-only calls keep the intended tab; an unbounded transcript-backed namespace/session index reserves active destinations across aliases, serializes artifact lifecycle and explicit wait/output writes, persists cross-branch close tombstones, retires every successful close path (including every matching namespace owner for `close --all`), rejects missing/stale restart output, coalesces terminal batch state, keeps only the newest pending path per identity, rejects recording starts after a nested close, folds Unicode path aliases, and retains exact cleanup actions with visible guidance on any later same-session failure | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#diff-debug-and-streaming), `test/agent-browser.extension-validation.test.ts`, `test/agent-browser.presentation-artifacts-batch.test.ts` |
| Upstream CLI drift can silently invalidate wrapper behavior | Publishes a repo-readable command reference, verifies it against the recommended 0.38.1 target, and probes browser-backed calls once per cwd/PATH so stable versions below the 0.35.0 floor fail before browser launch with installed/expected version evidence | `npm run verify` |
| Pages can expose structured workflows through experimental WebMCP | Shows native positive WebMCP availability in navigation summaries and passes through `webmcp list`, `invoke`, detached `result` / `cancel`, params/frame/timeout options, and the bundled `webmcp-gen` skill; treats `--no-webmcp` as launch-scoped, keeps pending or unsuccessfully settled targets unverified with an actionable `get url` follow-up, invalidates stale refs after page tools run, and budgets effective raw or stdin batch timeouts | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#webmcp-page-tools), `test/agent-browser.extension-ref-guards.test.ts`, `test/agent-browser.wait-timeouts.test.ts`, `test/agent-browser.real-upstream-contract.test.ts` |
| Desktop Electron apps need discovery, CDP attach, and safe teardown | `agent_browser_electron` runs host `list` / isolated `launch` (temp profile, OS-chosen debug port) / `status` / `probe` / `cleanup`, merges `launchId` plus managed `sessionName`, supports `handoff` `snapshot` / `tabs` / `connect`, and surfaces mismatch and post-command health guidance; wrapper cleanup applies only to launches it created | `extensions/agent-browser/lib/electron/discovery.ts`, `launch.ts`, `cleanup.ts`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#agent_browser_electron), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#electron-desktop-apps) |
| Agents need bundled `skills` text and local setup/status commands without touching the live session | Treats `skills list/get/path`, local auth/profile/setup commands, `session list`, and local state lifecycle commands as sessionless reads/actions when upstream does not need a live page. Session/state rows and targets remain visible, and supported upstream state/config/path operations pass through unchanged. Browser-backed workflows still receive an implicit session only when the caller did not choose one. | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#built-in-skills), `extensions/agent-browser/lib/command-policy.ts`, `extensions/agent-browser/lib/runtime.ts` |

Artifact results show known requested paths separately from reported/resolved locations and infer image MIME types from file headers, not suffixes. Parent-directory failures return path-specific `validation-error` guidance before browser dispatch. Prefer absolute artifact paths in raw batch strings because the daemon's working directory may differ from Pi's. When execution cwd differs from the launch/project root, the wrapper binds relative file operands, including raw batch rows, to the captured execution cwd. Dispatched `record start` and URL-bearing `record restart` attempts also return one fresh-snapshot warning on success or failure, including in JSON output. It describes conservative ref invalidation, not an observed page change; unreached rows do not emit it.

## Fastest way to try it

Use Pi 0.87.0 or newer. This package keeps optional Pi core imports as wildcard `peerDependencies` because Pi package docs require the host Pi install to provide those packages, pins its direct Pi validation dependencies to 0.87.0, and makes hosts below 0.87.0 a setup failure through `pi-agent-browser-doctor`. There are no compatibility shims for older Pi releases.

Install upstream `agent-browser` first and make sure it is on `PATH`:

- https://agent-browser.dev/
- https://github.com/vercel-labs/agent-browser

Optional external tools unlock the full command surface:

| Dependency | Required for | macOS install example |
| --- | --- | --- |
| `agent-browser` | All browser automation through this extension | See upstream install docs |
| `ffmpeg` | Recording WebM (libvpx) or MP4 (libx264); install before `record start` / `record restart` | `brew install ffmpeg` or `brew install ffmpeg-full` |

Keep both binaries on `PATH`. This package recommends `agent-browser 0.38.1` and accepts stable versions at or above the 0.35.0 floor; browser-backed calls fail fast below that floor while local inspection/setup commands remain available for diagnosis. Native 0.37 validates `ffmpeg`, the output extension and FPS before recording; older supported natives may defer failures until stop. Use `record start <path.webm|path.mp4> [url] [--fps <n>]` (1–60 fps, default 30), then verify the completed file after `record stop`. Native `doctor` checks the recording dependency and encoders.

On 0.38.1, use `snapshot --delta` for native full/unchanged/changed revisions and `snapshot --delta --full` to reset its baseline. Surviving DOM nodes keep their refs, but navigation/replaced nodes still require fresh refs. The wrapper preserves native revisions and refreshes complete refs internally for partial results. `screenshot --if-changed` (or `--threshold 0.01`) skips unchanged images without creating an artifact. `--input-mode instant|smooth|human` controls native session pointer movement; `click ... --human`, `drag ... --human`, and timed `mouse move` remain ordinary `args`. Recordings accept `--cursor` and `--contact-sheet`; the latter produces a timestamped PNG verified after stop. `auth login <name> --no-navigate` fills a prepared login page after upstream checks its origin. See the [command reference](docs/COMMAND_REFERENCE.md#upstream-0381-rebaseline) for examples and limits.

### Android / Termux

Android support currently uses Termux's system Chromium rather than Chrome for Testing. Upstream issue [vercel-labs/agent-browser#1587](https://github.com/vercel-labs/agent-browser/issues/1587) tracks native Android packaging; until upstream ships an Android launcher, install the packaged Linux-musl arm64 binary without lifecycle scripts and point the global command at it. The last locally validated Android setup used 0.36.0:

```bash
pkg install tur-repo x11-repo
pkg install chromium ffmpeg which
npm install -g --ignore-scripts agent-browser@0.36.0
ln -sfn "$(npm root -g)/agent-browser/bin/agent-browser-linux-musl-arm64" \
  "$(npm prefix -g)/bin/agent-browser"
ln -sfn "$PREFIX/lib/chromium/chromium-launcher.sh" "$PREFIX/bin/chromium"
agent-browser --version
which chromium
```

The `which` package and launcher symlink satisfy upstream's existing Linux system-browser discovery even when tests or Pi sessions isolate `HOME`. Browser code uses the same native launch configuration as direct calls.

Reapply the musl command symlink after reinstalling or upgrading upstream until #1587 is resolved. The wrapper uses Termux-private socket/policy storage, compact 80-bit managed identities so ordinary namespaces and fresh rotations fit the Unix socket-path limit, Termux's `ps`, and Android app-sandbox trust rules automatically. Historical 0.6 Android validation covered headless browser flows, managed restore, namespaced sessions, the former script/job inputs, QA, screenshots, and recording; it does not qualify the 0.7 code contract. Electron desktop discovery/lifecycle is not applicable to Android apps. Android remains outside the release-blocking Crabbox macOS/Ubuntu/native-Windows matrix until a repeatable Android provider target is added.

The native tool also gives agents absolute installed-package doc paths in its compact runtime guidance. Raw `args` are the 1:1 upstream CLI coverage path for the targeted `agent-browser` release; `agent_browser_code` adds bounded JavaScript orchestration over the same browser, while advanced tools preserve semantic actions, diagnostic QA, source lookup, and Electron lifecycle. Agents should read `README.md` for setup/dependencies, `docs/COMMAND_REFERENCE.md` for targeted command workflows, and `docs/TOOL_CONTRACT.md` for result/detail contracts only when deeper guidance is needed.

Then install this Pi package:

```bash
pi install npm:pi-agent-browser-native
```

After updating `pi-agent-browser-native`, fully quit and restart Pi before using the updated tools. `/reload` can retain previously loaded compiled JavaScript even after `dist/` is rebuilt, so it is not a reliable way to pick up package updates.

Start Pi and ask for a browser action:

```text
Use the agent_browser tool to open https://example.com and then take an interactive snapshot.
```

For a one-off trial without adding the package to your Pi settings:

```bash
pi --no-extensions -e npm:pi-agent-browser-native
```

`--no-extensions` disables automatic extension loading, not Pi settings, configured package resolution, skills, prompts, themes, or context files.

Pi 0.84.0+ may ask whether to trust projects with trust-gated settings or resources. This extension follows Pi's trust decision when loading its project-local config. `--no-approve` skips that config and Pi's trust-gated project resources; context files such as `AGENTS.md` still load unless context loading is separately disabled.

For a specific published version:

```bash
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

To install directly from source instead of npm:

```bash
pi install https://github.com/fitchmultz/pi-agent-browser-native
```

For a source trial without adding the package to your Pi settings:

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
- the installed upstream is a stable version at or above the supported 0.35.0 floor; 0.38.1 remains the recommended baseline
- `pi --version` meets the minimum Pi runtime floor for this release; older Pi versions are setup failures
- Pi settings do not point at multiple active `pi-agent-browser-native` sources

It does **not** edit Pi settings and does **not** run upstream `agent-browser doctor --fix`.

Pi hosts that run as uid 0 should set `PI_AGENT_BROWSER_SOCKET_DIR` to a short absolute directory under private root-owned ancestry, create it with mode `0700`, and keep it owned by the Pi user. The extension validates that directory and forwards it as upstream `AGENT_BROWSER_SOCKET_DIR`; ambient upstream socket overrides remain ignored.

In a Linux user namespace, `/` may report an unmapped owner. Socket checks trust that operating-environment root while retaining checks on every other ancestor and the private socket directory; they do not protect against whoever controls the root filesystem. The demonstrated bubblewrap layout uses a read-only mode-`0755` root and a current-user-owned mode-`0700` `/tmp`, with private HOME and checkout below it. Unmapped non-root ancestors such as `/home` still fail automatic restore checks; this is not support for every bubblewrap layout. See [filesystem trust](docs/ARCHITECTURE.md#ownership).

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

The optional `agent_browser_web_search` companion tool is available when a usable Exa or Brave credential source is configured or resolvable from startup config or trusted session config. It is not an `agent_browser` input mode and does not launch a browser; prefer it for current/live external web facts and URL discovery, then use `agent_browser` when the page itself needs interaction, screenshots, authenticated/profile content, or DOM inspection. Prefer it over automating public search-engine forms such as Google in headless browser jobs: those flows may be redirected to anti-bot or CAPTCHA pages, and this wrapper does not provide or recommend CAPTCHA bypass. If both keys are available, the default provider is Exa because its `/search` endpoint returns agent-friendly highlights and search modes; set `webSearch.preferredProvider` to `"brave"` when you prefer Brave Search.

Get an Exa API key from the [Exa dashboard](https://dashboard.exa.ai/api-keys) or a Brave Search API key from the [Brave Search API dashboard](https://api-dashboard.search.brave.com/). Most users can simply export `EXA_API_KEY` or `BRAVE_API_KEY` in the environment that launches `pi`; config is only needed when you want Pi-scoped secret references, a preferred provider, a default Exa search type, or to disable this built-in search tool.

Most config users should store env-var references in the Pi-scoped config:

```bash
mkdir -p ~/.pi/config/pi-agent-browser-native
cat > ~/.pi/config/pi-agent-browser-native/config.json <<'JSON'
{
  "version": 1,
  "webSearch": {
    "enabled": true,
    "preferredProvider": "exa",
    "defaultSearchType": "deep-lite",
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

For Exa, the effective mode is the per-call `searchType`, then `webSearch.defaultSearchType`, then `auto`. A research-heavy coding workflow should set the config default to `deep-lite`; callers can still override it per search. Users who do not opt in keep the existing `auto` latency.

| Exa `searchType` | Typical latency | Use |
| --- | --- | --- |
| `instant` | ~250 ms | Trivial lookups only |
| `fast` | ~450 ms | Low-latency relevance |
| `auto` | ~1 s | Everyday fact lookup |
| `deep-lite` | ~4 s | Preferred research-before-implementation mode |
| `deep` | 4–15 s | Hard multi-source research and comparisons |
| `deep-reasoning` | 12–40 s | Exhaustive or hardest multi-hop research only |

```json
{
  "query": "pi-agent-browser-native agent_browser_web_search searchType defaults",
  "searchType": "deep-lite",
  "count": 5
}
```

Exa calls may also use up to 20 `includeDomains` or `excludeDomains`, a typed `category`, up to 10 deep-mode `additionalQueries`, and the `highlightsDynamic` research preview. `company` and `people` categories cannot combine with `freshness` or `excludeDomains`. These explicit Exa-only options fail clearly when Brave is selected; the existing `searchType` field remains ignored by Brave. Regular `contents.highlights: true` stays the default, and structured output schemas remain out of scope.

Every Exa request asks the provider to prefer primary official sources, honor requested versions/dates, and avoid equivalent results. After provider normalization, both adapters remove later results with the same exact normalized URL while preserving first-result order; they do not guess that distinct paths or query URLs are aliases and do not overfetch to replace removed rows. `details.duplicatesRemoved` reports any shrinkage. Exa `publishedDate` and Brave `page_age` appear as `pageDate`; Brave can also return a separate result `age`. These are provider-supplied page clues, not crawl age or proof of a version match. For version-sensitive work, inspect those clues, constrain one follow-up to the primary domain (`includeDomains` for Exa or `site:` in a Brave query), then read the primary page.

The same config file can record conservative browser defaults such as a profile hint or a Chromium-compatible executable path:

```bash
# Ask the agent to use this profile for signed-in/account-specific work.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile set "Profile 1" --policy authenticated-only

# Ask the agent to launch a different Chromium-compatible browser executable.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable set "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
```

Profile hints with `authenticated-only` remain advisory. Global/override profile names with `policy: "always"` and executable defaults bootstrap inactive automatic root browsers; active roots and unrelated explicit sessions retain their native settings. Configure profile/executable guidance globally, in trusted project config, or through `PI_AGENT_BROWSER_CONFIG`. Ask the agent to run `agent_browser` with `args: ["profiles"]` and `args: ["doctor"]` when profile resolution fails. The upstream `profiles` command lists Chrome profiles from Chrome's user data directory; `Default` is not canonical on every machine. Use the displayed profile directory name, a full profile/user-data directory path when upstream accepts one, or a configured `browser.executablePath` plus `sessionMode: "fresh"` for a different Chromium-compatible browser.

## Common agent calls

You usually prompt the agent in natural language. These JSON snippets show the exact native tool shape the agent should use.

Open a page and inspect it (first-call recipe: open → snapshot -i → interact with current `@refs` → snapshot -i after changes). Omit `--json` unless you need JSON text; structured details are always available.

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
```

Chromium launch switches belong in the value of `--args`, for example `{ "args": ["--args", "--no-sandbox", "open", "https://example.com"], "sessionMode": "fresh" }` when that switch is needed. A bare `--no-sandbox` in the command slot is an unknown command; in an `open` / `goto` / `navigate` option position, upstream ignores it. The wrapper diagnoses those forms without rejecting literal text, select values or paths in other commands. For batches, put `--args` in top-level `args` before `batch`, not inside a row.

Local Chrome startup uses the stock binary's `--args --no-startup-window` capability to suppress Chrome's extra startup window. Headless remains the default. Caller launch arguments keep native CLI → environment → config precedence and follow this default; browsers started before this change with custom arguments may restart once when their native launch configuration changes. Ordinary follow-ups do not resend bootstrap settings. CDP, providers, Electron, and Lightpanda remain native-owned; no tabs are deleted or profiles edited by this behavior.

`open` without a URL uses native `get url`: it launches when needed and otherwise preserves the current page. This also applies to effective batch rows and code calls. `details.args` preserves the request, while `effectiveArgs`, command, URL data, and lifecycle describe the actual native operation. Use `open about:blank` only when you intend to navigate there. Help/version requests remain unchanged.

Watch a browser window during a demo, QA run, or user-completed login by adding upstream's global `--headed` flag on the first launch. Use `sessionMode: "fresh"` if a managed session may already exist, because headed/headless state is launch-scoped. A successful first/fresh local wrapper-managed headed launch, including a launch inside `batch`, returns `details.browserWindow = { mode: "headed", ownership: "wrapper-managed", sessionName, visibility: "unverified" }` and one visible handoff sentence; CDP, auto-connect, provider, and Electron attachments do not. This proves that the wrapper requested and upstream launched headed mode, not that the OS window is visible on the user's display; remote, container, or virtual-display setups can still hide it. After the user finishes in the window, continue with `sessionMode: "auto"`.

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

`--webgpu` is also available as `AGENT_BROWSER_WEBGPU`; `--webgpu false` overrides an enabled environment default. Standalone upstream also supports `"webgpu": true` in `agent-browser.json`; native calls preserve upstream config. It cannot be combined while enabled with `--cdp`, `--auto-connect`, or provider launches. Run `{ "args": ["doctor", "--webgpu"] }` to pixel-check rendering and capture. macOS supports headless WebGPU screenshots; upstream requires a logged-in headed desktop on Windows and `--headed` plus Vulkan loader/Mesa packages on Linux (automatic Xvfb unless `AGENT_BROWSER_NO_XVFB=1`).

On `agent-browser 0.35.0`, trust a private interception-proxy CA for locally launched Linux Chromium with a fresh, restore-disabled session:

```json
{ "args": ["--proxy", "http://proxy.example:8080", "--ca-cert", "/path/to/proxy-ca.pem", "open", "https://example.com"], "sessionMode": "fresh" }
```

`--ca-cert <path>` also has `AGENT_BROWSER_CA_CERT`; `--no-ca-cert` / `AGENT_BROWSER_CLEAR_CA_CERT` clears retained trust. Upstream accepts PEM bundles or DER certificates, uses an isolated NSS store, preserves normal hostname/validity checks, and requires Linux Chromium plus `certutil`. It rejects profiles, CDP/auto-connect, providers, Lightpanda, `--ignore-https-errors`, and non-Linux hosts. Because a trusted interception CA can observe authenticated traffic, this wrapper disables automatic managed restore for CA-enabled sessions.

Restrict browser and `read` traffic with upstream's domain containment on a fresh local Chrome context:

```json
{ "args": ["--allowed-domains", "example.com,*.example.org", "open", "https://example.com"], "sessionMode": "fresh" }
```

In `agent-browser 0.32.0`, the allowlist also covers workers and popups and disables Chromium `RTCPeerConnection` while active. Upstream owns containment and rejects incompatible CDP/auto-connect, profile, restore/state, provider, iOS/Safari, and startup-argument combinations; the wrapper passes the setting and upstream result through unchanged.

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

Use exact `batch --bail` when a later content step assumes an earlier navigation succeeded. Without fail-fast behavior, a failed navigation can leave an unverified prior page active; the wrapper rejects that shape before the content step. Non-bail continuation remains available when every possible retained target is verified. Splitting navigation and content into separate calls is the other safe option.

If the same `batch` stdin later uses `@e…` on interaction commands after a step that can navigate or mutate the page (`open`, non-form `click`, `reload`, and similar), insert a `snapshot` step whose first argv token is `snapshot` (for example `["snapshot","-i"]`) between those phases. Multiple same-snapshot `fill @e…` steps and native form-control steps (`check`/`uncheck` on checkbox or radio refs, checkbox/radio `click`/`tap` refs, and `select` on combobox refs) may be batched before a final click/submit step. Dynamic or autosubmit forms should still use stable locators or split with a fresh snapshot. The wrapper rejects unsafe ordering with `failureCategory: "stale-ref"` before upstream runs; full rules are under `refSnapshot` in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).

Read documentation or other unstructured text without requiring a Chrome page, or omit the URL to read the rendered DOM of the current tab:

```json
{ "args": ["read", "https://example.com/docs", "--filter", "authentication"] }
{ "args": ["read"] }
```

Explicit URL reads prefer `text/markdown`, then try a `.md` path and nearby `llms.txt` links before falling back to readable HTML text. Use `--outline`, `--llms index|full`, `--require-md`, `--raw`, or `--timeout <ms>` when needed. Explicit reads, including all-read batches, do not allocate or replace a managed browser, require a known page, or run browser helpers before, after, or following a timeout. Native config and argv pass through unchanged; the native HTTP reader owns fetching. A visible `Read execution` line reports the source, CLI start and native launch evidence without treating an HTTP read as proof of shared-browser liveness. Bare `read` still uses and verifies the current DOM. The native no-browser-effects path requires the companion upstream fix; older supported binaries do not guarantee it merely because this wrapper skips helpers. It renders upstream `data.content` first, preserves metadata in `details.data`, keeps fetched URLs from replacing the active browser tab target, and budgets explicit long read timeouts across upstream's `.md` and ancestor-`llms.txt` request fallbacks.

Use `session info` to inspect browser status. A timeout proves no liveness and returns only `retry-session-info` for that same session/namespace; it does not run page probes or change existing page/ref state.

Evaluate page JavaScript through stdin. Put the script in the top-level `stdin` field, not as an extra `args` token after `--stdin`. Return the value you want as an expression; `eval --stdin` may warn with `details.evalStdinHint` when a function-shaped snippet serializes to `{}` instead of being invoked:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
{ "args": ["eval", "--stdin"], "stdin": "({ title: document.title, url: location.href })" }
{ "args": ["eval", "--stdin"], "stdin": "({ title: document.title, url: location.href })", "outputPath": "logs/page-state.json" }
```

Use `outputPath` when `eval`, `get`, `snapshot`, or another extraction should be saved as a durable workspace file. Recording results also export on failure or timeout: their JSON envelope retains the failed attempt, native receipt, verification and any recovery evidence rather than writing misleading bare success data. Keep it distinct from screenshot, download, recording, and other browser artifact destinations; preflight rejects known same-call aliases before browser activity, and the result writer preserves the browser artifact if an alias becomes apparent only afterward. The wrapper writes `details.data` when present, otherwise the model-facing text content. When presentation compacted a large direct result, a result row, or the whole `batch`, it instead reads the full command-redacted pre-compaction payload only from the corresponding live wrapper-managed spill recorded in `details.artifactManifest`; if any required spill is unavailable or untrusted, the call fails without writing compact metadata to the requested path. `details.outputFile` reports the saved path and byte count. Explicit upstream `--json` content stays parseable, including early snapshot/network filters, scroll results, and preparation failures; metadata stays in `details` and the save notice lives only in `details.outputFile`. Help/version output remains native text.

Recording receipts separate captured-frame rate and wall-clock capture duration from nominal/output FPS. `details.artifacts[].recording` includes native capture timestamps, received frame counts (not pixel-unique frames), encoded/written/held/dropped/skipped counts, and output duration. Missing native metrics stay unknown. Repeated, static, sparse or final-state-only frames cannot establish UI smoothness.

```json
{ "args": ["record", "stop"], "outputPath": "logs/record-stop.json" }
```

A timed-out stop or `No recording in progress` response gets one bounded native `session info` query. Only a matching terminal native receipt, successful encoder measurements and a verified file can recover success; file presence alone cannot. The original attempt remains visible. A receipt can verify the recording from a timed-out batch without proving its other steps succeeded. Follow the exact status/stop actions returned, not blind retries or longer timeouts. See [recording receipts](docs/TOOL_CONTRACT.md#recording-receipts-and-recovery) for fields and native availability.

Extract several known refs or selectors in one `batch` call instead of many serial getter calls. When a prior snapshot and session are available and the same-page freshness checks apply, ref-consuming calls add one extra `snapshot -i` preflight per top-level call or batch. Batching shares that probe across rows; it does not remove it:

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

### Persistent browser code

Use `agent_browser_code` for loops, branching, or aggregation. Each call gets fresh JavaScript variables and the same browser selected by ordinary `agent_browser` calls. Cookies, open tabs, and authenticated browser state persist according to native session/profile settings; finishing a code call does not close the browser.

```json
{
  "code": "const titles = []; for (const url of ['https://example.com', 'https://example.org']) { const opened = await browser({ args: ['open', url] }); if (!opened.success) throw new Error(opened.error); const title = await browser({ args: ['get', 'title'] }); if (!title.success) throw new Error(title.error); titles.push({ url, title: title.data.title ?? title.data.result }); } emit(titles);"
}
```

`await browser({ args, stdin?, timeoutMs? })` returns the canonical observation: `success`, `data`, error/category information, exact `nextActions`, and artifact/image evidence when available. Emit the selected JSON the model needs instead of entire observations. `emitImage(observation.imageObservations[0])` selects a verified image from this code call for actual image attachment; emitting a path as JSON does not attach it. Stop at observations that need model judgment rather than guessing the next action in code.

```json
{
  "code": "const shot = await browser({ args: ['screenshot', '/tmp/current-page.png'] }); if (!shot.success) throw new Error(shot.error); emit(shot.artifactVerification); if (shot.imageObservations?.length) emitImage(shot.imageObservations[0]);"
}
```

Optional `session` and `namespace` select one native identity for the whole code call; omitted fields follow normal browser defaults. Inner native commands can use batch, auth, profiles, state, connect, and close, but cannot change that identity or issue namespace-wide `close --all`. Use the direct tool for those operations. Parent-side native commands keep normal auth/config/environment behavior. The fresh permissioned Node child exposes no host filesystem, network, process APIs, imports, timers, or dynamic code generation.

Limits: 25 attempted browser calls; 64 KiB source and emitted JSON; 1 MiB per IPC message and 8 MiB cumulative IPC; 120 seconds by default, 300 seconds maximum. Inner calls are serial, even with `Promise.all`. Selected images are limited to eight and 20 MiB total, with the normal configurable inline limit (5 MiB per image by default). See the [code contract](docs/TOOL_CONTRACT.md#agent_browser_code) for failure, cancellation, and image rules.

A handled browser failure remains visible in `failures` and `codeRun.failedCallCount`; successful source completion is not proof that every inner command succeeded. Rejected inner input shapes, source exceptions, cancellation, or deadline failure fail the code result. Uncertain mutations must be inspected before retry. Ordered Pi transition entries preserve inner page/ref/attachment/close state through resume; an interrupted intent remains unknown until inspection. A persisted Pi session is required.

### Advanced browser tools

List specialized capabilities with `agent_browser_tools {}`. Enable only what the task needs:

```json
{ "enable": ["action", "qa", "electron", "source", "network"] }
```

Activation adds tools without removing other active tools; Pi owns the selected-tool history. Omit CLI `--tools` for normal lazy activation, or include each desired advanced tool in that explicit selection. The loader cannot enable tools excluded by the host. Each specialized tool takes **flat fields**, not a nested object on `agent_browser`:

| Tool | Example input | Preserved capability |
| --- | --- | --- |
| `agent_browser_action` | `{ "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" }` | Stable locators, direct selectors/refs, and unique accessible native dropdown selection |
| `agent_browser_qa` | `{ "url": "https://example.com", "expectedText": "Example Domain" }` | Visible assertions, scoped diagnostics, actionable/benign error classification, and a real pass/fail verdict |
| `agent_browser_electron` | `{ "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" }` | Host discovery, isolated app launch, CDP readiness, status/probe, and owned cleanup |
| `agent_browser_source` | `{ "selector": "#save", "componentName": "SaveButton" }` | Experimental DOM/React and bounded local workspace candidates |
| `agent_browser_network_source` | `{ "requestId": "req-1", "url": "/api/fail" }` | Experimental failed-request/initiator/local-source correlation |

Use `agent_browser_action` with `action: "select"` for a native dropdown: a direct `selector` plus `value`/`values`, or an exact role/name or label locator resolved to one visible combobox/listbox. For framework-controlled rich inputs, inspect returned recovery actions, focus a current ref, then use native `keyboard type`; verify application state before submitting.

QA defaults to `domcontentloaded`. URL QA clears enabled network/console buffers and checks page-error residue before opening the URL. Matched residue makes that check unverified and non-pass; it is not proof of a new application error. Attached QA (`{ "attached": true }`) preserves existing buffers and defaults diagnostics off; opt into `checkNetwork`, `checkConsole`, or `checkErrors` deliberately. Native diagnostic-read success alone is not a QA verdict.

Electron launch uses a new temporary app profile and does not inherit the normal app's signed-in state. Use `agent_browser_electron` to list, launch, probe/status, then clean up its returned `launchId`. A manually launched debug-enabled app uses native `connect` and stays host-owned. Read [the Electron guide](docs/ELECTRON.md) for lifecycle and timeout details.

Source tools report candidates, never authoritative blame or automatic edits. Workspace scans default to 2,000 source files, cap at 5,000, and return at most ten workspace matches. They remain available even when unrelated Pi file tools are disabled; packaged app bundles are not unpacked.

### Fixed sequences and evidence

Use native `batch --bail` for known sequences. Add an explicit destination/text wait after a navigation-prone click; successful dispatch is not proof the application changed. Split when fresh refs or model judgment are needed.

```json
{
  "args": ["batch", "--bail"],
  "stdin": "[[\"open\",\"https://shop.example/checkout\"],[\"fill\",\"#email\",\"user@example.com\"],[\"click\",\"#continue\"],[\"wait\",\"--url\",\"**/shipping\"],[\"wait\",\"--text\",\"Shipping address\"],[\"screenshot\",\"/tmp/shipping.png\"]]"
}
```

Use the exact returned recovery payload after errors. Timeout partial progress distinguishes observed results from planned or unknown steps; it never proves an unobserved mutation did not run. For paced typing, native batch can interleave `keyboard type` characters and positional `wait <ms>` rows; see [the migration map](docs/TOOL_CONTRACT.md#07-migration). Do not assume a native `--delay` option reproduces the removed job behavior.

Both JSON and prose results expose a bounded canonical observation with recovery actions and artifact receipts. Oversized observations name an `observationPath` for the complete redacted result; audit-only `details` is not the model's sole recovery channel. Inner code calls avoid full model rendering, spills, and image encoding until output is selected.

Screenshots expose measured image dimensions and capture geometry when supported by matching before/after samples. A full-page or element image is not a viewport screenshot. Native mouse coordinates are viewport CSS pixels; use the [geometry contract](docs/TOOL_CONTRACT.md#image-observations) and current scroll/frame state before converting image pixels. Unknown geometry stays unknown, including ambiguous or scrolled element captures and unmeasured batch captures. Pi image-resize notes only map sent pixels to original image pixels.

Save artifacts to the user's exact paths and check `artifactVerification` before claiming they exist or are fresh. Conditional `changed: false` screenshots produce no new attachment. `outputPath` is a separate result-data destination and must not alias a screenshot, download, or recording. Close ends the browser session; explicit files remain host-owned. Recording starts remain pending until stop and receipt/file verification.

### Upgrading from 0.6

Version 0.7 replaces top-level `script`/`job` and nested advanced input modes. Move script bodies to `agent_browser_code.code`, replace `.ok` with `.success`, and account for the now-persistent browser. Move fixed jobs to native batch; enable and call the flat advanced tools above. There is no parallel legacy public execution route. See [the complete migration map](docs/TOOL_CONTRACT.md#07-migration) and [package rollback](docs/RELEASE.md#07-upgrade-and-rollback).

Restart every participating Pi process onto the same updated package before relying on cross-process coordination. Package rollback means reinstalling the previously used 0.6 release and restarting those processes, preserving saved authentication, artifacts, and Pi transcripts; it does not undo browser actions.

### Working-directory changes

With `pi-change-working-dir`, each browser call captures the selected execution directory once. New relative screenshots, downloads, recordings, file inputs, `outputPath`, and source/network-source scans use that directory, including queued batches and code calls. Absolute paths remain unchanged. Existing browsers, tabs, profiles, restore identities, pending recording destinations, cached artifacts, and Pi package config/trust remain anchored to their original owners.

Ordinary native config discovery stays at the project or current managed browser's launch directory. `--session` selects a target for that call; it does not switch the config root. An unnamed `sessionMode: "fresh"` launch and explicit `--config` / `AGENT_BROWSER_CONFIG` resolve from the selected execution directory, preserving native session precedence. Managed fresh launches retain their launch directory across follow-ups and resume. If the old launch directory is deleted, ordinary browser calls stop with recovery guidance instead of selecting another project's config; restore it or explicitly choose fresh/config from the new directory. Shell/file operations can continue independently. Older directory extensions must be updated and Pi restarted; without a directory extension, native Pi cwd remains the default.

## Authenticated/profile workflows

### Shared browser defaults

Ordinary browser calls use one native named browser per **root Pi session**. A parent and its subagents share that browser; unrelated roots get different names and can browse concurrently. `pi-subagents` supplies `PI_SUBAGENT_ROOT_SESSION_ID` through its existing launch records, including detached runs, delegated forks, grandchildren, and revived children. Ordinary Pi new/fork/clone sessions get their own root identity; resuming the same root or changing its cwd keeps its browser name.

Cooperating updated Pi processes share a cross-process lock keyed by the actual socket context, canonical namespace, and session. It covers a direct call's helpers and action, or an entire code call; different identities can run independently. Coordinate navigation across separate tool calls with existing subagent/intercom tools. This is ordering, not rollback or protection against human navigation, external CLI clients, or older extension versions. Parent or child exit does not close the group browser. Native idle policy applies; explicitly close only your group's browser when the group is finished.

To bootstrap new root browsers from an authenticated normal Chrome profile, set the existing **Pi package** config in `~/.pi/config/pi-agent-browser-native/config.json`:

```json
{
  "browser": {
    "defaultProfile": { "name": "Default", "policy": "always" },
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  }
}
```

For inactive automatic roots, global/override `always` profile **names** and the configured executable bootstrap native launch through a scoped subprocess environment shared with helpers. Active roots retain native launch settings instead of resending defaults that could replace an explicitly profiled browser; their existing restore key is preserved, including follow-ups naming the same root browser. Native Chrome profile names use independent temporary copies, not the source profile's lock. Profile paths and other profile policies remain advisory; project guidance does not change a root's launch settings when a child changes cwd. Explicit unrelated sessions and Electron launches do not receive root bootstrap defaults. Code calls selecting the ordinary root browser use its normal configuration and authenticated state. Do not set a global native profile merely to enable this feature: it can change the launch configuration of existing unrelated browsers.

Each automatic root has its own stable native restore key. Native save/restore preserves cookies, localStorage, and sessionStorage across normal close/restart; it does not merge auth between roots or save new IndexedDB-only credentials, service workers, or page-memory grants. Named profile copies can bootstrap existing IndexedDB, but are discarded on close and never write back to the communal profile. Verify the actual application after restart, not just a successful restore receipt. If an application needs unsupported state, use a supported persistent **per-root** profile and collect required sign-ins together; never point concurrent roots at one writable profile directory. Sites can expire sessions or require a fresh human challenge.

Explicit native `session` defaults (config or `AGENT_BROWSER_SESSION`) still override automatic root selection, including `sessionMode: "fresh"`. They intentionally share whichever browser the caller selected. Per-call session/namespace flags retain precedence. Ordinary launch options such as `--profile` or `--executable-path` still use the root-group name. Repeat explicit options when deliberately relaunching a persistent per-root profile after close. Explicit `fresh` and attachment choices retain their existing managed-session lifecycle; later auto calls follow that selected managed session. Use `session info` with the reported `sessionName` for read-only native daemon/browser evidence. Unknown native fields remain unknown.

Policy-required URL reads keep the two-call read → confirm/deny flow. Returned actions name the actual native namespace/session, including `default`; routing survives transcript resume and branch changes. Only explicit-read provenance plus native `capabilities.readRequiresConfirmation: true` permits matching confirm/deny without page helpers. This capability includes native confirmation-ID checking. Legacy prompts retain correct routing but normal page checks; DOM or content-shaped prompts never receive the exemption.

Full live identity, browser-independent native reads/confirmations and detailed recording receipts require the companion upstream fixes; the current recommended release does not yet supply all of them. Older supported versions remain accepted with unavailable evidence marked unknown. The extension does not upgrade or restart your installed browser to obtain these fields.

### Native working-session checkpoints

On Pi hosts with `session_checkpoint`, an unused or cleanly closed browser integration can qualify for sleep. Live browsers, attachments, active code calls, unfinished recordings/legacy cleanup leases, and dirty recording persistence keep compute alive. Pi core owns native journal flush/repair and strict restore; an ongoing journal I/O failure rejects checkpoint acquisition. Checkpointing never closes browsers or changes cleanup ownership. Native save-on-close and per-root restore remain the persistence path; page JavaScript, unsaved forms, and live recordings are not serialized. See [checkpoint boundaries](docs/ARCHITECTURE.md#native-checkpoint-boundary).

### Profile selection

The wrapper does not clone profiles or hide what upstream Chrome/Chromium profile or executable you chose. Passing `--profile` or `--executable-path` is an explicit upstream `agent-browser` choice. Visible page content from real profiles is model-visible and may persist in transcripts or saved artifacts; redaction protects credential-like cookie/storage/auth values, not ordinary page text you asked the browser to read. Redactions use `[REDACTED]` (URL-encoded in parsed URLs); ordinary technical phrases such as `bearer token` stay intact. URL redaction includes `code`, `authorization_session_id`, and auth-context `state` / `nonce` across visible text, details, spills, and `outputPath` exports. URLs needing no redaction keep their original spelling.

Use these rules:

- Use public/temp profiles for tests and examples.
- Do not assume `--profile Default` is correct. Ask the agent to run `profiles` to list Chrome profile directory names, then `doctor` if profile/user-data-dir resolution still fails. On macOS, a copied Chrome profile may omit Keychain-encrypted cookies, so profile selection is not proof that the target page is authenticated; verify the page and use a user-approved headed login once when needed.
- For non-Chrome Chromium browsers such as Brave, Edge, Arc, or Vivaldi, use `--executable-path <path>` when upstream can launch that executable. If you need that browser's existing login state, use the browser's real profile/user-data directory path when upstream accepts it, or attach with `--auto-connect` / `connect` to a debug-enabled running browser when appropriate.
- Use `sessionMode: "fresh"` when switching from public browsing to `--allowed-domains`, `--profile`, `--executable-path`, `--webgpu`, `--restore`, `--restore-save`, restore check flags, `--namespace`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device`.
- Use `--session` when you want to manage a live upstream session name yourself. For CDP, connect once, verify with `get url`, keep using that session without repeating `--cdp`, and close it explicitly when done. The wrapper preserves the established attachment across follow-ups instead of resending local-launch defaults, and live-checks the URL before later page reads or interactions because an attached browser can change tabs outside Pi.
- Do not treat an arbitrary `--session` name alone as persisted auth after `close`, `quit`, or `exit`. Wrapper-owned implicit sessions automatically use a Pi-transcript- and Git-checkout-generation-scoped `AGENT_BROWSER_RESTORE` key so cookies and web storage can survive relaunch, reload, and `/resume`; disable that convenience with `PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE=0`. Caller-selected sessions, restore/state paths, profiles, upstream config, file access, launch arguments, environment variables, and close arguments pass through unchanged. `session list` and `state list` keep all upstream rows and restore identifiers visible. The wrapper does not reserve `piab-*` names or reject cross-checkout/local paths. Automatic restore still validates its own checkout/storage identity and coordinates same-daemon reuse so it cannot mix the wrapper's restore pools.
- Caller-owned explicit sessions are live-checked with `get url` before content-bearing reads or interactions. Missing or stale transcript page state is not treated as proof of a target; if the live URL cannot be verified, the requested content command does not run. Calls to the same actual socket context and effective canonical namespace/session are serialized across cooperating updated Pi processes; explicit namespace argv overrides `AGENT_BROWSER_NAMESPACE`, including an explicit empty default from that probe through any semantic-action snapshot and the requested command, while different caller-owned sessions remain independent. Raw non-bail batches are rejected when a failed navigation could leave an unverified target before later content; use exact `batch --bail` or split navigation from content. Nested `batch` steps are rejected, and raw batch command strings mirror upstream's ASCII-space tokenizer, including its single/double-quote and backslash handling, without splitting on other Unicode whitespace.
- Prefer page actions and storage checks over cookie dumps. `cookies get` can expose real profile cookies.
- Prefer `auth save --password-stdin` over putting passwords in `args`; the wrapper only accepts caller `stdin` for `batch`, `eval --stdin`, and `auth save --password-stdin` (advanced QA and source tools generate their own batch stdin).
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

### Chrome relay sidecar: drive the user's real Chrome

When the goal is the user's actual signed-in browser rather than a managed
profile, the optional Chrome relay sidecar attaches upstream `connect` to the
user's real, headed Chrome through a `chrome.debugger` extension — no debug
port, no Playwright profile. Start it with
`npx pi-agent-browser-chrome-relay start`, load the unpacked extension from
`npx pi-agent-browser-chrome-relay extension-path` in `chrome://extensions`,
then `{ "args": ["connect", "ws://127.0.0.1:9224/cdp"], "sessionMode": "fresh" }`.
Setup steps, the Windows/WSL2 NAT recipe, and the security model live in
[`docs/CHROME_RELAY.md`](docs/CHROME_RELAY.md).

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

That mode sets `PI_AGENT_BROWSER_REAL_UPSTREAM=1` and runs `test/agent-browser.real-upstream-contract.test.ts` against the real `agent-browser` on `PATH` (the stable version must meet the 0.35.0 floor; current command-reference validation targets the recommended 0.38.1 capability baseline). It covers inspection, skills, experimental WebMCP list/invoke/result/cancel plus `--no-webmcp`, and a broad core interaction and navigation matrix on localhost fixtures (including off-viewport click, frame-scoped selector/wait/click behavior, form command fixes, `batch` stdin, and `pushstate`), plus `vitals`, network route/requests/HAR, diff snapshot/screenshot/url, trace/profiler, console/errors/highlight, stream enable/status/disable, `cookies set --curl`, a `react tree` missing-renderer path, and `wait --download` with the on-disk caveat documented in release notes. The harness uses a throwaway temp `HOME` and dedicated socket/screenshot directories so the run does not touch your normal browser profile paths. Browser-opening or credential-dependent families such as `inspect`, `dashboard`, `chat`, provider clouds, and OS clipboard flows stay in fake-upstream or manual validation unless a safe deterministic fixture is added. For prerequisites, isolation details, and troubleshooting, see [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-contract-validation).

A deterministic host-only live-browser wrapper smoke is available without an LLM choosing tool calls:

```bash
npm run verify -- dogfood
```

That mode clean-builds the package, then drives persistent browser code, advanced QA/actions, native batch, screenshot artifact verification, and session close against a deterministic local fixture. It complements, but does not replace, the interactive Pi/tmux release dogfood in [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks).

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
2. The extension registers compact direct/code tools, an advanced-tool loader with five initially inactive specialized tools, and the optional credential-backed `agent_browser_web_search` companion.
3. Tool calls are translated into upstream `agent-browser` CLI invocations with controlled args, stdin, environment, timeout, and session planning.
4. Upstream JSON/plain-text output is parsed into model-friendly content and structured details.
5. Screenshots, downloads, recordings, traces, profiles, and spill files are normalized as Pi-visible artifacts where possible.
6. Generated playbook text in docs and tool metadata stays aligned with `extensions/agent-browser/lib/playbook.ts`.

The upstream browser engine remains [`agent-browser`](https://agent-browser.dev/). This package does not bundle it. The recommended baseline is 0.38.1 and the stable runtime floor is 0.35.0; newer stable versions are accepted without version-specific compatibility shims.

## Current limits

- Published pre-1.0 package.
- Recommends upstream `agent-browser` 0.38.1 and accepts stable runtimes at or above 0.35.0.
- Does not bundle `agent-browser`; users install it separately.
- Does not provide a human browser UI inside Pi; the primary UX is agent-invoked tool calls. `--headed` asks upstream to show a browser window, but the wrapper cannot yet prove that the window is visible on the user's desktop.
- Localhost means the browser host's loopback, not necessarily the shell/Pi host. If `http://localhost:<port>` or `http://127.0.0.1:<port>` fails with errors such as `ERR_EMPTY_RESPONSE`, use an environment-specific host-reachable HTTP(S) address. A `file://` fixture is supported when upstream browser launch settings allow it; use HTTP(S) only when the browser environment cannot reach the local file.
- A successful upstream `click` is not proof that the app handled the event. For state-changing flows, verify with a fresh snapshot, text/URL assertion, screenshot, or `pageChangeSummary` before reporting success.
- Real authenticated profile use is powerful but sensitive. Treat profile and cookie access as user-approved, task-specific behavior.
- Wrapper tab/session recovery is best effort around observed upstream behavior, not a replacement for explicit profile/session design.

## Local development

Install upstream `agent-browser`, then install dependencies:

```bash
npm install
```

Use the npm version declared in `package.json` `packageManager` when refreshing `package-lock.json` (for example `npx -y npm@11.14.0 install`) so optional-platform lockfile metadata does not drift. Use Pi 0.87.0 or newer for lifecycle and interactive browser smokes; the pinned Pi devDependencies are validation fixtures, not an exact-version requirement for the host CLI. See [Environment and automation pitfalls](docs/RELEASE.md#environment-and-automation-pitfalls) in `docs/RELEASE.md`.

Checkout-only extension smoke test:

```bash
pi --approve --no-extensions -e .
```

This selects the checkout extension and disables automatic extension loading; Pi settings and configured package resolution remain active. Use temporary `HOME` and `PI_CODING_AGENT_DIR` directories for isolated test settings, and `PI_OFFLINE=1` to disable automatic startup network/update operations. `--approve` trusts this checkout's project-local inputs; omit it when testing the Project Trust prompt. After editing extension code, restart Pi to test the new checkout.

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
- After confirmed shutdown of an automatically restored managed session, the wrapper retains its complete recorded URL, including the fragment, until the first current-page operation (including get url and reload). Non-page calls such as tab list may start a daemon without fulfilling that reopen; explicit URL reads leave the managed browser and pending reopen untouched. The wrapper uses native open once, verifies the observed tab, and discards old refs/frame scope; it does not restore unsaved forms, JavaScript memory, or history. Explicit navigation, caller-owned/attached sessions, and restore-disabled sessions are not auto-reopened.
- For a still-live browser after tab drift or resume, the wrapper verifies/selects the intended tab before ref/semantic helpers and page commands; failed selection stops the call without navigating. Local commands, read <url>, URL a11y/vitals, diff url, window new, and explicit tab/navigation/connection/state recovery do not require the prior tab. Batch checks follow effective rows past non-page prefixes and stop at explicit context changes, preserving caller argv/stdin and continue-on-error behavior. Same-tab reselection is avoided because it clears refs. Use exact batch --bail for fail-fast, not --bail=<value>. Routine same-session calls skip tab-list preflights.
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
| `scripts/agent-browser-target.mjs` | Canonical recommended target and minimum supported stable version shared by runtime and build-time checks |
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
