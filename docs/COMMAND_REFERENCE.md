# Agent Browser command reference

Related docs:
- [`../README.md`](../README.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`ELECTRON.md`](ELECTRON.md)
- [`RELEASE.md`](RELEASE.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

## Purpose

Provide a local, repo-readable command reference for the native `agent_browser` tool.

This project intentionally blocks normal `agent-browser` bash usage in most agent sessions, so the agent still needs an accessible local equivalent of the upstream command surface. This document is the durable reference the agent can read inside the repository without calling the binary directly.

## Upstream baseline

<!-- agent-browser-capability-baseline:start upstream-baseline -->
<!-- Generated from scripts/agent-browser-capability-baseline.mjs. Run `npm run docs -- command-reference write` to update. Do not edit manually. -->
This reference is baselined to the locally installed `agent-browser 0.27.1` command/help surface, audited against vercel-labs/agent-browser@90050f2913159875e2c3719e424746396ccb3cbf. Upstream `agent-browser` remains the source of truth for command semantics; this file is the local fallback for Pi agent sessions where direct binary help is blocked or discouraged.

The lightweight drift check is `npm run verify -- command-reference`. Run it whenever the installed upstream `agent-browser` version changes or this reference is edited.

Use `npm run benchmark:agent-browser` or `npm run verify -- benchmark` before and after agent-facing workflow abstractions to measure task success, tool calls, model-visible output size, stale-ref behavior, artifact success, failure-category coverage, and elapsed-time estimates.
<!-- agent-browser-capability-baseline:end upstream-baseline -->

## Core mental model

Input mode chooser (one per call): **`args`** for the default open → snapshot -i → click/fill `@refs` flow; **`semanticAction`** for stable role/text/label targets; **`job`** / **`qa`** for multi-step checks; **`electron`** for desktop apps only; **`sourceLookup`** / **`networkSourceLookup`** are **experimental candidates-only** helpers (not authoritative mappings). Do not pass `--json` in `args`—the wrapper injects it. Match link and button text to the latest snapshot (on `https://example.com/` the main link is `Learn more`, not legacy `More information...` copy). See [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#input-mode-chooser) for snapshot variants (`-i` vs `--compact` vs full) and batching three or more getters.

Tool parameters (use exactly one of `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron`):

```json
{ "args": ["open", "https://example.com"], "sessionMode": "auto" }
```

```json
{ "semanticAction": { "action": "click", "locator": "text", "value": "Submit" }, "sessionMode": "auto" }
{ "semanticAction": { "action": "select", "selector": "#flavor", "value": "chocolate" } }
```

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

```json
{ "job": { "steps": [{ "action": "open", "url": "https://example.com" }, { "action": "assertText", "text": "Example Domain" }] } }
```

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

```json
{ "networkSourceLookup": { "requestId": "req-1", "url": "/api/fail" } }
```

```json
{ "electron": { "action": "list", "query": "code" } }
{ "electron": { "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" } }
```

- `args`: exact `agent-browser` CLI tokens after the binary name. Omit when using `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron` instead (mutually exclusive).
- `semanticAction`: optional shorthand for common `find` flows and native dropdown `select`; compiles to upstream argv and is rejected together with `args`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron` on the same call.
- `job`: optional constrained short-workflow schema; compiles to existing upstream `batch` args/stdin and reports the compiled plan in `details.compiledJob`.
- `qa`: optional lightweight QA preset; compiles to the same batch path and reports `details.compiledQaPreset` plus `details.qaPreset` pass/fail evidence.
- `sourceLookup`: **EXPERIMENTAL — candidates only** for local UI-to-source hints; compiles to the same `batch` path, reports `details.compiledSourceLookup` and `details.sourceLookup`, and never reclassifies a fully successful upstream batch as failed the way `qa` can (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#sourcelookup) and the longer notes below).
- `networkSourceLookup`: **EXPERIMENTAL — candidates only** for failed request-to-source hints; compiles to generated `batch`, reports `details.compiledNetworkSourceLookup` and `details.networkSourceLookup`, and never assigns blame or edits files.
- `electron`: optional Electron desktop-app shorthand. `list`, `status`, `cleanup`, and `probe` are wrapper-owned host/session helpers; `launch` starts a wrapper-owned isolated Electron profile and attaches through upstream `connect`.
- `stdin`: only for `batch`, `eval --stdin`, and `auth save --password-stdin`; other command/stdin combinations are rejected before `agent-browser` is launched. `job`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron` generate or manage their own input.
- `sessionMode`:
  - `"auto"` reuses the extension-managed session when possible.
  - `"fresh"` rotates that managed session to a fresh upstream launch so launch-scoped flags (`--auto-connect`, `--cdp`, `--enable`, `--executable-path`, `--init-script`, `--device`, `--profile`, `--provider`, `-p`, `--session-name`, `--state`) apply.
  - If a fresh launch fails or times out, read `details.managedSessionOutcome` for `preserved` vs `abandoned` (and related fields). A model-visible `Managed session outcome: …` line is appended only for failing calls that used `sessionMode: "fresh"`; `"auto"` failures can still populate the struct without that extra line. If you explicitly close the current wrapper-managed session with `--session <name> close`, later default auto calls rotate to a new wrapper-generated session instead of reusing the closed name; repeated closes and branch restores keep those generated names monotonic.

### Debug, diff, stream, dashboard, and chat families

Upstream also exposes non-core families (`network`, `diff`, `trace` / `profiler` / `record`, `console` / `errors` / `highlight` / `inspect` / `clipboard`, `stream`, `dashboard`, `chat`, and related subcommands). The wrapper still owns argv planning, `--json`, managed sessions where applicable, artifact metadata, and model-facing presentation: structured results are compacted and scrubbed in `extensions/agent-browser/lib/results/presentation.ts`, and echoed argv uses the same `redactInvocationArgs` rules as core commands (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) for the field contract). Deterministic fake-upstream coverage for representative JSON shapes and redaction lives in `test/agent-browser.extension-validation.test.ts` under `agentBrowserExtension passes through non-core network debug diff stream dashboard and chat families`.

## Recommended workflow

Keep routine browser work simple: open a page, inspect it with `snapshot -i`, interact with current `@ref` values from that snapshot, then inspect again. Re-run `snapshot -i` after navigation, scrolling, rerendering, or other major DOM changes because refs can become stale.

### Normal browse flow

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i", "--urls"] }
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

### Headed demo and local-page checks

Use upstream's global `--headed` flag on the first launch when the user needs to watch the browser. Because headed/headless state belongs to the browser launch, use `sessionMode: "fresh"` when a managed session may already exist or when changing from a previous headless run.

```json
{ "args": ["--headed", "open", "https://example.com"], "sessionMode": "fresh" }
{ "args": ["screenshot", "/tmp/agent-browser-headed-check.png"] }
```

Treat headed success as browser-context success, not proof that a window is visible on the user's display. Remote shells, containers, virtual framebuffers, or upstream/provider-owned browser hosts can still put the visible window somewhere the user cannot see. If a user reports no window, gather evidence with `screenshot`, `tab list`, `get url`, or `snapshot -i`; then relaunch with the right display/profile/provider setup rather than assuming the user missed it.

For local fixtures, remember that `localhost` and `127.0.0.1` are resolved from the browser host, which may differ from the shell that started a temporary HTTP server. `net::ERR_EMPTY_RESPONSE` on `http://localhost:<port>` usually means the browser could not reach that server, not that the page itself rendered blank; the wrapper appends a local fixture hint for common loopback navigation failures. Prefer a host-reachable address when your environment provides one; otherwise use `file://` only for static fixtures and note its limits. `file://` does not provide HTTP headers and may change MIME/CORS/storage/debugger behavior. If `eval --stdin` on a `file://` page returns `null` for even simple DOM expressions, first make sure the JavaScript is in the native tool `stdin` field rather than trailing after `--stdin` in `args`; then treat the result as inconclusive and verify with `snapshot -i`, `get text` on current refs, or screenshots until the fixture can run over reachable HTTP.

Temporary HTTP servers and their port/process lifecycle stay outside the native tool. Extension maintainers running real-upstream contract tests can reuse `startAgentBrowserContractFixtureServer()` in [`test/helpers/agent-browser-harness.ts`](../test/helpers/agent-browser-harness.ts) instead of ad-hoc `python3 -m http.server` processes.

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
{ "args": ["vitals", "https://example.com"] }
{ "args": ["pushstate", "/dashboard?tab=settings"] }
```

For first-navigation setup, start on `about:blank`, then stage routes, cookies, or init scripts before navigating. The relevant v0.27.1 surfaces are `network route <url> [--abort|--body <json>] [--resource-type <csv>]` and `cookies set --curl <file>`:

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
{ "semanticAction": { "action": "click", "locator": "role", "role": "button", "name": "Continue without Signing In" } }
{ "semanticAction": { "action": "fill", "locator": "label", "value": "Email", "text": "user@example.com" } }
{ "semanticAction": { "action": "select", "selector": "#flavor", "value": "chocolate" } }
{ "semanticAction": { "action": "click", "locator": "text", "value": "Close", "session": "named-browser" } }
{ "semanticAction": { "action": "uncheck", "locator": "label", "value": "Remember me" } }
{ "args": ["scrollintoview", "@e12"] }
{ "args": ["snapshot", "-i"] }
```

The optional native `semanticAction` object is only a thin schema for common locator-based actions and native dropdown selection; it compiles locator actions to existing upstream `find` commands, compiles `action: "select"` to upstream `select <selector> <value...>`, and reports the compiled argv in `details.compiledSemanticAction` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction) for the full field rules). For `locator: "role"`, pass either `value: "button"` or `role: "button"`; if both are present they must match. It is a top-level alternative to `args`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron`, not a nested shape inside `batch` stdin arrays. Add `session` inside `semanticAction` when the shorthand should target a named upstream browser session; the compiled argv prepends `--session <name>` before `find` or `select`, and fallback candidate actions preserve that prefix. For active sessions, role/name click/check/uncheck shorthands may resolve through the current `snapshot -i` refs before execution so hidden duplicate matches do not steal the action; inspect `details.effectiveArgs` when you need the exact executed argv. `select` shorthand intentionally requires a stable selector or current `@ref` plus `value`/`values`; upstream `find` does not expose a verified `select` action, so role/name/label dropdown resolution stays a snapshot/selector decision instead of hidden wrapper magic. If a raw `find` or semantic action misses with `selector-not-found`, the wrapper may take one fresh snapshot and append `Current snapshot ref fallback` when that snapshot has exact visible role/name matches for the failed target. Non-fill matches can include direct `try-current-visible-ref*` next actions. Semantic click misses may also include `Agent-browser candidate fallbacks`; `details.nextActions` first recommends a fresh `snapshot -i` and may include bounded role/name retries such as `button`/`link` for a missed `text` click, each as a `try-*-candidate` entry carrying redacted `find role …` argv.

For desktop or host-controlled rich inputs, treat a semantic `fill` miss differently. If the fresh snapshot finds an exact current editable ref (`searchbox` or `textbox`), `details.richInputRecovery` and visible `Rich input recovery` describe the candidate and append `focus-current-editable-ref*` / `click-current-editable-ref*` next actions. Those actions deliberately do **not** copy the fill text and never press `Enter` or submit. Use the safe ladder instead: refresh refs, choose the current editable `@ref`, focus or click it, then send the intended text with `keyboard inserttext` or `keyboard type` in a separate call. Do not auto-submit unless the user flow explicitly calls for it.

Do not assume Playwright selector dialects such as `text=Close` or `button:has-text('Close')` are supported wrapper syntax. If you need those forms, verify current upstream `agent-browser` behavior first; otherwise use refs, `find`, or known CSS selectors.

Treat `@e…` refs as page-scoped. After a successful `snapshot`, the wrapper records the latest refs and page target for that session; mutation-prone ref commands such as `click @e4`, `select @e5 chocolate`, or batch steps with old refs fail with `failureCategory: "stale-ref"` when the page target changed or the ref is absent from the latest same-page snapshot. If a session `snapshot -i` fails with `No active page`, the wrapper invalidates prior refs for that session; later mutation-prone `@e…` calls fail before upstream until a successful fresh `snapshot -i` records refs again. Inside `batch` stdin JSON, the wrapper also walks steps in order before spawn: steps whose first token can navigate or mutate set a latch; a later step whose first token is `snapshot` clears that latch for following rows; guarded steps that still mention `@e…` after an uncleared latch fail with the same `stale-ref` bucket without launching upstream. Same-snapshot form fills are allowed before a click or submit step, so a login-style `fill`, `fill`, `click` batch can run from one snapshot; split dynamic or autosubmit forms with a fresh snapshot if a fill itself rerenders the targets. Follow the `refresh-interactive-refs` next action (it includes `--session <name>` when needed) and prefer stable `find` or `semanticAction` locators when navigation or rerendering is likely. Contract detail: [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) (`refSnapshot`, `refSnapshotInvalidation`).

A successful `click` result means upstream reported a target, not that the app definitely handled the event. For top-level non-Electron clicks, the wrapper installs a bounded DOM-event probe; when upstream reports success but no trusted event reaches the target, it fails the tool and exposes `details.clickDispatch` plus a `Click dispatch diagnostic` line with explicit retry/inspect next actions (no in-page click replay). When the workflow depends on a mutation, use `details.pageChangeSummary`, a wait, URL/text extraction, or a fresh `snapshot -i` before trusting the state; if nothing changed, retry with a current visible ref or stable selector and report the workflow issue. For static local fixtures or debugging where the user explicitly accepts scripted activation, `eval --stdin` can call `document.querySelector(...).click()` to exercise inline handlers and app code; treat that as an untrusted programmatic event, not as evidence that CDP/user-like clicking works. Preserve explicit user stop boundaries: if the user says to stop before a final order, post, purchase, or submit action, gather evidence from that page and do not click the final action or use scripted activation to bypass the stop. The wrapper also blocks likely final order/submit click targets under those prompts and returns `details.promptGuard` with `failureCategory: "policy-blocked"`.

When a **top-level** `click` succeeds (not a `click` hidden inside a `batch`/`job` tool call—the unified command must be `click`), the upstream payload includes `data.clicked`, no `details.clickDispatch` diagnostic fired for the same result, and the wrapper sees the active tab URL unchanged after the same normalization it uses for ref guards (**`#fragment` ignored**), it may run one extra `snapshot -i` and surface `Possible overlay blockers` plus `details.overlayBlockers` (`candidates`, `summary`, and a `snapshot` map that can refresh `refSnapshot`) when that snapshot shows strong modal context (`dialog` / `alertdialog`) **and** up to three close/dismiss-like controls; page-wide words such as privacy, sign in, or banner alone do not trigger it. The URL check compares the session’s prior pinned tab target to `details.navigationSummary.url` after the click; that summary is gathered with one read-only `eval` when the click JSON omits **both** string `data.url` and `data.title`—if upstream already echoes either field, overlay diagnostics are skipped on this path. The diagnostic is skipped if the wrapper already applied tab-focus correction or about-blank recovery on that result. Appended `inspect-overlay-state` / `try-overlay-blocker-candidate-*` entries in `details.nextActions` include `--session <name>` when the session is named, same as other session-scoped follow-ups. Treat `inspect-overlay-state` as the safe first follow-up; only use a `try-overlay-blocker-candidate-*` next action when the candidate is clearly the control you intend to close.

