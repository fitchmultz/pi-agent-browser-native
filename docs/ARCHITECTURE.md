# Architecture

Related docs:
- [`../README.md`](../README.md)
- [`../AGENTS.md`](../AGENTS.md) (maintainer workflows, including upstream capability baseline)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)

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
- support optional stdin only for `eval --stdin`, `batch`, and `auth save --password-stdin`, rejecting other command/stdin combinations before launch
- accept an optional native `semanticAction` object as a mutually exclusive alternative to `args` on a single tool call, compile it into upstream `find` argv, and echo the compiled shape in `details.compiledSemanticAction` for observability (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction))
- when that compiled path fails as `stale-ref`, optionally append a `retry-semantic-action-after-stale-ref` entry to `details.nextActions` after the usual `refresh-interactive-refs` snapshot step so agents can re-issue the same compiled `find` argv only when the failure implies the interaction did not run (contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction))

### Agent-first UX

The primary UX is the agent calling the tool directly.

That means:
- no command-heavy slash-command interface
- no manual user orchestration as the main workflow
- any future slash commands should be minimal and secondary

### Package layout versus local checkout development

The published package should load from the `pi` manifest in `package.json`.

Local checkout validation has two intentional modes:

- **Quick isolated mode:** use explicit CLI loading such as `pi --no-extensions -e .` from the repository root. This bypasses Pi settings and extension discovery, avoids duplicate `agent_browser` registrations when another source is installed globally, and is the right mode for checkout smoke tests.
- **Configured-source lifecycle mode:** configure exactly one active checkout or package source in Pi settings and launch plain `pi`. This is the right mode for validating `/reload`, restart, and `/resume` behavior because those lifecycle checks exercise discovered/configured resources.

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
- reconstruct the current extension-managed session from persisted tool details on resume/reload so later default calls keep following the active managed browser
- if an unnamed fresh launch replaces an active extension-managed session, best-effort close the old managed session after the switch succeeds
- leave explicit caller-provided `--session` choices alone unless the caller closes them explicitly
- after profiled `open` / `goto` / `navigate` calls, verify the active tab still matches the returned page URL and best-effort switch back when restored profile tabs steal focus
- once the wrapper knows which tab the agent is operating on, later active-tab commands may synthesize a tiny upstream `batch` that re-selects that tab and then runs the requested command in the same upstream invocation; this stays thin while avoiding reconnect-time drift on profile-restored sessions
- after a successful command on a known tab target, the wrapper may best-effort restore that same target again if restored/background tabs steal focus after the command returns
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

## Preferring the native tool

Keep the handling simple:
- prefer the native tool through extension guidance and tool-call guards
- do not rely on package skill overrides as the primary solution

This keeps the product centered on native tool usage instead of auxiliary skill wiring.

## Responsibility split

### `pi-agent-browser-native` owns

- tool registration and schema (including the optional `semanticAction` → `find` compilation path)
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

This mirrors the playbook contract pattern described in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md): canonical TypeScript source and Markdown fragments stay paired through `npm run docs` / `npm run verify`, with deeper step-by-step notes in [`AGENTS.md`](../AGENTS.md) and release checklist items in [`RELEASE.md`](RELEASE.md).

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
