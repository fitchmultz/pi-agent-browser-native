# Ponytail audit cleanup: Plan

**Date:** 2026-06-18
**Status:** Executed through first safe cleanup pass

## Goal

Turn the repo-wide ponytail audit into a short, conservative cleanup queue. The pass should remove copied guidance, thin wrappers, and contract-free indirection while preserving the package's thin-wrapper posture and public `agent_browser` contract.

## Guardrails

- Scope is whole repo: code, docs, tests, scripts, verification gates, and config.
- Prefer consolidation over deletion unless evidence proves a path is obsolete.
- Keep anything that owns input validation, user-facing result shape, browser lifecycle safety, cross-platform behavior, or public package UX.
- Do not create a new audit framework, checklist runtime, or cleanup ledger. The implementation proof lives in the PR diff, `rg` checks, and existing verification gates.

## Background

- Active docs should update the smallest canonical source instead of copying rules across files (`docs/SOURCE_OF_TRUTH.md:13`, `docs/SOURCE_OF_TRUTH.md:28`).
- The extension is intentionally thin; upstream `agent-browser` remains the behavior source of truth (`docs/ARCHITECTURE.md:12`, `docs/REQUIREMENTS.md:34`).
- Reusable browser recipes are still rejected without repeated dogfood or benchmark evidence (`docs/ARCHITECTURE.md:85`).
- Verification orchestration lives in `verifySteps`, not in scattered prose (`scripts/project.mjs:311`).

## Ranked Work Items

1. **Collapse duplicated release/platform-smoke prose.**
   - Targets: `AGENTS.md:46`, `AGENTS.md:48`, `README.md:620`, `README.md:632`, `docs/RELEASE.md:43`, `docs/RELEASE.md:73`, `docs/platform-smoke.md:12`, `docs/SUPPORT_MATRIX.md:61`.
   - Keep: `README.md` as user entry point, `docs/RELEASE.md` as maintainer release flow, `docs/platform-smoke.md` as platform detail, `scripts/project.mjs:311` as executable gate source.
   - Cut rule: replace repeated command lists or gate explanations with links when the destination already says the same thing.
   - Proof: `rg -n "smoke:platform|verify -- release|platform-smoke" README.md AGENTS.md docs` shows no conflicting active instructions.

2. **Review platform smoke script aliases before deleting any.**
   - Targets: `package.json:84`, `package.json:85`, `package.json:86`, `package.json:87`, `scripts/platform-smoke/build-ubuntu-image.mjs:6`, `scripts/project.mjs:230`, `scripts/platform-smoke.mjs:74`.
   - Cut rule: remove a script alias or wrapper only if no docs, package smoke, release flow, or external-facing instructions name it.
   - Default likely outcome: keep public aliases if docs still advertise them; only shrink private duplicate validation.
   - Proof: `rg -n "smoke:platform:(ubuntu-image|macos|ubuntu|windows-native)|platform-smoke" README.md docs AGENTS.md package.json scripts test` before and after any change.

3. **Treat generated command-reference bulk as mostly out of scope.**
   - Target: `docs/COMMAND_REFERENCE.md:858` generated capability baseline.
   - Cut rule: do not hand-delete generated blocks. Only change this if the implementation also changes `scripts/agent-browser-capability-baseline.mjs` and passes docs generation checks.
   - Proof: `npm run docs -- command-reference check` after any generated-block change.

4. **Runtime cut pass: schemas and obvious indirection first.**
   - Targets: duplicate Electron launch schema branches in `extensions/agent-browser/lib/input-modes/params.ts:106`, `:116`, `:126`, `:136`; job descriptor indirection in `extensions/agent-browser/lib/input-modes/job.ts:217` and `:254`.
   - Cut rule: simplify only if the replacement keeps the same TypeBox schema, error text, compiled argv, and test coverage.
   - Proof: focused schema/input-mode tests plus full typecheck.