### Extract page data

```json
{ "args": ["get", "title"] }
{ "args": ["get", "url"] }
{ "args": ["get", "text", "main"] }
{ "args": ["eval", "--stdin"], "stdin": "document.title" }
```

When you already know several visible refs or selectors, extract them in one `batch` call instead of many serial getter calls:

```json
{ "args": ["batch"], "stdin": "[[\"get\",\"text\",\"@e64\"],[\"get\",\"text\",\"@e65\"],[\"get\",\"text\",\"@e66\"]]" }
```

Prefer `get` and scoped `eval --stdin` for read-only extraction. Getter names are grouped under `get`: use `get title`, `get url`, or `get text <selector>`, not shortcut commands such as `title` or `url`. When upstream reports an unknown command, unknown subcommand, or unrecognized command for a single-token shortcut (`attr`, `count`, `html`, `text`, `title`, `url`, or `value`), the wrapper adds a visible grouped-`get` hint; only `title` and `url` also get exact read-only `details.nextActions` (`use-get-title` / `use-get-url`, with `--session` preserved when the failed call named a session). If another `Agent-browser hint:` (selector dialect or stale-ref recovery) was already appended to the same error text, the getter hint is omitted.

Return the intended JavaScript value from `eval --stdin` instead of relying on `console.log`. In the native pi tool, the JavaScript belongs in the top-level `stdin` field; do **not** write it as a third `args` item such as `{ "args": ["eval", "--stdin", "document.title"] }`. The wrapper tolerates that common misplaced form by moving the trailing token to stdin before spawn, but the explicit `stdin` field is the documented form and avoids ambiguity for multiline snippets. For object-shaped extraction, pass a plain expression such as `({ title: document.title, url: location.href })`; if you send a function-shaped snippet, invoke it explicitly, for example `(() => ({ title: document.title }))()`. When upstream serializes a function result to `{}`, the wrapper can append `Eval stdin hint` and `details.evalStdinHint`.

On tabbed or hidden-DOM pages, `get text <selector>` reads the upstream-selected match, which may be hidden even when a later match is visible. For non-`@ref` CSS selectors with multiple matches, including successful `batch` steps, the wrapper may add `Selector text visibility warning`, `details.selectorTextVisibility` (and `details.selectorTextVisibilityAll` for multiple batched warnings), and `inspect-visible-text-candidates` next actions. The warning names the matching `details.nextActions` id so agents know to use a fresher `snapshot -i`, a visible `@ref`, or a more specific selector instead of trusting hidden tab content. If the probe still leaves multiple visible candidates, do not keep reading the broad selector; switch to a current visible `@ref`, add a narrower selector such as a known panel/container id, or use a targeted `eval --stdin` expression that filters for visible elements and returns the intended index/text.

### Run a multi-step flow in one browser invocation

```json
{ "args": ["batch"], "stdin": "[[\"open\",\"https://example.com\"],[\"snapshot\",\"-i\"]]" }
```

Use `batch --bail` when later steps should stop after the first failed command.

For short constrained flows, use top-level `job` instead of hand-writing `batch` stdin. Supported job steps are `open`, `click`, `fill`, `select`, `wait`, `assertText`, `assertUrl`, `waitForDownload`, and `screenshot`; `select` requires `selector` plus `value` or `values`, and compiles to upstream `select <selector> <value...>`. The wrapper compiles steps to upstream `batch` and records `details.compiledJob.steps[]`. There is still no separate first-class catalog of reusable named browser recipes above `job`, the `qa` preset, and raw `batch`; see [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet) for the closed `RQ-0068` decision and revisit bar.

**Job navigation is explicit.** A `click` step (or other navigation-prone interaction) does not prove the next page loaded. The wrapper does not auto-insert `assertUrl` or `assertText` after clicks inside `job`; add those steps yourself with the URL pattern or on-page text you expect, especially after forms, checkout, tabs, or submit buttons, before screenshots or later steps.

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

Navigation-prone flow (open → fill → click → assert destination → screenshot):

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

On app pages that expose a native dropdown, add a `select` step such as `{ "action": "select", "selector": "#flavor", "value": "chocolate" }` before the assertion that depends on it.

Use raw `args: ["batch"]` with `stdin` when you need arbitrary upstream commands, flags, or batch failure policies outside the constrained schema. Do not pass `stdin` with `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron`; those modes generate or manage their own input.

For quick smoke/QA checks, use top-level `qa`. It clears enabled network/console/page-error buffers before opening the target URL, waits for page readiness, checks expected text/selector, inspects fresh network requests, console messages, and page errors, and can capture an evidence screenshot. The readiness wait defaults to `loadState: "domcontentloaded"`; set `loadState` to `"load"` or `"networkidle"` only when that stricter state is useful and the site is not expected to keep background requests alive. QA network diagnostics classify failed requests by likely impact and list failed rows first in the network preview: actionable document/script/API-style failures fail the preset, while common low-impact browser icon misses such as `favicon.ico` are surfaced as warnings (`qaPreset.warnings`) so they do not fail an otherwise healthy page. Successful QA with no failed checks returns compact model-visible prose (page URL/title when known, checks run, optional screenshot verification) while keeping the full step matrix in `details.qaPreset` and `details.batchSteps`. Failed QA presets report `details.resultCategory: "failure"`, `failureCategory: "qa-failure"`, keep verbose per-step batch output, and real Pi sessions treat the diagnostic as a failed tool result. Prose output also gets a model-visible result-category line including `Pi tool isError: true`; caller-requested `--json` output keeps the JSON string parseable and relies on the patched `isError` plus `details` fields.

The same classification drives plain `network requests` presentation: when any row counts as failed (HTTP status ≥ 400, `failed: true`, or a string `error`), model-facing text starts with a line like `Network failure summary: 0 actionable, 1 benign low-impact (1 total).`, and each preview line can end with an impact tag such as `[benign: low-impact browser icon asset]` or `[actionable: document, script, API, or non-benign request failure]`. When safe request IDs are present, `details.nextActions` adds bounded read-only follow-ups such as `network request <id>`, `networkSourceLookup` for actionable failed rows, `network requests --filter <path>`, and `network har start`; prefer those payloads over rebuilding request-id commands from prose. Rules live in `classifyNetworkRequestFailure` / `summarizeNetworkFailures` in `extensions/agent-browser/lib/results/network.ts`; QA aggregation is `analyzeQaPresetResults` in `extensions/agent-browser/index.ts`.

```json
{ "qa": { "url": "https://example.com", "expectedText": "Example Domain", "screenshotPath": ".dogfood/qa-example.png" } }
```

Optional `loadState`, `checkNetwork`, `checkConsole`, and `checkErrors` default to `"domcontentloaded"`, `true`, `true`, and `true`; set a check to `false` to skip that diagnostic. Omit `expectedText` and `expectedSelector` when you only need load plus diagnostics.

