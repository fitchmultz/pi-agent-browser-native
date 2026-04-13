# pi-agent-browser-native

Native `pi` integration for [`agent-browser`](https://agent-browser.dev/).

## Status

Early working scaffold.

The package scaffold, native `agent_browser` tool, local typecheck/test setup, and release/package verification workflow are in place.

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

The product direction is package-first. Prefer the package source once a release exists, while keeping the local-checkout flow for current development and pre-release validation.

### Preferred package install

Install `agent-browser` separately, then install this package into `pi`:

```bash
pi install npm:pi-agent-browser-native
```

To try a published package without installing it permanently:

```bash
pi -e npm:pi-agent-browser-native
```

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

### Current practical local-checkout flow

Until you are using a published package release, prefer an explicit checkout-only run instead of installing the checkout into your normal `pi` package set:

```bash
pi --no-extensions -e /absolute/path/to/pi-agent-browser-native
```

This avoids duplicate `agent_browser` registrations if you also have the published package installed globally.

The native tool exposed to the agent is named `agent_browser`.

The primary session control parameter is `sessionMode`:

- `"auto"` (default) reuses the extension-managed `pi`-scoped session when possible
- `"fresh"` switches that managed session to a fresh upstream launch so startup-scoped flags like `--profile`, `--session-name`, and `--cdp` apply and later auto calls follow the new browser

## Agent quick start

### Mental model

- `args` — exact CLI args after `agent-browser`
- `stdin` — raw stdin only for `batch` and `eval --stdin`
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

Do not track or rely on a repo-local `.pi/extensions/agent-browser.ts` autoload shim for this package. When the package is also installed globally, that creates a duplicate `agent_browser` registration and blocks `pi` startup from this working directory.

1. Install `agent-browser` separately via the upstream project.
2. Run `npm install`.
3. Launch `pi` from this repository root with only the checkout extension loaded:

```bash
pi --no-extensions -e .
```

4. Prompt the agent to use `agent_browser`.

Example prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Validated workflow examples:

- open a page and snapshot it
- click a link and confirm the destination title
- use an explicit `--session` across multiple tool calls
- use an explicit `--profile` and verify persisted browser storage across restarts
- open `chatgpt.com` headlessly with `--profile Default` without forcing `--headed` or `--auto-connect`
- verify `/reload` and full restart + `/resume` keep following the same implicit managed browser session
- run `batch` with JSON via `stdin`
- run `eval --stdin`
- take a screenshot with inline attachment support
- inspect `agent_browser --help` and `--version` via the tool's stateless plain-text inspection fallback

Inspection commands like `agent_browser --help` and `--version` are always supported. They return plain text, are useful for debugging or capability checks, and stay stateless: the extension does not inject its implicit session for them and they do not consume the managed-session slot needed for a later `--profile`, `--session-name`, or `--cdp` launch.

Current cautions:
- passing `--profile` is an explicit upstream choice; this extension does not add its own profile-cloning or isolation layer
- startup-scoped flags like `--profile`, `--session-name`, and `--cdp` are for the first command that launches a session; if the implicit session is already active, retry that call with `sessionMode: "fresh"` or provide an explicit `--session ...` for the new launch
- implicit `piab-*` sessions are extension-managed convenience sessions; they stay alive across `pi` shutdown/reload so later default calls can keep following the active managed browser on `/reload` or `/resume`, rely on the configured idle timeout to reduce stale background daemons, store persisted-session large snapshot spill files under a private session-scoped artifact directory with a bounded per-session budget so `details.fullOutputPath` survives reload/resume without unbounded growth, and still clean up process-private temp spill artifacts on shutdown
- `sessionMode: "fresh"` without an explicit `--session` rotates that extension-managed session to the new browser so later auto calls keep using it
- for local Unix launches, the wrapper uses a short private socket directory under `/tmp` so extension-generated session names do not trip upstream Unix socket-path limits in longer cwd/session-name combinations
- for direct headless local Chrome launches to `chatgpt.com` and `chat.openai.com`, the extension injects a normal Chrome user agent when the caller did not explicitly provide `--user-agent`; this keeps the default headless workflow usable without forcing `--headed` or `--auto-connect`
- after profiled `open` calls, the extension best-effort re-selects the tab that matches the returned page URL when restored profile tabs steal focus during launch
- after a target tab is known, later active-tab commands like `click` and `snapshot -i` best-effort pin that same tab inside the same upstream invocation when a reconnect would otherwise drift to a restored tab
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
- [`docs/RELEASE.md`](docs/RELEASE.md) — maintainer release and package verification workflow

## Documentation rule

When requirements change in chat:

1. update `docs/REQUIREMENTS.md`
2. update the affected design docs
3. update this README if user-facing expectations changed
