# Tool contract

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

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

The tool also needs an operating playbook, not just a capability list. The model should not have to rediscover basics each session, but always-on guidance must stay concise. The canonical agent-facing playbook lives in `extensions/agent-browser/lib/playbook.ts`; it provides compact runtime rules plus absolute installed-package paths to `README.md`, `docs/COMMAND_REFERENCE.md`, and this contract so agents with file tools can read targeted guidance on demand instead of receiving the full docs in prompt context. Generated Markdown fragments are updated by `npm run docs -- playbook write`, and `npm run docs -- playbook check` fails when checked-in documentation drifts.

The native command reference in `docs/COMMAND_REFERENCE.md` is driven by the same pattern: canonical metadata lives in `scripts/agent-browser-capability-baseline.mjs`, selected regions are generated into the Markdown by `npm run docs -- command-reference write`, and `npm run docs` plus `npm run verify -- command-reference` catch drift (the latter also samples the installed `agent-browser` on `PATH`). Maintainer workflow details live in `AGENTS.md` under upstream capability baseline.

Agent-facing efficiency claims are measured with `npm run benchmark:agent-browser` or `npm run verify -- benchmark`. The benchmark is deterministic and does not launch a browser; it tracks representative workflow success, tool calls, model-visible output size, stale-ref failures and recoveries, artifact success, failure-category coverage, and elapsed-time estimates so future abstractions can prove they reduce agent work before replacing raw tool use.

<!-- agent-browser-playbook:start shared-guidelines -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- Standard workflow: open the page, snapshot -i, interact using current @refs from that snapshot, and re-snapshot after navigation, scrolling, rerendering, or other major DOM changes because refs are page-scoped; the wrapper fails mutation-prone stale/recycled refs before upstream can silently target a different current-page element.
- When snapshot -i compacts because the tree is oversized, scan visible output for Omitted high-value controls and optional details.data.highValueControlRefIds before opening the spill file: those list bounded searchboxes, textboxes, comboboxes, buttons, tabs, checkboxes, radios, options, and menuitems that did not fit the key/other ref previews.
- When a visible text or accessible-name target should survive ref churn, prefer find locators such as role, text, label, placeholder, alt, title, or testid with the intended action instead of guessing a CSS selector.
- Do not assume Playwright selector dialects such as text=Close or button:has-text('Close') are supported wrapper syntax unless current upstream agent-browser behavior has been verified.
- For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.
- Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.
- When using --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.
- If you already used the implicit session and now need launch-scoped flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device, retry with sessionMode set to fresh or pass an explicit --session for the new launch. After a successful unnamed fresh launch, later auto calls follow that new session.
- For React introspection, launch the page with --enable react-devtools before first navigation, then use react tree, react inspect <fiberId>, sourceLookup candidates for local UI source hints, react renders start/stop, or react suspense; sourceLookup is experimental and reports confidence/evidence instead of guaranteed DOM-to-file mappings. For failed fetches and APIs, networkSourceLookup (experimental) correlates failed network requests with initiator metadata and bounded workspace URL literals—candidates only, not definitive blame. Use vitals [url] for Core Web Vitals and hydration timing, and pushstate <url> for client-side SPA navigation.
- For first-navigation setup, use open without a URL plus network route --resource-type <csv>, cookies set --curl <file>, or --init-script/--enable before navigate/opening the target page.
- For stateful browser context work, prefer purpose-specific page actions before dumping browser data: use auth save --password-stdin with the tool stdin field for credentials, state save/load for portable test state, cookies get/set/clear and storage local|session only when the task needs those values, and expect cookie/storage/auth/state summaries to redact credential-like fields.
- For batch chains that touch cookies, storage, auth, or other secret-bearing commands, use details.batchSteps for per-step artifacts, categories, spill paths, and full structured errors; top-level details.data on batch is only a compact redacted step matrix (success, argv-redacted command, redacted result or scrubbed error text) built from the same presentation rules as standalone calls.
- For non-core families, pass current upstream commands through the native tool directly: network route/requests/har, diff snapshot/screenshot/url, trace/profiler/record, console/errors/highlight/inspect/clipboard, stream enable/disable/status, dashboard start/stop, and chat. Artifact-producing commands report details.artifacts and verification state; long-running starts such as stream, dashboard, trace/profiler, and record should be paired with the matching stop/disable command when the task is done.
- For provider or specialized app workflows, load version-matched upstream guidance with skills get agentcore|electron|slack|dogfood|vercel-sandbox through the native tool. Provider launches such as -p ios, --provider browserbase/kernel/browseruse/browserless/agentcore, and iOS --device are upstream-owned setup paths; use sessionMode fresh when switching providers and expect external credentials or local Appium/Xcode setup to be required.
- For dialogs and frames, use dialog status/accept/dismiss and frame <selector|main> through native args; when --confirm-actions produces a pending confirmation, use details.nextActions or exact confirm <id> / deny <id> calls instead of inventing ids.
- If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <tab-id-or-label> / snapshot -i to recover state before retrying different URLs or fallback strategies. Only use wait with an explicit argument like milliseconds, --load <state>, --url <matcher>, --fn <js>, or --text <matcher>.
- For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.
- For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.
- For downloads, prefer download <selector> <path> when an element click should save a file. Do not rely on click alone when you need the downloaded file on disk.
- On dashboards with nested scroll containers, verify scroll with a screenshot or fresh snapshot -i; if the viewport did not move, prefer scrollintoview <@ref> or target the actual scrollable region. For comboboxes, a click/semanticAction may only focus the field; re-snapshot and fall back to type, press Enter/arrow keys, select, or visible option refs.
- When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.
- When using eval --stdin for extraction, return the value you want instead of relying on console.log as the primary result channel. Prefer plain expressions like ({ title: document.title }) or explicitly invoked functions like (() => ({ title: document.title }))(); if a function-shaped snippet returns {}, details.evalStdinHint may warn that the function was serialized instead of called. If get text on a CSS selector surfaces details.selectorTextVisibility or selectorTextVisibilityAll, prefer a visible @ref, a more specific selector, or the inspect-visible-text-candidates nextAction over hidden tab content.
- When details.pageChangeSummary is present, use changeType and summary as a compact signal for navigation, DOM mutation, confirmations, or artifacts; when nextActionIds is set, match those ids to entries in details.nextActions (or per-step nextActions inside batch) for concrete follow-up payloads instead of inferring from prose alone. If a no-navigation click surfaces details.overlayBlockers, inspect the fresh snapshot evidence before using a close/dismiss candidate nextAction; ordinary page chrome without dialog/alertdialog evidence should not trigger this diagnostic.
- When commands save or spill files (screenshots, downloads, PDFs, traces, recordings, HAR, large snapshot spills), treat paths as provisional until details.artifactVerification shows every row verified: branch on missingCount, pendingCount, unverifiedCount, per-entry state, and optional limitation before downstream file use.
- Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.
<!-- agent-browser-playbook:end shared-guidelines -->

## Parameters

