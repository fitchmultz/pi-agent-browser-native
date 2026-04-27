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
<!-- Generated from scripts/agent-browser-capability-baseline.mjs. Run `npm run docs:command-reference:write` to update. Do not edit manually. -->
This reference is baselined to the locally installed `agent-browser 0.26.0` command/help surface. Upstream `agent-browser` remains the source of truth for command semantics; this file is the local fallback for Pi agent sessions where direct binary help is blocked or discouraged.

The lightweight drift check is `npm run verify:command-reference`. Run it whenever the installed upstream `agent-browser` version changes or this reference is edited.
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
- `stdin`: only for `batch` and `eval --stdin`; other command/stdin combinations are rejected before `agent-browser` is launched.
- `sessionMode`:
  - `"auto"` reuses the extension-managed session when possible.
  - `"fresh"` rotates that managed session to a fresh upstream launch so launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, or `--auto-connect` apply.

## Recommended workflow

Keep routine browser work simple: open a page, inspect it with `snapshot -i`, interact with current `@ref` values from that snapshot, then inspect again. Re-run `snapshot -i` after navigation, scrolling, rerendering, or other major DOM changes because refs can become stale.

### Normal browse flow

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i", "--urls"] }
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
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
{ "args": ["scrollintoview", "@e12"] }
{ "args": ["snapshot", "-i"] }
```

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

A successful wait-based download renders a readable summary such as `Download completed: /tmp/report.csv` and exposes top-level `details.savedFilePath` plus `details.savedFile` for non-batch calls. With the current upstream `agent-browser 0.26.0`, `wait --download <path>` may report the requested path before this environment can verify that the file was persisted there. Treat `details.savedFilePath` as upstream-reported metadata unless `details.artifacts[].exists` is true. Upstream tracking: [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300).

### Download, screenshot, and PDF files

```json
{ "args": ["download", "@e5", "/tmp/report.pdf"] }
{ "args": ["screenshot", "/tmp/page.png"] }
{ "args": ["pdf", "/tmp/page.pdf"] }
```

Prefer `download <selector> <path>` when the target element itself is the downloadable link/control. Use `click` plus `wait --download [path]` when a previous action starts the download indirectly.

Wrapper result rendering is metadata-first for saved files:
- screenshots return a saved-path summary, structured `details.artifacts` metadata, and an inline image attachment when safe
- downloads, PDFs, `wait --download` files, traces, CPU profiles, WebM recordings, and path-bearing HAR captures return concise saved-path summaries plus structured `details.artifacts` metadata without inlining large files
- `batch` keeps each step's artifacts in `details.batchSteps[].artifacts` and aggregates them in top-level `details.artifacts` in step order

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

| Command | Purpose |
| --- | --- |
| `skills list` | List available CLI-bundled skills. |
| `skills get core` | Print the core usage guide. |
| `skills get core --full` | Print the full version-matched core command reference and templates. |
| `skills get <name>` | Load a specialized skill such as `electron` or `slack`. |
| `skills path [name]` | Print a skill directory path. |

### Core page and element commands

| Command | Purpose |
| --- | --- |
| `open <url>` | Navigate to a URL. |
| `click <sel>` | Click an element or `@ref`. |
| `dblclick <sel>` | Double-click an element. |
| `type <sel> <text>` | Type into an element. |
| `fill <sel> <text>` | Clear and fill an element. |
| `press <key>` | Press a key such as `Enter`, `Tab`, or `Control+a`. |
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

### Session and inspection commands

| Command | Purpose |
| --- | --- |
| `session` | Show current session name. |
| `session list` | List active sessions. |
| `close` | Close the current browser session. |
| `close --all` | Close every session. |

<!-- agent-browser-playbook:start inspection -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs:playbook:write` to update. -->
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
| `network <action>` | `route <url> [--abort|--body <json>]`, `unroute [url]`, `requests [--clear] [--filter <pattern>]`, `request <requestId>`, `har <start|stop> [path]`. |
| `cookies [get|set|clear]` | Manage cookies. `set` supports `--url`, `--domain`, `--path`, `--httpOnly`, `--secure`, `--sameSite`, and `--expires`. |
| `storage <local|session>` | Manage web storage. |

### Tabs

