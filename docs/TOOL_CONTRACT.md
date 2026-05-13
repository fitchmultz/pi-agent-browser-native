# Tool contract

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md)

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

The tool also needs an operating playbook, not just a capability list. The model should not have to rediscover basics each session. The canonical agent-facing playbook lives in `extensions/agent-browser/lib/playbook.ts`; generated Markdown fragments are updated by `npm run docs -- playbook write`, and `npm run docs -- playbook check` fails when checked-in documentation drifts.

The native command reference in `docs/COMMAND_REFERENCE.md` is driven by the same pattern: canonical metadata lives in `scripts/agent-browser-capability-baseline.mjs`, selected regions are generated into the Markdown by `npm run docs -- command-reference write`, and `npm run docs` plus `npm run verify -- command-reference` catch drift (the latter also samples the installed `agent-browser` on `PATH`). Maintainer workflow details live in `AGENTS.md` under upstream capability baseline.

Agent-facing efficiency claims are measured with `npm run benchmark:agent-browser` or `npm run verify -- benchmark`. The benchmark is deterministic and does not launch a browser; it tracks representative workflow success, tool calls, model-visible output size, stale-ref failures and recoveries, artifact success, failure-category coverage, and elapsed-time estimates so future abstractions can prove they reduce agent work before replacing raw tool use.

<!-- agent-browser-playbook:start shared-guidelines -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- Standard workflow: open the page, snapshot -i, interact using current @refs from that snapshot, and re-snapshot after navigation, scrolling, rerendering, or other major DOM changes because refs can become stale.
- When a visible text or accessible-name target should survive ref churn, prefer find locators such as role, text, label, placeholder, alt, title, or testid with the intended action instead of guessing a CSS selector.
- Do not assume Playwright selector dialects such as text=Close or button:has-text('Close') are supported wrapper syntax unless current upstream agent-browser behavior has been verified.
- For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.
- Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.
- When using --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.
- If you already used the implicit session and now need launch-scoped flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable, retry with sessionMode set to fresh or pass an explicit --session for the new launch. After a successful unnamed fresh launch, later auto calls follow that new session.
- For React introspection, launch the page with --enable react-devtools before first navigation, then use react tree, react inspect <fiberId>, react renders start/stop, or react suspense; use vitals [url] for Core Web Vitals and hydration timing, and pushstate <url> for client-side SPA navigation.
- For first-navigation setup, use open without a URL plus network route --resource-type <csv>, cookies set --curl <file>, or --init-script/--enable before navigate/opening the target page.
- If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <tab-id-or-label> / snapshot -i to recover state before retrying different URLs or fallback strategies. Only use wait with an explicit argument like milliseconds, --load <state>, --url <matcher>, --fn <js>, or --text <matcher>.
- For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.
- For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.
- For downloads, prefer download <selector> <path> when an element click should save a file. Do not rely on click alone when you need the downloaded file on disk.
- When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.
- When using eval --stdin for extraction, return the value you want instead of relying on console.log as the primary result channel.
- When details.pageChangeSummary is present, use changeType and summary as a compact signal for navigation, DOM mutation, confirmations, or artifacts; when nextActionIds is set, match those ids to entries in details.nextActions (or per-step nextActions inside batch) for concrete follow-up payloads instead of inferring from prose alone.
- Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.
<!-- agent-browser-playbook:end shared-guidelines -->

## Parameters

Illustrative shapes (each real call uses **either** `args` **or** `semanticAction`, not both):

```json
{ "args": ["open", "https://example.com"], "stdin": "optional raw stdin content", "sessionMode": "auto" }
```

```json
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Export" }, "sessionMode": "auto" }
```

### `args`

- type: `string[]`
- required unless `semanticAction` is provided
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

### `semanticAction`

- type: object
- optional; mutually exclusive with `args` (omit `args` entirely when using this field)
- top-level tool input only: `batch` stdin remains upstream argv arrays; express find steps inside batch as string arrays such as `["find","role","button","click","--name","Export"]`, not nested `semanticAction` objects
- thin intent schema compiled by this wrapper into existing upstream `find` commands; behavior and locator semantics stay upstream-owned
- supported actions: `click`, `fill`, `select`, `check`, `uncheck`
- supported locators: `role`, `text`, `label`, `placeholder`, `alt`, `title`, `testid`
- `value` is the locator argument (for example ARIA role token `"button"`, label text, or visible substring), must be a non-empty string after trim
- `fill` and `select` require non-empty `text` (compiled as the trailing value argument to `find`)
- optional `name` is only valid with `locator: "role"` and compiles to `--name <name>` after the action (and after `text` when present)
- optional `role` is accepted only when `locator` is `role` and must equal `value` if set (redundant with `value`; prefer `value` alone)

