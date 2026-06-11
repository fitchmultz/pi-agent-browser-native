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
- Managed-session outcomes (`RQ-0077`): after extension-managed implicit or fresh `--session` injection reaches process execution, `details.managedSessionOutcome` records the transition (`created` / `replaced` / `unchanged` / `closed` on success; `preserved` / `abandoned` when a plan fails before a new session becomes current). Failing `sessionMode: "fresh"` calls also append model-visible `Managed session outcome: …`—[`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details), [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md), [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), and [`../AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) maintainer checklist
- Stateful context commands (`cookies`, `storage`, `auth`, `dialog`, `frame`, `state`) and aggregate `batch` results: model-facing `details.data` is summarized or redacted per [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); aggregate `batch` replaces top-level `details.data` with a compact per-step matrix (`success`, argv-redacted `command`, redacted `result` or scrubbed `error`) while full per-step payloads, artifacts, and categories remain on `batchSteps[]`—operational notes in [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md#use-stateful-browser-context-commands-safely), assembly in `extensions/agent-browser/lib/results/presentation/batch.ts`

## Purpose

Provide one concrete maintainer workflow for validating repo state, package contents, and install guidance before publishing `pi-agent-browser-native`.

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

`pre-pr` composes the default gate with `npm run verify -- package`: generated docs, TypeScript, the full unit/fake suite, live command-reference sampling, and package-content verification. It intentionally does not run lifecycle, packaged Pi smoke, Crabbox platform smoke, real-upstream, dogfood, or benchmark modes.

`npm run verify -- release` runs:

1. `npm run verify` for generated playbook drift, TypeScript, unit/fake coverage, command-reference generated-block drift, and live command-reference verification against the targeted upstream on `PATH`
2. `npm run verify -- lifecycle`, which launches the configured-source lifecycle harness for `/reload`, exact `--session-id` relaunch, managed-session continuity, persisted spill reachability, and Pi failure-patch behavior
3. `npm run verify -- package-pi`, which first validates package contents via `npm pack --json --dry-run` and then smoke-loads the packed package in Pi isolation
4. `npm run smoke:platform:doctor` and the full Crabbox matrix from [`platform-smoke.md`](platform-smoke.md): macOS SSH, Ubuntu local-container, and native Windows Parallels targets running fast target-local `platform-build` plus `browser-dogfood-smoke`

`npm publish` runs npm’s `prepublishOnly` script from `package.json`, which executes the same `npm run verify -- release` gate and then `npm pack --dry-run`. That concatenated gate is everything in the default `npm run verify` step (generated playbook drift, TypeScript, the unit/fake suite, generated command-reference blocks, and live upstream command-reference sampling against the targeted `agent-browser` on `PATH`), the configured-source lifecycle harness, the packaged Pi smoke in `package-pi`, and the release-blocking Crabbox platform matrix. Using `npm publish --ignore-scripts` skips that contract intentionally.

`prepublishOnly` intentionally does **not** run the standalone host-only `npm run verify -- real-upstream`, `npm run verify -- dogfood`, or `npm run verify -- benchmark` modes; those remain separate `npm run verify` modes in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs). The platform matrix includes its own fast target-local build/package gate and browser dogfood suite, and is automated through the `release` slice.

For a deterministic host-only real-browser wrapper smoke without model choice in the loop, run:

```bash
npm run verify -- dogfood
```

For direct Crabbox diagnostics outside the full release compose, run:

```bash
npm run check:platform-smoke
npm run smoke:platform:ubuntu-image
npm run smoke:platform:doctor
npm run smoke:platform:all
crabbox list --provider local-container
crabbox list --provider parallels
```

The Crabbox gate is only green when suite assertions and artifact manifests under `.artifacts/platform-smoke/` are green and no unexpected lease/clone remains.