Illustrative shapes (each real call uses exactly one of `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, or `networkSourceLookup`):

```json
{ "args": ["open", "https://example.com"], "stdin": "optional raw stdin content", "sessionMode": "auto" }
```

```json
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Export" }, "sessionMode": "auto" }
```

### `args`

- type: `string[]`
- required unless `semanticAction`, `job`, `qa`, `sourceLookup`, or `networkSourceLookup` is provided
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
- optional; mutually exclusive with `args`, `job`, `qa`, `sourceLookup`, and `networkSourceLookup` (omit all of them when using this field)
- top-level tool input only: `batch` stdin remains upstream argv arrays; express find steps inside batch as string arrays such as `["find","role","button","click","--name","Export"]`, not nested `semanticAction` objects
- thin intent schema compiled by this wrapper into existing upstream `find` commands; behavior and locator semantics stay upstream-owned
- supported actions: `click`, `fill`, `select`, `check`, `uncheck`
- supported locators: `role`, `text`, `label`, `placeholder`, `alt`, `title`, `testid`
- `value` is the locator argument (for example ARIA role token `"button"`, label text, or visible substring), must be a non-empty string after trim
- `fill` and `select` require non-empty `text` (compiled as the trailing value argument to `find`)
- optional `name` is only valid with `locator: "role"` and compiles to `--name <name>` after the action (and after `text` when present)
- optional `role` is accepted only when `locator` is `role` and must equal `value` if set (redundant with `value`; prefer `value` alone)
- optional `session` is an upstream session name; when set, compilation prepends `--session <session>` before `find` so the shorthand targets that named browser context instead of the managed default; this is independent of top-level `sessionMode`, which only injects or rotates the extension-managed implicit session when the planned argv does not already start with `--session` (see `buildExecutionPlan` in `extensions/agent-browser/lib/runtime.ts`). On successful unified results, `details.sessionName` matches that name and `usedImplicitSession` is `false` because the call named upstream directly rather than consuming the extension-managed implicit session slot.

Compilation (then `--json` and session handling apply like any other call):

| Fields | Compiled `args` (conceptually) |
| --- | --- |
| `click`, `check`, or `uncheck` + non-`role` locator | `["find", <locator>, <value>, <action>]` |
| `click` / `check` / `uncheck` + `role` + optional `name` | `["find","role",<value>,<action>]` plus `["--name",<name>]` when `name` is set |
| `fill` or `select` | `["find",<locator>,<value>,<action>,<text>]` plus optional `["--name",<name>]` after `text` when `locator` is `role` and `name` is set |
| any supported action + `session` | prepends `["--session",<session>]` before the compiled `find` argv |

When `semanticAction` compiles successfully, `details.compiledSemanticAction` echoes `{ action, locator, args }` with `args` redacted the same way as other invocation details. Expect it on the initial wrapper validation return (when that path still builds the early `details` object) and on the unified result after `agent-browser` runs. It is omitted when the call used `args` only, when compilation never produced argv, and on some in-`execute` error returns that attach a slimmer `details` shape before the unified merge (for example certain session-plan, stdin-contract, tab-pinning, or missing-binary guard paths); compare `extensions/agent-browser/index.ts` where `compiledSemanticAction` is assigned. For active sessions, role/name `click`, `check`, and `uncheck` semantic actions may be resolved through one fresh `snapshot -i` to a current visible `@ref` before execution; this avoids hidden duplicate matches stealing an upstream `find` action. In that case `details.compiledSemanticAction` still records the original semantic target while `details.effectiveArgs` shows the executed ref action.

If a compiled `semanticAction` fails with `failureCategory: "selector-not-found"`, visible content includes an `Agent-browser candidate fallbacks` block when the wrapper has bounded role/name retries for that locator and action, and `details.nextActions` includes the normal `refresh-interactive-refs` snapshot step plus those entries. When `session` was provided, candidate retry args preserve the same `--session <session>` prefix. Today `buildSemanticActionCandidateActions` in `extensions/agent-browser/index.ts` only appends candidates for: `fill` + `placeholder` → `try-searchbox-name-candidate` and `try-textbox-name-candidate` (same accessible name as `value`); `click` + `text` → `try-button-name-candidate` and `try-link-name-candidate`; `fill` + `label` → `try-labeled-textbox-candidate`. `select` misses—including `select` + `placeholder`—do not append `try-*` entries even when a parallel `fill` would; other locator/action pairs omit this block too. `fill` candidates keep the same trailing `text` token as the original compile before `--name <value>`; `click` candidates omit text. Each entry carries `safety` noting the match may be ambiguous. Candidate fallbacks are heuristics, not proof that an element exists; inspect the page when several controls could share the same name.

If a compiled `semanticAction` fails with `failureCategory: "stale-ref"`, `details.nextActions` includes `retry-semantic-action-after-stale-ref` with the same redacted compiled argv as `details.compiledSemanticAction` in `params.args` (any leading `--session` pair from `semanticAction.session`, then the `find` tokens). The wrapper appends that entry **after** any `refresh-interactive-refs` snapshot step from `buildAgentBrowserNextActions` in `extensions/agent-browser/lib/results/shared.ts` (see `extensions/agent-browser/index.ts` where `nextActions` is merged). That retry is only offered because the semantic target is stable and the stale-ref error proves the previous action did not execute; direct stale `@e…` commands still return snapshot/find recovery guidance instead of an unsafe blind retry.

For direct page-scoped `@e…` refs, successful `snapshot` results record `details.refSnapshot` with the latest ref ids and page target for the session. Before mutation-prone ref commands such as `click`, `fill`, `check`, `select`, `download`, drag/upload/keyboard-style actions, or equivalent batch steps run, the wrapper rejects refs from an older page target or refs absent from the latest same-page snapshot with `failureCategory: "stale-ref"`. This is a best-effort wrapper guard against upstream ref-number recycling after navigation; it does not prove the DOM stayed unchanged after the snapshot. Refresh with the session-aware `refresh-interactive-refs` next action before retrying.

Examples:

```json
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Export" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "semanticAction": { "action": "check", "locator": "label", "value": "Remember me" } }
{ "semanticAction": { "action": "uncheck", "locator": "label", "value": "Remember me" } }
{ "semanticAction": { "action": "select", "locator": "label", "value": "Country", "text": "United States" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close", "session": "named-browser" } }
```

### `job`

- type: object with a non-empty `steps` array
- optional; mutually exclusive with `args`, `semanticAction`, `qa`, `sourceLookup`, and `networkSourceLookup`
- top-level tool input only; do not nest `job` inside `batch` stdin
- constrained orchestration only: every step compiles to existing upstream `batch` argv and the compiled plan is echoed as `details.compiledJob`
- there is no separate reusable named “browser recipe” extension surface above `job`, `qa`, and raw `batch` yet; the closed `RQ-0068` decision, evidence bar, and revisit criteria are in [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet) and [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- supported steps (each row becomes one upstream `batch` step; `click` / `fill` pass `selector` through as the same argv token shape standalone `click` / `fill` would use upstream, including `@refs`, not the `semanticAction` locator schema):
  - `open` with `url`
  - `click` with `selector`
  - `fill` with `selector` and `text`
  - `wait` with positive integer `milliseconds`
  - `assertText` with `text` (compiled as passive `wait --text <text>`)
  - `assertUrl` with `url` pattern (compiled as `wait --url <pattern>`)
  - `waitForDownload` with `path` (compiled as `wait --download <path>`)
  - `screenshot` with `path`

Example:

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

Compiled shape:

```json
{
  "args": ["batch"],
  "stdin": "[[\"open\",\"https://example.com\"],[\"wait\",\"--text\",\"Example Domain\"],[\"screenshot\",\".dogfood/example.png\"]]"
}
```

Use raw `args` plus `stdin` for upstream `batch` when a flow needs commands, flags, stdin forms, or failure policies outside this constrained schema.

Because `job` still executes as upstream `batch` with generated stdin, the same wrapper page-scoped `@e…` preflight applies: if you pass `@refs` in `click`/`fill` selectors after an `open` or another step that can navigate or mutate the page, split the work across tool calls or switch to raw `batch` and insert your own `snapshot -i` rows between steps—the constrained `job` vocabulary does not emit snapshot steps for you.

### `qa`

- type: object with required `url`
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `sourceLookup`, and `networkSourceLookup`
- lightweight preset built on the same batch compiler path as `job`
- clears enabled diagnostic buffers first (`network requests --clear`, `console --clear`, `errors --clear`), then opens `url`, waits with `wait --load <loadState>`, optionally asserts `expectedText` (string or string array) and/or `expectedSelector` (each may be omitted for a load-plus-diagnostics-only smoke), then runs enabled diagnostics: `network requests`, `console`, and `errors`
- `loadState` is optional and must be `domcontentloaded`, `load`, or `networkidle`; it defaults to `domcontentloaded` so analytics-heavy or long-polling pages do not hang routine QA. Use `networkidle` only when the site is expected to go fully quiet.
- `checkNetwork`, `checkConsole`, and `checkErrors` default to `true`; set a field to `false` to omit that diagnostic
- optional `screenshotPath` adds an evidence screenshot step
- reports `details.compiledQaPreset` with the compiled batch plan and resolved `loadState`, plus `details.qaPreset` with `{ passed, failedChecks, warnings, summary }`
- fails the native tool result with `failureCategory: "qa-failure"` when diagnostics report page errors, console error messages, actionable failed network requests, or any batch step failure. Benign classification (implementation: `classifyNetworkRequestFailure` → `isBenignAssetFailure` in `extensions/agent-browser/lib/results/shared.ts`) applies only when the row is already treated as failed (`status >= 400`, `failed: true`, or a string `error`—see `isFailedNetworkRequest`), the URL path’s last segment matches the icon basename heuristic (`favicon` plus `.ico`/`.png`/`.svg`, or `apple-touch-icon` plus `.png`, each allowing an optional `[-.\w]*` stem suffix before the extension), **and** at least one of `status === 404`, `failed === true`, or `typeof request.error === "string"` holds (so a **status-only** failure such as `500` on that path with neither `failed` nor a string `error` stays actionable). It also requires the upstream `resourceType` / `mimeType` (whichever is present) to be absent or look image-like: `image`, `img`, `other`, or a value starting with `image/`. Those rows are counted in `qaPreset.warnings` (for example `N benign network request failure(s) ignored`) and omitted from the actionable failed-network tally; every other failed request stays actionable.

Example:

```json
{ "qa": { "url": "https://example.com", "expectedText": "Example Domain", "screenshotPath": ".dogfood/qa-example.png" } }
```

Use custom `job` or raw `batch` for QA flows that need custom commands, flags, auth setup, HAR capture, or project-specific assertions.

### `sourceLookup`

- type: object with at least one of `selector`, `reactFiberId`, or `componentName`
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `qa`, and `networkSourceLookup`
- experimental opt-in helper for local app debugging; it reports candidate source locations with confidence and evidence instead of claiming a guaranteed DOM-to-file mapping
- compiles to existing upstream `batch` commands only:
  - `selector` adds `is visible <selector>` and, unless `includeDomHints: false`, adds `get html <selector>` for source-like DOM attributes (`data-source-file`, `data-file`, `data-component-file`, `data-source`, plus optional `data-source-line` / `data-line` and `data-source-column` / `data-column`) and for `.ts`/`.tsx`/`.js`/`.jsx` paths embedded in HTML text
  - `reactFiberId` runs `react inspect <id>`; this requires the page to have been launched with `--enable react-devtools` before first navigation and for the app build to expose source information
  - `componentName` runs `react tree` and performs a bounded local workspace scan under the Pi tool session **cwd** for matching component declarations in `.ts`, `.tsx`, `.js`, and `.jsx` files (skipping directories such as `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `out`, `tmp`, and `temp`); the walk stops after `maxWorkspaceFiles` files (default 2000, hard cap 5000) and records at most ten `workspace-search` candidates
- optional `includeDomHints: false` skips the selector HTML read
- optional `maxWorkspaceFiles` bounds the local component-name scan; default is 2000 source files and the hard maximum is 5000
- reports `details.compiledSourceLookup` with the generated batch plan and `details.sourceLookup` with `{ status, candidates, limitations, summary }`
- each `candidates[]` entry includes `source` (`react-inspect`, `dom-attribute`, or `workspace-search`), `confidence` (`high`, `medium`, or `low`), `evidence` (string reasons), and optional `file`, `line`, `column`, and `componentName`
- `details.sourceLookup.status` is one of `candidates-found`, `no-candidates`, or `unsupported`; `unsupported` applies only when **no** candidates were collected **and** at least one compiled `react` batch step failed (for example React DevTools not enabled, no renderer, or inspect errors). If DOM or workspace evidence still produced candidates, `status` stays `candidates-found` even when a `react` step failed
- when analysis produces a `summary`, the wrapper prepends it to the primary visible text block (or inserts a leading text block) for quick scanning; unlike `qa`, it never flips the unified tool outcome to failed solely because diagnostics look noisy or because `status` is `no-candidates` / metadata was missing—failed upstream batch steps still surface as normal tool errors

Example:

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

Use raw `args` for direct upstream React inspection when you already know the exact `react tree` / `react inspect` command you want, or when this experiment's bounded evidence model is too narrow.

### `networkSourceLookup`

- type: object with at least one of `requestId`, `filter`, or `url`, plus optional `maxWorkspaceFiles`
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `qa`, and `sourceLookup`
- experimental failed-request source-hint helper; it reports failed network requests and candidate source hints with evidence instead of assigning blame
- compiles to existing upstream `batch` commands only: `network request <requestId>` when provided plus `network requests` with `--filter <filter-or-url>` when a filter or URL is provided (if both are set, `filter` wins; when only `url` is set, it becomes the `--filter` argument)
- detects failed requests from `status >= 400`, `failed: true`, or an `error` field
- candidate sources come from source-like initiator/stack metadata in upstream network results and bounded local workspace search for URL/path literals under the Pi session cwd
- optional `maxWorkspaceFiles` defaults to 2000 and cannot exceed 5000; workspace-search candidates are capped at ten
- reports `details.compiledNetworkSourceLookup` with the generated batch plan and `details.networkSourceLookup` with `{ status, failedRequests, candidates, limitations, summary }`
- `details.networkSourceLookup.status` is one of `failed-requests-found`, `no-failed-requests`, or `no-candidates`
- `details.networkSourceLookup.failedRequests[]` lists correlated failed requests (optional `requestId`, `url`, HTTP `status`, `method`, `error`) after the same failure heuristics as analysis
- each `candidates[]` entry uses `source` `initiator` (parsed from upstream initiator/stack/source/trace fields on matching requests) or `workspace-search` (string match of URL/path needles in local source files), plus `confidence`, `evidence`, optional `file`/`line`, and optional `requestUrl`; URLs and query parameters in these surfaces are redacted for model-facing output

Example:

```json
{ "networkSourceLookup": { "requestId": "req-1", "url": "/api/fail" } }
```

Use raw `args` for HAR capture, full request body inspection, or custom network debugging beyond this bounded evidence model.

### `stdin`

- type: `string`
- optional
- raw stdin for `eval --stdin`, `batch`, and `auth save --password-stdin`; generated internally when `job`, `qa`, `sourceLookup`, or `networkSourceLookup` compiles to `batch`
- do not provide `stdin` with `job`, `qa`, `sourceLookup`, or `networkSourceLookup`; those modes own the generated batch stdin and reject caller-provided stdin to avoid ambiguity
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
- if `args` already include `--session` (including argv compiled from optional `semanticAction.session`), upstream session choice wins
- `"auto"` prepends the current extension-managed active session when appropriate
- `"fresh"` rotates that managed session to a fresh upstream launch so startup-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device` apply and later default calls follow the new browser
- stateless paths skip that injection even under `"auto"`: plain-text `--help` / `-h` / `--version` / `-V` (see the generated inspection playbook fragment below) and read-only `skills list`, `skills get …`, and `skills path …` keep `effectiveArgs` free of the implicit managed `--session` unless the caller supplied `--session` explicitly; successful results therefore omit `usedImplicitSession` and the extension-managed `sessionName` for those calls (`extensions/agent-browser/lib/runtime.ts`, `buildExecutionPlan`)

Recommended use:
- use `"auto"` for the common browse/snapshot/click flow inside one `pi` session
- use `"fresh"` when switching from an already-active implicit session to a new profile/debug/auth/provider launch without inventing a fixed explicit session name
- when a fresh launch fails or times out before becoming current, check `details.managedSessionOutcome`: it states whether the prior managed session was preserved or whether the attempted fresh session was abandoned because no prior managed session existed; when `sessionMode` is `"fresh"` and the tool ultimately fails, the model-visible result also appends `Managed session outcome: …` (see `#details` below). Failures under `sessionMode: "auto"` still expose the struct on `details` when the extension injects a managed `--session`, but they do not add that extra prose line.

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

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, auto-connect, or provider-backed launches.
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
- when compacting hides actionable controls, snapshot output should add an `Omitted high-value controls` section for bounded searchboxes, textboxes, comboboxes, buttons, tabs, checkboxes, radios, options, and menuitems that were not already shown in key refs

Examples:
- small `snapshot` results should include the actual snapshot text
- oversized `snapshot` results should switch to a compact view that preserves the primary content, nearby sections, a trimmed set of high-value refs, and a separate bounded list of omitted high-value controls when dense pages would otherwise hide important inputs/tabs/buttons, while exposing the full raw snapshot path directly in the rendered tool text and via `details.fullOutputPath`
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
- `successCategory`: present on successful results. Current values are `"completed"`, `"artifact-saved"`, `"artifact-unverified"`, and `"inspection"`. `artifact-unverified` means upstream reported success but the merged `artifactVerification` summary still reports missing or unverified rows (including manifest-backed spill rows), or the legacy artifact classifier still sees a non-pending file without confirmed disk presence; inspect `artifactVerification` (counts and per-entry `state` / optional `limitation`) before treating paths as durable.
- `failureCategory`: present on failed results. Current values are `"aborted"`, `"confirmation-required"`, `"download-not-verified"`, `"missing-binary"`, `"parse-failure"`, `"qa-failure"`, `"selector-not-found"`, `"selector-unsupported"`, `"stale-ref"`, `"tab-drift"`, `"timeout"`, `"upstream-error"`, and `"validation-error"`.

These categories are intentionally bounded and stable so agents can branch on them instead of parsing prose. They do not replace raw diagnostics: `details.error`, `details.stderr`, `details.parseError`, `details.validationError`, and visible content still preserve the specific upstream or wrapper message after normal redaction.

For `batch`, top-level `details` still carries `resultCategory` plus `successCategory` or `failureCategory` for the **aggregate** tool outcome: if any step fails, the overall result is a failure (`resultCategory: "failure"`) even when later steps succeed—inspect `batchSteps[]` for per-step outcomes. Each `batchSteps[]` entry includes its own `resultCategory` and either `successCategory` or `failureCategory` for that step. `batchFailure.failedStep` duplicates the first failing step’s details, including its `failureCategory` and any `nextActions`.

Top-level `details.data` on `batch` is a compact per-step roll-up (not a verbatim replay of raw upstream batch JSON): each element is `{ success, command, result? | error? }` where `command` is argv-redacted the same way as echoed invocation args (including `cookies set` cookie values, `storage local|session set` values, and other sensitive flags/positionals), `result` is the presentation-layer data for that step after the same structured redaction as non-batch commands, and `error` is failure text with cookie/storage/password literals stripped when those values appeared in argv. Prefer `batchSteps[]` for full per-step `details` (artifacts, categories, spill paths); use the roll-up when you only need a redacted matrix of what ran.

`details.refSnapshot` may appear after successful `snapshot` calls and subsequent same-session calls. It records the latest page-scoped ref ids known to the wrapper and the page target they came from so mutation-prone `@e…` commands can fail fast instead of silently hitting recycled refs after navigation.

Ref preflight details (implementation in `extensions/agent-browser/index.ts`):

- **URL alignment:** `refSnapshot.target.url` and the session’s current tab URL are compared via `targetsMatch` / `normalizeComparableUrl` in `extensions/agent-browser/index.ts`: values are trimmed, parsed as URLs when possible, compared **after dropping the `#fragment`**, and the query string remains significant. If either side lacks a `url`, `targetsMatch` treats the pair as matching so early-session calls are not blocked.
- **Batch stdin ordering:** user `batch` JSON is scanned in order. Any step whose first token is in `REF_INVALIDATING_BATCH_COMMANDS` sets a latch that blocks later steps whose first token is in `REF_GUARDED_COMMANDS` and that mention `@e…` refs. A step whose first token is `snapshot` clears that latch for subsequent steps (pre-spawn intent only; it does not wait for upstream success). The invalidating set includes navigation/mutation verbs such as `open`, `goto`, `reload`, `click`, `fill`, and related upstream commands; the guarded set is the commands that accept page-scoped refs for interaction (`click`, `fill`, `download`, `scrollintoview`, and others enumerated next to those literals in source). Changing either set requires updating this contract, [`docs/SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) `RQ-0072` notes, README and command-reference pitfalls, and `test/agent-browser.extension-validation.test.ts`.

**Presentation redaction (implementation map):** Successful non-`batch` tool calls and each successful `batchSteps[]` row run upstream `data` through `redactPresentationData` in `extensions/agent-browser/lib/results/presentation.ts`: `cookies` and `storage` walk objects/arrays and replace case-insensitive `value` keys with `"[REDACTED]"` (diagnostic formatters still describe rows without expanding secrets); every other command’s payload is recursively scrubbed with `redactStructuredPresentationValue`, which redacts known sensitive key names and applies string-level sensitivity heuristics so network, diff, trace/profiler, stream, dashboard, chat, and other structured results do not echo bearer tokens, proxy credentials, or similar fields verbatim into `details.data`. Echoed `command` arrays in `details` and in batch roll-ups use `redactInvocationArgs` from `extensions/agent-browser/lib/runtime.ts` to mask trailing values for sensitive global flags (including `--body`, `--headers`, `--password`, and `--proxy`), preserve the special positional rules for `cookies set`, `storage local|session set`, and `set credentials`, and scrub other argv tokens for URLs and inline secrets. Failed batch steps additionally run `redactExactValues` on structured step errors so literals taken from that step’s argv (cookie value, storage set value, `--password` / `--password=` tokens) cannot reappear inside formatted error blobs.

`nextActions` is an optional machine-readable list of exact native `agent_browser` follow-ups. Each entry includes `tool: "agent_browser"`, an `id`, a short `reason`, optional `safety`, and either `params` (`args`, optional `stdin`, optional `sessionMode`) or an `artifactPath` for saved-file workflows. Agents should prefer these payloads over prose when present. Current recommendations include: `open` success → `snapshot -i`; mutating/navigation commands (see `buildAgentBrowserNextActions` in source for the exact command set) → `snapshot -i`; stale refs and selector failures → `snapshot -i` via `refresh-interactive-refs` (prefixed with `--session <name>` when the failed call ran in a named or managed session); unknown getter shortcuts such as `title` / `url` → exact read-only retries like `get title` / `get url` with ids `use-get-title` / `use-get-url`; semantic `selector-not-found` failures that compiled from `semanticAction` may append `try-searchbox-name-candidate`, `try-textbox-name-candidate`, `try-button-name-candidate`, `try-link-name-candidate`, or `try-labeled-textbox-candidate` after presentation `nextActions` only for the bounded fill/click pairs enumerated under `semanticAction` (not for `select`); semantic `stale-ref` failures that compiled from `semanticAction` may also include `retry-semantic-action-after-stale-ref` after that snapshot step; qualifying same-URL top-level clicks (see `overlayBlockers` below) with fresh snapshot evidence of likely overlay/banner/dialog close controls may append `inspect-overlay-state` and bounded `try-overlay-blocker-candidate-*` entries; successful top-level `scroll` calls whose pre/post viewport and sampled scroll-container positions do not change may append `inspect-after-noop-scroll` and `verify-noop-scroll-visually`; explicit combobox-targeted actions that focus a combobox without visible options may append `inspect-focused-combobox`, `try-open-combobox-with-arrow`, and `try-open-combobox-with-enter`; `get text <selector>` calls with hidden/multiple CSS matches may append `inspect-visible-text-candidates` with a read-only `eval --stdin` probe (each prefixed with `--session <name>` when `details.sessionName` is set, same `sessionPrefixArgs` rule as other session-scoped follow-ups); confirmations → exact `confirm <id>` and `deny <id>` choices; tab drift → `tab list` then `snapshot -i`; download verification failures or missing successful download artifacts → `wait --download [path]`; saved artifacts → the artifact path to inspect/consume after checking `artifactVerification`/metadata; missing non-download artifacts → `verify-artifact-path` so agents do not trust an absent file. When nothing applies, the field is omitted.

**Unknown-command getter hints (failure presentation):** `buildToolPresentation` in `extensions/agent-browser/lib/results/presentation.ts` only runs this path when upstream error text (after model-facing redaction) matches `unknown command`, `unknown subcommand`, or `unrecognized command` (case-insensitive) **and** the failed invocation’s primary command token is one of `attr`, `count`, `html`, `text`, `title`, `url`, or `value`. Visible text then includes a grouped-`get` hint line plus per-token guidance (`get text <selector>`, `get html …`, `get attr …`, `get count …`, `get value …`, `get title`, `get url`). Machine `nextActions` with ids `use-get-title` / `use-get-url` are emitted only for `title` / `url`, with `params.args` optionally prefixed by `--session <name>` when the failed call targeted a named session. If the error string already contains `Agent-browser hint:` from selector recovery (stale-ref or unsupported selector dialect appendages), the getter block is skipped so two stacked `Agent-browser hint:` headers are not emitted.

For `batch`, each `batchSteps[]` entry can carry its own `nextActions` for that step’s success or failure. Top-level `details.nextActions` on a failed batch duplicates `batchFailure.failedStep.nextActions` so callers can read one aggregate object. On a fully successful batch, top-level `nextActions` may still list artifact follow-ups derived from the combined step artifacts.

`pageChangeSummary` is an optional compact summary for mutation-prone and artifact-producing commands. It includes `changeType` (`"navigation"`, `"mutation"`, `"artifact"`, or `"confirmation"`), `command`, a readable `summary`, optional `title`/`url`, optional `artifactCount` or `savedFilePath`, and `nextActionIds` that link the observed change to `nextActions` without repeating full payloads. The wrapper maintains an explicit allowlist of mutation-prone commands in `extensions/agent-browser/lib/results/presentation.ts` (`PAGE_CHANGE_SUMMARY_COMMANDS`): those commands still emit a `mutation`-typed summary when upstream JSON lacks navigation metadata, as long as no stronger signal (artifact, saved path, navigation fields, or pending confirmation) applies. Commands outside that set omit `pageChangeSummary` unless the parsed payload shows navigation, a confirmation prompt, saved files, or artifacts—including read-only inspection commands, which normally have no summary unless one of those signals appears. For `batch`, the top-level summary favors artifact rollups when any step produced artifacts; otherwise it may synthesize a `mutation` summary from steps that carried their own `pageChangeSummary`.

`overlayBlockers` may appear after a successful **top-level** `click` (the unified `details.command` is `click`, not `batch`/`job`/`qa` flows that compile to `batch`) only when upstream JSON includes a string `data.clicked` ref, the session’s prior pinned tab URL (`priorSessionTabTarget.url`) and the post-click active tab URL both exist and stay equal after the same URL normalization used for ref preflight (trimmed hosts/paths; **`#fragment` dropped** while the query string stays significant), and the wrapper did not apply session tab correction or an about-blank mismatch recovery in the same result. The post-click side comes from `details.navigationSummary.url`, which the wrapper fills via follow-up `get url` / `get title` only when upstream click JSON omits **both** string `data.url` and `data.title` (`shouldCaptureNavigationSummary` in `extensions/agent-browser/index.ts`). If either field is present as a string on the click payload, that probe is skipped, `navigationSummary` stays unset here, and overlay diagnostics are omitted even when the page did not navigate. The wrapper then issues **one** extra session-scoped `snapshot -i`, scans that snapshot’s `refs` map, and only emits diagnostics when **both** are true: at least one ref has a strong modal role (`dialog` or `alertdialog`), and there are up to **three** separate `button`/`link`/`menuitem` refs whose names match close/dismiss-style patterns (for example “Close”, “Dismiss”, “No thanks”, or a lone `×`). Page-wide text such as “privacy”, “sign in”, or “banner” without a dialog role is not enough, which avoids warning on ordinary same-page menu opens or app button mutations. Each candidate carries `ref` (`@eN`), optional `role`/`name`, exact `click` argv in `args`, and a short evidence `reason`. The struct also includes a `summary` string (one sentence stating that the click left the tab on the same normalized URL and the fresh snapshot shows likely dismiss controls) plus a `snapshot` object (same shape as `details.refSnapshot` after a normal snapshot): on success the wrapper may treat that snapshot as the session’s latest ref map for subsequent calls, so agents should assume refs can move to match this post-diagnostic tree. Visible text appends the same bullets under `Possible overlay blockers`, and `details.nextActions` gains `inspect-overlay-state` plus `try-overlay-blocker-candidate-1`…`3` after any presentation `nextActions` (for example `inspect-after-mutation`); when `details.sessionName` is set, those appended actions use `sessionPrefixArgs` so `params.args` begin with `--session <name>` unless argv already starts with `--session`. This is conservative evidence, not proof the candidate should be clicked; prefer `inspect-overlay-state` first unless the dismiss control is clearly safe.

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

When `semanticAction` produced compiled argv but the unified result is `failureCategory: "stale-ref"` with `details.compiledSemanticAction` still present, `nextActions` chains snapshot refresh then the compiled `find` retry; `reason` / `safety` strings match `buildAgentBrowserNextActions` in `extensions/agent-browser/lib/results/shared.ts` and the append in `extensions/agent-browser/index.ts`:

```json
"nextActions": [
  {
    "tool": "agent_browser",
    "id": "refresh-interactive-refs",
    "reason": "Get current interactive refs before retrying the element action.",
    "safety": "Prefer a current @ref or a stable find locator; do not retry stale refs blindly.",
    "params": { "args": ["snapshot", "-i"] }
  },
  {
    "tool": "agent_browser",
    "id": "retry-semantic-action-after-stale-ref",
    "reason": "Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.",
    "safety": "Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.",
    "params": { "args": ["find", "text", "Submit", "click"] }
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

- Types, classifiers, and follow-up assembly live in `extensions/agent-browser/lib/results/shared.ts`: `classifyAgentBrowserSuccessCategory`, `classifyAgentBrowserFailureCategory`, `buildAgentBrowserResultCategoryDetails` (the last prefers an explicit `failureCategory` when the caller already knows the bucket, otherwise it runs the classifier), and `buildAgentBrowserNextActions`. Failed upstream `network requests` rows also flow through `classifyNetworkRequestFailure` / `summarizeNetworkFailures` there for QA analysis (`analyzeQaPresetResults` in `extensions/agent-browser/index.ts`) and for actionable-vs-benign lines in `network requests` presentation (`extensions/agent-browser/lib/results/presentation.ts`).
- Artifact verification: `ArtifactVerificationSummary` / `ArtifactVerificationEntry` types live in `shared.ts`. `buildArtifactVerificationSummary`, `getArtifactVerificationEntry`, and `getManifestVerificationEntry` in `presentation.ts` merge each resolved file artifact with manifest rows whose `storageScope` is not `explicit-path` (those rows duplicate file artifacts) and whose `path` is in the current result’s spill path set. Successful presentation merges then run `classifyPresentationSuccessCategory` in `presentation.ts`, which forces `successCategory: "artifact-unverified"` when `artifactVerification.missingCount` or `artifactVerification.unverifiedCount` is greater than zero before delegating to `classifyAgentBrowserSuccessCategory`.
- Inner success categories (`classifyAgentBrowserSuccessCategory` in `shared.ts`, after verification counts are clear): if `inspection` is true → `"inspection"`; else if any non-pending artifact lacks confirmed on-disk presence (`exists !== true`) → `"artifact-unverified"`; else if there is a `savedFile` or any `artifacts` → `"artifact-saved"`; else → `"completed"`.
- Failure: the classifier walks a single ordered chain (first match wins): `confirmation-required` → `timeout` → `missing-binary` → `parse-failure` → `aborted` → `tab-drift` → `stale-ref` (including “unknown ref” text and a narrow `@eN` plus “element not found” heuristic) → `selector-unsupported` → `selector-not-found` → `download-not-verified` (download / wait-download style failures) → `validation-error` when a wrapper `validationError` is present → default `upstream-error`.
- The main tool implementation merges these fields into Pi-facing `details` from `extensions/agent-browser/index.ts` and from `extensions/agent-browser/lib/results/presentation.ts` for presentation-time failures.

Additional structured fields can appear when relevant:
- `compiledSemanticAction` when the call used `semanticAction` and the result includes the unified `details` merge: `{ action, locator, args }` with the same redaction rules as `args` / `effectiveArgs`; omitted for plain `args`/`job` calls and omitted on some early error returns that omit this field (see the `semanticAction` section above)
- `compiledJob` when the call used `job` or the job-backed `qa` preset: `{ args: ["batch"], stdin, steps: [{ action, args }] }`, with step args redacted the same way as other invocation details
- `compiledQaPreset` when the call used `qa`: the compiled job fields plus the QA `checks` object
- `qaPreset` when the call used `qa`: `{ passed, failedChecks, warnings, summary }`. Network rows inside the `network requests` batch step use `summarizeNetworkFailures` / `classifyNetworkRequestFailure` in `shared.ts`: actionable failures appear in `failedChecks` (and fail the tool when the upstream batch still succeeded); benign icon-classified failures appear only in `warnings` and in `summary` as `QA preset passed with warnings: …` when nothing else failed.
- `batchFailure` and `batchSteps` for `batch` rendering, including mixed-success runs
- `navigationSummary` for navigation-style commands like `click`, `back`, `forward`, and `reload`
- `pageChangeSummary` for compact mutation/artifact/navigation summaries on commands that can change browser state
- `overlayBlockers` for conservative post-click overlay/banner/dialog blocker candidates when a direct click stays on the same URL and a fresh snapshot provides evidence (`candidates`, `summary`, and `snapshot` per `OverlayBlockerDiagnostic` in `extensions/agent-browser/index.ts`)
- `scrollNoop` after a successful **top-level** `scroll` when wrapper-side read-only probes before and after the command show no change in `window.scrollX` / `window.scrollY` and no change in the sampled prominent scrollable containers. To avoid pre-launching a session without caller startup state, this probe is skipped when the invocation includes startup-scoped flags such as `--profile`, `--state`, `--session-name`, `--cdp`, providers, init scripts, or similar launch settings. Shape: `{ reason: "no-observed-scroll-position-change", message, before, after, recommendations }`; `before` / `after` include viewport dimensions, document scroll dimensions, and up to ten sampled container descriptors plus scroll offsets. Container descriptors use only sample index, tag name, and ARIA role; DOM ids/classes are intentionally not stored. This diagnostic is conservative evidence that the page-level scroll likely missed a nested pane, not proof that every app-specific region is unchanged. Visible text appends `Scroll diagnostic: no observed scroll movement`, and `details.nextActions` gains `inspect-after-noop-scroll` (`snapshot -i`) plus `verify-noop-scroll-visually` (`screenshot`), session-prefixed when applicable.
- `comboboxFocus` after a successful explicit combobox-targeted `click` / `fill` / `find … click|fill|select` (for example `semanticAction` with role `combobox`, including when that semantic action resolves through a current visible `@ref` before execution) when a read-only probe sees the active element is combobox-like, `aria-expanded` is explicitly `false`, and no visible `listbox` / `option` / menu option elements are open. Shape: `{ reason: "focused-combobox-without-visible-options", message, activeElement, visibleListboxCount, visibleOptionCount, recommendations }`; `activeElement` includes bounded role/tag/expanded/hasPopup/name metadata with normal text redaction. Visible text appends `Combobox diagnostic: focused combobox did not expose visible options`, and `details.nextActions` gains `inspect-focused-combobox` (`snapshot -i`), `try-open-combobox-with-arrow` (`press ArrowDown`), and `try-open-combobox-with-enter` (`press Enter`), session-prefixed when applicable. The diagnostic is deliberately gated to explicit combobox-targeted calls to avoid extra probes or false positives on ordinary clicks/textboxes.
- `recordingDependencyWarning` after a successful `record start` or `record restart` when the wrapper cannot find an executable `ffmpeg` on the Pi process `PATH`. Shape: `{ reason: "ffmpeg-missing-for-recording", dependency: "ffmpeg", command, message, recommendations }`. Visible text appends `Recording dependency warning: ffmpeg not found on PATH`. This is a non-blocking preflight warning: upstream may start recording, but `record stop` needs `ffmpeg` to encode the WebM.
- `selectorTextVisibility` after a **successful** upstream `get text <selector>` (standalone or inside a successful `batch`) when the wrapper’s follow-up probe finds a hazard: more than one DOM match (upstream reads the first `querySelectorAll` hit, which may be the wrong tab/panel), or the first match is hidden while at least one other match is visible (requires multiple DOM nodes so a visible peer exists; a lone hidden match is not flagged). The probe is a read-only `eval --stdin` script (`buildVisibleTextProbeScript` in `extensions/agent-browser/index.ts`) that counts matches, applies a small visibility heuristic (`display`/`visibility`/`opacity` plus non-zero client rects), and may include a redacted `firstVisibleTextPreview`. It is **not** run for page-scoped `@e…` selectors or when the selector string is withheld because `selectorMayExposeSensitiveLiteral` would risk echoing secrets in probe output. `details.selectorTextVisibility` mirrors the primary diagnostic (first sorted entry); when several selectors in one `batch` qualify, `selectorTextVisibilityAll` lists every diagnostic sorted so hidden-first cases precede generic multi-match ambiguity. Appended `details.nextActions` use ids `inspect-visible-text-candidates` and `inspect-visible-text-candidates-2`, … with the probe replayed via `eval --stdin` for each hazardous selector.
- `evalStdinHint` after a successful `eval --stdin` when caller stdin (trimmed) looks function-shaped to the wrapper’s lightweight detector (`looksLikeFunctionEvalStdin` in `extensions/agent-browser/index.ts`: leading `function` / `async function`, parenthesized arrow `(…) =>`, or a concise `name =>` / `async name =>` form) **and** upstream JSON `data` is an object whose `result` field is an empty object (`{}`). It includes `reason` and `suggestion`; visible output appends `Eval stdin hint` with the same guidance. This is a heuristic for the common mistake of returning a function object instead of invoking it or passing a plain expression, not a JavaScript parser or proof that the page returned no useful data.
- `timeoutPartialProgress` after `runAgentBrowserProcess` reports `timedOut` (wrapper child-process watchdog) when best-effort recovery finds useful context. `summary` is a short sentence counting how many declared artifact paths exist on disk versus how many were scanned, and whether page context came from live session reads or only from a planned URL (when nothing in the plan declares an artifact path, the fraction may read `0/0` while `currentPage` can still carry session or planned URL context). `steps` lists planned argv from the compiled `job` or `qa` batch plan (`compiledJob` in `extensions/agent-browser/index.ts`, which is only populated for those top-level modes) or, when that object is absent, from the same JSON-array `batch` stdin the tool sends upstream—whether caller-authored or wrapper-generated for `sourceLookup` / `networkSourceLookup` (1-based indices; only JSON-array stdin whose elements are string[] argv arrays is parsed); timeouts on other argv shapes may still emit `currentPage` / summary evidence without `steps`. `currentPage` comes from session-scoped `get url` / `get title` when the session answers, otherwise a fallback URL may be inferred from the last `open` / `navigate` / `pushstate` step in the plan. `artifacts` covers declared output paths on `screenshot`, `pdf`, `download`, and `wait --download` steps (absolute path, existence, optional `sizeBytes`, `stepIndex`). Visible text repeats the same block under `Timeout partial progress`, applying URL and path-segment redaction; the prose `Planned steps` list shows at most six steps, then an omitted-count line when the plan is longer. This is recovery evidence only; missing entries do not prove the upstream step never ran or that no other side effects occurred.
- `managedSessionOutcome` after a managed-session plan reaches process execution (`buildManagedSessionOutcome` / `formatManagedSessionOutcomeText` in `extensions/agent-browser/index.ts`). Populated when `buildExecutionPlan` injects an extension-managed implicit or fresh `--session` (omitted when the caller already set explicit upstream `--session` or for stateless inspection paths that skip injection). Fields: `status` (`created`, `replaced`, `unchanged`, `closed`, `preserved`, or `abandoned`), `sessionMode`, `attemptedSessionName`, `previousSessionName`, `currentSessionName`, optional `replacedSessionName`, `activeBefore`, `activeAfter`, `succeeded`, and `summary`. Model-visible echo: only when `sessionMode` is `"fresh"` **and** `succeeded` is false, the wrapper appends a line of the form `Managed session outcome: ${summary}` after the primary presentation (including missing-binary failures on a fresh plan, where it follows the missing-binary message and no other diagnostic tail runs). When other trailing diagnostic prose is also emitted in the same result, that line is concatenated **after** semantic-action candidate lines, overlay/selector-visibility tails, and `Timeout partial progress` (see `rawAppendedDiagnosticText` in `extensions/agent-browser/index.ts`). For `"auto"` failures the same struct may appear on `details` without that extra line. When post-upstream analysis (for example **`qa`** preset failure) flips the overall tool result after a successful batch, the implementation only realigns `managedSessionOutcome.succeeded` to the final outcome; `status`/`summary` may still describe the managed-session transition (for example `replaced` while `failureCategory` is `qa-failure`), so read `failureCategory` / `qaPreset` / `batchFailure` alongside this object.
- `imagePath` / `imagePaths` for Pi inline image attachments from the **`screenshot`** command (including batched screenshot steps). **`diff screenshot`** still records the diff output as an `image`-kind entry in `details.artifacts`, but it does **not** populate `imagePath` / `imagePaths` or attach an inline image: only plain `screenshot` is treated as a trusted live-capture path for automatic inlining (`isTrustedScreenshotOutput` in `extensions/agent-browser/lib/results/presentation.ts`).
- `artifacts` for upstream saved files such as screenshots, `state save` outputs, `diff screenshot` diff images, PDFs, downloads, `wait --download` files, traces, CPU profiles, completed WebM recordings, path-bearing HAR captures, and future recording output paths reported by `record start`. Each artifact includes the original saved or requested `path`, resolved `absolutePath`, `kind`/`artifactType`, optional `mediaType`, optional `extension`, best-effort disk metadata such as `exists` and `sizeBytes`, plus `requestedPath`, `status`, `cwd`, `session`, and `tempPath` when applicable.
- `savedFilePath` / `savedFile` for direct `download`, `pdf`, and `wait --download` saved-file workflows; batch results preserve the same fields on the relevant `batchSteps` entry.
- `batchSteps[].artifacts` for per-step artifacts in `batch` output; top-level `artifacts` aggregates all step artifacts in order
- `artifactVerification` for a normalized verification summary on the unified result and on each successful `batchSteps[]` row (failed batch steps omit artifact rows). Top-level `batch` verification rolls up all step file artifacts; each step’s summary reflects that step’s nested tool presentation (including its spill paths and manifest slice). It reports `verified`, `verifiedCount`, `missingCount`, `pendingCount`, `unverifiedCount`, and `artifacts[]` entries with `path`, optional `absolutePath`, optional `requestedPath`, `kind` (a normal file artifact kind or `"spill"` for manifest-backed rows), optional `mediaType`, optional `exists`, optional `sizeBytes`, optional `status`, optional `retentionState` / `storageScope` on manifest-derived rows, `state` (`verified`, `missing`, `pending`, or `unverified`), and optional `limitation` (human-readable lifecycle or retention context, for example pending `record start`, missing or unverified files, ephemeral spill files, or evicted persisted spills). The summary `verified` boolean is true only when every entry is `verified`. `record start` is `pending` until `record stop`; `state load` may mention a path in command output but is not a saved artifact row.
- `fullOutputPath` / `fullOutputPaths` when large snapshot output or other oversized tool output is compacted and spilled to a private file; persisted sessions keep that path under a private session-scoped artifact directory with a bounded per-session budget so it survives reload/resume without unbounded growth
- `artifactManifest` for a bounded, metadata-only inventory of recent session artifacts. Entries include path metadata, artifact `kind`, source `command`/`subcommand` when safe, `storageScope` (`persistent-session`, `process-temp`, or `explicit-path`), and `retentionState` (`live`, `ephemeral`, `missing`, or `evicted`). The default recent window is 100 entries and can be configured with `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES`. The manifest must not store command args, output contents, headers, DOM snapshots, or downloaded file contents.
- `artifactRetentionSummary` with a concise count of live, evicted, ephemeral, and missing artifacts from the current manifest; results append this summary to model-facing text only when retention state affects recovery, such as spill files, ephemeral files, or evictions. Routine explicit saved files keep the summary in details to avoid noisy browsing transcripts.
- `artifactCleanup` after a successful `close` when `artifactManifest` exists and `entries` is non-empty. Fields: `owner: "host-file-tools"`, `summary` (same retention summary string as `artifactRetentionSummary` for that manifest), `note` explaining that browser close does not delete explicit screenshots/downloads/PDFs/traces/HAR/recordings, and `explicitArtifactPaths`: up to ten **distinct existing** paths taken from manifest rows with `storageScope: "explicit-path"` in encounter order (de-duplicated after checking the filesystem); deleted/stale explicit paths are skipped. When the recent window has no existing explicit rows—for example only spill/ephemeral inventory or explicit paths already deleted—the array is empty but `summary` / `note` still surface so agents know close is not file deletion. The native browser tool intentionally does not expose a delete operation for arbitrary user-chosen artifact paths; agents should inspect `artifactVerification` / manifest metadata, then remove files with normal host file tools when cleanup is required.
- compact **snapshot** metadata on successful presentation when `details.data.compacted` is true (oversized trees): `previewMode` (`"structured"` vs outline `"outline"`), `structuredPreviewUsed`, `previewRefIds`, `previewSections` (per-section `linesShown` / `omittedLines` / root `role` / `title`), `additionalSectionsOmitted`, counts such as `refCount`, `snapshotLineCount`, and `roleCounts`, optional `highValueControlRefIds` aligned with the visible `Omitted high-value controls` lines, and optional `spillError` when the wrapper could not write the raw spill file; the model text still ends with `Full raw snapshot path:` or an explicit unavailable reason plus `details.fullOutputPath` when a path exists
- `sessionRecoveryHint` when startup-scoped flags need `sessionMode: "fresh"` while an implicit session is already active: includes `reason`, `recommendedSessionMode` (`"fresh"`), redacted `exampleArgs`, and `exampleParams` where `sessionMode` is `"fresh"` and `args` is the same redacted argv as `exampleArgs` (from `buildExecutionPlan` in `extensions/agent-browser/lib/runtime.ts`, merged through `redactRecoveryHint` in `extensions/agent-browser/index.ts`)
- `inspection: true` plus `stdout` for successful plain-text inspection commands like `--help` and `--version`

When the tool echoes `args` or `effectiveArgs` back into Pi, sensitive values such as `--headers`, proxy credentials, and auth-bearing URL parameters should be redacted first.

For oversized snapshots and other oversized tool outputs, details should switch to a compact metadata object and include `fullOutputPath` pointing at a private spill file with the full redacted upstream payload. The model-facing tool text should print the actual spill-file path when one exists instead of only saying to inspect a details key. Persisted sessions should keep that spill file under a private session-scoped artifact directory so the path remains usable after reload/restart. The oldest persisted spill files are evicted as needed to stay within `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB), and those evictions are reported as `artifactManifest.entries[].retentionState: "evicted"` instead of silently disappearing from the session inventory. This persisted-spill byte budget is separate from the recent metadata window controlled by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES`.

## High-value result rendering

"Rendering" here means how results appear inside `pi`, not embedding a browser UI.

The TUI renderer is user-facing only. It may compact or colorize what the human sees in the Pi transcript, but it must not further truncate, summarize, or remove the model-facing `content` returned by the tool. Use the existing `details.fullOutputPath` / spill-file contracts for content that is too large for the model.

Worth doing in v1:
- screenshots → saved-path summary, visible artifact metadata, `details.artifacts` metadata, and inline image attachment when safe; screenshot paths that upstream would treat ambiguously, such as `.dogfood/run/foo.png`, are normalized to absolute paths before launch and repaired from upstream temp output when possible
- file artifacts such as PDFs, downloads, `wait --download` files, `state save` state files, diff screenshot output images, traces, CPU profiles, completed WebM recordings, and path-bearing HAR captures → concise saved-path summaries plus metadata in `details.artifacts` and bounded recent metadata in `details.artifactManifest`; `record start` reports recording lifecycle state and the future output path without adding a missing manifest entry; upstream needs `ffmpeg` on `PATH` for `record stop` to encode the WebM, and successful `record start` / `record restart` calls may also expose `details.recordingDependencyWarning` when the wrapper cannot find `ffmpeg`; direct saved-file workflows also expose `details.savedFilePath` / `details.savedFile`; large or binary artifacts are not inlined into model context; the recent manifest cap can age out explicit-file metadata but does not remove explicit saved files from disk
- `diff screenshot` → same file-artifact pattern as above for the **diff** image path only (summary text uses “Saved diff image”); baseline paths and other fields stay in the structured payload but are not echoed as separate saved artifacts in the visible artifact block, and there is no Pi inline image attachment for the diff output
- `state load` → completion text may mention the loaded path, but the wrapper does **not** treat that path as a new saved artifact (`artifacts` / `artifactManifest` stay unset) the way `state save` does
- auth, cookies, storage, dialog, frame, state, network, debug, diff, stream, dashboard, chat, and other structured results → concise summaries that avoid expanding secret-bearing payloads; credential-like keys, values, URLs, body snippets, bearer/basic credentials, and cookie/storage values are redacted before model-facing output and `details.data`
- TUI display → custom `agent_browser` call/result rendering with colorized command/output text and a built-in-style collapsed view for long visible output; `ctrl+o` expansion reveals the full rendered tool result without changing the model-facing content
- snapshots → origin + ref count + main-content-first compact preview, with the raw snapshot spill path printed directly in content and kept in `details.fullOutputPath` plus `details.artifactManifest` when the inline result would otherwise be too large
- oversized generic outputs such as large `eval --stdin` payloads → compact preview plus the actual spill file path instead of dumping the whole payload into model context
- extraction-style commands like `eval --stdin` and `get title` → scalar-first text with lightweight origin context when available
- navigation actions like `click`, `back`, `forward`, and `reload` → lightweight post-action title/url summary when available
- tab lists → compact summary/table
- stream status → enabled/connected/port summary plus WebSocket URL and frame format when a port is known; if the caller explicitly passed `--json`, visible text is valid JSON instead of a prose summary
- diagnostic/status families (`session`, `session list`, `profiles`, `doctor`, `auth list`/`show`, `cookies`, `storage`, `dialog`, `frame`, `state`, `network requests`, `console`, `errors`, and dashboard start/stop/status outputs) → compact readable summaries with counts and stable fields; network request lists include an actionable-vs-benign failed-request summary and mark low-impact browser icon failures separately; large log/request/error outputs use previews plus `fullOutputPath` spill files; sensitive nested auth/header/token fields are not expanded in the model-facing text
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
- when an unnamed `sessionMode: "fresh"` launch fails or times out, preserve the previous managed session when one was active or report the attempted fresh session as abandoned when no managed session was active (`details.managedSessionOutcome`; visible `Managed session outcome: …` only when the final tool call used `sessionMode: "fresh"` and failed—see `#details`)
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
- keep wrapper-spawned commands below the upstream CLI IPC read-timeout budget by clamping `AGENT_BROWSER_DEFAULT_TIMEOUT` to 25 seconds and stopping a stuck child process before the upstream 30-second retry path begins (`PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS` configures the watchdog); timed-out compiled `job` / `qa` or caller `batch` calls may add `details.timeoutPartialProgress` and visible `Timeout partial progress` evidence with planned steps, current page title/URL, and declared artifact path checks
- interactive or long-running upstream families such as `chat` without a prompt, `dashboard start`, `stream enable`, `trace start`, `profiler start`, `record start`, `inspect`, `install`, `upgrade`, `doctor --fix`, and `confirm-interactive` are passed through thinly but remain bounded by the same wrapper timeout/session planning rules; prefer explicit arguments, single-shot `chat <message>`, non-interactive flags like `doctor --offline --quick` or `doctor --json`, and cleanup pairs such as `dashboard stop`, `stream disable`, `trace stop`, `profiler stop`, and `record stop`
- treat successful plain-text inspection commands like `--help` and `--version` as stateless: do not inject the implicit managed session and do not let those calls claim the managed-session slot
- if startup-scoped flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device` are supplied after the implicit session is already active while `sessionMode` is `"auto"`, return a validation error with a structured recovery hint that recommends `sessionMode: "fresh"`
- for direct headless local Chrome launches to `chat.com` / `chatgpt.com` / `chat.openai.com`, allow a narrow compatibility fallback that injects a normal Chrome `--user-agent` only when the caller did not explicitly provide one and did not choose `--headed`, `--cdp`, `--auto-connect`, or a provider-backed launch

## Non-goals

- no giant action enum mirroring the whole upstream CLI
- no support for older `agent-browser` versions
- no compatibility shims
- no first-class reusable named browser recipe runtime above constrained `job`, the `qa` preset, experimental `sourceLookup` / `networkSourceLookup`, and raw `batch` / `args`; see [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet) (closed `RQ-0068`)
- no embedded browser UI inside `pi`