Compilation (then `--json` and session handling apply like any other call):

| Fields | Compiled `args` (conceptually) |
| --- | --- |
| `click`, `check`, or `uncheck` + non-`role` locator | `["find", <locator>, <value>, <action>]` |
| `click` / `check` / `uncheck` + `role` + optional `name` | `["find","role",<value>,<action>]` plus `["--name",<name>]` when `name` is set |
| `fill` or `select` | `["find",<locator>,<value>,<action>,<text>]` plus optional `["--name",<name>]` after `text` when `locator` is `role` and `name` is set |

When `semanticAction` compiles successfully, `details.compiledSemanticAction` echoes `{ action, locator, args }` with `args` redacted the same way as other invocation details. Expect it on the initial wrapper validation return (when that path still builds the early `details` object) and on the unified result after `agent-browser` runs. It is omitted when the call used `args` only, when compilation never produced argv, and on some in-`execute` error returns that attach a slimmer `details` shape before the unified merge (for example certain session-plan, stdin-contract, tab-pinning, or missing-binary guard paths); compare `extensions/agent-browser/index.ts` where `compiledSemanticAction` is assigned.

If a compiled `semanticAction` fails with `failureCategory: "stale-ref"`, `details.nextActions` includes `retry-semantic-action-after-stale-ref` with the exact compiled `find` argv. That retry is only offered because the semantic target is stable and the stale-ref error proves the previous action did not execute; direct stale `@e…` commands still return snapshot/find recovery guidance instead of an unsafe blind retry.

Examples:

```json
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Export" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "semanticAction": { "action": "check", "locator": "label", "value": "Remember me" } }
{ "semanticAction": { "action": "uncheck", "locator": "label", "value": "Remember me" } }
{ "semanticAction": { "action": "select", "locator": "label", "value": "Country", "text": "United States" } }
```

### `stdin`

- type: `string`
- optional
- raw stdin for `eval --stdin`, `batch`, and `auth save --password-stdin`
- rejected before launch for any other command/stdin combination, including commands such as `click`, `snapshot`, or `open`

Examples:

```json
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
```

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

```json
{ "args": ["auth", "save", "my-login", "--password-stdin"], "stdin": "password from the user-approved secret source" }
```

### `sessionMode`

- type: `"auto" | "fresh"`
- optional
- default: `"auto"`

Behavior:
- if `args` already include `--session`, upstream session choice wins
- `"auto"` prepends the current extension-managed active session when appropriate
- `"fresh"` rotates that managed session to a fresh upstream launch so startup-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, or `--enable` apply and later default calls follow the new browser

Recommended use:
- use `"auto"` for the common browse/snapshot/click flow inside one `pi` session
- use `"fresh"` when switching from an already-active implicit session to a new profile/debug/auth launch without inventing a fixed explicit session name

## Wrapper behavior

The extension should:
- inject `--json`
- invoke `agent-browser` directly, not through a shell
- parse JSON output into tool details
- handle observed JSON result shapes, including the array returned by `batch --json`
- allow plain-text fallback for native inspection calls
- support those inspection calls unconditionally so the tool contract stays local and predictable

<!-- agent-browser-playbook:start inspection -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
Native inspection calls use the `agent_browser` tool shape, not shell-like direct-binary commands:

- { "args": ["--help"] }
- { "args": ["--version"] }

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, or auto-connect launches.
<!-- agent-browser-playbook:end inspection -->
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
- oversized `snapshot` results should switch to a compact view that preserves the primary content, nearby sections, and a trimmed set of high-value refs, while exposing the full raw snapshot path directly in the rendered tool text and via `details.fullOutputPath`
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
  "resultCategory": "success",
  "successCategory": "completed",
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

Stable category fields are part of the machine-readable contract:

- `resultCategory`: always either `"success"` or `"failure"`.
- `successCategory`: present on successful results. Current values are `"completed"`, `"artifact-saved"`, and `"inspection"`.
- `failureCategory`: present on failed results. Current values are `"aborted"`, `"confirmation-required"`, `"download-not-verified"`, `"missing-binary"`, `"parse-failure"`, `"selector-not-found"`, `"selector-unsupported"`, `"stale-ref"`, `"tab-drift"`, `"timeout"`, `"upstream-error"`, and `"validation-error"`.

