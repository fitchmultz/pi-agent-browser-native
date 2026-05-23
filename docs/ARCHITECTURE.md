# Architecture

Related docs:
- [`../README.md`](../README.md)
- [`../AGENTS.md`](../AGENTS.md) (maintainer workflows, including upstream capability baseline)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ELECTRON.md`](ELECTRON.md)

## Decision

Build this as a **thin `pi` extension/package** that exposes `agent-browser` as one native tool while keeping upstream `agent-browser` as the source of truth.

The package install path is the primary product path. Local checkout development should use explicit CLI loading for isolated smoke tests and configured-source plain `pi` runs for lifecycle validation, while package-manifest behavior and packaged contents matter more.

## Chosen shape

### One primary tool

V1 should expose one native tool:

- `agent_browser`

Why:
- lowest maintenance cost
- lowest drift risk as upstream changes
- preserves full upstream power
- avoids overengineering

### Direct subprocess execution

The extension should:
- resolve `agent-browser` from `PATH`
- invoke it directly, not through a shell
- inject `--json`
- complete each upstream invocation when the direct `agent-browser` child exits even if Node delays `"close"`: piped stdio can stay referenced by longer-lived descendant processes, so `runAgentBrowserProcess` destroys streams on `exit`, watches `exit` and `close` together, applies a short post-`exit` grace before resolving, and prefers `close` codes then wrapper timeout (`124`) over signal-shaped `exit` codes (`watchSpawnedChildCompletion` / `resolveSpawnedChildExitCode` in `extensions/agent-browser/lib/process.ts`) so the tool cannot hang after the CLI process has already terminated
- support optional stdin only for `eval --stdin`, `batch`, `auth save --password-stdin`, and wrapper-generated `batch` stdin from top-level `job`, `qa`, `sourceLookup`, or `networkSourceLookup`, rejecting other command/stdin combinations before launch; top-level `electron` never accepts caller `stdin` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron))
- accept an optional native `semanticAction` object as a mutually exclusive alternative to `args` on a single tool call (and to `job`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron` on the same call), compile locator actions into upstream `find` argv and native dropdown selection into upstream `select <selector> <value...>` argv (with optional `semanticAction.session` expanding to a leading `--session <name>` before the compiled command when targeting a named upstream browser instead of the managed default), and echo the compiled shape in `details.compiledSemanticAction` for observability (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction))
- accept an optional native `job` object (mutually exclusive with `args`, `semanticAction`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron` on the same call) with a small fixed step vocabulary that compiles only to existing upstream `batch` argv rows, generates the JSON batch stdin string internally, and echoes `details.compiledJob` for observability (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#job))
- accept an optional native `qa` object (mutually exclusive with `args`, `semanticAction`, `job`, `sourceLookup`, `networkSourceLookup`, and `electron` on the same call) that compiles to the same `batch` path as `job`, runs a fixed diagnostic smoke sequence, and echoes `details.compiledQaPreset` plus structured `details.qaPreset` pass/fail evidence (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#qa))
- accept an optional native `sourceLookup` object (mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `networkSourceLookup`, and `electron` on the same call) that compiles to the same `batch` path, gathers evidence-backed local source *candidates* for a selector/fiber/component name, and echoes `details.compiledSourceLookup` plus structured `details.sourceLookup` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#sourcelookup)); unlike `qa`, it never applies a second pass/fail layer that marks the tool failed when upstream already reported batch success—failed upstream steps still fail the invocation normally, and `details.sourceLookup` may still be present for partial evidence
- accept an optional native `networkSourceLookup` object (mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `electron` on the same call) that compiles to the same `batch` path, correlates failed network requests with initiator metadata and bounded workspace URL literals, and echoes `details.compiledNetworkSourceLookup` plus structured `details.networkSourceLookup` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#networksourcelookup)); like `sourceLookup`, it never flips a successful upstream batch to failed solely because no source candidates were found
- accept an optional native `electron` object (mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `networkSourceLookup` on the same call) for bounded desktop Electron lifecycle: `list` scans the host for install candidates, `launch` creates a wrapper-owned isolated profile plus OS-chosen remote-debugging port, then attaches through upstream `connect` with `sessionMode: "fresh"`, and `status` / `cleanup` / `probe` operate only on wrapper-tracked launches; host-side spawn and CDP discovery live in `extensions/agent-browser/lib/electron/discovery.ts`, `launch.ts`, and `cleanup.ts`, while compilation, transcript restore for `launchId` records, handoff probes, and merged `details.electron*` fields live in `extensions/agent-browser/index.ts` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron))
- when a compiled `find` semantic action fails as `stale-ref`, optionally append a `retry-semantic-action-after-stale-ref` entry to `details.nextActions` after the usual `refresh-interactive-refs` snapshot step so agents can re-issue the same compiled `find` argv only when the failure implies the interaction did not run; `select` shorthands with stale `@refs` get refresh guidance only (contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction))
- when the same compiled path fails as `selector-not-found` for the bounded locator/action pairs documented there, optionally append `try-*-candidate` entries to `details.nextActions` and mirror them in visible text as `Agent-browser candidate fallbacks` so agents can retry role/name `find` variants without hand-rebuilding argv (`select` misses are intentionally excluded)

### Agent-first UX

The primary UX is the agent calling the tool directly.

That means:
- no command-heavy slash-command interface
- no manual user orchestration as the main workflow
- any future slash commands should be minimal and secondary

### No reusable recipe layer yet

Do **not** add reusable browser recipes as a first-class runtime surface yet.

Current evidence does not justify another source of truth for workflows:
- the deterministic efficiency benchmark in [`scripts/agent-browser-efficiency-benchmark.mjs`](../scripts/agent-browser-efficiency-benchmark.mjs) models one native `job` scenario (`job-open-assert-screenshot`), one `qa` preset (`qa-open-diagnostics`), one `sourceLookup` (`source-lookup-visible-element`), one `networkSourceLookup` (`network-source-lookup-failed-request`), plus deterministic `electron` lifecycle/probe scenarios (`electron-lifecycle`, `electron-probe`) rather than repeated named job patterns that agents keep re-specifying
- repo-local dogfood evidence does not show repeated project-specific job recipes that need versioning or ownership
- `qa` already covers the only repeated smoke-test shape with a stable top-level preset
- docs and prompt guidance can carry examples without adding recipe state, migration rules, or another schema

Revisit this only when benchmark or dogfood data shows at least two repeated, failure-prone job sequences that cannot be represented clearly by `job`, `qa`, top-level `electron`, or raw `batch`. If that happens, define ownership, versioning, schema boundaries, generated docs, and tests before adding executable recipes.

### Package layout versus local checkout development

The published package should load from the `pi` manifest in `package.json`.

Local checkout validation has two intentional modes:

- **Quick isolated mode:** use explicit CLI loading such as `pi --no-extensions -e .` from the repository root. This bypasses Pi settings and extension discovery, avoids duplicate `agent_browser` registrations when another source is installed globally, and is the right mode for checkout smoke tests.
- **Configured-source lifecycle mode:** configure exactly one active checkout or package source in Pi settings and launch plain `pi`. This is the right mode for validating `/reload`, restart, and `/resume` behavior because those lifecycle checks exercise discovered/configured resources. Before shipping, maintainers also run `npm run verify -- lifecycle` (same semantics under automation) plus the live-site checks in [`RELEASE.md`](RELEASE.md#pre-release-checks); `npm publish` enforces `npm run verify -- release` via `prepublishOnly` unless scripts are skipped.

The repo should not add a repo-local `.pi/extensions/` autoload shim as the documented checkout path.

Why:
- avoids duplicate `agent_browser` registrations when the package is also installed globally
- keeps the product contract centered on the package manifest instead of repo-local autoload wiring
- keeps reload and resume validation tied to Pi's configured-source lifecycle instead of an isolated quick-test path
- keeps the published tarball focused on the package manifest, extension code, canonical docs, and license

The published package should exclude agent-only and superseded repo materials such as `AGENTS.md`, `docs/v1-tool-contract.md`, `docs/native-integration-design.md`, and other internal planning notes.

## Session model

### Default

If the caller does not provide `--session`, the extension should default to `sessionMode: "auto"` and use an implicit session name derived from the current `pi` session id plus a hash of the absolute cwd.

Why:
- works out of the box
- gives continuity across calls
- avoids forcing the agent to invent session names for basic browsing

### Explicit upstream sessions and fresh launches

If the caller provides `--session`, `--profile`, `--cdp`, or similar upstream flags, the extension should respect them with minimal interference.

The tool should also expose a first-class `sessionMode: "fresh"` escape hatch so agents can intentionally rotate the extension-managed session to a fresh upstream launch without inventing a fixed explicit session name.

### Ownership

V1 ownership rule:
- implicit auto-generated sessions are extension-managed convenience sessions
- unnamed `sessionMode: "fresh"` launches rotate that extension-managed session to a new upstream browser
- explicit/user-managed sessions are not auto-managed by default
- extension-managed sessions should be reusable during an active `pi` session and across `/reload` / `/resume`, while still being cleaned up predictably

Practical policy:
- preserve the current extension-managed session across `/reload` and resumable session transitions so persisted sessions can keep following the live browser after `/reload` or `/resume`
- close the active extension-managed session when the originating `pi` process quits, while leaving explicit caller-provided sessions alone
- set an idle timeout on extension-managed sessions as a backstop for abnormal exits or cleanup failures
- clean up process-private temp spill artifacts on shutdown, but keep persisted-session snapshot spill files in a private session-scoped artifact directory with a bounded per-session budget so `details.fullOutputPath` stays usable after reload/resume without unbounded growth
- keep explicit screenshots, downloads, PDFs, traces, HAR captures, and recordings written to caller-chosen paths on disk after a successful upstream `close`; when the bounded `details.artifactManifest` has entries, successful `close` also surfaces `details.artifactCleanup` and an `Artifact lifecycle` note (including up to ten distinct `explicit-path` manifest paths when present) so operators remove files with normal host tools—the native tool does not delete arbitrary user paths (`extensions/agent-browser/index.ts`, `getArtifactCleanupGuidance`); contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details), checklist `RQ-0079` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- reconstruct the current extension-managed session from persisted tool details on resume/reload so later default calls keep following the active managed browser
- if an unnamed fresh launch replaces an active extension-managed session, best-effort close the old managed session after the switch succeeds
- leave explicit caller-provided `--session` choices alone unless the caller closes them explicitly
- after profiled `open` / `goto` / `navigate` calls, verify the active tab still matches the returned page URL and best-effort switch back when restored profile tabs steal focus
- once the wrapper observes tab-drift risk for a session (profile restore correction, overlapping stale opens, or restored session state), later active-tab commands may synthesize a tiny upstream `batch` that re-selects that tab and then runs the requested command in the same upstream invocation; routine same-session commands avoid `tab list` preflights to reduce probes that can perturb upstream click behavior
- for sessions with observed tab-drift risk, after a successful command on a known tab target, the wrapper may best-effort restore that same target again if restored/background tabs steal focus after the command returns; routine same-session commands skip this post-command `tab list` probe
- keep a per-session `refSnapshot` aligned with the last successful `snapshot` (including refs merged from a successful `batch` by taking the last successful `snapshot` step in batch result order): restore it from persisted tool `details` when reloading or resuming, drop it on successful `close`, and refuse mutation-prone `@e…` argv before spawn when the active tab URL no longer matches the snapshot URL, when a ref id was never in that snapshot, or when `batch` stdin would reuse `@e…` on a guarded step after an earlier invalidating step without a later `snapshot` step in the same stdin array. Same-snapshot `fill @e…` rows are guarded but do not themselves set that invalidation latch, so ordinary form fills can precede a click/submit row in one batch—see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) for the agent-visible contract and failure text
- after successful `get text` on a non-ref CSS selector, optionally issue one read-only `eval --stdin` probe per qualifying selector when multiple DOM matches or a hidden first match with visible peers could misread tabbed or off-screen content; merge `details.selectorTextVisibility` / `selectorTextVisibilityAll`, visible warning lines, and `inspect-visible-text-candidates*` next actions as documented in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) and `RQ-0074` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- for local Unix launches, set a short private socket directory so extension-generated session names do not fail on the upstream Unix socket-path length limit
- keep wrapper-spawned upstream CLI calls inside the upstream IPC budget by clamping `AGENT_BROWSER_DEFAULT_TIMEOUT` to 25 seconds and stopping a stuck child process before the upstream 30-second read-timeout retry loop begins

This is primarily about ownership clarity and avoiding surprise, not adding a heavy safety wrapper. If the extension invented the session, the extension should own its lifecycle without breaking reload/resume semantics. If the caller explicitly chose the upstream session model, the extension should stay out of the way.

### Launch flags

`agent-browser` startup flags are sticky once a session is already running.
The extension should surface that clearly and avoid hidden restart behavior in v1.

That means explicit startup-scoping flags like `--profile`, `--session-name`, `--cdp`, `--state`, `--auto-connect`, `--init-script`, `--enable`, `-p` / `--provider`, and iOS `--device` should remain explicit upstream choices instead of being wrapped in extra hidden restart or cloning logic.

The wrapper may still apply narrow compatibility normalizations when observed behavior justifies them and the result remains thin, local, and opt-out. For example, if a specific site starts rejecting the default local headless Chrome user agent while the same flow works with a normal Chrome UA, the extension may inject a domain-specific fallback UA only when the caller did not already choose `--user-agent`, `--headed`, `--cdp`, `--auto-connect`, or a provider-backed launch.

If the implicit session is already active and one of those startup-scoped flags appears again while `sessionMode` is still `"auto"`, the extension should fail clearly instead of silently sending a command shape that upstream would ignore.

That failure should include a structured recovery hint pointing to `sessionMode: "fresh"` as the first-line fix, while still allowing an explicit `--session` when the caller wants to name the new upstream session.

Implementation detail lives in `extensions/agent-browser/lib/runtime.ts` (`findCommandStartIndex`, `VALUE_FLAGS`, `getStartupScopedFlags`, `buildExecutionPlan`):

- **Command discovery:** Leading argv is scanned with a value-taking allowlist so tokens such as `--timeout` on `wait`, `--resource-type` on `network route`, or `--curl` / `--domain` on `cookies set` consume their values before the upstream command word is identified. When upstream adds new global flags that take values ahead of the command, extend that allowlist; otherwise the wrapper can mis-classify the command or mis-validate value flags. A smaller set of global boolean flags may be followed by an optional `true`/`false` literal; when present, that literal is consumed as the flag value before command discovery continues.
- **`--state` disambiguation:** Persisted browser `--state` before the command participates in launch-scoped validation and tab-correction hints. The same flag spelling after a `wait` command (for example `wait @ref --state hidden`) is a wait predicate, not a launch flag, and is excluded from startup-scoped detection so it does not spuriously require `sessionMode: "fresh"` while an implicit session is active.
- **`--auto-connect`:** Treated as launch-scoped only when enabled (`--auto-connect` bare or `true`). `--auto-connect false` is ignored for startup-scoped blocking so disabled attach hints do not force a fresh launch.

**Stateless inspection and read-only skills:** Plain-text global help and version probes (`--help`, `-h`, `--version`, `-V`) must never allocate or bind the extension-managed session. The same session-ownership rules apply to read-only upstream `skills list`, `skills get …`, and `skills path …`: those calls still run with `--json` for machine-readable output, but the planner treats them like other stateless inspection work so an agent can load bundled skill text without pinning a browser session or consuming the implicit session slot before a real `open`. Planning and allowlisting live in `extensions/agent-browser/lib/runtime.ts` (`isPlainTextInspectionArgs`, `isStatelessInspectionCommand`, `buildExecutionPlan`).

A successful unnamed `sessionMode: "fresh"` launch should become the new extension-managed session so later default calls follow that browser instead of silently snapping back to the older managed session.

When a managed implicit or fresh `--session` plan reaches process execution, `details.managedSessionOutcome` summarizes the managed-session transition: on **success**, statuses such as `created`, `replaced`, `unchanged`, or `closed` describe what became current (including successful `close`); on **failure** (launch error, timeout, missing binary, **`qa`** reclassification after a nominally successful batch, failed `close`, and similar), `preserved` vs `abandoned` captures whether a prior managed session stayed current or no managed session ended up active, plus related names and booleans. Failing calls that used `sessionMode: "fresh"` also append a short `Managed session outcome: …` line to model-visible text so the next default `sessionMode: "auto"` hop is obvious; `"auto"` failures may still populate the struct without that extra line. Implementation and field semantics live in `extensions/agent-browser/index.ts` (`buildManagedSessionOutcome`, `formatManagedSessionOutcomeText`); agent contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); checklist row `RQ-0077` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

## Preferring the native tool

Keep the handling simple:
- prefer the native tool through extension guidance and tool-call guards
- do not rely on package skill overrides as the primary solution

This keeps the product centered on native tool usage instead of auxiliary skill wiring.

## Responsibility split

### `pi-agent-browser-native` owns

- tool registration and schema (including the optional `semanticAction` compilation path to upstream `find` or `select`)
- subprocess execution and JSON parsing through a filtered child environment (`buildAgentBrowserProcessEnv` in `extensions/agent-browser/lib/process.ts`): copies an allowlisted inherited-name set plus every parent `AGENT_BROWSER_*` variable and provider-related prefixes (`AGENTCORE_*`, `AI_GATEWAY_*`, `BROWSERBASE_*`, `BROWSERLESS_*`, `BROWSER_USE_*`, `KERNEL_*`, `XDG_*`) instead of cloning the full parent process environment
- clear missing-binary errors
- compact result summaries, including presentation-time redaction: stateful browser-context commands (`auth`, `cookies`, `storage`, `dialog`, `frame`, `state`) use field-aware value redaction and compact formatters, while other structured upstream JSON (for example `network`, `diff`, `trace` / `profiler` / `record`, `console` / `errors` / `highlight` / `inspect` / `clipboard`, `stream`, `dashboard`, and `chat`) is passed through `redactPresentationData` in `extensions/agent-browser/lib/results/presentation.ts` so model-facing `details.data` and batch roll-ups stay compact and do not echo bearer tokens, proxy passwords, or similar fields verbatim; `redactInvocationArgs` in `extensions/agent-browser/lib/runtime.ts` masks trailing values for sensitive global flags such as `--body`, `--headers`, `--password`, and `--proxy`, preserves positional rules for `cookies set` and `storage local|session set`, and nested `batch` steps use the same argv and error-body scrubbing before echoing commands or errors
- bounded machine-readable outcome metadata on tool `details` (`resultCategory`, `successCategory`, `failureCategory`, optional `nextActions`, optional `pageChangeSummary` with per-step summaries on `batch`, optional `artifactVerification` with the same shape on each successful `batchSteps[]` row) so agents can branch without parsing prose; enums, classifier precedence, and follow-up payloads are assembled in `extensions/agent-browser/lib/results/shared.ts`, compact page-change summaries and artifact verification rollups are built in `extensions/agent-browser/lib/results/presentation.ts` (`buildPageChangeSummary`, `buildArtifactVerificationSummary`), and the human contract lives in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details)
- inline screenshots/images for the plain `screenshot` command; other image-like saves (for example `diff screenshot`) still appear in `details.artifacts` and summaries but are not auto-inlined as Pi image attachments (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details))
- lightweight session convenience
- docs, including a repo-readable command reference that mirrors the blocked direct-binary help path closely enough for normal agent work
- a deterministic **agent efficiency benchmark** (`scripts/agent-browser-efficiency-benchmark.mjs`) used to quantify representative agent-facing workflows without invoking upstream; maintainer commands and constraints are in [`AGENTS.md`](../AGENTS.md) under “Agent browser efficiency benchmark”

### Upstream `agent-browser` owns

- browser automation semantics
- command vocabulary
- session/profile behavior
- auth/profile mechanics
- feature evolution

### Upstream command surface and checked-in docs

The extension does not ship `agent-browser`, but it does ship maintainer-owned documentation that must stay aligned when upstream help text grows. That work splits into two checks with different responsibilities:

1. **Canonical baseline metadata** lives in `scripts/agent-browser-capability-baseline.mjs` (target version, which `agent-browser` help invocations to sample in live checks, and which literal tokens must appear in upstream help and in human-written `docs/COMMAND_REFERENCE.md` inventory sections). That file does not execute `agent-browser`; rebasing it is an explicit edit after comparing real `--help` output from the installed binary.

2. **Generated Markdown blocks** in `docs/COMMAND_REFERENCE.md` are bounded by stable HTML comments. `scripts/check-command-reference-baseline.mjs` renders those blocks from the baseline metadata only. Use `npm run docs -- command-reference check` or `npm run docs -- command-reference write` after baseline edits so checked-in blocks cannot drift silently.

3. **Live help verification** is `scripts/verify-command-reference.mjs`, invoked via `npm run verify -- command-reference` (and included in the default `npm run verify` gate). It runs the baseline’s help commands against `agent-browser` on `PATH` and fails when the installed upstream surface does not match the declared target version or expected tokens.

This mirrors the playbook contract pattern described in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md): canonical TypeScript source and Markdown fragments stay paired through `npm run docs` / `npm run verify`, with deeper step-by-step notes in [`AGENTS.md`](../AGENTS.md), release checklist items in [`RELEASE.md`](RELEASE.md), and the baseline inventory-to-gates matrix in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

## Not the right design

V1 should avoid:
- a wide family of bespoke browser tools
- compatibility layers for old `agent-browser` versions
- deep embedded SDK-style integration
- embedding a human-browsable browser UI inside `pi`
- a slash-command-heavy UX

## V1 priorities

### Must have

- one native `agent_browser` tool
- direct `--json` execution
- optional stdin support
- implicit-session convenience
- screenshot/image attachment
- clear install and missing-binary messaging
- solid docs

### Nice to have

- compact renderers for snapshots and tab lists
- lightweight status display

## Summary

The architecture should stay:
- thin
- latest-only
- close to upstream
- native where it matters
- low-maintenance
