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
- surface stderr and non-zero exits clearly
- attach images when the result points to a screenshot-like artifact

## Result shape

### Content

Primary content should be:
- a concise text summary
- an image attachment when relevant

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
- respect explicit upstream `--session` with minimal interference
- only auto-close extension-owned implicit sessions on shutdown in v1

## Non-goals

- no giant action enum mirroring the whole upstream CLI
- no support for older `agent-browser` versions
- no compatibility shims
- no embedded browser UI inside `pi`
