# Architecture

Related docs:
- [`../README.md`](../README.md)
- [`../AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) (maintainer workflows, including upstream capability baseline)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ELECTRON.md`](ELECTRON.md)

## Decision

Build this as a **thin `pi` extension/package** that exposes `agent-browser` as one native tool while keeping upstream `agent-browser` as the source of truth.

The package install path is the primary product path. Local checkout development should use explicit CLI loading for isolated smoke tests and configured-source plain `pi` runs for lifecycle validation, while package-manifest behavior and packaged contents matter more.

## Chosen shape

### One primary tool plus optional companion search

V1 exposes one native browser tool:

- `agent_browser`

It may also expose one optional companion tool:

- `agent_browser_web_search`, available when an Exa or Brave Search credential source is configured or resolvable from startup config or trusted session config and runtime `webSearch.enabled` is not false

Why:
- keeps browser automation centered on `agent_browser`
- avoids colliding with generic `web_search`
- keeps live search separate from browser state, screenshots, refs, and session lifecycle
- supports requested Exa/Brave provider choice without turning search into an `agent_browser` input mode
- keeps optional search invisible when it cannot run or when the user disables it

### Direct subprocess execution

The extension should:
- resolve `agent-browser` from `PATH`
- invoke it directly on POSIX; on Windows, route through PowerShell with single-quoted argv so npm launchers and the native `.exe` receive the same command tail that a user would type, and terminate the full PowerShell/agent-browser process tree with `taskkill /T /F` on timeout or abort before falling back to the direct child signal
- inject `--json`
- complete each upstream invocation when the direct `agent-browser` child exits even if Node delays `"close"`: piped stdio can stay referenced by longer-lived descendant processes, so `runAgentBrowserProcess` watches `exit` and `close` together, leaves stdio intact during a short post-`exit` grace so normal `close` can still win, destroys streams only when the post-`exit` fallback fires, and prefers `close` codes then wrapper timeout (`124`) over signal-shaped `exit` codes (`watchSpawnedChildCompletion` / `resolveSpawnedChildExitCode` in `extensions/agent-browser/lib/process.ts`) so the tool cannot hang after the CLI process has already terminated
- support optional stdin only for `eval --stdin`, `batch`, `auth save --password-stdin`, and wrapper-generated `batch` stdin from top-level `job`, `qa`, `sourceLookup`, or `networkSourceLookup`, rejecting other command/stdin combinations before launch; top-level `electron` never accepts caller `stdin` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron))
- support optional top-level `outputPath` for successful browser results by writing `details.data` (or model-facing text when no structured data exists) to a caller-requested local file and reporting `details.outputFile`, without changing upstream argv semantics
- support optional top-level `timeoutMs` as a per-call subprocess watchdog override for browser CLI input modes while keeping Electron-specific timeouts inside the `electron` object
- accept an optional native `semanticAction` object as a mutually exclusive alternative to `args` on a single tool call (and to `job`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron` on the same call), compile locator actions into upstream `find` argv, direct selector/ref click/check/fill into upstream command argv, and native dropdown selection into upstream `select <selector> <value...>` argv (with optional `semanticAction.session` expanding to a leading `--session <name>` before the compiled command when targeting a named upstream browser instead of the managed default), and echo the compiled shape in `details.compiledSemanticAction` for observability (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction))
- accept an optional native `job` object (mutually exclusive with `args`, `semanticAction`, `qa`, `sourceLookup`, `networkSourceLookup`, and `electron` on the same call) with a small fixed step vocabulary that compiles only to existing upstream `batch` argv rows, generates the JSON batch stdin string internally, defaults to fail-fast `batch --bail` unless `failFast:false` is explicit, supports semantic locator fields on constrained `click`/`fill` steps by reusing the top-level semantic-action compiler, supports human-paced `type` by expanding to a bounded set of existing focus/keyboard/wait/press rows while compacting model-visible batch text, and echoes `details.compiledJob` for observability (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#job))
- accept an optional native `qa` object (mutually exclusive with `args`, `semanticAction`, `job`, `sourceLookup`, `networkSourceLookup`, and `electron` on the same call) that compiles to the same fail-fast `batch --bail` path as `job`, runs a fixed diagnostic smoke sequence with bounded visible-text predicates for `expectedText`, preserves existing diagnostics for `qa.attached` while clearing buffers only for URL-opening QA, and echoes `details.compiledQaPreset` plus structured `details.qaPreset` pass/fail evidence (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#qa))
- accept an optional native `sourceLookup` object (mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `networkSourceLookup`, and `electron` on the same call) that compiles to the same `batch` path, gathers evidence-backed local source *candidates* for a selector/fiber/component name, and echoes `details.compiledSourceLookup` plus structured `details.sourceLookup` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#sourcelookup)); unlike `qa`, it never applies a second pass/fail layer that marks the tool failed when upstream already reported batch success—failed upstream steps still fail the invocation normally, and `details.sourceLookup` may still be present for partial evidence
- accept an optional native `networkSourceLookup` object (mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `electron` on the same call) that compiles to the same `batch` path, correlates failed network requests with initiator metadata and bounded workspace URL literals, and echoes `details.compiledNetworkSourceLookup` plus structured `details.networkSourceLookup` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#networksourcelookup)); like `sourceLookup`, it never flips a successful upstream batch to failed solely because no source candidates were found
- accept an optional native `electron` object (mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `networkSourceLookup` on the same call) for bounded desktop Electron lifecycle: `list` scans the host for install candidates, `launch` creates a wrapper-owned isolated profile plus OS-chosen remote-debugging port, then attaches through upstream `connect` with `sessionMode: "fresh"`, and `status` / `cleanup` / `probe` operate only on wrapper-tracked launches; host-side spawn and CDP discovery live in `extensions/agent-browser/lib/electron/discovery.ts`, `launch.ts`, and `cleanup.ts`, while compilation, transcript restore for `launchId` records, handoff probes, and merged `details.electron*` fields live under `extensions/agent-browser/lib/orchestration/electron-host/` and `extensions/agent-browser/lib/orchestration/browser-run/` (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron))
- when a compiled `find` semantic action fails as `stale-ref`, optionally append a `retry-semantic-action-after-stale-ref` entry to `details.nextActions` after the usual `refresh-interactive-refs` snapshot step so agents can re-issue the same compiled `find` argv only when the failure implies the interaction did not run; `select` shorthands with stale `@refs` get refresh guidance only (contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction))
- when the same compiled path fails as `selector-not-found` for the bounded locator/action pairs documented there, optionally append `try-*-candidate` entries to `details.nextActions` and mirror them in visible text as `Agent-browser candidate fallbacks` so agents can retry role/name `find` variants without hand-rebuilding argv (`select` misses are intentionally excluded)

### Agent-first UX

The primary UX is the agent calling the tool directly.

That means:
- no command-heavy slash-command interface
- no manual user orchestration as the main workflow
- any future slash commands should be minimal and secondary

### Package-owned config

Pi docs use `settings.json` for package/resource loading and filtering, not arbitrary extension secrets. For user-tunable package behavior, this package owns Pi-scoped config files instead:

- global: `~/.pi/config/pi-agent-browser-native/config.json`
- project-local: `.pi/config/pi-agent-browser-native/config.json`
- explicit override: `PI_AGENT_BROWSER_CONFIG=/path/to/config.json`

Config layers merge in that order: global, project, override. The shared policy module (`extensions/agent-browser/lib/config-policy.js`) owns provider descriptors, environment variable names, config keys, credential source parsing, developer-trusted project layer inclusion, layer validation/merge, redacted status projection, and credential summaries for both runtime config loading and the package config helper. Under Pi 0.79+, globally installed or CLI-loaded extensions are developer-trusted code, so this extension reads `.pi/config/pi-agent-browser-native/config.json` by default and skips that project layer when Pi reports the project is untrusted or when launched with `--no-approve`. Global config and explicit `PI_AGENT_BROWSER_CONFIG` overrides remain available either way. The config reader accepts v1 fields for `webSearch.enabled`, `webSearch.preferredProvider`, `webSearch.exaApiKey`, `webSearch.braveApiKey`, and conservative browser defaults such as `browser.defaultProfile` and `browser.executablePath`. Web-search key fields follow Pi model/provider-style value resolution from any loaded layer: literal values, `$ENV_VAR` / `${ENV_VAR}` interpolation, escapes (`$$`, `$!`), and leading `!command` resolved at request time. `EXA_API_KEY` and `BRAVE_API_KEY` remain environment fallbacks when no config credential source exists for that provider. Browser default values keep their source scope; prompt guidance is emitted from the highest-priority loaded layer, including project config when Pi trust/loading allows it.

`agent_browser_web_search` availability is conditional. Startup registration uses global, override, and environment fallback config without reading project-local config before Pi trust context exists; trusted project config can register the companion tool on `session_start`, and every execution reloads the final session config so `webSearch.enabled: false` still prevents a request even if a startup credential made the tool visible. A global disable is the normal user default and can still be overridden by project config or `PI_AGENT_BROWSER_CONFIG`; a project disable applies to one repo; an explicit `PI_AGENT_BROWSER_CONFIG` file with `webSearch.enabled: false` is the highest-priority hard disable for that run. Literal and env-backed sources must resolve before they make the tool available; command-backed sources are considered configured without running the command until tool execution, so secret managers do not slow startup or prompt unexpectedly. The tool resolves the selected key lazily, chooses Exa or Brave from available credentials (preferring Exa by default unless `webSearch.preferredProvider` says otherwise), then follows one provider-agnostic execution path through provider adapters for request building, HTTP JSON fetch, response normalization, and provider-specific detail fields. It calls Exa `/search` with highlights or Brave Search and returns compact result details without exposing keys.

Browser default config is intentionally advisory. It can add prompt guidance for signed-in/account-specific tasks and alternate Chromium-compatible executables, but current releases do not auto-inject `--profile` or `--executable-path` into every launch. Loaded project config can provide the same guidance as global and override config; Pi/project trust decides whether that project layer is loaded. Automatic launch-default mutation would affect privacy, browser state, and host executable choice, so it needs a separate explicit design and test pass.

### Prompt guidance budget

Runtime `promptGuidelines` are a Tier A budget, not a full manual. They stay short enough to load on every `agent_browser`-aware turn and carry only high-impact rules: input-mode choice, the open → snapshot → ref loop, launch-scoped session handling, artifact verification, structured `nextActions`, extraction basics, and hard agent-responsibility boundaries such as “stop before order/post/purchase/submit.”

Tier B guidance lives in `SHARED_BROWSER_PLAYBOOK_GUIDELINES`, generated README/command-reference fragments, and targeted docs. When a workflow needs examples, caveats, or long command-family coverage, add it there instead of expanding always-on prompt text. If a Tier B rule prevents a repeated real failure, promote only the smallest durable sentence into Tier A and keep the generated-doc mirrors aligned.

### No reusable recipe layer yet

Do **not** add reusable browser recipes as a first-class runtime surface yet.

Current evidence does not justify another source of truth for workflows:
- the deterministic efficiency benchmark in [`scripts/agent-browser-efficiency-benchmark.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/agent-browser-efficiency-benchmark.mjs) models one native `job` scenario (`job-open-assert-screenshot`), one `qa` preset (`qa-open-diagnostics`), one `sourceLookup` (`source-lookup-visible-element`), one `networkSourceLookup` (`network-source-lookup-failed-request`), plus deterministic `electron` lifecycle/probe scenarios (`electron-lifecycle`, `electron-probe`) rather than repeated named job patterns that agents keep re-specifying
- repo-local dogfood evidence does not show repeated project-specific job recipes that need versioning or ownership
- `qa` already covers the only repeated smoke-test shape with a stable top-level preset
- docs and prompt guidance can carry examples without adding recipe state, migration rules, or another schema