For attached Electron or manually connected CDP sessions, use `qa.attached` after the session exists. It does not open a URL and rejects `sessionMode: "fresh"` because it checks the current managed session. Before running diagnostics, the wrapper requires a readable `http:` or `https:` page URL on the attached session; missing URLs, read failures, and non-http(s) surfaces fail fast with recovery `nextActions` such as `tab list` and `snapshot -i` instead of running the full QA batch.

```json
{ "qa": { "attached": true, "expectedText": "Explorer", "screenshotPath": ".dogfood/electron.png" } }
```

Use custom `job` or raw `batch` when you need a different check sequence.

### Electron desktop apps

Full public guide: [`ELECTRON.md`](ELECTRON.md). Use it as the entry point when Electron support is the task; this section keeps the inline workflow snippets for agents reading the broader command surface.

Use top-level `electron` when the wrapper should discover, launch, attach to, probe, and clean up a desktop Electron app. The wrapper owns only launches it created. It uses an isolated temporary `userDataDir`, `--remote-debugging-port=0`, and safe launch defaults; it does **not** reuse the app's normal signed-in profile or attach to an already-running authenticated app. For already-authenticated desktop app content, do not stop at the isolated-launch warning: when host tools are available and the app is not already running, launch the normal app with a debug port (macOS example: `open -a Slack --args --remote-debugging-port=9222 --remote-allow-origins='*'`), verify the port, then attach with `{ "args": ["connect", "9222"], "sessionMode": "fresh" }`; if the app is already running without a debug port, ask before relaunching it. Remote debugging still exposes app content, so use caller-owned `allow` / `deny` lists for sensitive app policies when needed. `electron.list` may annotate common private-data apps as `[likely sensitive: …]`; this is advisory metadata only and does not block `launch` or replace caller policy.

Install scans for `electron.list` (and resolving `appName` / `bundleId` targets) are implemented for **macOS and Linux** hosts only. On **Windows**, `list` returns `platform: "unsupported"` with no apps, so prefer `executablePath` (or a host `appPath` that points at the real Electron `.exe`) when launching there—the wrapper still runs Electron evidence checks on that path before spawn.

Typical lifecycle:

```json
{ "electron": { "action": "list", "query": "code" } }
{ "electron": { "action": "launch", "appName": "Visual Studio Code", "handoff": "snapshot" } }
{ "args": ["snapshot", "-i"] }
{ "electron": { "action": "probe", "timeoutMs": 5000 } }
{ "electron": { "action": "cleanup", "launchId": "electron-…" } }
```

`electron.status` and `electron.cleanup` take either `launchId`, **`all: true`** (literal boolean) to walk every wrapper-tracked launch in one call, or neither when exactly one active launch exists—never both `launchId` and `all`. They can target the current branch-visible launch plus still-owned off-branch launch records by `launchId`; default no-arg calls are intentionally ambiguous when more than one active launch is owned. `/reload` preserves the current branch-visible active Electron launch and its isolated temp `userDataDir` for continuity, and cleans off-branch owned Electron launches; if cleanup is partial and skips or fails profile removal, the generic temp sweep preserves that `userDataDir` across reload, quit, later temp cleanup, process exit, and stale temp-root pruning after restart. For `electron.launch`, `timeoutMs` bounds host CDP readiness with a **15s** default and **120s** cap in `extensions/agent-browser/lib/electron/launch.ts`. Optional `timeoutMs` on **`status`** applies to managed-session `get title` / `get url` reads (localhost CDP probes stay on a short fixed fetch budget). On **`cleanup`**, it caps upstream `close` **and** host teardown (process exit, debug-port idle check, isolated profile removal); when omitted it follows the implicit session close default (**5s** unless `PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS` overrides). A successful managed-session close step retires that wrapper-managed session even when host process/profile cleanup remains partial. On **`probe`**, it bounds each underlying upstream read subprocess—omit it to use the normal tool subprocess default, or raise it on slow desktops.

`launch.handoff` defaults to `"snapshot"`, which attaches through upstream `connect`, lists targets, and captures a current `snapshot -i` in one call. Snapshot handoff retries briefly when the first Electron snapshot has no refs; if it still reports no refs, run `snapshot -i` once more before assuming the app is blank. Use `handoff: "tabs"` as the safer diagnostic starting point when you only need target discovery and do not want to snapshot app content yet, or `handoff: "connect"` when you want to attach first and run your own follow-up commands. `targetType` defaults to `"page"`; use `"webview"` or `"any"` for apps that expose useful webviews. When a matching CDP target exposes a WebSocket URL, launch connects to that target; otherwise it falls back to the browser port.

After launch, prefer the exact `details.nextActions` payloads when present: `status-electron-launch` checks liveness, `probe-electron-launch` runs compact diagnostics for a tracked launch, `snapshot-electron-session` refreshes current refs, `list-electron-tabs` inspects targets, and `cleanup-electron-launch` removes the wrapper-owned process/profile when the run is done. If launch times out, inspect `details.electron.failure.diagnostics` for PID, wrapper profile, `DevToolsActivePort`, and timing evidence before retrying. If status/probe detects a session or target mismatch, follow `reattach-electron-launch` or a fresh snapshot action before using old refs. If a click/fill/type looks successful but the Electron PID or debug port dies, the wrapper now fails the result with `details.electronPostCommandHealth` and same-launch status/probe/cleanup next actions instead of leaving the agent on `about:blank`. If cleanup is partial (`failureCategory: "cleanup-failed"`), inspect `details.electron.cleanup.results` and use `retry-electron-cleanup` only for the same `launchId`.

Manual path for externally launched apps: if you started the Electron app yourself with a debug port or DevTools URL, skip the wrapper lifecycle and attach directly with upstream `connect`. In this path you own app shutdown and profile cleanup; do not use `electron.cleanup`. close commands (`close`, `quit`, or `exit`) only close the browser/CDP session and do not quit the manually launched app or remove explicit artifacts.

```json
{ "args": ["connect", "9222"], "sessionMode": "fresh" }
{ "args": ["tab", "list"] }
{ "args": ["tab", "t2"] }
{ "args": ["snapshot", "-i"] }
```

A successful raw `connect` means the debug endpoint accepted the session, not that the app has an active ready page. Prefer `details.nextActions` when present: `list-connected-session-tabs` runs the session-scoped tab inspection. After that read-only list, select or confirm the stable `t<N>` target and run `snapshot -i` explicitly before trusting refs. If a `snapshot -i` says `No active page`, the wrapper clears any prior refs for that session; follow `list-tabs-after-no-active-page`, select the stable `t<N>` surface, then use a condition wait or retry `snapshot -i` before trusting refs.

For current-session smoke checks after either path, use `qa.attached`; for compact state instead of separate title/url/focus/tab/snapshot calls, use `electron.probe`. `electron.probe.timeoutMs` bounds each underlying read subprocess; `electron.probe.launchId` ties the probe to a wrapper launch and can surface session or target mismatch guidance before you trust page refs. For VS Code-style quick inputs, treat a successful `fill` as tentative: the wrapper may append `details.fillVerification` if `get value` still reads empty or different, and Electron `@e…` mutations can append `refresh-electron-refs-after-rerender` because same-URL UI rerenders commonly churn refs.

For local app debugging, top-level `sourceLookup` can gather candidate component/file locations for a visible element from selector DOM hints, React DevTools inspection, and a bounded workspace component-name search rooted at the Pi session working directory (`maxWorkspaceFiles` defaults to 2000 and cannot exceed 5000; the scan records at most ten `workspace-search` candidates). With a `selector`, the wrapper runs `is visible` and, unless `includeDomHints` is `false`, `get html` so DOM data attributes and embedded source-like paths can become `dom-attribute` candidates. It reports evidence and confidence in `details.sourceLookup` instead of claiming a guaranteed source file. React hints require a session opened with `--enable react-devtools`. The `details.sourceLookup.status` field reads `unsupported` only when no candidates were collected **and** a `react` batch step failed (inspect errors, missing renderer, and similar); it reads `no-candidates` when the batch succeeded but nothing matched. If selector or workspace hints still yield candidates, `status` remains `candidates-found` even when React inspection failed. Unlike `qa`, the wrapper does not downgrade a **fully successful** upstream batch to `isError` solely because those statuses appear—though failed batch steps still produce normal tool errors. For wrapper-tracked packaged Electron sessions with no candidates, `details.sourceLookup.workspaceRoot` and optional `details.sourceLookup.electronContext` explain that the scan only covered the Pi tool cwd; installed app resources or `app.asar` bundles are outside that scan and are not unpacked. Those results may add `snapshot-electron-session`, `probe-electron-launch`, and `list-electron-tabs` next actions so you can inspect the live packaged app before deciding whether to change the workspace or app bundle.

```json
{ "sourceLookup": { "selector": "#save", "reactFiberId": "2", "componentName": "SaveButton" } }
```

Top-level `networkSourceLookup` does the same for failed browser requests. When `requestId` is set it adds `network request <requestId>`; when `filter` or `url` is set it also adds `network requests --filter …`, using `url` as the filter pattern when `filter` is omitted. Add `session` when the generated batch should target an explicit upstream session. With `requestId` only, the compiled batch is just that request step; failed-request detection still walks the returned batch JSON and treats HTTP status ≥ 400, `failed: true`, or an `error` field as failure. When `filter` or `url` is present, the same heuristics apply but requests are correlated only if their URL matches that substring (either direction). Workspace URL literal search under the Pi session cwd reuses the `sourceLookup` scan rules (`maxWorkspaceFiles` defaults to 2000, hard cap 5000, at most ten `workspace-search` rows, up to eight URL/path needles from the query plus failed request URLs). It reports `details.networkSourceLookup.status` as `failed-requests-found`, `no-failed-requests`, or `no-candidates` and never assigns definitive blame. Request-detail URLs are diagnostic evidence, not active-tab evidence: standalone `network request …` and generated `networkSourceLookup` batches preserve the previous app page target and latest same-page `refSnapshot`.

```json
{ "networkSourceLookup": { "requestId": "req-1", "url": "/api/fail" } }
```

### Wait for page readiness or downloads

```json
{ "args": ["wait", "--load", "networkidle"] }
{ "args": ["wait", "--url", "**/dashboard"] }
{ "args": ["wait", "--download", "/tmp/report.pdf"] }
```

Do not omit the load state value; use `wait --load <state>` with `load`, `domcontentloaded`, or `networkidle`.

For desktop-host readiness, prefer condition waits over fixed sleeps. Use this ladder: `wait --text` / `wait --url` / `wait --fn` / `wait --load <state>` / `wait --download` when a real condition exists; after raw `connect`, run `tab list` → `tab t<N>` → condition wait or `snapshot -i`; after wrapper-owned `electron.launch`, use `electron.probe` / `electron.status` for launch health or target mismatch; use `qa.attached` when expected text or selector plus diagnostics can express the check. Fixed waits are a last resort: `wait 30000` is intentionally blocked by the wrapper IPC budget, and a successful fixed-wait payload such as `"waited":"timeout"` means elapsed time only, not proof that the desktop host finished. Verify with an observed condition, fresh snapshot, or screenshot before continuing.

Use `wait --download [path]` after an earlier action has already started a browser download, such as a dashboard export button that responds asynchronously:

