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

The tool also needs an operating playbook, not just a capability list. The model should not have to rediscover basics each session. Guidance should explicitly encode the normal browser workflow (`open` -> `snapshot -i` -> interact -> re-snapshot), the authenticated-content workflow (prefer `--profile Default` on the first browser call and let the implicit session carry continuity; use `--auto-connect` as a fallback when profile reuse is unavailable), and the preferred recovery path when a session opens on the wrong tab, an action changes origin unexpectedly, or an `open` call returns blocked/blank/unexpected results (`tab list` / `tab <n>` / `snapshot -i` before retrying different URLs or fallback strategies). It should also discourage inventing fixed explicit session names for routine tasks, because those names leak stale browser state across otherwise unrelated `pi` sessions. For read-only browsing tasks, guidance should prefer answering from the current page state first: use the current snapshot, structured ref labels, or `eval --stdin` on the current page before navigating into media viewers, detail routes, or other new pages unless the current view lacks the needed information. When using `eval --stdin`, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics. When using `eval --stdin` for extraction, return the intended value instead of relying on `console.log` as the primary result channel.

## Parameters

```json
{
  "args": ["open", "https://example.com"],
  "stdin": "optional raw stdin content",
  "sessionMode": "auto"
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

### `sessionMode`

- type: `"auto" | "fresh"`
- optional
- default: `"auto"`

Behavior:
- if `args` already include `--session`, upstream session choice wins
- `"auto"` prepends the current extension-managed active session when appropriate
- `"fresh"` rotates that managed session to a fresh upstream launch so startup-scoped flags like `--profile`, `--session-name`, or `--cdp` apply and later default calls follow the new browser

Recommended use:
- use `"auto"` for the common browse/snapshot/click flow inside one `pi` session
- use `"fresh"` when switching from an already-active implicit session to a new profile/debug/auth launch without inventing a fixed explicit session name

## Wrapper behavior

The extension should:
- inject `--json`
- invoke `agent-browser` directly, not through a shell
- parse JSON output into tool details
- handle observed JSON result shapes, including the array returned by `batch --json`
- allow plain-text fallback for inspection commands like `--help` and `--version`
- support those inspection commands unconditionally so the tool contract stays local and predictable
- still describe normal browser workflows in guidance so models do not overuse inspection for routine tasks
- surface stderr and non-zero exits clearly
- attach images when the result points to a screenshot-like artifact

## Result shape

### Content

Primary content should be:
- useful result text for the model, not just a status line
- an image attachment when relevant
- browser-aware compacting for oversized snapshots so the model gets a concise actionable view before raw page noise
- compact snapshots should be main-content-first: prefer the primary content block and nearby sections over top-of-page chrome, ads, or unrelated sidebars when those can be distinguished from the snapshot tree

Examples:
- small `snapshot` results should include the actual snapshot text
- oversized `snapshot` results should switch to a compact view that preserves the primary content, nearby sections, and a trimmed set of high-value refs, while exposing the full raw snapshot path via `details.fullOutputPath`
- successful navigation actions like `click`, `back`, `forward`, and `reload` should include a lightweight post-action title/url summary when the wrapper can address the active session
- `tab list` should include a readable tab summary
- `screenshot` should include the saved-path summary plus the inline image attachment when available

### Details

Recommended details:

```json
{
  "args": ["snapshot", "-i"],
  "effectiveArgs": ["--json", "--session", "pi-abc123", "snapshot", "-i"],
  "command": "snapshot",
  "sessionMode": "auto",
  "sessionName": "pi-abc123",
  "usedImplicitSession": true,
  "data": {
    "origin": "https://example.com/",
    "refs": {
      "e1": { "name": "Example Domain", "role": "heading" }
    },
    "snapshot": "- heading \"Example Domain\" [level=1, ref=e1]"
  },
  "summary": "Snapshot: 1 refs on https://example.com/"
}
```

Additional structured fields can appear when relevant:
- `batchFailure` and `batchSteps` for `batch` rendering, including mixed-success runs
- `navigationSummary` for navigation-style commands like `click`, `back`, `forward`, and `reload`
- `imagePath` / `imagePaths` for screenshots and batched image outputs
- `fullOutputPath` / `fullOutputPaths` when large snapshot output is compacted and spilled to a private file; persisted sessions keep that path under a private session-scoped artifact directory with a bounded per-session budget so it survives reload/resume without unbounded growth
- `sessionRecoveryHint` when startup-scoped flags need `sessionMode: "fresh"`
- `inspection: true` plus `stdout` for successful plain-text inspection commands like `--help` and `--version`

When the tool echoes `args` or `effectiveArgs` back into Pi, sensitive values such as `--headers`, proxy credentials, and auth-bearing URL parameters should be redacted first.

For oversized snapshots, details should switch to a compact metadata object and include `fullOutputPath` pointing at a private JSON spill file with the full upstream snapshot payload. Persisted sessions should keep that spill file under a private session-scoped artifact directory so the path remains usable after reload/restart, with the oldest persisted spill files evicted as needed to stay within the per-session budget.

## High-value result rendering

"Rendering" here means how results appear inside `pi`, not embedding a browser UI.

Worth doing in v1:
- screenshots → inline image attachment
- snapshots → origin + ref count + main-content-first compact preview, with the raw snapshot spill path kept in `details.fullOutputPath` when the inline result would otherwise be too large
- extraction-style commands like `eval --stdin` and `get title` → scalar-first text with lightweight origin context when available
- navigation actions like `click`, `back`, `forward`, and `reload` → lightweight post-action title/url summary when available
- tab lists → compact summary/table
- stream status → enabled/connected/port summary

## Missing binary behavior

If `agent-browser` is not on `PATH`, fail with a message that:
- says `agent-browser` is required
- says this project does not bundle it
- points to upstream install/docs

## Session behavior

- maintain one extension-managed active session per `pi` session for the common path
- derive the base implicit session name from the official `pi` session id plus a cwd hash so same-named checkouts do not collide
- respect explicit upstream `--session` with minimal interference
- treat the extension-managed session as convenience state owned by the wrapper
- preserve the current extension-managed session across normal `pi` shutdown/reload so persisted sessions can keep following the live browser on `/reload` or `/resume`
- set an idle timeout on extension-managed sessions so abandoned daemons eventually self-clean
- clean up process-private temp spill artifacts on shutdown, while keeping persisted-session snapshot spill files in a private session-scoped artifact directory so `details.fullOutputPath` survives reload/restart and the oldest spill files are evicted if the per-session artifact budget is exceeded
- reconstruct the current extension-managed session from persisted tool details on resume/reload so later default calls keep following the active managed browser
- when an unnamed `sessionMode: "fresh"` launch succeeds, make it the new extension-managed session so later default calls keep using it
- if that unnamed fresh launch replaced an already-active managed session, best-effort close the old managed session after the switch succeeds
- treat explicit caller-provided `--session` choices as user-managed
- pass explicit `--profile` straight through to upstream `agent-browser`; no profile-cloning or isolation layer is added in v1
- after profiled `open` / `goto` / `navigate`, if upstream leaves a restored profile tab active instead of the page that was just opened, best-effort switch back to the tab whose URL matches the returned open result before returning control to the agent
- treat successful plain-text inspection commands like `--help` and `--version` as stateless: do not inject the implicit managed session and do not let those calls claim the managed-session slot
- if startup-scoped flags like `--profile`, `--session-name`, or `--cdp` are supplied after the implicit session is already active while `sessionMode` is `"auto"`, return a validation error with a structured recovery hint that recommends `sessionMode: "fresh"`
- for direct headless local Chrome launches to `chatgpt.com` / `chat.openai.com`, allow a narrow compatibility fallback that injects a normal Chrome `--user-agent` only when the caller did not explicitly provide one and did not choose `--headed`, `--cdp`, `--auto-connect`, or a provider-backed launch

## Non-goals

- no giant action enum mirroring the whole upstream CLI
- no support for older `agent-browser` versions
- no compatibility shims
- no embedded browser UI inside `pi`