Revisit this only when benchmark or dogfood data shows at least two repeated, failure-prone job sequences that cannot be represented clearly by `job`, `qa`, top-level `electron`, or raw `batch`. If that happens, define ownership, versioning, schema boundaries, generated docs, and tests before adding executable recipes.

### Package layout versus local checkout development

The published package should load from the `pi` manifest in `package.json`.

Local checkout validation has two intentional modes:

- **Quick isolated mode:** use explicit CLI loading such as `pi --approve --no-extensions -e .` from the repository root when this checkout is intentionally trusted. This bypasses Pi settings and extension discovery, avoids duplicate `agent_browser` registrations when another source is installed globally, and is the right mode for checkout smoke tests; omit `--approve` only when deliberately testing Pi's Project Trust prompt.
- **Configured-source lifecycle mode:** configure exactly one active checkout or package source in Pi settings and launch plain `pi` for manual validation, or run the automated harness that launches with `--approve`. This is the right mode for validating `/reload` and exact-session relaunch because those lifecycle checks exercise discovered/configured resources. Focused extension harness tests validate branch-backed `session_tree` rehydration and cleanup ownership. Before shipping, maintainers also run `npm run verify -- lifecycle` (same semantics under automation, using Pi 0.79 `--approve --session-id` to reopen the exact JSONL session) plus the live-site checks in [`RELEASE.md`](RELEASE.md#pre-release-checks); `npm publish` enforces `npm run verify -- release` via `prepublishOnly` unless scripts are skipped.

The repo should not add a repo-local `.pi/extensions/` autoload shim as the documented checkout path.

Why:
- avoids duplicate `agent_browser` registrations when the package is also installed globally
- keeps the product contract centered on the package manifest instead of repo-local autoload wiring
- keeps reload and exact-session relaunch validation tied to Pi's configured-source lifecycle instead of an isolated quick-test path, while `session_tree` state changes stay covered by focused extension harness tests
- keeps the published tarball focused on the package manifest, extension code, canonical docs, and license

The published package should exclude agent-only and internal planning materials such as `AGENTS.md` and `docs/plans/`.

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
- extension-managed sessions should be reusable during an active `pi` session and across `/reload`, exact-session relaunch, `/resume`, and Pi branch-tree transitions, while still being cleaned up predictably

Practical policy:
- preserve the current branch-visible extension-managed session across `/reload`, exact-session relaunch, `/resume`, and Pi 0.79 `session_tree` branch transitions so persisted sessions can keep following the live browser after lifecycle changes
- close the active extension-managed session when the originating `pi` process quits, while leaving explicit caller-provided sessions alone
- set an idle timeout on extension-managed sessions as a backstop for abnormal exits or cleanup failures
- clean up process-private temp spill artifacts on shutdown, but keep persisted-session snapshot spill files in a private session-scoped artifact directory with a bounded per-session budget so `details.fullOutputPath` stays usable after reload/resume without unbounded growth
- keep explicit screenshots, downloads, PDFs, traces, HAR captures, and recordings written to caller-chosen paths on disk after a successful upstream close command (`close`, `quit`, or `exit`); before artifact-producing commands run, create missing parent directories for requested host paths, and for simple loopback HTML anchor downloads with resolvable HTTP(S) hrefs the wrapper may save directly to the requested path before upstream fallback. When the bounded `details.artifactManifest` has entries, successful close commands also surface `details.artifactCleanup` and a compact `Artifact lifecycle` note pointing to structured explicit paths so operators remove files with normal host tools—the native tool does not delete arbitrary user paths (`extensions/agent-browser/lib/orchestration/browser-run/diagnostics.ts`, `getArtifactCleanupGuidance`); contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details), checklist `RQ-0079` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- reconstruct the current branch-visible extension-managed session, page-scoped refs, artifact manifest, and Electron launch records from the active transcript branch on `session_start` and `session_tree` so later default calls keep following the active managed browser after resume/reload or branch switching; restore also honors successful explicit `--session <wrapper-owned> close` rows and `electron.cleanup` managed-session steps so closed wrapper-owned sessions are not resurrected
- keep process-owned cleanup registries for extension-managed sessions and wrapper-launched Electron records separate from the current branch-visible view; `session_tree` restore and wrapper-owned browser commands are serialized with managed-session work, while independent caller-owned explicit-session commands keep their parallel tab-target behavior but use a branch-state generation guard so stale completions cannot overwrite newer branch-visible managed/artifact state after a branch switch; branch switches still must not drop resources the current Pi process owns and must keep fresh-session allocation monotonic
- when a successful close targets the current extension-managed session, including an explicit `--session <current> close` or an `electron.cleanup` managed-session step, clear page/ref state, mark that session inactive, untrack cleanup ownership, and rotate the next default auto call to a fresh wrapper-generated session name rather than reusing the closed name
- on non-quit shutdown such as `/reload`, close off-branch owned managed sessions and off-branch owned Electron launches before clearing process-local ownership, but preserve the current branch-visible active managed session and Electron launch plus that launch's isolated `userDataDir` so reload continuity still works from the active transcript branch
- expose still-owned off-branch Electron launch records to `electron.status { launchId }`, `electron.status { all: true }`, `electron.probe { launchId }`, and `electron.cleanup`, while leaving default `electron.probe` scoped to the current managed session
- if an unnamed fresh launch replaces an active extension-managed session, best-effort close the old managed session after the switch succeeds
- leave explicit caller-provided `--session` choices alone unless the caller closes them explicitly
- after profiled `open` / `goto` / `navigate` calls, verify the active tab still matches the returned page URL and best-effort switch back when restored profile tabs steal focus
- once the wrapper observes tab-drift risk for a session (profile restore correction, overlapping stale opens, or restored session state), later active-tab commands may synthesize a tiny upstream `batch` that re-selects that tab and then runs the requested command in the same upstream invocation; routine same-session commands avoid `tab list` preflights to reduce probes that can perturb upstream click behavior
- for sessions with observed tab-drift risk, after a successful command on a known tab target, the wrapper may best-effort restore that same target again if restored/background tabs steal focus after the command returns; routine same-session commands skip this post-command `tab list` probe
- keep a per-session `refSnapshot` aligned with the last successful `snapshot` (including refs merged from a successful `batch` by taking the last successful `snapshot` step in batch result order): restore it from persisted tool `details` when reloading, resuming, or moving to a different Pi session-tree branch, store bounded ref role/name metadata from the same snapshot for wrapper-side current-ref diagnostics, drop it on successful close commands (`close`, `quit`, or `exit`), and refuse mutation-prone `@e…` argv before spawn when the active tab URL no longer matches the snapshot URL, when a ref id was never in that snapshot, or when `batch` stdin would reuse `@e…` on a guarded step after an earlier invalidating step without a later `snapshot` step in the same stdin array. Same-snapshot `fill @e…` rows are guarded but do not themselves set that invalidation latch, so ordinary form fills can precede a click/submit row in one batch—see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) for the agent-visible contract and failure text; typed per-session tab/ref/pinning state lives in `extensions/agent-browser/lib/session-page-state.ts` and is updated from `extensions/agent-browser/index.ts` after each tool result
- for top-level non-Electron direct `click` commands with an eligible target, install a bounded in-page target-specific event probe before upstream runs; if upstream reports success but no trusted pointer/mouse/click event reached the resolved target, fail the tool and report `details.clickDispatch` with explicit retry/inspect next actions (the wrapper does not replay clicks in-page). The probe covers `xpath=` targets and current `@e…` / `ref=` refs whose latest stored `refSnapshot.refs` role is `button`, `checkbox`, `menuitem`, `radio`, `switch`, or `tab`; it uses that role/name metadata, including snapshot-order `duplicateIndex` for duplicate-name refs, instead of taking a fresh pre-click snapshot that could recycle upstream refs. The probe is intentionally skipped for CSS selector clicks, unresolved `find … click` locators, and `batch`/`job`/`qa` click steps
- derive narrow prompt guards only for concrete evidence invariants: exact required screenshot paths block browser close until the artifact manifest verifies those paths. The wrapper intentionally does not infer broad business/user intent from prompt text such as order/payment/post boundaries; agents must follow those instructions themselves. The artifact guard is bounded preflight policy (`details.promptGuard`, `failureCategory: "policy-blocked"`), not a reusable browser recipe layer
- after successful `get text` on a qualifying non-ref CSS selector, optionally issue one read-only `eval --stdin` probe per selector when multiple DOM matches or a hidden first match with visible peers could misread tabbed or off-screen content; simple id selectors and sensitive-looking literals skip this probe. Merge `details.selectorTextVisibility` / `selectorTextVisibilityAll`, visible warning lines, and `inspect-visible-text-candidates*` next actions as documented in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) and `RQ-0074` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- for local Unix launches, set a short private socket directory so extension-generated session names do not fail on the upstream Unix socket-path length limit
- keep wrapper-spawned upstream CLI calls bounded by clamping `AGENT_BROWSER_DEFAULT_TIMEOUT` to the upstream documented 25-second default while deriving a longer subprocess watchdog for explicit long `wait <ms>` / `wait --timeout <ms>` calls; dialog commands, likely dialog-trigger clicks/taps/finds, and `eval --stdin` snippets that look like alert/confirm/prompt/dialog triggers use shorter wrapper subprocess budgets so blocking JavaScript prompts surface recovery actions before the full default watchdog