```json
{ "args": ["click", "@export"] }
{ "args": ["wait", "--download", "/tmp/report.csv"] }
```

For one-call flows, put the click and wait in `batch`; the wait step keeps the saved-file metadata in `details.batchSteps[n].savedFilePath` and `details.batchSteps[n].savedFile`:

```json
{ "args": ["batch"], "stdin": "[[\"click\",\"@export\"],[\"wait\",\"--download\",\"/tmp/report.csv\"]]" }
```

A successful wait-based download renders a readable summary such as `Download completed: /tmp/report.csv` and exposes top-level `details.savedFilePath` plus `details.savedFile` for non-batch calls. With the current upstream `agent-browser 0.27.1`, `wait --download <path>` may report the requested path before this environment can verify that the file was persisted there. Treat `details.savedFilePath` as upstream-reported metadata unless `details.artifacts[].exists` is true. Upstream tracking: [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300).

### Download, screenshot, and PDF files

```json
{ "args": ["download", "@e5", "/tmp/report.pdf"] }
{ "args": ["screenshot", "/tmp/page.png"] }
{ "args": ["screenshot", "--full", "/tmp/full-page.png"] }
{ "args": ["screenshot", "--annotate", "/tmp/annotated.png"] }
{ "args": ["pdf", "/tmp/page.pdf"] }
```

The upstream screenshot aliases are `screenshot --full` for full-page capture and `screenshot --annotate` for labeled screenshots. When a user gives exact artifact paths for screenshots, recordings, downloads, PDFs, traces, or HAR files, use those paths or explicitly report why the artifact was unavailable; do not silently substitute another path in the final report. When the latest prompt names exact required screenshot paths, `close` / `quit` / `exit` can be blocked with `details.promptGuard.reason: "requested-artifacts-missing-before-close"` until those paths appear as verified explicit artifacts.

Prefer `download <selector> <path>` when the target element itself is the downloadable link/control. Use `click` plus `wait --download [path]` when a previous action starts the download indirectly.

For evidence-only screenshots, QA captures, or audit artifacts, save to an explicit path and branch on `details.artifactVerification` plus `details.artifacts` before reporting PASS/FAIL. Inline image attachments are optional convenience when size limits allow; do not require vision review unless the user asked for visual inspection.

Wrapper result rendering is metadata-first for saved files:
- screenshots return a saved-path summary, visible artifact metadata, structured `details.artifacts` metadata, and an inline image attachment when safe; the visible block includes artifact type, requested path, absolute path, existence, size, cwd, session, and repair/copy status when applicable
- downloads, PDFs, `wait --download` files, `state save` state files, diff screenshot output images, traces, CPU profiles, completed WebM recordings from `record stop`, and path-bearing HAR captures return concise saved-path summaries plus structured `details.artifacts` metadata without inlining large files
- `record start <path>` reports that recording started and that output will be written on `record stop`; the target file may not exist until recording stops, and upstream needs `ffmpeg` on `PATH` at stop time to encode the WebM. If `ffmpeg` is missing after a successful `record start` / `record restart`, the wrapper appends `Recording dependency warning: ffmpeg not found on PATH` and sets `details.recordingDependencyWarning` without blocking the upstream command.
- `batch` keeps each step's artifacts in `details.batchSteps[].artifacts` and aggregates them in top-level `details.artifacts` in step order

`diff screenshot` follows the file-artifact path above for the **diff** image: model-visible text and `details.artifacts` focus on that output, while baseline paths stay out of the artifact summary block, and Pi does **not** auto-inline the diff the way it inlines trusted `screenshot` captures. `state load` may print the loaded path in prose but does not add a saved-file artifact entry the way `state save` does.

For screenshot paths under dot-directories such as `.dogfood/run/foo.png`, the wrapper normalizes the requested path to an absolute path before invoking upstream `agent-browser`, verifies the requested file exists, and repairs from an upstream temp screenshot when possible. The requested path remains visible as `Requested path`, while `Absolute path` shows the actual on-disk location.

For annotated screenshots in `batch`, put `--annotate` in top-level args instead of inside the screenshot step:

```json
{ "args": ["--annotate", "batch"], "stdin": "[[\"screenshot\",\"/tmp/page.png\"]]" }
```

#### Artifact retention and dogfood-heavy QA runs

The wrapper keeps a bounded, metadata-only `details.artifactManifest` of recent artifacts so long sessions do not grow unbounded. The default recent window is 100 entries and can be raised for screenshot/video-heavy QA sessions with `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES=<count>`.

This manifest cap controls what appears in `details.artifactManifest` and in summaries such as `Session artifacts: 42 live, 0 evicted (42/100 recent)`. It does not delete explicit files that upstream saved to paths you chose, such as screenshots, PDFs, downloads, traces, HAR files, or WebM recordings.

Browser close commands (`close`, `quit`, or `exit`) are also not file cleanup. If `details.artifactManifest` is present with a non-empty `entries` list, a successful close command appends an `Artifact lifecycle` note and reports `details.artifactCleanup` with the current retention summary and the same host-owned cleanup `note` as the contract (`extensions/agent-browser/lib/orchestration/browser-run/diagnostics.ts`, `getArtifactCleanupGuidance`). Up to ten distinct user-chosen paths that still exist on disk appear in `explicitArtifactPaths` when matching `explicit-path` manifest rows exist in the recent window; deleted/stale paths are skipped. Otherwise that array is empty and visible text may omit the “Explicit artifact paths” line even though the lifecycle block still reminds you that close commands do not delete saved files. Delete any paths you care about with host file tools after inspection; the native browser tool intentionally does not remove arbitrary user-chosen filesystem paths.