The deterministic dogfood mode uses the extension harness and the real `agent-browser` on `PATH` against a deterministic local file fixture, then verifies top-level `qa`, `semanticAction`, constrained `job`, screenshot artifact verification, and session close. Use `npm run verify -- dogfood --keep-artifacts` or `--artifact-dir <path>` only while debugging, then delete retained screenshots. This smoke complements, but does not replace, human-readable interactive transcript evidence.

Every release also requires interactive `tmux`-driven Pi dogfood with the native `agent_browser` tool against real sites. For extension-focused release smokes, use `pi --approve --no-extensions --no-skills -e .` from the trusted checkout before publish so auto-loaded dogfood/QA skills cannot replace the bounded smoke workflow; omit `--approve` only when the smoke is explicitly testing Pi's Project Trust prompt. Run separate skill-enabled dogfood only when validating skill routing or report-generation behavior. Drive prompts with `tmux send-keys`, exercise at least one simple static site and one real documentation/product site, include the higher-level `qa` or `job`/`batch` surfaces when they changed, close every opened browser session, remove screenshots/temp artifacts, and record the outcome in the release notes or support-matrix evidence. Do not paste raw multi-line prompts into a tmux Pi pane: plain newlines submit separate queued user messages. For scripted smoke driving, collapse prompt files to one line before sending (`PROMPT=$(tr '\n' ' ' < /tmp/smoke-prompt.md); tmux send-keys -t "$SESSION":0.0 -l "$PROMPT"; tmux send-keys -t "$SESSION":0.0 Enter`). For manual multi-line editing, use Pi's external editor shortcut (`Ctrl+G`) or configure tmux extended keys so Pi can receive `Shift+Enter` for newlines; see the installed Pi `docs/tmux.md` guidance. Automated localhost, fake-upstream, and deterministic dogfood gates do not replace this human-readable live-site transcript evidence. When `agent_browser_web_search` or package config changed, add one key-free smoke proving the optional tool is absent without config, one fake/unit-backed smoke in the default suite, and one opt-in live Exa or Brave Search check with a real key while confirming the key does not appear in transcripts, stdout/stderr, config status, PR text, or artifacts. When `electron.*` surfaces, attached-session diagnostics, or `qa.attached` changed, add a local Electron pass: `electron.list` → `electron.launch` (expect isolated profile behavior) → `snapshot -i` or `electron.probe` / `qa.attached` → `electron.cleanup` with the returned `launchId`, verifying status/mismatch guidance if you simulate a dead renderer or stale refs. For dense-dashboard stress coverage, use the [public Grafana stress checklist](#public-grafana-stress-checklist) below; it is a maintainer workflow, not bundled product skill or recipe runtime.

When reviewing saved session JSONL after a failed smoke or a `qa` preset that reclassified an upstream-successful batch, expect `agent_browser` tool rows to carry `isError: true` whenever `details.resultCategory` is `failure`. For normal prose output, model-visible text should end with a `Pi tool isError: true` category line; for caller-requested `--json` output, the hook preserves parseable JSON and only patches `isError`. The extension applies that patch on the `tool_result` path so Pi’s transcript matches the wrapper contract ([`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details)). Preserve a normal Pi session directory for those checks; avoiding `--no-session` keeps this evidence intact ([`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) preferred validation workflow).

The configured-source lifecycle regression harness is required before release because it launches an interactive `pi` process under `tmux` with `--approve` and validates `/reload`, full relaunch with the same exact Pi 0.79 `--session-id`, managed-session continuity, persisted artifacts, and Pi failure-patch behavior. Branch-backed `session_tree` rehydration and cleanup ownership are validated by focused extension harness tests:

```bash
npm run verify -- lifecycle
```

Use `npm run verify -- lifecycle --keep-artifacts` when debugging failures, then remove retained artifacts after inspection.

## Public Grafana stress checklist

Use this optional-but-recommended checklist when a release touches dashboard behavior, snapshots, refs, scroll, comboboxes, artifacts, network diagnostics, recording, or prompt guidance. It keeps the useful public Grafana dogfood target repeatable without bundling private dogfood/VFR skills or adding a reusable browser recipe layer.

Target:

```text
https://play.grafana.org/d/rYdddlPWk/node-exporter-full?orgId=1&from=now-6h&to=now&timezone=browser&var-datasource=default&var-job=node&var-node=All
```

Minimum pass:

1. Open the URL with the native `agent_browser` tool in a fresh session.
2. Run `snapshot -i`; confirm the output is useful on a dense dashboard, including high-value controls and bounded spill behavior when needed.
3. Exercise one dashboard scroll path. If page-level `scroll` does not move visible content, confirm `details.scrollNoop` / next actions or equivalent guidance points to snapshot/screenshot verification and nested-scroll recovery.
4. Exercise one explicit combobox-targeted action such as a role/name `semanticAction` on a dashboard variable. If it only focuses the field, confirm `details.comboboxFocus` / next actions point to `snapshot -i`, `press ArrowDown`, and `press Enter` when the closed-state evidence qualifies.
5. Capture at least one screenshot artifact and verify `details.artifactVerification` before using the file.
6. If `ffmpeg` is on `PATH`, run a short `record start` / visible interaction / `record stop` cycle and verify the WebM artifact. If `ffmpeg` is absent, confirm `details.recordingDependencyWarning` appears after `record start` and stop before relying on recording evidence.
7. Inspect `network requests`, `console`, and `errors` summaries. Treat Grafana Play-side noise such as analytics/Sentry requests, public-demo 403s, and console errors as site noise unless the wrapper leaks secrets, hides actionable failed rows, misclassifies artifacts, or suggests unsafe follow-ups.
8. Close the browser session and delete temporary screenshots, HARs, recordings, and scratch reports after extracting any release evidence.

Record release evidence as a short note with: date, package/checkout source, target URL, browser command families exercised, artifacts collected and cleaned up, known Grafana-side noise observed, and any product findings converted into CueLoop tasks. Do not commit private dogfood scripts, VFR harness files, raw browser profiles, HARs, videos, or `.dogfood/` run output as product docs.

## Public Sauce Demo checkout smoke prompt

Use this validation prompt after changing click enrichment, tab pinning, ref preflight, form-fill batching, artifact handling, recording, or prompt guidance. It is intentionally more stateful than `example.com` and uses a natural user-style request so the transcript shows what the agent chooses on its own. Do **not** mention `agent_browser`, snapshots, refs, `batch`, `eval`, or upstream command names in the prompt; those are evaluator expectations, not user instructions.

Run it in an isolated checkout session with skills disabled so the run validates the extension browser workflow instead of external dogfood/QA skill routing. It is fine to restrict active tools at launch so the checkout extension is the only browser surface, but keep those launch details out of the user prompt:

```bash
pi --approve --no-extensions --no-skills -e . --model openai-codex/gpt-5.5:minimal --tools agent_browser --session-dir "$SESSION_DIR"
```

Repeat with `--model openai-codex/gpt-5.5:medium` when validating instruction-following robustness. Use unique temp paths for each run and delete them afterward. Run separate skill-enabled dogfood sessions only when the thing under test is skill integration, not this bounded release smoke.

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

## Deterministic agent efficiency benchmark

[`scripts/agent-browser-efficiency-benchmark.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/agent-browser-efficiency-benchmark.mjs) is an accounting-only benchmark: it does not shell out to `agent-browser`, launch a browser, or read or write Pi sessions. It models representative `agent_browser` call shapes (including optional `stdin` for `batch` and top-level `job`, `qa`, or experimental `sourceLookup` / `networkSourceLookup` objects that compile to batch) and aggregates success rate, tool-call counts, UTF-8 size of model-visible strings, stale-ref failure and recovery counts, artifact success, distinct failure-category coverage, and summed elapsed-time estimates. When extending scenarios, keep them aligned with the closed `RQ-0068` “no reusable recipe layer” rationale in [`ARCHITECTURE.md`](ARCHITECTURE.md#no-reusable-recipe-layer-yet) (benchmark ids cited there are the canonical inventory for that evidence bar).

- **During development:** `npm run benchmark:agent-browser` prints a Markdown report; `npm run benchmark:agent-browser -- --json` saves machine-readable metrics; `npm run benchmark:agent-browser -- --compare path/to/prior.json` fails with exit code `1` on regressions (see the script’s `--help` for exit codes). Optional `--sample-jsonl path/to/session.jsonl` adds a `jsonlSample` section with real UTF-8 byte totals and per-workflow/overall p95 sizes for model-visible `agent_browser` tool-result text without changing deterministic scenario metrics; comparison ignores `jsonlSample` blocks.
- **Default gate:** `npm run verify` checks generated playbook drift, runs `tsc --noEmit`, runs the full unit/fake suite under `test/**/*.test.ts` with Node test concurrency pinned to `1` (including [`test/agent-browser.efficiency-benchmark.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.efficiency-benchmark.test.ts) for scenario coverage and comparison behavior), verifies generated command-reference baseline blocks, and samples live upstream command-reference tokens. It does not spawn the standalone benchmark script’s JSON/Markdown run; that is what the opt-in slice below adds.
- **Pre-PR gate:** `npm run verify -- pre-pr` runs the default gate plus `npm run verify -- package` for larger handoffs that need package-content confidence without lifecycle, platform, real-upstream, dogfood, or benchmark cost.
- **Opt-in slice:** `npm run verify -- benchmark` runs the benchmark script once with `--json` and then that same test module alone. It is intentionally **not** part of `npm run verify -- pre-pr` or `npm run verify -- release`, so routine handoff and publish gates stay decoupled from benchmark churn while still allowing a focused check after editing scenarios or `CURRENT_BENCHMARK_VERSION`.

