# pi-agent-browser-native

A Pi extension that lets coding agents drive real browser sessions with a native `agent_browser` tool instead of brittle shell commands.

It is for Pi users who want agents to browse sites, inspect pages, click through flows, capture screenshots, use persistent profiles, and handle authenticated web apps without spending context on `agent-browser` CLI ceremony.

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
| Agents build fragile shell commands | Exposes `agent_browser` with exact `args`, an optional `semanticAction` shorthand for common `find` flows and native `select`, constrained `job` / `qa` presets, experimental `sourceLookup` / `networkSourceLookup` that compile short workflows to `batch`, top-level `electron` for desktop lifecycle, plus controlled `stdin` and `sessionMode` | `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/input-modes/`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) |
| Page snapshots are too large | Shows compact, main-content-first summaries, surfaces an `Omitted high-value controls` section (plus `details.data.highValueControlRefIds`) when dense pages or desktop host screens hide editables, named surfaces/tabs, primary action buttons, and high-signal named links such as repository results from the trimmed ref lists, supports wrapper-side `snapshot -i --search <text>` / `--filter role=<role>` to trim dense pages while preserving full `details.refSnapshot`, and stores full raw output in spill files when needed | `extensions/agent-browser/lib/results/snapshot.ts`, `extensions/agent-browser/lib/orchestration/browser-run/prepare.ts`, `test/agent-browser.presentation.test.ts`, `test/agent-browser.extension-validation.test.ts` |
| Screenshots/downloads get lost in text | Normalizes artifact paths, creates missing parent directories, saves simple loopback anchor downloads to the requested path when possible, and reports existence, size, cwd, session, and repair status | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#download-screenshot-and-pdf-files) |
| Profile restores and tab drift confuse agents | Tracks managed sessions, re-selects target tabs after observed drift, rehydrates branch-backed session state on Pi session-tree changes, and pins later commands only for sessions with drift/restored-session risk | generated tab-recovery notes below; `test/agent-browser.extension-tab-recovery.test.ts` (drift and about:blank recovery), `test/agent-browser.resume-state.test.ts` (persisted session / resume planning), `test/agent-browser.extension-ref-guards.test.ts` (session_tree rehydration) |
| Auth/profile workflows can leak secrets | Supports `auth save --password-stdin` and redacts sensitive args, URLs, stdout/stderr, details, and parse-failure spills | `test/agent-browser.extension-security-redaction.test.ts` |
| Stateful cookies/storage/auth output bloats or leaks context | Presentation layer redacts `details.data` for cookies and credential-like storage values while keeping low-risk local QA values such as `theme: dark` readable; recursively scrubs other structured upstream JSON (network, diff, trace/profiler, stream, dashboard, chat, auth, dialog, frame, state, and similar) using sensitive key names plus string heuristics; masks sensitive argv flags and positionals; scrubs secrets from failed batch step errors; and exposes a compact redacted `batch` matrix on top-level `details.data` | `extensions/agent-browser/lib/results/presentation.ts`, `extensions/agent-browser/lib/results/presentation/diagnostics.ts`, `extensions/agent-browser/lib/runtime.ts`, `test/agent-browser.presentation-diagnostics.test.ts` |
| Stale `@eN` refs fail mysteriously | Records per-session `details.refSnapshot`, rejects mismatched URLs / unknown refs / unsafe `batch` stdin ordering before spawn, adds recovery guidance to rerun `snapshot -i` or use stable `find` locators | `extensions/agent-browser/index.ts`, `extensions/agent-browser/lib/session-page-state.ts`, `test/agent-browser.session-page-state.test.ts`, `test/agent-browser.results.test.ts`, `test/agent-browser.extension-ref-guards.test.ts`, `test/agent-browser.extension-semantic-recovery.test.ts` |
| Agents need stable success/failure buckets | Exposes bounded `resultCategory`, `successCategory`, and `failureCategory` on tool `details` for branching without parsing prose; a `tool_result` hook also aligns real Pi `isError` semantics, naming `Pi tool isError: true` in prose output while preserving parseable caller-requested `--json` output | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/results/categories.ts`, `extensions/agent-browser/lib/results/shared.ts` (re-export barrel), `extensions/agent-browser/index.ts`, `test/agent-browser.results.test.ts`, `test/agent-browser.extension-validation.test.ts`, `test/agent-browser.pi-pipeline.test.ts` |
| Clicks can report success without the page receiving the event | Top-level non-Electron `click` on exact CSS/XPath selectors, and on `@e…` refs when the latest snapshot has role/name metadata the wrapper can resolve to a unique visible element, installs a bounded DOM-event probe; if upstream reports success but no trusted event reaches the target, the wrapper fails the tool, exposes `details.clickDispatch`, and suggests explicit retry/inspect next actions (no in-page replay), including a nested-scroll `scrollintoview` action when the probe sees the target outside a scroll container or viewport. Other click results still expose `details.pageChangeSummary`, and unchanged-URL clicks can surface evidence-backed `details.overlayBlockers` candidates. | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.ts`, `extensions/agent-browser/lib/results/presentation/navigation.ts`, `test/agent-browser.presentation.test.ts`, `test/agent-browser.extension-click-dispatch.test.ts` |
| Dashboard scroll commands can look successful while nothing moves | Samples viewport and prominent scroll-container positions around top-level `scroll` calls; unchanged positions produce `details.scrollNoop`, visible recovery guidance, and exact `nextActions` for snapshot/screenshot verification | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#core-page-and-element-commands), `test/agent-browser.extension-validation.test.ts` |
| Dropdown/combobox clicks can focus or hit native option box-model errors | Adds first-class `select <selector> <value...>` paths through raw `args`, `semanticAction`, and `job`; for custom combobox clicks, detects focused controls with explicit `aria-expanded` state but no visible options and returns `details.comboboxFocus` plus exact recovery `nextActions` | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#core-page-and-element-commands), `extensions/agent-browser/lib/input-modes/semantic-action.ts`, `test/agent-browser.extension-input-modes.test.ts`, `test/agent-browser.extension-validation.test.ts` |
| Recording workflows fail late when `ffmpeg` is missing | After successful `record start` / `record restart`, warns when `ffmpeg` is not on `PATH` so agents can install or fix PATH before `record stop` | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#diff-debug-and-streaming), `test/agent-browser.extension-validation.test.ts` |
| Direct binary help may be blocked in agent sessions | Publishes a repo-readable command reference and verifies it against the target upstream version | `npm run verify` |
| Desktop Electron apps need discovery, CDP attach, and safe teardown | Top-level `electron` runs host `list` / isolated `launch` (temp profile, OS-chosen debug port) / `status` / `probe` / `cleanup`, merges `launchId` plus managed `sessionName`, supports `handoff` `snapshot` / `tabs` / `connect`, and surfaces mismatch and post-command health guidance; wrapper cleanup applies only to launches it created | `extensions/agent-browser/lib/electron/discovery.ts`, `launch.ts`, `cleanup.ts`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#electron), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#electron-desktop-apps) |
| Agents need bundled `skills` text and local setup/status commands without touching the live session | Treats `skills list`, `skills get …`, `skills path …`, local auth profile management (`auth save/list/show/delete/remove`), `profiles`, `dashboard`, `device list`, `doctor`, `install`, `upgrade`, `session list`, and targeted/all saved-state maintenance (`state clear --all`, `state clear -a`, named clear, or `state clean --older-than <days>`) as sessionless reads/actions: no implicit managed `--session` under default `sessionMode: "auto"` (same session-ownership goal as plain-text `--help` / `--version`), while provider and browser-backed workflows stay thin passthroughs that require upstream setup and credentials | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#built-in-skills), `extensions/agent-browser/lib/command-policy.ts`, `extensions/agent-browser/lib/runtime.ts` |

