# Agent Browser command reference

Related docs:
- [`../README.md`](../README.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`RELEASE.md`](RELEASE.md)

## Purpose

Provide a local, repo-readable command reference for the native `agent_browser` tool.

This project intentionally blocks normal `agent-browser` bash usage in most agent sessions, so the agent still needs an accessible local equivalent of the upstream command surface. This document is the durable reference the agent can read inside the repository without calling the binary directly.

## Upstream baseline

<!-- agent-browser-capability-baseline:start upstream-baseline -->
<!-- Generated from scripts/agent-browser-capability-baseline.mjs. Run `npm run docs -- command-reference write` to update. Do not edit manually. -->
This reference is baselined to the locally installed `agent-browser 0.27.0` command/help surface. Upstream `agent-browser` remains the source of truth for command semantics; this file is the local fallback for Pi agent sessions where direct binary help is blocked or discouraged.

The lightweight drift check is `npm run verify -- command-reference`. Run it whenever the installed upstream `agent-browser` version changes or this reference is edited.

Use `npm run benchmark:agent-browser` or `npm run verify -- benchmark` before and after agent-facing workflow abstractions to measure task success, tool calls, model-visible output size, stale-ref behavior, artifact success, failure-category coverage, and elapsed-time estimates.
<!-- agent-browser-capability-baseline:end upstream-baseline -->

## Core mental model

Tool parameters:

```json
{
  "args": ["open", "https://example.com"],
  "stdin": "optional raw stdin content",
  "sessionMode": "auto"
}
```

- `args`: exact `agent-browser` CLI tokens after the binary name.
- `stdin`: only for `batch`, `eval --stdin`, and `auth save --password-stdin`; other command/stdin combinations are rejected before `agent-browser` is launched.
- `sessionMode`:
  - `"auto"` reuses the extension-managed session when possible.
  - `"fresh"` rotates that managed session to a fresh upstream launch so launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, or `--enable` apply.

## Recommended workflow

Keep routine browser work simple: open a page, inspect it with `snapshot -i`, interact with current `@ref` values from that snapshot, then inspect again. Re-run `snapshot -i` after navigation, scrolling, rerendering, or other major DOM changes because refs can become stale.

### Normal browse flow

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i", "--urls"] }
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

### React, SPA, and Web Vitals flows

React introspection requires the React DevTools init hook to be installed before the page's first JavaScript runs. Launch or relaunch that browser session with `--enable react-devtools`; if the implicit session is already active, use `sessionMode: "fresh"`.

```json
{ "args": ["open", "--enable", "react-devtools", "https://example.com"], "sessionMode": "fresh" }
{ "args": ["react", "tree"] }
{ "args": ["react", "inspect", "<fiberId>"] }
{ "args": ["react", "renders", "start"] }
{ "args": ["react", "renders", "stop"] }
{ "args": ["react", "suspense", "--only-dynamic"] }
```

Use `vitals [url]` for Core Web Vitals plus React hydration timing when available, and `pushstate <url>` for client-side SPA navigation without a full reload:

```json
{ "args": ["vitals", "https://example.com", "--json"] }
{ "args": ["pushstate", "/dashboard?tab=settings"] }
```

For first-navigation setup, start on `about:blank`, then stage routes, cookies, or init scripts before navigating. The relevant v0.27.0 surfaces are `network route <url> [--abort|--body <json>] [--resource-type <csv>]` and `cookies set --curl <file>`:

```json
{ "args": ["open"], "sessionMode": "fresh" }
{ "args": ["network", "route", "**/*.js", "--abort", "--resource-type", "script"] }
{ "args": ["cookies", "set", "--curl", "/path/to/cookies.txt", "--domain", "example.com"] }
{ "args": ["navigate", "https://example.com"] }
```

### Selector strategy

Prefer targets in this order:

1. Use a current `@ref` from the latest `snapshot -i` for visible interactive controls.
2. After `scroll`, `scrollintoview`, navigation, or any rerender, take a fresh `snapshot -i` before reusing refs.
3. When a target is easiest to describe by accessible name or visible text, use `find` locators such as `role`, `text`, `label`, `placeholder`, `alt`, `title`, or `testid` instead of guessing selector syntax.
4. Use CSS selectors for scoped extraction or stable app-specific hooks when you know they match the current page.

Examples:

```json
{ "args": ["find", "role", "button", "click", "--name", "Close"] }
{ "args": ["find", "text", "Close", "click"] }
{ "args": ["find", "label", "Email", "fill", "user@example.com"] }
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Close" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "args": ["scrollintoview", "@e12"] }
{ "args": ["snapshot", "-i"] }
```

The optional native `semanticAction` object is only a thin schema for common locator-based actions; it compiles to existing upstream `find` commands and reports the compiled args in `details.compiledSemanticAction`.

Do not assume Playwright selector dialects such as `text=Close` or `button:has-text('Close')` are supported wrapper syntax. If you need those forms, verify current upstream `agent-browser` behavior first; otherwise use refs, `find`, or known CSS selectors.

### Extract page data

```json
{ "args": ["get", "title"] }
{ "args": ["get", "url"] }
{ "args": ["get", "text", "main"] }
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
```

Prefer `get` and scoped `eval --stdin` for read-only extraction. Return the intended JavaScript value instead of relying on `console.log`.

### Run a multi-step flow in one browser invocation

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

Use `batch --bail` when later steps should stop after the first failed command.

### Wait for page readiness or downloads

```json
{ "args": ["wait", "--load", "networkidle"] }
{ "args": ["wait", "--url", "**/dashboard"] }
{ "args": ["wait", "--download", "/tmp/report.pdf"] }
```

Do not use a bare `wait --load`; `--load` needs a state value such as `load`, `domcontentloaded`, or `networkidle`.

Use `wait --download [path]` after an earlier action has already started a browser download, such as a dashboard export button that responds asynchronously:

```json
{ "args": ["click", "@export"] }
{ "args": ["wait", "--download", "/tmp/report.csv"] }
```

For one-call flows, put the click and wait in `batch`; the wait step keeps the saved-file metadata in `details.batchSteps[n].savedFilePath` and `details.batchSteps[n].savedFile`:

```json
{ "args": ["batch"], "stdin": "[[\"click\",\"@export\"],[\"wait\",\"--download\",\"/tmp/report.csv\"]]" }
```

