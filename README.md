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
| Agents build fragile shell commands | Exposes `agent_browser` with exact `args`, an optional `semanticAction` shorthand for common `find` flows, constrained `job` / `qa` presets and experimental `sourceLookup` / `networkSourceLookup` that compile short workflows to `batch`, plus controlled `stdin` and `sessionMode` | `extensions/agent-browser/index.ts`, [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) |
| Page snapshots are too large | Shows compact, main-content-first summaries and stores full raw output in spill files when needed | `test/agent-browser.presentation.test.ts` |
| Screenshots/downloads get lost in text | Normalizes artifact paths and reports existence, size, cwd, session, and repair status | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#download-screenshot-and-pdf-files) |
| Profile restores and tab drift confuse agents | Tracks managed sessions, pins intended tabs, and re-selects target tabs after drift | generated tab-recovery notes below; `test/agent-browser.resume-state.test.ts` |
| Auth/profile workflows can leak secrets | Supports `auth save --password-stdin` and redacts sensitive args, URLs, stdout/stderr, details, and parse-failure spills | `test/agent-browser.extension-validation.test.ts` |
| Stateful cookies/storage/auth output bloats or leaks context | Presentation layer redacts `details.data` for cookies and storage (field-aware values) and recursively scrubs other structured upstream JSON (network, diff, trace/profiler, stream, dashboard, chat, auth, dialog, frame, state, and similar) using sensitive key names plus string heuristics; masks sensitive argv flags and positionals; scrubs secrets from failed batch step errors; and exposes a compact redacted `batch` matrix on top-level `details.data` | `extensions/agent-browser/lib/results/presentation.ts`, `extensions/agent-browser/lib/runtime.ts`, `test/agent-browser.presentation.test.ts` |
| Stale `@eN` refs fail mysteriously | Adds recovery guidance to rerun `snapshot -i` or use stable `find` locators | `test/agent-browser.results.test.ts` |
| Agents need stable success/failure buckets | Exposes bounded `resultCategory`, `successCategory`, and `failureCategory` on tool `details` for branching without parsing prose | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/results/shared.ts`, `test/agent-browser.results.test.ts` |
| Models re-snapshot after every click without new URL/title context | Adds optional `details.pageChangeSummary` (and per-batch-step summaries) with `changeType`, compact text, optional `title`/`url`, artifact hints, and `nextActionIds` aligned to `nextActions` | [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), `extensions/agent-browser/lib/results/presentation.ts`, `test/agent-browser.presentation.test.ts` |
| Direct binary help may be blocked in agent sessions | Publishes a repo-readable command reference and verifies it against the target upstream version | `npm run verify` |
| Agents need bundled `skills` text without touching the live session | Treats `skills list`, `skills get …`, and `skills path …` as stateless JSON reads: no implicit managed `--session` under default `sessionMode: "auto"` (same session-ownership goal as plain-text `--help` / `--version`), while provider workflows stay thin passthroughs that require upstream setup and credentials | [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#built-in-skills), `extensions/agent-browser/lib/runtime.ts` |

## Fastest way to try it

Install upstream `agent-browser` first and make sure it is on `PATH`:

- https://agent-browser.dev/
- https://github.com/vercel-labs/agent-browser

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
- Pi settings do not point at multiple active `pi-agent-browser-native` sources

It does **not** edit Pi settings and does **not** run upstream `agent-browser doctor --fix`.

## Common agent calls

You usually prompt the agent in natural language. These JSON snippets show the exact native tool shape the agent should use.

Open a page and inspect it:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
```

Click a visible ref, then refresh refs after navigation or a DOM update:

```json
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

Run a multi-step flow in one tool call:

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

Evaluate page JavaScript through stdin:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
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

For supported upstream `find` flows you can omit hand-built `args` and pass a top-level `semanticAction` object instead. The wrapper compiles it to the same `find` argv upstream already understands; compiled argv is echoed as `details.compiledSemanticAction` when the unified result includes that field. Full field rules live in [`docs/TOOL_CONTRACT.md#semanticaction`](docs/TOOL_CONTRACT.md#semanticaction).

```json
{ "semanticAction": { "action": "click", "locator": "text", "value": "Submit" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
```

Typical pitfalls:

