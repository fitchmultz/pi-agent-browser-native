# Critique: `docs/plans/electron-extension-2026-05-20.md`

**Date:** 2026-05-20
**Scope:** spot critique only. Plan stays the artifact of record; export is reference.

## 1. Top 3 under-specified seams

1. **`details.electron.launch` persisted-details branch.** Plan says "same persisted-details branch used by `details.refSnapshot`" (Details contract; WI-3 Done-when; WI-5 Done-when) but never names the actual mechanism. The canonical wiring is `restoreSessionRefSnapshotsFromBranch` at `extensions/agent-browser/index.ts:2467` (read site at `:2484`, write extractor `extractRefSnapshotFromData` at `:2445`). Implementer must guess whether to (a) extend that loop to also surface launches, or (b) add a sibling restorer keyed off `details.electron.launch`. Snapshot is per-call/per-session; launches are per-process and outlive snapshot churn — same branch, but different lifecycle. Name the function and pick (a)/(b).
2. **"`sessionMode: 'fresh'`-equivalent" wiring.** Plan says "reuse the existing fresh-launch wiring" without naming it. The relevant surface is `buildManagedSessionOutcome` / `formatManagedSessionOutcomeText` (`index.ts:3795–3826`) plus the implicit-session machinery in `runtime.ts:984–1138`. Two viable routes are not distinguished: (a) the embedded `connect` call inside `electron.launch` is itself invoked with `sessionMode: "fresh"` (driven through `buildExecutionPlan`), or (b) the launch synthesizes a managed-session outcome record without touching `sessionMode`. These have different `RQ-0077` obligations and different test shapes. Pick one.
3. **Linux Electron evidence heuristic.** "The binary *typically* links against `libffmpeg.so`, sits next to `resources/app.asar` or `resources/app/`, and its parent directory contains `chrome_*` resources" is not a gate. Implementer needs: AND vs OR semantics, Snap (`/snap/<name>/current/` — the `Exec=` path is a wrapper script in `/snap/bin/`) and Flatpak (`/var/lib/flatpak/app/<id>/current/active/files/`) binary resolution, and `.desktop` filtering rules (`NoDisplay=true`, `Hidden=true`, `Type=Application`). Specify or downgrade Linux discovery to a documented best-effort with a known false-negative list.

## 2. Specificity balance

**Over-specified — should be implementer-owned:**
- Schema pins `timeoutMs` default to `10000`. Pinning a bound is fine; the exact default belongs in code.
- WI-3 Done-when pins the field name `details.managedSessionOutcome` for launch-failure reporting. Plan should say "the existing managed-session outcome path"; the field belongs to `RQ-0077` machinery.
- Lifecycle data flow step 5 reads as prescriptive code ("Poll `<userDataDir>/DevToolsActivePort` until populated"). Fine as the standard CDP shape; move polling cadence/backoff out of the plan entirely (the export wisely did not specify it).

**Dropped from export — should be restored:**
- Export's hard rule "no user-provided port in v1." The plan's schema omits `port` but never states the rationale, so it reads as an oversight rather than a decision.
- Export framing: "either a new flag on `qa` or `electron: { action: "qa", … }`." Plan keeps both open in WI-9 without choosing. The two paths have different AGENTS.md "When changing X" obligations (`qa` rule vs. new `electron` rule), so the deferral changes WI-9's Key files set.
- Export distinguished the launch-failure modes (timeout vs. spawn error vs. port-not-found). Plan collapses them into one "best-effort cleanup of temp resources" line.

## 3. Contradictions and missing dependencies