This is primarily about ownership clarity and avoiding surprise, not adding a heavy safety wrapper. If the extension invented the session, the extension should own its lifecycle without breaking reload, resume, or branch-tree semantics. If the caller explicitly chose the upstream session model, the extension should stay out of the way.

### Launch flags

`agent-browser` startup flags are sticky once a session is already running.
The extension should surface that clearly and avoid hidden restart behavior in v1.

That means explicit startup-scoping flags like `--allowed-domains`, `--auto-connect`, `--cdp`, `--enable`, `--executable-path`, `--webgpu`, `--init-script`, `--device`, `--namespace`, `--profile`, `--provider`, `-p`, `--restore`, `--restore-save`, restore check flags, `--session-name`, and `--state` should remain explicit upstream choices instead of being wrapped in extra hidden restart or cloning logic.

The wrapper may still apply narrow compatibility normalizations when observed behavior justifies them and the result remains thin, local, and opt-out. For example, if a specific site starts rejecting the default local headless Chrome user agent while the same flow works with a normal Chrome UA, the extension may inject a domain-specific fallback UA only when the caller did not already choose `--user-agent`, `--headed`, `--cdp`, `--auto-connect`, or a provider-backed launch.

If the implicit session is already active and one of those startup-scoped flags appears again while `sessionMode` is still `"auto"`, the extension should fail clearly instead of silently sending a command shape that upstream would ignore.

