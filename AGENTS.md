# pi-agent-browser-native

Native `pi` integration of `agent-browser` as a `pi` tool.

## Product-specific guidance

- Do **not** bundle `agent-browser` in this project.
- Assume `agent-browser` is installed separately and available on `PATH`.
- Target the current locally installed `agent-browser` version only.
- Do **not** add backwards-compatibility shims for older upstream versions.
- Keep the integration thin and close to upstream `agent-browser` behavior.
- The primary UX is the agent invoking the native tool directly, not a slash-command-heavy manual workflow.
- Do **not** overengineer or solve hypothetical problems that do not exist in observed behavior.
- Thoroughly check official `pi` docs/examples/source behavior before inventing bespoke integration patterns. Prefer an official `pi` mechanism whenever one exists.
- Prioritize the global install path first. Most users will install this extension globally, not as a project-local extension.
- Keep the local extension-side documentation good enough that an agent can use the tool without relying on direct `agent-browser` binary help; when upstream `agent-browser` changes, update the repo-readable command reference, prompt guidance, README/docs, and any relevant tests in the same work.
- For this repository, assume a single operator model: no human and no other agent is making changes here besides you.
- Treat every lingering scratch file, temp artifact, browser session, tmux session, or other side effect related to this repository as your responsibility to clean up.

## Documentation placement

- Put user-facing product docs in `README.md` and `docs/`.
- Put agent-specific operational notes, workflows, and testing procedures in this `AGENTS.md`.
- Write documents as complete documents, not iterative logs, unless the document is explicitly meant to be iterative such as `CHANGELOG.md`.

## Upstream capability baseline and command reference

When upstream `agent-browser` changes version or help text, keep three layers aligned:

1. **Canonical metadata** — `scripts/agent-browser-capability-baseline.mjs` defines the targeted upstream version, which `agent-browser <args>` help outputs are sampled for drift checks, and which literal tokens must appear in upstream help and in human-written sections of `docs/COMMAND_REFERENCE.md` (grouped as inventory sections). Nothing in this file shells out to `agent-browser`; rebaselining is an explicit maintainer edit after comparing real `--help` output from the installed binary.

2. **Human command guide** — `docs/COMMAND_REFERENCE.md` holds the readable workflows, examples, and constraints. Outside the two HTML-comment bounded generated regions (`upstream-baseline`, `capability-token-baseline`), edits are normal prose. Every human-authored token listed in the baseline must appear somewhere in the doc body so agents searching the repo see real usage, not only generated lists.

3. **Generated blocks** — The baseline checker renders versioned boilerplate into `docs/COMMAND_REFERENCE.md`. After changing the baseline metadata, run `npm run docs -- command-reference write`. Do not hand-edit inside the `<!-- agent-browser-capability-baseline:start ... -->` / `<!-- ...:end ... -->` markers.

Verification stack:

- `npm run docs` (or `npm run docs -- command-reference check`) — generated blocks match `agent-browser-capability-baseline.mjs`.
- `npm run verify -- command-reference` — the above plus live `agent-browser --version` and help sampling against the same baseline (requires the targeted upstream on `PATH`).
- Unit coverage for the verifier and block renderer lives in `test/verify-command-reference.test.ts`.

Release-oriented notes also live in [`docs/RELEASE.md`](docs/RELEASE.md) under pre-release and real-upstream sections.

**Opt-in real upstream contract:** `npm run verify -- real-upstream` runs `test/agent-browser.real-upstream-contract.test.ts` with `PI_AGENT_BROWSER_REAL_UPSTREAM=1` against the real `agent-browser` on `PATH` (must match `scripts/agent-browser-capability-baseline.mjs`). Besides inspection, skills, `open`/`eval --stdin`/`snapshot -i`/`batch`, and managed-session continuity, the suite exercises a representative core command matrix on localhost fixtures (`test/helpers/agent-browser-harness.ts` contract pages), plus `pushstate`, `vitals`, `network route`, `cookies set --curl`, a `react tree` missing-renderer case, and `wait --download` with explicit assertions around upstream save-path reporting versus on-disk presence; see [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-contract-validation) for the async download caveat, temp-directory isolation, output-shape fixture maintenance, and common failure triage (including when to refresh `test/fixtures/agent-browser-real-output-shapes.json`).

### Tool result categories

`agent_browser` results include stable machine-readable fields on `details`: `resultCategory` (`success` | `failure`), plus `successCategory` or `failureCategory` with small fixed enums. The human-facing contract and field list live in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).