## Fastest way to try it

Use Pi 0.78.1 or newer when possible. This package does not hard-pin Pi 0.78.1 as a runtime requirement, but the current release is audited and validated against that extension/package baseline.

Install upstream `agent-browser` first and make sure it is on `PATH`:

- https://agent-browser.dev/
- https://github.com/vercel-labs/agent-browser

Optional external tools unlock the full command surface:

| Dependency | Required for | macOS install example |
| --- | --- | --- |
| `agent-browser` | All browser automation through this extension | See upstream install docs |
| `ffmpeg` | `record stop` WebM encoding after `record start` / `record restart` | `brew install ffmpeg` or `brew install ffmpeg-full` |

Keep both binaries on `PATH`. `record start` can begin without a file on disk, but `record stop` needs `ffmpeg` to encode the WebM.

The native tool also gives agents absolute installed-package doc paths in its compact runtime guidance. Raw `args` are the 1:1 upstream CLI coverage path for the targeted `agent-browser` release; typed modes such as `semanticAction`, `job`, `qa`, source lookups, and Electron lifecycle helpers are reliability shorthands layered on top. Agents should read `README.md` for setup/dependencies, `docs/COMMAND_REFERENCE.md` for targeted command workflows, and `docs/TOOL_CONTRACT.md` for result/detail contracts only when deeper guidance is needed.

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
- `pi --version` meets the recommended Pi floor for this release, as a warning rather than a hard failure
- Pi settings do not point at multiple active `pi-agent-browser-native` sources

It does **not** edit Pi settings and does **not** run upstream `agent-browser doctor --fix`.

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

The optional `agent_browser_web_search` companion tool is registered only when a usable Exa or Brave credential source is configured or resolvable. It is not an `agent_browser` input mode and does not launch a browser; agents may use it whenever current/live external web information helps, then use `agent_browser` when they need page interaction, screenshots, authenticated/profile content, or DOM inspection. If both keys are available, the default provider is Exa because its `/search` endpoint returns agent-friendly highlights and search modes; set `webSearch.preferredProvider` to `"brave"` when you prefer Brave Search.

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

# Store a plaintext key in global Pi-scoped user config; output stays redacted.
printf '%s' "$EXA_API_KEY" | npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-key --provider exa --stdin