A successful wait-based download renders a readable summary such as `Download completed: /tmp/report.csv` and exposes top-level `details.savedFilePath` plus `details.savedFile` for non-batch calls. With the current upstream `agent-browser 0.27.0`, `wait --download <path>` may report the requested path before this environment can verify that the file was persisted there. Treat `details.savedFilePath` as upstream-reported metadata unless `details.artifacts[].exists` is true. Upstream tracking: [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300).

### Download, screenshot, and PDF files

```json
{ "args": ["download", "@e5", "/tmp/report.pdf"] }
{ "args": ["screenshot", "/tmp/page.png"] }
{ "args": ["screenshot", "--full", "/tmp/full-page.png"] }
{ "args": ["screenshot", "--annotate", "/tmp/annotated.png"] }
{ "args": ["pdf", "/tmp/page.pdf"] }
```

The upstream screenshot aliases are `screenshot --full` for full-page capture and `screenshot --annotate` for labeled screenshots.

Prefer `download <selector> <path>` when the target element itself is the downloadable link/control. Use `click` plus `wait --download [path]` when a previous action starts the download indirectly.

Wrapper result rendering is metadata-first for saved files:
- screenshots return a saved-path summary, visible artifact metadata, structured `details.artifacts` metadata, and an inline image attachment when safe; the visible block includes artifact type, requested path, absolute path, existence, size, cwd, session, and repair/copy status when applicable
- downloads, PDFs, `wait --download` files, traces, CPU profiles, completed WebM recordings from `record stop`, and path-bearing HAR captures return concise saved-path summaries plus structured `details.artifacts` metadata without inlining large files
- `record start <path>` reports that recording started and that output will be written on `record stop`; the target file may not exist until recording stops
- `batch` keeps each step's artifacts in `details.batchSteps[].artifacts` and aggregates them in top-level `details.artifacts` in step order

For screenshot paths under dot-directories such as `.dogfood/run/foo.png`, the wrapper normalizes the requested path to an absolute path before invoking upstream `agent-browser`, verifies the requested file exists, and repairs from an upstream temp screenshot when possible. The requested path remains visible as `Requested path`, while `Absolute path` shows the actual on-disk location.

For annotated screenshots in `batch`, put `--annotate` in top-level args instead of inside the screenshot step:

```json
{ "args": ["--annotate", "batch"], "stdin": "[[\"screenshot\",\"/tmp/page.png\"]]" }
```

#### Artifact retention and dogfood-heavy QA runs

The wrapper keeps a bounded, metadata-only `details.artifactManifest` of recent artifacts so long sessions do not grow unbounded. The default recent window is 100 entries and can be raised for screenshot/video-heavy QA sessions with `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES=<count>`.

This manifest cap controls what appears in `details.artifactManifest` and in summaries such as `Session artifacts: 42 live, 0 evicted (42/100 recent)`. It does not delete explicit files that upstream saved to paths you chose, such as screenshots, PDFs, downloads, traces, HAR files, or WebM recordings.