That failure should include a structured recovery hint pointing to `sessionMode: "fresh"` as the first-line fix, while still allowing an explicit `--session` when the caller wants to name the new upstream session.

Implementation detail lives in `extensions/agent-browser/lib/launch-scoped-flags.ts` (canonical flag metadata shared with playbook/docs assertions), `extensions/agent-browser/lib/argv-descriptor.ts` and `extensions/agent-browser/lib/argv-grammar.ts` (command discovery, `VALUE_FLAGS`, `parseArgvDescriptor`) plus `extensions/agent-browser/lib/runtime.ts` (`getStartupScopedFlags`, `buildExecutionPlan`):

- **Command discovery:** Leading argv is scanned with a value-taking allowlist so known global flags and documented command flags consume their values before the upstream command word is identified. Missing-value prevalidation is intentionally limited to upstream global value flags; command-scoped flags and literal text are left to upstream parsing so values like `fill #field --password` are not rejected by wrapper heuristics before the CLI sees them. When upstream adds new global flags that take values ahead of the command, extend both the command-discovery and prevalidation allowlists; when it adds command-specific flags, extend only command discovery/redaction as needed. A smaller set of global boolean flags may be followed by an optional `true`/`false` literal; when present, that literal is consumed as the flag value before command discovery continues.
- **`--state` disambiguation:** Persisted browser `--state` before the command participates in launch-scoped validation and tab-correction hints. The same flag spelling after a `wait` command is excluded from startup-scoped detection so upstream help examples such as `wait @ref --state hidden` do not spuriously require `sessionMode: "fresh"` while an implicit session is active. As of the current upstream baseline, the parser still does not implement those `wait --state` examples as distinct wait modes, so agent-facing docs recommend `wait --fn` predicates for disappearance checks instead.
- **`--auto-connect`:** Treated as launch-scoped only when enabled (`--auto-connect` bare or `true`). `--auto-connect false` is ignored for startup-scoped blocking so disabled attach hints do not force a fresh launch.
- **`--webgpu`:** Treated as launch-scoped for both enabled and explicit `false` values. Enabled WebGPU selects upstream's platform-specific local-launch preset; explicit false can override an environment/config default and still belongs to a fresh browser launch. Upstream rejects enabled WebGPU with CDP, auto-connect, or provider launches.
- **`--allowed-domains`:** Treated as launch-scoped so containment cannot silently relaunch or reuse the active implicit browser. Upstream 0.32.0 owns request, worker, popup, and WebRTC containment and rejects CDP/auto-connect, profiles, restore/state replay, direct-page providers, iOS/Safari, and unsafe startup/profile Chrome args; the wrapper keeps only a final-URL policy check as defense in depth.