# Store a global secret-manager command source.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-command "op read 'op://Private/Brave Search/API Key'" --provider brave --global
```

Config merges in this order: global → project → `PI_AGENT_BROWSER_CONFIG` override. `webSearch.enabled` is evaluated after that merge. Use `web-search disable --global` for a user default, `web-search disable --project` for one repo, and a `PI_AGENT_BROWSER_CONFIG` override with `{ "webSearch": { "enabled": false } }` when web search must stay off even if project config exists. Project-local plaintext, custom env aliases, interpolation-literal, malformed, and command-backed web-search keys are refused; project config may only use the matching provider env refs (`$EXA_API_KEY` / `${EXA_API_KEY}` for Exa and `$BRAVE_API_KEY` / `${BRAVE_API_KEY}` for Brave). `web-search set-key`, `set-command`, and `clear` require `--provider`; `set-env` infers Exa/Brave from `EXA_API_KEY` or `BRAVE_API_KEY` unless you pass `--provider`. The tool content, details, status output, and docs examples must not expose resolved keys.

For Exa, the tool defaults to `searchType: "auto"` with `contents.highlights: true`. Agents may pass `searchType` (`fast`, `instant`, `deep-lite`, `deep`, or `deep-reasoning`) only when the task needs that latency/depth tradeoff; structured output schemas are intentionally not exposed yet.

The same config file can record conservative browser defaults such as a profile hint or a Chromium-compatible executable path:

```bash
# Ask the agent to use this profile for signed-in/account-specific work.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile set "Profile 1" --policy authenticated-only

# Ask the agent to launch a different Chromium-compatible browser executable.
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable set "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
```

This adds agent guidance for signed-in/account-specific tasks; current releases do not auto-inject `--profile` or `--executable-path` for every launch. Configure profile/executable guidance globally or through `PI_AGENT_BROWSER_CONFIG`; project-local browser config is not trusted to steer host executable/profile prompt guidance. Ask the agent to run `agent_browser` with `args: ["profiles"]` and `args: ["doctor"]` when profile resolution fails. The upstream `profiles` command lists Chrome profiles from Chrome's user data directory; `Default` is not canonical on every machine. Use the displayed profile directory name, a full profile/user-data directory path when upstream accepts one, or a configured `browser.executablePath` plus `sessionMode: "fresh"` for a different Chromium-compatible browser.

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

On `https://example.com/`, the main link label is **Learn more**—use exact visible text from your snapshot, not guessed copy such as `More information...`.

Click a visible ref, then refresh refs after navigation or a DOM update:

```json
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

Run a multi-step flow in one tool call:

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

If the same `batch` stdin later uses `@e…` on interaction commands after a step that can navigate or mutate the page (`open`, non-form `click`, `reload`, and similar), insert a `snapshot` step whose first argv token is `snapshot` (for example `["snapshot","-i"]`) between those phases. Multiple same-snapshot `fill @e…` steps and native form-control steps (`check`/`uncheck` on checkbox or radio refs and `select` on combobox refs) may be batched before a click/submit step; checkbox/radio `click`s remain conservative unless followed by a fresh snapshot. Dynamic or autosubmit forms should still use stable locators or split with a fresh snapshot. The wrapper rejects unsafe ordering with `failureCategory: "stale-ref"` before upstream runs; full rules are under `refSnapshot` in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).

Evaluate page JavaScript through stdin. Put the script in the top-level `stdin` field, not as an extra `args` token after `--stdin`. Return the value you want as an expression; `eval --stdin` may warn with `details.evalStdinHint` when a function-shaped snippet serializes to `{}` instead of being invoked:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
{ "args": ["eval", "--stdin"], "stdin": "({ title: document.title, url: location.href })" }
```

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

### Locator shorthand (`semanticAction`)