Oversized snapshots and oversized generic outputs are different: when a persisted pi session is available, their wrapper-managed spill files are stored under the private session artifact directory and are governed by the byte budget `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB). Raise that byte budget as well for long QA sessions that need many full raw snapshots or large text spills to survive reload/resume.

### Switch from an already-active implicit session to a fresh profiled launch

```json
{
  "args": ["--profile", "Default", "open", "https://mail.google.com"],
  "sessionMode": "fresh"
}
```

### Recover tabs when focus lands somewhere unexpected

```json
{ "args": ["tab", "list"] }
{ "args": ["tab", "t2"] }
{ "args": ["snapshot", "-i"] }
```

Use `tab list` and `tab <tab-id-or-label>` when a profile restore, pop-up, or click opens or focuses the wrong tab.

### Recover from guarded-action confirmations

When a call uses `--confirm-actions` and upstream requires confirmation, the native tool result prints the pending confirmation id and both recovery calls. Use the same `agent_browser` tool; do not switch to bash.

```json
{ "args": ["--confirm-actions", "click", "click", "@danger"] }
```

If the result says `Pending confirmation id: c_8f3a1234`, choose one follow-up:

```json
{ "args": ["confirm", "c_8f3a1234"] }
{ "args": ["deny", "c_8f3a1234"] }
```

Confirmation context may be redacted when it contains credentials, tokens, cookies, or auth-bearing URLs. Use the id exactly as printed.

## Full supported surface

The tables below intentionally list more than the recommended workflow. Rare commands are included so agents can discover that the installed upstream supports them without direct `agent-browser --help` access.

### Built-in skills

Native-tool note: upstream skills are written for the standalone `agent-browser` CLI and may show bash/heredoc examples. In pi, convert those examples to `agent_browser` calls: pass CLI tokens in `args`, and pass heredoc/stdin bodies through the tool `stdin` field for `batch`, `eval --stdin`, or `auth save --password-stdin`.

| Command | Purpose |
| --- | --- |
| `skills list` | List available CLI-bundled skills. |
| `skills get core` | Print the core usage guide. |
| `skills get core --full` | Print the full version-matched core command reference and templates. |
| `skills get <name>` | Load a specialized skill such as `electron` or `slack`. Common specialized calls include `skills get electron`, `skills get slack`, `skills get dogfood`, `skills get vercel-sandbox`, and `skills get agentcore`. |
| `skills path [name]` | Print a skill directory path. |

### Core page and element commands

| Command | Purpose |
| --- | --- |
| `open <url>` | Navigate to a URL. |
| `click <sel>` | Click an element or `@ref`. |
| `dblclick <sel>` | Double-click an element. |
| `type <sel> <text>` | Type into an element. |
| `fill <sel> <text>` | Clear and fill an element. |
| `press <key>` | Press a key such as `Enter`, `Tab`, or `Control+a`. Related key-hold aliases include `keydown Shift` and `keyup Shift`. |
| `keyboard type <text>` | Type text with real keystrokes and no selector. |
| `keyboard inserttext <text>` | Insert text without key events. |
| `hover <sel>` | Hover an element. |
| `focus <sel>` | Focus an element. |
| `check <sel>` | Check a checkbox. |
| `uncheck <sel>` | Uncheck a checkbox. |
| `select <sel> <val...>` | Select one or more dropdown options. |
| `drag <src> <dst>` | Drag and drop. |
| `upload <sel> <files...>` | Upload one or more files. |
| `download <sel> <path>` | Download a file by clicking an element. |
| `scroll <dir> [px]` | Scroll `up`, `down`, `left`, or `right`. |
| `scrollintoview <sel>` | Scroll an element into view. |
| `wait <sel|ms>` | Wait for an element or a duration. |
| `screenshot [path]` | Take a screenshot. |
| `pdf <path>` | Save the page as a PDF. |
| `snapshot` | Print an accessibility tree with refs for AI interaction. |
| `eval <js>` | Run JavaScript. Use `eval --stdin` through this wrapper for larger snippets. |
| `connect <port|url>` | Connect to a browser through CDP. |
| `close [--all]` | Close the current browser or all sessions. |

### Navigation

| Command | Purpose |
| --- | --- |
| `back` | Go back. |
| `forward` | Go forward. |
| `reload` | Reload the current page. |

### Session, state, frames, dialogs, windows, and inspection commands

| Command | Purpose |
| --- | --- |
| `session` | Show current session name. |
| `session list` | List active sessions. |
| `state save <path>` | Save cookies, local storage, and session storage to a state file. |
| `state load <path>` | Load cookies and storage from a state file. |
| `frame <selector|main>` | Switch iframe context by selector/ref/name/URL, or return to the main frame. |
| `dialog accept [text]` | Accept an alert, confirm, or prompt dialog, optionally supplying prompt text. |
| `dialog dismiss` | Dismiss or cancel the current dialog. |
| `dialog status` | Check whether a dialog is pending. |
| `window new` | Open a new browser window. |
| `close` | Close the current browser session. |
| `close --all` | Close every session. |

<!-- agent-browser-playbook:start inspection -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
Native inspection calls use the `agent_browser` tool shape, not shell-like direct-binary commands:

- { "args": ["--help"] }
- { "args": ["--version"] }

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, or auto-connect launches.
<!-- agent-browser-playbook:end inspection -->

### Page state, finding, mouse, settings, network, and storage

| Family | Surface |
| --- | --- |
| `get <what> [selector]` | `text`, `html`, `value`, `attr <name>`, `title`, `url`, `count`, `box`, `styles`, `cdp-url`. |
| `is <what> <selector>` | Check `visible`, `enabled`, or `checked`. |
| `find <locator> <value> <action> [text]` | Locator types include `role`, `text`, `label`, `placeholder`, `alt`, `title`, `testid`, `first`, `last`, and `nth`. |
| `mouse <action> [args]` | `move <x> <y>`, `down [btn]`, `up [btn]`, `wheel <dy> [dx]`. |
| `set <setting> [value]` | `viewport <w> <h>`, `device <name>`, `geo <lat> <lng>`, `offline [on|off]`, `headers <json>`, `credentials <user> <pass>`, `media [dark|light] [reduced-motion]`. |
| `network <action>` | `route <url> [--abort|--body <json>] [--resource-type <csv>]`, `unroute [url]`, `requests [--clear] [--filter <pattern>]`, `request <requestId>`, `har <start|stop> [path]`. `--resource-type` filters intercepted requests by CDP resource type, such as `script`, `image`, `font`, `xhr`, or `fetch`. |
| `cookies [get|set|clear]` | Manage cookies. `set` supports `--url`, `--domain`, `--path`, `--httpOnly`, `--secure`, `--sameSite`, `--expires`, and `--curl <file>` for JSON, cURL, or bare Cookie-header bulk imports. |
| `storage <local|session>` | Manage web storage. |

Privacy note: `cookies get` can expose real profile cookies. Do not run it against `--profile Default` or other authenticated profiles unless the user explicitly needs cookie inspection; prefer task-specific page actions and storage checks.

### Tabs

Stable tab ids look like `t1`, `t2`, and `t3`. Optional user labels such as `docs` or `app` are interchangeable with ids wherever a tab reference is accepted. Upstream help may refer to numeric tab positions, but this wrapper guidance uses stable `t<N>` ids because positional integers are not accepted by current upstream `agent-browser`.

| Command | Purpose |
| --- | --- |
| `tab` | List open tabs by default. |
| `tab list` | List open tabs with ids and labels. |
| `tab new [url]` | Open a new tab. |
| `tab new --label <name> [url]` | Open a new tab with a user label. |
| `tab <t<N>|label>` | Switch to a tab by id or label. |
| `tab close [t<N>|label]` | Close the current tab or a referenced tab. |

### Snapshot

| Option | Purpose |
| --- | --- |
| `snapshot` | Full accessibility tree with refs. |
| `snapshot -i` / `snapshot --interactive` | Include only interactive elements. |
| `snapshot -i --urls` | Include only interactive elements and link hrefs. |
| `snapshot -u` / `snapshot --urls` | Include href URLs for link elements. |
| `snapshot -c` / `snapshot --compact` | Remove empty structural elements. |
| `snapshot -d <n>` / `snapshot --depth <n>` | Limit tree depth. |
| `snapshot -s <sel>` / `snapshot --selector <sel>` | Scope to a CSS selector. |

### Wait

| Mode | Purpose |
| --- | --- |
| `wait <selector>` | Wait for an element to appear. |
| `wait <ms>` | Wait for a fixed number of milliseconds. In the native Pi wrapper, keep each fixed wait at `25000` ms or less and split longer waits into multiple tool calls. |
| `wait --url <pattern>` | Wait for the URL to match a pattern. |
| `wait --load <state>` | Wait for load state: `load`, `domcontentloaded`, or `networkidle`. |
| `wait --fn <expression>` | Wait for a JavaScript expression to become truthy. |
| `wait --text <text>` | Wait for text to appear on the page. |
| `wait --download [path]` | Wait for a download started by a previous action and optionally save it to `path`; successful wrapper results include upstream-reported `savedFilePath`/`savedFile`, while `details.artifacts[].exists` is the wrapper's on-disk verification signal. |
| `wait --download [path] --timeout <ms>` | Set download-start timeout in milliseconds. In the native Pi wrapper, use `25000` ms or less per call to stay under the upstream CLI IPC budget. |
| `wait <selector> --state hidden` | Wait for an element to become hidden. |
| `wait <selector> --state detached` | Wait for an element to detach. |

### Diff, debug, and streaming

| Command | Purpose |
| --- | --- |
| `diff snapshot` | Compare current versus last snapshot. |
| `diff screenshot --baseline` | Compare current screenshot versus a baseline image. |
| `diff url <u1> <u2>` | Compare two pages. |
| `trace start|stop [path]` | Record a Chrome DevTools trace. |
| `profiler start|stop [path]` | Record a Chrome DevTools profile. |
| `record start <path> [url]` | Start WebM video recording; output is written on `record stop`. |
| `record stop` | Stop and save video. |
| `record restart <path> [url]` | Stop any current recording and start a new WebM recording. |
| `console [--clear]` | View or clear console logs. |
| `errors [--clear]` | View or clear page errors. |
| `highlight <sel>` | Highlight an element. |
| `inspect` | Open Chrome DevTools for the active page. |
| `clipboard <op> [text]` | Read/write clipboard: `read`, `write`, `copy`, `paste`. |
| `stream enable [--port <n>]` | Start runtime WebSocket streaming for this session. |
| `stream disable` | Stop runtime WebSocket streaming. |
| `stream status` | Show streaming status and active port. |
| `react tree` | Print the full React component tree. Requires the page to have been launched with `--enable react-devtools`. |
| `react inspect <id>` | Inspect one React fiber's props, hooks, state, and source. |
| `react renders start` | Start recording React render activity. |
| `react renders stop [--json]` | Stop render recording and print mount/re-render counts and changed details. |
| `react suspense [--only-dynamic] [--json]` | Classify Suspense boundaries with grouped root-cause recommendations. |
| `vitals [url] [--json]` | Report Core Web Vitals: LCP, CLS, TTFB, FCP, INP, plus React hydration timing when available. |
| `pushstate <url>` | Perform SPA client-side navigation; detects Next.js router pushes and falls back to history navigation events. |
| `removeinitscript <id>` | Remove an init script registered through upstream init-script mechanisms. |

When these diagnostic commands are invoked through the native `agent_browser` tool, structured console, page-error, React, Web Vitals, and SPA outputs render as compact summaries when possible, with large outputs previewed and spilled instead of dumped into context. Large outputs are previewed with a `Full output path:` spill file instead of dumping the entire payload into context.

`trace` and `profiler` share upstream Chrome tracing machinery. Do not run them at the same time. The wrapper tracks owner state it observes in the current Pi session and blocks conflicting starts/stops with "wrapper believes ..." wording because direct upstream CLI use or browser restarts can desynchronize wrapper-local state.

### Batch, auth, confirmations, sessions, chat, dashboard, and setup

| Command | Purpose |
| --- | --- |
| `batch [--bail] ["cmd" ...]` | Execute multiple commands sequentially from args or stdin. |
| `auth save <name> [opts]` | Save an auth profile with options such as `--url`, `--username`, `--password`, or `--password-stdin`. Prefer `auth save <name> --password-stdin` with the tool `stdin` field; avoid putting passwords in `args`. |
| `auth login <name>` | Login using saved credentials. |
| `auth list` | List saved auth profiles. |
| `auth show <name>` | Show auth profile metadata. |
| `auth delete <name>` | Delete an auth profile. |
| `confirm <id>` | Approve a pending action. |
| `deny <id>` | Deny a pending action. |
| `session` | Show current session name. |
| `session list` | List active sessions. |
| `chat <message>` | Send a natural-language instruction. |
| `chat` | Start interactive chat when stdin is a TTY. |
| `dashboard [start]` | Start the dashboard server on the default port `4848`. |
| `dashboard start --port <n>` | Start the dashboard on a specific port. |
| `dashboard stop` | Stop the dashboard server. |
| `install` | Install browser binaries. |
| `install --with-deps` | Install browser binaries plus Linux system dependencies. |
| `upgrade` | Upgrade `agent-browser` to the latest version. |
| `doctor [--fix]` | Diagnose install issues and optionally auto-clean stale files. Use `doctor --offline --quick` for a fast local-only check and `doctor --json` for structured output. |
| `profiles` | List available Chrome profiles. |

When these commands are invoked through the native `agent_browser` tool, structured diagnostic/status outputs are rendered as compact summaries. List-like outputs such as sessions, Chrome profiles, auth profiles, network requests, console messages, and page errors include counts and key fields; large outputs are previewed with a `Full output path:` spill file instead of dumping the entire payload into context. For `network requests`, the wrapper shows status, method, URL, resource/mime type, request id, and, when the installed upstream output includes body-like fields, bounded redacted payload, response, and failure/error snippets. `network request <requestId>` can expose upstream full-detail body fields such as response bodies using the same bounded model-facing preview. Header, cookie, auth, token, and other secret-like fields are not expanded in model-facing text; use upstream HAR or full raw details only when complete data is required.

## Important global flags, config, and environment

### Authentication and session flags

- `--profile <name|path>`: reuse Chrome profile login state or use a persistent custom profile. Environment: `AGENT_BROWSER_PROFILE`.
- `--session <name>`: use an isolated session. Environment: `AGENT_BROWSER_SESSION`.
- `--session-name <name>`: auto-save/restore cookies and local storage by name. Environment: `AGENT_BROWSER_SESSION_NAME`.
- `--state <path>`: load saved auth state from JSON. Environment: `AGENT_BROWSER_STATE`.
- `--auto-connect`: connect to a running Chrome to reuse auth state. Environment: `AGENT_BROWSER_AUTO_CONNECT`.
- `--headers <json>`: apply HTTP headers scoped to the opened URL's origin.
- `--init-script <path>`: register a script before first navigation; repeatable. Environment: `AGENT_BROWSER_INIT_SCRIPTS`.
- `--enable <feature>`: enable built-in init scripts such as `react-devtools`; repeatable or comma-separated. Environment: `AGENT_BROWSER_ENABLE`.

### Browser launch and runtime flags

- `--executable-path <path>`: custom browser executable. Environment: `AGENT_BROWSER_EXECUTABLE_PATH`.
- `--extension <path>`: load browser extensions; repeatable. Environment: `AGENT_BROWSER_EXTENSIONS`.
- `--args <args>`: browser launch args, comma or newline separated. Environment: `AGENT_BROWSER_ARGS`.
- `--user-agent <ua>`: custom user agent. Environment: `AGENT_BROWSER_USER_AGENT`.
- `--proxy <server>`: proxy server URL. Environments: `AGENT_BROWSER_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`.
- `--proxy-bypass <hosts>`: proxy bypass hosts. Environments: `AGENT_BROWSER_PROXY_BYPASS`, `NO_PROXY`.
- `--ignore-https-errors`: ignore HTTPS certificate errors. Environment: `AGENT_BROWSER_IGNORE_HTTPS_ERRORS`.
- `--allow-file-access`: allow `file://` URLs to access local files. Environment: `AGENT_BROWSER_ALLOW_FILE_ACCESS`.
- `--headed`: show the browser window. Environment: `AGENT_BROWSER_HEADED`.
- `--cdp <port>`: connect through Chrome DevTools Protocol.
- `--color-scheme <scheme>`: `dark`, `light`, or `no-preference`. Environment: `AGENT_BROWSER_COLOR_SCHEME`.
- `--download-path <path>`: default browser download directory. Environment: `AGENT_BROWSER_DOWNLOAD_PATH`.
- `--engine <name>`: browser engine, `chrome` by default or `lightpanda`. Environment: `AGENT_BROWSER_ENGINE`.
- `--no-auto-dialog`: disable automatic dismissal of alert/beforeunload dialogs. Environment: `AGENT_BROWSER_NO_AUTO_DIALOG`.