5. **Runtime investigation-only candidates.**
   - Targets: workspace scanners in `extensions/agent-browser/lib/input-modes/lookups.ts:220` and `:385`; snapshot ranking in `extensions/agent-browser/lib/results/snapshot-high-value-controls.ts:81`; artifact contract shapes in `extensions/agent-browser/lib/results/contracts.ts:69`.
   - Cut rule: no deletion in the first implementation pass unless tests prove the behavior is redundant and docs do not promise it.
   - Proof: existing source/network lookup, snapshot, artifact, presentation, and contract tests remain green.

6. **Do not cut `results/shared.ts` in the first pass.**
   - Target: `extensions/agent-browser/lib/results/shared.ts:2`.
   - Reason: it is a documented compatibility barrel preserving the historical import surface. Deleting it is a migration, not a ponytail cut.
   - Future cut rule: only remove after all internal imports move to focused modules and package compatibility risk is accepted in the same PR.

## Proof Gates

- `rg` stale-reference checks for every deleted script, export, doc anchor, or filename.
- `npm run docs` if generated docs or playbook fragments are touched.
- `npm run typecheck` for TypeScript-only runtime edits.
- `npm run verify` before calling an implementation PR complete.
- For docs-only edits, at minimum run the relevant docs command and inspect links/anchors touched by the diff.

## Open Questions

- Are the `smoke:platform:*` npm scripts treated as public user-facing entry points outside this repo's docs? If yes, keep aliases and only remove duplicate prose.
- Should a follow-up implementation cap itself to the top 2–3 cuts? Recommended: yes, to avoid a cleanup PR that becomes a broad rewrite.

## Resolution (2026-06-18): Work Items 1–3

Scoped docs-only pass. Runtime TypeScript (WI 4–5) was handled concurrently by another agent; this pass did not touch `extensions/` or `test/`.

- **WI 1 (collapse duplicated release/platform-smoke prose) — done, conservatively.**
  - `README.md`: merged the two back-to-back platform-smoke sections into one. Removed the duplicate standalone command block (`check` / `ubuntu-image` / `doctor` / `all`) and the duplicate suite/artifact prose; kept the canonical release-gate block (`doctor` → `check` → `ubuntu-image` → `doctor` → `verify -- release`). Standalone and per-target commands remain discoverable via a named pointer to `docs/platform-smoke.md`.
  - `docs/RELEASE.md`: collapsed the "direct Crabbox diagnostics" block, which was a verbatim duplicate of `platform-smoke.md`'s required gate. Replaced the 4 duplicated commands with a named pointer + `platform-smoke.md#required-release-gate` anchor; retained the distinct `crabbox list` lease inspection and the green-gate sentence.
  - `AGENTS.md` (Crabbox platform smoke paragraph): kept the agent-essential release-blocking checklist, required targets, and blocked-not-skipped rule; deferred the verbatim `platform-build`/`browser-dogfood-smoke` suite detail and artifact/lease prose to `docs/platform-smoke.md` (now named as owner of matrix, suites, artifact contracts, and lease cleanup).
  - **Intentionally kept** (reviewed, not conflicting instructions):
    - `AGENTS.md` "npm verification facade" paragraph — the agent's primary verify-mode runbook; the duplicated `release` sentence is one compressed line and trimming package mechanics (`prepack`/`prepare`/`build`/`prepublishOnly`) risked agent clarity for negligible gain.
    - `docs/SUPPORT_MATRIX.md` Crabbox row — evidence/status prose tied to dated pass evidence, not an active command instruction; it already links `platform-smoke.md`.
    - `docs/platform-smoke.md` required gate and `docs/RELEASE.md` pre-release gate / `verify -- release` explanation — these are the canonical source of truth and the maintainer release flow respectively (the "Keep" set in WI 1).