- **Source of truth for enums and classifiers:** `extensions/agent-browser/lib/results/shared.ts` (`classifyAgentBrowserSuccessCategory`, `classifyAgentBrowserFailureCategory`, `buildAgentBrowserResultCategoryDetails`). The tool entrypoint merges category details in `extensions/agent-browser/index.ts`; presentation-layer failures also attach categories from `extensions/agent-browser/lib/results/presentation.ts`.
- **Structured follow-ups:** optional `details.nextActions` (and per-step `batchSteps[].nextActions`) are built by `buildAgentBrowserNextActions` in the same `shared.ts` module, then merged into Pi-facing `details` from `extensions/agent-browser/index.ts` and `extensions/agent-browser/lib/results/presentation.ts`. See [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) for the field contract.
- **Page-change summaries:** optional `details.pageChangeSummary` (and per-step `batchSteps[].pageChangeSummary` when a step carries one) compress navigation, mutation, confirmation, and artifact signals into a small struct with `changeType`, `summary`, optional `title`/`url`, artifact fields, and `nextActionIds` that line up with `nextActions`. Types live in `extensions/agent-browser/lib/results/shared.ts` (`AgentBrowserPageChangeSummary`); assembly and the mutation-prone command allowlist are in `extensions/agent-browser/lib/results/presentation.ts` (`buildPageChangeSummary`, `PAGE_CHANGE_SUMMARY_COMMANDS`); successful paths merge from `extensions/agent-browser/index.ts` alongside presentation output.
- **Artifact verification:** optional `details.artifactVerification` and per-step `batchSteps[].artifactVerification` summarize wrapper-checked paths and filtered session-manifest rows (non-`explicit-path` spills) so jobs can branch on counts and per-row `state` without re-statting files. Types live in `extensions/agent-browser/lib/results/shared.ts` (`ArtifactVerificationSummary`, `ArtifactVerificationEntry`); assembly and `classifyPresentationSuccessCategory` live in `extensions/agent-browser/lib/results/presentation.ts` (`buildArtifactVerificationSummary` and helpers). The human field contract is in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).
- **Regression tests:** `test/agent-browser.results.test.ts` locks classifier and next-action behavior; `test/agent-browser.extension-validation.test.ts` asserts `details` on representative tool outcomes; `test/agent-browser.presentation.test.ts` covers batch and presentation wiring.
- **When changing artifact verification:** extend `ArtifactVerificationEntry` / `ArtifactVerificationSummary` and `buildArtifactVerificationSummary` together, refresh `test/agent-browser.presentation.test.ts` and `test/agent-browser.extension-validation.test.ts` expectations, and align [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).
- **When changing categories:** extend the TypeScript unions and classifier in `shared.ts`, update the prose list in `docs/TOOL_CONTRACT.md`, add or adjust tests above, and refresh any benchmark or docs that mention failure-category coverage if the taxonomy changes.
- **When changing next-action recommendations:** update `buildAgentBrowserNextActions` and its unit coverage in `test/agent-browser.results.test.ts`, keep presentation and extension-validation expectations in sync, and align the human contract in `docs/TOOL_CONTRACT.md`. Semantic stale-ref retries appended in `extensions/agent-browser/index.ts` follow the same contract and extension-validation expectations.
- **When changing page-change summaries:** extend `AgentBrowserPageChangeSummary` and `buildPageChangeSummary` together, adjust `PAGE_CHANGE_SUMMARY_COMMANDS` only when the upstream command surface changes, update `test/agent-browser.presentation.test.ts` and any `pageChangeSummary` assertions in `test/agent-browser.extension-validation.test.ts`, and align `docs/TOOL_CONTRACT.md`.

### `semanticAction` shorthand (top-level tool input)

- **Compilation and validation:** `compileAgentBrowserSemanticAction` in `extensions/agent-browser/index.ts` turns the optional `semanticAction` object into upstream `find` argv; it is mutually exclusive with `args` on the same call. Changing allowed actions, locators, or argv shape requires updating the schema beside that helper, the human contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction), examples in [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), and playbook strings in `extensions/agent-browser/lib/playbook.ts` (then `npm run docs -- playbook write`).
- **Stale-ref machine follow-up:** for unified failures classified as `stale-ref` when `details.compiledSemanticAction` is present, `extensions/agent-browser/index.ts` appends `retry-semantic-action-after-stale-ref` to any `details.nextActions` from presentation (after `buildAgentBrowserNextActions` in `shared.ts`). Changing when that append runs, its payload shape, or its safety copy requires updating [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), playbook text if guidance shifts, and `test/agent-browser.extension-validation.test.ts`.
- **Regression tests:** `test/agent-browser.extension-validation.test.ts` asserts compiled argv and pre-spawn validation errors for `semanticAction`.

### Runtime planning (`extensions/agent-browser/lib/runtime.ts`)

This module is **pre-spawn planning only**: it validates raw `args`, derives implicit or fresh managed session names, classifies browser prompts, redacts invocation text, and builds `effectiveArgs` for the upstream binary. It does not spawn processes or touch the filesystem.