### Output, provider, policy, and AI flags

- `--json`: JSON output. The wrapper injects this automatically for normal tool execution. Environment: `AGENT_BROWSER_JSON`.
- `--annotate`: annotated screenshot with numbered labels and legend. Environment: `AGENT_BROWSER_ANNOTATE`.
- `--screenshot-dir <path>`: default screenshot output directory. Environment: `AGENT_BROWSER_SCREENSHOT_DIR`.
- `--screenshot-quality <n>`: JPEG quality `0-100`. Environment: `AGENT_BROWSER_SCREENSHOT_QUALITY`.
- `--screenshot-format <fmt>`: `png` or `jpeg`. Environment: `AGENT_BROWSER_SCREENSHOT_FORMAT`.
- `--content-boundaries`: wrap page output in boundary markers. Environment: `AGENT_BROWSER_CONTENT_BOUNDARIES`.
- `--max-output <chars>`: truncate page output to N characters. Environment: `AGENT_BROWSER_MAX_OUTPUT`.
- `--allowed-domains <list>`: restrict navigation domains. Environment: `AGENT_BROWSER_ALLOWED_DOMAINS`.
- `--action-policy <path>`: action policy JSON file. Environment: `AGENT_BROWSER_ACTION_POLICY`.
- `--confirm-actions <list>`: action categories requiring confirmation. Environment: `AGENT_BROWSER_CONFIRM_ACTIONS`.
- `--confirm-interactive`: interactive confirmations; auto-denies when stdin is not a TTY. Environment: `AGENT_BROWSER_CONFIRM_INTERACTIVE`.
- `-p, --provider <name>`: provider such as `ios`, `browserbase`, `kernel`, `browseruse`, `browserless`, or `agentcore`. Environment: `AGENT_BROWSER_PROVIDER`.
- `--device <name>`: iOS device name. Environment: `AGENT_BROWSER_IOS_DEVICE`.
- Provider-specific iOS examples from upstream include `agent-browser -p ios device list`, `agent-browser -p ios swipe up`, and `agent-browser -p ios tap @e1`; in pi, pass those tokens through `args` rather than bash.
- `--model <name>`: AI model for `chat`. Environment: `AI_GATEWAY_MODEL`.
- `-v, --verbose`: show tool commands and raw output.
- `-q, --quiet`: show only AI text responses.
- `--debug`: debug output. Environment: `AGENT_BROWSER_DEBUG`.
- `--version`, `-V`: show version.