- Supply **exactly one** of `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, or `networkSourceLookup` per call (not more, not none).
- `semanticAction` and `job` are **not** valid inside `batch` stdin; batch steps stay upstream argv string arrays (spell a `find` step as tokens there if you need it in a batch).
- Commands or locators outside the supported shorthand still require explicit `args`.
- If upstream classifies the failure as `stale-ref` and `details.compiledSemanticAction` is present, `details.nextActions` may list `retry-semantic-action-after-stale-ref` after `refresh-interactive-refs`, carrying the same compiled `find` argv so you can retry the locator-stable target once it is safe to do so (contract in [`docs/TOOL_CONTRACT.md#semanticaction`](docs/TOOL_CONTRACT.md#semanticaction)).

### Constrained browser jobs

For short repeatable workflows, pass a top-level `job` instead of hand-writing `batch` stdin. The wrapper only supports constrained steps (`open`, `click`, `fill`, `wait`, `assertText`, `assertUrl`, `waitForDownload`, and `screenshot`), compiles them to existing upstream `batch` commands, and echoes the compiled commands as `details.compiledJob` for auditability.

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

Use raw `args`/`stdin` when you need full upstream `batch` power, custom flags, or commands outside the constrained job schema. Do not pass `stdin` with `job`, `qa`, `sourceLookup`, or `networkSourceLookup`; those modes generate the batch stdin themselves.

### Lightweight QA preset

For a quick smoke/QA pass, use top-level `qa`. It compiles to the same batch path as `job`, clears enabled network/console/page-error buffers before opening the target URL, waits for page readiness, checks optional expected text or selector, inspects fresh network requests, console messages, and page errors, and can capture an evidence screenshot. `checkNetwork`, `checkConsole`, and `checkErrors` default to true; set one to `false` to skip that diagnostic read.

```json
{
  "qa": {
    "url": "https://example.com",
    "expectedText": "Example Domain",
    "screenshotPath": ".dogfood/qa-example.png"
  }
}
```

Use custom `job` or raw `batch` when you need a different check sequence.

### Experimental source lookup

For local app debugging, `sourceLookup` can gather candidate component/file locations for a visible UI element. It is explicit and evidence-based: pass a `selector`, `reactFiberId`, and/or `componentName`; the wrapper compiles those inputs to existing batch steps (`is visible`, `get html` when `includeDomHints` is not `false`, `react inspect`, `react tree`) and a bounded local workspace scan under the Pi session cwd (`maxWorkspaceFiles` defaults to 2000 and cannot exceed 5000; the scan records at most ten `workspace-search` candidates). Results appear in `details.sourceLookup` with `status`, `candidates`, `limitations`, and `summary`. Unlike `qa`, the wrapper does not mark the tool failed on an otherwise successful batch solely because `status` is `no-candidates` or because React metadata was missing; failed upstream steps (for example `react inspect` without DevTools) still fail the batch normally.

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

This is an experiment, not a guarantee. React hints require a session opened with `--enable react-devtools`, and many builds do not expose useful sourcemap/source metadata; `status: "no-candidates"` is common when nothing matched, and `status: "unsupported"` only when no candidates were found **and** a compiled `react` batch step failed (if DOM or workspace search still produced candidates, you get `candidates-found` instead).

`networkSourceLookup` is the matching failed-request experiment. It reads `network request <id>` and/or filtered `network requests`, reports failed requests plus candidate initiator/workspace source hints, and avoids automatic blame or edits.

```json
{ "networkSourceLookup": { "requestId": "req-1", "url": "/api/fail" } }
```

For asynchronous exports, click first and then wait for the download:

```json
{ "args": ["click", "@export"] }
{ "args": ["wait", "--download", "/tmp/report.csv"] }
```

With upstream `agent-browser 0.27.0`, treat `details.savedFilePath` as upstream-reported metadata and confirm `details.artifacts[].exists` before relying on the requested `wait --download <path>` file being present on disk.

Start a fresh profiled browser after the implicit public-browsing session already exists:

```json
{ "args": ["--profile", "Default", "open", "https://example.com/account"], "sessionMode": "fresh" }
```

After a successful unnamed fresh launch, later default `sessionMode: "auto"` calls follow that browser automatically.

## Authenticated/profile workflows

The wrapper does not clone profiles or hide what upstream Chrome profile you chose. Passing `--profile` is an explicit upstream `agent-browser` choice.

Use these rules:

- Use public/temp profiles for tests and examples.
- Use `sessionMode: "fresh"` when switching from public browsing to `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device`.
- Use `--session` when you want to manage a live upstream session name yourself.
- Do not treat `--session` as persisted auth or tab restore after `close`; use `--profile`, `--session-name`, or `--state` for persistence.
- Prefer page actions and storage checks over cookie dumps. `cookies get` can expose real profile cookies.
- Prefer `auth save --password-stdin` over putting passwords in `args`; the wrapper only accepts caller `stdin` for `batch`, `eval --stdin`, and `auth save --password-stdin` (top-level `job` and `qa` compile to `batch` and supply their own stdin).
- Use `state save <path>` / `state load <path>` for portable test state. `state save` is reported as a file artifact with verification metadata; `state load` may mention a path but is not treated as a newly saved artifact.
- Treat `cookies get`, `storage local|session`, and `auth show` output as sensitive. The native presentation summarizes and redacts credential-like values, but avoid requesting these dumps unless the task needs them.
- Use `dialog status`, `dialog accept [text]`, `dialog dismiss`, and `frame <selector|main>` through native `args`; use exact `confirm <id>` / `deny <id>` next actions for guarded-action confirmations.

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
{ "args": ["vitals", "https://example.com", "--json"] }
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

It runs:

- generated playbook/documentation drift checks
- `tsc --noEmit`
- the test suite
- command-reference baseline checks
- live command-reference verification against the targeted installed upstream `agent-browser`

Step order and which subprocesses run live in [`scripts/project.mjs`](scripts/project.mjs); [`test/project-verify.test.ts`](test/project-verify.test.ts) locks default, `release`, `real-upstream`, `package-pi`, and combined-docs orchestration so a gate cannot disappear accidentally. Run `npm run verify -- --help` for opt-in modes and supported passthrough flags.

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

For package release confidence, follow [`docs/RELEASE.md`](docs/RELEASE.md). The release gate is:

```bash
npm run doctor
npm run verify -- release
```

`npm run verify -- release` includes the default verification gate plus packaged Pi smoke coverage. The package also has a `prepublishOnly` hook that runs default verification and `npm pack --dry-run` during `npm publish`.

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
- Does not provide a human browser UI inside Pi; the primary UX is agent-invoked tool calls.
- Real authenticated profile use is powerful but sensitive. Treat profile and cookie access as user-approved, task-specific behavior.
- Wrapper tab/session recovery is best effort around observed upstream behavior, not a replacement for explicit profile/session design.

## Local development

Install upstream `agent-browser`, then install dependencies:

```bash
npm install
```

Quick isolated checkout smoke test:

```bash
pi --no-extensions -e .
```

This bypasses Pi settings and configured extensions. After editing extension code, restart that Pi process to test the new checkout.

For a concrete expanded native-tool smoke matrix (version/help/skills through dashboard/chat families), see [Local development validation](docs/RELEASE.md#local-development-validation) in `docs/RELEASE.md`.

Configured-source lifecycle validation:

```bash
npm run verify -- lifecycle
```

Use lifecycle validation when testing `/reload`, full restart, `/resume`, managed-session continuity, or persisted artifact behavior.

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
- After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.
- After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.
- If a known session target unexpectedly reports about:blank, agent_browser preserves the prior intended target, best-effort re-selects it when it still exists, and reports exact recovery guidance when it cannot be re-selected.
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
| `docs/ARCHITECTURE.md` | Design decisions and implementation structure |
| `docs/REQUIREMENTS.md` | Product requirements and constraints |
| `docs/RELEASE.md` | Release, package, and lifecycle verification workflow |
| `docs/SUPPORT_MATRIX.md` | Current upstream support audit and release-readiness matrix |
| `test/` | Wrapper, runtime, presentation, lifecycle, and package tests |

## More docs

- [`AGENTS.md`](AGENTS.md) — maintainer and agent runbooks, including upstream capability baseline rebaselining and Pi smoke testing in `tmux`
- [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md) — full native command reference and upstream capability baseline
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — exact tool contract
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the wrapper is designed
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — product constraints and non-goals
- [`docs/RELEASE.md`](docs/RELEASE.md) — maintainer release workflow
- [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) — current upstream support matrix and closure evidence

## Where to go next

If you are a user, install the package and ask Pi to open a public page with `agent_browser`.

If you are evaluating the implementation, read [`extensions/agent-browser/index.ts`](extensions/agent-browser/index.ts), then run `npm run verify`.