- **`buildExecutionPlan`** — Injects `--json`, optionally injects extension-managed `--session` for `sessionMode: "auto"`, applies the ChatGPT headless `--user-agent` workaround when eligible, and returns `validationError` plus a structured `recoveryHint` when launch-scoped flags would be ignored on an already-active implicit session (surfaced to Pi as `details.sessionRecoveryHint` after redaction in `extensions/agent-browser/index.ts`).
- **Command discovery** — `findCommandStartIndex` walks leading tokens using `VALUE_FLAGS` and `GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES` so value-taking global flags ahead of the upstream command word consume their values before the command is identified. A smaller set of global booleans may be followed by an optional `true`/`false` literal; when present, that literal is consumed before command discovery continues. When upstream adds new globals that take a separate argv value before the subcommand, extend those sets; otherwise `parseCommandInfo`, invalid-flag validation, and launch-scoped detection can mis-fire.
- **Launch-scoped flags** — `getStartupScopedFlags` mirrors `LAUNCH_SCOPED_FLAG_DEFINITIONS` (`--auto-connect`, `--cdp`, `--enable`, `--init-script`, `--profile`, `--session-name`, `--state`). `--auto-connect` counts only when enabled (bare or `true`); `--state` after a `wait` command is treated as a wait predicate, not launch state, so it does not force `sessionMode: "fresh"` during implicit reuse.
- **Tab-correction signal** — `hasLaunchScopedTabCorrectionFlag` is a subset (`--profile`, `--session-name`, `--state`) for post-open tab re-selection when restored tabs steal focus; it intentionally excludes `--cdp` and `--auto-connect`.
- **Stateless inspection** — `isPlainTextInspectionArgs` recognizes `--help`, `-h`, `--version`, and `-V`: those calls keep the caller’s argv (no `--json`), skip implicit `--session`, and are ignored when `restoreManagedSessionStateFromBranch` walks prior tool rows. Read-only `skills list`, `skills get …`, and `skills path …` are treated as stateless JSON inspection via `isStatelessInspectionCommand`: `buildExecutionPlan` still prepends `--json` but skips the same implicit-session and fresh-session injection paths as plain-text inspection, so successful results omit managed `sessionName` / `usedImplicitSession` and do not advance session replay. Any new upstream `skills` subcommand only picks up this behavior after it is allowlisted next to `isStatelessInspectionCommand` and covered in `test/agent-browser.runtime.test.ts` (see `buildExecutionPlan limits stateless skills inspection to documented subcommands`).
- **Regression tests** — `test/agent-browser.runtime.test.ts` locks execution-plan injection, launch-scoped blocking, argv edge cases, and related helpers.

Product-facing behavior and rationale live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) under **Session model** / **Launch flags**; agent-visible fields live in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) (`sessionMode`, `sessionRecoveryHint`, `effectiveArgs`).

### Agent browser efficiency benchmark

`scripts/agent-browser-efficiency-benchmark.mjs` is a **deterministic accounting benchmark**: it does not shell out to `agent-browser`, does not launch a browser, and does not read or write Pi sessions. It models representative `agent_browser` call shapes (including optional `stdin` for `batch`) and synthetic model-visible strings to produce comparable totals: scenario success rate, total tool calls, UTF-8 byte volume of model-visible output, stale-ref failure and recovery counts, artifact success count, distinct failure-category coverage, and summed elapsed-time estimates.

- **Run:** `npm run benchmark:agent-browser` prints a Markdown report (default). `npm run benchmark:agent-browser -- --json` prints the same metrics as JSON suitable for saving as a baseline snapshot.
- **Gate:** Default `npm run verify` runs the full unit suite (`test/**/*.test.ts`), which includes `test/agent-browser.efficiency-benchmark.test.ts` for scenario and comparison assertions, but it does **not** execute the standalone benchmark script’s JSON accounting pass. `npm run verify -- benchmark` runs `scripts/agent-browser-efficiency-benchmark.mjs --json` once and then that test module alone; it stays opt-in so release-style gates are not coupled to re-running the script on every default verify.
- **Compare:** `npm run benchmark:agent-browser -- --compare path/to/prior.json` diffs a saved JSON report against the current in-repo scenario set. Exit code `1` means regressions (for example higher tool-call or model-visible byte totals, dropped success rate, missing failure categories) or unreadable comparison input; see the script’s `usage()` text for full exit codes.
- **Evolving the benchmark:** scenarios and `CURRENT_BENCHMARK_VERSION` are defined in the script. Adding, removing, or renaming scenarios—or bumping the version—requires updating `test/agent-browser.efficiency-benchmark.test.ts` and any prose that cites specific scenario ids.

### Maintainer rebaselining workflow