### Config precedence

`agent-browser` looks for `agent-browser.json` in these locations, from lowest to highest priority:

1. `~/.agent-browser/config.json` for user defaults.
2. `./agent-browser.json` for project overrides.
3. Environment variables, including `AGENT_BROWSER_CONFIG`.
4. CLI flags.

Use `--config <path>` to load a specific config file. Boolean flags accept optional `true` or `false` values, such as `--headed false`, to override config. Browser extensions from user and project configs are merged rather than replaced.

Other useful environment variables include `AGENT_BROWSER_DEFAULT_TIMEOUT`, `AGENT_BROWSER_STREAM_PORT`, `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `AGENT_BROWSER_ENCRYPTION_KEY`, `AGENT_BROWSER_STATE_EXPIRE_DAYS`, `AGENT_BROWSER_IOS_UDID`, `AI_GATEWAY_URL`, and `AI_GATEWAY_API_KEY`.

## Wrapper-specific behavior worth knowing

- The extension may keep following one implicit managed session across later tool calls.
- If launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, or `--enable` would be ignored because that implicit session is already active, retry with `sessionMode: "fresh"`.
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.
- After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.
- If a known session target unexpectedly reports about:blank, agent_browser preserves the prior intended target, best-effort re-selects it when it still exists, and reports exact recovery guidance when it cannot be re-selected.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- Wrapper-spawned commands clamp `AGENT_BROWSER_DEFAULT_TIMEOUT` to 25 seconds and use a 28-second child-process watchdog so one upstream CLI call does not cross the upstream 30-second IPC read-timeout/retry path.
- Oversized snapshots and oversized generic outputs may be compacted in tool content, with the full raw output written to a spill file path shown directly in the tool result. Recent artifact metadata is bounded by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES` (default 100); persisted spill files are separately bounded by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB).
- The wrapper keeps `--help` and `--version` stateless so they do not consume the implicit managed-session slot.

## Generated capability baseline

<!-- agent-browser-capability-baseline:start capability-token-baseline -->
<!-- Generated from scripts/agent-browser-capability-baseline.mjs. Run `npm run docs -- command-reference write` to update. Do not edit manually. -->
<details>
<summary>Generated verifier capability baseline for agent-browser 0.27.0</summary>

This generated block is review data for maintainers. The human-authored reference sections above remain the readable command guide.