- **WI 2 (platform-smoke script aliases) — reviewed, all kept.** `rg` across `README.md docs AGENTS.md package.json scripts test CHANGELOG.md` shows every targeted alias is referenced: `smoke:platform:doctor`, `:ubuntu-image`, `:all` are in README/AGENTS/RELEASE/SUPPORT_MATRIX/`platform-smoke.md`/`scripts/platform-smoke.mjs` help/`test/platform-smoke.test.ts`; `:macos`/`:ubuntu`/`:windows-native` are the documented per-target commands in `platform-smoke.md` (and `:windows-native` is asserted in `test/platform-smoke.test.ts`). The bare `smoke:platform` alias (`package.json:82`) has zero external references but is a harmless CLI-entrypoint convenience and was not in the WI 2 target list, so it was kept to avoid breaking habits (matches the "Default likely outcome"). No private duplicate validation was found to shrink. `scripts/platform-smoke/build-ubuntu-image.mjs`, `scripts/platform-smoke.mjs`, and `scripts/project.mjs` `validatePlatformSmokePassthrough` are the implementations/validation behind these public aliases, not duplications.
- **WI 3 (generated command-reference bulk) — out of scope, no action.** No edits to `scripts/agent-browser-capability-baseline.mjs` or generated HTML-comment blocks in `docs/COMMAND_REFERENCE.md`. `npm run docs` confirms playbook and command-reference baseline are in sync.
- **Proof gates:** `rg -n "smoke:platform|verify -- release|platform-smoke" README.md AGENTS.md docs` (excluding `docs/plans/`) shows only consistent, purpose-distinct references — no conflicting active instructions. `npm run docs` passes.

## Resolution (2026-06-18): Work Item 4

Scoped runtime pass. Docs/release/platform-smoke prose was handled concurrently by another agent; this pass did not touch those surfaces.

- **WI 4 (runtime schemas and obvious indirection) — done, behavior-preserving.**
  - `extensions/agent-browser/lib/input-modes/params.ts`: replaced four duplicate `electron.launch` schema branches with one `electronLaunchVariant` helper. The helper only centralizes the shared launch fields; each target field remains distinct (`appPath`, `appName`, `bundleId`, `executablePath`).
  - `extensions/agent-browser/lib/input-modes/job.ts`: removed the `JobStepDescriptor` mirror. `JOB_STEP_ALLOWED_FIELDS` remains the source for allowed fields, and `JOB_STEP_COMPILERS` now only maps actions to compilers.
  - **Intentionally kept:** `results/shared.ts`, lookup scanners, snapshot ranking, and artifact contract shapes. These are compatibility or contract surfaces, not first-pass cuts.
  - **Proof gates:** schema output parity was checked by the implementing agent; focused schema/input-mode/electron/runtime/source-lookup/import-boundary tests passed; `npm run typecheck` passed.

## Resolution (2026-06-18): Upstream 0.28.0 validation follow-up

Full release validation initially failed because the local upstream `agent-browser` was `0.28.0` while the checked-in capability baseline still targeted `0.27.3`. This was a validation requirement, not part of the planned ponytail cleanup.

- **Rebaseline — done, conservative.**
  - Updated `scripts/agent-browser-capability-baseline.mjs`, generated `docs/COMMAND_REFERENCE.md` blocks, `docs/SUPPORT_MATRIX.md`, and the real-upstream output-shape fixture to target `agent-browser 0.28.0`.
  - Captured the only new local/infra upstream surfaces found in 0.28.0: `mcp`, `plugin add/list/show/run`, plugin-backed `auth login --credential-provider`, and `AGENT_BROWSER_PLUGINS`.
  - Updated `extensions/agent-browser/lib/command-policy.ts` and `test/agent-browser.runtime.test.ts` so `mcp` and known `plugin` commands stay sessionless. No compatibility shim for older upstream versions was added.
- **Platform setup — refreshed.**
  - Built the local Ubuntu Crabbox image for `agent-browser 0.28.0`.
  - Refreshed the Windows Parallels `pi-extension-windows-template` `crabbox-ready` snapshot to `agent-browser 0.28.0` and verified browser cache/prewarm.
- **Final proof gate:** `npm run verify -- release` passes on 2026-06-18 with default unit/fake gate, command-reference checks, lifecycle harness, packaged Pi smoke, and macOS/Ubuntu/native-Windows Crabbox platform smoke.

## References

- `docs/SOURCE_OF_TRUTH.md`
- `docs/ARCHITECTURE.md`
- `docs/REQUIREMENTS.md`
- `docs/RELEASE.md`
- `docs/platform-smoke.md`
- `docs/SUPPORT_MATRIX.md`
- `docs/COMMAND_REFERENCE.md`
- `scripts/project.mjs`
- `package.json`
