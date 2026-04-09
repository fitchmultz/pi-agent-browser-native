# Tool contract

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)

## V1 tool

V1 should expose one primary native tool:

- `agent_browser`

## Why this tool shape

This keeps the integration:
- thin
- powerful
- low-drift
- low-maintenance
- close to upstream `agent-browser`

It also keeps the main UX where it belongs: the agent invokes the tool directly instead of relying on bash or a large manual command surface.

The tool guidance should be written for task discovery first, not wrapper implementation first. That means the description should emphasize browser use cases like web research, reading live docs, clicking, filling, screenshots, extraction, and authenticated/profile-based workflows. Low-level wrapper details like `stdin` and exact CLI args belong in the schema and guidelines, not the lead description.

The tool also needs an operating playbook, not just a capability list. The model should not have to rediscover basics each session. Guidance should explicitly encode the normal browser workflow (`open` -> `snapshot -i` -> interact -> re-snapshot), the authenticated-content workflow (prefer `--profile Default` on the first browser call and let the implicit session carry continuity; use `--auto-connect` as a fallback when profile reuse is unavailable), and the preferred recovery path when a session opens on the wrong tab or an action changes origin unexpectedly (`tab list` / `tab <n>` / `snapshot -i`). It should also discourage inventing fixed explicit session names for routine tasks, because those names leak stale browser state across otherwise unrelated `pi` sessions. For read-only browsing tasks, guidance should prefer answering from the current page state first: use the current snapshot, structured ref labels, or `eval --stdin` on the current page before navigating into media viewers, detail routes, or other new pages unless the current view lacks the needed information. When using `eval --stdin` for extraction, return the intended value instead of relying on `console.log` as the primary result channel.

## Parameters

```json
{
  "args": ["open", "https://example.com"],
  "stdin": "optional raw stdin content",
  "useActiveSession": true
}
```

### `args`

- type: `string[]`
- required
- exact CLI args passed after `agent-browser`
- no shell operators
- do not include the binary name

Examples:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
{ "args": ["click", "@e2"] }
{ "args": ["tab", "list"] }
```

### `stdin`

- type: `string`
- optional
- raw stdin for commands like `eval --stdin` and `batch`

Examples:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
```

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

### `useActiveSession`

- type: `boolean`
- optional
- default: `true`

Behavior:
- if `args` already include `--session`, upstream session choice wins
- otherwise the extension prepends its implicit active session when `useActiveSession` is `true`

## Wrapper behavior

The extension should:
- inject `--json`
- invoke `agent-browser` directly, not through a shell
- parse JSON output into tool details
- handle observed JSON result shapes, including the array returned by `batch --json`
- allow plain-text fallback for inspection commands like `--help` and `--version`
- discourage exploratory inspection calls unless the user explicitly asks or debugging requires them
- deflect normal-task `--help` inspection back into the standard browser workflow instead of letting the model relearn the tool from scratch each session
- surface stderr and non-zero exits clearly
- attach images when the result points to a screenshot-like artifact

## Result shape

### Content

Primary content should be:
- useful result text for the model, not just a status line
- an image attachment when relevant

Examples:
- `snapshot` should include the actual snapshot text
- `tab list` should include a readable tab summary
- `screenshot` should include the saved-path summary plus the inline image attachment when available

### Details

Recommended details:

```json
{
  "args": ["snapshot", "-i"],
  "effectiveArgs": ["--session", "pi-abc123", "--json", "snapshot", "-i"],
  "sessionName": "pi-abc123",
  "usedImplicitSession": true,
  "data": {
    "origin": "https://example.com/",
    "refs": {
      "e1": { "name": "Example Domain", "role": "heading" }
    },
    "snapshot": "- heading \"Example Domain\" [level=1, ref=e1]"
  }
}
```

## High-value result rendering

"Rendering" here means how results appear inside `pi`, not embedding a browser UI.

Worth doing in v1:
- screenshots → inline image attachment
- snapshots → origin + ref count + compact preview
- tab lists → compact summary/table
- stream status → enabled/connected/port summary

## Missing binary behavior

If `agent-browser` is not on `PATH`, fail with a message that:
- says `agent-browser` is required
- says this project does not bundle it
- points to upstream install/docs

## Session behavior

- maintain one implicit active session per `pi` session for the common path
- derive that implicit session from the official `pi` session id
- respect explicit upstream `--session` with minimal interference
- treat the implicit session as extension-managed convenience state
- on normal `pi` shutdown, best-effort close the implicit session
- set an idle timeout on implicit sessions so abandoned daemons eventually self-clean
- treat explicit upstream session choices like `--session`, `--profile`, `--session-name`, and `--cdp` as user-managed
- pass explicit `--profile` straight through to upstream `agent-browser`; no profile-cloning or isolation layer is added in v1

## Non-goals

- no giant action enum mirroring the whole upstream CLI
- no support for older `agent-browser` versions
- no compatibility shims
- no embedded browser UI inside `pi`