For supported upstream `find` flows and native dropdown selection you can omit hand-built `args` and pass a top-level `semanticAction` object instead. The wrapper compiles locator actions to the same `find` argv upstream already understands, or compiles `action: "select"` to upstream `select <selector> <value...>`; compiled argv is echoed as `details.compiledSemanticAction` when the unified result includes that field. Full field rules live in [`docs/TOOL_CONTRACT.md#semanticaction`](docs/TOOL_CONTRACT.md#semanticaction).

```json
{ "semanticAction": { "action": "click", "locator": "text", "value": "Submit" } }
{ "semanticAction": { "action": "click", "locator": "role", "role": "button", "name": "Continue without Signing In" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "semanticAction": { "action": "select", "selector": "#flavor", "value": "chocolate" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close", "session": "named-browser" } }
```

Typical pitfalls:

- Supply **exactly one** of `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron` per call (not more, not none). Prefer `args` for routine browse; `semanticAction` for stable locators; `job`/`qa` for multi-step checks; `electron` for desktop apps; treat `sourceLookup` / `networkSourceLookup` as experimental candidates-only.
- Do not pass `--json` in `args`; the wrapper injects it automatically.
- `semanticAction` and `job` are **not** valid inside `batch` stdin; batch steps stay upstream argv string arrays (spell a `find` step as tokens there if you need it in a batch).
- Commands or locators outside the supported shorthand still require explicit `args`. Common page getters are grouped under `get`: use `get title`, `get url`, or `get text <selector>` rather than shortcut commands such as `title` or `url`; unknown getter shortcuts can return read-only `details.nextActions` like `use-get-title`.
- For `locator: "role"`, pass either `value: "button"` or `role: "button"`; if both are present they must match.
- Use `semanticAction.session` to target a named upstream browser session; the wrapper prepends `--session <name>` before the compiled `find` or `select` argv and keeps that prefix on retry/candidate actions. In active sessions, role/name click/check/fill shorthands may resolve through the current `snapshot -i` refs before execution so hidden duplicate matches do not steal the action; fill only resolves when the current snapshot has one exact editable ref match. `details.effectiveArgs` shows the exact executed argv.
- Do not reuse `@e…` refs across navigation. The wrapper records the latest snapshot refs per session and fails mutation-prone stale/recycled refs before upstream can silently hit a different current-page element; use the session-aware `refresh-interactive-refs` next action.
- If upstream classifies the failure as `stale-ref` and `details.compiledSemanticAction` is present for a compiled `find` action, `details.nextActions` may list `retry-semantic-action-after-stale-ref` after `refresh-interactive-refs`, carrying the same compiled `find` argv so you can retry the locator-stable target once it is safe to do so. `select` calls that used stale `@refs` only get refresh guidance; use a fresh snapshot or stable selector before retrying (contract in [`docs/TOOL_CONTRACT.md#semanticaction`](docs/TOOL_CONTRACT.md#semanticaction)).
- If the failure is `selector-not-found`, the wrapper may take one fresh snapshot and add `Current snapshot ref fallback` when that snapshot has exact visible role/name matches for the failed `find` / `semanticAction` target. Non-fill targets can include direct `try-current-visible-ref*` next actions, and semantic click misses can still add bounded `Agent-browser candidate fallbacks` such as `button`/`link` role retries for `text` clicks. `semanticAction` does not expose `uncheck` while upstream `find ... uncheck` is not runtime-supported; use raw `args: ["uncheck", <selector-or-ref>]` after a stable selector or fresh snapshot ref. For semantic `fill` misses on desktop or host-controlled rich inputs, prefer `details.richInputRecovery`: refresh refs, choose the current editable `@ref`, focus or click it, then use `keyboard inserttext` or `keyboard type` with the intended text. Direct contenteditable fills are verified with `get text` when snapshot metadata proves the target is contenteditable; if replacement did not happen, `details.fillVerification` warns before any submit step. Those recovery nextActions do not copy the fill text and do not press `Enter` or submit; only submit when the user flow explicitly calls for it (same contract link).
- A successful upstream `click` is not proof that the web app handled the event or changed state. For top-level non-Electron clicks, the wrapper may fail the tool with `details.clickDispatch` and a `Click dispatch diagnostic` line when upstream reported success but no trusted DOM event reached the target; use the suggested `inspect-click-dispatch-miss` / `retry-click-after-dispatch-miss` next actions instead of assuming the click mutated the page; when `details.clickDispatch.scrollContainer` is present, use `scroll-target-into-view-after-dispatch-miss` first. When the task depends on a mutation, follow `inspect-after-mutation` / `pageChangeSummary` evidence with a wait, URL/text check, or fresh snapshot before trusting the result; if the target still did not change, retry with a current visible ref or stable selector and report the workflow issue instead of silently continuing. For static local fixtures where the user only needs to exercise app code, an explicit `eval --stdin` programmatic click such as `document.querySelector("#demo").click()` can be a diagnostic workaround, but treat it as an untrusted scripted activation rather than proof a real user click works, and never use it to bypass user instructions. Respect explicit user stop boundaries yourself: if the user says to stop before order/post/purchase/submit, gather evidence on that page and do not click the final action. The wrapper does not parse broad prompt text into business-intent action blocks; `details.promptGuard` is reserved for concrete artifact-before-close checks.
- A successful `snapshot -i` can surface `Possible overlay blockers` immediately when refs already contain strong dialog/alertdialog evidence plus close/dismiss controls. If a **top-level** `click` succeeds (unified command `click`, not a `batch` step), upstream reports `data.clicked`, and the tab URL is unchanged under the same normalization as ref preflight (fragment-insensitive), the wrapper may take one extra `snapshot -i` and add `Possible overlay blockers` with `details.overlayBlockers` (`candidates`, `summary`, optional `snapshot` refresh for refs) plus session-aware `inspect-overlay-state` / bounded `try-overlay-blocker-candidate-*` next actions when that snapshot shows strong modal context (`dialog` / `alertdialog`) and close/dismiss-like controls. Page-wide words like privacy, sign in, or banner alone do not trigger this diagnostic. The unchanged-URL check uses `details.navigationSummary`, which is populated with one read-only `eval` summary when the click JSON omits **both** string `data.url` and `data.title`; if upstream already includes either, overlay diagnostics are skipped here. Also skipped when tab correction or about-blank recovery already ran on that result.
- If `get text <selector>` reads a non-ref CSS selector with multiple matches or a hidden first match while visible matches exist, including successful `batch` steps, the wrapper may add `Selector text visibility warning`, `details.selectorTextVisibility` (plus `selectorTextVisibilityAll` for multiple batched warnings), and `inspect-visible-text-candidates` next actions; the warning names the matching `details.nextActions` id. Prefer a visible `@ref`, a scoped selector, or a targeted `eval --stdin` over hidden tab content.
- In wrapper-tracked attached Electron sessions, broad selectors such as `body`, `html`, `main`, or `[role=application]` may read the whole app shell. The wrapper may add `Broad Electron get text selector warning`, `details.electronGetTextScopeWarning`, and `snapshot-for-electron-text-scope`; ordinary browser pages, including `file://` fixtures, do not qualify without Electron launch provenance. Prefer `snapshot -i`, a current `@ref`, or a narrower panel selector.

### Constrained browser jobs

For short repeatable workflows, pass a top-level `job` instead of hand-writing `batch` stdin. The wrapper only supports constrained steps (`open`, `click`, `fill`, `select`, `wait`, `assertText`, `assertUrl`, `waitForDownload`, and `screenshot`), compiles them to existing upstream `batch` commands, and echoes the compiled commands as `details.compiledJob` for auditability. `click` and `fill` steps can use either CSS `selector` or semantic locator fields (`locator`, `role`/`value`, optional `name`) so a job can express flows like role/name search without brittle selectors. The same compile path backs top-level `qa`, so long `qa` runs surface the same timeout evidence shape. If a long `job`, `qa`, or `batch` hits the wrapper watchdog, `details.timeoutPartialProgress` may recover planned steps, current page title/URL, and declared artifact paths that already exist on disk (see [`docs/TOOL_CONTRACT.md#details`](docs/TOOL_CONTRACT.md#details)). There is no separate catalog of reusable named browser recipes above `job`, `qa`, and raw `batch`; see [`docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet`](docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet) for the closed `RQ-0068` decision and when to revisit it.

**Navigation inside `job` is explicit.** A successful `click` does not prove the next page loaded; add `assertUrl` and/or `assertText` after navigation-prone clicks (forms, checkout, tabs, submit buttons) before screenshots or steps that assume the new page.

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

Use raw `args`/`stdin` when you need full upstream `batch` power, custom flags, or commands outside the constrained job schema. Do not pass `stdin` with `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron`; those modes generate or manage their own input.

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

`connect` success means the debug endpoint accepted the session, not that an active page is ready. If a snapshot says `No active page`, the wrapper clears prior refs for that session; choose a stable `t<N>` tab and retry a condition wait or fresh `snapshot -i` before using `@e…` refs. Close commands (`close`, `quit`, or `exit`) only close the browser/CDP session; manually launched apps, their profiles, and explicit screenshots/downloads/HARs/traces/recordings remain host-owned.

After either path, use `qa: { "attached": true, ... }` for a current-session smoke check without opening a URL. Attached QA preserves existing network/console/page-error buffers instead of clearing them, so it can catch errors raised before the check started; visible output and `details.compiledQaPreset.checks.diagnosticsResetAtStart` identify that scope. Prefer condition waits (`wait --text`, `wait --url`, `wait --fn`, `wait --load <state>`, `wait --download`), `qa.attached`, `electron.probe` / `electron.status`, `tab list` → `tab t<N>`, fresh snapshots, or screenshots over blind sleeps. Keep fixed waits below the wrapper IPC budget: `wait 30000` is intentionally blocked, and a result like `"waited":"timeout"` only proves elapsed time.

### Lightweight QA preset

For a quick smoke/QA pass, use top-level `qa`. It compiles to the same batch path as `job` and uses `batch --bail` so failed readiness/text/selector assertions stop before slower diagnostics can burn the wrapper watchdog. The URL form clears enabled network/console/page-error buffers before opening the target URL, waits for page readiness, checks optional expected text or selector, inspects fresh network requests, console messages, and page errors when preceding assertions pass, and can capture an evidence screenshot. Expected text is checked with bounded visible-text `wait --fn … --timeout 5000` predicates after the requested load state so dense pages can pass on visible headings/copy and missing text becomes crisp QA evidence. The attached form (`qa: { "attached": true }`) runs checks against the current managed session, such as an attached Electron app, rejects `url`, and deliberately preserves existing diagnostics instead of clearing evidence; its diagnostic reads default off so stale buffers do not fail a current-page smoke unless `checkNetwork`, `checkConsole`, or `checkErrors` is explicitly `true`. `loadState` defaults to `"domcontentloaded"`; set it to `"load"` or `"networkidle"` only when the stricter state is useful and the site is not expected to keep background requests alive. For URL-opening QA, `checkNetwork`, `checkConsole`, and `checkErrors` default to true; set one to `false` to skip that diagnostic read. Network failures are classified by likely impact and failed rows are listed first in network previews: actionable document/script/API-style failures still fail QA, while some low-impact browser icon asset misses (for example certain `favicon` or `apple-touch-icon` paths when upstream marks the row failed and resource metadata looks image-like) surface only as warnings instead of failing an otherwise healthy smoke check (`details.qaPreset.warnings`, with human-readable `details.qaPreset.summary` when the preset still passes). Exact predicates live in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#qa) and `classifyNetworkRequestFailure` in `extensions/agent-browser/lib/results/network.ts` (re-exported from the compatibility barrel).

```json
{
  "qa": {
    "url": "https://example.com",
    "expectedText": "Example Domain",
    "screenshotPath": ".dogfood/qa-example.png"
  }
}
```

Use custom `job` or raw `batch` when you need a different check sequence. `job` defaults to `batch --bail` (`failFast: true`) so later mutating steps do not run after an earlier required step fails; set `failFast: false` only when collecting later diagnostic artifacts is more important than stopping immediately. `qa` always uses fail-fast assertion behavior; omit expected text/selector when you want load-plus-diagnostics only.

### Experimental source lookup

For local app debugging, `sourceLookup` can gather candidate component/file locations for a visible UI element. It is explicit and evidence-based: pass a `selector`, `reactFiberId`, and/or `componentName`; the wrapper compiles those inputs to existing batch steps (`is visible`, `get html` when `includeDomHints` is not `false`, `react inspect`, `react tree`) and a bounded local workspace scan under the Pi session cwd (`maxWorkspaceFiles` defaults to 2000 and cannot exceed 5000; the scan records at most ten `workspace-search` candidates). Results appear in `details.sourceLookup` with `status`, `candidates`, `limitations`, and `summary`. Unlike `qa`, the wrapper does not mark the tool failed on an otherwise successful batch solely because `status` is `no-candidates` or because React metadata was missing; failed upstream steps (for example `react inspect` without DevTools) still fail the batch normally.

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

This is an experiment, not a guarantee. React hints require a session opened with `--enable react-devtools`, and many builds do not expose useful sourcemap/source metadata; `status: "no-candidates"` is common when nothing matched, and `status: "unsupported"` only when no candidates were found **and** a compiled `react` batch step failed (if DOM or workspace search still produced candidates, you get `candidates-found` instead). For wrapper-tracked packaged Electron apps, a no-candidate result includes `details.sourceLookup.workspaceRoot`, optional `details.sourceLookup.electronContext`, limitations explaining that the scan is limited to the Pi cwd and does not unpack app bundles/`app.asar`, plus Electron snapshot/probe/tab next actions when a launch is known.

`networkSourceLookup` is the matching failed-request experiment. It runs `network request <id>` when `requestId` is present and/or `network requests --filter …` when `filter` or `url` is present (`url` supplies the filter pattern when `filter` is omitted); add `session` when the generated batch should target an explicit upstream session. It merges failed-request rows from the batch JSON with initiator-style hints and a bounded workspace literal scan (`maxWorkspaceFiles` defaults to 2000, cap 5000), surfaces everything under `details.networkSourceLookup`, and avoids automatic blame or edits. Compact `network requests` results with safe request IDs also add `details.nextActions` for request details, bounded `networkSourceLookup` on actionable failures, path filtering, diagnostic-buffer clearing before a repro, or HAR capture so agents can branch without guessing request-id syntax. When the wrapper has seen `network route` in the same session, pending fetch/XHR rows or CORS-looking errors that match the route surface `details.networkRouteDiagnostics` plus executable follow-ups to inspect the request or start HAR capture; same-origin/CORS-correct fixture retry guidance stays in prose. Network diagnostics are read-only for wrapper page state: request URLs in `network request` or generated `networkSourceLookup` batches do not replace the session’s active page target or invalidate page-scoped refs from the app page.

```json
{ "networkSourceLookup": { "requestId": "req-1", "url": "/api/fail" } }
```

For asynchronous exports, click first and then wait for the download:

```json
{ "args": ["click", "@export"] }
{ "args": ["wait", "--download", "/tmp/report.csv"] }
```

When a user gives exact artifact paths for screenshots, recordings, downloads, PDFs, traces, or HAR files, use those paths or explicitly report why the artifact was unavailable; do not silently substitute a different path in the final report. The wrapper creates missing parent directories for direct artifact paths such as `state save`, screenshots, PDFs, downloads, and `wait --download`. For simple loopback `download <selector> <path>` anchor links with HTTP(S) `href`, it can save the in-page response directly to the requested path before falling back to upstream click/download behavior; non-loopback/profile downloads stay upstream-owned. With upstream `agent-browser 0.27.1`, treat `details.savedFilePath` as upstream-reported metadata and confirm `details.artifacts[].exists` / `details.artifactVerification.verified` before relying on the requested `wait --download <path>` file being present on disk; non-file download payloads such as `data:` URLs are not verified local artifacts.

For evidence-only screenshots or QA captures, branch on `details.artifactVerification` and `details.artifacts` before reporting PASS/FAIL; inline image attachments are optional when size limits allow—do not require vision review unless the user asked for visual inspection. If the latest prompt names exact required artifact paths, browser close can be blocked with `details.promptGuard` until those artifacts are saved and verified.

Artifact cleanup is host-owned, not a browser command. Close commands (`close`, `quit`, or `exit`) shut down the browser session but do **not** delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings saved to paths you chose. When the session’s non-empty `details.artifactManifest` is in scope, a successful close command appends an `Artifact lifecycle` note and sets `details.artifactCleanup` with the same retention summary as `details.artifactRetentionSummary`, a fixed `note` about host-owned cleanup, and `explicitArtifactPaths`: up to ten distinct paths from manifest rows whose `storageScope` is `explicit-path` (this list can be empty if the recent window only holds spills or other non-explicit inventory). Remove any listed paths with normal file tools after inspection.

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
- Do not assume `--profile Default` is correct. Ask the agent to run `profiles` to list Chrome profile directory names, then `doctor` if profile/user-data-dir resolution still fails.
- For non-Chrome Chromium browsers such as Brave, Edge, Arc, or Vivaldi, use `--executable-path <path>` when upstream can launch that executable. If you need that browser's existing login state, use the browser's real profile/user-data directory path when upstream accepts it, or attach with `--auto-connect` / `connect` to a debug-enabled running browser when appropriate.
- Use `sessionMode: "fresh"` when switching from public browsing to `--profile`, `--executable-path`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device`.
- Use `--session` when you want to manage a live upstream session name yourself.
- Do not treat `--session` as persisted auth or tab restore after `close`, `quit`, or `exit`; use `--profile`, `--session-name`, or `--state` for persistence.
- Prefer page actions and storage checks over cookie dumps. `cookies get` can expose real profile cookies.
- Prefer `auth save --password-stdin` over putting passwords in `args`; the wrapper only accepts caller `stdin` for `batch`, `eval --stdin`, and `auth save --password-stdin` (top-level `job` and `qa` compile to `batch` and supply their own stdin).
- Use `state save <path>` / `state load <path>` for portable test state. `state save` is reported as a file artifact with verification metadata; if an upstream-successful artifact command reports a non-pending file path that the wrapper cannot find on disk, the tool fails with `failureCategory: "artifact-missing"` instead of treating the path as durable. `state load` may mention a path but is not treated as a newly saved artifact.
- Treat `cookies get`, `storage local|session`, and `auth show` output as sensitive. The native presentation summarizes and redacts credential-like values while allowing benign primitive storage values to aid local QA, but avoid requesting broad dumps unless the task needs them.
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
- `tsc --noEmit`
- the test suite
- command-reference baseline checks
- live command-reference verification against the targeted installed upstream `agent-browser`

Step order and which subprocesses run live in [`scripts/project.mjs`](scripts/project.mjs); [`test/project-verify.test.ts`](test/project-verify.test.ts) locks default, `release`, `real-upstream`, `dogfood`, `platform-target`, `platform-smoke`, `package-pi`, and combined-docs orchestration so a gate cannot disappear accidentally. Run `npm run verify -- --help` for opt-in modes and supported passthrough flags.

The deterministic agent-efficiency benchmark’s **standalone JSON/Markdown accounting run** is not part of default `npm run verify` (only `npm run verify -- benchmark` or `npm run benchmark:agent-browser` invokes the script). The full unit suite still exercises `test/agent-browser.efficiency-benchmark.test.ts`. Use the script before and after agent-facing abstractions to prove call-count, output-size, stale-ref, artifact, failure-category coverage, success-rate, and elapsed-time effects before changing the wrapper UX:

```bash
npm run benchmark:agent-browser
npm run verify -- benchmark
```

Save a JSON baseline (for example before changing playbook or wrapper behavior), then compare later runs: `npm run benchmark:agent-browser -- --json > /tmp/agent-browser-benchmark.json` and `npm run benchmark:agent-browser -- --compare /tmp/agent-browser-benchmark.json`.

It does not launch a browser or mutate local profiles; it models representative raw workflows and provides a stable baseline for later comparisons.

The opt-in real-upstream suite is separate because it drives a real browser installation:

```bash
npm run verify -- real-upstream
```

That mode sets `PI_AGENT_BROWSER_REAL_UPSTREAM=1` and runs `test/agent-browser.real-upstream-contract.test.ts` against the real `agent-browser` on `PATH` (version must match the capability baseline). It covers inspection, skills, a broad core interaction and navigation matrix on localhost fixtures (including `batch` stdin and `pushstate`), plus `vitals`, network route/requests/HAR, diff snapshot/screenshot/url, trace/profiler, console/errors/highlight, stream enable/status/disable, `cookies set --curl`, a `react tree` missing-renderer path, and `wait --download` with the on-disk caveat documented in release notes. The harness uses a throwaway temp `HOME` and dedicated socket/screenshot directories so the run does not touch your normal browser profile paths. Browser-opening or credential-dependent families such as `inspect`, `dashboard`, `chat`, provider clouds, and OS clipboard flows stay in fake-upstream or manual validation unless a safe deterministic fixture is added. For prerequisites, isolation details, and troubleshooting, see [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-contract-validation).

A deterministic host-only live-browser wrapper smoke is available without an LLM choosing tool calls:

```bash
npm run verify -- dogfood
```

That mode drives the native wrapper through top-level `qa`, `semanticAction`, constrained `job`, screenshot artifact verification, and session close against a deterministic local fixture. It complements, but does not replace, the interactive Pi/tmux release dogfood in [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks).

Cross-platform release coverage uses Crabbox to run macOS, Ubuntu Linux, and native Windows target suites:

```bash
npm run check:platform-smoke
npm run smoke:platform:ubuntu-image
npm run smoke:platform:doctor
npm run smoke:platform:all
```

The required matrix is documented in [`docs/platform-smoke.md`](docs/platform-smoke.md). It runs `platform-build` (fast target-local verify, pack, clean packed Pi install, `pi list`) and `browser-dogfood-smoke` (real `agent-browser`/browser wrapper smoke) on every target. Inspect `.artifacts/platform-smoke/` and check `crabbox list --provider local-container` plus `crabbox list --provider parallels` after release runs so cleanup proof is not chat-only.

For package release confidence, follow [`docs/RELEASE.md`](docs/RELEASE.md). The release gate is:

```bash
npm run doctor
npm run check:platform-smoke
npm run smoke:platform:ubuntu-image
npm run smoke:platform:doctor
npm run verify -- release
```

`npm run verify -- release` includes the default verification gate, packaged Pi smoke coverage, and the release-blocking Crabbox platform matrix. The package also has a `prepublishOnly` hook that runs the same release gate and `npm pack --dry-run` during `npm publish`.

## How it works

`pi-agent-browser-native` is intentionally thin:

1. Pi loads `extensions/agent-browser/index.ts` from the package manifest.
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
- Localhost means the browser host's loopback, not necessarily the shell/Pi host. If `http://localhost:<port>` or `http://127.0.0.1:<port>` fails with errors such as `ERR_EMPTY_RESPONSE`, use a host-reachable address when available or a `file://` URL for static fixtures, then verify with `snapshot -i` or an explicit screenshot.
- `file://` pages are useful as a static fallback, but they can behave differently from HTTP pages for MIME types, CORS, storage, and script/debugger behavior. If `eval --stdin` returns `null` or otherwise cannot verify a `file://` page, treat that as inconclusive and use screenshot/snapshot evidence or move the fixture to reachable HTTP.
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
pi --no-extensions -e .
```

This bypasses Pi settings and configured extensions. After editing extension code, restart that Pi process to test the new checkout.

For a concrete expanded native-tool smoke matrix (version/help/skills through dashboard/chat families), see [Local development validation](docs/RELEASE.md#local-development-validation) in `docs/RELEASE.md`. For bounded release smokes that should validate this extension rather than skill routing, use the [Sauce Demo smoke prompt](docs/RELEASE.md#public-sauce-demo-checkout-smoke-prompt), which adds `--no-skills`. When changes affect dense dashboards, diagnostics, artifacts, recording, scroll, or combobox behavior, use the public [Grafana stress checklist](docs/RELEASE.md#public-grafana-stress-checklist) for repeatable release dogfood without bundling private skills or recipes.

Configured-source lifecycle validation:

```bash
npm run verify -- lifecycle
```

The harness defaults to Pi model `zai/glm-5.1` and **180000 ms** per-step tmux waits; pass `--model <id>` and/or `--timeout-ms <ms>` after `lifecycle` when you need different settings (see [Configured-source lifecycle validation](docs/RELEASE.md#configured-source-lifecycle-validation) in `docs/RELEASE.md`). It launches Pi 0.78 with a deterministic `--session-id`, drives `/reload`, closes Pi, relaunches the exact same session, asserts the JSONL header id, and checks managed-session continuity, persisted spill reachability, and real Pi `tool_result` failure-patch behavior.

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
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After the wrapper observes tab-drift risk for a session (for example profile restore correction, overlapping stale opens, or resumed session state), later active-tab commands best-effort pin that tab inside the same upstream invocation. Routine same-session commands are not preflighted with tab list just because a target tab is known.
- For sessions with observed tab-drift risk, after a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes. Routine same-session commands skip this post-command tab-list probe.
- If a known session target unexpectedly reports about:blank, agent_browser best-effort re-selects the prior intended target when it still exists; if recovery fails, it records the observed about:blank target and reports exact recovery guidance instead of treating the prior page as active.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->

## Project map

| Path | Purpose |
|---|---|
| `extensions/agent-browser/index.ts` | Pi extension entrypoint and native tool wrapper |
| `extensions/agent-browser/lib/runtime.ts` | Argv parsing, session planning, redaction, and execution-plan helpers (pure planning; subprocess wiring lives beside the entrypoint) |
| `extensions/agent-browser/lib/results/` | Model-facing result rendering and error guidance |
| `extensions/agent-browser/lib/playbook.ts` | Canonical generated agent/browser guidance |
| `scripts/agent-browser-capability-baseline.mjs` | Target upstream version, help samples, and doc/token inventory for drift checks |
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

- [`AGENTS.md`](AGENTS.md) — maintainer and agent runbooks, including upstream capability baseline rebaselining and Pi smoke testing in `tmux`
- [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md) — full native command reference and upstream capability baseline
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — exact tool contract
- [`docs/ELECTRON.md`](docs/ELECTRON.md) — Electron desktop-app guide
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the wrapper is designed
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — product constraints and non-goals
- [`docs/RELEASE.md`](docs/RELEASE.md) — maintainer release workflow
- [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) — current upstream support matrix and closure evidence

## Where to go next

If you are a user, install the package and ask Pi to open a public page with `agent_browser`.

If you are evaluating the implementation, read [`extensions/agent-browser/index.ts`](extensions/agent-browser/index.ts), then run `npm run verify`.