These categories are intentionally bounded and stable so agents can branch on them instead of parsing prose. They do not replace raw diagnostics: `details.error`, `details.stderr`, `details.parseError`, `details.validationError`, and visible content still preserve the specific upstream or wrapper message after normal redaction.

For `batch`, top-level `details` still carries `resultCategory` plus `successCategory` or `failureCategory` for the **aggregate** tool outcome: if any step fails, the overall result is a failure (`resultCategory: "failure"`) even when later steps succeed—inspect `batchSteps[]` for per-step outcomes. Each `batchSteps[]` entry includes its own `resultCategory` and either `successCategory` or `failureCategory` for that step. `batchFailure.failedStep` duplicates the first failing step’s details, including its `failureCategory` and any `nextActions`.

`nextActions` is an optional machine-readable list of exact native `agent_browser` follow-ups. Each entry includes `tool: "agent_browser"`, an `id`, a short `reason`, optional `safety`, and either `params` (`args`, optional `stdin`, optional `sessionMode`) or an `artifactPath` for saved-file workflows. Agents should prefer these payloads over prose when present. Current recommendations include: `open` success → `snapshot -i`; mutating/navigation commands (see `buildAgentBrowserNextActions` in source for the exact command set) → `snapshot -i`; stale refs and selector failures → `snapshot -i`; confirmations → exact `confirm <id>` and `deny <id>` choices; tab drift → `tab list` then `snapshot -i`; download verification failures → `wait --download [path]`; saved artifacts → the artifact path to inspect/consume after checking metadata. When nothing applies, the field is omitted.

For `batch`, each `batchSteps[]` entry can carry its own `nextActions` for that step’s success or failure. Top-level `details.nextActions` on a failed batch duplicates `batchFailure.failedStep.nextActions` so callers can read one aggregate object. On a fully successful batch, top-level `nextActions` may still list artifact follow-ups derived from the combined step artifacts.

`pageChangeSummary` is an optional compact summary for mutation-prone and artifact-producing commands. It includes `changeType` (`"navigation"`, `"mutation"`, `"artifact"`, or `"confirmation"`), `command`, a readable `summary`, optional `title`/`url`, optional `artifactCount` or `savedFilePath`, and `nextActionIds` that link the observed change to `nextActions` without repeating full payloads. The wrapper maintains an explicit allowlist of mutation-prone commands in `extensions/agent-browser/lib/results/presentation.ts` (`PAGE_CHANGE_SUMMARY_COMMANDS`): those commands still emit a `mutation`-typed summary when upstream JSON lacks navigation metadata, as long as no stronger signal (artifact, saved path, navigation fields, or pending confirmation) applies. Commands outside that set omit `pageChangeSummary` unless the parsed payload shows navigation, a confirmation prompt, saved files, or artifacts—including read-only inspection commands, which normally have no summary unless one of those signals appears. For `batch`, the top-level summary favors artifact rollups when any step produced artifacts; otherwise it may synthesize a `mutation` summary from steps that carried their own `pageChangeSummary`.

Example shape (fields vary by scenario):

```json
"nextActions": [
  {
    "tool": "agent_browser",
    "id": "inspect-after-mutation",
    "reason": "Refresh interactive refs after a browser mutation, navigation, scroll, or rerender.",
    "safety": "Do not reuse prior @refs until a fresh snapshot confirms they still exist.",
    "params": { "args": ["snapshot", "-i"], "sessionMode": "auto" }
  }
]
```

```json
"pageChangeSummary": {
  "changeType": "navigation",
  "command": "open",
  "summary": "Opened Example Domain",
  "title": "Example Domain",
  "url": "https://example.com/",
  "nextActionIds": ["inspect-opened-page"]
}
```

Implementation and precedence:

- Types, classifiers, and follow-up assembly live in `extensions/agent-browser/lib/results/shared.ts`: `classifyAgentBrowserSuccessCategory`, `classifyAgentBrowserFailureCategory`, `buildAgentBrowserResultCategoryDetails` (the last prefers an explicit `failureCategory` when the caller already knows the bucket, otherwise it runs the classifier), and `buildAgentBrowserNextActions`.
- Success: if `inspection` is true → `"inspection"`; else if there is a `savedFile` or any `artifacts` → `"artifact-saved"`; else → `"completed"`.
- Failure: the classifier walks a single ordered chain (first match wins): `confirmation-required` → `timeout` → `missing-binary` → `parse-failure` → `aborted` → `tab-drift` → `stale-ref` (including “unknown ref” text and a narrow `@eN` plus “element not found” heuristic) → `selector-unsupported` → `selector-not-found` → `download-not-verified` (download / wait-download style failures) → `validation-error` when a wrapper `validationError` is present → default `upstream-error`.
- The main tool implementation merges these fields into Pi-facing `details` from `extensions/agent-browser/index.ts` and from `extensions/agent-browser/lib/results/presentation.ts` for presentation-time failures.