#### Upstream help commands sampled
- root help: `agent-browser --help`
- skills help: `agent-browser skills --help`
- skills list: `agent-browser skills list`
- core skill full: `agent-browser skills get core --full`
- tab help: `agent-browser tab --help`
- snapshot help: `agent-browser snapshot --help`
- wait help: `agent-browser wait --help`
- screenshot help: `agent-browser screenshot --help`
- find help: `agent-browser find --help`
- network help: `agent-browser network --help`
- cookies help: `agent-browser cookies --help`
- storage help: `agent-browser storage --help`
- state help: `agent-browser state --help`
- frame help: `agent-browser frame --help`
- dialog help: `agent-browser dialog --help`
- window help: `agent-browser window --help`
- keyboard help: `agent-browser keyboard --help`
- batch help: `agent-browser batch --help`
- auth help: `agent-browser auth --help`
- stream help: `agent-browser stream --help`
- dashboard help: `agent-browser dashboard --help`
- chat help: `agent-browser chat --help`
- doctor help: `agent-browser doctor --help`
- diff help: `agent-browser diff --help`
- trace help: `agent-browser trace --help`
- profiler help: `agent-browser profiler --help`
- record help: `agent-browser record --help`

#### Inventory sections
- Built-in skills: 10 human-doc token(s), 11 upstream token(s)
- Core page, element, navigation, and extraction commands: 38 human-doc token(s), 40 upstream token(s)
- Sessions, state, tabs, frames, dialogs, and windows: 12 human-doc token(s), 8 upstream token(s)
- Network, storage, artifacts, diagnostics, and performance: 29 human-doc token(s), 33 upstream token(s)
- Batch, auth, confirmations, setup, dashboard, and AI commands: 19 human-doc token(s), 17 upstream token(s)
- Global flags, config, providers, policy, and environment: 95 human-doc token(s), 90 upstream token(s)

#### Human-authored doc tokens required
##### Built-in skills
- `skills list`
- `skills get core`
- `skills get core --full`
- `skills get <name>`
- `skills get electron`
- `skills get slack`
- `skills get dogfood`
- `skills get vercel-sandbox`
- `skills get agentcore`
- `skills path [name]`

##### Core page, element, navigation, and extraction commands
- `open <url>`
- `click <sel>`
- `dblclick <sel>`
- `type <sel> <text>`
- `fill <sel> <text>`
- `press <key>`
- `keyboard type <text>`
- `keyboard inserttext <text>`
- `keydown Shift`
- `keyup Shift`
- `hover <sel>`
- `focus <sel>`
- `check <sel>`
- `uncheck <sel>`
- `select <sel> <val...>`
- `drag <src> <dst>`
- `upload <sel> <files...>`
- `download <sel> <path>`
- `scroll <dir> [px]`
- `scrollintoview <sel>`
- `wait <sel|ms>`
- `screenshot [path]`
- `screenshot --full`
- `screenshot --annotate`
- `pdf <path>`
- `snapshot`
- `eval <js>`
- `connect <port|url>`
- `close [--all]`
- `back`
- `forward`
- `reload`
- `pushstate <url>`
- `get <what> [selector]`
- `is <what> <selector>`
- `find <locator> <value> <action>`
- `mouse <action> [args]`
- `set <setting> [value]`

##### Sessions, state, tabs, frames, dialogs, and windows
- `session`
- `session list`
- `state save <path>`
- `state load <path>`
- `tab list`
- `tab new --label <name> [url]`
- `tab <t<N>|label>`
- `frame <selector|main>`
- `dialog accept [text]`
- `dialog dismiss`
- `dialog status`
- `window new`

##### Network, storage, artifacts, diagnostics, and performance
- `network <action>`
- `network route <url> [--abort|--body <json>] [--resource-type <csv>]`
- `network request <requestId>`
- `cookies [get|set|clear]`
- `cookies set --curl <file>`
- `storage <local|session>`
- `diff snapshot`
- `diff screenshot --baseline`
- `diff url <u1> <u2>`
- `trace start|stop [path]`
- `profiler start|stop [path]`
- `record start <path> [url]`
- `record restart <path> [url]`
- `record stop`
- `console [--clear]`
- `errors [--clear]`
- `highlight <sel>`
- `inspect`
- `clipboard <op> [text]`
- `stream enable [--port <n>]`
- `stream disable`
- `stream status`
- `react tree`
- `react inspect <id>`
- `react renders start`
- `react renders stop [--json]`
- `react suspense [--only-dynamic] [--json]`
- `vitals [url] [--json]`
- `removeinitscript <id>`

##### Batch, auth, confirmations, setup, dashboard, and AI commands
- `batch [--bail]`
- `auth save <name>`
- `auth save <name> --password-stdin`
- `auth login <name>`
- `auth list`
- `auth show <name>`
- `auth delete <name>`
- `confirm <id>`
- `deny <id>`
- `chat <message>`
- `dashboard start --port <n>`
- `dashboard stop`
- `install`
- `install --with-deps`
- `upgrade`
- `doctor [--fix]`
- `doctor --offline --quick`
- `doctor --json`
- `profiles`

