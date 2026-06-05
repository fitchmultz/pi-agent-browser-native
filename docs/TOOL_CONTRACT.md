# Tool contract

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md)
- [`ELECTRON.md`](ELECTRON.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

## V1 tool

V1 exposes one primary native browser tool and one optional companion search tool:

- `agent_browser`
- `agent_browser_web_search` when an Exa or Brave Search credential source is configured or resolvable and `webSearch.enabled` is not false

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

## Optional companion web search

`agent_browser_web_search` is a separate custom tool, not an `agent_browser` input mode. It is registered only when the extension can see at least one configured/resolvable Exa or Brave credential source from `~/.pi/config/pi-agent-browser-native/config.json`, `.pi/config/pi-agent-browser-native/config.json`, `PI_AGENT_BROWSER_CONFIG`, or the `EXA_API_KEY` / `BRAVE_API_KEY` environment fallbacks, and only when the final merged config does not set `webSearch.enabled` to `false`. Config layers merge global → project → `PI_AGENT_BROWSER_CONFIG` override, so disable scope is explicit: a global disable is a normal user default, a project disable applies to one repo, and an override file with `webSearch.enabled: false` is the highest-priority hard disable for that run. Command credential sources such as `"!op read 'op://Private/Exa/API Key'"` are allowed only from trusted global or explicit-override config; they make the tool available without running the command at startup, and the key is resolved when the tool executes. Project-local config may use only matching provider env refs (`$EXA_API_KEY` / `${EXA_API_KEY}` for Exa and `$BRAVE_API_KEY` / `${BRAVE_API_KEY}` for Brave); custom env aliases, interpolation literals, and malformed `$` values are rejected. Browser profile/executable config uses the same paths but only trusted global or explicit override values are emitted as host launch prompt guidance; project-local browser config is not trusted to steer local profiles or executable paths.

Use it when live/current external web information would help answer a task, find current docs/news, or discover candidate URLs. Use `agent_browser` when the task needs browser interaction, screenshots, authenticated/profile content, page inspection, or DOM work. The search tool is namespaced to avoid colliding with generic `web_search`, chooses Exa or Brave automatically from available credentials, defaults to Exa when both are available (unless `webSearch.preferredProvider` is set), and must not expose resolved API keys in content, details, errors, status output, docs examples, logs, or PR artifacts.

Config shape:

```json
{
  "webSearch": {
    "enabled": true,
    "preferredProvider": "exa",
    "exaApiKey": "$EXA_API_KEY",
    "braveApiKey": "$BRAVE_API_KEY"
  }
}
```

Schema:

```json
{
  "query": "search text",
  "provider": "auto",
  "searchType": "auto",
  "count": 5,
  "offset": 0,
  "country": "US",
  "searchLang": "en-US",
  "safesearch": "moderate",
  "freshness": "pw"
}
```

Provider notes:
- `provider` is optional; `auto` uses available keys plus `webSearch.preferredProvider`.
- `searchType` applies to Exa only and supports `auto`, `fast`, `instant`, `deep-lite`, `deep`, and `deep-reasoning`. The default is `auto`; deep modes are slower and should be used only for harder research.
- Exa requests use `/search` with `contents.highlights: true` for compact excerpts. The wrapper intentionally does not expose Exa structured-output schemas yet, to keep the tool small.
- Brave-specific `searchLang` is ignored by Exa; Exa maps `country` to `userLocation`, `safesearch` moderate/strict to `moderation: true`, and `freshness` to `startPublishedDate`.

Result details:

```json
{
  "provider": "exa",
  "query": "search text",
  "returnedQuery": "search text",
  "count": 5,
  "offset": 0,
  "searchType": "auto",
  "requestId": "request-id-when-provider-returns-one",
  "fetchedAt": "2026-06-02T00:00:00.000Z",
  "results": [
    {
      "title": "Result title",
      "url": "https://example.com/",
      "description": "Compact summary or first highlight",
      "highlights": ["Relevant excerpt"],
      "source": "Example",
      "age": "2026-06-02",
      "language": "en"
    }
  ]
}
```

## Input mode chooser

Use exactly one top-level input per call:

| When you need | Use | Notes |
| --- | --- | --- |
| Routine browse, click, fill, screenshots, upstream commands | `args` | Default path: `open` → `snapshot -i` → `click`/`fill` `@eN` → `snapshot -i` after navigation or DOM changes. Do not pass `--json`; the wrapper injects it (see [Wrapper `--json`](#wrapper-json)). |
| Stable visible role/text/label/placeholder targets | `semanticAction` | Compiles to upstream `find` or `select`; optional `session` for a named upstream browser. |
| Short multi-step smoke or evidence flows | `job` or `qa` | Both compile to `batch`; `qa` may reclassify diagnostics as failure. |
| Desktop Electron apps (list/launch/probe/cleanup) | `electron` | Wrapper-owned lifecycle; not for ordinary websites. |
| Local UI source hints (experimental) | `sourceLookup` | **Candidates only** with confidence/evidence; not guaranteed DOM-to-file mappings. |
| Failed fetch/API source hints (experimental) | `networkSourceLookup` | **Candidates only** from initiator metadata and bounded workspace URL literals; not definitive blame. |

For link and button text, use the **exact** visible label from the latest `snapshot -i` (or `semanticAction` locators), not guessed copy. The `https://example.com/` smoke page uses heading `Example Domain` and link `Learn more`; do not assume older example.com strings such as `More information...`.

## Snapshot and getter batching

- **`snapshot -i`**: default for interaction—interactive `@eN` refs, main-content-first trimming, and the usual click/fill workflow.
- **`snapshot --compact`**: denser same-page tree when you still need refs but want less output than full interactive snapshot.
- **Full `snapshot`** (no `-i`): use only when you need the complete accessibility tree; expect larger output and possible spill files.
- Re-run `snapshot -i` after navigation, scrolling, rerendering, or other major DOM changes; refs are page-scoped.
- When you need **three or more** `get title` / `get url` / `get text` / similar reads for known refs or selectors on the same page, prefer one `batch` stdin array (for example `[["get","text","@e1"],["get","text","@e2"]]`) instead of serial tool calls.

## Wrapper `--json`

The extension always plans normal browser commands with `--json` prepended in `effectiveArgs` so upstream returns structured JSON for presentation and `details`. **Do not** include `--json` in caller `args`; it is unnecessary and can confuse planning or transcript hooks that treat caller-requested JSON differently. Plain-text inspection (`--help`, `--version`) keeps its own output shape. Read-only skills and local/setup commands such as `skills list` / `skills get` / `skills path`, local auth profile management (`auth save/list/show/delete/remove`), `profiles`, `dashboard`, `device list`, `doctor`, `install`, `upgrade`, `session list`, and targeted/all local saved-state maintenance including `state clear --all`, `state clear -a`, and named `state clear <session-name>` skip implicit session injection as documented under `sessionMode`.

## Headed and local fixture limits

- `--headed` is an upstream global flag passed through `args` (for example `{ "args": ["--headed", "open", "https://example.com"], "sessionMode": "fresh" }`). Use it on the first launch for demos or human-observed QA. If a managed browser session already exists, use `sessionMode: "fresh"` so the launch-scoped headed/headless choice is not ignored.
- `--profile <name|path>` is upstream Chrome profile selection. `profiles` lists Chrome profile directory names from Chrome's user data directory; `Default` is common but not guaranteed. On profile/user-data-dir failures, use `details.nextActions` or run `profiles` / `doctor`, then tell the user which profile name/path to configure before retrying.
- `--executable-path <path>` selects a custom Chromium-compatible browser executable when upstream can launch it. Use it with `sessionMode: "fresh"` when switching from an already-active implicit session. For non-Chrome Chromium login state, use a full profile/user-data directory path only when upstream accepts it, or attach to a debug-enabled running browser with `--auto-connect` / `connect` when appropriate.
- A successful headed call proves only that upstream accepted and ran the browser command. The wrapper currently has no portable contract field that proves the OS window is visible on the user's desktop. When visibility matters, collect independent evidence such as `screenshot`, `tab list`, `get url`, or `snapshot -i`, and treat “user cannot see the browser” as a display/provider/session setup issue until proven otherwise.
- `localhost` / `127.0.0.1` URLs are resolved by the browser host, which may differ from the shell or Pi process that started a temporary server. Errors such as `net::ERR_EMPTY_RESPONSE` on local ports are not reliable page-render evidence; they can mean the browser cannot reach the host loopback. Use an environment-specific host-reachable address when available, or fall back to `file://` only for static fixtures.
- `file://` pages do not provide HTTP headers and can differ from HTTP pages for MIME handling, CORS, storage, and debugger/script behavior. If `eval --stdin` returns `null` or otherwise fails to prove DOM state on a `file://` page, first confirm the script was passed through the native tool `stdin` field (not as a third `args` item after `--stdin`), then treat that verification as inconclusive and use `snapshot -i`, `get text` from current refs, screenshots, or a reachable HTTP fixture instead.
- Temporary HTTP servers launched outside the tool are host-owned. The native tool does not allocate ports, track background server PIDs, or clean them up; use a harness or shell cleanup for those processes.

<!-- agent-browser-playbook:start shared-guidelines -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- Standard workflow: open the page, snapshot -i, interact using current @refs from that snapshot, and re-snapshot after navigation, scrolling, rerendering, or other major DOM changes because refs are page-scoped; the wrapper fails mutation-prone stale/recycled refs before upstream can silently target a different current-page element. On dense pages, use wrapper-side snapshot -i --search <text> or snapshot -i --filter role=<role> to render matching refs while preserving the full ref map in details.refSnapshot.
- For ordinary forms from one snapshot, batch multiple fill @refs before the submit/click step to avoid serial tool calls; if a fill may autosubmit, navigate, or rerender later fields, split the flow and refresh refs first.
- Snapshot choice: prefer snapshot -i for routine clicks/fills (interactive @refs, main-content-first). Use snapshot --compact when you need a denser same-page tree without full spill; use full snapshot (no -i) only when you need the complete accessibility tree. Re-snapshot after navigation or major DOM changes. When snapshot -i compacts because the tree is oversized, scan visible output for Omitted high-value controls and optional details.data.highValueControlRefIds before opening the spill file: those list bounded searchboxes, textboxes, comboboxes, buttons, tabs, checkboxes, radios, options, and menuitems that did not fit the key/other ref previews.
- When a visible text or accessible-name target should survive ref churn, prefer find locators such as role, text, label, placeholder, alt, title, or testid with the intended action instead of guessing a CSS selector.
- For desktop or host-controlled rich inputs, if semanticAction fill misses, refresh refs and prefer a current editable @ref from details.richInputRecovery or the latest snapshot; focus or click that ref, then use keyboard inserttext or keyboard type with the intended text. Do not auto-submit with Enter or a submit button unless the user flow explicitly calls for it.
- Do not assume Playwright selector dialects such as text=Close or button:has-text('Close') are supported wrapper syntax unless current upstream agent-browser behavior has been verified.
- For authenticated or user-specific content explicitly requested by the user, such as feeds, inboxes, account pages, or private dashboards, use a real profile only when the user/config asks for it or profiles have been inspected; do not assume --profile Default exists on every machine. Do not use a real profile for public pages just because they are dashboards. Treat visible page content from real profiles as model-visible transcript data; use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser. If profile/user-data-dir resolution fails, stop retrying opens, run profiles and/or doctor through agent_browser, then report what the user needs to configure.
- Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.
- When using launch-scoped flags (--auto-connect, --cdp, --enable, --executable-path, --init-script, --device, --profile, --provider, -p, --session-name, --state), put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.
- If you already used the implicit session and now need launch-scoped flags (--auto-connect, --cdp, --enable, --executable-path, --init-script, --device, --profile, --provider, -p, --session-name, --state), retry with top-level sessionMode set to fresh or pass an explicit --session for the new launch; never pass --session-mode inside args. After a successful unnamed fresh launch, later auto calls follow that new session.
- For React introspection, launch the page with --enable react-devtools before first navigation, then use react tree, react inspect <fiberId>, sourceLookup candidates for local UI source hints, react renders start/stop, or react suspense; sourceLookup is experimental and reports confidence/evidence instead of guaranteed DOM-to-file mappings. For failed fetches and APIs, networkSourceLookup (experimental) correlates failed network requests with initiator metadata and bounded workspace URL literals—candidates only, not definitive blame. Use vitals [url] for Core Web Vitals and hydration timing, and pushstate <url> for client-side SPA navigation.
- For first-navigation setup, use open without a URL plus network route --resource-type <csv>, cookies set --curl <file>, or --init-script/--enable before navigate/opening the target page.
- For stateful browser context work, prefer purpose-specific page actions before dumping browser data: use auth save --password-stdin with the tool stdin field for credentials, auth list/show/delete/remove for local auth-profile maintenance, auth login when you need the browser to fill a saved profile, state save/load for portable test state, state list/show/rename/clear/clear -a/clean for saved-state lifecycle cleanup, cookies get/set/clear and storage local|session only when the task needs those values, and expect cookie/storage/auth/state summaries to redact credential-like fields while allowing benign primitive storage values when useful for local QA.
- For batch chains that touch cookies, storage, auth, or other secret-bearing commands, use details.batchSteps for per-step artifacts, categories, spill paths, and full structured errors; top-level details.data on batch is only a compact redacted step matrix (success, argv-redacted command, redacted result or scrubbed error text) built from the same presentation rules as standalone calls.
- For non-core families, pass current upstream commands through the native tool directly: network route/requests/har (including request filters like --type/--method/--status), diff snapshot/screenshot/url with scoped/baseline options, trace/profiler/record, console/errors/highlight/inspect/clipboard, stream enable/disable/status, dashboard start/stop, device list for iOS simulator inventory, and chat. For compact network requests output, prefer details.nextActions for request detail, route-mock diagnostics, actionable failed-request networkSourceLookup, filtering, clearing the aggregate buffer before repro, or HAR capture follow-ups instead of guessing request-id syntax. Artifact-producing commands report details.artifacts and verification state; long-running starts such as stream, dashboard, trace/profiler, and record should be paired with the matching stop/disable command when the task is done; stream enable already-enabled outcomes are treated as idempotent success with status/disable follow-ups.
- For Electron desktop apps, prefer top-level electron for wrapper-owned discovery, isolated launch, status, compact probe, and cleanup: list first, treat likely-sensitive annotations as hints rather than enforcement, launch with the default snapshot handoff unless handoff: "tabs" is the safer diagnostic starting point, use electron.probe or snapshot -i/qa.attached for current-session state, and always cleanup the returned launchId when done. electron.launch uses an isolated temporary profile; it does not reuse the app's normal signed-in profile or attach to an already-running authenticated app. For signed-in local app state, host-launch the normal app with --remote-debugging-port when appropriate, then use raw args connect <port|url>; after connect, inspect tab list, select the stable tab id such as tab t2, then run a condition wait or snapshot -i before using refs. close commands (`close`, `quit`, or `exit`) only close the browser/CDP session; leave manually launched app shutdown, profile cleanup, and explicit artifacts to the host owner.
- For provider or specialized app workflows, load version-matched upstream guidance with skills get agentcore|electron|slack|dogfood|vercel-sandbox through the native tool; add --full when you need references/templates, and use skills get --all only for broad skill audits. Provider launches such as -p ios, --provider browserbase/kernel/browseruse/browserless/agentcore, and iOS --device are upstream-owned setup paths; use sessionMode fresh when switching providers and expect external credentials or local Appium/Xcode setup to be required.
- For dialogs and frames, use dialog status/accept/dismiss and frame <selector|main> through native args; dialog commands and eval snippets that look like alert/confirm/prompt/dialog triggers are shorter-bounded than normal browser calls, and timed-out dialog-like interactions may add inspect-dialog-after-timeout, dismiss-dialog-after-timeout, or recover-fresh-session-after-dialog-timeout nextActions. When --confirm-actions produces a pending confirmation, use details.nextActions or exact confirm <id> / deny <id> calls instead of inventing ids.
- If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <tab-id-or-label> / snapshot -i to recover state before retrying different URLs or fallback strategies. For headed demos, put --headed on the first launch with sessionMode=fresh and verify with screenshot/tab/get-url evidence because tool success cannot prove the OS window is visible to the user. For desktop readiness, prefer real conditions first: wait --text, wait --url, wait --fn, wait --load <state>, wait --download, or qa.attached; for disappearance checks in agent-browser 0.27.1, use wait --fn predicates instead of stale upstream-help examples like wait <selector> --state hidden. Use electron.probe/status for wrapper-owned launch health or target mismatch. Fixed waits are a last resort, must stay below the wrapper IPC budget (wait 30000 is intentionally blocked), and a successful payload like "waited":"timeout" means elapsed time only—verify completion with an observed condition, fresh snapshot, or screenshot.
- For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.
- For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.
- For downloads, prefer download <selector> <path> when an element click should save a file; simple loopback anchor downloads are saved to the requested path when the wrapper can resolve an HTTP(S) href. Do not rely on click alone when you need the downloaded file on disk.
- On dashboards with nested scroll containers, verify scroll with a screenshot or fresh snapshot -i; if the viewport did not move, details.data.scrolled may be false/noMovement true and you should prefer scrollintoview <@ref> or target the actual scrollable region with scroll <selector> <dir> [px|percent]. For native selects, use select <selector> <value...> (or semanticAction/job select) instead of clicking option refs; for custom comboboxes, a click/semanticAction may only focus the field, so re-snapshot and fall back to type, press Enter/arrow keys, or visible option refs.
- When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.
- When using eval --stdin for extraction, pass the JavaScript through the native tool stdin field, not as an extra args token after --stdin, and return the value you want instead of relying on console.log as the primary result channel. Prefer plain expressions like ({ title: document.title }) or explicitly invoked functions like (() => ({ title: document.title }))(); if a function-shaped snippet returns {}, details.evalStdinHint may warn that the function was serialized instead of called. On file:// pages, when upstream JSON returns result: null for non-trivial stdin, details.evalResultWarning may append Eval result warning without failing the tool—treat that as inconclusive DOM verification. If get text on a CSS selector surfaces details.selectorTextVisibility or selectorTextVisibilityAll, prefer a visible @ref, a more specific selector, or the inspect-visible-text-candidates nextAction over hidden tab content.
- When details.pageChangeSummary is present, use changeType and summary as a compact signal for navigation, DOM mutation, confirmations, or artifacts; when nextActionIds is set, match those ids to entries in details.nextActions (or per-step nextActions inside batch) for concrete follow-up payloads instead of inferring from prose alone. If details.clickDispatch reports no trusted DOM event, refresh/inspect/retry the real click first; for static local fixtures only, an explicit eval --stdin programmatic .click() can exercise app handlers, but treat it as an untrusted scripted workaround and never use it to bypass stop-before-submit/order/purchase boundaries. If a no-navigation click surfaces details.overlayBlockers, inspect the fresh snapshot evidence before using a close/dismiss candidate nextAction; ordinary page chrome without dialog/alertdialog evidence should not trigger this diagnostic.
- When commands save or spill files (screenshots, downloads, PDFs, traces, recordings, HAR, large snapshot spills), use the user's exact requested paths when given and treat paths as provisional until details.artifactVerification shows every row verified: branch on missingCount, pendingCount, unverifiedCount, per-entry state, and optional limitation before downstream file use or PASS/FAIL reporting.
- For evidence-only screenshots, QA captures, or other audit artifacts, save to an explicit path and branch on details.artifactVerification plus details.artifacts before reporting PASS/FAIL; do not require vision review of inline image attachments unless the user asked for visual inspection.
- Respect explicit user stop boundaries yourself: if the user says to stop before order/post/purchase/submit, do not click that final action. The wrapper does not infer broad business intent from prompt text; details.promptGuard is reserved for concrete artifact-before-close checks.
- Successful record stop needs ffmpeg on PATH; the wrapper may warn after record start when ffmpeg is missing.
- Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.
<!-- agent-browser-playbook:end shared-guidelines -->

## Parameters

Illustrative shapes (each real call uses exactly one of `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron`):

```json
{ "args": ["open", "https://example.com"], "stdin": "optional raw stdin content", "sessionMode": "auto" }
```

```json
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Export" }, "sessionMode": "auto" }
{ "semanticAction": { "action": "select", "selector": "#flavor", "value": "chocolate" } }
```

```json
{ "electron": { "action": "list", "query": "code" } }
{ "electron": { "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" } }
```

### `args`

- type: `string[]`
- required unless `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron` is provided
- exact CLI args passed after `agent-browser`; this is the 1:1 upstream CLI coverage path for the targeted `agent-browser` version
- no shell operators
- do not include the binary name
- do not include `--json`; the wrapper injects it (see [Wrapper `--json`](#wrapper-json))
- first-call recipe: `open` → `snapshot -i` → `click` / `fill` with current `@eN` refs from that snapshot → `snapshot -i` again after navigation or DOM changes

Examples:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
{ "args": ["click", "@e2"] }
{ "args": ["tab", "list"] }
{ "args": ["network", "unroute"] }
{ "args": ["quit"] }
```

### `semanticAction`

- type: object
- optional; mutually exclusive with `args`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron` (omit all of them when using this field)
- top-level tool input only: `batch` stdin remains upstream argv arrays; express find steps inside batch as string arrays such as `["find","role","button","click","--name","Export"]`, not nested `semanticAction` objects
- thin intent schema compiled by this wrapper into existing upstream commands; locator actions compile to `find`, while native dropdown selection compiles to `select <selector> <value...>`; behavior and locator/selector semantics stay upstream-owned
- supported actions: `click`, `fill`, `check`, `select`
- supported locators for `click` / `fill` / `check`: `role`, `text`, `label`, `placeholder`, `alt`, `title`, `testid`
- `semanticAction` does not expose `uncheck` while upstream `find ... uncheck` is not runtime-supported; use raw `args: ["uncheck", <selector-or-ref>]` after a stable selector or current snapshot ref
- for locator actions, `value` is the locator argument (for example ARIA role token `"button"`, label text, or visible substring), must be a non-empty string after trim; for `locator: "role"`, callers may provide `role` instead of redundant `value`
- `fill` requires non-empty `text` (compiled as the trailing value argument to `find`)
- `select` requires non-empty `selector` plus either `value` (single option value) or `values` (non-empty array of option values). `select` does not accept `locator`, `role`, `name`, or `text`; upstream `find` does not expose a verified `select` action, so role/name/label dropdown targeting must first be resolved to a stable selector or current `@ref`.
- optional `name` is only valid with `locator: "role"` and compiles to `--name <name>` after the action (and after `text` for `fill` when present)
- optional `role` is accepted only when `locator` is `role`; it may replace `value`, and must equal `value` if both are set
- optional `session` is an upstream session name; when set, compilation prepends `--session <session>` before the compiled `find` or `select` command so the shorthand targets that named browser context instead of the managed default; this is independent of top-level `sessionMode`, which only injects or rotates the extension-managed implicit session when the planned argv does not already start with `--session` (see `buildExecutionPlan` in `extensions/agent-browser/lib/runtime.ts`). On successful unified results, `details.sessionName` matches that name and `usedImplicitSession` is `false` because the call named upstream directly rather than consuming the extension-managed implicit session slot.

Compilation (then `--json` and session handling apply like any other call):

| Fields | Compiled `args` (conceptually) |
| --- | --- |
| `click` or `check` + non-`role` locator | `["find", <locator>, <value>, <action>]` |
| `click` / `check` / `fill` + `role` or `value` + optional `name` | `["find","role",<role-or-value>,<action>]` plus `["--name",<name>]` when `name` is set; active-session fill may pre-resolve to `fill @ref <text>` when one exact editable current ref matches |
| `fill` | `["find",<locator>,<value>,"fill",<text>]` plus optional `["--name",<name>]` after `text` when `locator` is `role` and `name` is set |
| `select` + `selector` + `value` / `values` | `["select",<selector>,<value...>]` |
| any supported action + `session` | prepends `["--session",<session>]` before the compiled argv |

When `semanticAction` compiles successfully, `details.compiledSemanticAction` echoes `{ action, locator, args }` for `find` actions or `{ action: "select", selector, values, args }` for `select`, with `args` redacted the same way as other invocation details. Expect it on the initial wrapper validation return (when that path still builds the early `details` object) and on the unified result after `agent-browser` runs. It is omitted when the call used `args` only, when compilation never produced argv, and on some in-`execute` error returns that attach a slimmer `details` shape before the unified merge (for example certain session-plan, stdin-contract, tab-pinning, or missing-binary guard paths); compare `extensions/agent-browser/index.ts` where `compiledSemanticAction` is assigned. For active sessions, role/name `click`, `check`, and guarded `fill` semantic actions may be resolved through one fresh `snapshot -i` to a current visible `@ref` before execution; fill only resolves when one exact editable `combobox`, `searchbox`, or `textbox` ref matches. This avoids hidden duplicate matches stealing an upstream `find` action. In that case `details.compiledSemanticAction` still records the original semantic target while `details.effectiveArgs` shows the executed ref action.

If a raw `find` or compiled `semanticAction` fails with `failureCategory: "selector-not-found"`, the wrapper may run one fresh session-scoped `snapshot -i` and add visible `Current snapshot ref fallback` plus `details.visibleRefFallback` when that snapshot contains exact role/name matches for the failed target. Non-fill matches can also add `try-current-visible-ref` / `try-current-visible-ref-N` next actions. The matcher is bounded to current snapshot refs and exact normalized role/name matches: role locators require `--name`, text-click falls back only to exact-name `button`/`link` refs, label-fill to exact-name `textbox`, and placeholder-fill to exact-name `searchbox`/`textbox`. It never fuzzy-matches names such as prefixes; when several exact refs match, each action carries safety copy telling agents to inspect the snapshot and choose only if unambiguous. For post-failure `fill` matches, `visibleRefFallback.candidates[].args` and `visibleRefFallback.target.text` are omitted so recovery details do not repeat the fill text.

If a compiled `semanticAction` fails with `failureCategory: "selector-not-found"`, visible content can also include an `Agent-browser candidate fallbacks` block when the wrapper has bounded role/name retries for that locator and action, and `details.nextActions` includes the normal `refresh-interactive-refs` snapshot step plus those entries. When `session` was provided, candidate retry args preserve the same `--session <session>` prefix. Today `buildSemanticActionCandidateActions` in `extensions/agent-browser/index.ts` only appends click candidates for `click` + `text` → `try-button-name-candidate` and `try-link-name-candidate`. Fill misses no longer emit `find … fill <text>` retry actions because those would repeat potentially sensitive text. Instead, when the same selector-miss snapshot finds exact current editable refs (`searchbox` or `textbox`), the wrapper emits `details.richInputRecovery`, visible `Rich input recovery`, and `focus-current-editable-ref` / `click-current-editable-ref` (numbered when ambiguous) next actions. Those actions carry only focus/click argv for the candidate ref; they do not copy fill text, press `Enter`, or submit. Use `keyboard inserttext` or `keyboard type` with the intended text only after focusing the right current ref, and submit only when the user flow explicitly calls for it. Candidate fallbacks are heuristics, not proof that an element exists; inspect the page when several controls could share the same name.

If a compiled `semanticAction` `find` action fails with `failureCategory: "stale-ref"`, `details.nextActions` includes `retry-semantic-action-after-stale-ref` with the same redacted compiled argv as `details.compiledSemanticAction` in `params.args` (any leading `--session` pair from `semanticAction.session`, then the `find` tokens). The wrapper appends that entry **after** any `refresh-interactive-refs` snapshot step from `buildAgentBrowserNextActions` in `extensions/agent-browser/lib/results/action-recommendations.ts` (re-exported from `shared.ts`; see `extensions/agent-browser/index.ts` where `nextActions` is merged). That retry is only offered because the semantic target is stable and the stale-ref error proves the previous action did not execute; `select` shorthands with stale `@e…` selectors and direct stale `@e…` commands still return refresh guidance instead of an unsafe blind retry.

For direct page-scoped `@e…` refs, successful `snapshot` results record `details.refSnapshot` with the latest ref ids and page target for the session. A failed session `snapshot` whose upstream error says `No active page` clears that session’s prior ref snapshot and records `details.refSnapshotInvalidation.reason: "no-active-page"`; mutation-prone `@e…` preflight then fails with `failureCategory: "stale-ref"` until a later successful `snapshot -i` records fresh refs. Before mutation-prone ref commands such as `click`, `fill`, `check`, `select`, `download`, drag/upload/keyboard-style actions, or equivalent batch steps run, the wrapper rejects refs from an older page target, refs absent from the latest same-page snapshot, or refs from an invalidated snapshot state. This is a best-effort wrapper guard against upstream ref-number recycling after navigation; it does not prove the DOM stayed unchanged after the snapshot. Refresh with the session-aware `refresh-interactive-refs` next action before retrying.

Examples:

```json
{ "semanticAction": { "action": "click", "locator": "role", "value": "button", "name": "Export" } }
{ "semanticAction": { "action": "click", "locator": "role", "role": "button", "name": "Continue without Signing In" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "semanticAction": { "action": "select", "selector": "#flavor", "value": "chocolate" } }
{ "semanticAction": { "action": "select", "selector": "#multi", "values": ["dark", "compact"] } }
{ "semanticAction": { "action": "check", "locator": "label", "value": "Remember me" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close", "session": "named-browser" } }
```

### `job`

- type: object with a non-empty `steps` array
- optional; mutually exclusive with `args`, `semanticAction`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron`
- top-level tool input only; do not nest `job` inside `batch` stdin
- constrained orchestration only: every step compiles to existing upstream `batch` argv and the compiled plan is echoed as `details.compiledJob`
- optional `failFast` boolean; defaults to `true`, compiling to upstream `batch --bail` so later mutating job steps do not run after an earlier required step fails. Set `failFast: false` only when you explicitly want upstream batch's continue-after-error behavior.
- there is no separate reusable named “browser recipe” extension surface above `job`, `qa`, and raw `batch` yet; the closed `RQ-0068` decision, evidence bar, and revisit criteria are in [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet) and [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- supported steps (each row becomes one upstream `batch` step; `click` / `fill` / `select` pass `selector` through as the same argv token shape standalone upstream commands would use, including `@refs`, not the `semanticAction` locator schema):
  - `open` with `url`
  - `click` with `selector`
  - `fill` with `selector` and `text`
  - `select` with `selector` plus either `value` or `values` (one or more option values; compiled as `select <selector> <value...>`)
  - `wait` with positive integer `milliseconds`
  - `assertText` with `text` (compiled as passive `wait --text <text>`)
  - `assertUrl` with `url` pattern (compiled as `wait --url <pattern>`)
  - `waitForDownload` with `path` (compiled as `wait --download <path>`)
  - `snapshot` (compiled as `snapshot -i`; useful between mutation-prone steps before reusing current refs)
  - `screenshot` with `path`

**Navigation assertions are explicit only.** `job` never treats a successful `click` (or a `select` / submit-style interaction that may navigate) as proof that the expected next page loaded. Top-level `click` may still surface optional `details.navigationSummary` or `pageChangeSummary` hints for operators, but compiled `job` / `batch` steps do **not** auto-insert `assertUrl` or `assertText` after clicks—there is no deterministic expected URL source without caller intent. After any navigation-prone step (link/submit clicks, checkout or form flows, tab-sensitive UI), add an explicit `assertUrl` with the destination pattern you expect, `assertText` for on-page copy, or both, **before** screenshots or steps that assume the new page state.

Example (static landing page):

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

Example (open → fill → click → assert destination → screenshot):

```json
{
  "job": {
    "steps": [
      { "action": "open", "url": "https://shop.example/checkout" },
      { "action": "fill", "selector": "#email", "text": "user@example.com" },
      { "action": "click", "selector": "#continue" },
      { "action": "assertUrl", "url": "**/shipping" },
      { "action": "assertText", "text": "Shipping address" },
      { "action": "screenshot", "path": ".dogfood/shipping.png" }
    ]
  }
}
```

Compiled shape for the navigation example:

```json
{
  "args": ["batch", "--bail"],
  "stdin": "[[\"open\",\"https://shop.example/checkout\"],[\"fill\",\"#email\",\"user@example.com\"],[\"click\",\"#continue\"],[\"wait\",\"--url\",\"**/shipping\"],[\"wait\",\"--text\",\"Shipping address\"],[\"screenshot\",\".dogfood/shipping.png\"]]"
}
```

On app pages that expose a native dropdown, add a `select` step such as `{ "action": "select", "selector": "#flavor", "value": "chocolate" }` before the assertion that depends on it. `click` and `fill` steps may use either `selector` or semantic locator fields. A semantic locator step mirrors the top-level `semanticAction` compiler and must include `locator` plus the locator value (`role`/`value` and optional `name` for role locators); it compiles to upstream `find`, for example `{ "action": "fill", "locator": "role", "role": "searchbox", "name": "Search", "text": "agent browser" }` → `find role searchbox fill "agent browser" --name Search` and `{ "action": "click", "locator": "role", "role": "button", "name": "Search" }` → `find role button click --name Search`. Supplying both `selector` and semantic locator fields is rejected.

Use raw `args` plus `stdin` for upstream `batch` when a flow needs commands, flags, stdin forms, or failure policies outside this constrained schema. `job.failFast: false` keeps the constrained schema but removes `--bail` when collecting later diagnostic artifacts is more important than stopping on the first failure.

Because `job` still executes as upstream `batch` with generated stdin, the same wrapper page-scoped `@e…` preflight applies: if you pass `@refs` in `click`/`fill`/`select` selectors after an `open`, non-form `click`, or another step that can navigate or mutate the page, split the work across tool calls or switch to raw `batch` and insert your own `snapshot -i` rows between steps—the constrained `job` vocabulary emits a `snapshot` step only when you include `{ action: "snapshot" }` explicitly. Multiple same-snapshot `fill @e…` rows may run before the first click/submit-style step. Raw `args:["batch"]` stdin can also batch native form-control rows (`check`/`uncheck` checkbox or radio refs and `select` combobox refs) before that click.

### `qa`

- type: object with either required `url` (normal URL-opening QA) or `attached: true` (current attached-session QA)
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `sourceLookup`, `networkSourceLookup`, and `electron`
- lightweight preset built on the same batch compiler path as `job`, using `batch --bail` so missing readiness/text/selector assertions stop before slower diagnostics can burn the wrapper watchdog
- URL form: clears enabled diagnostic buffers first (`network requests --clear`, `console --clear`, `errors --clear`), then opens `url`, waits with `wait --load <state>` using the resolved `loadState`, optionally asserts `expectedText` (string or string array, compiled to bounded visible-text `wait --fn … --timeout 5000` predicates after load) and/or `expectedSelector` (each may be omitted for a load-plus-diagnostics-only smoke), then runs enabled diagnostics: `network requests`, `console`, and `errors` only if preceding batch steps pass
- attached form: `qa: { attached: true, expectedText?, expectedSelector?, screenshotPath?, checkNetwork?, checkConsole?, checkErrors?, loadState? }` runs the same waits, optional assertions, diagnostics, and screenshot against the current attached managed session without opening a URL. It rejects `url` and cannot be used with `sessionMode: "fresh"`; attach first with `electron.launch` or raw `args: ["connect", "<port-or-url>"]`, then run `qa.attached`. Before spawning the diagnostic batch, the wrapper preflights the attached session: `get url` must succeed and return an `http:` or `https:` page URL. Missing URLs, read failures, and non-http(s) surfaces fail fast with `failureCategory: "validation-error"`, `details.validationError`, and recovery `nextActions` such as `list-tabs-before-qa-attached` and `snapshot-before-qa-attached` instead of running the full QA batch. Attached QA does **not** run `network requests --clear`, `console --clear`, or `errors --clear`; `details.compiledQaPreset.checks.diagnosticsResetAtStart` is `false`. Visible text warns that existing diagnostic buffers were preserved only when `checkNetwork`, `checkConsole`, or `checkErrors` is enabled, and those diagnostics may include events from before the QA check.
- `loadState` is optional and must be `domcontentloaded`, `load`, or `networkidle`; it defaults to `domcontentloaded` so analytics-heavy or long-polling pages do not hang routine QA. Use `networkidle` only when the site is expected to go fully quiet.
- `checkNetwork`, `checkConsole`, and `checkErrors` default to `true` for URL-opening QA; for `qa.attached` they default to `false` because preserved upstream buffers may predate the current check. Set a field to `true` on `qa.attached` to opt into preserved-buffer diagnostics.
- optional `screenshotPath` adds an evidence screenshot step
- reports `details.compiledQaPreset` with the compiled batch plan and resolved `loadState`, plus `details.qaPreset` with `{ passed, failedChecks, warnings, summary }`
- on success with no failed checks, model-visible prose collapses to a compact pass summary (current page URL/title when known, checks run, optional screenshot path plus artifact verification, pointer to `details.qaPreset` and `details.batchSteps` for the full matrix). Failed QA and QA reclassified to `qa-failure` keep the verbose per-step batch output.
- fails the native tool result with `failureCategory: "qa-failure"` when diagnostics report page errors, console error messages, actionable failed network requests, any batch step failure, or missing expected text after the requested load state. Expected-text QA checks use bounded visible-element predicates plus fail-fast batch behavior instead of reading all body text, so dense pages can pass on visible headings/copy and missing text reports `expected text not found: …` rather than burning the full wrapper watchdog. Benign classification (implementation: `classifyNetworkRequestFailure` → `isBenignAssetFailure` in `extensions/agent-browser/lib/results/network.ts`) applies only when the row is already treated as failed (`status >= 400`, `failed: true`, or a string `error`—see `isFailedNetworkRequest`), the URL path’s last segment matches the icon basename heuristic (`favicon` plus `.ico`/`.png`/`.svg`, or `apple-touch-icon` plus `.png`, each allowing an optional `[-.\w]*` stem suffix before the extension), **and** at least one of `status === 404`, `failed === true`, or `typeof request.error === "string"` holds (so a **status-only** failure such as `500` on that path with neither `failed` nor a string `error` stays actionable). It also requires the upstream `resourceType` / `mimeType` (whichever is present) to be absent or look image-like: `image`, `img`, `other`, or a value starting with `image/`. Those rows are counted in `qaPreset.warnings` (for example `N benign network request failure(s) ignored`) and omitted from the actionable failed-network tally; every other failed request stays actionable.

Example:

```json
{ "qa": { "url": "https://example.com", "expectedText": "Example Domain", "screenshotPath": ".dogfood/qa-example.png" } }
```

Use custom `job` or raw `batch` for QA flows that need custom commands, flags, auth setup, HAR capture, or project-specific assertions.

### `electron`

Workflow-oriented public guide: [`ELECTRON.md`](ELECTRON.md). This section remains the canonical field contract; the guide covers when and how to use these actions in practice.

- type: object with required `action`
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `networkSourceLookup`
- top-level wrapper shorthand for Electron desktop apps; do not nest it inside `batch` stdin
- `stdin` is rejected with `electron`; host-only actions manage their own local work and `launch` manages its own upstream `connect`
- supported actions: `list`, `launch`, `status`, `cleanup`, and `probe`

Action schemas:

| Action | Fields | Behavior |
| --- | --- | --- |
| `list` | `query?`, `maxResults?` | Scans supported platform app locations for Electron evidence and returns bounded app metadata in `details.electron.apps`. Likely-sensitive app annotations are advisory metadata only. Does not spawn upstream `agent-browser`; list output also warns that later wrapper launches are isolated and will not read existing signed-in desktop state. |
| `launch` | exactly one of `appPath`, `appName`, `bundleId`, or `executablePath`; optional `appArgs`, `handoff`, `targetType`, `timeoutMs`, `allow`, `deny` | Resolves and verifies an Electron target, launches it with a wrapper-owned isolated profile and OS-chosen CDP port, attaches through upstream `connect` using `sessionMode: "fresh"`, and records `details.electron.launch`. It does not reuse the app's normal signed-in profile or attach to an already-running authenticated app; when signed-in local app state is the goal, use a host debug-port launch plus raw `connect` instead. |
| `status` | optional `launchId` or `all`, optional `timeoutMs` | Inspects wrapper-tracked launches, debug-port liveness, and current CDP targets without mutating the app. With neither `launchId` nor `all`, selects the single active wrapper launch when unambiguous. Runtime-owned launches remain visible by `launchId` after a Pi `session_tree` branch switch. Current branch-visible launches survive `/reload`; off-branch owned launches are cleaned on reload. |
| `cleanup` | optional `launchId` or `all`, optional `timeoutMs` | Closes the tracked upstream session when present, stops only the wrapper-tracked process, verifies debug-port shutdown, removes the wrapper-created `userDataDir`, and marks records cleaned or partial. Cleanup is serialized with managed-session browser work, and a successful managed-session close step clears live/restore managed-session state even when host process/profile cleanup remains partial. |
| `probe` | optional `launchId`, optional `timeoutMs` | Runs bounded current-session or launch-scoped state reads (`get title`, `get url`, focused-element `eval --stdin`, `tab list`, compact `snapshot -i`) and reports `details.electron.probe`. Without `launchId`, requires an active attached managed session; with `launchId`, it resolves the tracked launch session, including runtime-owned off-branch launch records, and can report mismatch guidance. |

Validation and defaults:

- `launch` requires exactly one target field. `list` accepts only `query` and `maxResults`; `probe` accepts only `launchId` and `timeoutMs` beyond `action`; `status` / `cleanup` accept only `launchId`, `all`, and `timeoutMs`.
- Host install discovery (`electron.list` and resolving `appName` / `bundleId` through `discoverElectronApps` in `extensions/agent-browser/lib/electron/discovery.ts`) runs on **macOS** and **Linux** only. On **Windows** (and any other platform), `list` returns `platform: "unsupported"` with an empty `apps` array, and `launch` cannot resolve purely name-based targets without a prior scan—use `executablePath` or a host `appPath` that resolves to a verifiable Electron binary (`inspectElectronExecutablePath` still gates Windows executables).
- `launch.handoff` defaults to `"snapshot"`; supported values are `"connect"`, `"tabs"`, and `"snapshot"`. `"connect"` stops after attach, `"tabs"` adds a session-scoped `tab list` and is the safer diagnostic starting point when you do not want to capture refs/content yet, and `"snapshot"` adds `tab list` plus `snapshot -i` so current refs are immediately available. If the first Electron snapshot returns no refs while the app is still settling, the wrapper retries briefly before reporting no refs and tells agents to run `snapshot -i` once more before treating the UI as unusable.
- `launch.targetType` defaults to `"page"`; supported values are `"page"`, `"webview"`, and `"any"`. When a matching CDP target exposes a WebSocket URL, launch connects to that target; otherwise it falls back to the browser port.
- `appArgs` are passed to the Electron app, but wrapper-owned lifecycle/debug flags are rejected (`--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-address`, `--remote-debugging-pipe`, and `--`).
- `allow` and `deny` are optional caller-owned policy lists. Entries match app name, bundle id, desktop id, app path, or executable path by substring. If `allow` is set, the target must match it; `deny` wins on conflict. With neither list, launch is permitted.
- `electron.status` / `electron.cleanup` accept optional `all` only as the boolean literal `true` to include every wrapper-tracked launch; `all` and `launchId` cannot both be set. Status and cleanup use the same runtime wrapper-tracked scope: current branch-visible records plus still-owned off-branch records. Default no-argument status/cleanup is intentionally ambiguous when more than one active launch is in that merged scope; pass `launchId` or `all: true`.
- `electron.launch` `timeoutMs` is an optional positive integer for the host CDP readiness window. The launcher normalizes missing or non-positive values to **15000 ms** and **caps** at **120000 ms** (`normalizeTimeoutMs` in `extensions/agent-browser/lib/electron/launch.ts`). Other actions use `timeoutMs` differently: **`status`** forwards it only to managed-session `get title` / `get url` reads for mismatch diagnostics (when omitted, those subprocess reads use the normal `runAgentBrowserProcess` default from `getAgentBrowserProcessTimeoutMs`), while localhost CDP liveness in `inspectElectronLaunchStatus` uses a fixed **1000 ms** fetch budget per HTTP probe (`ELECTRON_STATUS_FETCH_TIMEOUT_MS` in `extensions/agent-browser/lib/electron/cleanup.ts`). **`cleanup`** applies one budget to upstream managed-session `close` plus host process exit, debug-port verification, and temp profile removal (`cleanupTrackedElectronHostLaunches` in `extensions/agent-browser/lib/orchestration/electron-host/index.ts`); when omitted it defaults to **`PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS`** else **5000 ms** (`getImplicitSessionCloseTimeoutMs` in `extensions/agent-browser/lib/runtime.ts`). **`probe`** forwards it to each bounded upstream read (`get title`, `get url`, `eval --stdin`, `tab list`, `snapshot -i`); when omitted, those reads use the same `runAgentBrowserProcess` default as other tool calls.
- Non-Electron targets are rejected as a correctness failure; the wrapper does not blindly launch arbitrary executables as Electron.

Safety defaults and ownership:

- `launch` always uses a new isolated wrapper-created `userDataDir` and `--remote-debugging-port=0`, then reads `DevToolsActivePort`; callers cannot choose a fixed debug port, cannot reuse the app's normal signed-in profile, and cannot use this path to attach to an already-running authenticated app.
- The wrapper also passes `--disable-extensions`, `--no-first-run`, and `--no-default-browser-check` alongside sanitized caller `appArgs`.
- Remote debugging exposes app contents to the attached browser tool. The wrapper gives isolation defaults and optional `allow` / `deny`; the user still owns the decision to launch or attach to a sensitive desktop app.
- `electron.list` may annotate apps as likely sensitive (`sensitivity.level: "likely-sensitive"`, categories such as `notes`, `chat`, `mail`, `developer-workspace`, or `passwords-auth`) and print `[likely sensitive: …]`. These annotations are non-blocking hints, not enforcement; caller-owned `allow` / `deny` policy still controls launch decisions.
- Cleanup is wrapper-owned **only** for records created by `electron.launch`. `electron.cleanup` never targets manually launched apps, externally supplied debug ports, or arbitrary Electron processes. Explicit screenshots/downloads/HARs/traces remain host-file cleanup, not Electron cleanup. If `electron.cleanup` closes the upstream managed session but process/profile cleanup remains partial, later shutdown cleanup does not close that managed session a second time; retry cleanup focuses on the remaining host resources.
- On Pi `quit`, active wrapper-owned Electron launches are best-effort cleaned. On `/reload`, current branch-visible active Electron launches are preserved for reload continuity, including their isolated `userDataDir` profile directories, while off-branch owned launches are cleaned before process-local ownership is cleared. If cleanup is partial and deliberately skips or fails `user-data-dir` removal because the process or debug port is still live, generic temp cleanup preserves that profile path across reload, quit, later temp sweeps, process-exit cleanup, and stale temp-root pruning after restart instead of deleting it underneath the remaining host resource. Stale restored records are reported instead of guessed/killed when the wrapper lacks a live child process.

Details fields:

```json
{
  "compiledElectron": {
    "action": "launch",
    "appName": "My App",
    "handoff": "snapshot",
    "targetType": "page",
    "appArgs": ["--safe-mode"]
  },
  "electron": {
    "action": "launch",
    "status": "succeeded",
    "launch": {
      "version": 1,
      "launchId": "electron-…",
      "launchedByWrapper": true,
      "appName": "My App",
      "bundleId": "com.example.my-app",
      "appPath": "/Applications/My App.app",
      "executablePath": "/Applications/My App.app/Contents/MacOS/My App",
      "userDataDir": "/tmp/pi-agent-browser-electron-…",
      "port": 12345,
      "pid": 1234,
      "sessionName": "pi-…",
      "webSocketDebuggerUrl": "ws://127.0.0.1:12345/devtools/browser/…",
      "createdAtMs": 1770000000000,
      "cleanupState": "active"
    },
    "targets": [{ "type": "page", "title": "My App", "url": "app://index" }],
    "handoff": { "handoff": "snapshot" },
    "profileIsolation": {
      "isolatedLaunch": true,
      "reusesExistingSignedInProfile": false,
      "attachesToAlreadyRunningApp": false,
      "hostDebugLaunchExample": "macOS: open -a <App Name> --args --remote-debugging-port=9222 --remote-allow-origins='*'; then agent_browser connect 9222 with sessionMode=fresh"
    }
  }
}
```

Action-specific `details.electron` fields:

- `list`: `{ action: "list", status: "succeeded", apps, platform, query?, maxResults, skippedCount, omittedCount?, sensitiveAppCount?, profileIsolation }`. Each app is platform-tagged and may include `name`, `bundleId`, `desktopId`, `appPath`, `executablePath`, `icon`, `packageSource`, and non-blocking `sensitivity` metadata depending on platform/discovery source.
- `launch`: `{ action: "launch", status, launch, targets?, version?, handoff?, cleanup?, identifiers?, profileIsolation }`. `profileIsolation` states that wrapper launches use a new temporary profile, do not reuse existing signed-in app state, and do not attach to already-running authenticated apps; it also includes host debug-launch guidance for the separate normal-app attach path. `identifiers` repeats the launch-scoped `launchId` and attached `sessionName` so agents distinguish Electron lifecycle actions from browser session/tab actions. `launch.cleanupState` is one of `"active"`, `"cleaned"`, `"dead"`, `"failed"`, or `"partial"`. Failed launches expose `details.electron.failure.diagnostics` when available, including `pid` / `pidAlive`, wrapper `userDataDir`, elapsed/timeout timing, `DevToolsActivePort` file state, discovered port, and whether CDP `/json/version` was reached.
- `status`: `{ action: "status", status: "succeeded", launches, statuses, targets, identifiers?, identifierList?, managedSession?, managedSessions?, sessionMismatch?, sessionMismatches? }`, where each status includes the tracked `launchId`, port/pid liveness, and bounded CDP target metadata. Mismatch fields explain when the current managed session or tab does not match a live wrapper launch target.
- `cleanup`: `{ action: "cleanup", status: "succeeded" | "partial", cleanup: { partial, records, results } }`. Partial cleanup is a failed tool result with `failureCategory: "cleanup-failed"` and retry next actions. Cleanup steps may include `managed-session`, `process`, `debug-port`, and `user-data-dir`; managed-session close failures are reported while host-owned process/profile cleanup still runs.
- `probe`: `{ action: "probe", status: "succeeded" | "partial", probe, probeContext, identifiers?, sessionMismatch?, statusTargets?, launchStatus? }`. `probeContext` records whether the probe inspected the current managed session or a specific `launchId`. `probe` includes bounded `title`, `url`, `focusedElement`, `activeTab`, `tabs`, compact `snapshot` metadata (`refCount`, `refIds`, optional text preview and omission counts), `errors?`, and `summary`. When launch status is known, visible probe output includes debug-port/pid liveness so `about:blank` plus a dead wrapper launch is unmistakable. It also updates the normal session target/ref tracking when a snapshot is collected.

Failure categories and next actions:

- `policy-blocked` is used when `electron.launch` is blocked by caller-supplied `allow` / `deny`; inspect `details.electron.failure.policy` for the matched list and entry when present.
- `cleanup-failed` is used when `electron.cleanup` only partially cleans tracked resources; inspect `details.electron.cleanup.results[].steps` for remaining process, port, or profile cleanup state.
- Launch timeout maps to `timeout`; non-Electron targets and input issues map to `validation-error`; launch/attach/spawn/CDP failures map to `upstream-error` unless a more specific category applies. If a successful-looking Electron mutation is followed by a dead process/debug port or an unrecoverable `about:blank` target, the wrapper upgrades the result to `failureCategory: "tab-drift"` and sets `details.electronPostCommandHealth` with the launch status and recovery action ids.
- Successful Electron `fill <selector> <text>` commands may run a read-only `get value <selector>` verification, and successful fills against refs whose latest snapshot metadata proves a contenteditable target may run `get text <ref>` verification. If the value/text still differs, the wrapper keeps the tool successful but adds `details.fillVerification`, visible guidance to use snapshot/focus/keyboard typing for custom quick-input or rich editor controls, and `inspect-after-fill-verification` / `verify-filled-value` next actions.
- Successful active launches/status/probe results may include exact `details.nextActions` with ids `status-electron-launch`, `probe-electron-launch`, `cleanup-electron-launch`, `list-electron-tabs`, and `snapshot-electron-session`. Electron status/probe mismatch diagnostics may also include `reattach-electron-launch` before fresh tab/snapshot inspection. Electron post-command health failures include status/probe/cleanup actions for the same `launchId`; Electron `@e…` mutations may add `refresh-electron-refs-after-rerender` because desktop apps often rerender without URL changes. Electron cleanup partial failures may include `status-electron-launch` and `retry-electron-cleanup`.

Next-action payload examples:

```json
{
  "tool": "agent_browser",
  "id": "cleanup-electron-launch",
  "reason": "Clean the wrapper-owned Electron process and isolated userDataDir when the run is complete.",
  "safety": "Only operates on the launchId created by electron.launch; explicit artifacts and manually launched apps remain host-owned.",
  "params": { "electron": { "action": "cleanup", "launchId": "electron-…" } }
}
```

```json
{
  "tool": "agent_browser",
  "id": "snapshot-electron-session",
  "reason": "Refresh interactive refs for the attached Electron session.",
  "safety": "Use current Electron refs only after a fresh snapshot for this session.",
  "params": { "args": ["--session", "pi-…", "snapshot", "-i"] }
}
```

Examples:

```json
{ "electron": { "action": "list", "query": "code" } }
{ "electron": { "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" } }
{ "electron": { "action": "probe" } }
{ "qa": { "attached": true, "expectedText": "Explorer" } }
{ "electron": { "action": "cleanup", "launchId": "electron-…" } }
```

For an app you launched manually with remote debugging enabled, skip `electron.cleanup` and use the upstream path directly:

```json
{ "args": ["connect", "9222"], "sessionMode": "fresh" }
```

### `sourceLookup`

- type: object with at least one of `selector`, `reactFiberId`, or `componentName`
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `networkSourceLookup`, and `electron`
- **EXPERIMENTAL — candidates only:** opt-in helper for local app debugging; it reports candidate source locations with confidence and evidence instead of claiming a guaranteed DOM-to-file mapping. Do not treat output as authoritative file ownership or edit targets without verification.
- compiles to existing upstream `batch` commands only:
  - `selector` adds `is visible <selector>` and, unless `includeDomHints: false`, adds `get html <selector>` for source-like DOM attributes (`data-source-file`, `data-file`, `data-component-file`, `data-source`, plus optional `data-source-line` / `data-line` and `data-source-column` / `data-column`) and for `.ts`/`.tsx`/`.js`/`.jsx` paths embedded in HTML text
  - `reactFiberId` runs `react inspect <id>`; this requires the page to have been launched with `--enable react-devtools` before first navigation and for the app build to expose source information
  - `componentName` runs `react tree` and performs a bounded local workspace scan under the Pi tool session **cwd** for matching component declarations in `.ts`, `.tsx`, `.js`, and `.jsx` files (skipping directories such as `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `out`, `tmp`, and `temp`); the walk stops after `maxWorkspaceFiles` files (default 2000, hard cap 5000) and records at most ten `workspace-search` candidates
- optional `includeDomHints: false` skips the selector HTML read
- optional `maxWorkspaceFiles` bounds the local component-name scan; default is 2000 source files and the hard maximum is 5000
- reports `details.compiledSourceLookup` with the generated batch plan and `details.sourceLookup` with `{ status, candidates, limitations, summary, workspaceRoot?, electronContext? }`
- each `candidates[]` entry includes `source` (`react-inspect`, `dom-attribute`, or `workspace-search`), `confidence` (`high`, `medium`, or `low`), `evidence` (string reasons), and optional `file`, `line`, `column`, and `componentName`
- `details.sourceLookup.status` is one of `candidates-found`, `no-candidates`, or `unsupported`; `unsupported` applies only when **no** candidates were collected **and** at least one compiled `react` batch step failed (for example React DevTools not enabled, no renderer, or inspect errors). If DOM or workspace evidence still produced candidates, `status` stays `candidates-found` even when a `react` step failed
- when analysis produces a `summary`, the wrapper prepends it to the primary visible text block (or inserts a leading text block) for quick scanning; unlike `qa`, it never flips the unified tool outcome to failed solely because diagnostics look noisy or because `status` is `no-candidates` / metadata was missing—failed upstream batch steps still surface as normal tool errors
- for wrapper-tracked packaged Electron sessions where `status` is `no-candidates`, the wrapper may add `workspaceRoot` and `electronContext` (`launchId?`, `appName?`, `appPath?`, `executablePath?`, `sessionName?`, `url?`) plus limitations explaining that the local workspace scan only covered the Pi tool cwd and did not unpack installed app resources or `app.asar`; it may also append `snapshot-electron-session`, `probe-electron-launch`, and `list-electron-tabs` next actions for live app inspection

Example:

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

Use raw `args` for direct upstream React inspection when you already know the exact `react tree` / `react inspect` command you want, or when this experiment's bounded evidence model is too narrow.

### `networkSourceLookup`

- type: object with at least one of `requestId`, `filter`, or `url`, plus optional `maxWorkspaceFiles`
- optional; mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `electron`
- **EXPERIMENTAL — candidates only:** failed-request source-hint helper; it reports failed network requests and candidate source hints with evidence instead of assigning blame or proving root cause
- compiles to existing upstream `batch` commands only: `network request <requestId>` when provided plus `network requests` with `--filter <filter-or-url>` when a filter or URL is provided (if both are set, `filter` wins; when only `url` is set, it becomes the `--filter` argument); optional `session` prepends `--session <name>` before that generated `batch`
- detects failed requests from `status >= 400`, `failed: true`, or an `error` field
- candidate sources come from source-like initiator/stack metadata in upstream network results and bounded local workspace search for URL/path literals under the Pi session cwd
- optional `maxWorkspaceFiles` defaults to 2000 and cannot exceed 5000; workspace-search candidates are capped at ten
- reports `details.compiledNetworkSourceLookup` with the generated batch plan and `details.networkSourceLookup` with `{ status, failedRequests, candidates, limitations, summary }`
- `details.networkSourceLookup.status` is one of `failed-requests-found`, `no-failed-requests`, or `no-candidates`
- `details.networkSourceLookup.failedRequests[]` lists correlated failed requests (optional `requestId`, `url`, HTTP `status`, `method`, `error`) after the same failure heuristics as analysis; those request URLs are diagnostic evidence only and do not replace the session’s active page target or invalidate the latest app-page `refSnapshot`
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

For `eval --stdin`, put the script in the top-level `stdin` field. The wrapper normalizes the common mistaken shape `{ "args": ["eval", "--stdin", "document.title"] }` by moving trailing tokens after `--stdin` into stdin before launching upstream, but that recovery is only for simple one-line mistakes; use `stdin` explicitly for multiline or quote-sensitive snippets.

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
- `"fresh"` rotates that managed session to a fresh upstream launch so startup-scoped flags like `--profile`, `--executable-path`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device` apply and later default calls follow the new browser
- sessionless paths skip that injection even under `"auto"`: plain-text `--help` / `-h` / `--version` / `-V` (see the generated inspection playbook fragment below), read-only `skills list`, `skills get …`, and `skills path …`, local auth profile management (`auth save/list/show/delete/remove`), local/setup commands (`profiles`, `dashboard start/stop`, `device list`, `doctor`, `install`, `upgrade`, `session list`), and targeted/all local saved-state maintenance (`state list/show`, `state clear --all`, `state clear -a`, `state clear <session-name>`, `state clean --older-than <days>`, `state rename`) keep `effectiveArgs` free of the implicit managed `--session` unless the caller supplied `--session` explicitly; successful results therefore omit `usedImplicitSession` and the extension-managed `sessionName` for those calls, while root `session`, untargeted `state clear`, bare `state clean`, browser-backed `auth login`, and `state save/load` keep normal managed-session injection (`extensions/agent-browser/lib/command-policy.ts`, `needsManagedSession`; `extensions/agent-browser/lib/runtime.ts`, `buildExecutionPlan`)

Recommended use:
- use `"auto"` for the common browse/snapshot/click flow inside one `pi` session
- use `"fresh"` when switching from an already-active implicit session to a new profile/browser executable/debug/auth/provider launch without inventing a fixed explicit session name
- when a fresh launch fails or times out before becoming current, check `details.managedSessionOutcome`: it states whether the prior managed session was preserved or whether the attempted fresh session was abandoned because no prior managed session existed; when `sessionMode` is `"fresh"` and the tool ultimately fails, the model-visible result also appends `Managed session outcome: …` (see `#details` below). Failures under `sessionMode: "auto"` still expose the struct on `details` when the extension injects a managed `--session`, but they do not add that extra prose line.

## Wrapper behavior

Caller `args` should omit `--json`; the wrapper prepends it for normal execution so `details` and presentation stay structured. See [Wrapper `--json`](#wrapper-json).

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
- compact snapshots should be main-content-first: prefer the primary content block and nearby sections over top-of-page chrome, ads, or unrelated sidebars when those can be distinguished from the snapshot tree. They are DOM/signal-prioritized, not guaranteed viewport-first after scroll; compact output may include `details.snapshotCompaction.viewportOrdering: "dom-signal-prioritized"` and a visible viewport note when viewport context matters.
- when compacting hides actionable controls, snapshot output should add an `Omitted high-value controls` section for bounded editable/searchbox/textbox/combobox controls, named tab/surface controls, primary action buttons, high-signal named links such as repository search results, and other useful controls such as checkboxes, radios, options, and menuitems that were not already shown in key refs
- wrapper-side `snapshot -i --search <text>` and `snapshot -i --filter role=<role>` filters should strip those wrapper-only flags before upstream spawn, preserve the full latest ref map in `details.refSnapshot`, and render only matching snapshot refs/lines with `details.snapshotFilter` counts so dense-page agents can find controls without opening raw spill files

Examples:
- small `snapshot` results should include the actual snapshot text
- oversized `snapshot` results should switch to a compact view that preserves the primary content, nearby sections, a trimmed set of high-value refs, and a separate bounded list of omitted high-value controls when dense pages or desktop host screens would otherwise hide editable inputs, named surfaces/tabs, or primary action buttons, while exposing the full raw snapshot path directly in the rendered tool text and via `details.fullOutputPath`
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
- `successCategory`: present on successful results. Current values are `"completed"`, `"artifact-saved"`, `"artifact-unverified"`, and `"inspection"`. `artifact-unverified` means upstream reported success but the merged `artifactVerification` summary still has unverified non-missing rows (for example bounded spill rows) or the legacy artifact classifier still sees a non-pending file without confirmed disk presence; inspect `artifactVerification` (counts and per-entry `state` / optional `limitation`) before treating paths as durable.
- `failureCategory`: present on failed results. Current values are `"aborted"`, `"artifact-missing"`, `"cleanup-failed"`, `"confirmation-required"`, `"download-not-verified"`, `"missing-binary"`, `"parse-failure"`, `"policy-blocked"`, `"qa-failure"`, `"selector-not-found"`, `"selector-unsupported"`, `"stale-ref"`, `"tab-drift"`, `"timeout"`, `"upstream-error"`, and `"validation-error"`. `artifact-missing` means upstream reported a saved/completed artifact path, but the wrapper verified the non-pending file is absent and failed closed.

These categories are intentionally bounded and stable so agents can branch on them instead of parsing prose. They do not replace raw diagnostics: `details.error`, `details.stderr`, `details.parseError`, `details.validationError`, and visible content still preserve the specific upstream or wrapper message after normal redaction.

For argv-supplied `--allowed-domains`, the wrapper preserves the allowlist for the managed session and checks the final observed `http(s)` page URL after successful-looking browser commands. If a click, redirect, or other post-load navigation ends outside the allowlist, the wrapper reclassifies the result as `failureCategory: "policy-blocked"` and includes the requested allowlist plus observed URL/host in the failure text. Direct upstream blocks may still surface as upstream errors when upstream rejects navigation before a page target is available.

Real Pi custom tools only mark a tool result failed when the tool throws during `execute`; returned `isError` fields are not authoritative. The extension therefore also registers a `tool_result` handler that treats any `agent_browser` result with `details.resultCategory: "failure"` as a real Pi tool error. For normal prose output, it appends `Result category: failure; failureCategory: …; Pi tool isError: true.` to model-visible text. For caller-requested `--json` output, it only patches `isError` and preserves the visible JSON string unchanged so the content remains parseable. The hook treats `--json` as requested when echoed `details.args` or the original tool `input.args` includes that flag; it skips appending the prose notice only when a text content item is non-empty parseable JSON (so mixed or invalid JSON bodies still get the visible line). Implementation: `buildAgentBrowserToolResultPatch` in `extensions/agent-browser/index.ts`. This keeps Pi transcript semantics aligned with the machine-readable result contract, including wrapper-side reclassifications such as `qa-failure` after an upstream-successful batch and `artifact-missing` after an upstream-successful artifact command whose requested file is absent.

For `batch`, top-level `details` still carries `resultCategory` plus `successCategory` or `failureCategory` for the **aggregate** tool outcome: if any step fails, the overall result is a failure (`resultCategory: "failure"`) even when later steps succeed—inspect `batchSteps[]` for per-step outcomes. Each `batchSteps[]` entry includes its own `resultCategory` and either `successCategory` or `failureCategory` for that step. `batchFailure.failedStep` duplicates the first failing step’s details, including its `failureCategory` and any `nextActions`.

Top-level `details.data` on `batch` is a compact per-step roll-up (not a verbatim replay of raw upstream batch JSON): each element is `{ success, command, result? | error? }` where `command` is argv-redacted the same way as echoed invocation args (including `clipboard write` text, `cookies set` cookie values, `storage local|session set` values, and other sensitive flags/positionals), `result` is the presentation-layer data for that step after the same structured redaction as non-batch commands, and `error` is failure text with clipboard-write/cookie/storage/password literals stripped when those values appeared in argv. Prefer `batchSteps[]` for full per-step `details` (artifacts, categories, spill paths); use the roll-up when you only need a redacted matrix of what ran.

`details.refSnapshot` may appear after successful `snapshot` calls and subsequent same-session calls. It records the latest page-scoped ref ids known to the wrapper, optional per-ref accessible `role`/`name` metadata from the same snapshot, and the page target they came from so mutation-prone `@e…` commands can fail fast instead of silently hitting recycled refs after navigation. For wrapper-tracked Electron sessions, `details.electronRefFreshness` may also appear after a successful `@e…` mutation as a softer same-URL rerender warning: run `snapshot -i` before reusing old refs even if the URL did not change.

Ref preflight details (command taxonomy in `extensions/agent-browser/lib/command-taxonomy.ts`, orchestration in `extensions/agent-browser/lib/orchestration/browser-run/session-state.ts`):

- **URL alignment:** `refSnapshot.target.url` and the session’s current tab URL are compared via `targetsMatch` / `normalizeComparableUrl` in `extensions/agent-browser/index.ts`: values are trimmed, parsed as URLs when possible, compared **after dropping the `#fragment`**, and the query string remains significant. If either side lacks a `url`, `targetsMatch` treats the pair as matching so early-session calls are not blocked.
- **Batch stdin ordering:** user `batch` JSON is scanned in order. Any step whose first token satisfies `isRefInvalidatingBatchCommand` sets a latch that blocks later steps whose first token satisfies `isRefGuardedCommand` and that mention `@e…` refs, except for same-snapshot native form-control steps whose current snapshot role metadata identifies all refs as safe controls (`check`/`uncheck` or direct `click`/`tap` on checkbox or radio refs, and `select` on combobox refs). A step whose first token is `snapshot` clears that latch for subsequent steps (pre-spawn intent only; it does not wait for upstream success). These predicates read explicit command capability flags from `command-taxonomy.ts`: navigation/mutation verbs such as `open` / `goto`, `reload`, non-form `click`, and related upstream commands have `invalidatesBatchRefs`; same-snapshot `fill` rows and the role-checked native form-control rows stay guarded against missing/stale refs but do not set the latch, allowing ordinary form batches before a final click/submit step. Direct `click`/`tap @e…` is only treated as a safe form-control row when every ref in that step is a latest-snapshot checkbox or radio; other click/tap refs remain invalidating. Ref-guarded commands accept page-scoped refs for interaction (`click`, `fill`, `download`, `scrollintoview` / `scrollinto`, and others centralized in the command taxonomy). Changing either capability requires updating this contract, [`docs/SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) `RQ-0072`/`RQ-0087` notes, README and command-reference pitfalls, and `test/agent-browser.extension-validation.test.ts`.

**Presentation redaction (implementation map):** Successful non-`batch` tool calls and each successful `batchSteps[]` row run upstream `data` through `redactPresentationData` in `extensions/agent-browser/lib/results/presentation/diagnostics.ts`: `cookies` still walk objects/arrays and replace case-insensitive `value` keys with `"[REDACTED]"`; `storage` redacts values when the key or value looks credential-like (token, cookie, auth, secret, JWT, bearer/basic credential, high-entropy token-like string, or nested sensitive JSON) but keeps low-risk primitive QA values such as booleans, numbers, and short strings visible. Redacted storage entries add `valueRedacted` plus `valueRedactionReason` in `details.data`; diagnostic formatters mirror the same decision. Every other command’s payload is recursively scrubbed with `redactStructuredPresentationValue`, which redacts known sensitive key names and applies string-level sensitivity heuristics so network, diff, trace/profiler, stream, dashboard, chat, and other structured results do not echo bearer tokens, proxy credentials, or similar fields verbatim into `details.data`. Echoed `command` arrays in `details` and in batch roll-ups use `redactInvocationArgs` from `extensions/agent-browser/lib/runtime.ts` to mask trailing values for sensitive global flags (including `--body`, `--headers`, `--password`, and `--proxy`), preserve the special positional rules for `cookies set`, `storage local|session set`, and `set credentials`, and scrub other argv tokens for URLs and inline secrets. Failed batch steps additionally run `redactExactValues` on structured step errors so literals taken from that step’s argv (cookie value, storage set value, `--password` / `--password=` tokens) cannot reappear inside formatted error blobs.

`nextActions` is an optional machine-readable list of exact native `agent_browser` follow-ups. Each entry includes `tool: "agent_browser"`, an `id`, a short `reason`, optional `safety`, and either `params` (`args`, optional `stdin`, optional `sessionMode`, optional `networkSourceLookup`, optional `electron`) or an `artifactPath` for saved-file workflows. Agents should prefer these payloads over prose when present. Tab/session recovery id strings are centralized in `AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS`, while rich-input focus/click recovery ids are centralized in `AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS` plus `getAgentBrowserRichInputRecoveryNextActionId(s)` in `extensions/agent-browser/lib/results/recovery-actions.ts` (both registries are also re-exported from `shared.ts`); docs and tests mirror those registries/helpers rather than inventing recovery ids in prose. Current recommendations include: raw `connect` success → session-scoped `list-connected-session-tabs` only, then the agent should inspect/select a stable `tab t<N>` target and run `snapshot -i` explicitly; `snapshot` failures whose upstream error says `No active page` and whose wrapper result has a known session → `list-tabs-after-no-active-page` only, because this path has no wrapper-observed safe tab id to select atomically; browser profile/user-data-dir resolution failures → `inspect-browser-profiles` (`profiles`) and `run-agent-browser-doctor` (`doctor`) before retrying opens; Electron launches → wrapper-tracked `electron.status` / `electron.probe` / `electron.cleanup` actions plus session-scoped tab/snapshot inspection when attached; Electron status/probe mismatch diagnostics → `reattach-electron-launch` plus fresh tab/snapshot inspection; Electron post-command health failures → status/probe/cleanup for the same `launchId`; Electron or contenteditable fill verification mismatches → `inspect-after-fill-verification` and `verify-filled-value`; Electron same-URL ref freshness warnings → `refresh-electron-refs-after-rerender`; packaged-Electron `sourceLookup` no-candidate diagnostics → session snapshot, launch probe, and tab list; Electron cleanup partial failures → status plus retry-cleanup for the same wrapper-owned `launchId`; `open` success → `snapshot -i`; mutating/navigation commands (see `buildAgentBrowserNextActions` in source for the exact command set) → `snapshot -i`; stale refs and selector failures → `snapshot -i` via `refresh-interactive-refs` (prefixed with `--session <name>` when the failed call ran in a named or managed session); selector misses with exact current snapshot role/name matches → direct ref retries via `try-current-visible-ref` or bounded `try-current-visible-ref-N` for non-fill targets; semantic `fill` selector misses with exact current editable refs → `focus-current-editable-ref` / `click-current-editable-ref` or numbered variants that do not include fill text or submit; unknown getter shortcuts such as `title` / `url` → exact read-only retries like `get title` / `get url` with ids `use-get-title` / `use-get-url`; compact `network requests` results with safe request IDs → bounded read-only request detail, `networkSourceLookup`, path filter, or HAR-capture follow-ups; semantic `selector-not-found` failures that compiled from `semanticAction` may append `try-button-name-candidate` or `try-link-name-candidate` after presentation `nextActions` only for the bounded click pair enumerated under `semanticAction`; semantic `stale-ref` failures that compiled from `semanticAction` `find` argv may also include `retry-semantic-action-after-stale-ref` after that snapshot step; successful snapshots or qualifying same-URL non-Electron top-level clicks (see `overlayBlockers` below) with snapshot evidence of likely overlay/banner/dialog close controls may append `inspect-overlay-state` and bounded `try-overlay-blocker-candidate-*` entries; successful top-level `scroll` calls whose pre/post viewport and sampled scroll-container positions do not change may append `inspect-after-noop-scroll` and `verify-noop-scroll-visually`; explicit combobox-targeted actions that focus a combobox without visible options may append `inspect-focused-combobox`, `try-open-combobox-with-arrow`, and `try-open-combobox-with-enter`; `get text <selector>` calls with hidden/multiple CSS matches may append `inspect-visible-text-candidates` with a read-only `eval --stdin` probe (each prefixed with `--session <name>` when `details.sessionName` is set, same `sessionPrefixArgs` rule as other session-scoped follow-ups); confirmations → exact `confirm <id>` and `deny <id>` choices; generic tab drift → `list-tabs-for-recovery` with `tab list` first, then select or confirm the stable target before running `snapshot -i`; about:blank or tab-drift recovery with a wrapper-known target → `list-tabs-for-about-blank-recovery` or `list-tabs-for-tab-drift-recovery`, plus `select-intended-tab-after-drift` and `snapshot-after-tab-recovery` when the wrapper already observed the stable `t<N>` tab id; `wait --text` assertion failures → `inspect-after-text-assertion-failure` with a read-only snapshot; download verification failures or missing successful download artifacts → `wait --download [path]`; saved artifacts → the artifact path to inspect/consume after checking `artifactVerification`/metadata; missing non-download artifacts → `verify-artifact-path` so agents do not trust an absent file. When nothing applies, the field is omitted.

**Unknown-command getter hints (failure presentation):** `buildErrorPresentation` in `extensions/agent-browser/lib/results/presentation/errors.ts` only runs this path when upstream error text (after model-facing redaction) matches `unknown command`, `unknown subcommand`, or `unrecognized command` (case-insensitive) **and** the failed invocation’s primary command token is one of `attr`, `count`, `html`, `text`, `title`, `url`, or `value`. Visible text then includes a grouped-`get` hint line plus per-token guidance (`get text <selector>`, `get html …`, `get attr …`, `get count …`, `get value …`, `get title`, `get url`). Machine `nextActions` with ids `use-get-title` / `use-get-url` are emitted only for `title` / `url`, with `params.args` optionally prefixed by `--session <name>` when the failed call targeted a named session. If the error string already contains `Agent-browser hint:` from selector recovery (stale-ref or unsupported selector dialect appendages), the getter block is skipped so two stacked `Agent-browser hint:` headers are not emitted.

For `network requests`, `details.nextActions` is bounded to one selected safe request ID, preferring actionable failed rows, then API/fetch-like rows, then benign failed rows, then the first request with a safe ID. Detail/filter/HAR actions use `params.args` and preserve a known `--session <name>` prefix when the current presentation has `details.sessionName`; source-candidate actions use `params.networkSourceLookup` with the selected `requestId` plus `session` when known and are only emitted for actionable failed rows that the failed-request analyzer can correlate. A `clear-network-requests-before-repro` action can run `network requests --clear` so the next reproduction starts with a current-page-focused diagnostic buffer. Wrapper-side `network requests --current-page` / `--current-origin` renders only rows whose URL matches the active page origin, while `--current-url` renders exact active-document URL matches; those wrapper-only flags are removed before upstream spawn and reported in `details.networkRequestsPageFilter`. URLs and query strings are not copied into action params; path filters are skipped when they look sensitive or too large. If the wrapper has observed `network route` in the same session, matching failed, pending, or CORS-looking fetch/XHR rows also add `details.networkRouteDiagnostics[]` with `{ reason, routePattern, mode, requestId?, requestUrl?, summary }` and prepend executable route-mock next actions (`inspect-routed-network-request`, `start-network-har-capture-for-route-mock`) before generic request follow-ups; same-origin/CORS fixture retry guidance stays in visible prose. The route tracker is wrapper-session-local, updated on successful `network route`/`network unroute`, and cleared when that session closes or is replaced.

For `batch`, each `batchSteps[]` entry can carry its own `nextActions` for that step’s success or failure. Top-level `details.nextActions` on a failed batch duplicates `batchFailure.failedStep.nextActions` so callers can read one aggregate object. On a fully successful batch, top-level `nextActions` may still list artifact follow-ups derived from the combined step artifacts.

`pageChangeSummary` is an optional compact summary for mutation-prone and artifact-producing commands. It includes `changeType` (`"navigation"`, `"mutation"`, `"artifact"`, or `"confirmation"`), `command`, a readable `summary`, optional `title`/`url`, optional `artifactCount` or `savedFilePath`, and `nextActionIds` that link the observed change to `nextActions` without repeating full payloads. The wrapper maintains an explicit `eligibleForPageChangeSummary` command capability through `isPageChangeSummaryCommand` in `extensions/agent-browser/lib/command-taxonomy.ts`: those commands still emit a `mutation`-typed summary when upstream JSON lacks navigation metadata, as long as no stronger signal (artifact, saved path, navigation fields, or pending confirmation) applies. That capability is independent from `invalidatesBatchRefs` and `triggersPostMutationSnapshot`, so artifact summaries like `download` / `screenshot` and guarded-but-non-invalidating `fill` are documented directly in the capability table instead of implied by broad set spreading. Commands outside that set omit `pageChangeSummary` unless the parsed payload shows navigation, a confirmation prompt, saved files, or artifacts—including read-only inspection commands, which normally have no summary unless one of those signals appears. For `batch`, the top-level summary favors artifact rollups when any step produced artifacts; otherwise it may synthesize a `mutation` summary from steps that carried their own `pageChangeSummary`. Treat mutation summaries as "upstream attempted the action" evidence, not proof the application handled it; agents should verify URL/text/state for important mutations before continuing.

`clickDispatch` may appear after a **top-level non-Electron** `click` when the wrapper installed a pre-click DOM-event probe, upstream reported success, and the post-click probe found no trusted DOM event reached that target. The wrapper probes exact CSS selectors, XPath selectors, and `@e…` refs when the latest wrapper-tracked snapshot has role/name metadata that resolves to one visible DOM candidate; it does **not** take a fresh pre-click snapshot because that could recycle upstream refs before the intended click. The wrapper does **not** replay clicks in-page. On a miss it marks the tool failed, appends `Click dispatch diagnostic: …`, and sets `clickDispatch.status` to `"no-native-event-observed"` with `reason: "native-click-produced-no-target-dom-event"`, `nativeEventCount`, and a redacted `target` descriptor (`kind: "selector" | "xpath"` plus `selector`, or `kind: "accessible"` plus `refId`, `role`, and redacted `name`). `details.nextActions` gains `inspect-click-dispatch-miss` (`snapshot -i`) and `retry-click-after-dispatch-miss` (same upstream `click` argv, session-prefixed when applicable). If a local static fixture must be exercised despite this diagnostic, a caller may explicitly run a programmatic activation via `eval --stdin` such as `document.querySelector(...).click()`, but that emits an untrusted scripted event and is only a debugging/workaround path; it must not be used as proof that real user-like clicking works or to bypass prompt stop boundaries. This diagnostic is only for standalone `click`; `batch`/`job`/`qa` click steps remain upstream-owned batch behavior.

`promptGuard` may appear on wrapper-blocked calls only for concrete, machine-checkable prompt requirements. `reason: "requested-artifacts-missing-before-close"` blocks `close` / `quit` / `exit` when the prompt named exact required screenshot paths and the session artifact manifest has not verified those paths; optional recording paths are only required when recording appears available. The wrapper does **not** parse broad user/business intent such as “do not place the order” or “do not post anything” into click/key blocks; agents must follow those instructions themselves. Prompt guards return `failureCategory: "policy-blocked"` and `validationError` text instead of invoking upstream.

`overlayBlockers` may appear on a successful `snapshot` whose own refs show strong modal context, or after a successful **top-level non-Electron** `click` (the unified `details.command` is `click`, not `batch`/`job`/`qa` flows that compile to `batch`) only when upstream JSON includes a string `data.clicked` ref, no `clickDispatch` diagnostic fired for the same result, the session’s prior pinned tab URL (`priorSessionTabTarget.url`) and the post-click active tab URL both exist and stay equal after the same URL normalization used for ref preflight (trimmed hosts/paths; **`#fragment` dropped** while the query string stays significant), and the wrapper did not apply session tab correction or an about-blank mismatch recovery in the same result. Wrapper-tracked Electron clicks prefer lifecycle health and ref-freshness diagnostics because desktop app chrome produced too many false overlay candidates in dogfood. The post-click side comes from `details.navigationSummary.url`, which the wrapper fills with one read-only `eval` summary (`({ title: document.title, url: location.href })`) only when upstream click JSON omits **both** string `data.url` and `data.title` (`shouldCaptureNavigationSummary` in `extensions/agent-browser/index.ts`). If either field is present as a string on the click payload, that probe is skipped, `navigationSummary` stays unset here, and overlay diagnostics are omitted even when the page did not navigate. For post-click diagnostics, the wrapper then issues **one** extra session-scoped `snapshot -i`; for snapshot diagnostics, it scans that snapshot result directly. It only emits diagnostics when **both** are true: at least one ref has a strong modal role (`dialog` or `alertdialog`), and there are up to **three** separate `button`/`link`/`menuitem` refs whose names match close/dismiss-style patterns (for example “Close”, “Dismiss”, “No thanks”, or a lone `×`). Page-wide text such as “privacy”, “sign in”, or “banner” without a dialog role is not enough, which avoids warning on ordinary same-page menu opens or app button mutations. Each candidate carries `ref` (`@eN`), optional `role`/`name`, exact `click` argv in `args`, and a short evidence `reason`. The struct also includes a `summary` string (one sentence describing the snapshot/click evidence and likely dismiss controls) plus a `snapshot` object (same shape as `details.refSnapshot` after a normal snapshot): on success the wrapper may treat that snapshot as the session’s latest ref map for subsequent calls, so agents should assume refs can move to match this post-diagnostic tree. Visible text appends the same bullets under `Possible overlay blockers`, and `details.nextActions` gains `inspect-overlay-state` plus `try-overlay-blocker-candidate-1`…`3` after any presentation `nextActions` (for example `inspect-after-mutation`); when `details.sessionName` is set, those appended actions use `sessionPrefixArgs` so `params.args` begin with `--session <name>` unless argv already starts with `--session`. This is conservative evidence, not proof the candidate should be clicked; prefer `inspect-overlay-state` first unless the dismiss control is clearly safe.

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

When `semanticAction` produced compiled `find` argv and the unified result is `failureCategory: "stale-ref"` with `details.compiledSemanticAction` still present, `nextActions` chains snapshot refresh then the compiled `find` retry; `select` shorthands with stale `@refs` stop at refresh guidance. `reason` / `safety` strings match `buildAgentBrowserNextActions` in `extensions/agent-browser/lib/results/action-recommendations.ts` and the append in `extensions/agent-browser/index.ts`:

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

- Shared machine-readable types are centralized in `extensions/agent-browser/lib/results/contracts.ts` (including re-exports such as `AgentBrowserNextAction` from `next-actions.ts`). Classifiers live in `categories.ts` (`classifyAgentBrowserSuccessCategory`, `classifyAgentBrowserFailureCategory`, `buildAgentBrowserResultCategoryDetails`—the last prefers an explicit `failureCategory` when the caller already knows the bucket, otherwise it runs the classifier). Generic follow-up assembly lives in `action-recommendations.ts` (`buildAgentBrowserNextActions`). Tab/session recovery ids live in `recovery-actions.ts` (`AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS`, `AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS`, `getAgentBrowserRichInputRecoveryNextActionId`, `getAgentBrowserRichInputRecoveryNextActionIds`, `buildRecoveryNextActions`) and session-aware wrappers live in `recovery-next-actions.ts`. Selector miss and rich-input diagnostic shapes/actions live in `selector-recovery.ts`. `extensions/agent-browser/lib/results/shared.ts` re-exports focused modules for compatibility only. Failed upstream `network requests` rows flow through `classifyNetworkRequestFailure` / `summarizeNetworkFailures` in `network.ts` for QA analysis (`analyzeQaPresetResults` in `extensions/agent-browser/index.ts`) and for actionable-vs-benign lines plus request-specific nextActions in `network requests` presentation (`extensions/agent-browser/lib/results/presentation/diagnostics.ts`).
- Artifact verification: `ArtifactVerificationSummary` / `ArtifactVerificationEntry` types live in `contracts.ts`. `buildArtifactVerificationSummary`, `getArtifactVerificationEntry`, and `getManifestVerificationEntry` in `presentation/artifacts.ts` merge each resolved file artifact with manifest rows whose `storageScope` is not `explicit-path` (those rows duplicate file artifacts) and whose `path` is in the current result’s spill path set. Presentation then fails closed with `failureCategory: "artifact-missing"` when any resolved non-pending file artifact has `exists: false`; pending recording-start artifacts and non-explicit spill rows do not trigger this failure. If no hard-missing file artifact exists, successful presentation merges run `classifyPresentationSuccessCategory`, which can still force `successCategory: "artifact-unverified"` for unverified counts before delegating to `classifyAgentBrowserSuccessCategory`.
- Inner success categories (`classifyAgentBrowserSuccessCategory` in `categories.ts`, after verification counts are clear): if `inspection` is true → `"inspection"`; else if any non-pending artifact lacks confirmed on-disk presence (`exists !== true`) and was not upgraded to an `artifact-missing` failure → `"artifact-unverified"`; else if there is a `savedFile` or any `artifacts` → `"artifact-saved"`; else → `"completed"`.
- Failure: the classifier walks a single ordered chain (first match wins): `confirmation-required` → `timeout` → `missing-binary` → `parse-failure` → `aborted` → `policy-blocked` → `cleanup-failed` → `tab-drift` → `stale-ref` (including “unknown ref” text and a narrow `@eN` plus “element not found” heuristic) → `selector-unsupported` → `selector-not-found` → `download-not-verified` (download / wait-download style failures) → `validation-error` when a wrapper `validationError` is present → default `upstream-error`. Wrapper-known missing artifact checks pass an explicit `artifact-missing` category rather than relying on this text classifier.
- The main tool implementation merges these fields into Pi-facing `details` from `extensions/agent-browser/index.ts` and from `extensions/agent-browser/lib/results/presentation.ts` for presentation-time failures.

Additional structured fields can appear when relevant:
- `compiledSemanticAction` when the call used `semanticAction` and the result includes the unified `details` merge: `{ action, locator, args }` for `find` actions or `{ action: "select", selector, values, args }` for `select`, with the same redaction rules as `args` / `effectiveArgs`; omitted for plain `args`/`job` calls and omitted on some early error returns that omit this field (see the `semanticAction` section above)
- `compiledJob` when the call used `job` or the job-backed `qa` preset: `{ args: ["batch"], stdin, steps: [{ action, args }] }`, with step args redacted the same way as other invocation details. Semantic `job` click/fill steps appear here as their compiled upstream `find … click|fill …` argv, not as the input object.
- `compiledQaPreset` when the call used `qa`: the compiled job fields plus the QA `checks` object. `args` is `batch --bail` and `failFast` is `true` for QA presets. `checks.attached` is `true` for current-session QA, `checks.url` is present only for URL-opening QA, and `checks.diagnosticsResetAtStart` is `true` only for URL-opening QA because `qa.attached` preserves existing session diagnostics.
- `compiledSourceLookup` when the call used `sourceLookup`: `{ args: ["batch"], stdin, steps, query }` with the generated local-evidence plan and original query fields (`selector?`, `reactFiberId?`, `componentName?`, `includeDomHints?`, `maxWorkspaceFiles?`).
- `sourceLookup` when the call used `sourceLookup`: `{ status, candidates, limitations, summary, workspaceRoot?, electronContext? }`; wrapper-tracked packaged Electron no-candidate diagnostics may carry `workspaceRoot` plus `electronContext` and live Electron nextActions without marking the successful batch as a tool failure.
- `compiledNetworkSourceLookup` / `networkSourceLookup` when the call used `networkSourceLookup`: the generated batch plan plus bounded failed-request/candidate evidence as described above.
- `qaPreset` when the call used `qa`: `{ passed, failedChecks, warnings, summary }`. Network rows inside the `network requests` batch step use `summarizeNetworkFailures` / `classifyNetworkRequestFailure` in `network.ts`: actionable failures appear in `failedChecks` (and fail the tool when the upstream batch still succeeded); benign icon-classified failures appear only in `warnings` and in `summary` as `QA preset passed with warnings: …` when nothing else failed.
- `networkRouteDiagnostics` after successful `network requests` when the wrapper has observed active `network route` patterns for that session and a matching request row is pending/no-status or carries CORS/preflight-looking error text. Each row includes `reason` (`"pending-routed-request"` or `"cors-likely-routed-request"`), `routePattern`, `mode`, optional `requestId`, optional `requestUrl`, and `summary`; visible text starts with `Network route diagnostics`, and `details.nextActions` prepends executable route-mock inspection/HAR follow-ups before generic request follow-ups.
- `compiledElectron` when the call used `electron`: redacted action plan for `list`, `launch`, `status`, `cleanup`, or `probe`.
- `electron` when the call used `electron`: action-specific lifecycle, discovery, probe, and cleanup data; see the `electron` section below.
- `batchFailure` and `batchSteps` for `batch` rendering, including mixed-success runs
- `navigationSummary` for navigation-style commands like `click`, `back`, `forward`, and `reload`
- `pageChangeSummary` for compact mutation/artifact/navigation summaries on commands that can change browser state
- `clickDispatch` when a top-level non-Electron `click` reported upstream success but the wrapper’s DOM-event probe found no trusted event reached the target; shape follows `ClickDispatchDiagnostic` in `extensions/agent-browser/lib/orchestration/browser-run/types.ts`
- `promptGuard` when the requested-artifact-before-close guard blocks browser close before required prompt artifact paths are verified; implementation lives in `extensions/agent-browser/lib/orchestration/browser-run/prompt-guards.ts`
- `overlayBlockers` for conservative overlay/banner/dialog blocker candidates when a successful snapshot itself contains strong modal evidence, or after a direct click stays on the same URL, no `clickDispatch` diagnostic fired, and a fresh snapshot provides evidence (`candidates`, `summary`, and `snapshot` per `OverlayBlockerDiagnostic` in `extensions/agent-browser/index.ts`)
- `visibleRefFallback` after a raw `find` or compiled `semanticAction` fails with `selector-not-found` and a fresh snapshot finds exact role/name `@ref` matches. Shape follows `VisibleRefFallbackDiagnostic` in `extensions/agent-browser/lib/results/selector-recovery.ts`: `{ candidates, snapshot, summary, target }`, where each candidate has `ref`, `role`, `name`, optional direct ref `args`, and `reason`; visible text appends `Current snapshot ref fallback`. Non-fill candidates with direct args add `try-current-visible-ref` or numbered `try-current-visible-ref-N` actions. Fill candidates omit direct args and target text so recovery details do not repeat potentially sensitive fill text.
- `refSnapshotInvalidation` after a session `snapshot` fails with `No active page`. Shape follows `SessionRefSnapshotInvalidation` in `extensions/agent-browser/lib/session-page-state.ts`: `{ reason: "no-active-page", summary }`. The wrapper deletes prior refs for that session, persists the invalidation for resume, and blocks mutation-prone `@e…` preflight with `failureCategory: "stale-ref"` until a successful fresh `snapshot -i` records refs again.
- `snapshotFilter` after wrapper-side `snapshot -i --search <text>` or `snapshot -i --filter role=<role>`. Shape: `{ cleanArgs, search?, role?, matchedRefs, totalRefs, visibleLines, totalLines }`. The visible snapshot content is filtered, but `details.refSnapshot` still records the full upstream ref map for later stale-ref checks.
- `networkRequestsPageFilter` after wrapper-side `network requests --current-page`, `--current-origin`, or `--current-url`. Shape: `{ cleanArgs, currentUrl, mode, matchedRows, totalRows }`; the visible rows and `details.data.requests` / `items` / `entries` are filtered while the active session page target is read with `get url`.
- `richInputRecovery` after a raw `find` or compiled `semanticAction` `fill` fails with `selector-not-found` and the same current-ref diagnostic finds exact editable `searchbox` / `textbox` candidates. Shape follows `RichInputRecoveryDiagnostic` in `extensions/agent-browser/lib/results/selector-recovery.ts`: `{ candidates, inputMethodHint, nextActionIds, summary, target }`, where each candidate has `ref`, `role`, `name`, `focusArgs`, `clickArgs`, and `reason`. Visible text appends `Rich input recovery`, and `details.nextActions` gains ids from `getAgentBrowserRichInputRecoveryNextActionIds`: `focus-current-editable-ref` / `click-current-editable-ref` (or numbered variants). These actions are bounded to focus/click/inspect-style recovery: they do not include the fill text, do not press `Enter`, and do not submit. After the right current editable ref is focused, the agent should use `keyboard inserttext` or `keyboard type` with the intended text in a separate call and submit only when explicitly required by the flow.
- `scrollNoop` after a successful **top-level** `scroll` when wrapper-side read-only probes before and after the command show no change in `window.scrollX` / `window.scrollY` and no change in the sampled prominent scrollable containers. To avoid pre-launching a session without caller startup state, this probe is skipped when the invocation includes startup-scoped flags such as `--profile`, `--state`, `--session-name`, `--cdp`, providers, init scripts, or similar launch settings. Shape: `{ reason: "no-observed-scroll-position-change", message, before, after, recommendations }`; `before` / `after` include viewport dimensions, document scroll dimensions, and up to ten sampled container descriptors plus scroll offsets. Container descriptors use only sample index, tag name, and ARIA role; DOM ids/classes are intentionally not stored. This diagnostic is conservative evidence that the page-level scroll likely missed a nested pane, not proof that every app-specific region is unchanged. Visible text starts with `Scroll completed with no observed movement`, appends `Scroll diagnostic: no observed scroll movement`, sets `details.data.scrolled` to `false` / `details.data.noMovement` to `true`, and `details.nextActions` gains `inspect-after-noop-scroll` (`snapshot -i`) plus `verify-noop-scroll-visually` (`screenshot`), session-prefixed when applicable. Explicit CSS-container calls of the form `scroll <selector> <up|down|left|right> [px|percent]` are handled before upstream page scroll and report `details.scrollContainer` with before/after offsets. Explicit page-position calls `scroll to end` / `scroll to top` are handled against `document.scrollingElement` before upstream page scroll and report `details.scrollPage` with before/after offsets.
- `comboboxFocus` after a successful explicit combobox-targeted `click` / `fill` / `find … click|fill` (for example `semanticAction` with role `combobox`, including when that semantic action resolves through a current visible `@ref` before execution) when a read-only probe sees the active element is combobox-like, `aria-expanded` is explicitly present (`false` or `true`), and no visible `listbox` / `option` / menu option elements are open. Shape: `{ reason: "focused-combobox-without-visible-options", message, activeElement, visibleListboxCount, visibleOptionCount, recommendations }`; `activeElement` includes bounded role/tag/expanded/hasPopup/name metadata with normal text redaction. Visible text appends `Combobox diagnostic: focused combobox did not expose visible options`, and `details.nextActions` gains `inspect-focused-combobox` (`snapshot -i`), `try-open-combobox-with-arrow` (`press ArrowDown`), and `try-open-combobox-with-enter` (`press Enter`), session-prefixed when applicable. The diagnostic is deliberately gated to explicit combobox-targeted calls to avoid extra probes or false positives on ordinary clicks/textboxes.
- `recordingDependencyWarning` after a successful `record start` or `record restart` when the wrapper cannot find an executable `ffmpeg` on the Pi process `PATH`. Shape: `{ reason: "ffmpeg-missing-for-recording", dependency: "ffmpeg", command, message, recommendations }`. Visible text appends `Recording dependency warning: ffmpeg not found on PATH`. This is a non-blocking preflight warning: upstream may start recording, but `record stop` needs `ffmpeg` to encode the WebM.
- `selectorTextVisibility` after a **successful** upstream `get text <selector>` (standalone or inside a successful `batch`) when the wrapper’s follow-up probe finds a hazard: more than one DOM match (upstream reads the first `querySelectorAll` hit, which may be the wrong tab/panel), or the first match is hidden while at least one other match is visible (requires multiple DOM nodes so a visible peer exists; a lone hidden match is not flagged). The probe is a read-only `eval --stdin` script (`buildVisibleTextProbeScript` in `extensions/agent-browser/lib/orchestration/browser-run/diagnostics.ts`) that counts matches, applies a small visibility heuristic (`display`/`visibility`/`opacity` plus non-zero client rects), may include a redacted `firstVisibleTextPreview`, and may include up to eight `visibleCandidates` entries (`index` in `querySelectorAll`, `tagName`, optional `role`, optional redacted `textPreview`). It is **not** run for page-scoped `@e…` selectors or when the selector string is withheld because `selectorMayExposeSensitiveLiteral` would risk echoing secrets in probe output. `details.selectorTextVisibility` mirrors the primary diagnostic (first sorted entry); when several selectors in one `batch` qualify, `selectorTextVisibilityAll` lists every diagnostic sorted so hidden-first cases precede generic multi-match ambiguity. Appended visible warning text names the matching `details.nextActions` id and may list visible candidate previews. Appended `details.nextActions` use ids `inspect-visible-text-candidates` and `inspect-visible-text-candidates-2`, … with the probe replayed via `eval --stdin` for each hazardous selector. If the probe still leaves more than one visible candidate, it is only ambiguity evidence; agents should narrow the selector, use a current visible `@ref`, or run a targeted visible-element `eval --stdin` rather than trusting the broad selector.
- `electronGetTextScopeWarning` after a successful wrapper-tracked attached Electron `get text <selector>` (standalone or successful `batch`) when a broad non-ref CSS selector such as `body`, `html`, `main`, `div`, or `[role=application]` may read the whole app shell. Ordinary browser pages, including `file://` fixtures, do not qualify without wrapper-owned Electron launch provenance. Shape: `{ selector, summary, electronContext: { launchId?, sessionName?, url? } }`; multiple batched diagnostics use `electronGetTextScopeWarnings`. Visible text appends `Broad Electron get text selector warning`, and next actions use `snapshot-for-electron-text-scope` ids with session-scoped `snapshot -i` payloads.
- `evalStdinHint` after a successful `eval --stdin` when caller stdin (trimmed) looks function-shaped to the wrapper’s lightweight detector (in `extensions/agent-browser/lib/orchestration/browser-run/diagnostics.ts`: leading `function` / `async function`, parenthesized arrow `(…) =>`, or a concise `name =>` / `async name =>` form) **and** upstream JSON `data` is an object whose `result` field is a plain empty object (`{}`). Arrays such as `[]` do not qualify. It includes `reason` and `suggestion`; visible output appends `Eval stdin hint` with the same guidance. This is a heuristic for the common mistake of returning a function object instead of invoking it or passing a plain expression, not a JavaScript parser or proof that the page returned no useful data. Before this diagnostic path runs, the wrapper also recovers the common malformed native-tool call `args: ["eval", "--stdin", "..."]` with no top-level `stdin` by moving trailing `args` tokens after `--stdin` into the process stdin stream.
- `evalResultWarning` after a successful `eval --stdin` when the current or prior page URL is `file:` (from navigation summary, session tab target, or persisted session page state), upstream JSON `data.result` is strictly `null`, and stdin is non-empty and not a trivial literal `null`/`undefined`. Fields: `reason`, `suggestion`. Visible output appends `Eval result warning` without failing the tool. Use snapshot -i, ref-based getters, screenshots, or http(s) fixtures when file:// null results are inconclusive.
- `timeoutPartialProgress` after `runAgentBrowserProcess` reports `timedOut` (wrapper child-process watchdog) when best-effort recovery finds useful context. `summary` is a short sentence counting how many declared artifact paths exist on disk versus how many were scanned, and whether page context came from live session reads or only from a planned URL (when nothing in the plan declares an artifact path, the fraction may read `0/0` while `currentPage` can still carry session or planned URL context). `steps` lists planned argv from the compiled `job` or `qa` batch plan (`compiledJob` in `extensions/agent-browser/index.ts`, which is only populated for those top-level modes) or, when that object is absent, from the same JSON-array `batch` stdin the tool sends upstream—whether caller-authored or wrapper-generated for `sourceLookup` / `networkSourceLookup` (1-based indices; only JSON-array stdin whose elements are string[] argv arrays is parsed); timeouts on other argv shapes may still emit `currentPage` / summary evidence without `steps`. `currentPage` comes from session-scoped `get url` / `get title` when the session answers, otherwise a fallback URL may be inferred from the last `open` / `navigate` / `pushstate` step in the plan. `artifacts` covers declared output paths on `screenshot`, `pdf`, `download`, and `wait --download` steps (absolute path, existence, optional `sizeBytes`, `stepIndex`). Visible text repeats the same block under `Timeout partial progress`, applying URL and path-segment redaction; the prose `Planned steps` list shows at most six steps, then an omitted-count line when the plan is longer. This is recovery evidence only; missing entries do not prove the upstream step never ran or that no other side effects occurred.
- `managedSessionOutcome` after a managed-session plan reaches process execution (`buildManagedSessionOutcome` / `formatManagedSessionOutcomeText` in `extensions/agent-browser/lib/orchestration/browser-run/session-state.ts`). Populated when `buildExecutionPlan` injects an extension-managed implicit or fresh `--session`, and also when a successful explicit `--session <current-wrapper-managed-session> close` closes the current managed session. It remains omitted for unrelated explicit user-managed sessions and for sessionless inspection/local paths that skip injection. Fields: `status` (`created`, `replaced`, `unchanged`, `closed`, `preserved`, or `abandoned`), `sessionMode`, `attemptedSessionName`, `previousSessionName`, `currentSessionName`, optional `replacedSessionName`, `activeBefore`, `activeAfter`, `succeeded`, and `summary` (machine-oriented; may include generated session names). Model-visible echo: only when `sessionMode` is `"fresh"` **and** `succeeded` is false, the wrapper appends action-oriented `Managed session outcome` and `Recovery` lines without repeating generated session ids in visible prose; session names remain in `details.managedSessionOutcome`. Failed fresh launches may also append `details.nextActions` such as `run-agent-browser-doctor`, `verify-current-managed-session`, `snapshot-current-managed-session`, or `retry-fresh-managed-session`. When other trailing diagnostic prose is also emitted in the same result, that block is concatenated **after** semantic-action candidate lines, overlay/selector-visibility tails, eval hints/warnings, and `Timeout partial progress` (see `rawAppendedDiagnosticText` in `extensions/agent-browser/lib/orchestration/browser-run/final-result.ts`). For `"auto"` failures the same struct may appear on `details` without that extra line. When post-upstream analysis (for example **`qa`** preset failure) flips the overall tool result after a successful batch, or a fresh `job`/batch opens the requested page and then a later step fails, the managed-session transition still reflects that the fresh browser became current. The visible recovery says the fresh launch became current and points to `failureCategory` / `qaPreset` / `batchFailure` for the post-launch failure instead of telling the agent that the old session was preserved.
- `imagePath` / `imagePaths` for Pi inline image attachments from the **`screenshot`** command (including batched screenshot steps). **`diff screenshot`** still records the diff output as an `image`-kind entry in `details.artifacts`, but it does **not** populate `imagePath` / `imagePaths` or attach an inline image: only plain `screenshot` is treated as a trusted live-capture path for automatic inlining (`isTrustedScreenshotOutput` in `extensions/agent-browser/lib/results/presentation/artifacts.ts`).
- `artifacts` for saved files such as screenshots, `state save` outputs, `diff screenshot` diff images, PDFs, downloads, `wait --download` files, traces, CPU profiles, completed WebM recordings, path-bearing HAR captures, and future recording output paths reported by `record start`. Non-file URL payloads such as `data:` / `blob:` / `http(s):` values are not treated as verified local artifacts. For direct artifact commands and batch artifact steps, the wrapper creates parent directories for requested paths before spawning upstream. Each artifact includes the original saved or requested `path`, resolved `absolutePath`, `kind`/`artifactType`, optional `mediaType`, optional `extension`, best-effort disk metadata such as `exists` and `sizeBytes`, plus `requestedPath`, `status`, `cwd`, `session`, and `tempPath` when applicable.
- `savedFilePath` / `savedFile` for direct `download`, `pdf`, and `wait --download` saved-file workflows when a host file path is reported or wrapper-verified. Batch results preserve the same fields on the relevant `batchSteps` entry. These fields are metadata only until `artifactVerification` verifies the file. For simple loopback `download <selector> <path>` anchors with a non-ref selector, `details.downloadRecovery.method: "direct-anchor-fetch"` means the wrapper resolved the anchor URL in-session and saved the in-page HTTP(S) response directly to the requested path before using upstream's click/download fallback; non-loopback/profile downloads stay upstream-owned so external provider behavior is preserved.
- `batchSteps[].artifacts` for per-step artifacts in `batch` output; top-level `artifacts` aggregates all step artifacts in order
- `artifactVerification` for a normalized verification summary on the unified result and on each successful `batchSteps[]` row (failed batch steps omit artifact rows). Top-level `batch` verification rolls up all step file artifacts; each step’s summary reflects that step’s nested tool presentation (including its spill paths and manifest slice). It reports `verified`, `verifiedCount`, `missingCount`, `pendingCount`, `unverifiedCount`, and `artifacts[]` entries with `path`, optional `absolutePath`, optional `requestedPath`, `kind` (a normal file artifact kind or `"spill"` for manifest-backed rows), optional `mediaType`, optional `exists`, optional `sizeBytes`, optional `status`, optional `retentionState` / `storageScope` on manifest-derived rows, `state` (`verified`, `missing`, `pending`, or `unverified`), and optional `limitation` (human-readable lifecycle or retention context, for example pending `record start`, missing or unverified files, ephemeral spill files, or evicted persisted spills). The summary `verified` boolean is true only when every entry is `verified`. `record start` is `pending` until `record stop`; `state load` may mention a path in command output but is not a saved artifact row.
- `fullOutputPath` / `fullOutputPaths` when large snapshot output or other oversized tool output is compacted and spilled to a private file; persisted sessions keep that path under a private session-scoped artifact directory with a bounded per-session budget so it survives reload/resume without unbounded growth
- `artifactManifest` for a bounded, metadata-only inventory of recent session artifacts. Entries include path metadata, artifact `kind`, source `command`/`subcommand` when safe, `storageScope` (`persistent-session`, `process-temp`, or `explicit-path`), and `retentionState` (`live`, `ephemeral`, `missing`, or `evicted`). The default recent window is 100 entries and can be configured with `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES`. The manifest must not store command args, output contents, headers, DOM snapshots, or downloaded file contents.
- `artifactRetentionSummary` with a concise count of live, evicted, ephemeral, and missing artifacts from the current manifest; results append this summary to model-facing text only when retention state affects recovery, such as spill files, ephemeral files, or evictions. Routine explicit saved files keep the summary in details to avoid noisy browsing transcripts.
- `artifactCleanup` after a successful close command (`close`, `quit`, or `exit`) when `artifactManifest` exists and `entries` is non-empty. Fields: `owner: "host-file-tools"`, `summary` (same retention summary string as `artifactRetentionSummary` for that manifest), `note` explaining that browser close commands do not delete explicit screenshots/downloads/PDFs/traces/HAR/recordings, and `explicitArtifactPaths`: up to ten **distinct existing** paths taken from manifest rows with `storageScope: "explicit-path"` in encounter order (de-duplicated after checking the filesystem); deleted/stale explicit paths are skipped. When the recent window has no existing explicit rows—for example only spill/ephemeral inventory or explicit paths already deleted—the array is empty but `summary` / `note` still surface so agents know close is not file deletion. The native browser tool intentionally does not expose a delete operation for arbitrary user-chosen artifact paths; agents should inspect `artifactVerification` / manifest metadata, then remove files with normal host file tools when cleanup is required.
- compact **snapshot** metadata on successful presentation when `details.data.compacted` is true (oversized trees): `previewMode` (`"structured"` vs outline `"outline"`), `structuredPreviewUsed`, `previewRefIds`, `previewSections` (per-section `linesShown` / `omittedLines` / root `role` / `title`), `additionalSectionsOmitted`, counts such as `refCount`, `snapshotLineCount`, and `roleCounts`, optional `highValueControlRefIds` aligned with the visible bounded `Omitted high-value controls` lines, and optional `spillError` when the wrapper could not write the raw spill file; the model text still ends with `Full raw snapshot path:` or an explicit unavailable reason plus `details.fullOutputPath` when a path exists
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
- `diff screenshot` → same file-artifact pattern as above for the **diff** image path only (summary text uses “Saved diff image” only when the diff output exists; missing output says “Diff image reported; file not verified” and fails as `artifact-missing`); baseline paths and other fields stay in the structured payload but are not echoed as separate saved artifacts in the visible artifact block, and there is no Pi inline image attachment for the diff output
- `state load` → completion text may mention the loaded path, but the wrapper does **not** treat that path as a new saved artifact (`artifacts` / `artifactManifest` stay unset) the way `state save` does
- auth, cookies, storage, clipboard, dialog, frame, state, network, debug, diff, stream, dashboard, chat, and other structured results → concise summaries that avoid expanding secret-bearing payloads; credential-like keys, values, URLs, body snippets, bearer/basic credentials, clipboard write text, cookie values, and likely secret storage values are redacted before model-facing output and `details.data`, while benign primitive storage values may remain visible for local QA
- TUI display → custom `agent_browser` call/result rendering with colorized command/output text and a built-in-style collapsed view for long visible output; `ctrl+o` expansion reveals the full rendered tool result without changing the model-facing content
- snapshots → origin + ref count + main-content-first compact preview, with the raw snapshot spill path printed directly in content and kept in `details.fullOutputPath` plus `details.artifactManifest` when the inline result would otherwise be too large
- oversized generic outputs such as large `eval --stdin` payloads → compact preview plus the actual spill file path instead of dumping the whole payload into model context
- extraction-style commands like `eval --stdin` and `get title` → scalar-first text with lightweight origin context when available
- navigation actions like `click`, `back`, `forward`, and `reload` → lightweight post-action title/url summary when available
- tab lists → compact summary/table
- stream status → enabled/connected/port summary plus WebSocket URL and frame format when a port is known; `stream enable` errors that only say streaming is already enabled are normalized to a successful idempotent no-op with `details.data.alreadyEnabled: true` and status/disable nextActions; if the caller explicitly passed `--json`, visible text is valid JSON instead of a prose summary
- diagnostic/status families (`session`, `session list`, `profiles`, `doctor`, `auth list`/`show`, `cookies`, `storage`, `dialog`, `frame`, `state`, `network requests`, `console`, `errors`, and dashboard start/stop/status outputs) → compact readable summaries with counts and stable fields; `doctor` renders status/check/fix rows even when upstream puts those fields at the top level of its JSON envelope; `session list` and `tab list` keep names/labels/active markers/titles/URLs readable instead of opaque generated ids only; `network requests` and `console` previews label their scope as the upstream session aggregate unless upstream or a URL-opening QA preset explicitly cleared/filtered the buffers first; network request lists include an actionable-vs-benign failed-request summary and mark low-impact browser icon failures separately; active route mocks can add failed/pending/CORS route diagnostics; `data:image` artifact request rows are hidden from compact previews while preserved in raw details; request-detail URLs from `network request` remain diagnostic-only rather than session page targets; large log/request/error outputs use previews plus `fullOutputPath` spill files; sensitive nested auth/header/token fields are not expanded in the model-facing text
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
- preserve the current branch-visible extension-managed session across `/reload`, exact-session relaunch, `/resume`, and Pi `session_tree` branch transitions so persisted sessions can keep following the live browser after lifecycle changes
- close the active extension-managed session when the originating `pi` process quits, while leaving explicit caller-provided sessions alone
- set an idle timeout on extension-managed sessions as a backstop for abnormal exits or cleanup failures
- clean up process-private temp spill artifacts on shutdown, while keeping persisted-session snapshot spill files in a private session-scoped artifact directory so `details.fullOutputPath` survives reload/restart and the oldest spill files are evicted if the per-session artifact budget is exceeded
- reconstruct the current branch-visible extension-managed session, latest page-scoped refs, latest `artifactManifest`, and wrapper-tracked Electron launch records from the active transcript branch on `session_start` and Pi `session_tree` so later default calls keep following the active managed browser and can continue reporting artifact retention state; successful explicit wrapper-owned close rows and `electron.cleanup` managed-session steps are restore-visible close events
- keep runtime cleanup ownership separate from branch-visible state: `session_tree` restore and wrapper-owned browser commands are serialized with managed-session work; independent caller-owned explicit-session commands can still run in parallel, but a branch-state generation guard prevents stale completions from overwriting a newer branch restore. Extension-managed sessions and wrapper-launched Electron records owned by the current process remain eligible for quit/cleanup, and fresh-session allocation stays monotonic across branch restores, including auto rows and close rows that reference wrapper-generated fresh names
- when a close command or `electron.cleanup` successfully closes the current wrapper-managed session, clear live page/ref state, reserve the next generated fresh-session ordinal, and rotate the next default auto call to a fresh wrapper-generated session name rather than reusing the closed name
- when `/reload` shuts down an extension instance, close off-branch owned managed sessions and off-branch owned Electron launches before clearing process-local ownership; preserve only the current branch-visible active managed session and active Electron launch plus its isolated `userDataDir` for reload continuity, and also persistently protect `userDataDir` paths when partial cleanup intentionally skips or fails profile removal so later temp cleanup, process exit, and stale temp-root pruning after restart do not violate Electron cleanup's safety decision; rebuild active branch state from the active branch on the next `session_start`
- when an unnamed `sessionMode: "fresh"` launch succeeds, make it the new extension-managed session so later default calls keep using it
- when an unnamed `sessionMode: "fresh"` launch fails or times out, preserve the previous managed session when one was active or report the attempted fresh session as abandoned when no managed session was active (`details.managedSessionOutcome`; visible `Managed session outcome: …` only when the final tool call used `sessionMode: "fresh"` and failed—see `#details`)
- if that unnamed fresh launch replaced an already-active managed session, best-effort close the old managed session after the switch succeeds
- treat explicit caller-provided `--session` choices as user-managed; `--session` isolates a live browser session but is not a persisted tab/auth restore mechanism after a close command (`close`, `quit`, or `exit`), so use `--profile`, `--session-name`, or `--state` when persisted auth/tab state is required
- pass explicit `--profile` straight through to upstream `agent-browser`; no profile-cloning or isolation layer is added in v1
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After the wrapper observes tab-drift risk for a session (for example profile restore correction, overlapping stale opens, or resumed session state), later active-tab commands best-effort pin that tab inside the same upstream invocation. Routine same-session commands are not preflighted with tab list just because a target tab is known.
- For sessions with observed tab-drift risk, after a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes. Routine same-session commands skip this post-command tab-list probe.
- If a known session target unexpectedly reports about:blank, agent_browser best-effort re-selects the prior intended target when it still exists; if recovery fails, it records the observed about:blank target and reports exact recovery guidance instead of treating the prior page as active.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- on local Unix launches, set a short private socket directory for wrapper-spawned `agent-browser` processes so extension-generated session names do not fail the upstream Unix socket-path length limit in longer cwd/session-name combinations
- keep wrapper-spawned commands below the upstream CLI IPC read-timeout budget by clamping `AGENT_BROWSER_DEFAULT_TIMEOUT` to 25 seconds and stopping a stuck child process before the upstream 30-second retry path begins (`PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS` configures the default watchdog). Dialog commands use `PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS` (default 5000 ms), and click/tap/find refs or tokens plus `eval --stdin` snippets whose text looks like alert/confirm/prompt/dialog triggers use `PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS` (default 8000 ms). Timed-out compiled `job` / `qa` or caller `batch` calls may add `details.timeoutPartialProgress` and visible `Timeout partial progress` evidence with planned steps, current page title/URL, and declared artifact path checks; timed-out dialog-like commands may add dialog status/dismiss/fresh-session recovery next actions
- interactive or long-running upstream families such as `chat` without a prompt, `dashboard start`, `stream enable`, `trace start`, `profiler start`, `record start`, `inspect`, `install`, `upgrade`, `doctor --fix`, and `confirm-interactive` are passed through thinly but remain bounded by the same wrapper timeout/session planning rules; prefer explicit arguments, single-shot `chat <message>`, non-interactive flags like `doctor --offline --quick` or `doctor --json`, and cleanup pairs such as `dashboard stop`, `stream disable`, `trace stop`, `profiler stop`, and `record stop`
- treat successful plain-text inspection commands like `--help` and `--version` as stateless: do not inject the implicit managed session and do not let those calls claim the managed-session slot
- if startup-scoped flags like `--profile`, `--executable-path`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, or iOS `--device` are supplied after the implicit session is already active while `sessionMode` is `"auto"`, return a validation error with a structured recovery hint that recommends `sessionMode: "fresh"`
- for direct headless local Chrome launches to `chat.com` / `chatgpt.com` / `chat.openai.com`, allow a narrow compatibility fallback that injects a normal Chrome `--user-agent` only when the caller did not explicitly provide one and did not choose `--headed`, `--cdp`, `--auto-connect`, or a provider-backed launch

## Non-goals

- no giant action enum mirroring the whole upstream CLI
- no support for older `agent-browser` versions
- no compatibility shims
- no first-class reusable named browser recipe runtime above constrained `job`, the `qa` preset, experimental `sourceLookup` / `networkSourceLookup`, and raw `batch` / `args`; see [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet) (closed `RQ-0068`)
- no embedded browser UI inside `pi`