Maintainer constraints for evolving scenarios and version bumps are summarized under “Agent browser efficiency benchmark” in [`../AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md).

## What package verification checks

`npm run verify -- package` confirms that:

- no repo-local `.pi/extensions/agent-browser.ts` autoload shim is present
- `LICENSE` exists in the repo and the packed tarball
- canonical published docs are present
- the package-level doctor command and capability baseline are present
- extension source files are present, including the split result-rendering modules required by the published facade
- agent-only and superseded docs are absent from the tarball

`npm run verify -- package-pi` runs the same package-content checks and additionally confirms that:

- the packed package can be loaded through Pi SDK resource loading with the same isolation principle as `pi --no-extensions -e <package-source>`
- `agent_browser` is registered without requiring optional Brave config
- any optional companion tools remain governed by their own configuration gates
- the registered `agent_browser` source resolves inside the extracted packed package path, not the working checkout
- the packaged `agent_browser` tool can be executed through Pi's loaded native tool definition with a deterministic fake upstream `agent-browser --version` binary

The packaged execution smoke intentionally uses a temporary fake `agent-browser` binary and the `--version` inspection path. It proves first invocation of the packaged Pi tool without launching a real browser. Real browser coverage remains part of local checkout validation and post-publish install validation.

Current forbidden packed files include:

- `AGENTS.md`
- archived planning drafts under `docs/archive/`
- `.pi/extensions/agent-browser.ts`
- test and repo-only maintenance files

For a full packed file listing:

```bash
npm run verify -- package --list-files
```

## Local development validation

Before publishing, validate both local-checkout modes without mixing their assumptions.

### Quick isolated checkout smoke test

1. Install `agent-browser` separately.
2. Launch `pi --approve --no-extensions -e .` from this trusted repository root. Omit `--approve` only when testing Pi's Project Trust prompt.
3. Confirm the checkout extension loads from `extensions/agent-browser/index.ts`.
4. Run a smoke prompt that exercises `agent_browser`.
5. Restart the `pi` process after extension edits; Pi settings and `/reload` are not the validation target in this isolated mode.

For expanded-surface validation, the smoke prompt should cover native tool invocation rather than shelling out to `agent-browser`: `--version`, `--help`, `skills list`, `skills get core --full`, `open` with `sessionMode: "fresh"`, `snapshot -i`, `click`, top-level `semanticAction` (locator shorthand compiled to upstream `find` and native dropdown selection compiled to upstream `select`, optionally with `semanticAction.session` when you need the same named upstream session as a prior explicit `--session` call), `eval --stdin`, `batch` via stdin, top-level `job`, `qa`, or experimental `sourceLookup` / `networkSourceLookup` (compiled batch smoke), `screenshot <path>`, explicit `--session … open` plus `--session … close`, `network requests`, `console` / `errors`, `diff snapshot`, `stream status` plus `stream disable`, `dashboard start` plus `dashboard stop`, and `chat <message>` (credential failure is acceptable evidence of wrapper pass-through when `AI_GATEWAY_API_KEY` is intentionally unset). Clean up any opened browser session with `close`, remove temporary files, and kill the tmux session before ending validation.

This checklist assumes a real `agent-browser` on `PATH`. It complements, but does not overlap, `npm run verify -- lifecycle`: that harness swaps in a fake upstream binary and focuses on `/reload`, exact `--session-id` relaunch, managed-session continuity, spill-path persistence, and Pi `tool_result` failure-patch semantics (`scripts/verify-lifecycle.mjs`), not the full command matrix above.

When a smoke or dogfood run fails after `sessionMode: "fresh"` (missing binary, timeout, upstream error, or **`qa`** preset reclassification), read `details.managedSessionOutcome` before assuming which managed session the next default `sessionMode: "auto"` call will follow; the same struct can appear without the extra `Managed session outcome: …` prose line on `"auto"` failures. Field-level semantics and append ordering relative to other diagnostic tails are documented in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details) and the session-mode notes in [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md).

### Configured-source lifecycle validation

Run the automated harness for deterministic configured-source lifecycle regression coverage (required before publish together with the other [Pre-release checks](#pre-release-checks)):

```bash
npm run verify -- lifecycle
```

The harness creates an isolated `PI_CODING_AGENT_DIR`, writes settings with exactly one temporary configured package source, runs `pi` in `tmux` with `--approve`, default model **`zai/glm-5.1`**, and a deterministic `--session-id`, puts a deterministic fake `agent-browser` first on `PATH`, drives `/reload`, closes Pi, and relaunches with the same exact session id instead of typing `/resume`. It also asserts the JSONL session header id, same-page managed-session continuity, persisted spill reachability, and real Pi `tool_result` failure-patch semantics for a QA reclassification. Per-step tmux waits default to **180000 ms** (three minutes) in [`scripts/verify-lifecycle.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/verify-lifecycle.mjs) (`DEFAULT_TIMEOUT_MS`); override with `--timeout-ms <ms>` when slower models or cold starts need more headroom. Override the model when needed:

```bash
npm run verify -- lifecycle --model openai-codex/gpt-5.5:minimal
```

Combine flags in one invocation when both apply (order after `lifecycle` is flexible as long as each value-taking flag is immediately followed by its value):

```bash
npm run verify -- lifecycle --model openai-codex/gpt-5.5:minimal --timeout-ms 600000
```

On failure it retains transcripts/session artifacts; on success it performs best-effort cleanup. It does not replace occasional real-browser manual smoke testing.

**Lifecycle triage:** a timeout on sentinel `v2` after `/reload` often means Pi rejected reload while the TUI still showed `Working…` (`Wait for the current response to finish before reloading`), even when the session JSONL already has a final assistant message. Re-run with `--keep-artifacts --verbose`, inspect the retained pane capture, and confirm the configured model follows tool prompts reliably. Slower models may need a higher `--timeout-ms` than the **180000 ms** default.

### Environment and automation pitfalls

These show up often in cloud dev boxes and scripted smokes; they are maintainer notes, not product defects.

| Topic | What to watch for | Mitigation |
| --- | --- | --- |
| **Pi CLI vs repo devDependencies** | Global `pi` older than the minimum Pi runtime floor for the release can change TUI behavior, `/reload`, package installs, and tool routing during lifecycle or checkout smokes. | Run `npm run doctor` and align `pi` with the current audited baseline before release gates (`pi update` or install the matching version). The published peer range stays wildcard per Pi package docs, and the doctor enforces the minimum Pi runtime floor before package validation. |
| **npm lockfile (`packageManager`)** | `package.json` pins **npm@11**. npm 10 may only strip optional `libc` metadata on `@esbuild/*` platform entries in `package-lock.json` (no dependency version change). | Prefer `npx -y npm@11.14.0 install` when refreshing the lockfile; do not commit npm-10-only lockfile churn. |
| **`pi -p` / print mode** | Non-interactive `pi -p` may hang or emit no stdout for long real-browser smokes without a TTY. | Use **tmux**-driven interactive `pi` for release evidence and checkout smokes; reserve `-p` for short, non-browser checks. |
| **Real-browser cleanup** | `real-upstream`, Sauce Demo, and live-site runs can leave defunct Chrome/`agent-browser` children if a session aborts mid-flow. | Close via `agent_browser` / `agent-browser` `close`, kill stray tmux sessions, and remove temp screenshots/HARs under `/tmp` or your chosen artifact dirs. |
| **Automated prompt driving** | Grepping tmux pane text for words that also appear in the **user** prompt (`PASS`, `FAIL`, `checkout overview`, `Smoke result:`) can false-complete before the agent finishes. | Wait for pane idle (no `Working…`), `agent_browser close` / `Artifact lifecycle`, or JSONL tool results—not instruction phrases copied from the prompt. |
| **Lifecycle verify flags** | `npm run verify -- lifecycle --model` or `--timeout-ms` without the next argv token fails fast with a usage error—the `project.mjs` facade validates passthrough the same way as `scripts/verify-lifecycle.mjs`. | Always pair flags with values (`--model openai-codex/gpt-5.5:minimal`, `--timeout-ms 600000`) or omit `--model` / `--timeout-ms` to keep the harness defaults (`zai/glm-5.1`, **180000 ms** per-step waits). |