**Sessionless inspection and local commands:** Plain-text global help and version probes (`--help`, `-h`, `--version`, `-V`) must never allocate or bind the extension-managed session. The same session-ownership rule applies to read-only upstream `skills list`, `skills get …`, and `skills path …`, local auth profile management (`auth save/list/show/delete/remove`), plus local/setup surfaces such as `profiles`, `dashboard start/stop`, `device list`, `doctor`, `install`, `upgrade`, `session id`, `session info`, `session list`, and targeted/all local saved-state maintenance (`state list/show`, `state clear --all`, `state clear -a`, `state clear <session-name>`, `state clean --older-than <days>`, `state rename`). Non-plain-text sessionless commands still run with `--json` for machine-readable output, but the planner does not prepend the implicit managed `--session`, so an agent can inspect local capabilities or start/stop the standalone dashboard without consuming the implicit session slot before a real `open`. Browser-backed, context-dependent, or incomplete commands such as root `session`, untargeted `state clear`, bare `state clean`, `auth login`, `state save`, and `state load` keep normal managed-session injection. Command-shape allowlisting lives in `extensions/agent-browser/lib/command-policy.ts` (`needsManagedSession`), while `extensions/agent-browser/lib/runtime.ts` (`isPlainTextInspectionArgs`, `buildExecutionPlan`) applies that decision to execution planning.