Stable tab ids look like `t1`, `t2`, and `t3`. Optional user labels such as `docs` or `app` are interchangeable with ids wherever a tab reference is accepted.

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
| `wait <ms>` | Wait for a fixed number of milliseconds. |
| `wait --url <pattern>` | Wait for the URL to match a pattern. |
| `wait --load <state>` | Wait for load state: `load`, `domcontentloaded`, or `networkidle`. |
| `wait --fn <expression>` | Wait for a JavaScript expression to become truthy. |
| `wait --text <text>` | Wait for text to appear on the page. |
| `wait --download [path]` | Wait for a download started by a previous action and optionally save it to `path`; successful wrapper results include upstream-reported `savedFilePath`/`savedFile`, while `details.artifacts[].exists` is the wrapper's on-disk verification signal. |
| `wait --download [path] --timeout <ms>` | Set download-start timeout in milliseconds. |
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
| `record start <path> [url]` | Start WebM video recording. |
| `record stop` | Stop and save video. |
| `console [--clear]` | View or clear console logs. |
| `errors [--clear]` | View or clear page errors. |
| `highlight <sel>` | Highlight an element. |
| `inspect` | Open Chrome DevTools for the active page. |
| `clipboard <op> [text]` | Read/write clipboard: `read`, `write`, `copy`, `paste`. |
| `stream enable [--port <n>]` | Start runtime WebSocket streaming for this session. |
| `stream disable` | Stop runtime WebSocket streaming. |
| `stream status` | Show streaming status and active port. |

When these diagnostic commands are invoked through the native `agent_browser` tool, structured console and page-error outputs render as compact summaries with counts and key fields. Large outputs are previewed with a `Full output path:` spill file instead of dumping the entire payload into context.

### Batch, auth, confirmations, sessions, chat, dashboard, and setup

| Command | Purpose |
| --- | --- |
| `batch [--bail] ["cmd" ...]` | Execute multiple commands sequentially from args or stdin. |
| `auth save <name> [opts]` | Save an auth profile with options such as `--url`, `--username`, `--password`, or `--password-stdin`. |
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
| `doctor [--fix]` | Diagnose install issues and optionally auto-clean stale files. |
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

- `--json`: JSON output. The wrapper injects this automatically for normal tool execution.
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
- If launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, or `--auto-connect` would be ignored because that implicit session is already active, retry with `sessionMode: "fresh"`.
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs:playbook:write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.
- After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- Oversized snapshots and oversized generic outputs may be compacted in tool content, with the full raw output written to a spill file path shown directly in the tool result. Recent artifact metadata is bounded by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES` (default 100); persisted spill files are separately bounded by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB).
- The wrapper keeps `--help` and `--version` stateless so they do not consume the implicit managed-session slot.

## Generated capability baseline

<!-- agent-browser-capability-baseline:start capability-token-baseline -->
<!-- Generated from scripts/agent-browser-capability-baseline.mjs. Run `npm run docs:command-reference:write` to update. Do not edit manually. -->
<details>
<summary>Generated verifier capability baseline for agent-browser 0.26.0</summary>

This generated block is review data for maintainers. The human-authored reference sections above remain the readable command guide.

#### Upstream help commands sampled
- root help: `agent-browser --help`
- tab help: `agent-browser tab --help`
- snapshot help: `agent-browser snapshot --help`
- wait help: `agent-browser wait --help`

#### Upstream help tokens expected
- root help: `skills`
- root help: `keyboard`
- root help: `scroll`
- root help: `scrollintoview`
- root help: `connect`
- root help: `is`
- root help: `find`
- root help: `mouse`
- root help: `set`
- root help: `network`
- root help: `cookies [get|set|clear]`
- root help: `storage`
- root help: `diff snapshot`
- root help: `trace start|stop [path]`
- root help: `profiler start|stop [path]`
- root help: `record start <path> [url]`
- root help: `console [--clear]`
- root help: `errors [--clear]`
- root help: `highlight <sel>`
- root help: `inspect`
- root help: `clipboard <op> [text]`
- root help: `stream enable [--port <n>]`
- root help: `auth save <name>`
- root help: `confirm <id>`
- root help: `deny <id>`
- root help: `chat <message>`
- root help: `dashboard start --port <n>`
- root help: `install --with-deps`
- root help: `upgrade`
- root help: `doctor [--fix]`
- root help: `profiles`
- snapshot help: `-u, --urls`
- wait help: `--download [path]`
- tab help: `new --label <name> [url]`

</details>
<!-- agent-browser-capability-baseline:end capability-token-baseline -->

## Maintenance rule

Whenever the upstream `agent-browser` binary version changes in this project:

1. run `agent-browser --version`, `agent-browser --help`, `agent-browser tab --help`, `agent-browser snapshot --help`, and `agent-browser wait --help`
2. update the canonical metadata in `scripts/agent-browser-capability-baseline.mjs`
3. update the human-authored command reference sections if command semantics or recommended workflows changed
4. run `npm run docs:command-reference:write` to regenerate capability baseline blocks; do not manually edit generated blocks
5. run `npm run verify:command-reference`
6. update tool prompt guidance if the recommended agent workflow changed
7. update README and release docs if user-visible behavior changed
8. validate the extension still exposes local documentation that is at least as usable as the blocked direct-binary path for normal agent work