Additional structured fields can appear when relevant:
- `compiledSemanticAction` when the call used `semanticAction` and the result includes the unified `details` merge: `{ action, locator, args }` with the same redaction rules as `args` / `effectiveArgs`; omitted for plain `args` calls and omitted on some early error returns that omit this field (see the `semanticAction` section above)
- `batchFailure` and `batchSteps` for `batch` rendering, including mixed-success runs
- `navigationSummary` for navigation-style commands like `click`, `back`, `forward`, and `reload`
- `pageChangeSummary` for compact mutation/artifact/navigation summaries on commands that can change browser state
- `imagePath` / `imagePaths` for screenshots and batched image outputs
- `artifacts` for upstream saved files such as screenshots, PDFs, downloads, `wait --download` files, traces, CPU profiles, completed WebM recordings, path-bearing HAR captures, and future recording output paths reported by `record start`. Each artifact includes the original saved or requested `path`, resolved `absolutePath`, `kind`/`artifactType`, optional `mediaType`, optional `extension`, best-effort disk metadata such as `exists` and `sizeBytes`, plus `requestedPath`, `status`, `cwd`, `session`, and `tempPath` when applicable.
- `savedFilePath` / `savedFile` for direct `download`, `pdf`, and `wait --download` saved-file workflows; batch results preserve the same fields on the relevant `batchSteps` entry.
- `batchSteps[].artifacts` for per-step artifacts in `batch` output; top-level `artifacts` aggregates all step artifacts in order
- `fullOutputPath` / `fullOutputPaths` when large snapshot output or other oversized tool output is compacted and spilled to a private file; persisted sessions keep that path under a private session-scoped artifact directory with a bounded per-session budget so it survives reload/resume without unbounded growth
- `artifactManifest` for a bounded, metadata-only inventory of recent session artifacts. Entries include path metadata, artifact `kind`, source `command`/`subcommand` when safe, `storageScope` (`persistent-session`, `process-temp`, or `explicit-path`), and `retentionState` (`live`, `ephemeral`, `missing`, or `evicted`). The default recent window is 100 entries and can be configured with `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES`. The manifest must not store command args, output contents, headers, DOM snapshots, or downloaded file contents.
- `artifactRetentionSummary` with a concise count of live, evicted, ephemeral, and missing artifacts from the current manifest; results append this summary to model-facing text only when retention state affects recovery, such as spill files, ephemeral files, or evictions. Routine explicit saved files keep the summary in details to avoid noisy browsing transcripts.
- `sessionRecoveryHint` when startup-scoped flags need `sessionMode: "fresh"`
- `inspection: true` plus `stdout` for successful plain-text inspection commands like `--help` and `--version`

When the tool echoes `args` or `effectiveArgs` back into Pi, sensitive values such as `--headers`, proxy credentials, and auth-bearing URL parameters should be redacted first.

For oversized snapshots and other oversized tool outputs, details should switch to a compact metadata object and include `fullOutputPath` pointing at a private spill file with the full redacted upstream payload. The model-facing tool text should print the actual spill-file path when one exists instead of only saying to inspect a details key. Persisted sessions should keep that spill file under a private session-scoped artifact directory so the path remains usable after reload/restart. The oldest persisted spill files are evicted as needed to stay within `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB), and those evictions are reported as `artifactManifest.entries[].retentionState: "evicted"` instead of silently disappearing from the session inventory. This persisted-spill byte budget is separate from the recent metadata window controlled by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES`.

## High-value result rendering

"Rendering" here means how results appear inside `pi`, not embedding a browser UI.

The TUI renderer is user-facing only. It may compact or colorize what the human sees in the Pi transcript, but it must not further truncate, summarize, or remove the model-facing `content` returned by the tool. Use the existing `details.fullOutputPath` / spill-file contracts for content that is too large for the model.