Use this sequence when upstream ships a new `agent-browser` version or help text changes enough to break the live verifier:

1. Capture real `agent-browser … --help` output from the binary you intend to target, then edit `scripts/agent-browser-capability-baseline.mjs`. That file is import-only metadata; it never shells out to `agent-browser`, so rebaselining stays an explicit maintainer decision.
2. Keep `docs/COMMAND_REFERENCE.md` human prose aligned with the baseline: every inventory token the baseline expects in the doc must appear **outside** the two generated regions (`upstream-baseline`, `capability-token-baseline`). `scripts/verify-command-reference.mjs` strips those generated blocks and fails if any required token is missing from the remaining Markdown.
3. Regenerate the HTML-comment bounded blocks with `npm run docs -- command-reference write`. If you also changed playbook source in `extensions/agent-browser/lib/playbook.ts`, refresh every generated doc fragment in one shot with `npm run docs -- write` (runs playbook drift rewrite plus command-reference rewrite).
4. Before committing, run `npm run docs` (or `npm run docs -- command-reference check`) so checked-in blocks cannot drift from the baseline file.
5. When the targeted `agent-browser` is available on `PATH`, run `npm run verify -- command-reference`. It enforces `agent-browser --version` against the baseline, re-samples each `helpCommands` invocation for expected upstream tokens, and repeats the human-token scan against `docs/COMMAND_REFERENCE.md`.

## Preferred testing workflow

Use an end-to-end interactive `pi` run inside `tmux`.

### Rules

- Use two distinct validation modes and do not mix their assumptions:
  - **Quick isolated mode:** launch `pi --no-extensions -e .` from this repository root. Pi settings and auto-discovered extension sources are intentionally bypassed; use this for checkout-only smoke tests and restart the `pi` process after extension edits instead of treating `/reload` as the validation target.
  - **Configured-source lifecycle mode:** run the opt-in `npm run verify -- lifecycle` harness for deterministic regression coverage, or configure exactly one active source for this extension in Pi settings and launch plain `pi` for manual validation. Use this mode when validating `/reload`, restart, and `/resume` behavior because `/reload` exercises auto-discovered/configured resources.
- For code changes, an isolated `pi --no-extensions -e .` smoke session is a pre-commit requirement; whoever made the changes should validate unpublished checkout behavior there before commit/push (a published install alone is not a substitute).
- For installed-package validation after publish: update the real installed package, then exercise it with only the published package active—either temporarily disable/remove the checkout path and run plain `pi` for lifecycle validation, or use an isolated ephemeral smoke run like `pi --no-extensions -e npm:pi-agent-browser-native@<version>`.
- Use `tmux` via bash commands.
- Do **not** use the pi interactive shell extension for this workflow.
- Drive `pi` like a real user by sending prompts normally.
- The extension blocks direct `agent-browser` bash calls by default to push agents toward the native tool. During this package's own development, the guard is bypassed when the session cwd is this package root (`package.json` name `pi-agent-browser-native`) or when `PI_AGENT_BROWSER_ALLOW_DIRECT_BASH=1` is set, so upstream CLI behavior can be debugged directly.
- After extension changes in configured-source lifecycle mode, `/reload` is the minimum, but a full close-and-relaunch of `pi` is preferred for higher confidence. The automated `npm run verify -- lifecycle` harness creates an isolated `PI_CODING_AGENT_DIR`, configures a temporary package source, drives plain `pi` in `tmux`, uses a deterministic fake upstream `agent-browser`, checks `/reload` plus restart/`/resume`, and captures transcript artifacts on failure.
- If continuing the same conversation after restart, use `/resume` or an explicit session path/id.
- Resumed sessions should reflect the updated configured extension source after restart.

### Practical tmux notes

- Prefer `tmux send-keys ... Enter` for prompt submission.
- Capture larger pane ranges when debugging: `tmux capture-pane -p -S -300 -t <session>:0.0`.
- Clean up tmux sessions after testing.
- Before ending a turn, sweep for and remove repo-local scratch files, project-scoped temp artifacts, and lingering browser sessions created during the work unless the user explicitly asked to keep them.
- Do not overfit testing to `example.com`; use it for smoke checks only, then validate against additional realistic pages and flows. The lifecycle harness intentionally uses a fake upstream browser for deterministic lifecycle assertions and does not replace occasional real-browser manual smoke testing before release.

## Current testing focus

Before calling the first implementation usable, verify at minimum:

- missing-`agent-browser` error path is clear
- native tool invocation works from interactive `pi`
- `open` works
- `snapshot -i` works
- `click` works
- `batch` via stdin works
- `eval --stdin` works
- screenshot attachment works
- implicit session reuse works
- explicit `--session` passthrough works
- configured-source `/reload` picks up changed extension code
- full restart + `/resume` picks up changed extension code