Manual validation remains useful for release confidence and installed-package checks:

1. Configure exactly one active source for this extension in Pi settings: this checkout path before publishing, or the installed package after publishing.
2. Launch plain `pi` so extension discovery is active.
3. Validate managed-session continuity with `/reload` and a full restart plus exact `--session-id` relaunch or `/resume`.
4. Re-check local extension-side docs (`README.md`, `docs/COMMAND_REFERENCE.md`, `docs/TOOL_CONTRACT.md`, including the [`semanticAction`](TOOL_CONTRACT.md#semanticaction) rules when that shorthand or upstream `find` / `select` behavior changes) and regenerated prompt fragments from `extensions/agent-browser/lib/playbook.ts` via `npm run docs -- playbook check` or `npm run docs`. When the upstream `agent-browser` version or help surface changed, run `npm run verify -- command-reference`.

### Real upstream contract validation

The default `npm test` and `npm run verify` paths use fast deterministic tests and fake binaries. For a focused single-file rerun, use `npx tsx --test test/<file>.test.ts`; `npm test -- test/<file>.test.ts` still runs the package script's full glob. When a change touches upstream command planning, result presentation, managed-session behavior, or the canonical capability baseline, also run the opt-in real-upstream contract suite:

```bash
npm run verify -- real-upstream
```

That npm script sets `PI_AGENT_BROWSER_REAL_UPSTREAM=1` for the test process. To run `test/agent-browser.real-upstream-contract.test.ts` directly (for example with `node --test` and `tsx`), set the same variable yourself; the suite is skipped when it is unset.

This suite requires the installed `agent-browser --version` to exactly match `scripts/agent-browser-capability-baseline.mjs`. It serves fixture pages from localhost and checks stable `details`/`data` keys via `test/fixtures/agent-browser-real-output-shapes.json`. Coverage groups:

- **Inspection and skills (stateless JSON):** `--version`, `--help`, `snapshot --help`, `skills list`, `skills get … --full`, `skills path …` (no managed `sessionName` / `usedImplicitSession`).
- **Managed session core and safe diagnostic matrix:** fresh `open` on the contract fixture, then implicit reuse across `eval --stdin`, `snapshot -i`, interaction commands (`click`, `dblclick`, `fill`, `type`, `type --clear --delay`, `focus`, `keyboard` with `type` / `inserttext`, `press`, `hover`, `check`, `uncheck`, `select`, failed `select` no-match, `upload`, `drag`, `mouse`, `scroll`, off-viewport click, `scrollintoview`, `wait` on selectors in the main frame and a selected iframe), extraction (`get` variants, `is` variants, `find label … fill` via native `<label>`, `aria-label`, and `aria-labelledby`, inline `eval`), file outputs (`screenshot`, `pdf`), navigation (`back`, `forward`, `reload`, `tab list`, another `open` to the same fixture), `batch` stdin, `pushstate`, `vitals … --json`, network route/requests/HAR, diff snapshot/screenshot/url, trace/profiler, console/errors/highlight, stream enable/status/disable, and `cookies set --curl`.
- **Failure shape:** `react tree` on a page opened with `--enable react-devtools` but without a React app (expects a clear missing-renderer error with session-bound `details`).
- **Async download:** `open` on the `/download` fixture, anchor-triggered export, then `wait --download <path>` metadata and wrapper artifact reporting for the requested path.

The default unit suite also runs `agentBrowserExtension passes through core command coverage fallback matrix` in [`test/agent-browser.extension-validation.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-validation.test.ts): a fake upstream records argv so `connect 9222`, `download` with a selector and path, `get url`, `snapshot --compact`, and `tab new` / `tab 0` / `tab close` still prove `--json` plus implicit `--session` ordering without a browser. A second fake-upstream matrix in the same file (`agentBrowserExtension passes through non-core network debug diff stream dashboard and chat families`) pins representative `network`, `diff`, `trace` / `profiler` / `record`, `console` / `errors` / `highlight` / `inspect` / `clipboard`, `stream`, `dashboard`, and `chat` JSON shapes plus redacted `details.data` and argv echoes without a browser. A third matrix (`agentBrowserExtension passes through provider and specialized skill workflows`) asserts provider `open` argv shapes still receive `--json` plus implicit `--session` while read-only `skills get …` stays stateless (no managed session fields) and provider credential env vars are forwarded into the fake upstream log. Extend those matrices when adding passthrough coverage that should stay out of the slow real-upstream loop.

### Real upstream suite mechanics, isolation, and troubleshooting

- **Single bundled test:** `test/agent-browser.real-upstream-contract.test.ts` registers one long-running case (120s timeout) so browser startup, the command matrix, and teardown stay in one place.
- **Output-shape locking:** Expected `details` / `data` keys per step live in `test/fixtures/agent-browser-real-output-shapes.json`, keyed by logical groups (`version`, `rootHelp`, `commandHelp`, `skillsList`, `skillsGetFull`, `skillsPath`, `open`, `eval`, `snapshot`, `coreCommand`, `coreSubcommand`, `coreFileArtifact`, `batch`, `pushstate`, `vitals`, `networkRoute`, `nonCoreStatus`, `nonCoreArtifact`, `diffScreenshotArtifact`, `streamControl`, `streamStatus`, `cookiesCurl`, `reactMissingRenderer`, `waitDownload`). Keep `targetVersion` in that file aligned with `scripts/agent-browser-capability-baseline.mjs`, and extend entries whenever the suite starts asserting on new presentation fields.
- **Isolation:** The harness allocates a throwaway directory under the system temp folder, points `HOME`, `AGENT_BROWSER_SOCKET_DIR`, and `AGENT_BROWSER_SCREENSHOT_DIR` at that tree, serves HTML fixtures from loopback (`startAgentBrowserContractFixtureServer` in `test/helpers/agent-browser-harness.ts`), and closes the managed session before deleting the temp tree. The main matrix does not reuse your normal profile or socket locations.
- **React DevTools branch:** After the core matrix, the suite performs another `open` with `--enable react-devtools` and `sessionMode: "fresh"`, then expects `react tree` to fail with a missing-renderer style error on the same non-React contract page. The following download fixture + `wait --download` assertions run against whichever managed session is current after that fresh `open` (typically the React DevTools session), not the original pre-matrix session name.

**Troubleshooting**

- **Version mismatch:** Install the `agent-browser` version declared in the capability baseline, or follow the maintainer rebaselining sequence in `AGENTS.md` if you intentionally move the target.
- **Missing or extra `details` / `data` keys:** Update `test/fixtures/agent-browser-real-output-shapes.json` in the same change as the wrapper or presentation code that shifts those keys.
- **Timeouts:** A 120s bound covers the full matrix; repeated timeouts usually mean a hung browser, blocked loopback, or an environment preventing headful/headless launch—check upstream logs and local security tooling before loosening timeouts.

The current upstream `agent-browser 0.27.2` `wait --download <path>` saveAs persistence limitation is tracked at [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300); until it is fixed, release validation must treat `details.savedFilePath` as upstream-reported metadata and use `details.artifacts[].exists` as the filesystem truth (the contract asserts the requested path is absent on disk while upstream still reports success). If the suite fails because JSON/detail keys drifted, update the wrapper behavior or refresh `test/fixtures/agent-browser-real-output-shapes.json` together with the presentation work that consumes those shapes.

Example smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Recommended configured-source lifecycle follow-up:

1. Open a page with the implicit managed session and confirm the title.
2. Run `/reload`, then ask for `snapshot -i` and confirm the same page is still active.
3. Exit `pi`, relaunch it against the same exact session id/path or use `/resume`, then ask for `snapshot -i` again and confirm the same page is still active.
4. Open a large page that compacts its snapshot output and confirm `details.fullOutputPath` still exists after the restart/resume/exact-session flow.
5. Trigger an oversized non-snapshot output (for example a deliberately large `eval --stdin` result) and confirm the tool prints the actual spill file path directly in content instead of only referencing a details key.
6. Validate at least one direct file-download flow with `download <selector> <path>`.
7. Validate at least one asynchronous export flow with `click` followed by `wait --download <path>`, confirming the wait result reports `savedFilePath`/`savedFile` and checking `details.artifacts[].exists` before relying on the requested path being present on disk.

## Post-publish install validation

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
- complete interactive `tmux` live-site extension smoke with `pi --approve --no-extensions --no-skills -e .` and the native `agent_browser` tool (at least one simple static site and one real documentation/product site; include `qa` or `job`/`batch` when those surfaces changed; use the [public Grafana stress checklist](#public-grafana-stress-checklist) when dashboard/diagnostic/artifact behavior changed; close sessions and remove screenshots/temp artifacts; record evidence). Run separate skill-enabled dogfood only when validating skill routing/report-generation behavior—see [Pre-release checks](#pre-release-checks); automated gates are not a substitute
- rerun `npm run verify -- release` and confirm the embedded Crabbox `platform-build` plus `browser-dogfood-smoke` matrix passed on `macos`, `ubuntu`, and `windows-native` with artifacts under `.artifacts/platform-smoke/`
- run `npm run verify -- lifecycle` for configured-source `/reload`, exact `--session-id` relaunch, managed-session continuity, persisted-spill, and Pi failure-patch regression coverage (required before publish; see [Pre-release checks](#pre-release-checks))
- confirm [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) still maps every current baseline inventory section to docs, runtime handling, tests, and validation status
- manually exercise real-browser `/reload` and full restart plus exact `--session-id` relaunch or `/resume` continuity when release risk warrants browser-level confidence beyond the fake upstream harness
- publish only after the tarball contents and isolated packaged-extension smoke check match expectations