##### Global flags, config, providers, policy, and environment
- `--profile <name|path>`
- `AGENT_BROWSER_PROFILE`
- `--session <name>`
- `AGENT_BROWSER_SESSION`
- `--session-name <name>`
- `AGENT_BROWSER_SESSION_NAME`
- `--state <path>`
- `AGENT_BROWSER_STATE`
- `--auto-connect`
- `AGENT_BROWSER_AUTO_CONNECT`
- `--headers <json>`
- `--init-script <path>`
- `AGENT_BROWSER_INIT_SCRIPTS`
- `--enable <feature>`
- `AGENT_BROWSER_ENABLE`
- `--executable-path <path>`
- `AGENT_BROWSER_EXECUTABLE_PATH`
- `--extension <path>`
- `AGENT_BROWSER_EXTENSIONS`
- `--args <args>`
- `AGENT_BROWSER_ARGS`
- `--user-agent <ua>`
- `AGENT_BROWSER_USER_AGENT`
- `--proxy <server>`
- `AGENT_BROWSER_PROXY`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- `--proxy-bypass <hosts>`
- `AGENT_BROWSER_PROXY_BYPASS`
- `NO_PROXY`
- `--ignore-https-errors`
- `AGENT_BROWSER_IGNORE_HTTPS_ERRORS`
- `--allow-file-access`
- `AGENT_BROWSER_ALLOW_FILE_ACCESS`
- `--headed`
- `AGENT_BROWSER_HEADED`
- `--cdp <port>`
- `--color-scheme <scheme>`
- `AGENT_BROWSER_COLOR_SCHEME`
- `--download-path <path>`
- `AGENT_BROWSER_DOWNLOAD_PATH`
- `--engine <name>`
- `AGENT_BROWSER_ENGINE`
- `--no-auto-dialog`
- `AGENT_BROWSER_NO_AUTO_DIALOG`
- `--json`
- `AGENT_BROWSER_JSON`
- `--annotate`
- `AGENT_BROWSER_ANNOTATE`
- `--screenshot-dir <path>`
- `AGENT_BROWSER_SCREENSHOT_DIR`
- `--screenshot-quality <n>`
- `AGENT_BROWSER_SCREENSHOT_QUALITY`
- `--screenshot-format <fmt>`
- `AGENT_BROWSER_SCREENSHOT_FORMAT`
- `--content-boundaries`
- `AGENT_BROWSER_CONTENT_BOUNDARIES`
- `--max-output <chars>`
- `AGENT_BROWSER_MAX_OUTPUT`
- `--allowed-domains <list>`
- `AGENT_BROWSER_ALLOWED_DOMAINS`
- `--action-policy <path>`
- `AGENT_BROWSER_ACTION_POLICY`
- `--confirm-actions <list>`
- `AGENT_BROWSER_CONFIRM_ACTIONS`
- `--confirm-interactive`
- `AGENT_BROWSER_CONFIRM_INTERACTIVE`
- `-p, --provider <name>`
- `AGENT_BROWSER_PROVIDER`
- `browserbase`
- `kernel`
- `browseruse`
- `browserless`
- `agentcore`
- `--device <name>`
- `AGENT_BROWSER_IOS_DEVICE`
- `agent-browser -p ios device list`
- `agent-browser -p ios swipe up`
- `agent-browser -p ios tap @e1`
- `--model <name>`
- `AI_GATEWAY_MODEL`
- `-v, --verbose`
- `-q, --quiet`
- `--debug`
- `AGENT_BROWSER_DEBUG`
- `AGENT_BROWSER_CONFIG`
- `AGENT_BROWSER_DEFAULT_TIMEOUT`
- `AGENT_BROWSER_STREAM_PORT`
- `AGENT_BROWSER_IDLE_TIMEOUT_MS`
- `AGENT_BROWSER_ENCRYPTION_KEY`
- `AGENT_BROWSER_STATE_EXPIRE_DAYS`
- `AGENT_BROWSER_IOS_UDID`
- `AI_GATEWAY_URL`
- `AI_GATEWAY_API_KEY`

#### Upstream help tokens expected
##### Built-in skills
- root help: `skills get core --full`
- skills help: `get <name> --full`
- skills list: `core`
- skills list: `electron`
- skills list: `slack`
- skills list: `dogfood`
- skills list: `vercel-sandbox`
- skills list: `agentcore`
- core skill full: `agent-browser frame @e3`
- core skill full: `agent-browser dialog accept`
- core skill full: `agent-browser state save ./auth.json`

##### Core page, element, navigation, and extraction commands
- root help: `open <url>`
- root help: `click <sel>`
- root help: `dblclick <sel>`
- root help: `type <sel> <text>`
- root help: `fill <sel> <text>`
- root help: `press <key>`
- root help: `keyboard type <text>`
- root help: `keyboard inserttext <text>`
- root help: `hover <sel>`
- root help: `focus <sel>`
- root help: `check <sel>`
- root help: `uncheck <sel>`
- root help: `select <sel> <val...>`
- root help: `drag <src> <dst>`
- root help: `upload <sel> <files...>`
- root help: `download <sel> <path>`
- root help: `scroll <dir> [px]`
- root help: `scrollintoview <sel>`
- root help: `wait <sel|ms>`
- root help: `screenshot [path]`
- root help: `pdf <path>`
- root help: `snapshot`
- root help: `eval <js>`
- root help: `connect <port|url>`
- root help: `close [--all]`
- root help: `back`
- root help: `forward`
- root help: `reload`
- root help: `pushstate <url>`
- root help: `Get Info:  agent-browser get <what> [selector]`
- root help: `Check State:  agent-browser is <what> <selector>`
- root help: `Find Elements:  agent-browser find <locator> <value> <action> [text]`
- root help: `Mouse:  agent-browser mouse <action> [args]`
- root help: `Browser Settings:  agent-browser set <setting> [value]`
- keyboard help: `type <text>`
- keyboard help: `inserttext <text>`
- screenshot help: `--full, -f`
- screenshot help: `--annotate`
- find help: `role <role>`
- find help: `testid <id>`

##### Sessions, state, tabs, frames, dialogs, and windows
- root help: `session list`
- state help: `save <path>`
- state help: `load <path>`
- tab help: `new --label <name> [url]`
- tab help: `Stable tab ids`
- frame help: `frame <selector|main>`
- dialog help: `dialog <accept|dismiss|status> [text]`
- window help: `window <operation>`

##### Network, storage, artifacts, diagnostics, and performance
- root help: `network <action>`
- root help: `--resource-type <csv>`
- root help: `cookies [get|set|clear]`
- root help: `cookies set --curl <file>`
- root help: `storage <local|session>`
- root help: `diff snapshot`
- root help: `diff screenshot --baseline`
- root help: `trace start|stop [path]`
- root help: `profiler start|stop [path]`
- root help: `record start <path> [url]`
- root help: `record stop`
- root help: `console [--clear]`
- root help: `errors [--clear]`
- root help: `highlight <sel>`
- root help: `inspect`
- root help: `clipboard <op> [text]`
- root help: `stream enable [--port <n>]`
- root help: `stream disable`
- root help: `stream status`
- root help: `react tree`
- root help: `react inspect <id>`
- root help: `react renders start`
- root help: `react renders stop [--json]`
- root help: `react suspense [--only-dynamic] [--json]`
- root help: `vitals [url] [--json]`
- root help: `removeinitscript <id>`
- network help: `request <requestId>`
- network help: `har <start|stop>`
- storage help: `set <key> <value>`
- diff help: `diff screenshot --baseline <f>`
- trace help: `trace <operation> [path]`
- profiler help: `--categories <list>`
- record help: `record restart <path.webm> [url]`