- **`highRisk` survivor after safety classification was removed.** MVP launch record still includes `highRisk` (Details contract), and lifecycle steps still mention "risk classification" (`electron.list` step 3; WI-2 Done-when "risk label, omitted-count summary"). User-mid-flow decision explicitly removed classification. Direct contradiction.
- **WI-8 dependency arrow is inverted.** WI-8 Done-when says "A benchmark scenario shows the probe replaces ≥ 2 separate calls" — the benchmark needs WI-8, not the reverse. Plan lists Dependencies: WI-4, WI-7, but Implementation order runs WI-8 *before* WI-7. Pick one: drop WI-7 from WI-8's deps, or merge the probe-benchmark scenario into WI-8.
- **AGENTS.md "When changing categories" not cited.** WI-3 introduces `policy-blocked` as a failure category. `AGENTS.md:62` requires extending the union + classifier in `lib/results/shared.ts`, the prose list in `docs/TOOL_CONTRACT.md`, and tests. Plan touches `shared.ts` only for `AgentBrowserNextAction.params`, not for the category union.
- **AGENTS.md "When changing next-action recommendations" not cited.** Plan adds new `nextActions` ids (`cleanup-electron-launch`, plus tab/snapshot/status follow-ups). `AGENTS.md:63` names `buildAgentBrowserNextActions` and `test/agent-browser.results.test.ts`. Neither appears in any WI's Key files.
- **RQ-0086 / RQ-0087 / RQ-0072 cross-references missing where operational.** WI-5 (`/reload` + `/resume` restore) is exactly where tab-drift (`RQ-0086`) and page-scoped ref invalidation (`RQ-0072`, `RQ-0087`) precedents apply — restoring a wrapper-launched Electron session after Pi reload can land the user on `about:blank` against a stale snapshot. Background lists these as precedents but WI-5 does not cite them.
- **WI-9 → WI-8 dependency is organizational, not technical.** Probe (compact state collection) and current-session QA (assertion-style smoke) compose different upstream commands. Confirm/break the link.

## 4. Risk of over-planning

- **Background section (≈180 lines) is reference material, not a plan.** "External CDP best practices," "Upstream baseline," and "What 'first-class token-efficient' means" duplicate the export and `docs/COMMAND_REFERENCE.md`. For a strict thin-wrapper plan, collapse to 1 paragraph + links. RQ-0068 framing stays.
- **WI-8 bundled into MVP blurs the RQ-0068 revisit justification.** The dogfood evidence cited is launch/discovery pain; the probe is generic state compaction. Keep WI-8 if the user wants it shipped, but mark its revisit evidence separately so the line between "lifecycle warrants a shorthand" and "compaction warrants a shorthand" stays visible. Otherwise the next revisit will be muddier.
- **"Implementation order" duplicates the WI list.** Merge into the WI list, or keep only the sentence about WI-7/WI-8 ordering.
- **"Decisions resolved at mid-flow check-in" duplicates resolutions stated inline.** Collapse to a 4-bullet preamble or delete.

## 5. Questions that would change implementation order

1. **Does WI-8 actually depend on WI-7's benchmark?** No — fix the arrow (see §3). WI-8 can land independently if it ships its own benchmark scenario; WI-7 becomes redundant or gets renamed to "lifecycle-only benchmark."
2. **Does WI-9 depend on WI-8?** Probably no. If confirmed independent, WI-9 can parallelize with WI-6/WI-7.
3. **Where does `lib/electron.ts` live?** `extensions/agent-browser/lib/` is consistent with `runtime.ts` / `process.ts` / `temp.ts` / `parsing.ts`. Given discovery is platform-specific and growth is plausible (Windows follow-up), prefer `lib/electron/{discovery,launch,cleanup}.ts` so platform branches don't bloat one file. One-line decision.
4. **`qa` extension: flag on existing `qa` or new `electron.action: "qa"`?** Pick now — changes WI-9's Key files and which AGENTS.md "When changing X" rule applies.
5. **Fresh-session wiring: drive `sessionMode: "fresh"` through embedded `connect`, or synthesize the outcome record?** (See §1 #2.) Changes WI-3 vs. WI-5 test scope.
6. **Snap/Flatpak binary resolution on Linux: in-scope for v1 discovery, or documented gap?** Decides whether Linux discovery ships behind a flag.

---

**Net assessment:** plan is solid on shorthand shape, scope boundary, and RQ-0068 framing. The seams above are concrete enough to fix in-place without restructuring; do that before WI-2 starts.