Worth doing in v1:
- screenshots → saved-path summary, visible artifact metadata, `details.artifacts` metadata, and inline image attachment when safe; screenshot paths that upstream would treat ambiguously, such as `.dogfood/run/foo.png`, are normalized to absolute paths before launch and repaired from upstream temp output when possible
- file artifacts such as PDFs, downloads, `wait --download` files, traces, CPU profiles, completed WebM recordings, and path-bearing HAR captures → concise saved-path summaries plus metadata in `details.artifacts` and bounded recent metadata in `details.artifactManifest`; `record start` reports recording lifecycle state and the future output path without adding a missing manifest entry; direct saved-file workflows also expose `details.savedFilePath` / `details.savedFile`; large or binary artifacts are not inlined into model context; the recent manifest cap can age out explicit-file metadata but does not remove explicit saved files from disk
- TUI display → custom `agent_browser` call/result rendering with colorized command/output text and a built-in-style collapsed view for long visible output; `ctrl+o` expansion reveals the full rendered tool result without changing the model-facing content
- snapshots → origin + ref count + main-content-first compact preview, with the raw snapshot spill path printed directly in content and kept in `details.fullOutputPath` plus `details.artifactManifest` when the inline result would otherwise be too large
- oversized generic outputs such as large `eval --stdin` payloads → compact preview plus the actual spill file path instead of dumping the whole payload into model context
- extraction-style commands like `eval --stdin` and `get title` → scalar-first text with lightweight origin context when available
- navigation actions like `click`, `back`, `forward`, and `reload` → lightweight post-action title/url summary when available
- tab lists → compact summary/table
- stream status → enabled/connected/port summary plus WebSocket URL and frame format when a port is known; if the caller explicitly passed `--json`, visible text is valid JSON instead of a prose summary
- diagnostic/status families (`session`, `session list`, `profiles`, `doctor`, `auth list`/`show`, `network requests`, `console`, `errors`, and dashboard start/stop/status outputs) → compact readable summaries with counts and stable fields; large log/request/error outputs use previews plus `fullOutputPath` spill files; sensitive nested auth/header/token fields are not expanded in the model-facing text
- trace/profiler owner conflicts → when the wrapper has observed one owner active for a session, block conflicting starts/stops with "wrapper believes ..." wording because upstream or external CLI use can desynchronize wrapper-local state

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
- preserve the current extension-managed session across `/reload` and resumable session transitions so persisted sessions can keep following the live browser on `/reload` or `/resume`
- close the active extension-managed session when the originating `pi` process quits, while leaving explicit caller-provided sessions alone
- set an idle timeout on extension-managed sessions as a backstop for abnormal exits or cleanup failures
- clean up process-private temp spill artifacts on shutdown, while keeping persisted-session snapshot spill files in a private session-scoped artifact directory so `details.fullOutputPath` survives reload/restart and the oldest spill files are evicted if the per-session artifact budget is exceeded
- reconstruct the current extension-managed session and latest `artifactManifest` from persisted tool details on resume/reload so later default calls keep following the active managed browser and can continue reporting artifact retention state
- when an unnamed `sessionMode: "fresh"` launch succeeds, make it the new extension-managed session so later default calls keep using it
- if that unnamed fresh launch replaced an already-active managed session, best-effort close the old managed session after the switch succeeds
- treat explicit caller-provided `--session` choices as user-managed; `--session` isolates a live browser session but is not a persisted tab/auth restore mechanism after `close`, so use `--profile`, `--session-name`, or `--state` when persisted auth/tab state is required
- pass explicit `--profile` straight through to upstream `agent-browser`; no profile-cloning or isolation layer is added in v1
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.
- After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.
- If a known session target unexpectedly reports about:blank, agent_browser preserves the prior intended target, best-effort re-selects it when it still exists, and reports exact recovery guidance when it cannot be re-selected.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- on local Unix launches, set a short private socket directory for wrapper-spawned `agent-browser` processes so extension-generated session names do not fail the upstream Unix socket-path length limit in longer cwd/session-name combinations
- keep wrapper-spawned commands below the upstream CLI IPC read-timeout budget by clamping `AGENT_BROWSER_DEFAULT_TIMEOUT` to 25 seconds and stopping a stuck child process before the upstream 30-second retry path begins
- treat successful plain-text inspection commands like `--help` and `--version` as stateless: do not inject the implicit managed session and do not let those calls claim the managed-session slot
- if startup-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, or `--enable` are supplied after the implicit session is already active while `sessionMode` is `"auto"`, return a validation error with a structured recovery hint that recommends `sessionMode: "fresh"`
- for direct headless local Chrome launches to `chat.com` / `chatgpt.com` / `chat.openai.com`, allow a narrow compatibility fallback that injects a normal Chrome `--user-agent` only when the caller did not explicitly provide one and did not choose `--headed`, `--cdp`, `--auto-connect`, or a provider-backed launch

## Non-goals

- no giant action enum mirroring the whole upstream CLI
- no support for older `agent-browser` versions
- no compatibility shims
- no embedded browser UI inside `pi`