A successful unnamed `sessionMode: "fresh"` launch should become the new extension-managed session so later default calls follow that browser instead of silently snapping back to the older managed session.

When a managed implicit or fresh `--session` plan reaches process execution, `details.managedSessionOutcome` summarizes the managed-session transition: on **success**, statuses such as `created`, `replaced`, `unchanged`, or `closed` describe what became current (including successful close commands: `close`, `quit`, or `exit`); on **failure** (launch error, timeout, missing binary, failed close command, and similar), `preserved` vs `abandoned` captures whether a prior managed session stayed current or no managed session ended up active, plus related names and booleans. Post-launch failures after the fresh browser has already opened the target page—such as **`qa`** reclassification, a later failed `job`/batch step, or a fresh batch timeout with recovered current-page evidence—preserve that fresh session as current and set the visible recovery text to say the fresh launch became current instead of reverting the agent to the old session. Failing calls that used `sessionMode: "fresh"` also append a short `Managed session outcome: …` line to model-visible text so the next default `sessionMode: "auto"` hop is obvious; `"auto"` failures may still populate the struct without that extra line. Implementation and field semantics live in `extensions/agent-browser/lib/session-page-state.ts` and `extensions/agent-browser/lib/orchestration/browser-run/session-state.ts`; agent contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); checklist row `RQ-0077` in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