Oversized snapshots and oversized generic outputs are different: when a persisted pi session is available, their wrapper-managed spill files are stored under the private session artifact directory and are governed by the byte budget `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB). Raise that byte budget as well for long QA sessions that need many full raw snapshots or large text spills to survive reload/resume.

### Switch from an already-active implicit session to a fresh profiled or alternate-browser launch

```json
{
  "args": ["--profile", "Profile 1", "open", "https://mail.google.com"],
  "sessionMode": "fresh"
}
```

```json
{
  "args": ["--executable-path", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "open", "https://mail.google.com"],
  "sessionMode": "fresh"
}
```

`profiles` lists Chrome profile directory names from Chrome's user data directory; `Default` is common but not guaranteed. When profile resolution fails, use `agent_browser` diagnostics first: run `{ "args": ["profiles"] }` and `{ "args": ["doctor"] }`, then tell the user which profile name/path or browser executable setting to configure before retrying. For non-Chrome Chromium browsers, pass `--executable-path <path>` to the browser binary and use a full profile/user-data directory path only when upstream accepts that path.

### Recover tabs when focus lands somewhere unexpected

```json
{ "args": ["tab", "list"] }
{ "args": ["tab", "t2"] }
{ "args": ["snapshot", "-i"] }
```

Use `tab list` and `tab <tab-id-or-label>` when a profile restore, pop-up, or click opens or focuses the wrong tab. Generic tab-drift recovery lists tabs first; run `snapshot -i` only after selecting or confirming the intended stable target. When the wrapper already knows the target, `details.nextActions` may include recovery actions that list tabs, select the intended tab, and refresh refs in the right session.

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

### Use stateful browser-context commands safely

Stateful commands are native `agent_browser` calls, not shell commands. Keep secrets out of `args` whenever upstream supports stdin, and expect model-facing summaries to redact auth, cookie, password, secret, session, and token-like values.

```json
{ "args": ["auth", "save", "demo", "--password-stdin"], "stdin": "password from the user-approved secret source" }
{ "args": ["auth", "login", "demo"] }
{ "args": ["state", "save", "/tmp/demo-state.json"] }
{ "args": ["state", "load", "/tmp/demo-state.json"], "sessionMode": "fresh" }
{ "args": ["cookies", "set", "theme", "dark", "--url", "https://example.com"] }
{ "args": ["storage", "local", "get", "theme"] }
{ "args": ["dialog", "status"] }
{ "args": ["dialog", "accept", "prompt text"] }
{ "args": ["frame", "main"] }
```

Operational notes:

- Visible page content from real authenticated profiles is still model-visible and may persist in transcripts or saved artifacts. The wrapper redacts credential-like cookie/storage/auth data, not the ordinary page text you asked it to read.
- `stdin` is accepted only for `batch`, `eval --stdin`, and `auth save --password-stdin`; other stdin-bearing calls are rejected before launch.
- `auth list/show/save/login/delete` summaries avoid expanding profile secrets. Prefer `auth save --password-stdin` over `--password <value>`.
- `state save <path>` is a verified file-artifact workflow; inspect `details.artifactVerification` before relying on the file. `state load <path>` is not treated as a newly saved artifact.
- `cookies get` can expose real authenticated-profile cookies; prefer task-specific page actions and only inspect cookies when the user needs cookie data.
- `storage local|session` summaries redact sensitive keys and values; still avoid broad storage dumps unless necessary.
- `dialog accept/dismiss/status`, `frame <selector|main>`, and guarded-action `confirm <id>` / `deny <id>` pass through the native tool. Prefer `details.nextActions` for exact confirmation recovery payloads.
- `batch` mirrors the same redaction on every step: top-level `details.data` is a compact `{ success, command, result?, error? }[]` matrix (argv-redacted `command`, stateful `result`, scrubbed `error` text). Use `details.batchSteps[]` when you need per-step artifacts, categories, spill paths, or full structured errors beyond the roll-up.

## Full supported surface

The tables below intentionally list more than the recommended workflow. Rare commands are included so agents can discover that the installed upstream supports them without direct `agent-browser --help` access.

### Built-in skills

Native-tool note: upstream skills are written for the standalone `agent-browser` CLI and may show bash/heredoc examples. In pi, convert those examples to `agent_browser` calls: pass CLI tokens in `args`, and pass heredoc/stdin bodies through the tool `stdin` field for `batch`, `eval --stdin`, or `auth save --password-stdin`.

Session note: `skills list`, `skills get …`, and `skills path …` are **stateless** in this wrapper. Even with default `sessionMode: "auto"`, the extension does not prepend the implicit managed `--session` for those commands, so reading bundled skills does not attach to or rotate the active browser session (same intent as plain-text `--help` / `--version` inspection). Other `skills` subcommands follow normal session rules until explicitly allowlisted in `extensions/agent-browser/lib/runtime.ts` alongside regression coverage in `test/agent-browser.runtime.test.ts`.

| Command | Purpose |
| --- | --- |
| `skills list` | List available CLI-bundled skills. |
| `skills get core` | Print the core usage guide. |
| `skills get core --full` | Print the full version-matched core command reference and templates. |
| `skills get <name>` | Load a specialized skill such as `electron` or `slack`. Common specialized calls include `skills get electron`, `skills get slack`, `skills get dogfood`, `skills get vercel-sandbox`, and `skills get agentcore`. |
| `skills get <name> --full` | Include a skill's supplementary references/templates when present. |
| `skills get --all` | Print all visible bundled skills for broad audit/debug work. |
| `skills path [name]` | Print a skill directory path. |

Skill-source debugging note: upstream honors `AGENT_BROWSER_SKILLS_DIR` as an override for bundled skill discovery. Normal agents should not need it, but it is useful when validating package layout or upstream skill packaging.

### Core page and element commands

| Command | Purpose |
| --- | --- |
| `open [url]` | Launch the browser and optionally navigate. URL-less `open` stays on `about:blank` so agents can stage routes, cookies, or init scripts before first navigation. |
| `open <url>` | Navigate to a URL; `goto <url>` and `navigate <url>` are equivalent navigation aliases when a URL is present. |
| `click <sel>` | Click an element or `@ref`. |
| `click <sel> --new-tab` | Click a link/control while requesting a new tab. |
| `dblclick <sel>` | Double-click an element. |
| `type <sel> <text>` | Type into an element. |
| `fill <sel> <text>` | Clear and fill an element. |
| `press <key>` | Press a key such as `Enter`, `Tab`, or `Control+a`. `key <key>` is the upstream alias. |
| `key <key>` | Alias for `press <key>`. |
| `keydown <key>` | Hold a key down without releasing it, useful for modifiers. |
| `keyup <key>` | Release a key previously held by `keydown <key>`. Common modifier examples are `keydown Shift` and `keyup Shift`. |
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
| `scroll <dir> [px] --selector <sel>` | Scroll a specific scrollable element/container instead of the page. |
| `scrollintoview <sel>` | Scroll an element into view; `scrollinto <sel>` is the upstream alias. |
| `scrollinto <sel>` | Alias for `scrollintoview <sel>`. |
| `wait <sel|ms>` | Wait for an element or a duration. |
| `screenshot [selector] [path]` | Take a full-page or element-scoped screenshot; a single selector-like argument scopes, while a path-like argument saves to that path. |
| `screenshot [path]` | Take a screenshot and optionally save it to a path. |
| `pdf <path>` | Save the page as a PDF. |
| `snapshot` | Print an accessibility tree with refs for AI interaction. Common options include `snapshot --interactive`, `snapshot --urls`, `snapshot --compact`, `snapshot --depth <n>`, `snapshot --selector <sel>`, and `snapshot --cursor` / `snapshot -C` for cursor/focus context when upstream returns it. |
| `eval <js>` | Run JavaScript. Use `eval --stdin` through this wrapper for larger snippets, or `eval -b <base64>` for shell-escaping-safe one-liners. |
| `connect <port|url>` | Connect to a browser through CDP. |
| `close [--all]` | Close the current browser or all sessions; `quit` and `exit` are upstream close aliases. |
| `tap <selector>` | Touch-oriented tap alias for iOS/provider workflows. |
| `swipe <direction> [distance]` | Touch-oriented swipe for iOS/provider workflows. |

On dashboards and other apps with nested scroll containers, `scroll <dir> [px]` may report a successful wheel action while the viewport appears unchanged because the page-level scroller was not the one containing the content. For top-level `scroll` calls without startup-scoped launch flags, the wrapper samples viewport and prominent scroll-container positions before and after the command; when nothing changes it appends `Scroll diagnostic: no observed scroll movement`, exposes `details.scrollNoop`, and adds exact `details.nextActions` for a fresh `snapshot -i` and screenshot. Use those before repeating page scrolls; when you need a specific panel, prefer `scrollintoview <@ref>` or a scoped interaction with the actual scrollable region.

Comboboxes vary by app. For native `<select>` controls, prefer raw `select <selector> <value...>`, `semanticAction: { action: "select", selector, value|values }`, or a `job` `select` step instead of clicking option refs; native option refs can be non-boxed in CDP and fail before a real selection. A `click` or `semanticAction` role/name click may focus a searchable custom combobox without opening its option list. For explicit combobox-targeted actions such as `semanticAction` role `combobox`, the wrapper checks whether a combobox-like element is focused, has explicit `aria-expanded` state, and has no visible listbox/options open; this still applies when the semantic action first resolves to a current visible `@ref` before execution. When that happens it appends `Combobox diagnostic: focused combobox did not expose visible options`, exposes `details.comboboxFocus`, and adds exact `details.nextActions` for a fresh `snapshot -i`, `press ArrowDown`, and `press Enter`. Use those instead of assuming click alone expanded the control; reserve visible option refs for custom comboboxes after a fresh snapshot shows the intended option.

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
| `state list` | List saved state files. |
| `state show <filename>` | Show saved-state metadata without dumping secrets. |
| `state rename <old-name> <new-name>` | Rename a saved state file. |
| `state clear [session-name] [--all]` | Clear saved states for one name or all names; `state clear -a` is the upstream short alias for clearing all names. |
| `state clean --older-than <days>` | Delete expired saved-state files. |
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

These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, auto-connect, or provider-backed launches.
<!-- agent-browser-playbook:end inspection -->

### Page state, finding, mouse, settings, network, and storage

| Family | Surface |
| --- | --- |
| `get <what> [selector]` | `text`, `html`, `value`, `attr <name>`, `title`, `url`, `count`, `get box <selector>`, `get styles <selector>`, and `get cdp-url`. |
| `is <what> <selector>` | Check `visible`, `enabled`, or `checked`. |
| `find <locator> <value> <action> [text]` | Locator types include `role`, `text`, `label`, `placeholder`, `alt`, `title`, and `testid`; selector helpers include `find first <sel>`, `find last <sel>`, and `find nth <n> <sel>`. Role/text filters include `find role <role> --name <name>` and `find ... --exact`. |
| `mouse <action> [args]` | `move <x> <y>`, `down [btn]`, `up [btn]`, `wheel <dy> [dx]`. |
| `set <setting> [value]` | `viewport <w> <h>`, `device <name>`, `geo <lat> <lng>`, `offline [on|off]`, `headers <json>`, `credentials <user> <pass>`, and `set media <features>` (`dark`, `light`, and/or `reduced-motion`). |
| `network <action>` | `network route <url> [--abort|--body <json>] [--resource-type <csv>]`, `network unroute [url]`, `network requests [--clear] [--filter <pattern>] [--type <csv>] [--method <method>] [--status <code|range>]`, `network request <requestId>`, `network har start`, and `network har stop [path]`. `--resource-type` filters intercepted requests by CDP resource type, such as `script`, `image`, `font`, `xhr`, or `fetch`; request listing filters accept resource types (`xhr,fetch`), methods (`POST`), and statuses (`2xx`, `400-499`). |
| `cookies [get|set|clear]` | Manage cookies. Full set form: `cookies set <name> <value> --url <url> --domain <domain> --path <path> --httpOnly --secure --sameSite <Strict|Lax|None> --expires <timestamp>`; also supports `cookies set --curl <file>` for JSON, cURL, or bare Cookie-header bulk imports. |
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
| `tab close [t<N>|label]` | Close the current tab or a referenced tab. Generic references in workflows may say `tab close [target]`; use a stable `t<N>` id or label when you have one. |

### Snapshot

| Option | Purpose |
| --- | --- |
| `snapshot` | Full accessibility tree with refs. |
| `snapshot -i` / `snapshot --interactive` | Include only interactive elements. |
| `snapshot -i --urls` | Include only interactive elements and link hrefs. |
| `snapshot -u` / `snapshot --urls` | Include href URLs for link elements. |
| `snapshot -C` / `snapshot --cursor` | Include cursor/focus context when upstream provides it. |
| `snapshot -c` / `snapshot --compact` | Remove empty structural elements. |
| `snapshot -d <n>` / `snapshot --depth <n>` | Limit tree depth. |
| `snapshot -s <sel>` / `snapshot --selector <sel>` | Scope to a CSS selector. |

When a snapshot is too large for inline output, the Pi wrapper renders a compact view before spilling the full raw snapshot to `details.fullOutputPath`. Compact snapshots are main-content-first, but dense pages and desktop host screens can still hide actionable controls in omitted content; scan `Omitted high-value controls` before opening the spill file. That bounded section favors editable/searchbox/textbox/combobox controls, named tab/surface controls, and primary action buttons, then includes other useful controls such as checkboxes, radios, options, and menuitems that were not already listed under key refs or other refs. When that section appears, `details.data.highValueControlRefIds` repeats the same visible ref ids for programmatic follow-up alongside fields such as `previewMode`, `previewSections`, and counts on `details.data` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details)).

### Wait

| Mode | Purpose |
| --- | --- |
| `wait <selector>` | Wait for an element to appear. |
| `wait <ms>` | Wait for a fixed number of milliseconds. In the native Pi wrapper, keep each fixed wait at `25000` ms or less and split longer waits into multiple tool calls. |
| `wait --url <pattern>` | Wait for the URL to match a pattern. |
| `wait --load <state>` | Wait for load state: `load`, `domcontentloaded`, or `networkidle`. |
| `wait --fn <expression>` | Wait for a JavaScript expression to become truthy. |
| `wait --text <text>` | Wait for text to appear on the page; failures may include `inspect-after-text-assertion-failure` with a session-scoped `snapshot -i` payload. |
| `wait --download [path]` | Wait for a download started by a previous action and optionally save it to `path`; successful wrapper results include upstream-reported `savedFilePath`/`savedFile`, while `details.artifacts[].exists` is the wrapper's on-disk verification signal. |
| `wait --download [path] --timeout <ms>` | Set download-start timeout in milliseconds. In the native Pi wrapper, use `25000` ms or less per call to stay under the upstream CLI IPC budget. |

Current v0.27.1 source does not parse `wait <selector> --state hidden` / `wait <selector> --state detached` as distinct wait modes even though upstream help mentions those examples. Use `wait --fn "!document.querySelector('#spinner')"` or another explicit JavaScript predicate for disappearance/detach checks until upstream parser support exists.

### Diff, debug, and streaming

| Command | Purpose |
| --- | --- |
| `diff snapshot` | Compare current versus last snapshot. Use `diff snapshot --baseline <file> --selector <sel> --compact --depth <n>` when you need a saved baseline, scoped subtree, compact output, or depth bound. |
| `diff screenshot --baseline` | Compare current screenshot versus a baseline image. Use `diff screenshot --baseline <file> --output <file> --threshold <0-1> --selector <sel> --full` when you need a saved diff image, threshold tuning, element scope, or full-page capture. |
| `diff url <u1> <u2>` | Compare two pages. Use `diff url <u1> <u2> --screenshot --wait-until <strategy> --selector <sel> --compact --depth <n>` when you need screenshot comparison, navigation wait control, or scoped/compact snapshot comparison. |
| `trace start`, `trace stop [path]` | Record a Chrome DevTools trace. |
| `profiler start|stop [path]` | Record a Chrome DevTools profile. |
| `record start <path> [url]` | Start WebM video recording; output is written on `record stop`. Requires `ffmpeg` on `PATH` for the final encode. |
| `record stop` | Stop and save video. If this fails with `ffmpeg not found`, install `ffmpeg` / `ffmpeg-full` and rerun the recording. |
| `record restart <path> [url]` | Stop any current recording and start a new WebM recording. |
| `console [--clear]` | View or clear console logs. |
| `errors [--clear]` | View or clear page errors. |
| `highlight <sel>` | Highlight an element. |
| `inspect` | Open Chrome DevTools for the active page. |
| `clipboard <op> [text]` | Read/write clipboard: `clipboard read`, `clipboard write <text>`, `clipboard copy`, and `clipboard paste`. |
| `stream enable [--port <n>]` | Start runtime WebSocket streaming for this session. |
| `stream disable` | Stop runtime WebSocket streaming. |
| `stream status` | Show streaming status and active port. |
| `react tree` | Print the full React component tree. Requires the page to have been launched with `--enable react-devtools`. |
| `react inspect <id>` | Inspect one React fiber's props, hooks, state, and source. |
| `react renders start` | Start recording React render activity. |
| `react renders stop [--json]` | Stop render recording and print mount/re-render counts and changed details. |
| `react suspense [--only-dynamic] [--json]` | Classify Suspense boundaries with grouped root-cause recommendations. |
| `vitals [url] [--json]` | Report Core Web Vitals: LCP, CLS, TTFB, FCP, INP, plus React hydration timing when available. `web-vitals [url] [--json]` is the upstream alias. |
| `pushstate <url>` | Perform SPA client-side navigation; detects Next.js router pushes and falls back to history navigation events. |
| `removeinitscript <id>` | Remove an init script registered through upstream init-script mechanisms. |

When these diagnostic commands are invoked through the native `agent_browser` tool, structured console, page-error, React, Web Vitals, and SPA outputs render as compact summaries when possible, with large outputs previewed and spilled instead of dumped into context. Large outputs are previewed with a `Full output path:` spill file instead of dumping the entire payload into context. Artifact-producing commands such as `network har stop`, `diff screenshot`, `trace stop`, `profiler stop`, and `record stop` report `details.artifacts[]` plus `details.artifactVerification`; `record start` is reported as pending until `record stop` completes. For video workflows, keep `ffmpeg` on `PATH` first; on macOS with Homebrew, `brew install ffmpeg` or `brew install ffmpeg-full` is sufficient. Successful `record start` / `record restart` results warn early with `details.recordingDependencyWarning` when the wrapper cannot find `ffmpeg`, so fix PATH before `record stop` instead of discovering the missing encoder after the capture. The README install section keeps the concise external-dependency list for maximal extension use.

Long-running or lifecycle commands should be explicitly paired with cleanup calls: `stream enable` → `stream disable`, `dashboard start` → `dashboard stop`, `trace start` → `trace stop`, `profiler start` → `profiler stop`, and `record start` → `record stop`. The wrapper keeps each subprocess bounded by its normal timeout; it does not keep an interactive `chat` REPL open, so prefer `chat <message>` with `--model` or `AI_GATEWAY_MODEL` for single-shot AI use.

`trace` and `profiler` share upstream Chrome tracing machinery. Do not run them at the same time. The wrapper tracks owner state it observes in the current Pi session and blocks conflicting starts/stops with "wrapper believes ..." wording because direct upstream CLI use or browser restarts can desynchronize wrapper-local state.

### Batch, auth, confirmations, sessions, chat, dashboard, devices, and setup

| Command | Purpose |
| --- | --- |
| `batch [--bail] ["cmd" ...]` | Execute multiple commands sequentially from args or stdin. |
| `auth save <name> [opts]` | Save an auth profile. Full credential form: `auth save <name> --url <url> --username <user> --password <pass>`; selector override form: `auth save <name> --username-selector <s> --password-selector <s> --submit-selector <s>`. Prefer `auth save <name> --password-stdin` with the tool `stdin` field; avoid putting passwords in `args`. |
| `auth login <name>` | Login using saved credentials. |
| `auth list` | List saved auth profiles. |
| `auth show <name>` | Show auth profile metadata. |
| `auth delete <name>` | Delete an auth profile; `auth remove <name>` is the upstream alias. |
| `confirm <id>` | Approve a pending action. |
| `deny <id>` | Deny a pending action. |
| `session` | Show current session name. |
| `session list` | List active sessions. |
| `chat <message>` | Send a natural-language instruction. |
| `chat` | Start interactive chat when stdin is a TTY. |
| `dashboard [start]` | Start the dashboard server on the default port `4848`. |
| `dashboard start --port <n>` | Start the dashboard on a specific port. |
| `dashboard stop` | Stop the dashboard server. |
| `device list` | List available iOS simulators. Use with `-p ios` when exercising iOS provider flows. |
| `install` | Install browser binaries. |
| `install --with-deps` | Install browser binaries plus Linux system dependencies. |
| `upgrade` | Upgrade `agent-browser` to the latest version. |
| `doctor [--fix]` | Diagnose install issues and optionally auto-clean stale files. Use `doctor --offline --quick` for a fast local-only check and `doctor --json` for structured output. |
| `profiles` | List available Chrome profiles. |

When these commands are invoked through the native `agent_browser` tool, structured diagnostic/status outputs are rendered as compact summaries. Local inspection/setup calls (`auth save/list/show/delete/remove`, `dashboard start/stop`, `device list`, `doctor`, `install`, `upgrade`, `profiles`, `session list`, `state list/show/rename`, `state clean --older-than <days>`, `state clear --all`, `state clear -a`, and `state clear <session-name>`) are sessionless unless you explicitly pass `--session`; context-dependent calls such as root `session`, untargeted `state clear`, `auth login`, `chat`, and `state save/load` keep normal session behavior. List-like outputs such as sessions, Chrome profiles, auth profiles, network requests, console messages, and page errors include counts and key fields; large outputs are previewed with a `Full output path:` spill file instead of dumping the entire payload into context. For `network requests`, the wrapper shows a failed-request summary split into actionable versus benign low-impact rows, then status, method, URL, resource/mime type, request id, and, when the installed upstream output includes body-like fields, bounded redacted payload, response, and failure/error snippets. Safe request IDs also produce `details.nextActions` for exact request details, actionable failed-request source lookup candidates, filtered request lists, or starting HAR capture before a repro. `network request <requestId>` can expose upstream full-detail body fields such as response bodies using the same bounded model-facing preview; its request URL stays diagnostic-only and does not overwrite `details.sessionTabTarget` for later ref guards. Header, cookie, auth, token, and other secret-like fields are not expanded in model-facing text or `details.data`; command echoes also redact `--body`, `--headers`, `--password`, proxy credentials, auth-bearing URLs, cookie/storage values, and bearer/basic credential text in positional arguments. Use upstream HAR or full raw details only when complete data is required.

## Optional package config and companion web search

`pi-agent-browser-native` has package-owned config under Pi-scoped paths. This is separate from upstream `agent-browser` config and from Pi package settings:

- global: `~/.pi/config/pi-agent-browser-native/config.json`
- project-local: `.pi/config/pi-agent-browser-native/config.json`
- explicit override: `PI_AGENT_BROWSER_CONFIG=/path/to/config.json`

Get an Exa API key from the [Exa dashboard](https://dashboard.exa.ai/api-keys) or a Brave Search API key from the [Brave Search API dashboard](https://api-dashboard.search.brave.com/). If both keys are available, `agent_browser_web_search` prefers Exa by default because its `/search` endpoint returns token-efficient highlights and agent-oriented search modes; set `webSearch.preferredProvider` to `"brave"` when Brave Search is preferred. You can also disable this package's search tool with `webSearch.enabled: false` when another search tool should win.

`pi install npm:pi-agent-browser-native` loads the extension, but it does **not** usually put the package helper on your shell `PATH`. The clearest setup is to write the config file directly and keep actual keys in the environment that launches `pi`:

```bash
mkdir -p ~/.pi/config/pi-agent-browser-native
cat > ~/.pi/config/pi-agent-browser-native/config.json <<'JSON'
{
  "version": 1,
  "webSearch": {
    "enabled": true,
    "preferredProvider": "exa",
    "exaApiKey": "$EXA_API_KEY",
    "braveApiKey": "$BRAVE_API_KEY"
  }
}
JSON
```

If you prefer the helper, run it through npm unless you know `pi-agent-browser-config` is already on your `PATH`:

```bash
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config paths
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config show
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env EXA_API_KEY --global
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env BRAVE_API_KEY --global
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env EXA_API_KEY --project
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search prefer brave --global
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search disable --global
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-command "op read 'op://Private/Brave Search/API Key'" --provider brave --global
printf '%s' "$EXA_API_KEY" | npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-key --provider exa --stdin
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile set "Profile 1" --policy authenticated-only
npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable set "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
```

The optional `agent_browser_web_search` tool is registered only when Exa or Brave credentials are available and `webSearch.enabled` is not false. It is a separate custom tool, not an `agent_browser` input mode, and does not launch a browser. Use it when current/live external web information would help; use `agent_browser` for browser interaction, screenshots, authenticated/profile pages, and DOM inspection. Project-local plaintext, custom env aliases, interpolation-literal, malformed, and command-backed web-search keys are refused; project config may only use the matching provider env refs (`$EXA_API_KEY` / `${EXA_API_KEY}` for Exa and `$BRAVE_API_KEY` / `${BRAVE_API_KEY}` for Brave). `web-search set-key`, `set-command`, and `clear` require `--provider`; `set-env` infers Exa/Brave from `EXA_API_KEY` or `BRAVE_API_KEY` unless you pass `--provider`. For Exa, the tool defaults to `searchType: "auto"` with `contents.highlights: true`; use `fast`, `instant`, `deep-lite`, `deep`, or `deep-reasoning` only when the task needs that latency/depth tradeoff.

Example config:

```json
{
  "version": 1,
  "webSearch": {
    "enabled": true,
    "preferredProvider": "exa",
    "exaApiKey": "$EXA_API_KEY",
    "braveApiKey": "$BRAVE_API_KEY"
  },
  "browser": {
    "defaultProfile": {
      "name": "Profile 1",
      "policy": "authenticated-only"
    },
    "executablePath": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}
```

Browser default config is conservative: it adds agent guidance for signed-in/account-specific tasks and alternate Chromium-compatible executables; current releases do not auto-inject `--profile` or `--executable-path` for every launch. Configure profile/executable guidance globally or through `PI_AGENT_BROWSER_CONFIG`; project-local browser config is not trusted to steer host executable/profile prompt guidance. Ask the agent to run `profiles` and `doctor` when profile resolution fails, then use the reported Chrome profile directory name, a full profile/user-data directory path if upstream accepts one, or the configured `browser.executablePath` with top-level `sessionMode: "fresh"`.

## Important global flags, config, and environment

### Authentication and session flags

- `--profile <name|path>`: reuse Chrome profile login state by directory name from `profiles`, or use a persistent custom profile/profile-directory path when upstream accepts it. Environment: `AGENT_BROWSER_PROFILE`.
- `--session <name>`: use an isolated session. Environment: `AGENT_BROWSER_SESSION`.
- `--session-name <name>`: auto-save/restore cookies and local storage by name. Environment: `AGENT_BROWSER_SESSION_NAME`.
- `--state <path>`: load saved auth state from JSON. Environment: `AGENT_BROWSER_STATE`.
- `--auto-connect`: connect to a running Chrome to reuse auth state. Environment: `AGENT_BROWSER_AUTO_CONNECT`.
- `--headers <json>`: apply HTTP headers scoped to the opened URL's origin.
- `--init-script <path>`: register a script before first navigation; repeatable. Environment: `AGENT_BROWSER_INIT_SCRIPTS`.
- `--enable <feature>`: enable built-in init scripts such as `react-devtools`; repeatable or comma-separated. Environment: `AGENT_BROWSER_ENABLE`.

### Browser launch and runtime flags

- `--executable-path <path>`: custom Chromium-compatible browser executable, such as Brave/Edge/Arc/Vivaldi when upstream can launch that binary. Environment: `AGENT_BROWSER_EXECUTABLE_PATH`.
- `--extension <path>`: load browser extensions; repeatable. Environment: `AGENT_BROWSER_EXTENSIONS`.
- `--args <args>`: browser launch args, comma or newline separated. Environment: `AGENT_BROWSER_ARGS`.
- `--user-agent <ua>`: custom user agent. Environment: `AGENT_BROWSER_USER_AGENT`.
- `--proxy <server>`: proxy server URL. Environments: `AGENT_BROWSER_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`.
- `--proxy-bypass <hosts>`: proxy bypass hosts. Environments: `AGENT_BROWSER_PROXY_BYPASS`, `NO_PROXY`.
- `--ignore-https-errors`: ignore HTTPS certificate errors. Environment: `AGENT_BROWSER_IGNORE_HTTPS_ERRORS`.
- `--allow-file-access`: allow `file://` URLs to access local files. Environment: `AGENT_BROWSER_ALLOW_FILE_ACCESS`.
- `--headed`: ask upstream to show the browser window. Environment: `AGENT_BROWSER_HEADED`. Use it on the first launch, normally with `sessionMode: "fresh"` when changing an existing managed session; verify visibility with screenshot/tab evidence because the wrapper cannot yet prove the OS window is visible to the user.
- `--cdp <port>`: connect through Chrome DevTools Protocol.
- `--color-scheme <scheme>`: `dark`, `light`, or `no-preference`. Environment: `AGENT_BROWSER_COLOR_SCHEME`.
- `--download-path <path>`: default browser download directory. Environment: `AGENT_BROWSER_DOWNLOAD_PATH`.
- `--engine <name>`: browser engine, `chrome` by default or `lightpanda`. Environment: `AGENT_BROWSER_ENGINE`.
- `--no-auto-dialog`: disable automatic dismissal of alert/beforeunload dialogs. Environment: `AGENT_BROWSER_NO_AUTO_DIALOG`.
- `--idle-timeout <ms>`: close idle sessions after the requested idle window when upstream owns that session lifecycle. The wrapper also sets `AGENT_BROWSER_IDLE_TIMEOUT_MS` for its managed-session backstop.

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
- Provider-specific iOS examples from upstream include `agent-browser -p ios device list`, `agent-browser -p ios swipe up`, and `agent-browser -p ios tap @e1`; in pi, pass those tokens through `args` rather than bash. iOS requires external Xcode/Appium setup, and cloud providers (`browserbase`, `kernel`, `browseruse`, `browserless`, `agentcore`) require their upstream accounts, credentials, and provider-specific environment variables. Common forwarded provider variables include `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSERLESS_API_KEY`, `BROWSERLESS_API_URL`, `BROWSERLESS_BROWSER_TYPE`, `BROWSERLESS_STEALTH`, `BROWSERLESS_TTL`, `BROWSER_USE_API_KEY`, `KERNEL_API_KEY`, `KERNEL_HEADLESS`, `KERNEL_STEALTH`, `KERNEL_TIMEOUT_SECONDS`, `KERNEL_PROFILE_NAME`, `AGENTCORE_API_KEY`, `AGENTCORE_REGION`, `AGENTCORE_BROWSER_ID`, `AGENTCORE_PROFILE_ID`, `AGENTCORE_SESSION_TIMEOUT`, plus AWS names used by AgentCore such as `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. The wrapper forwards provider flags/env and stays thin; it does not emulate provider setup or cloud browser behavior.
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

Other useful environment variables include `AGENT_BROWSER_DEFAULT_TIMEOUT`, `AGENT_BROWSER_STREAM_PORT`, `AGENT_BROWSER_IDLE_TIMEOUT_MS`, `AGENT_BROWSER_ENCRYPTION_KEY`, `AGENT_BROWSER_STATE_EXPIRE_DAYS`, `AGENT_BROWSER_IOS_DEVICE`, `AGENT_BROWSER_IOS_UDID`, `AI_GATEWAY_URL`, `AI_GATEWAY_API_KEY`, the provider credential names listed above, and AWS credential names when using AgentCore. The upstream child also receives every parent variable whose name starts with `AGENT_BROWSER_`, `AGENTCORE_`, `AI_GATEWAY_`, `BROWSERBASE_`, `BROWSERLESS_`, `BROWSER_USE_`, `KERNEL_`, or `XDG_`, plus the explicit inherited-name allowlist in `buildAgentBrowserProcessEnv` (`extensions/agent-browser/lib/process.ts`).

## Wrapper-specific behavior worth knowing

- The extension may keep following one implicit managed session across later tool calls.
- If launch-scoped flags like `--profile`, `--executable-path`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `--provider` / `-p`, or provider device flags like `--device` would be ignored because that implicit session is already active, retry with `sessionMode: "fresh"`.
- If a `sessionMode: "fresh"` call fails (including upstream failure, timeout, missing binary, or **`qa`** reclassification after a nominally successful batch), read `details.managedSessionOutcome` before assuming where the next default call will go: `preserved` means the prior managed session remains current, while `abandoned` means no managed session became current. When the failure reason is not the fresh launch itself—for example `failureCategory: "qa-failure"`—`status`/`summary` may still describe the managed-session transition while `succeeded` on this object matches the final tool outcome.
<!-- agent-browser-playbook:start wrapper-tab-recovery -->
<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->
- After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.
- After the wrapper observes tab-drift risk for a session (for example profile restore correction, overlapping stale opens, or resumed session state), later active-tab commands best-effort pin that tab inside the same upstream invocation. Routine same-session commands are not preflighted with tab list just because a target tab is known.
- For sessions with observed tab-drift risk, after a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes. Routine same-session commands skip this post-command tab-list probe.
- If a known session target unexpectedly reports about:blank, agent_browser best-effort re-selects the prior intended target when it still exists; if recovery fails, it records the observed about:blank target and reports exact recovery guidance instead of treating the prior page as active.
<!-- agent-browser-playbook:end wrapper-tab-recovery -->
- Wrapper-spawned commands clamp `AGENT_BROWSER_DEFAULT_TIMEOUT` to 25 seconds and use a 28-second child-process watchdog (`PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS` overrides the default 28s budget) so one upstream CLI call does not cross the upstream 30-second IPC read-timeout/retry path. When that watchdog fires, `details.timeoutPartialProgress` may include a planned step list for compiled `job` / `qa` plans or caller `batch` stdin, current page title/URL from best-effort session `get url` / `get title` (or a planned URL inferred from the step list when the session cannot answer), and declared artifact paths such as `screenshot`, `pdf`, `download`, or `wait --download` outputs with existence/size checks; the same evidence is appended under `Timeout partial progress` in visible text with URL/path redaction.
- Oversized snapshots and oversized generic outputs may be compacted in tool content, with the full raw output written to a spill file path shown directly in the tool result. Recent artifact metadata is bounded by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES` (default 100); persisted spill files are separately bounded by `PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES` (default 32 MiB).
- The wrapper keeps `--help` and `--version` stateless so they do not consume the implicit managed-session slot.

## Generated capability baseline

<!-- agent-browser-capability-baseline:start capability-token-baseline -->
<!-- Generated from scripts/agent-browser-capability-baseline.mjs. Run `npm run docs -- command-reference write` to update. Do not edit manually. -->
<details>
<summary>Generated verifier capability baseline for agent-browser 0.27.1</summary>

This generated block is review data for maintainers. The human-authored reference sections above remain the readable command guide.

#### Source evidence
- repository: `vercel-labs/agent-browser`
- upstream HEAD: `90050f2913159875e2c3719e424746396ccb3cbf`
- upstream package version: `0.27.1`
- inspected: `agent-browser --version`
- inspected: `agent-browser --help`
- inspected: `selected agent-browser <command> --help output`
- inspected: `README.md`
- inspected: `CHANGELOG.md`
- inspected: `agent-browser.schema.json`
- inspected: `cli/src/commands.rs`
- inspected: `cli/src/flags.rs`

#### Upstream help commands sampled
- root help: `agent-browser --help`
- skills help: `agent-browser skills --help`
- skills list: `agent-browser skills list`
- core skill full: `agent-browser skills get core --full`
- open help: `agent-browser open --help`
- click help: `agent-browser click --help`
- key help: `agent-browser key --help`
- scroll help: `agent-browser scroll --help`
- scrollinto help: `agent-browser scrollinto --help`
- keydown help: `agent-browser keydown --help`
- keyup help: `agent-browser keyup --help`
- get help: `agent-browser get --help`
- is help: `agent-browser is --help`
- mouse help: `agent-browser mouse --help`
- set help: `agent-browser set --help`
- tab help: `agent-browser tab --help`
- snapshot help: `agent-browser snapshot --help`
- eval help: `agent-browser eval --help`
- wait help: `agent-browser wait --help`
- screenshot help: `agent-browser screenshot --help`
- pdf help: `agent-browser pdf --help`
- close help: `agent-browser close --help`
- find help: `agent-browser find --help`
- network help: `agent-browser network --help`
- cookies help: `agent-browser cookies --help`
- storage help: `agent-browser storage --help`
- state help: `agent-browser state --help`
- session help: `agent-browser session --help`
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
- console help: `agent-browser console --help`
- errors help: `agent-browser errors --help`
- clipboard help: `agent-browser clipboard --help`
- tap help: `agent-browser tap --help`
- swipe help: `agent-browser swipe --help`
- device help: `agent-browser device --help`
- install help: `agent-browser install --help`
- upgrade help: `agent-browser upgrade --help`
- profiles help: `agent-browser profiles --help`

#### Inventory sections
- Built-in skills: 13 human-doc token(s), 13 upstream token(s)
- Core page, element, navigation, and extraction commands: 74 human-doc token(s), 74 upstream token(s)
- Sessions, state, tabs, frames, dialogs, and windows: 20 human-doc token(s), 16 upstream token(s)
- Network, storage, artifacts, diagnostics, and performance: 43 human-doc token(s), 53 upstream token(s)
- Batch, auth, confirmations, setup, dashboard, devices, and AI commands: 24 human-doc token(s), 24 upstream token(s)
- Global flags, config, providers, policy, and environment: 117 human-doc token(s), 90 upstream token(s)

#### Human-authored doc tokens required
##### Built-in skills
- `skills list`
- `skills get core`
- `skills get core --full`
- `skills get <name>`
- `skills get <name> --full`
- `skills get --all`
- `skills get electron`
- `skills get slack`
- `skills get dogfood`
- `skills get vercel-sandbox`
- `skills get agentcore`
- `skills path [name]`
- `AGENT_BROWSER_SKILLS_DIR`

##### Core page, element, navigation, and extraction commands
- `open [url]`
- `open <url>`
- `goto <url>`
- `navigate <url>`
- `click <sel>`
- `click <sel> --new-tab`
- `dblclick <sel>`
- `type <sel> <text>`
- `fill <sel> <text>`
- `press <key>`
- `key <key>`
- `keydown <key>`
- `keyup <key>`
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
- `scroll <dir> [px] --selector <sel>`
- `scrollintoview <sel>`
- `scrollinto <sel>`
- `wait <sel|ms>`
- `wait --url <pattern>`
- `wait --load <state>`
- `wait --fn <expression>`
- `wait --text <text>`
- `wait --download [path]`
- `screenshot [selector] [path]`
- `screenshot [path]`
- `screenshot --full`
- `screenshot --annotate`
- `pdf <path>`
- `snapshot`
- `snapshot --cursor`
- `snapshot --interactive`
- `snapshot --urls`
- `snapshot --compact`
- `snapshot --depth <n>`
- `snapshot --selector <sel>`
- `eval <js>`
- `eval --stdin`
- `eval -b <base64>`
- `connect <port|url>`
- `close [--all]`
- `quit`
- `exit`
- `back`
- `forward`
- `reload`
- `pushstate <url>`
- `get <what> [selector]`
- `get cdp-url`
- `get box <selector>`
- `get styles <selector>`
- `is <what> <selector>`
- `find <locator> <value> <action>`
- `find first <sel>`
- `find last <sel>`
- `find nth <n> <sel>`
- `find role <role> --name <name>`
- `find ... --exact`
- `mouse <action> [args]`
- `set <setting> [value]`
- `set media <features>`
- `tap <selector>`
- `swipe <direction> [distance]`

##### Sessions, state, tabs, frames, dialogs, and windows
- `session`
- `session list`
- `state save <path>`
- `state load <path>`
- `state list`
- `state show <filename>`
- `state rename <old-name> <new-name>`
- `state clear [session-name] [--all]`
- `state clear -a`
- `state clean --older-than <days>`
- `tab list`
- `tab new [url]`
- `tab new --label <name> [url]`
- `tab close [target]`
- `tab <t<N>|label>`
- `frame <selector|main>`
- `dialog accept [text]`
- `dialog dismiss`
- `dialog status`
- `window new`

##### Network, storage, artifacts, diagnostics, and performance
- `network <action>`
- `network route <url> [--abort|--body <json>] [--resource-type <csv>]`
- `network unroute [url]`
- `network requests [--clear] [--filter <pattern>] [--type <csv>] [--method <method>] [--status <code|range>]`
- `network request <requestId>`
- `network har start`
- `network har stop [path]`
- `cookies [get|set|clear]`
- `cookies set <name> <value> --url <url> --domain <domain> --path <path> --httpOnly --secure --sameSite <Strict|Lax|None> --expires <timestamp>`
- `cookies set --curl <file>`
- `storage <local|session>`
- `diff snapshot`
- `diff snapshot --baseline <file> --selector <sel> --compact --depth <n>`
- `diff screenshot --baseline`
- `diff screenshot --baseline <file> --output <file> --threshold <0-1> --selector <sel> --full`
- `diff url <u1> <u2>`
- `diff url <u1> <u2> --screenshot --wait-until <strategy> --selector <sel> --compact --depth <n>`
- `trace start`
- `trace stop [path]`
- `profiler start|stop [path]`
- `record start <path> [url]`
- `record restart <path> [url]`
- `record stop`
- `console [--clear]`
- `errors [--clear]`
- `highlight <sel>`
- `inspect`
- `clipboard <op> [text]`
- `clipboard read`
- `clipboard write <text>`
- `clipboard copy`
- `clipboard paste`
- `stream enable [--port <n>]`
- `stream disable`
- `stream status`
- `react tree`
- `react inspect <id>`
- `react renders start`
- `react renders stop [--json]`
- `react suspense [--only-dynamic] [--json]`
- `vitals [url] [--json]`
- `web-vitals [url] [--json]`
- `removeinitscript <id>`

##### Batch, auth, confirmations, setup, dashboard, devices, and AI commands
- `batch [--bail]`
- `auth save <name>`
- `auth save <name> --url <url> --username <user> --password <pass>`
- `auth save <name> --username-selector <s> --password-selector <s> --submit-selector <s>`
- `auth save <name> --password-stdin`
- `auth login <name>`
- `auth list`
- `auth show <name>`
- `auth delete <name>`
- `auth remove <name>`
- `confirm <id>`
- `deny <id>`
- `chat <message>`
- `dashboard [start]`
- `dashboard start --port <n>`
- `dashboard stop`
- `device list`
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
- `--idle-timeout <ms>`
- `AGENT_BROWSER_STREAM_PORT`
- `AGENT_BROWSER_IDLE_TIMEOUT_MS`
- `AGENT_BROWSER_ENCRYPTION_KEY`
- `AGENT_BROWSER_STATE_EXPIRE_DAYS`
- `AGENT_BROWSER_IOS_UDID`
- `AI_GATEWAY_URL`
- `AI_GATEWAY_API_KEY`
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`
- `BROWSERLESS_API_KEY`
- `BROWSERLESS_API_URL`
- `BROWSERLESS_BROWSER_TYPE`
- `BROWSERLESS_STEALTH`
- `BROWSERLESS_TTL`
- `BROWSER_USE_API_KEY`
- `KERNEL_API_KEY`
- `KERNEL_HEADLESS`
- `KERNEL_STEALTH`
- `KERNEL_TIMEOUT_SECONDS`
- `KERNEL_PROFILE_NAME`
- `AGENTCORE_API_KEY`
- `AGENTCORE_REGION`
- `AGENTCORE_BROWSER_ID`
- `AGENTCORE_PROFILE_ID`
- `AGENTCORE_SESSION_TIMEOUT`
- `AWS_PROFILE`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

#### Upstream help tokens expected
##### Built-in skills
- root help: `skills get core --full`
- skills help: `get <name> --full`
- skills help: `get --all`
- skills help: `AGENT_BROWSER_SKILLS_DIR`
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
- open help: `open [url]`
- open help: `aliases still require a URL.`
- root help: `open <url>`
- root help: `click <sel>`
- click help: `--new-tab`
- root help: `dblclick <sel>`
- root help: `type <sel> <text>`
- root help: `fill <sel> <text>`
- root help: `press <key>`
- key help: `Aliases: key`
- keydown help: `keydown <key>`
- keyup help: `keyup <key>`
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
- scroll help: `--selector <sel>`
- root help: `scrollintoview <sel>`
- scrollinto help: `Aliases: scrollinto`
- root help: `wait <sel|ms>`
- wait help: `--url <pattern>`
- wait help: `--load <state>`
- wait help: `--fn <expression>`
- wait help: `--text <text>`
- wait help: `--download [path]`
- root help: `screenshot [path]`
- screenshot help: `screenshot [selector] [path]`
- root help: `pdf <path>`
- pdf help: `Save page as PDF`
- root help: `snapshot`
- snapshot help: `--interactive`
- snapshot help: `--urls`
- snapshot help: `--compact`
- snapshot help: `--depth <n>`
- snapshot help: `--selector <sel>`
- root help: `eval <js>`
- eval help: `--stdin`
- eval help: `-b, --base64`
- root help: `connect <port|url>`
- root help: `close [--all]`
- close help: `Aliases: quit, exit`
- root help: `back`
- root help: `forward`
- root help: `reload`
- root help: `pushstate <url>`
- root help: `Get Info:  agent-browser get <what> [selector]`
- get help: `box <selector>`
- get help: `styles <selector>`
- get help: `cdp-url`
- root help: `Check State:  agent-browser is <what> <selector>`
- root help: `Find Elements:  agent-browser find <locator> <value> <action> [text]`
- find help: `first <selector>`
- find help: `last <selector>`
- find help: `nth <index> <selector>`
- find help: `--name <name>`
- find help: `--exact`
- root help: `Mouse:  agent-browser mouse <action> [args]`
- root help: `Browser Settings:  agent-browser set <setting> [value]`
- set help: `media [dark|light]`
- keyboard help: `type <text>`
- keyboard help: `inserttext <text>`
- screenshot help: `--full, -f`
- screenshot help: `--annotate`
- find help: `role <role>`
- find help: `testid <id>`
- tap help: `tap <selector>`
- swipe help: `swipe <direction> [distance]`

##### Sessions, state, tabs, frames, dialogs, and windows
- root help: `session list`
- state help: `save <path>`
- state help: `load <path>`
- state help: `list`
- state help: `show <filename>`
- state help: `rename <old-name> <new-name>`
- state help: `clear [session-name] [--all]`
- state help: `agent-browser state clear --all`
- state help: `clean --older-than <days>`
- tab help: `new [url]`
- tab help: `new --label <name> [url]`
- tab help: `close [t<N>|label]`
- tab help: `Stable tab ids`
- frame help: `frame <selector|main>`
- dialog help: `dialog <accept|dismiss|status> [text]`
- window help: `window <operation>`

##### Network, storage, artifacts, diagnostics, and performance
- root help: `network <action>`
- root help: `--resource-type <csv>`
- network help: `unroute [url]`
- network help: `network har start`
- network help: `network har stop ./capture.har`
- root help: `cookies [get|set|clear]`
- root help: `cookies set --curl <file>`
- root help: `storage <local|session>`
- root help: `diff snapshot`
- root help: `diff screenshot --baseline`
- root help: `trace start`
- root help: `trace stop [path]`
- root help: `profiler start|stop [path]`
- root help: `record start <path> [url]`
- root help: `record stop`
- root help: `console [--clear]`
- root help: `errors [--clear]`
- root help: `highlight <sel>`
- root help: `inspect`
- root help: `clipboard <op> [text]`
- clipboard help: `read`
- clipboard help: `write <text>`
- clipboard help: `copy`
- clipboard help: `paste`
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
- network help: `requests [options]`
- network help: `--type <types>`
- network help: `--method <method>`
- network help: `--status <code>`
- network help: `request <requestId>`
- network help: `har <start|stop>`
- storage help: `set <key> <value>`
- diff help: `diff snapshot [options]`
- diff help: `--baseline <f>`
- diff help: `--output <file>`
- diff help: `--threshold <0-1>`
- diff help: `--wait-until <strategy>`
- diff help: `diff screenshot --baseline <f>`
- trace help: `trace start`
- trace help: `trace stop [path]`
- profiler help: `--categories <list>`
- record help: `record restart <path.webm> [url]`
- console help: `--clear`
- errors help: `--clear`

##### Batch, auth, confirmations, setup, dashboard, devices, and AI commands
- root help: `batch [--bail]`
- root help: `auth save <name>`
- root help: `auth login <name>`
- root help: `confirm <id>`
- root help: `deny <id>`
- root help: `chat <message>`
- root help: `dashboard start --port <n>`
- device help: `device list`
- root help: `install --with-deps`
- root help: `upgrade`
- root help: `doctor [--fix]`
- root help: `profiles`
- batch help: `--bail`
- auth help: `--url <url>`
- auth help: `--username <user>`
- auth help: `--password <pass>`
- auth help: `--password-stdin`
- auth help: `--username-selector <s>`
- auth help: `--password-selector <s>`
- auth help: `--submit-selector <s>`
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