##### Batch, auth, confirmations, setup, dashboard, and AI commands
- root help: `batch [--bail]`
- root help: `auth save <name>`
- root help: `auth login <name>`
- root help: `confirm <id>`
- root help: `deny <id>`
- root help: `chat <message>`
- root help: `dashboard start --port <n>`
- root help: `install --with-deps`
- root help: `upgrade`
- root help: `doctor [--fix]`
- root help: `profiles`
- batch help: `--bail`
- auth help: `--password-stdin`
- dashboard help: `dashboard [start|stop] [options]`
- chat help: `chat <message>`
- doctor help: `--offline`
- doctor help: `--json`

##### Global flags, config, providers, policy, and environment
- root help: `--profile <name|path>`
- root help: `AGENT_BROWSER_PROFILE`
- root help: `--session <name>`
- root help: `AGENT_BROWSER_SESSION`
- root help: `--session-name <name>`
- root help: `AGENT_BROWSER_SESSION_NAME`
- root help: `--state <path>`
- root help: `AGENT_BROWSER_STATE`
- root help: `--auto-connect`
- root help: `AGENT_BROWSER_AUTO_CONNECT`
- root help: `--headers <json>`
- root help: `--init-script <path>`
- root help: `AGENT_BROWSER_INIT_SCRIPTS`
- root help: `--enable <feature>`
- root help: `AGENT_BROWSER_ENABLE`
- root help: `--executable-path <path>`
- root help: `AGENT_BROWSER_EXECUTABLE_PATH`
- root help: `--extension <path>`
- root help: `AGENT_BROWSER_EXTENSIONS`
- root help: `--args <args>`
- root help: `AGENT_BROWSER_ARGS`
- root help: `--user-agent <ua>`
- root help: `AGENT_BROWSER_USER_AGENT`
- root help: `--proxy <server>`
- root help: `AGENT_BROWSER_PROXY`
- root help: `HTTP_PROXY / HTTPS_PROXY`
- root help: `ALL_PROXY`
- root help: `--proxy-bypass <hosts>`
- root help: `AGENT_BROWSER_PROXY_BYPASS`
- root help: `NO_PROXY`
- root help: `--ignore-https-errors`
- root help: `AGENT_BROWSER_IGNORE_HTTPS_ERRORS`
- root help: `--allow-file-access`
- root help: `AGENT_BROWSER_ALLOW_FILE_ACCESS`
- root help: `--headed`
- root help: `AGENT_BROWSER_HEADED`
- root help: `--cdp <port>`
- root help: `--color-scheme <scheme>`
- root help: `AGENT_BROWSER_COLOR_SCHEME`
- root help: `--download-path <path>`
- root help: `AGENT_BROWSER_DOWNLOAD_PATH`
- root help: `--engine <name>`
- root help: `AGENT_BROWSER_ENGINE`
- root help: `--no-auto-dialog`
- root help: `AGENT_BROWSER_NO_AUTO_DIALOG`
- root help: `--json`
- root help: `AGENT_BROWSER_JSON`
- root help: `--annotate`
- root help: `AGENT_BROWSER_ANNOTATE`
- root help: `--screenshot-dir <path>`
- root help: `AGENT_BROWSER_SCREENSHOT_DIR`
- root help: `--screenshot-quality <n>`
- root help: `AGENT_BROWSER_SCREENSHOT_QUALITY`
- root help: `--screenshot-format <fmt>`
- root help: `AGENT_BROWSER_SCREENSHOT_FORMAT`
- root help: `--content-boundaries`
- root help: `AGENT_BROWSER_CONTENT_BOUNDARIES`
- root help: `--max-output <chars>`
- root help: `AGENT_BROWSER_MAX_OUTPUT`
- root help: `--allowed-domains <list>`
- root help: `AGENT_BROWSER_ALLOWED_DOMAINS`
- root help: `--action-policy <path>`
- root help: `AGENT_BROWSER_ACTION_POLICY`
- root help: `--confirm-actions <list>`
- root help: `AGENT_BROWSER_CONFIRM_ACTIONS`
- root help: `--confirm-interactive`
- root help: `AGENT_BROWSER_CONFIRM_INTERACTIVE`
- root help: `--provider <name>`
- root help: `AGENT_BROWSER_PROVIDER`
- root help: `agent-browser -p ios device list`
- root help: `agent-browser -p ios swipe up`
- root help: `agent-browser -p ios tap @e1`
- root help: `--device <name>`
- root help: `AGENT_BROWSER_IOS_DEVICE`
- root help: `--model <name>`
- root help: `AI_GATEWAY_MODEL`
- root help: `--verbose`
- root help: `--quiet`
- root help: `--debug`
- root help: `AGENT_BROWSER_DEBUG`
- root help: `--config <path>`
- root help: `AGENT_BROWSER_CONFIG`
- root help: `AGENT_BROWSER_DEFAULT_TIMEOUT`
- root help: `AGENT_BROWSER_STREAM_PORT`
- root help: `AGENT_BROWSER_IDLE_TIMEOUT_MS`
- root help: `AGENT_BROWSER_ENCRYPTION_KEY`
- root help: `AGENT_BROWSER_STATE_EXPIRE_DAYS`
- root help: `AGENT_BROWSER_IOS_UDID`
- root help: `AI_GATEWAY_URL`
- root help: `AI_GATEWAY_API_KEY`

</details>
<!-- agent-browser-capability-baseline:end capability-token-baseline -->

## Maintenance rule

Whenever the upstream `agent-browser` binary version changes in this project:

1. run `agent-browser --version`, `agent-browser --help`, `agent-browser tab --help`, `agent-browser snapshot --help`, and `agent-browser wait --help`
2. update the canonical metadata in `scripts/agent-browser-capability-baseline.mjs`
3. update the human-authored command reference sections if command semantics or recommended workflows changed
4. run `npm run docs -- command-reference write` to regenerate capability baseline blocks; do not manually edit generated blocks
5. run `npm run verify -- command-reference`
6. update tool prompt guidance if the recommended agent workflow changed
7. update README and release docs if user-visible behavior changed
8. validate the extension still exposes local documentation that is at least as usable as the blocked direct-binary path for normal agent work
