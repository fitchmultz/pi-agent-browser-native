# Requirements

Related docs:
- [`../README.md`](../README.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ELECTRON.md`](ELECTRON.md)
- [`RELEASE.md`](RELEASE.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

## Purpose

Define the product requirements and constraints for `pi-agent-browser-native`.

## Product requirements

### Dependency model

- `agent-browser` is an external dependency.
- This project does **not** bundle `agent-browser`.
- Users install `agent-browser` separately and keep it available on `PATH`.
- User-facing install guidance should point to the upstream `agent-browser` project/docs.

### Version policy

- Target the current locally installed `agent-browser` version.
- Do **not** support a broad range of older `agent-browser` versions.
- Do **not** add backward-compatibility shims.
- Keep the wrapper close to current upstream behavior as `agent-browser` evolves.
- Maintainer-facing mapping from the canonical baseline (`scripts/agent-browser-capability-baseline.mjs`) to docs, runtime, tests, and verification gates lives in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md); refresh that matrix when rebaselining upstream.

### Design philosophy

- Do **not** overengineer.
- Do **not** reduce usability.
- Keep the integration thin and close to upstream `agent-browser`.
- Give `pi` agents the power they need for practical browser automation.
- Prefer official `pi` mechanisms over bespoke custom integration patterns.
- Do **not** solve hypothetical problems that are not backed by observed behavior.

### Primary UX

- The main UX is the agent invoking the native tool directly, similar to built-in tools like `read` or `write`.
- Do **not** rely on a large set of user-facing slash commands as the main interface.
- This project is not trying to embed a human-browsable browser UI inside `pi`.

### Install priority

- Prioritize the package install path first.
- User-facing install docs should lead with `pi install npm:pi-agent-browser-native`; ephemeral package trials and validation should use `pi --no-extensions -e npm:pi-agent-browser-native[@<version>]` so configured checkout or global sources cannot duplicate `agent_browser`, adding `--approve` in Pi 0.79+ automation when the current project is intentionally trusted.
- User-facing install docs should also include the GitHub source path `pi install https://github.com/fitchmultz/pi-agent-browser-native`.
- Provide a read-only package-level doctor command that checks upstream `agent-browser` PATH/version and duplicate Pi package/checkout sources before first use. It must not mutate Pi settings and must remain distinct from upstream `agent-browser doctor`.
- Keep the current local-checkout path documented as the practical pre-release and development flow.
- Most users will install this extension globally rather than as a project-local extension.
- Local trusted-checkout smoke testing should use explicit CLI loading such as `pi --approve --no-extensions -e .` or `pi --approve --no-extensions -e /absolute/path/to/pi-agent-browser-native`; Pi settings are bypassed in this mode and code edits require a process restart for validation. Omit `--approve` only when the test is meant to cover Pi's Project Trust prompt.
- Local checkout hot-reload and exact-session relaunch validation should use configured-source lifecycle mode: exactly one active checkout/package source in Pi settings, launched with plain `pi` (or the lifecycle harness' exact `--session-id` relaunch path), so `/reload` and relaunch events exercise discovered/configured resources. Focused extension harness tests validate Pi `session_tree` branch rehydration and cleanup ownership.
- Do **not** rely on repo-local `.pi/extensions/` auto-discovery for this package, because it conflicts with the global installed-package path.

### Native-tool preference

- When this native extension is available, the native `agent_browser` tool should be the preferred path for browser automation.
- Keep the handling simple and global-install-friendly.
- Do not rely on package skill overrides as the primary answer.

### Native `agent_browser` inputs

- Each tool invocation must supply **exactly one** of: `args` (full upstream argv after the binary name), top-level `semanticAction` (a small intent object compiled into existing upstream `find` argv for locator actions, direct selector/ref `click` / `check` / `fill` argv, or upstream `select <selector> <value...>` argv for native dropdown selection), `job`, `qa`, `sourceLookup`, `networkSourceLookup`, or `electron` (bounded desktop lifecycle: host `list`, wrapper-owned isolated `launch` with CDP attach, `status`, compact `probe`, and `cleanup`; mutually exclusive with caller `stdin`). Supplying multiple modes or none is rejected before launch (`extensions/agent-browser/index.ts`, `test/agent-browser.extension-validation.test.ts`). Contract and field rules: [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron); operator workflow: [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md#electron-desktop-apps).
- `semanticAction` is not a nested shape inside `batch` stdin; batch steps remain upstream argv string arrays, including `find` steps expressed as token lists.
- Supported actions, locators, exclusivity rules, when `details.compiledSemanticAction` appears, and bounded `try-*-candidate` follow-ups on `selector-not-found` (specific action/locator pairs only; see contract) are specified in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction), with workflow examples in [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md).
- Constrained `job` remains a thin batch compiler, but its `click`/`fill` steps may use the same semantic locator fields as `semanticAction` so short workflows can avoid brittle selectors without adding a reusable recipe runtime, and `type` steps may expand to a bounded set of existing upstream focus/keyboard/wait/press rows for human-paced input while compacting model-visible batch text. `job` must default to fail-fast (`batch --bail`) so later mutating steps do not run after an earlier required step fails; `failFast: false` is the explicit opt-out.
- `qa` must fail fast on failed readiness/text/selector assertions so missing expected text cannot burn the wrapper watchdog before reporting `qa-failure`. `qa.attached` must never erase existing session diagnostics; URL-opening `qa` may clear buffers to scope a fresh page load. Attached QA preserves buffers, reports that scope in `details.compiledQaPreset.checks.diagnosticsResetAtStart`, and defaults diagnostic checks off unless the caller opts into preserved-buffer failure checks.
- Direct artifact workflows must create missing parent directories before spawning upstream and must verify saved files before downstream use. Simple loopback HTTP(S) anchor downloads may be saved directly by the wrapper to the requested path when that avoids upstream random-name download behavior without bypassing authenticated browser credentials. `outputPath` may write a successful result payload to a caller-requested local file and must report `details.outputFile`. Missing non-pending artifacts, including diff screenshot outputs, must never use saved/verified wording; `record start` future files are pending/open until `record stop`, not missing.

### Documentation standard

- Documentation is a core product artifact.
- Docs must be structured, concise, well-linked, and written for humans first.
- Someone opening the repo should quickly understand the goal, purpose, install model, and usage.
- Documents should read as complete documents, not iterative logs, unless they are explicitly meant to be iterative, such as a changelog.
- Requirements, expectations, and durable rules from user conversations should be reflected in the appropriate docs.
- Because direct-binary usage is commonly blocked in normal agent sessions, the repo must carry a local command reference for the effective `agent_browser` surface and keep it in sync with upstream changes.
- Repository verification must include a lightweight command-reference drift check against the targeted installed upstream `agent-browser` version.
- Published package contents should include the canonical user-facing docs plus `LICENSE`.
- Published package contents should exclude agent-only and superseded docs such as `AGENTS.md` and archived drafts under `docs/archive/`.

### Testing guidance

- The primary confidence path is a real `pi` session driven in `tmux`.
- For quick local checkout smoke validation, launch `pi --approve --no-extensions -e .` from the repository root so only the checkout copy loads; do not rely on Pi settings or `/reload` semantics in this isolated mode.
- For hot-reload validation, configure exactly one active source for this extension in Pi settings and launch plain `pi`; validate `/reload` there because it exercises auto-discovered/configured resources.
- Maintain a tmux-driven configured-source lifecycle harness (`npm run verify -- lifecycle`; required before release per `docs/RELEASE.md`) that isolates Pi settings, uses exactly one configured source, exercises `/reload`, full restart plus exact `--session-id` relaunch, and asserts managed-session continuity, persisted artifact survival, and real Pi `tool_result` failure-patch semantics. It remains outside the default `npm run verify` sequence, but it is embedded in `npm run verify -- release` so `prepublishOnly` enforces it before publish unless scripts are intentionally skipped. The harness defaults Pi to model `zai/glm-5.2` (`scripts/verify-lifecycle.mjs`); pass `--model <id>` after `lifecycle` when a different model is required. Keep `docs/RELEASE.md` accurate about the harness behavior, cleanup, transcript retention, and limitations.
- Validate a full `pi` restart with exact `--session-id` relaunch or `/resume` when changes touch managed-session continuity, reload behavior, or persisted artifact paths. Validate branch-backed state changes with the focused `session_tree` harness tests.
- Prefer full `pi` restart over `/reload` when validating extension changes beyond a quick reload smoke check.
- Use `/resume` or an explicit session id/path when needed after restart.
- Keep testing broader than a single smoke site like `example.com`.
- Bounded release smokes that validate this extension should disable auto-loaded skills with `--no-skills`; run skill-enabled dogfood separately only when validating external skill routing or report-generation behavior.
- Maintain a concrete release/package verification workflow in `docs/RELEASE.md` and matching repository scripts.

## Representative use cases

The design should comfortably support workflows such as:

- UI testing and exploratory QA
- web research
- using browser UIs for other LLMs such as ChatGPT, Grok, Gemini, and Claude
- isolated authenticated browser sessions
- headless authenticated `chat.com` / ChatGPT / OpenAI browsing without forcing `--headed` or `--auto-connect`
- upstream profile/debug workflows without adding a local profile-cloning layer in this package
- provider-backed or iOS device launches where upstream owns credentials, env, and setup; the wrapper forwards argv and the parent environment without emulating those backends
- desktop Electron targets using top-level `electron` for discover → isolated launch → attach → probe/cleanup, or raw `args: ["connect", …]` when the operator launches the real app with a debug port for signed-in state (see [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#electron) and [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md#electron-desktop-apps))

## Implications for the implementation

- Package-manifest behavior matters more than repo-local development wiring.
- The extension should use official `pi` hooks and package resources where possible.
- The wrapper should stay thin, with upstream `agent-browser` remaining the source of truth for command semantics.
- Successful and failed tool outcomes should surface bounded machine-readable fields on Pi-facing `details` (`resultCategory`, `successCategory`, `failureCategory`, optional structured `nextActions`, optional `pageChangeSummary` with per-step summaries on `batch`, optional `artifactVerification` with the same shape on successful `batchSteps[]` rows, optional `outputFile`, optional `timeoutPartialProgress`) so agents can branch without parsing prose; stateful commands (`auth`, `cookies`, `storage`, `dialog`, `frame`, `state`) plus other structured diagnostics (for example `network`, `diff`, `trace`, `stream`, `dashboard`, `chat`) and `batch` should redact secret-bearing payloads in model-facing `details.data`, including the compact per-step `batch` roll-up on the parent result (full per-step payloads live on `batchSteps[]`). Dialog/prompt-related timeouts should be bounded with recovery `nextActions`; non-dialog timeouts should prefer best-effort per-step progress and retry payloads when a plan is available; no-op scrolls should expose no-movement state instead of only an upstream success boolean; explicit page/container scroll helpers should expose before/after movement evidence. The contract lives in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details), enums and classifier precedence live in `extensions/agent-browser/lib/results/categories.ts` and `contracts.ts` (also re-exported from `shared.ts`), and presentation-time summaries, redaction, network request follow-ups, and artifact verification rollups are assembled in `extensions/agent-browser/lib/results/presentation.ts` (`buildPageChangeSummary`, command taxonomy predicates from `command-taxonomy.ts`, `redactPresentationData`, `buildArtifactVerificationSummary`, `buildBatchPresentation`).
- User-facing docs belong in `README.md` and the canonical published files under `docs/`.
- Agent workflow and deeper testing procedures can stay in `AGENTS.md`, but published docs must not depend on that file being present.
- When upstream `agent-browser` changes, refresh the local command reference, prompt guidance, and other extension-side docs so agents still have a repo-readable equivalent of the blocked direct-binary help path.
- The canonical agent-facing playbook should live in `extensions/agent-browser/lib/playbook.ts`; README, command-reference, and tool-contract fragments must be generated or checked from that source by `npm run docs -- playbook check` so prompt guidance and docs cannot drift silently.
- Keep mitigations for legacy-skill coexistence simple; do not add extra moving parts unless observed behavior justifies them.
- Prefer narrow, evidence-backed compatibility mitigations over broad stealth layers when a specific upstream site starts rejecting the default headless launch fingerprint.
- Preserve the page that a profiled `open` just navigated to; if restored profile tabs steal focus during launch, the wrapper should best-effort switch back to the returned page URL before handing control back to the agent.
- Once a tab target is known for a session, later active-tab commands should best-effort pin that same tab inside the same upstream invocation when reconnect drift would otherwise land on a restored/background tab.
- If a restored/background tab steals focus after a successful command, the wrapper should best-effort restore the intended target tab again before handing control back.
- On local Unix launches, extension-generated session names should not fail just because the upstream default socket path is too long; the wrapper should choose a shorter socket directory when needed.
- Provider selection flags (`-p`, `--provider`) and provider device flags (`--device`) are launch-scoped like profile, CDP, persisted state, and upstream's `--webgpu` launch preset: if an extension-managed implicit session is already active, the planner must fail fast with the same recovery guidance as other startup-scoped flags instead of silently forwarding argv upstream would ignore; contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#sessionmode) and session model in [`ARCHITECTURE.md`](ARCHITECTURE.md).
- Treat argv-supplied `--allowed-domains` as launch-scoped so it starts in a fresh controllable browser context. Keep upstream 0.32.0 responsible for request/worker/popup/WebRTC containment and incompatible launch-mode rejection; retain the wrapper's final-URL policy check only as defense in depth.
- Upstream restore-state periodic autosave remains upstream-owned. Forward `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS` unchanged, document its 30-second default and `0` disable behavior, and do not duplicate its timer or claim its restore files as wrapper artifacts.
- Read-only upstream `skills list`, `skills get …`, and `skills path …` must stay free of implicit managed `--session` under default `sessionMode: "auto"` (still with `--json`), matching plain-text `--help` / `--version` inspection semantics so bundled skill text does not pin or rotate the active browser session; new `skills` subcommands pick up that behavior only after allowlisting in `extensions/agent-browser/lib/runtime.ts` with regression coverage.
- Optional `semanticAction.session` on native `agent_browser` must compile to a leading `--session <name>` pair before upstream `find` or `select` argv so the shorthand can target a named upstream browser without hand-built `args`, while `buildExecutionPlan` still skips double-injecting the extension-managed implicit session whenever planned argv already starts with `--session`; stale-ref retries for compiled `find` actions and bounded `try-*` candidate `nextActions` must preserve that same prefix. Contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#semanticaction) / [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#sessionmode); implementation in `extensions/agent-browser/index.ts` and `extensions/agent-browser/lib/runtime.ts`.

## Open design questions

- How much session convenience should the extension add by default versus leaving explicit session naming entirely to upstream `agent-browser` semantics?
- Exactly which high-value result renderers belong in v1 beyond screenshots/images and a few compact summaries?
