# Release and package verification

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`ELECTRON.md`](ELECTRON.md)
- [`platform-smoke.md`](platform-smoke.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- Bounded `agent_browser` outcome metadata on `details` (`resultCategory`, `successCategory`, `failureCategory`, optional `nextActions`, optional `pageChangeSummary` with per-step summaries on `batch`): contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); maintainer checklists under “Tool result categories” and “Page-change summaries” in [`../AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- Post-success `get text` selector visibility (`RQ-0074`): optional `details.selectorTextVisibility` / `selectorTextVisibilityAll`, visible warnings, and `inspect-visible-text-candidates*` next actions after read-only visibility probes—[`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details), and [`../AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) maintainer checklist
- Managed-session outcomes (`RQ-0077`): after extension-managed implicit or fresh `--session` injection reaches process execution, `details.managedSessionOutcome` records the transition (`created` / `replaced` / `unchanged` / `closed` on success; `preserved` / `abandoned` when a plan fails before a new session becomes current). Failing `sessionMode: "fresh"` calls and successful replacements whose old-session close fails also append model-visible `Managed session outcome: …`—[`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details), [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md), [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), and [`../AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) maintainer checklist
- Stateful context commands (`cookies`, `storage`, `auth`, `dialog`, `frame`, `state`) and aggregate `batch` results: model-facing `details.data` is summarized or redacted per [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); aggregate `batch` replaces top-level `details.data` with a compact per-step matrix (`success`, argv-redacted `command`, redacted `result` or scrubbed `error`) while full per-step payloads, artifacts, and categories remain on `batchSteps[]`—operational notes in [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md#use-stateful-browser-context-commands-safely), assembly in `extensions/agent-browser/lib/results/presentation/batch.ts`

## Purpose

Provide one concrete maintainer workflow for validating repo state, package contents, and install guidance before publishing `pi-agent-browser-native`.

## Current 0.6.16 rollout waiver

The owner's 2026-09-21 **“waive windows”** instruction makes Windows qualification nonblocking for this rollout, even with available runners, and supersedes older mandatory-Windows/no-waiver wording below and in platform guidance. Preserve failed diagnostics; do not claim a Windows full-suite pass or continue Windows repair experiments. Known policy-lock/restored Electron failures and bounded repeat results are tracked in [#191](https://github.com/fitchmultz/pi-agent-browser-native/issues/191) and the [current support matrix](SUPPORT_MATRIX.md#current-0616-rollout).

Linux/macOS, declared Node floors, official/fork host and consumer-artifact checks, and Native checkpoint Linux remain required. All three final reviewers (reviewer-gpt, reviewer-ponytail, reviewer-claude) must approve before merge, release or activation. This waiver changes neither runtime nor the composed `release`/`prepublishOnly` scripts: record individually satisfied gates and the explicit Windows waiver, never label the full composition passed.

Docs/workflow-only changes may reuse prior live/platform evidence when the complete compiled runtime, runtime dependencies and relevant tests are unchanged. Changed published files require a new retained tarball checked by `verify-package.mjs --smoke-pi`, including runtime-only SDK and actual CLI loading. Publish those exact checked bytes without repacking.

## 0.7 upgrade and rollback

The 0.7 tool contract is breaking: direct argv stays compact, `script` moves to `agent_browser_code.code` with a persistent browser, the job DSL is replaced by native batch/code, and five advanced tools use flat schemas after native activation. Publish with the [migration map](TOOL_CONTRACT.md#07-migration), not a parallel legacy public route. Preserve saved auth, explicit files, and Pi journals. Existing strict pre-0.7 isolated-script leases are only read for cleanup.

Before activating the update, finish or inspect in-flight mutations/recordings and restart every cooperating Pi process onto the same package. `/reload` alone is not reliable for picking up rebuilt compiled code. Mixed versions do not share the new execution-ordering guarantee.

Rollback is package-level: select the exact previously installed 0.6 release with `pi install npm:pi-agent-browser-native@<previous-0.6-version>`, then fully restart participating Pi processes with their existing session files. Do not delete auth/profile/state files, artifacts, or transcripts. The older package cannot interpret all new inner-transition records; inspect the live URL and obtain fresh refs before further actions. Rollback does not reverse submitted browser actions, stop external clients, or restore JavaScript variables.

### Changed-path qualification

The minimum Pi runtime is 0.87.0, matching the native APIs used by the new tool contract. Wildcard peers remain host-owned dependency declarations, not support for older runtimes.

Qualify official Pi 0.87 and the fork independently with the existing host/package/lifecycle infrastructure. Required evidence for the redesign includes compact schema and additive activation/history, native prompt sections, shared direct/code auth continuity, fresh JavaScript globals, selected real images and conservative geometry, visible handled failures/exact recovery, real cross-process helper/action and whole-cell ordering, cancellation/reaping, and ordered transition replay after interruption/branch changes. Retain native batch and advanced action/QA/Electron/source outcome coverage. Small synthetic timing comparisons are not universal performance claims or sandbox certification.

Existing owner waivers remain authoritative. Windows qualification is waived; report diagnostic failures without claiming a pass or restarting waived repair work. GitHub Actions remains disabled under the current explicit owner instruction; use the authorized local checks and review evidence, and label CI as not run rather than passed. This does not revoke other approved verification or authorize unrequested platform work.

## Pre-release checks

From the repository root:

```bash
npm install
npm run doctor
npm run check:platform-smoke
npm run smoke:platform:ubuntu-image
npm run smoke:platform:doctor
npm run verify -- release
```

`npm run doctor` is a read-only first-run diagnostic for PATH, targeted upstream version, the minimum Pi runtime floor, and duplicate package/checkout source conflicts. The package keeps Pi core imports as wildcard `peerDependencies` because installed Pi package docs require the host Pi install to provide those packages, while the doctor fails setup when `pi --version` is below the enforced floor. It does not replace upstream `agent-browser doctor` for browser runtime health and does not edit Pi settings.

For PR-ready local confidence before release-only lifecycle and platform cost, run:

```bash
npm run verify -- pre-pr
```

`pre-pr` composes the default gate with `npm run verify -- package`: generated docs, clean `dist/` build, TypeScript, the full unit/fake suite, live command-reference sampling, and package-content verification. It intentionally does not run lifecycle, packaged Pi smoke, Crabbox platform smoke, startup-profile, real-upstream or dogfood modes.

`npm run verify -- release` runs:

1. `npm run verify` for generated playbook drift, TypeScript, unit/fake coverage, command-reference generated-block drift, and live command-reference verification against the targeted upstream on `PATH`
2. `npm run verify -- lifecycle`, which launches the configured-source lifecycle harness for `/reload`, exact `--session-id` relaunch, managed-session continuity, persisted spill reachability, and Pi failure-patch behavior
3. `npm run verify -- package-pi`, which first validates package contents via `npm pack --json --dry-run` and then smoke-loads the packed package in Pi isolation
4. `npm run smoke:platform:doctor` and the full Crabbox matrix from [`platform-smoke.md`](platform-smoke.md): macOS SSH, Ubuntu local-container, and native Windows Parallels targets running fast target-local `platform-build` plus `browser-dogfood-smoke`

When using the documented, maintainer-approved [local macOS and hosted native-Windows alternatives](platform-smoke.md#alternate-native-transports), run and inspect those target-local suites separately alongside the remaining release checks. The default composed gate is unchanged; alternate evidence must not be labeled a passing Crabbox matrix.

`npm publish` runs npm’s `prepublishOnly` script from `package.json`, which executes the same `npm run verify -- release` gate and then `npm pack --dry-run`. That concatenated gate is everything in the default `npm run verify` step (generated playbook drift, clean `dist/` build, TypeScript, the unit/fake suite, generated command-reference blocks, and live upstream command-reference sampling against the targeted `agent-browser` on `PATH`), the configured-source lifecycle harness, the packaged Pi smoke in `package-pi`, and the release-blocking Crabbox platform matrix. Using `npm publish --ignore-scripts` skips that contract intentionally.

`prepublishOnly` intentionally does **not** run the standalone host-only `npm run verify -- startup-profile`, `npm run verify -- real-upstream`, `npm run verify -- dogfood` modes; those remain separate `npm run verify` modes in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs). The platform matrix includes its own fast target-local build/package gate and browser dogfood suite, and is automated through the `release` slice.

Run the opt-in startup profiler whenever package layout, the compiled entrypoint, top-level imports, schema registration, or prompt/config startup logic changes:

```bash
npm run build
npm run verify -- startup-profile --samples 3
```

The profiler first clean-builds `dist/`, then records only direct package entrypoint import/factory timing in fresh Node processes, writes `.artifacts/startup-profile/latest.json`, and includes a safety block confirming it did not launch Pi, tmux, mise, npm, browsers, or `agent-browser`. Full Pi TUI ready-prompt profiling is intentionally excluded because repeated real Pi/tmux launches proved too invasive for routine verification on the operator machine.

For a deterministic host-only real-browser wrapper smoke without model choice in the loop, run:

```bash
npm run verify -- dogfood
```

For direct Crabbox diagnostics outside the full release compose, run the [required platform gate](platform-smoke.md#required-release-gate) (`check:platform-smoke`, `smoke:platform:ubuntu-image`, `smoke:platform:doctor`, `smoke:platform:all`) from [`platform-smoke.md`](platform-smoke.md), then inspect provider leases:

```bash
crabbox list --provider local-container
crabbox list --provider parallels
```

The Crabbox gate is only green when suite assertions and artifact manifests under `.artifacts/platform-smoke/` are green and no unexpected lease/clone remains.

The deterministic dogfood mode clean-builds the compiled package, uses the extension harness and real `agent-browser` on `PATH` against a deterministic loopback HTTP fixture, then verifies persistent browser code aggregation, flat advanced QA/actions, native batch, screenshot artifact verification, and explicit session close. Use `npm run verify -- dogfood --keep-artifacts` or `--artifact-dir <path>` only while debugging, then delete retained screenshots. This smoke complements, but does not replace, human-readable interactive transcript evidence.

Every release also requires interactive `tmux`-driven Pi dogfood with the native `agent_browser` tool against real sites. For extension-focused release smokes, use `pi --approve --no-extensions --no-skills -e .` from the trusted checkout before publish so auto-loaded dogfood/QA skills cannot replace the bounded smoke workflow; omit `--approve` only when the smoke is explicitly testing Pi's Project Trust prompt. Run separate skill-enabled dogfood only when validating skill routing or report-generation behavior. Drive prompts with `tmux send-keys`, exercise at least one simple static site and one real documentation/product site, include advanced QA, code, or native batch when those surfaces changed, close every opened browser session, remove screenshots/temp artifacts, and record the outcome in the release notes or support-matrix evidence. Do not paste raw multi-line prompts into a tmux Pi pane: plain newlines submit separate queued user messages. For scripted smoke driving, collapse prompt files to one line before sending (`PROMPT=$(tr '\n' ' ' < /tmp/smoke-prompt.md); tmux send-keys -t "$SESSION":0.0 -l "$PROMPT"; tmux send-keys -t "$SESSION":0.0 Enter`). For manual multi-line editing, use Pi's external editor shortcut (`Ctrl+G`) or configure tmux extended keys so Pi can receive `Shift+Enter` for newlines; see the installed Pi `docs/tmux.md` guidance. Automated localhost, fake-upstream, and deterministic dogfood gates do not replace this human-readable live-site transcript evidence. When code changes, add a persisted-session `agent_browser_code` pass that aggregates at least two real pages, exercises a conditional branch, compares selected output with an ordinary-call baseline, verifies selected screenshot bytes reach the model, and checks browser/auth continuity on a later direct/code call with fresh JS globals. Review ordered custom transition entries and interrupted/replayed state, not only the outer result. Exercise handled failures, timeout/cancellation, whole-cell ordering, and child reaping; close only test-owned browsers afterward and retain Pi transcripts. Never use `--no-session` for code dogfood. When `agent_browser_web_search` or package config changed, add one key-free smoke proving the optional tool is absent without config, one fake/unit-backed smoke in the default suite, and one opt-in live Exa or Brave Search check with a real key while confirming the key does not appear in transcripts, stdout/stderr, config status, PR text, or artifacts. When `electron.*` surfaces, attached-session diagnostics, or `qa.attached` changed, add a local Electron pass: `electron.list` → `electron.launch` (expect isolated profile behavior) → `snapshot -i` or `electron.probe` / `qa.attached` → `electron.cleanup` with the returned `launchId`, verifying status/mismatch guidance if you simulate a dead renderer or stale refs. For dense-dashboard stress coverage, use the [public Grafana stress checklist](#public-grafana-stress-checklist) below; it is a maintainer workflow, not bundled product skill or recipe runtime.

When reviewing saved session JSONL after a failed smoke or QA reclassification, expect browser tool rows to carry `isError: true` whenever `details.resultCategory` is `failure`. The model-visible observation must also report failure. Canonical JSON stays parseable; Pi's error patch must not append prose to it. The extension applies that patch on the `tool_result` path so Pi’s transcript matches the wrapper contract ([`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details)). Preserve a normal Pi session directory for those checks; avoiding `--no-session` keeps this evidence intact ([`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) preferred validation workflow).

The configured-source lifecycle regression harness is required before release because it launches an interactive Pi 0.87.0+ process under `tmux` with `--approve` and validates `/reload`, full relaunch with the same exact `--session-id`, managed-session continuity, persisted artifacts, compiled-entrypoint pickup after process restart, and Pi failure-patch behavior. Branch-backed `session_tree` rehydration and cleanup ownership are validated by focused extension harness tests:

```bash
npm run verify -- lifecycle
```

Use `npm run verify -- lifecycle --keep-artifacts` when debugging failures, then remove retained artifacts after inspection.

## Public Grafana stress checklist

Use this optional-but-recommended checklist when a release touches dashboard behavior, snapshots, refs, scroll, comboboxes, artifacts, network diagnostics, recording, or prompt guidance. It keeps the useful public Grafana dogfood target repeatable without bundling private dogfood/VFR skills or adding a reusable browser recipe layer.

Target:

```text
https://play.grafana.org/d/nodes/linux-node-overview?var-datasource=grafanacloud-prom
```

Public panels may show No data. Verify the rendered dashboard and controls; this UI checklist does not certify metric ingestion.

Minimum pass:

1. Open the URL with the native `agent_browser` tool in a fresh session.
2. Run `snapshot -i`; confirm the output is useful on a dense dashboard, including high-value controls and bounded spill behavior when needed.
3. Exercise one dashboard scroll path. If page-level `scroll` does not move visible content, confirm `details.scrollNoop` / next actions or equivalent guidance points to snapshot/screenshot verification and nested-scroll recovery.
4. Exercise one explicit combobox-targeted action such as a role/name `agent_browser_action` on a dashboard variable. If it only focuses the field, confirm `details.comboboxFocus` / next actions point to `snapshot -i`, `press ArrowDown`, and `press Enter` when the closed-state evidence qualifies.
5. Capture at least one screenshot artifact and verify `details.artifactVerification` before using the file.
6. If `ffmpeg` is on `PATH`, run `record start` / visible interaction / `record stop` and verify the video artifact. Native 0.37 checks ffmpeg before start; older natives may instead return pending output plus `details.recordingDependencyWarning`. Neither is usable recording evidence. Short/cold 0.37 captures have failed on Ubuntu while explicit 12-second fixture captures encoded successfully; record capture duration and every failed attempt, and never treat an empty file as a captured frame.
7. Inspect `network requests`, `console`, and `errors` summaries. Treat Grafana Play-side noise such as analytics/Sentry requests, public-demo 403s, and console errors as site noise unless the wrapper leaks secrets, hides actionable failed rows, misclassifies artifacts, or suggests unsafe follow-ups.
8. Close the browser session and delete temporary screenshots, HARs, recordings, and scratch reports after extracting any release evidence.

Record release evidence as a short note with: date, package/checkout source, target URL, browser command families exercised, artifacts collected and cleaned up, known Grafana-side noise observed, and any product findings converted into CueLoop tasks. Do not commit private dogfood scripts, VFR harness files, raw browser profiles, HARs, videos, or `.dogfood/` run output as product docs.

## Public Sauce Demo checkout smoke prompt

Use this validation prompt after changing click enrichment, tab pinning, ref preflight, form-fill batching, artifact handling, recording, or prompt guidance. It is intentionally more stateful than `example.com` and uses a natural user-style request so the transcript shows what the agent chooses on its own. Do **not** mention `agent_browser`, snapshots, refs, `batch`, `eval`, or upstream command names in the prompt; those are evaluator expectations, not user instructions.

Run it in an isolated checkout session with skills disabled so the run validates the extension browser workflow instead of external dogfood/QA skill routing. It is fine to restrict active tools at launch so the checkout extension is the only browser surface, but keep those launch details out of the user prompt:

```bash
pi --approve --no-extensions --no-skills -e . --model openai-codex/gpt-6-astra:low --tools agent_browser,agent_browser_code,agent_browser_tools --session-dir "$SESSION_DIR"
```

Repeat with the task's chosen Astra reasoning level when validating instruction-following robustness. Use unique temp paths for each run and delete them afterward. Run separate skill-enabled dogfood sessions only when the thing under test is skill integration, not this bounded release smoke.

Submit the prompt as one Pi message. In tmux automation, write it to a temp file with placeholders replaced, collapse newlines to spaces, and send that one line; for manual multiline entry, use Pi's `Ctrl+G` external editor or a tmux setup that preserves `Shift+Enter` newlines. Do not paste the raw block into a tmux pane line-by-line.

Copy/paste prompt, replacing the two artifact placeholders with exact absolute paths:

```text
Please run a bounded release smoke check on the public Sauce Demo store. This is not an exploratory bug hunt or dogfood report.

Site: https://www.saucedemo.com/
Demo credentials: standard_user / secret_sauce

Use a clean browser context, not my personal Chrome profile.

Scenario:
- Log in.
- Sort products by price low to high.
- Add at least two products to the cart.
- Open the cart.
- Start checkout with a fake name and postal code.
- Stop on the checkout overview page; do not place the order.

Please gather enough evidence to support the smoke result:
- Save a screenshot here: <ABSOLUTE_SCREENSHOT_PATH>.png
- Save a short screen recording here if recording is available: <ABSOLUTE_RECORDING_PATH>.webm
- Include the final page title/URL, the selected sort order, cart contents, item total/tax/total, and any browser-side network, console, or page-error issues you see.
- Clean up by closing the browser when finished.

Return a concise PASS/FAIL report with evidence and any tool or workflow issues you noticed. Do not create a dogfood-output report directory.
```

Evaluator expectations after the queued Sauce Demo fixes: the agent should independently choose efficient, safe browser operations; native add-to-cart clicks should mutate cart state without the agent authoring `eval`/DOM-click fallbacks (the wrapper may fail with `details.clickDispatch` when upstream reports click success but no trusted DOM event reached the target); same-snapshot form fills may be batched safely when the agent chooses that route; the selected sort order should be verified; checkout must stop before Finish and must not place the order; the agent must not attempt Finish or another likely final submit action because prompt stop-boundaries are agent responsibility rather than wrapper-enforced business-intent policy; screenshot and recording must use the requested paths or be explicitly reported unavailable, and close should be blocked with `details.promptGuard.reason: "requested-artifacts-missing-before-close"` until required screenshot paths are verified; `network requests` may show public-demo telemetry 401s; `console` may report offline-cache logs; `errors` should show no page errors; and the browser session plus temp artifacts should be cleaned up after evidence is recorded. A run that reaches `checkout-complete.html` or silently substitutes artifact paths is a workflow failure even if other store flow steps work.

## What package verification checks

`npm run verify -- package` confirms that:

- no repo-local `.pi/extensions/agent-browser.ts` autoload shim is present
- `LICENSE` exists in the repo and the packed tarball
- canonical published docs are present
- `npm pack --json --dry-run` runs the package `prepare` build once and packs the compiled `dist/extensions/agent-browser/index.js` entrypoint
- GitHub/source installs use the same `prepare` build; when Pi installs with `npm install --omit=dev`, `scripts/prepare.mjs` installs source-build dev dependencies with lifecycle scripts disabled before building so Pi can load the ignored compiled entrypoint from a fresh clone
- the package-level doctor command and capability baseline are present
- compiled extension runtime files are present, including the split result-rendering modules required by the compiled extension entrypoint
- source-only, agent-only, and superseded docs are absent from the tarball

`npm run verify -- package-pi` runs the same package-content checks and additionally confirms that:

- the packed package can be loaded through Pi SDK resource loading with the same isolation principle as `pi --no-extensions -e <package-source>`
- direct/code/loader tools and inactive advanced tools register without requiring optional search config; explicit host selection remains honored
- any optional companion tools remain governed by their own configuration gates
- the registered `agent_browser` source resolves inside the extracted packed package path, not the working checkout
- the packaged `agent_browser` tool can be executed through Pi's loaded native tool definition with a deterministic fake upstream `agent-browser --version` binary

The packaged execution smoke intentionally uses a temporary fake `agent-browser` binary and the `--version` inspection path. It proves first invocation of the packaged Pi tool without launching a real browser. Real browser coverage remains part of local checkout validation and post-publish install validation.

Current forbidden packed files include:

- `AGENTS.md`
- `.pi/extensions/agent-browser.ts`
- TypeScript extension source and other test/repo-only maintenance files

For a full packed file listing:

```bash
npm run verify -- package --list-files
```

## Local development validation

Before publishing, validate both local-checkout modes without mixing their assumptions.

### Quick isolated checkout smoke test

1. Install `agent-browser` separately.
2. Launch `pi --approve --no-extensions -e .` from this trusted repository root. Omit `--approve` only when testing Pi's Project Trust prompt.
3. `--no-extensions` disables automatic extension loading only; settings, configured package resolution, and other resource types remain active. For isolated test settings, use temporary `HOME` and `PI_CODING_AGENT_DIR` directories with `PI_OFFLINE=1`, providing only the model credentials the smoke needs.
4. Confirm the checkout package loads the compiled `dist/extensions/agent-browser/index.js` entrypoint (run `npm run build` first after source edits).
5. Run a smoke prompt that exercises `agent_browser`.
6. Restart Pi after extension edits; configured-source `/reload` is a separate validation mode.

For expanded-surface validation, the smoke prompt should cover native tool invocation rather than shelling out to `agent-browser`: `--version`, `--help`, `skills list`, `skills get core --full`, `open` with `sessionMode: "fresh"`, `snapshot -i`, `click`, flat `agent_browser_action` after enabling `action` (including unique accessible select and explicit session routing), `eval --stdin`, `batch` via stdin, `agent_browser_code`, advanced QA, and experimental source/network tools after loader activation, `screenshot <path>`, explicit `--session … open` plus `--session … close`, `network requests`, `console` / `errors`, `diff snapshot`, `stream status` plus `stream disable`, `dashboard start` plus `dashboard stop`, and `chat <message>` (credential failure is acceptable evidence of wrapper pass-through when `AI_GATEWAY_API_KEY` is intentionally unset). Clean up any opened browser session with `close`, remove temporary files, and kill the tmux session before ending validation.

This checklist assumes a real `agent-browser` on `PATH`. It complements, but does not overlap, `npm run verify -- lifecycle`: that harness swaps in a fake upstream binary and focuses on `/reload`, exact `--session-id` relaunch, managed-session continuity, spill-path persistence, and Pi `tool_result` failure-patch semantics (`scripts/verify-lifecycle.mjs`), not the full command matrix above.

When a smoke or dogfood run fails after `sessionMode: "fresh"` (missing binary, timeout, upstream error, or **`qa`** preset reclassification), read `details.managedSessionOutcome` before assuming which managed session the next default `sessionMode: "auto"` call will follow; the same struct can appear without the extra `Managed session outcome: …` prose line on `"auto"` failures. Field-level semantics and append ordering relative to other diagnostic tails are documented in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) and the session-mode notes in [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md).

### Configured-source lifecycle validation

Run the automated harness for deterministic configured-source lifecycle regression coverage (required before publish together with the other [Pre-release checks](#pre-release-checks)):

```bash
npm run verify -- lifecycle
```

The harness creates an isolated `PI_CODING_AGENT_DIR`, writes settings with exactly one temporary configured package source, runs `pi` in `tmux` with `--approve`, default model **`zai/glm-5.2`**, and a deterministic `--session-id`, puts a deterministic fake `agent-browser` first on `PATH`, starts an explicit `sessionMode: "fresh"` managed browser, drives `/reload`, closes Pi, and relaunches with the same exact session id instead of typing `/resume`. It also asserts the JSONL session header id, same-page managed-session continuity, compiled JS code pickup after full process relaunch, persisted spill reachability, and real Pi `tool_result` failure-patch semantics for a QA reclassification. Per-step tmux waits default to **180000 ms** (three minutes) in [`scripts/verify-lifecycle.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/verify-lifecycle.mjs) (`DEFAULT_TIMEOUT_MS`); override with `--timeout-ms <ms>` when slower models or cold starts need more headroom. Override the model when needed:

```bash
npm run verify -- lifecycle --model openai-codex/gpt-5.5:minimal
```

Combine flags in one invocation when both apply (order after `lifecycle` is flexible as long as each value-taking flag is immediately followed by its value):

```bash
npm run verify -- lifecycle --model openai-codex/gpt-5.5:minimal --timeout-ms 600000
```

It retains Pi transcripts and evidence, and removes disposable runtime inputs after success. It does not replace occasional real-browser manual smoke testing.

**Lifecycle triage:** page checks require the first completed tool result to report a successful expected command and observed `data.url` (open) or `data.origin` (snapshot); recovery text and remembered targets are not page evidence. A cold post-quit `tab-drift` remains a continuity failure: upstream restores storage, and the wrapper must reopen the recorded URL after confirming shutdown before the first current-page read. Verify both empty storage and origin storage at non-root URLs and hash-routed URLs, including after `tab list` or explicit HTTP reads start the daemon and in batches with non-page prefixes, plus fresh refs and main-frame scope. A blank page, an origin root, or a URL mentioned only in an error is not the remembered page. Explicit URL QA recovery does not satisfy the same-page snapshot requirement; URL reopening does not recover unsaved forms, JavaScript memory, or history. A timeout on sentinel `v2` after exact-session relaunch means the new compiled entrypoint did not load after process restart. A reload-step timeout or missing post-reload snapshot often means Pi rejected reload while the TUI still showed `Working…` (`Wait for the current response to finish before reloading`), even when the session JSONL already has a final assistant message. Re-run with `--keep-artifacts --verbose`, inspect the retained pane capture, and confirm the configured model follows tool prompts reliably. Slower models may need a higher `--timeout-ms` than the **180000 ms** default.

### Environment and automation pitfalls

These show up often in cloud dev boxes and scripted smokes; they are maintainer notes, not product defects.

| Topic | What to watch for | Mitigation |
| --- | --- | --- |
| **Pi CLI vs repo devDependencies** | Global `pi` older than the minimum Pi runtime floor for the release can change TUI behavior, `/reload`, package installs, and tool routing during lifecycle or checkout smokes. | Run `npm run doctor` and align `pi` with the current audited baseline before release gates (`pi update` or install the matching version). The published peer range stays wildcard per Pi package docs, and the doctor enforces the minimum Pi runtime floor before package validation. |
| **npm lockfile (`packageManager`)** | `package.json` pins **npm@11**. npm 10 may only strip optional `libc` metadata on `@esbuild/*` platform entries in `package-lock.json` (no dependency version change). Private registry proxies can also leak organization URLs into `resolved` entries. | Prefer `npx -y npm@11.14.0 install` when refreshing the lockfile; do not commit npm-10-only churn or WorkOS/private-registry URLs. |
| **`pi -p` / print mode** | Non-interactive `pi -p` may hang or emit no stdout for long real-browser smokes without a TTY. | Use **tmux**-driven interactive `pi` for release evidence and checkout smokes; reserve `-p` for short, non-browser checks. |
| **Real-browser cleanup** | `real-upstream`, Sauce Demo, and live-site runs can leave defunct Chrome/`agent-browser` children if a session aborts mid-flow. | Close via `agent_browser` / `agent-browser` `close`, kill stray tmux sessions, and remove temp screenshots/HARs under `/tmp` or your chosen artifact dirs. |
| **Automated prompt driving** | Grepping tmux pane text for words that also appear in the **user** prompt (`PASS`, `FAIL`, `checkout overview`, `Smoke result:`) can false-complete before the agent finishes. | Wait for pane idle (no `Working…`), `agent_browser close` / `Artifact lifecycle`, or JSONL tool results—not instruction phrases copied from the prompt. |
| **Lifecycle verify flags** | `npm run verify -- lifecycle --model` or `--timeout-ms` without the next argv token fails fast with a usage error—the `project.mjs` facade validates passthrough the same way as `scripts/verify-lifecycle.mjs`. | Always pair flags with values (`--model openai-codex/gpt-5.5:minimal`, `--timeout-ms 600000`) or omit `--model` / `--timeout-ms` to keep the harness defaults (`zai/glm-5.2`, **180000 ms** per-step waits). |

Manual validation remains useful for release confidence and installed-package checks:

1. Configure exactly one active source for this extension in Pi settings: this checkout path before publishing, or the installed package after publishing.
2. Launch plain `pi` so extension discovery is active.
3. Validate managed-session continuity with `/reload` and a full restart plus exact `--session-id` relaunch or `/resume`.
4. Re-check local extension-side docs (`README.md`, `docs/COMMAND_REFERENCE.md`, `docs/TOOL_CONTRACT.md`, including the [`agent_browser_action`](TOOL_CONTRACT.md#agent_browser_action) rules when that shorthand or upstream `find` / `select` behavior changes) and regenerated prompt fragments from `extensions/agent-browser/lib/playbook.ts` via `npm run docs -- playbook check` or `npm run docs`. When the upstream `agent-browser` version or help surface changed, run `npm run verify -- command-reference`.

### Real upstream contract validation

The default `npm test` and `npm run verify` paths use fast deterministic tests and fake binaries. For a focused single-file rerun, use `npx tsx --test test/<file>.test.ts`; `npm test -- test/<file>.test.ts` still runs the package script's full glob. When a change touches upstream command planning, result presentation, managed-session behavior, or the canonical capability baseline, also run the opt-in real-upstream contract suite:

```bash
npm run verify -- real-upstream
```

That npm script sets `PI_AGENT_BROWSER_REAL_UPSTREAM=1` for the test process. To run `test/agent-browser.real-upstream-contract.test.ts` directly (for example with `node --test` and `tsx`), set the same variable yourself; the suite is skipped when it is unset.

This suite requires the installed stable `agent-browser --version` to meet the minimum in `scripts/agent-browser-target.mjs`; the output-shape fixture and command-reference verifier remain aligned to the current recommended baseline. It serves fixture pages from localhost and checks stable `details`/`data` keys via `test/fixtures/agent-browser-real-output-shapes.json`. Coverage groups:

- **Inspection and skills (stateless JSON):** `--version`, `--help`, `snapshot --help`, `skills list`, `skills get … --full` (including `webmcp-gen` on the 0.38.1 target), `skills path …` (no managed `sessionName` / `usedImplicitSession`).
- **Native 0.38 observation/recording:** full/unchanged delta snapshots, persistent refs, partial batch ref follow-ups, conditional screenshot suppression, sticky pointer mode and timed mouse movement, cursor recording and verified contact-sheet output. These options are skipped when explicitly validating the older stable floor.
- **WebMCP target contract:** on the 0.38.1 target, `webmcp list`, `invoke` with params/frame selection, detached `result` / `cancel`, ref invalidation after page tools, and a separate fresh launch with `--no-webmcp` returning an empty list.
- **Navigation metadata and native tab setup:** plain pages stay quiet; a page with tools retains positive native `data.webmcp` and shows the `webmcp list` hint. New tabs inherit configured headers before their first request, and clearing headers removes them on the next tab. No wrapper inheritance code is involved.
- **Recording FPS paths and pinning:** the opt-in `test/agent-browser.batch-fidelity.test.ts` native case checks direct/raw/stdin preflight before dispatch, actual start/restart destinations and pinned targets with leading `--fps`, conservative start-ref protection, FPS-only restart continuity, and valid 12-fps WebM output after explicitly logged 12-second fixture captures. Run it with `PI_AGENT_BROWSER_REAL_UPSTREAM=1`; it requires native 0.37 or newer. Keep focused older-native controls for fresh-page starts and the start-then-ref batch latch when changing that policy.
- **Managed session core and safe diagnostic matrix:** fresh `open` on the contract fixture, then implicit reuse across `eval --stdin`, `snapshot -i`, interaction commands (`click`, `dblclick`, `fill`, `type`, `type --clear --delay`, `focus`, `keyboard` with `type` / `inserttext`, `press`, `hover`, `check`, `uncheck`, `select`, failed `select` no-match, `upload`, `drag`, `mouse`, `scroll`, off-viewport click, `scrollintoview`, `wait` on selectors in the main frame and a selected iframe), extraction (`get` variants, `is` variants, `find label … fill` via native `<label>`, `aria-label`, and `aria-labelledby`, inline `eval`), file outputs (`screenshot`, `pdf`), navigation (`back`, `forward`, `reload`, `tab list`, another `open` to the same fixture), `batch` stdin, `pushstate`, `vitals … --json`, network route/requests/HAR, diff snapshot/screenshot/url, trace/profiler, console/errors/highlight, stream enable/status/disable, and `cookies set --curl`.
- **Managed restore correctness and persistence:** while the restore-enabled managed daemon is active, assert raw argument and stdin batches containing nested `connect` fail before upstream spawn; a new harness replaying the owned launch result must also reject incompatible reuse of that live same-name daemon. Seed a cookie plus localStorage/sessionStorage, close the first managed browser while a conflicting parent namespace is set, verify the default-namespace daemon actually closed, create a new extension harness with the same cwd, reopen the fixture with `sessionMode: "fresh"`, and assert all three values restore before closing the second browser. On POSIX, separate isolated real-browser launches assert automatic restore stays disabled and no snapshot is written through either a symlinked `sessions` directory or a file symlink in `sessions/.tmp`; a relative `HOME`, untrusted writable HOME ancestry, and a non-Git cwd must fail closed. Verify a checkout rename preserves its generation identity but starts a fresh composite restore key (fail-closed, because the cwd-derived managed-session base name changes), a copied or path-replacement checkout gets a new key, and changing the Git-generation marker between planning and spawn prevents agent-browser from starting. Run two same-identity harnesses concurrently so a compatible launch publishes its daemon policy before a waiting incompatible launch re-inspects and fails without reaching its main spawn; also fail a fresh non-batch command after daemon creation and verify shutdown closes the retained identity.
- **Cold first-read continuity:** the focused `contract suite matches cold URL reopen after quit` case starts an explicit `sessionMode: "fresh"` managed browser, runs actual quit cleanup, waits for the exact old daemon to exit, reloads the saved branch, and requests `snapshot -i` before any explicit navigation. Empty storage and origin storage must both reach their remembered non-root URL, report fresh refs in the main frame, and retain storage without pretending to retain unsaved forms or JavaScript memory. Separate deterministic cold-resume/boundary tests cover first `get url` and history commands, non-page daemon-starting calls and batch prefixes, hash routes, pending-state transcript replay, live missing tabs versus explicit URL destinations, close retirement, and caller-owned/attached/restore-disabled boundaries. Those fake-upstream checks do not replace native-browser or real Pi lifecycle qualification of the complete candidate.
- **Failure shape:** `react tree` on a page opened with `--enable react-devtools` but without a React app (expects a clear missing-renderer error with session-bound `details`).
- **Async download:** `open` on the `/download` fixture, anchor-triggered export, then `wait --download <path>` metadata and wrapper artifact reporting for the requested path.

The default unit suite also runs `agentBrowserExtension passes through core command coverage fallback matrix` in [`test/agent-browser.extension-passthrough-validation.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-passthrough-validation.test.ts): a fake upstream records argv so explicit `--session connector connect 9222`, plus `download` with a selector and path, `get url`, `snapshot --compact`, and `tab new` / `tab t1` / `tab close` on implicit managed sessions, still prove `--json` and session ordering without a browser. A second fake-upstream matrix in that file (`agentBrowserExtension passes through non-core network debug diff stream dashboard and chat families`) pins representative `network`, `diff`, `trace` / `profiler` / `record`, `console` / `errors` / `highlight` / `inspect` / `clipboard`, `stream`, `dashboard`, and `chat` JSON shapes plus redacted `details.data` and argv echoes without a browser. A third matrix (`agentBrowserExtension passes through provider and specialized skill workflows`) asserts provider `open` argv shapes still receive `--json` plus implicit `--session` while read-only `skills get …` stays stateless (no managed session fields) and provider credential env vars are forwarded into the fake upstream log. Extend those matrices when adding passthrough coverage that should stay out of the slow real-upstream loop.

### Native checkpoint qualification

`test/agent-browser.checkpoint-native.test.mjs` is an opt-in, model-free test for a Pi SDK exposing `acquireCheckpoint` with native failed-journal repair/flush (qualified against core `c401cada69172dfd683e6d569b2cd9e5a45b4fcd`). It loads the compiled extension through native resource discovery, dispatches real tools through an awaited native command, and records real results with SessionManager. It checks idle/release/reload, live root and managed browsers (including a stable ambient socket override without a Pi override), off-branch state, detached and native-owned code calls, recording, failed journal appends/cleanup leases, routes, trace, caller-owned CDP attachment, and native checkpoint selection/entries plus root restore after replacing checkout/state directories with fresh inodes. No provider or fake readiness classifier is used.

Run as a non-root user in an isolated environment with stock `agent-browser`, Chrome for Testing and ffmpeg. Clear inherited credentials/configuration; do not use a personal browser. The test creates its own HOME/socket directory, copies only the supplied browser binary directory, serves a loopback synthetic page, explicitly closes its sessions, and removes its fixtures. `PI_CHECKPOINT_TEST_BROWSER_DIR` must name a binary installation directory such as `.../.agent-browser/browsers/chrome-<version>`, never a browser profile.

```bash
npm run build
PI_CHECKPOINT_TEST_REQUIRED=1 \
PI_CHECKPOINT_TEST_SDK=/path/to/native/pi-coding-agent/dist/index.js \
PI_CHECKPOINT_TEST_BROWSER_DIR=/path/to/browsers/chrome-<version> \
node --test test/agent-browser.checkpoint-native.test.mjs
```

`PI_CHECKPOINT_TEST_EXTENSION` can select a separate baseline checkout. With `PI_CHECKPOINT_TEST_BASELINE_RESTORE=1`, only its existing root-restore path runs and every receipt must retain the old shutdown blocker; this is not positive sleep qualification. The SDK selector is test-only; it does not change package peers or activate an extension. This gate is separate from the default 0.84 unit fixtures and release/platform/model-based gates. Qualification is for ordinary native save-on-close and explicit URL reopen, not a live browser snapshot. Journal fault injection checks that ongoing native I/O errors reject acquisition and preserve prior bytes/accepted entries. Permission repair must recover through core capture without repeating the failed append; recording retry and cleanup leases remain extension-owned. The test also checks exact repaired entries/selection in a separate-process strict cold restore and rejection of a mismatched artifact. After explicit close it observes native daemon exit before asserting idle readiness; an acknowledgement alone is not proof of inactivity. The abnormal-restart regression kills only its exact SDK fixture PID after ordinary branch navigation, then reopens the real journal in a fresh SDK process. It verifies that the off-branch wrapper-created daemon blocks capture without acquiring cleanup ownership, and that explicit managed-looking names and a nonowned namespace retain ambient routing. Same-namespace/same-name controls check distinct live daemons in owned and ambient socket roots, continued blocking after closing only the caller, ambient-only blocking after closing the historical daemon, and positive readiness after both are explicitly closed. All browser ownership evidence comes from executed native tools, never injected ownership records.

#### Required Linux PR gate

[`.github/workflows/native-checkpoint.yml`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/.github/workflows/native-checkpoint.yml) runs **Native checkpoint Linux** on every PR to `main`, pushes to `main`, and manual dispatch. When Actions is authorized, this is the checkpoint PR check (repository settings are separate from the workflow). Under the current keep-Actions-disabled instruction, qualify locally and record the CI waiver rather than enabling workflows. It does not replace release/manual-publication gates or full Linux personal-workspace sleep/resume qualification.

The CI-only recipe in [`scripts/ci-native-checkpoint.sh`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/ci-native-checkpoint.sh) builds the public fork target selected by `host-targets.json` in the workflow's pinned `fitchmultz/.github` automation revision, using the fork's lockfile and documented `npm ci --ignore-scripts`, `hydrate:model-data`, `build:offline` sequence. It uses explicit Node **26.9.0**, the extension's unchanged lockfile, stock **agent-browser 0.38.1**, a fresh stock Chrome-for-Testing download, and Ubuntu ffmpeg. No browser fork, personal profile, credentials, or model calls are involved.

Sources live under a private `/tmp` root, outside HOME ancestry. Setup and tests use `env -i`; verification runs non-root in a loopback-only network namespace after downloads finish. Shared compatibility checks select independent official/fork graphs for types, tests and consumer installation. This workflow additionally runs the locked official graph on Node 26 before network isolation, then generated-document checks and live command-reference sampling inside the loopback namespace. The separate native gate requires **13 passed, zero failed/cancelled/skipped/todo** in its TAP output. `PI_CHECKPOINT_TEST_REQUIRED=1` turns a missing SDK into a failure and rejects root/baseline-only runs; missing browser parameters, binaries, or checkpoint APIs fail normally. Without the flag or SDK, direct local invocation remains opt-in and skips.

CI uploads raw setup/build/provenance logs, Node 26 and document verification output, and native TAP (including receipts), even on failure. Chrome is downloaded through the pinned stock installer, not separately version-pinned; the actual browser version is logged. These checks prove synthetic native behavior on that runner and sourcehost, not real-site authentication, Electron-app behavior, managed-key cold portability, or complete personal qualification. Passing this gate does not replace code review or full personal-workspace acceptance.

### Native Linux socket-root regression

`test/agent-browser.socket-namespace.test.ts` is opt-in (`PI_AGENT_BROWSER_SOCKET_NAMESPACE=1`). Run it with the installed `tsx` test runner inside a disposable bubblewrap user/mount namespace: a read-only mode-`0755` `/` whose owner is unmapped, and a current-user-owned mode-`0700` tmpfs at `/tmp`. Use a cleared environment with only the required executable PATH, private HOME and the opt-in variable. The test verifies those identities, exchanges data over a real Unix socket, dispatches native `agent-browser --version` through the shared subprocess wrapper, and inspects a disposable managed session with automatic restore enabled. It does not launch a browser or call a model.

For a root-check change, run the identical final test against both the pre-fix and rebuilt implementation: the old code must fail the socket validation assertion after the native socket exchange succeeds, and the new code must pass without filesystem mocks or runtime patch hooks. Also retain process/restore negatives for foreign or writable non-root ancestry, leaf symlinks, planted entries and unsafe alias destinations, plus existing root-owned sticky-mode coverage. Namespace setup failures are environment blockers, not test passes; do not silently widen container privileges or host policy. This qualified private-`/tmp` layout does not imply support for unmapped `/home` ancestry or replace the broader release gates.

### Real upstream suite mechanics, isolation, and troubleshooting

- **Focused and broad cases:** `test/agent-browser.real-upstream-contract.test.ts` keeps the broad command matrix in one 180-second case and separate 60-second cold-reopen, duplicate-name click-mutation, navigation-availability/tab-setup, and sessionless-plugin cases. The `real-upstream` facade's `contract suite matches` selection includes the broad matrix, cold reopen, click mutation, and navigation setup. The click case uses two native DOM buttons to prove a stale duplicate ordinal cannot contradict trusted target events, while exact XPath probes still detect missing events and native clicks remain dispatch-only evidence.
- **Output-shape locking:** Expected `details` / `data` keys per step live in `test/fixtures/agent-browser-real-output-shapes.json`, keyed by logical groups (`version`, `rootHelp`, `commandHelp`, `skillsList`, `skillsGetFull`, `skillsPath`, `open`, `eval`, `snapshot`, `coreCommand`, `coreSubcommand`, `coreFileArtifact`, `batch`, `pushstate`, `vitals`, `networkRoute`, `nonCoreStatus`, `nonCoreArtifact`, `diffScreenshotArtifact`, `streamControl`, `streamStatus`, `cookiesCurl`, `reactMissingRenderer`, `waitDownload`). Keep `targetVersion` in that file aligned with `scripts/agent-browser-capability-baseline.mjs`, and extend entries whenever the suite starts asserting on new presentation fields.
- **Isolation:** The harness uses a throwaway HOME and screenshot directory, and pairs `PI_AGENT_BROWSER_SOCKET_DIR` with `AGENT_BROWSER_SOCKET_DIR` in a short private socket directory. This keeps owned commands and native policy probes on the same daemon without exceeding Unix socket path limits. Raw click/FPS helpers retain owned-session context; cold-resume observers use the registered tool so they do not restart the browser they are measuring. The harness serves loopback fixtures, closes its sessions and removes only its own directories; it does not reuse your normal profile or socket locations.
- **React DevTools branch:** After the core matrix, the suite performs another `open` with `--enable react-devtools` and `sessionMode: "fresh"`, then expects `react tree` to fail with a missing-renderer style error on the same non-React contract page. The following download fixture + `wait --download` assertions run against whichever managed session is current after that fresh `open` (typically the React DevTools session), not the original pre-matrix session name.

**Troubleshooting**

- **Version mismatch:** Install a stable `agent-browser` at or above the configured floor (prefer the recommended capability baseline), or follow the maintainer rebaselining sequence in `AGENTS.md` if you intentionally move either version.
- **Missing or extra `details` / `data` keys:** Update `test/fixtures/agent-browser-real-output-shapes.json` in the same change as the wrapper or presentation code that shifts those keys.
- **Timeouts:** The broad matrix has a 180-second bound; the focused cold-reopen, click-mutation, and plugin cases each have a 60-second bound. Repeated timeouts usually mean a hung browser, blocked loopback, or an environment preventing headful/headless launch—check upstream logs and local security tooling before loosening timeouts.

The upstream `agent-browser` `wait --download <path>` saveAs persistence limitation is tracked at [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300); until it is fixed, release validation must treat `details.savedFilePath` as upstream-reported metadata and use `details.artifacts[].exists` as the filesystem truth (the contract asserts the requested path is absent on disk while upstream still reports success). If the suite fails because JSON/detail keys drifted, update the wrapper behavior or refresh `test/fixtures/agent-browser-real-output-shapes.json` together with the presentation work that consumes those shapes.

Example smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Recommended configured-source lifecycle follow-up:

1. Open a page with the implicit managed session and confirm the title.
2. Run `/reload`, then ask for `snapshot -i` and confirm the same page is still active.
3. Exit `pi`, confirm the old managed daemon stopped, relaunch against the same exact session id/path or use `/resume`, then ask for `snapshot -i` before any explicit navigation. Confirm the same recorded URL was reopened, its observed page is correct, and refs are fresh. Cover empty storage and origin storage at non-root paths; do not expect unsaved forms, JavaScript memory, or history to survive.
4. Open a large page that compacts its snapshot output and confirm `details.fullOutputPath` still exists after the restart/resume/exact-session flow.
5. Trigger an oversized non-snapshot output (for example a deliberately large `eval --stdin` result) and confirm the tool prints the actual spill file path directly in content instead of only referencing a details key.
6. Validate at least one direct file-download flow with `download <selector> <path>`.
7. Validate at least one asynchronous export flow with `click` followed by `wait --download <path>`, confirming the wait result reports `savedFilePath`/`savedFile` and checking `details.artifacts[].exists` before relying on the requested path being present on disk.

## Post-publish install validation

After updating `pi-agent-browser-native`, fully quit and restart Pi before using the updated tools. `/reload` can retain previously loaded compiled JavaScript even after `dist/` is rebuilt, so it is not a reliable way to pick up package updates.

After publishing a release, validate the package-first path in isolation. `npm run verify -- release` includes the deterministic fake-binary packaged execution gate and the pre-publish Crabbox platform matrix, but it does not replace a real-browser installed-package smoke against the published npm package:

```bash
npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
npm run verify -- release
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

Then run the real-browser smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Only use plain `pi` for installed-package validation after temporarily disabling or removing the checkout source or any other active source for this extension from Pi settings. Then confirm `pi` exposes the native `agent_browser` tool, that a basic `open` + `snapshot -i` flow works, and that `/reload` plus restart with exact `--session-id` relaunch or `/resume` keep following the same implicit managed browser session.

## Release notes checklist

Before publishing:

- update `CHANGELOG.md`
- confirm README install guidance still leads with the package-first flow
- confirm `docs/COMMAND_REFERENCE.md` still matches the effective upstream command/help surface used by the wrapper
- if you changed `scripts/agent-browser-capability-baseline.mjs` or the human inventory prose outside the generated HTML-comment blocks, run `npm run docs -- command-reference write` before verification; see `AGENTS.md` (upstream capability baseline section) for the three-layer model
- run `npm run verify -- command-reference` if the installed upstream `agent-browser` version or help surface changed
- run `npm run doctor` and confirm any duplicate-source remediation matches the active package/checkout setup
- run `npm run verify -- real-upstream` for upstream runtime, result-presentation, or managed-session changes
- confirm both local-checkout modes still work for pre-release validation: isolated `pi --approve --no-extensions -e .` smoke testing for general trusted checkout loading (add `--no-skills` for extension-focused bounded smokes; omit `--approve` only to test the trust prompt) and configured-source lifecycle validation
- complete interactive `tmux` live-site extension smoke with `pi --approve --no-extensions --no-skills -e .` and the native `agent_browser` tool (at least one simple static site and one real documentation/product site; include advanced QA, code, or native batch when those surfaces changed; use the [public Grafana stress checklist](#public-grafana-stress-checklist) when dashboard/diagnostic/artifact behavior changed; close sessions and remove screenshots/temp artifacts; record evidence). Run separate skill-enabled dogfood only when validating skill routing/report-generation behavior—see [Pre-release checks](#pre-release-checks); automated gates are not a substitute
- satisfy the approved release checks and current owner waivers; record individual platform evidence and never label a Windows-inclusive composition passed when Windows was waived
- run `npm run verify -- lifecycle` for configured-source `/reload`, exact `--session-id` relaunch, managed-session continuity, persisted-spill, and Pi failure-patch regression coverage (required before publish; see [Pre-release checks](#pre-release-checks))
- confirm [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) still maps every current baseline inventory section to docs, runtime handling, tests, and validation status
- manually exercise real-browser `/reload` and full restart plus exact `--session-id` relaunch or `/resume` continuity when release risk warrants browser-level confidence beyond the fake upstream harness
- publish only after the tarball contents and isolated packaged-extension smoke check match expectations
