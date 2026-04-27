# Agent Browser command reference

Related docs:
- [`../README.md`](../README.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`RELEASE.md`](RELEASE.md)

## Purpose

Provide a local, repo-readable command reference for the native `agent_browser` tool.

This project intentionally blocks normal `agent-browser` bash usage in most agent sessions, so the agent still needs an accessible local equivalent of the upstream command surface. This document is the durable reference the agent can read inside the repository without calling the binary directly.

## Core mental model

Tool parameters:

```json
{
  "args": ["open", "https://example.com"],
  "stdin": "optional raw stdin content",
  "sessionMode": "auto"
}
```

- `args`: exact `agent-browser` CLI tokens after the binary name
- `stdin`: only for `batch` and `eval --stdin`; other command/stdin combinations are rejected before `agent-browser` is launched
- `sessionMode`:
  - `"auto"` reuse the extension-managed session when possible
  - `"fresh"` rotate that managed session to a fresh upstream launch so launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, or `--auto-connect` apply

## Recommended workflow

### Normal browse flow

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

### Extract page data

```json
{ "args": ["get", "title"] }
{ "args": ["get", "url"] }
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
```

### Run a multi-step flow in one browser invocation

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

### Switch from an already-active implicit session to a fresh profiled launch

```json
{
  "args": ["--profile", "Default", "open", "https://mail.google.com"],
  "sessionMode": "fresh"
}
```

## High-value commands

### Open and navigation

- `open <url>`
- `goto <url>`
- `navigate <url>`
- `back`
- `forward`
- `reload`

Examples:

```json
{ "args": ["open", "https://react.dev"] }
{ "args": ["reload"] }
```

### Snapshot and page inspection

- `snapshot`
- `snapshot -i` interactive elements only
- `snapshot -c` compact tree
- `snapshot -d <n>` limit depth
- `snapshot -s <selector>` scope to one subtree

Examples:

```json
{ "args": ["snapshot", "-i"] }
{ "args": ["snapshot", "-i", "-s", "main"] }
```

### Element interaction

- `click <selector-or-@ref>`
- `dblclick <selector-or-@ref>`
- `hover <selector-or-@ref>`
- `focus <selector-or-@ref>`
- `type <selector-or-@ref> <text>`
- `fill <selector-or-@ref> <text>`
- `press <key>`
- `check <selector-or-@ref>`
- `uncheck <selector-or-@ref>`
- `select <selector-or-@ref> <value...>`
- `drag <src> <dst>`
- `upload <selector-or-@ref> <files...>`

Examples:

```json
{ "args": ["click", "@e12"] }
{ "args": ["fill", "#email", "user@example.com"] }
{ "args": ["press", "Enter"] }
```

### Downloads and saved files

Use the purpose-built command when a click should save a file.

- `download <selector-or-@ref> <path>`
- `pdf <path>`
- `screenshot [path]`

Examples:

```json
{ "args": ["download", "@e5", "/tmp/report.pdf"] }
{ "args": ["pdf", "/tmp/page.pdf"] }
{ "args": ["screenshot", "/tmp/page.png"] }
```

Rules:

- Prefer `download <selector> <path>` over `click` when the goal is a downloaded file on disk.
- Prefer explicit output paths when the calling task needs to read, move, or attach the saved file later.
- Use `--download-path <dir>` on the first launch when many downloads should land in one directory.

### Read page state

`get <subcommand>` supports:

- `title`
- `url`
- `text <selector>`
- `html <selector>`
- `value <selector>`
- `attr <selector> <name>`
- `count <selector>`
- `box <selector>`
- `styles <selector>`
- `cdp-url`

Examples:

```json
{ "args": ["get", "title"] }
{ "args": ["get", "text", "main"] }
{ "args": ["get", "attr", "a.primary", "href"] }
```

### JavaScript evaluation

- `eval <js>`
- `eval --stdin` with JavaScript in `stdin`

Example:

```json
{ "args": ["eval", "--stdin"], "stdin": "Array.from(document.querySelectorAll('a')).map((a) => a.href)" }
```

Rules:

- Return the intended value instead of relying on `console.log`.
- Scope DOM queries to the relevant route, component, or element.
- Prefer `snapshot -i` refs first when the task is interaction-heavy.

### Wait

- `wait <ms>`
- `wait <selector>`
- use explicit variants like `--load <state>`, `--url <matcher>`, `--fn <js>`, or `--text <matcher>` when needed

Important:

- bare `wait --load` is incomplete; `--load` needs a state value

### Tabs

- `tab list`
- `tab <tab-id-or-label>`
- `tab new`
- `tab close`

Examples:

```json
{ "args": ["tab", "list"] }
{ "args": ["tab", "t3"] }
```

Use this when:

- a restored profile tab steals focus
- an interaction opens a new tab
- the browser lands on the wrong page unexpectedly

### Batch

- `batch`
- `batch --bail`

Example:

```json
{ "args": ["batch", "--bail"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"],[\"click\",\"@e2\"]]" }
```

### Session and inspection commands

- `session`
- `session list`
- `close`
- `close --all`
<!-- agent-browser-playbook:start inspection -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs:playbook:write` to update. -->
Native inspection calls use the `agent_browser` tool shape, not shell-like direct-binary commands:

- { "args": ["--help"] }
- { "args": ["--version"] }

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, or auto-connect launches.
<!-- agent-browser-playbook:end inspection -->

## Important global flags

- `--profile <name|path>` reuse Chrome profile state
- `--session <name>` explicit upstream session name
- `--session-name <name>` upstream saved auth/session state name
- `--cdp <port-or-url>` connect to an existing browser
- `--state <path>` load upstream saved state/auth data
- `--auto-connect` attach to an already-running browser/debug endpoint according to upstream behavior
- `--headed` show the browser window
- `--download-path <dir>` default download directory
- `--user-agent <ua>` custom user agent
- `--json` injected by the wrapper automatically for normal tool execution

## Wrapper-specific behavior worth knowing

- The extension may keep following one implicit managed session across later tool calls.
- If launch-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, or `--auto-connect` would be ignored because that implicit session is already active, retry with `sessionMode: "fresh"`.
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs:playbook:write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.
- After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- Oversized snapshots and oversized generic outputs may be compacted in tool content, with the full raw output written to a spill file path shown directly in the tool result.

## Maintenance rule

Whenever the upstream `agent-browser` binary version changes in this project:

1. re-check the upstream command/help surface
2. update this local command reference if anything changed
3. update tool prompt guidance if the recommended agent workflow changed
4. update README and release docs if the user-visible behavior changed
5. validate the extension still exposes local documentation that is at least as usable as the blocked direct-binary path for normal agent work