## Preferring the native tool

Keep the handling simple:
- prefer the native tool through extension guidance and tool-call guards
- do not rely on package skill overrides as the primary solution

This keeps the product centered on native tool usage instead of auxiliary skill wiring.

Upstream restore-state persistence remains upstream-owned. The wrapper passes `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS` through unchanged; the behavior introduced in upstream 0.31.2 periodically saves restore-enabled cookies/localStorage after command quiet time and during idle page changes, while `0` disables periodic saves without disabling save-on-close. The wrapper must not duplicate that timer or treat upstream restore files as wrapper-owned artifacts.

## Responsibility split

### `pi-agent-browser-native` owns

- tool registration and schema (including the optional `semanticAction` compilation path to upstream `find` or `select`)
- subprocess execution and JSON parsing through `buildAgentBrowserProcessEnv` in `extensions/agent-browser/lib/process.ts`: copies the parent process environment so user-approved provider credentials and other runtime variables reach upstream, then applies wrapper overrides such as the managed socket directory and clamped default operation timeout
- clear missing-binary errors
- compact result summaries, including presentation-time redaction: stateful browser-context commands (`auth`, `cookies`, `storage`, `dialog`, `frame`, `state`) use field-aware value redaction and compact formatters, while other structured upstream JSON (for example `network`, `diff`, `trace` / `profiler` / `record`, `console` / `errors` / `highlight` / `inspect` / `clipboard`, `stream`, `dashboard`, and `chat`) is passed through `redactPresentationData` in `extensions/agent-browser/lib/results/presentation.ts` so model-facing `details.data` and batch roll-ups stay compact and do not echo bearer tokens, proxy passwords, or similar fields verbatim; `redactInvocationArgs` in `extensions/agent-browser/lib/runtime.ts` masks trailing values for sensitive global flags such as `--body`, `--headers`, `--password`, and `--proxy`, preserves positional rules for `cookies set` and `storage local|session set`, and nested `batch` steps use the same argv and error-body scrubbing before echoing commands or errors
- bounded machine-readable outcome metadata on tool `details` (`resultCategory`, `successCategory`, `failureCategory`, optional `nextActions`, optional `pageChangeSummary` with per-step summaries on `batch`, optional `artifactVerification` with the same shape on each successful `batchSteps[]` row) so agents can branch without parsing prose; enums, classifier precedence, and generic follow-up payloads are implemented under `extensions/agent-browser/lib/results/` in focused modules (`contracts.ts` for shared types, `categories.ts` for `classifyAgentBrowserSuccessCategory` / `classifyAgentBrowserFailureCategory` / `buildAgentBrowserResultCategoryDetails`, `action-recommendations.ts` for `buildAgentBrowserNextActions`, `next-actions.ts` for the `AgentBrowserNextAction` shape and merge helpers, `recovery-actions.ts` for recovery id registries and `buildRecoveryNextActions`, `network.ts` for `classifyNetworkRequestFailure` / `summarizeNetworkFailures`, and related helpers). Per-session tab target, `refSnapshot` alignment, invalidation, and tab pinning observations flow through `extensions/agent-browser/lib/session-page-state.ts` from `extensions/agent-browser/index.ts`. Compact page-change summaries and artifact verification rollups are built in `extensions/agent-browser/lib/results/presentation.ts` (`buildPageChangeSummary`, `buildArtifactVerificationSummary`), and the human contract lives in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details). Real Pi custom tools otherwise only mark a row failed when `execute` throws, so the extension also registers `pi.on("tool_result", …)` and patches `agent_browser` results whose `details.resultCategory` is `failure` to set `isError: true`. Prose results also receive a short category notice, while caller-requested `--json` results with parseable JSON content keep that text unchanged so JSONL transcripts, UI affordances, and the machine-readable contract stay aligned for wrapper-side reclassifications such as `qa-failure` (`buildAgentBrowserToolResultPatch` in `extensions/agent-browser/lib/pi-tool-rendering.ts`; transcript semantics in the same contract doc)
- inline screenshots/images for the plain `screenshot` command; other image-like saves (for example `diff screenshot`) still appear in `details.artifacts` and summaries but are not auto-inlined as Pi image attachments (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details))
- lightweight session convenience
- docs, including a repo-readable command reference that mirrors the blocked direct-binary help path closely enough for normal agent work
- a deterministic **agent efficiency benchmark** (`scripts/agent-browser-efficiency-benchmark.mjs`) used to quantify representative agent-facing workflows without invoking upstream; maintainer commands and constraints are in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) under “Agent browser efficiency benchmark”

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

This mirrors the playbook contract pattern described in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md): canonical TypeScript source and Markdown fragments stay paired through `npm run docs` / `npm run verify`, with deeper step-by-step notes in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), release checklist items in [`RELEASE.md`](RELEASE.md), and the baseline inventory-to-gates matrix in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

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
