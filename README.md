# pi-agent-browser-native

Native `pi` integration for [`agent-browser`](https://agent-browser.dev/).

## Status

Published pre-1.0 package.

The native `agent_browser` tool, local verification workflow, package-content checks, and release checks are in place. Package install is the default path; checkout loading is for development and validation.

## Goal

Expose `agent-browser` to `pi` as a native tool so agents can automate the browser without going through a bash-backed skill.

## Product stance

- **Not bundled**: users install `agent-browser` separately and keep it on `PATH`
- **Latest-version only**: no backward-compatibility support or shims for older `agent-browser` versions
- **Thin wrapper**: stay close to upstream `agent-browser` instead of re-implementing its CLI
- **Agent-invoked first**: the main UX is the agent calling the tool directly, like `read` or `write`
- **Global-install first**: package behavior matters more than repo-local development wiring

Upstream install/docs:
- https://agent-browser.dev/
- https://github.com/vercel-labs/agent-browser

## Why this exists

A native `pi` integration can improve on the current skill by adding:

- structured tool calls instead of shell strings
- parsed results instead of bash stdout
- compact model-facing snapshot shaping with full raw spill files for oversized pages
- main-content-first snapshot previews so the model sees the important page region before unrelated chrome or sidebar noise
- inline screenshots and artifacts
- lightweight session convenience inside `pi`
- a better base for serious browser automation

## Example use cases

- UI testing and exploratory QA
- web research
- driving web UIs for ChatGPT, Grok, Gemini, and Claude
- authenticated browser sessions and persistent profiles

## Install and try

The product direction is package-first. Prefer the package source for normal use; keep the local-checkout flow for development and pre-release validation.

### Preferred package install

Install `agent-browser` separately, then install this package into `pi`:

```bash
pi install npm:pi-agent-browser-native
```

To try a published package without installing it permanently, isolate that temporary package source from any configured checkout or global install:

```bash
pi --no-extensions -e npm:pi-agent-browser-native
```

For a specific published version:

```bash
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

### First-run doctor

Run the package doctor before first use or when `agent_browser` is missing or duplicated:

```bash
pi-agent-browser-doctor
# one-off without installing the package source permanently:
npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
# from a checkout:
npm run doctor
```

The doctor is read-only. It checks that upstream `agent-browser` is on `PATH`, that `agent-browser --version` matches the wrapper's capability baseline, and that Pi settings do not point at multiple active `pi-agent-browser-native` sources. It does not run upstream `agent-browser doctor --fix` or edit Pi settings.

If it reports duplicate sources, keep exactly one active source. For normal use, keep `pi install npm:pi-agent-browser-native` and remove checkout paths from Pi settings. For temporary package or checkout trials, use `pi --no-extensions -e npm:pi-agent-browser-native[@<version>]` or `pi --no-extensions -e /path/to/checkout` so configured sources are bypassed.

### GitHub install

For the source install path, prefer the repository URL:

```bash
pi install https://github.com/fitchmultz/pi-agent-browser-native
```

To try the GitHub source without installing it permanently, isolate that temporary source extension from your normal installed package set:

```bash
pi --no-extensions -e https://github.com/fitchmultz/pi-agent-browser-native
```

This avoids duplicate `agent_browser` registrations when you already have `pi-agent-browser-native` installed globally.

### Current practical local-checkout flows

This repository's `package.json` is itself a publishable pi package manifest that points at `extensions/agent-browser/index.ts`. That file is the real extension entrypoint for both the checkout and the published package.

Use two local-checkout modes intentionally:

- **Quick isolated smoke test:** run the checkout explicitly with `-e` and disable extension discovery:

  ```bash
  pi --no-extensions -e /absolute/path/to/pi-agent-browser-native
  ```

  This bypasses Pi settings and any configured checkout/global package sources, so it avoids duplicate `agent_browser` registrations. After editing extension code, restart this `pi` process to validate the new source; do not use this mode as proof that configured-source `/reload` works.

- **Configured-source lifecycle validation:** run `npm run verify -- lifecycle` for the opt-in automated tmux harness, or keep exactly one active source for this extension in Pi settings and launch plain `pi` for manual checks. Use this mode when validating `/reload`, full restart, and `/resume` behavior because Pi's reload flow operates on discovered/configured resources.

The native tool exposed to the agent is named `agent_browser`.

The primary session control parameter is `sessionMode`:

- `"auto"` (default) reuses the extension-managed `pi`-scoped session when possible
- `"fresh"` switches that managed session to a fresh upstream launch so launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, and `--auto-connect` apply and later auto calls follow the new browser

## Agent quick start

### Mental model

- `args` — exact CLI args after `agent-browser`
- `stdin` — raw stdin only for `batch` and `eval --stdin` (other command/stdin combinations are rejected before `agent-browser` is launched)
- `sessionMode`
  - `"auto"` — default, reuse the extension-managed `pi`-scoped session
  - `"fresh"` — switch that managed session to a new profile/debug launch

### Common call shapes

Open a page, then take an interactive snapshot:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
```

Click a ref, then re-snapshot after navigation or a major DOM change:

```json
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

Run a multi-step browser flow in one tool call:

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

Evaluate page JavaScript via stdin:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
```

Download a file from a known link/control directly:

```json
{ "args": ["download", "@e5", "/tmp/report.pdf"] }
```

For dashboards that start an export asynchronously after a click or navigation, click first and then wait for the download. The wrapper reports `Download completed: /tmp/report.csv` and exposes upstream-reported `details.savedFilePath` plus `details.savedFile` for the `wait` result; with upstream `agent-browser 0.26.0`, confirm `details.artifacts[].exists` before relying on a requested `wait --download <path>` file being present on disk (tracked upstream at [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300)):

```json
{ "args": ["click", "@export"] }
{ "args": ["wait", "--download", "/tmp/report.csv"] }
```

Batch flows preserve the same saved-file metadata on the wait step:

```json
{ "args": ["batch"], "stdin": "[[\"click\",\"@export\"],[\"wait\",\"--download\",\"/tmp/report.csv\"]]" }
```

Start a fresh profiled launch after you already used the implicit session:

```json
{ "args": ["--profile", "Default", "open", "https://example.com/account"], "sessionMode": "fresh" }
```

After a successful unnamed fresh launch, later `sessionMode: "auto"` calls follow that new browser automatically.

Name a new upstream session explicitly when you want to keep reusing it yourself:

```json
{ "args": ["--session", "auth-flow", "open", "https://example.com"] }
```

### First useful prompt in a fresh `pi` session

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

## Local development

Do not track or rely on a repo-local `.pi/extensions/agent-browser.ts` autoload shim for this package. That creates an unnecessary second registration path.

The published entrypoint lives at `extensions/agent-browser/index.ts` and is referenced directly from this repo's `package.json`.

Recommended local development setup:
1. Install `agent-browser` separately via the upstream project.
2. Run `npm install`.
3. For a quick checkout-only smoke test, launch `pi` from this repository root with discovery disabled:

```bash
pi --no-extensions -e .
```

4. Prompt the agent to use `agent_browser`.
5. For hot-reload or resume validation, run `npm run verify -- lifecycle` or configure exactly one active source for this extension in Pi settings, launch plain `pi`, and exercise `/reload` plus restart/`/resume`. Settings matter only in this configured-source mode; they are bypassed by `--no-extensions -e .`. See [`docs/RELEASE.md`](docs/RELEASE.md) for the automated harness behavior, cleanup, and transcript retention details.

Example prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

For installed-package validation after a release, use exactly one active source. The canonical isolated validation sequence is:

```bash
npm run verify -- package-pi
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

Only use plain `pi` for installed-package validation after disabling or removing the checkout source from Pi settings.

Validated workflow examples:

- open a page and snapshot it
- click a link and confirm the destination title
- use an explicit `--session` across multiple tool calls
- use an explicit `--profile` and verify persisted browser storage across restarts
- open `chat.com` or `chatgpt.com` headlessly with `--profile Default` without forcing `--headed` or `--auto-connect`
- in configured-source lifecycle mode, verify `/reload` and full restart + `/resume` keep following the same implicit managed browser session
- run `batch` with JSON via `stdin`
- run `eval --stdin`
- take a screenshot with inline attachment support and visible artifact metadata: artifact type, requested path, absolute path, existence, size, cwd, session, and repair/copy status when applicable
- inspect upstream help/version through native tool calls like `{ "args": ["--help"] }` and `{ "args": ["--version"] }` via the tool's stateless plain-text inspection fallback
- use `download <selector> <path>` for direct attachment/file-save workflows instead of trying to infer downloads from generic clicks or large eval dumps
- for `.dogfood/...` or other dot-directory screenshot paths, rely on the wrapper's path normalization/repair contract; the visible result reports the requested path and absolute path rather than only an upstream temp path
- use `click` plus `wait --download <path>` for asynchronous export flows, confirm `details.savedFilePath`/`details.savedFile` are present on the wait result or batch wait step, and check `details.artifacts[].exists` before relying on requested-path persistence
- confirm oversized outputs show the actual spill file path directly in tool content, not just a details key name
- inspect `details.artifactManifest` / `details.artifactRetentionSummary` during artifact-heavy flows to recover recent saved files, spill files, and visible eviction state after reload/resume

<!-- agent-browser-playbook:start inspection -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
Native inspection calls use the `agent_browser` tool shape, not shell-like direct-binary commands:

- { "args": ["--help"] }
- { "args": ["--version"] }

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, or auto-connect launches.
<!-- agent-browser-playbook:end inspection -->

Current cautions:
- passing `--profile` is an explicit upstream choice; this extension does not add its own profile-cloning or isolation layer
- launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, and `--auto-connect` are for the first command that launches a session; if the implicit session is already active, retry that call with `sessionMode: "fresh"` or provide an explicit `--session ...` for the new launch
- implicit `piab-*` sessions are extension-managed convenience sessions; they stay alive across `/reload` and resumable session transitions so later default calls can keep following the active managed browser on `/reload` or `/resume`, close when the originating `pi` process quits, rely on the configured idle timeout only as an abnormal-exit backstop, store persisted-session large snapshot spill files under a private session-scoped artifact directory with a bounded per-session budget so `details.fullOutputPath` and metadata-only `details.artifactManifest` survive reload/resume without unbounded growth, and still clean up process-private temp spill artifacts on shutdown
- `sessionMode: "fresh"` without an explicit `--session` rotates that extension-managed session to the new browser so later auto calls keep using it
- for local Unix launches, the wrapper uses a short private socket directory under `/tmp` so extension-generated session names do not trip upstream Unix socket-path limits in longer cwd/session-name combinations
- for direct headless local Chrome launches to `chat.com`, `chatgpt.com`, and `chat.openai.com`, the extension injects a normal Chrome user agent when the caller did not explicitly provide `--user-agent`; this keeps the default headless workflow usable without forcing `--headed` or `--auto-connect`
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.
- After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.
- If a known session target unexpectedly reports about:blank, agent_browser preserves the prior intended target, best-effort re-selects it when it still exists, and reports exact recovery guidance when it cannot be re-selected.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- oversized snapshots and oversized generic outputs compact inline content and print the actual spill file path directly in the tool result when a spill file exists; recent spills and explicit saved artifacts are also summarized in `details.artifactManifest`, including `evicted` entries when retention budgets remove older persisted files
- artifact-producing commands render direct readable artifact metadata in visible content and `details.artifacts`: `kind`/`artifactType`, `path`, `requestedPath`, `absolutePath`, `exists`, `sizeBytes`, `status`, `cwd`, `session`, and `tempPath` when the wrapper repaired an upstream temp fallback
- if the caller explicitly passes `--json`, the visible text content is valid JSON; for `stream status`, the wrapper enriches data with `wsUrl` and `frameFormat`
- `trace` and `profiler` share upstream tracing machinery; the wrapper blocks starts/stops that conflict with owner state it observed in the current Pi session, but the message says "wrapper believes" because upstream or external CLI calls can desynchronize that local state
- explicit caller-provided `--session` values are treated as user-managed and are not auto-closed by the extension
- explicit caller-provided `--user-agent` values win over the ChatGPT/OpenAI compatibility workaround
- tool progress/details redact sensitive invocation values such as `--headers`, proxy credentials, and auth-bearing URL parameters before echoing them back into Pi

### Switching from public browsing to a fresh profile/debug launch

A common agent workflow is:

1. browse a public page with the default implicit session
2. then switch to a fresh authenticated/profile/debug launch

Use `sessionMode: "fresh"` for that transition instead of relying on the implicit session:

```json
{
  "args": ["--profile", "Default", "open", "https://example.com/account"],
  "sessionMode": "fresh"
}
```

After that call succeeds, later default `sessionMode: "auto"` calls continue in the new fresh browser.

If you want to name the new upstream session yourself, pass an explicit session instead:

```json
{
  "args": ["--session", "auth-flow", "--profile", "Default", "open", "https://example.com/account"]
}
```

## Docs

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — product requirements and constraints
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture decision
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — proposed v1 tool shape
- [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md) — local repo-readable command reference for the blocked direct-binary path
- [`docs/RELEASE.md`](docs/RELEASE.md) — maintainer release and package verification workflow

## Documentation rule

When requirements change in chat:

1. update `docs/REQUIREMENTS.md`
2. update the affected design docs
3. update this README if user-facing expectations changed

When the upstream `agent-browser` binary changes:

1. re-check the upstream command/help surface
2. update `docs/COMMAND_REFERENCE.md`
3. update tool guidance, README, and release docs if behavior or recommended usage changed
4. verify the blocked direct-binary path still has an equally usable local extension-side documentation path
