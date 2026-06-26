# Changelog

## Unreleased

## 0.2.62 - 2026-06-26

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, playbook guidance, and real-upstream output-shape metadata for `agent-browser` `0.31.0` / vercel-labs/agent-browser@5acf7f9.
- Added upstream `--namespace`, `--restore`, restore-check flags, and `session id` / `session info` support to wrapper parsing, session policy, launch-scoped flag handling, and docs.

### Fixed

- Made wrapper-managed browser state namespace-aware across tab/ref tracking, allowed-domain policy, trace/profiler ownership, branch restore, cleanup, nextActions, and fresh-launch recovery.
- Reduced post-click diagnostic fragility for upstream `agent-browser 0.31.0`: CSS selector clicks without upstream href/navigation fields now skip immediate helper probes, while ref/href clicks keep navigation summaries and overlay diagnostics.
- Preserved namespace context for managed-session failure recovery and missing-binary nextActions.

### Validation

- Ran `npm run verify`, `npm run docs -- command-reference check`, `npm run typecheck`, focused runtime/diagnostic/passthrough tests, `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run verify -- lifecycle`, `npm run smoke:platform:doctor`, `npm run smoke:platform:all`, `npm publish --dry-run`, and `git diff --check`.
- Ran the required reviewer subagent loop until it returned `no findings`.

## 0.2.61 - 2026-06-24

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, playbook guidance, and real-upstream output-shape metadata for `agent-browser` `0.30.1` / vercel-labs/agent-browser@7379f7dbea76ad8dbf47f177349c4c3ce9263dcb.
- Removed the constrained `job.assertUrl` glob-to-`wait --fn` workaround now that upstream `wait --url` matches glob patterns such as `**/dashboard` against the full active URL.

### Validation

- Ran `npm run verify`, `npm run docs`, focused `npx tsx --test test/agent-browser.extension-input-modes.test.ts`, `npm run verify -- command-reference`, and `git diff --check`.
- Probed upstream `agent-browser 0.30.1` directly: `wait --url "**/dashboard"` succeeds after `pushstate /dashboard`; `find ... uncheck` and `wait <selector> --state hidden|detached` still fail, so only the URL-glob workaround was removed.

## 0.2.60 - 2026-06-24

### Changed

- Removed a dead `as never` cast and unreachable try/catch from the `agent_browser` collapsed-output "to expand" keybinding hint. `app.tools.expand` is a host-registered keybinding id (coding-agent augments pi-tui's `Keybindings` via declaration merging), so the id is resolved cast-free via `getKeybindings().getKeys(...)` with the stock `ctrl+o` fallback preserved for bare-node test contexts. No behavior change; the `pi-coding-agent` package stays type-only in the entrypoint import path so startup tax is unchanged.

### Validation

- Ran `npm run verify` (default gate: docs, typecheck, 575/575 unit, command-reference baseline + live drift), `npm run verify -- startup-profile --samples 3` (median 50.1ms, < 250ms budget), `npm run verify -- real-upstream`, `npm run verify -- lifecycle`, `npm run verify -- dogfood`, `npm run verify -- pre-pr`, and `npm run doctor` against the local checkout.
- Ran an independent reviewer subagent over the diff; no blockers found and the compaction-orphan audit claim was confirmed disproven against Pi 0.80.2 source.

## 0.2.59 - 2026-06-24

### Changed

- Shortened the always-on `agent_browser` prompt guidance by over 1KB while preserving the native-tool trigger, open → `snapshot -i` workflow, `sessionMode=fresh`, artifact verification, and extraction rules.
- Moved the quick live-search guidance onto `agent_browser_web_search` so browser-search routing stays available without duplicating that guidance in the main browser tool prompt.

### Validation

- Ran `npm run verify -- release`, `npm run doctor`, and `npm run verify -- startup-profile --samples 3` against the local checkout.
- Ran tmux-driven Pi checkout smoke with `pi --approve --model zai/glm-5.2:high --no-extensions --no-skills --session-dir <tmp> -e .`, confirming the model chose `agent_browser` for `open` + `snapshot -i`, chose `agent_browser_web_search` for live search, and closed the managed browser session.
- Ran an independent reviewer subagent over the diff; no blockers found.

## 0.2.58 - 2026-06-23

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.80.1` and raised the doctor/runtime floor to Pi `0.80.1`.
- Moved extension source/test imports that typecheck against old root `@earendil-works/pi-ai` globals to `@earendil-works/pi-ai/compat`, matching the Pi 0.80 migration guidance.

### Validation

- Pending in this release train.

## 0.2.57 - 2026-06-22

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.79.10` and refreshed `.pi-fleet-tested-version` for the installed `pi 0.79.10` runtime.

### Fixed

- Stabilized the timeout-progress regression test by giving the non-timeout setup open a larger per-call watchdog under full release-suite load.

### Validation

- Reviewed the installed Pi `0.79.10` changelog, extension docs, package docs, security/project-trust docs, and extension API types; no wrapper runtime change was required for the new compaction event metadata.
- Ran `npm run verify -- release`, `npm run verify`, `npm run verify -- lifecycle`, `npm run verify -- package-pi`, `npm run docs`, `npm run doctor`, `npm audit --json`, `npm run check:platform-smoke`, `npm run smoke:platform:doctor`, `npm run smoke:platform:all`, and `git diff --check` against `agent-browser 0.29.1` and `pi 0.79.10`.

## 0.2.56 - 2026-06-21

### Fixed

- Corrected the local Pi development baseline to `@earendil-works/*` `0.79.9`, matching the installed `pi 0.79.9` runtime used for release validation.

### Validation

- Re-ran `npm install` and `npm audit --json`; dependency install completed and audit reported zero vulnerabilities.

## 0.2.55 - 2026-06-21

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, playbook guidance, platform smoke image tag, and real-upstream output-shape metadata for `agent-browser` `0.29.1` / vercel-labs/agent-browser@4572acf0d71c0086009206c9c1e2136fc54ec9e5.
- Documented the new upstream `@agent-browser/sandbox` package guidance, `installSystemDependencies: false`, and stricter `install --with-deps` nonzero behavior while keeping sandbox support outside this thin Pi wrapper.
- Updated local Pi development dependencies to `@earendil-works/*` `0.79.8`, kept Pi core package peers host-provided, and marked those peers optional to avoid install-time peer noise for package consumers.

### Fixed

- Kept optional recording paths from being misclassified as required screenshots when release-smoke prompts are collapsed into one line for tmux automation.
- Added npm overrides for vulnerable transitive dev dependencies so `npm audit` reports zero vulnerabilities without adding runtime dependencies.

### Validation

- Ran `npm run verify -- release` against `agent-browser` `0.29.1`; after rebuilding the Ubuntu image and refreshing the Windows `crabbox-ready` snapshot, the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke.
- Ran `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run verify -- benchmark`, `npm run verify -- startup-profile --samples 3`, `npm run docs`, `npm run doctor`, `npm audit --json`, `npm run check:platform-smoke`, `npm run smoke:platform:ubuntu-image`, `npm run smoke:platform:doctor`, focused prompt-guard tests, and `git diff --check`.
- Ran tmux-driven Pi checkout dogfood with `pi --approve --no-extensions --no-skills -e .`, covering the public Sauce Demo checkout-overview flow with screenshot/recording evidence and no order placement; then verified the collapsed one-line screenshot-plus-recording close guard on `https://example.com` after rebuilding `dist/`.

## 0.2.54 - 2026-06-19

### Fixed

- Accepted upstream `plugin list` / `plugin show` JSON and blocked bare `mcp` native-tool calls while preserving `mcp --help`.

### Validation

- Ran `npm run verify -- release` against `agent-browser` `0.28.0`; the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke.
- Ran `npm run verify -- real-upstream`, `npm run docs`, `npm run doctor`, `npm run check:platform-smoke`, `npm run smoke:platform:ubuntu-image`, `npm run smoke:platform:doctor`, and `git diff --check`.
- Ran a tmux-driven Pi checkout dogfood with `pi --approve --no-extensions --no-skills -e .`, covering `--version`, `mcp --help`, `plugin list`, fresh `example.com` open plus `snapshot -i`, `qa` on `react.dev`, and browser close.

## 0.2.53 - 2026-06-18

### Changed

- Rebaselined upstream capability metadata, command reference, support matrix, platform-smoke image tag, and real-upstream output-shape metadata for `agent-browser` `0.28.0` / vercel-labs/agent-browser@6323df571ffd17d14e60ec19fcb56cc1caf498ab.
- Documented upstream `mcp`, `plugin add/list/show/run`, plugin-backed `auth login --credential-provider`, and `AGENT_BROWSER_PLUGINS` surfaces while keeping the wrapper thin and compatibility-shim-free.
- Marked `mcp` and known `plugin` commands as sessionless wrapper calls so local/infra commands do not get an implicit managed browser session.
- Collapsed duplicated release/platform-smoke prose across README, release docs, and agent guidance in favor of `docs/platform-smoke.md` as the detailed source of truth.
- Simplified duplicate internal schema/job compiler plumbing without changing the public tool schema or generated argv behavior.

### Fixed

- Retried the Windows platform dogfood smoke once after transient first browser-open failures, matching the existing Windows browser prewarm tolerance while preserving real dogfood failures.

### Validation

- Ran `npm run verify -- release` against `agent-browser` `0.28.0`; the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke after refreshing the Ubuntu image and Windows `crabbox-ready` snapshot.
- Ran `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run docs`, `npm run verify -- command-reference`, and `git diff --check`.

## 0.2.52 - 2026-06-15

### Changed

- Rebaselined the upstream capability metadata, command reference, support matrix, platform-smoke image tag, and real-upstream output-shape metadata for `agent-browser` `0.27.3` / vercel-labs/agent-browser@2c7991c9eccca1c9db6eee1a26a713414778de5a. This is an install-only upstream update from the prior baseline; no wrapper feature, shim, or inventory-token change was added.
- Updated the local Pi development baseline to `@earendil-works/*` `0.79.4`, refreshed `.pi-fleet-tested-version`, and refreshed `package-lock.json` with npm 11 while keeping the intentional doctor floor at Pi `0.79.0`.

### Fixed

- Updated the lifecycle release harness prompt-readiness check to accept Pi 0.79.4 footer units such as `1.0M`, avoiding false readiness timeouts after successful startup.

### Validation

- Ran `npm publish --dry-run` against `agent-browser` `0.27.3` and Pi `0.79.4`; the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke.

## 0.2.51 - 2026-06-11

### Fixed

- Made the source-package `prepare` lifecycle install dev dependencies with scripts disabled when Pi's `npm install --omit=dev` package path omits the compiler and peer type packages, so GitHub/source installs can still build `dist/` from a clean clone without changing runtime dependency policy.

### Validation

- Reproduced the `pi install -l --approve https://github.com/fitchmultz/pi-agent-browser-native@v0.2.50` source-install failure, then verified production-dependency source builds, project-local GitHub install, project-local npm install, and release gates before publish.

## 0.2.50 - 2026-06-11

### Changed

- Keep visual/model-facing secret redaction and the native-tool bash guard while allowing loaded config credential sources and parent environment variables to pass through to upstream/provider runtime paths.
- Allow trusted project-local package config to provide web-search credential sources and browser profile/executable prompt guidance instead of limiting those capabilities to global or override config.

### Validation

- Ran focused config/web-search/process/redaction/clipboard/extension tests, `npm run typecheck`, `npm run docs`, `npm run verify -- command-reference`, the default `npm run verify` gate, and the release gate through lifecycle, package Pi, and platform smoke validation.

## 0.2.49 - 2026-06-11

### Changed

- Ship the Pi package entrypoint as compiled JavaScript under `dist/` so installed package startup no longer pays runtime TypeScript loading cost.
- Added clean-build orchestration before verification, package, lifecycle, platform-target, test, startup-profile, and GitHub/source install flows that consume generated `dist/` output.
- Replaced invasive full-Pi startup profiling with a safe direct-entrypoint profiler that clean-builds `dist/`, measures fresh Node import/factory samples, and refuses the old timeout-driven Pi/tmux workflow.

### Fixed

- Prevented clean checkouts from validating missing or stale compiled package entrypoints by building before package/lifecycle/startup consumers, building on GitHub/source install, and ignoring generated `dist/` in the repo.
- Kept local config and doctor helpers aligned with the compiled package entrypoint while avoiding stale local `dist/` policy reads.

### Validation

- Ran focused build/package/lifecycle/config/doctor/startup tests, `npm run typecheck`, `npm run docs`, `npm run verify -- package-pi`, `npm run verify -- startup-profile --samples 10`, an independent reviewer loop to no findings, and a reload smoke using the native `agent_browser` tool against `https://example.com`.

## 0.2.48 - 2026-06-11

### Changed

- Rebaselined the upstream capability metadata, command reference, support matrix, and real-upstream contract metadata for `agent-browser` `0.27.2` after reviewing the upstream changelog.
- Forward explicit long `wait <ms>` / `wait --timeout <ms>` calls now that upstream `agent-browser` `0.27.2` fixes wait timeout and client read-budget handling; the wrapper derives a longer subprocess watchdog when the caller does not provide top-level `timeoutMs`.
- Split `browser-run/prepare.ts` concerns into focused direct-anchor download, network page-filter, wait-timeout, scroll-shim, and snapshot-filter preparation modules while preserving the existing coordinator behavior.
- Refactored constrained `job` step compilation around per-action descriptors so unsupported-field validation and compilation stay paired.
- Added a documentation source-of-truth map and moved implementation-deep support-matrix closure notes into maintainer notes so the active release checklist stays navigable.
- Moved superseded implementation-plan and v1 contract drafts into `docs/archive/` with clear non-canonical archive guidance while keeping them out of the published package.
- Added `npm run verify -- pre-pr` as a named local confidence gate that runs the default verification stack plus package-content checks without release-only lifecycle, platform, live dogfood, or benchmark cost.

### Fixed

- Removed stale docs that said `wait 30000` was intentionally blocked by the wrapper.
- Rejected unsupported fields for every constrained `job` step action instead of silently ignoring irrelevant fields.
- Broke the browser-run orchestration import cycle and added a static acyclic import-boundary regression test.
- Added package verification for local Markdown links in packed docs and converted repo-only documentation references to external GitHub links or plain text so npm docs remain navigable.
- Clarified support-matrix evidence so current `agent-browser 0.27.2` gates are separated from historical pending-refresh release gates.
- Aligned the documented/tested AWS provider environment allowlist with the runtime-forwarded AgentCore AWS variables.
- Kept env/global web-search registration available when project-local config is not approved, while trusted project disables or config errors still suppress unsafe search execution.
- Stopped running click-dispatch probes for unresolved `find … click` locators to avoid false failures on frame-scoped upstream clicks.

### Validation

- Ran focused wrapper/process tests, `npm run typecheck`, `npm run docs`, `npm run verify -- command-reference`, `npm test -- --test-concurrency=1`, `npm run verify -- real-upstream`, `npm run doctor`, `npm run verify -- package`, and `npm run verify -- dogfood` against `agent-browser` `0.27.2`; final release validation evidence is recorded in `docs/SUPPORT_MATRIX.md`.

## 0.2.47 - 2026-06-08

### Changed

- Updated the local Pi development baseline and release guidance to Pi 0.79.0, including Project Trust-aware lifecycle/package/platform validation commands.
- Kept this extension risk-on by loading project-local package config by default while honoring explicit Pi `--no-approve` / `-na` opt-out runs.
- Updated the `pi-extension-development` skill guidance for Pi 0.79.0 and for explicit user consultation before behavioral changes.

### Fixed

- Made platform smoke package install/list checks use Pi 0.79 approval flags so clean target-local package validation is deterministic.
- Ensured project-local package config can be explicitly skipped without losing global, override, or environment-backed web-search configuration.

### Validation

- Ran docs, typecheck, unit/default verify, package smoke, lifecycle, deterministic dogfood, doctor, platform doctor, full release/Crabbox gates, and interactive tmux native-tool smoke before publish.

## 0.2.46 - 2026-06-08

### Changed

- Reduced native extension startup cost by replacing heavy top-level Pi and TypeBox runtime imports with lightweight local schema and event helpers while preserving the public tool schemas.
- Kept custom browser tool rendering compact without importing Pi's full coding-agent runtime during extension load.

### Fixed

- Fixed issue #84 by cutting local cold extension import plus factory registration from roughly 1.1 seconds to roughly 76 milliseconds in checkout measurements.
- Stabilized timeout partial-progress diagnostics so post-navigation timeouts are recognized from later completed-step evidence even when live URL recovery is unavailable under load.

### Validation

- Added a cold-start budget test for the real extension entrypoint, schema parity coverage against the canonical TypeBox/StringEnum builders, rendering coverage for JSON highlighting plus collapsed-output expand hints, and stabilized deterministic dogfood smoke by avoiding a rapid Windows browser close/relaunch race.

## 0.2.45 - 2026-06-06

### Added

- Added top-level `outputPath` for successful browser CLI results so extraction, snapshot, and diagnostic payloads can be saved as durable local files without scraping transcript text. Explicit upstream `--json` output remains parseable, and failed upstream results do not write output files.
- Added direct selector/ref support to `semanticAction` for `click`, `check`, and `fill`, including optional named-session targeting.
- Added constrained `job` `type` steps with optional human-paced `delayMs` and final `press`, capped for delayed typing and compacted in model-visible batch prose.
- Added timeout partial-progress diagnostics with generated-step labels, declared artifact state, live-vs-planned page evidence, safe retry actions for read-only/idempotent steps, and fresh-session retry handling when no live page was recovered.

### Changed

- Increased the default wrapper child-process watchdog to 35 seconds while keeping upstream IPC operation waits clamped below the 30-second upstream read timeout.
- Improved `record start` / `record restart` lifecycle presentation: future WebM outputs are pending/open until `record stop`, `record restart` can show the previous recording saved by the restart, and ffmpeg warnings cover both start-like commands.
- Tightened dialog timeout precedence so explicit top-level `timeoutMs` overrides dialog-specific watchdog defaults.
- Updated README, command reference, tool contract, architecture, requirements, support matrix, and generated playbook guidance for timeout recovery, artifact lifecycle, output files, direct semantic selectors, and paced job typing.

### Fixed

- Avoided executable timeout retry actions for mutating steps that may already have clicked, filled, typed, selected, or submitted state before the watchdog fired.
- Kept `outputPath` write failures aligned with the result-category contract by removing stale success-only category fields when the wrapper-side write fails.
- Rejected unsupported fields on `job` `type` steps instead of silently accepting irrelevant step fields.

### Validation

- Ran full release verification for this change set before publish, including docs drift checks, TypeScript, unit/fake suite, command-reference verification, dogfood smoke, and release/package validation gates.

## 0.2.44 - 2026-06-04

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.78.1` after reviewing the installed Pi 0.78.1 changelog, docs, examples, and extension source. The audit found no runtime migration needed for `ctx.mode` or command-only `ctx.getSystemPromptOptions()`, and kept the public peer dependency ranges non-pinning.
- Extended the read-only package doctor with a warning-only `pi --version` check so release validation can catch a Pi CLI older than the audited 0.78.1 floor without making Pi 0.78.1 a hard runtime requirement.

### Validation

- Ran checkout-based interactive `tmux` Pi dogfood with `pi --no-extensions --no-skills -e .` on Pi 0.78.1: `agent_browser` opened and snapshotted `https://example.com`, ran a QA preset against `https://react.dev` expecting `React`, saved and verified a screenshot, reported no console/network/page errors, closed the browser session, and cleaned the temp artifact directory.

## 0.2.43 - 2026-06-04

### Added

- Added fail-closed artifact verification for explicit saved paths with an `artifact-missing` failure category when upstream reports success but the requested artifact is absent.
- Added wrapper-side allowed-domain tracking for browser sessions so post-navigation escapes from configured allowed domains fail loudly.
- Added route-aware network diagnostics for pending or CORS-likely route mocks, including structured follow-up actions for request inspection and HAR capture plus prose guidance for same-origin/CORS-correct fixture retries.

### Changed

- Made same-snapshot form batching less conservative: `check`/`uncheck` on checkbox or radio refs and `select` on combobox refs remain guarded against stale refs but no longer force a fresh snapshot before later same-batch form work; direct `click @ref` remains conservative.
- Removed unsupported `semanticAction.uncheck` from the public shorthand contract while keeping raw upstream `uncheck <selector-or-ref>` pass-through available.
- Improved `semanticAction.fill` recovery by resolving exact current editable role/name matches, including comboboxes, through a current visible ref before falling back to upstream locator behavior.
- Made benign local QA storage values visible for explicitly safe primitive keys while continuing to redact secret-, identity-, session-, email-, token-, and URL-shaped values.
- Treated the exact upstream “streaming already enabled” response as an idempotent success with cleanup/status next actions, without masking broader stream failures.

### Fixed

- Stopped emitting Electron app-shell broad-selector warnings on ordinary browser pages such as `file://` fixtures; broad Electron `get text` warnings now require wrapper-tracked Electron launch provenance.
- Clarified clipboard permission denials without leaking denied clipboard write payloads across prose, JSON, batch, parse-failure, and detail surfaces.

## 0.2.42 - 2026-06-03

### Fixed

- Corrected package-config docs to show the package helper only through `npm exec` examples or direct JSON edits, because `pi install npm:pi-agent-browser-native` loads the Pi package but does not add package bins to the user's shell `PATH`.

## 0.2.41 - 2026-06-03

### Added

- Added Exa support to the optional `agent_browser_web_search` companion tool. When both Exa and Brave credentials are configured, `provider: "auto"` now prefers Exa by default; set `webSearch.preferredProvider: "brave"` in config to keep Brave as the default provider.
- Added `webSearch.enabled: false` to disable the companion search tool even when `EXA_API_KEY` or `BRAVE_API_KEY` is present.

### Changed

- Tightened project-local web-search credential config: `.pi/config/pi-agent-browser-native/config.json` may only reference the matching provider env var (`$EXA_API_KEY` / `${EXA_API_KEY}` for Exa, `$BRAVE_API_KEY` / `${BRAVE_API_KEY}` for Brave). Project-local custom env aliases now fail config validation; move aliases to global config or `PI_AGENT_BROWSER_CONFIG`.
- Updated package-config helper actions `web-search set-key`, `set-command`, and `clear` to require `--provider`; `set-env` still infers the provider from `EXA_API_KEY` or `BRAVE_API_KEY`.
- Browser profile/executable prompt guidance now comes only from trusted global config or `PI_AGENT_BROWSER_CONFIG`; project-local browser config is status-only for host profile/executable launch guidance and cannot shadow trusted global guidance.
- `--executable-path` is treated as launch-scoped, so using it after an active implicit browser session returns fresh-session recovery guidance instead of being quietly ignored by session reuse.

### Fixed

- Rejected `--session-mode` inside `agent_browser.args` with guidance to use the top-level `sessionMode` field.
- Added profile/config recovery hints and `profiles` / `doctor` next actions for Chrome profile and user-data-dir failures, including upstream `Chrome profile ... not found` errors.
- Added web-search rate-limit guidance and serialized companion web-search requests so agents avoid repeated or parallel provider calls after HTTP 429s.
- Clarified web-search disable precedence: `webSearch.enabled` is evaluated after global → project → `PI_AGENT_BROWSER_CONFIG` merge, so users know when to use global, project, or override-level disable.

## 0.2.40 - 2026-06-02

### Added

- Added Pi-scoped `pi-agent-browser-native` package config at `~/.pi/config/pi-agent-browser-native/config.json`, `.pi/config/pi-agent-browser-native/config.json`, and the `PI_AGENT_BROWSER_CONFIG` override, including a package helper for redacted setup/status and conservative browser profile hints.
- Added the optional Brave-backed `agent_browser_web_search` companion tool, registered only when a usable Brave credential source is configured or resolvable, with compact normalized results for current/live web information.

### Changed

- Documented optional web-search setup, config precedence, credential safety, and browser profile guidance across the README, command reference, tool contract, architecture notes, and support matrix.

### Fixed

- Hardened Brave credential handling so project-local config only accepts exact inert `$ENV_VAR` or `${ENV_VAR}` references, rejects plaintext/malformed/interpolation-literal/command-backed secrets, and keeps raw or entity-encoded API keys out of tool output and errors.
- Cleaned Brave result text by decoding common HTML entities while stripping decoded HTML tags safely and preserving placeholder text such as `<version>`.

## 0.2.39 - 2026-06-02

### Added

- Added a Crabbox-backed platform smoke gate for release validation across macOS, prepared Ubuntu Linux, and native Windows, including packed-package installation and deterministic browser dogfood suites.

### Changed

- Updated the upstream capability baseline, command reference, platform smoke images, and live-contract metadata for `agent-browser` `0.27.1`.
- Reduced per-target platform smoke cost by using a focused `verify -- platform-target` gate inside Crabbox targets instead of rerunning the full default verification suite on every OS.

## 0.2.38 - 2026-05-29

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.78.0` after reviewing the installed Pi changelog, keeping lifecycle docs and exact-session test expectations aligned with Pi 0.78.
- Pinned the default maintainer unit/fake verification gate to Node test concurrency `1` to avoid process-contention flakes in full-suite release runs while preserving the full test inventory.

### Fixed

- Stabilized timing-sensitive fake-upstream, Electron probe/cleanup, temp-root, and session-close tests under release-suite load.

## 0.2.37 - 2026-05-29

### Added

- Added loopback navigation failure guidance for `localhost` / `127.0.0.1` errors such as `net::ERR_EMPTY_RESPONSE`, making clear that the browser host may not be able to reach the shell host's temporary server and pointing agents to host-reachable addresses or `file://` static-fixture fallbacks.
- Extended click-dispatch diagnostics to eligible `@e…` ref clicks using the latest snapshot role/name metadata, so ref and semanticAction-resolved clicks that report upstream success without a trusted DOM event now fail loudly with `details.clickDispatch` and inspect/retry next actions.

### Changed

- Documented programmatic `eval --stdin` `.click()` as a static-fixture/debugging workaround only: it can exercise app handlers when user-like click dispatch fails, but it emits an untrusted scripted event and must not be treated as proof of real click behavior or used to bypass explicit stop boundaries.
- Updated README, command reference, tool contract, playbook guidance, and support matrix for second through fifth-round `agent_browser` UX feedback, including localhost, click dispatch, and port-lifecycle ownership boundaries.

### Fixed

- Normalized malformed native-tool calls like `args: ["eval", "--stdin", "document.title"]` by moving trailing script tokens into stdin before spawning upstream, matching the canonical `eval --stdin` contract.

## 0.2.36 - 2026-05-29

### Added

- Added `details.evalResultWarning` and visible `Eval result warning` guidance for successful `eval --stdin` calls that return `null` on `file://` pages with non-trivial stdin, so agents treat those DOM checks as inconclusive without failing the tool.
- Enriched `get text <selector>` visibility diagnostics with bounded `visibleCandidates` entries (`querySelectorAll` index, tag, optional role, redacted text preview) so agents can resolve broad selector ambiguity without trusting hidden or first-match text.
- Added support-matrix tracking for the 2026-05-29 agent UX/reliability feedback batch (`RQ-0110`–`RQ-0117`) covering headed mode, local loopback, `file://` eval, click verification, selector ambiguity, host-owned fixture servers, fresh-session failures, and headed visibility limits.

### Changed

- Made failed `sessionMode: "fresh"` managed-session recovery prose action-oriented: visible output now avoids generated session ids, distinguishes preserved/abandoned launch failures from post-launch `qa` reclassification failures, and points to safe next actions while keeping full transition details in `details.managedSessionOutcome`.
- Expanded README, command reference, tool contract, and generated playbook guidance for headed demos, browser-host localhost semantics, `file://` fixture limits, post-click verification, and host-owned temporary server cleanup.

### Fixed

- Fresh-session failure next actions now verify or snapshot the current managed session for post-launch failures and avoid unconditional `doctor` guidance when the launch itself succeeded but a later diagnostic failed.

## 0.2.35 - 2026-05-28

### Changed

- Cut the local Pi development baseline to `@earendil-works/*` `0.76.0` and refreshed the npm lockfile with npm 11.14.0. Pi **≥ 0.76** is recommended for branch/session continuity (`session_tree` rehydration and generation-aware guards).
- Updated the configured-source lifecycle harness for Pi 0.76 exact session IDs: launches and relaunches now use `--session-id piab-lifecycle-<pid>` instead of driving `/resume`, assert the JSONL session header id, and include real Pi `tool_result` failure-patch evidence for QA reclassification.
- Rehydrate branch-visible browser state on Pi `session_tree` events as well as `session_start`, while keeping runtime-owned managed-session and Electron cleanup registries separate so branch switches do not orphan resources owned by the current Pi process; `session_tree`, Electron status/probe/cleanup, and wrapper-owned browser commands now share the same serialization boundary where they can touch managed state, while independent caller-owned explicit-session completions are guarded from overwriting newer branch restores.
- Tightened the public TypeBox schema to reject unsupported top-level fields and unsupported fields inside `semanticAction`, `sourceLookup`, `networkSourceLookup`, and constrained `job` steps.
- Centralized upstream command capabilities in `command-taxonomy.ts` (navigation, ref guards, batch invalidation, session close, Electron health probes, page-change summaries, pinning exclusions) and sessionless managed-session policy in `command-policy.ts` with shared argv discovery in `argv-descriptor.ts` / `argv-grammar.ts`.
- Normalized `open` / `goto` / `navigate` navigation handling through the shared taxonomy so page-change summaries and ref invalidation stay consistent across aliases.
- Refactored the extension entrypoint and browser-run orchestration: Electron host actions moved to `orchestration/electron-host/`, click-dispatch and prompt-guard preflight live under `orchestration/browser-run/`, and duplicate browser-run helper ownership was removed (#57).
- Expanded the upstream capability baseline and command reference for agent-browser **0.27.0** (additional help sampling, inventory tokens, and maintainer rebaseline metadata).

### Added

- Prompt-policy preflight guards: block likely final submit/order clicks (including batch steps and Enter/Return keyboard submits) when the latest user message sets an explicit stop boundary, and block `close`/`quit`/`exit` until requested screenshot/recording paths from the prompt are verified in the artifact manifest.
- Model-free real Pi pipeline coverage for `buildAgentBrowserToolResultPatch`, proving prose QA failures become `isError: true` in persisted JSONL tool results and caller-requested `--json` failures keep parseable JSON while still patching `isError`.
- Model-free real Pi pipeline coverage for strict public-schema rejection before upstream spawn.
- Regression tests for prompt guards, click-dispatch diagnostics, command taxonomy/policy, argv descriptor edge cases, temp-root cleanup, and `session_tree` branch rehydration of page-scoped refs, managed browser sessions, artifact manifests, Electron cleanup/status/probe ownership, explicit cleanup serialization, active-Electron reload profile preservation, targeted cleanup without unrelated branch promotion, reload cleanup of off-branch sessions/Electron launches, durable partial off-branch reload/quit profile preservation, protected temp-root process-exit and stale-prune cleanup, partial Electron cleanup session untracking, explicit close live/restore state retirement, explicit close generated-fresh ordinal reservation, explicit-session command branch-generation guarding, multi-branch managed-session cleanup, and monotonic fresh-session allocation.

### Fixed

- Successful explicit `--session <current-wrapper-managed-session> close` and `electron.cleanup` managed-session close steps now clear live managed-session/page state, untrack cleanup ownership, reserve the next generated fresh-session ordinal so repeated closes cannot reuse a just-closed generated name, rotate the next default auto call away from the closed name, and stay honored after reload/resume branch restore.
- `/reload` now preserves the current branch-visible active Electron launch and its isolated temp `userDataDir` for continuity while cleaning off-branch owned Electron launches, preserves off-branch profile dirs across reload, quit, repeated temp cleanup, process-exit cleanup, and stale temp-root pruning after restart when partial cleanup intentionally skips or fails `user-data-dir` removal, and targeted `electron.cleanup` no longer promotes unrelated off-branch launches into the current branch-visible state.
- Stabilized env-patched fake-upstream tests by serializing process environment patches and tightening the inherited-stdio subprocess regression to assert quick post-exit fallback behavior without waiting for the process timeout.
- Hardened maintainer dogfood/smoke safety around release prompts (stop-before-order and required artifact paths) so automated and interactive smokes exercise the new guards without placing orders or closing early.

## 0.2.34 - 2026-05-24

### Added

- Deterministic maintainer dogfood mode: `npm run verify -- dogfood` runs a model-free live-browser smoke through the native wrapper against public `example.com`, covering top-level `qa`, `semanticAction`, `qa.attached`, constrained `job`, screenshot artifact verification, and session close.
- Opt-in efficiency-benchmark JSONL sampling via `--sample-jsonl`, so maintainers can measure real transcript model-visible byte output without changing deterministic scenario metrics.
- Architecture note for the Tier A/Tier B prompt-guidance budget, keeping always-on `promptGuidelines` short while preserving detailed browser playbook guidance in docs.

### Changed

- Always-on `agent_browser` prompt guidance is smaller and focused on Tier A rules: input-mode choice, refs/session/artifacts/nextActions, extraction basics, and explicit stop-before-order/post/purchase/submit boundaries.
- `semanticAction` success output now better mirrors raw browser-action navigation and page-change summaries, while docs make the input-mode chooser clearer.
- QA preset pass output is more compact, and `qa.attached` preflight now treats URL-only current-page checks as valid attached-session evidence.
- Constrained `job` docs now make post-click navigation assertions explicit with `assertUrl` / `assertText` instead of implying hidden automatic navigation checks.

### Fixed

- Stabilized concurrency-sensitive fake-upstream tests by waiting for the older explicit-session open to reach the fake binary before launching the newer one, and by covering the documented planned-URL fallback separately from strict live current-page recovery assertions.

## 0.2.33 - 2026-05-23

### Added

- `npm run typecheck` as a thin alias for the default gate’s `tsc --noEmit` step (`scripts/project.mjs` `verify typecheck`), for fast iteration without docs drift checks, unit tests, or live upstream command-reference sampling.

### Changed

- Maintainer docs now map Pi `details` classifiers, `nextActions`, recovery id registries, and network QA helpers to the split `extensions/agent-browser/lib/results/*` modules (plus the `shared.ts` re-export barrel) and call out `extensions/agent-browser/lib/session-page-state.ts` for ordered tab/ref/pinning state—see [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md), and [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md).
- Real Pi transcripts now treat wrapper-classified failures as tool errors: a `tool_result` hook (`buildAgentBrowserToolResultPatch` in `extensions/agent-browser/index.ts`) sets `isError: true` when `details.resultCategory` is `failure` even if `execute` returned successfully (for example `qa` preset reclassification), appends a model-visible `Result category: failure; …; Pi tool isError: true.` line for prose output, and preserves caller-requested `--json` output as parseable JSON—see [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).
- Desktop and attach workflows: documented readiness ladders (condition waits, `tab list` → `tab t<N>` → `snapshot -i`, `electron.probe` / `qa.attached`) instead of blind sleeps; clarified that raw `connect` success only means the CDP endpoint accepted the session, and that `close` does not quit manually launched apps or remove explicit artifacts.
- Page-scoped refs: when `snapshot -i` reports `No active page`, prior session refs are cleared and `details.refSnapshotInvalidation` records `reason: "no-active-page"` until a successful snapshot restores refs; compact snapshots’ `Omitted high-value controls` heuristics favor editables, named tab/surface controls, and primary actions on dense desktop-host UIs.
- Semantic `fill` recovery on host-controlled rich inputs: `details.richInputRecovery`, visible `Rich input recovery`, and bounded `focus-current-editable-ref*` / `click-current-editable-ref*` next actions (no embedded fill text, no auto-submit); click misses still get bounded role/name `find` candidates where applicable.
- `get text` selector-visibility warnings now name the matching `details.nextActions` id; `about:blank` drift recovery records the observed blank target when re-selecting the prior tab fails instead of implying the old page stayed active.

## 0.2.32 - 2026-05-21

### Added
- First-class Electron desktop-app support for `agent_browser`: top-level `electron` now covers bounded app discovery, isolated wrapper-owned launch/attach, status, compact probe, and cleanup without requiring agents to hand-build the CDP launch sequence.
- Electron launch safety and lifecycle details: wrapper-owned launches use a temporary profile and OS-chosen debug port, record a `launchId`, surface exact status/probe/cleanup next actions, support caller-owned `allow` / `deny` policies, and avoid touching manually launched apps.
- `qa.attached` for current attached browser/Electron sessions, so agents can run quick smoke checks without opening a URL or replacing the active desktop-app target.
- A dedicated public Electron guide at [`docs/ELECTRON.md`](docs/ELECTRON.md), linked from the README, command reference, tool contract, architecture, requirements, release, and support-matrix docs and included in the published package.

### Changed
- `sourceLookup`, broad `get text`, fill verification, tab/session mismatch, and stale-ref guidance now include Electron-aware context and recovery actions for packaged desktop apps.
- Verification coverage now includes deterministic Electron lifecycle/probe benchmark scenarios, fake-upstream Electron discovery/lifecycle tests, lifecycle restore/shutdown cleanup checks, and real-app dogfood evidence recorded in the Electron plan.
- The configured-source lifecycle harness (`npm run verify -- lifecycle`, `scripts/verify-lifecycle.mjs`) now defaults to Pi model `zai/glm-5.2` with `--model <id>` override; `npm run verify` lifecycle passthrough rejects `--model` without a value.
- Updated the local Pi development baseline to `@earendil-works/*` `0.75.4` and refreshed the npm lockfile.

### Fixed
- Runtime validation now rejects `electron.status` / `electron.cleanup` with `all: false`, keeping runtime behavior aligned with the public schema and contract.
- Electron + caller `stdin` validation now reports a direct Electron-specific error instead of mixing in generated-batch mode guidance.

## 0.2.31 - 2026-05-18

### Added
- First-class native dropdown selection for `agent_browser`: `semanticAction.action = "select"` and constrained `job` `select` steps now compile to upstream `select <selector> <value...>`, with tests against fake and real upstream fixtures.
- Bounded machine `details.nextActions` for compact `network requests` output, including exact request-detail, source-lookup, filter, and HAR-capture follow-ups with session preservation and sensitive path/query suppression.

### Changed
- Release smoke guidance now uses bounded extension-focused prompts with `--no-skills` for Sauce Demo validation, keeping skill-enabled dogfood/report routing as a separate test mode.
- Network diagnostics preserve app page/ref context so request-detail and `networkSourceLookup` URLs do not replace the active browser target or stale current-page refs.

### Fixed
- Narrowed the `eval --stdin` empty-result hint so valid empty array results no longer warn like uninvoked function snippets that serialize to `{}`.

## 0.2.30 - 2026-05-18

### Added
- Current-snapshot ref fallback for locator misses: raw `find` and compiled `semanticAction` selector misses can now surface exact visible `@ref` retry actions when a fresh snapshot shows the intended control.
- Public Sauce Demo checkout smoke guidance for validating natural browser workflows, artifact paths, and final-action stop boundaries before release.
- Efficiency benchmark coverage for multi-ref extraction workflows.

### Changed
- Reduced wrapper-induced click fragility by replacing serial post-click title/URL probes with one read-only navigation summary eval and limiting tab-list pinning/correction probes to sessions with observed drift risk.
- Allowed same-snapshot form-fill batching: `fill @e…` remains stale-ref guarded but no longer invalidates later same-snapshot fills before the first click/submit/navigation row.
- Tightened browser playbook guidance for signed-in profile use, multi-value extraction, exact requested artifact paths, and explicit order/post/purchase/submit stop boundaries.

### Fixed
- Removed stale release/support documentation notes after the post-`v0.2.29` review and kept command-reference, support-matrix, README, and tool-contract guidance aligned with the current wrapper behavior.

## 0.2.29 - 2026-05-18

### Changed
- Updated the local pi package baseline to `@earendil-works/*` `0.75.3`, including the Node.js `>=22.19.0` runtime floor and refreshed npm lockfile.
- Removed tracked CueLoop runtime state from the repository and ignored local `.cueloop/` artifacts.


## 0.2.28 - 2026-05-15

### Added
- Compact runtime guidance now points agents to the installed package's `README.md`, `docs/COMMAND_REFERENCE.md`, and `docs/TOOL_CONTRACT.md` for on-demand detail instead of injecting the full browser playbook into every browser-oriented turn.
- Successful top-level `scroll` calls can now report `details.scrollNoop`, visible no-op scroll diagnostics, and exact snapshot/screenshot recovery `nextActions` when wrapper-side probes show the viewport and sampled scroll containers did not move.
- Successful explicit combobox-targeted actions can now report `details.comboboxFocus` and exact `snapshot -i`, `press ArrowDown`, and `press Enter` recovery `nextActions` when a focused combobox has explicit `aria-expanded` state but no visible options, including after active-session semanticAction role/name clicks resolve through current visible `@ref`s.
- Successful `record start` / `record restart` calls now warn early with `details.recordingDependencyWarning` when executable `ffmpeg` is missing from the Pi process `PATH`, so agents can fix recording prerequisites before `record stop` needs to encode the WebM.
- `docs/RELEASE.md` now includes a repeatable public Grafana Play stress checklist for dense-dashboard release dogfood without bundling private dogfood/VFR skills or adding a recipe runtime.

### Fixed
- Network request redaction now treats secret-like query and field names such as `sentry_key` and `writeKey` as sensitive in model-visible summaries and details.
- README and command-reference setup notes now call out `ffmpeg` as the external dependency required for recording workflows.

## 0.2.27 - 2026-05-14

### Fixed
- `semanticAction` role/name click, check, and uncheck calls in active sessions now resolve through the current `snapshot -i` refs before execution, preventing hidden duplicate upstream `find` matches from stealing the action while preserving the original target in `details.compiledSemanticAction` and showing the executed ref in `details.effectiveArgs`.
- QA presets now default to `loadState: "domcontentloaded"` and accept explicit `domcontentloaded`, `load`, or `networkidle`, avoiding wrapper watchdog timeouts on analytics-heavy or long-polling docs sites while keeping stricter waits opt-in.
- Network request presentation now shows actionable and benign failed rows before successful rows, so late failures remain visible even when request previews are capped.
- Overlay blocker diagnostics now require strong modal context (`dialog` / `alertdialog`) before suggesting close/dismiss candidates, eliminating noisy warnings after ordinary same-page menu opens or app button mutations.
- Artifact lifecycle cleanup guidance now lists only explicit artifact paths that still exist on disk, skipping deleted/stale paths while preserving the close-does-not-delete reminder.

## 0.2.26 - 2026-05-14

### Added
- artifact lifecycle cleanup guidance (`RQ-0079`): successful `close` results now include `details.artifactCleanup` and a visible `Artifact lifecycle` note when recent artifact metadata exists, making explicit that browser close does not delete user-chosen screenshot/download/PDF/trace/HAR/recording paths and listing paths for host-tool cleanup.
- getter/eval discoverability diagnostics (`RQ-0078`): common unknown getter shortcuts such as `title`, `url`, and `text` now get grouped-`get` guidance (with exact `use-get-title` / `use-get-url` next actions where unambiguous), and function-shaped `eval --stdin` snippets that serialize to `{}` now add visible `Eval stdin hint` plus `details.evalStdinHint` so agents know to pass a plain expression or invoke the function explicitly.
- managed-session outcome diagnostics for failed `sessionMode: "fresh"` calls (`RQ-0077`): failed or timed-out fresh launches now report `details.managedSessionOutcome` and, when the plan used `sessionMode: "fresh"` with a failing outcome, append visible `Managed session outcome: …` text so agents know whether the prior managed session was preserved or no managed session became current.
- timeout partial-progress evidence for long `job` / `qa` / `batch` calls (`RQ-0076`): wrapper watchdog timeouts now add best-effort `details.timeoutPartialProgress` with planned steps, current page title/URL, and declared artifact path checks, and append visible `Timeout partial progress` recovery text.
- QA/network failed-request impact classification (`RQ-0075`): `extensions/agent-browser/lib/results/shared.ts` now separates actionable network failures from benign low-impact browser icon misses such as missing `favicon.ico`, `qa` preserves benign misses as `qaPreset.warnings` instead of failing otherwise healthy smoke checks, and `network requests` presentation includes actionable/benign summary lines plus per-row impact tags. Contract and operator notes live in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`README.md`](README.md), and [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md); regression coverage is in `test/agent-browser.extension-validation.test.ts` and `test/agent-browser.presentation.test.ts`.
- post-success `get text <selector>` visibility diagnostics (`RQ-0074`): after a successful `get text` on a non-`@ref` CSS selector, `extensions/agent-browser/index.ts` may run an extra read-only `eval --stdin` probe (`buildVisibleTextProbeScript`), merge `details.selectorTextVisibility` (and `selectorTextVisibilityAll` when several batched selectors qualify), prepend `Selector text visibility warning` lines to visible text, and append `inspect-visible-text-candidates` next actions carrying the same probe script in `stdin`; skipped for `@e…` refs and for selectors whose string would leak secrets after redaction or match sensitive attribute-literal heuristics. Contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), operator notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), maintainer checklist in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); regression `agentBrowserExtension warns when get text may read hidden selector matches` in [`test/agent-browser.extension-validation.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-validation.test.ts)
- optional `semanticAction.session` on native `agent_browser`: compiles to a leading `--session <name>` pair before upstream `find` argv so the locator shorthand targets a named upstream browser session instead of the extension-managed default; `buildExecutionPlan` skips implicit `--session` injection when argv already starts with `--session`; successful unified results echo `details.sessionName`; `retry-semantic-action-after-stale-ref` copies the compiled argv including that prefix, and bounded `try-*-candidate` next actions preserve the same session prefix from `getCompiledSemanticActionSessionPrefix` in `extensions/agent-browser/index.ts`. Contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) and [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#sessionmode); operator notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#direct-subprocess-execution); playbook line in `extensions/agent-browser/lib/playbook.ts`; regression coverage in `test/agent-browser.extension-validation.test.ts`
- bounded `selector-not-found` recovery for top-level `semanticAction`: when the wrapper still has `details.compiledSemanticAction`, `extensions/agent-browser/index.ts` may append `try-*-candidate` entries to `details.nextActions` and an `Agent-browser candidate fallbacks` block in visible text for specific `fill`/`click` locator pairs (`placeholder`, `text`, `label` only; not `select`); contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) and [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), operator notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#direct-subprocess-execution), playbook line in `extensions/agent-browser/lib/playbook.ts`, regression coverage in `test/agent-browser.extension-validation.test.ts`
- compact oversized `snapshot` output now documents the `Omitted high-value controls` prose block and matching `details.data.highValueControlRefIds` (plus related compact snapshot metadata) in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#snapshot), [`README.md`](README.md), and generated playbook guidance from `extensions/agent-browser/lib/playbook.ts`, with implementation in `extensions/agent-browser/lib/results/snapshot.ts` and regression coverage in `test/agent-browser.presentation.test.ts`

### Changed
- documentation for `RQ-0077` managed-session outcomes now matches `buildManagedSessionOutcome` / `formatManagedSessionOutcomeText`: when the visible `Managed session outcome: …` line is emitted (including ordering after other diagnostic tails per `rawAppendedDiagnosticText` in `extensions/agent-browser/index.ts`, and the missing-binary-only case), how `details.managedSessionOutcome` behaves after **`qa`** reclassification, and that `"auto"` failures can populate `details` without the extra prose line; updates in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`README.md`](README.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#session-model), [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), and this changelog.
- documentation for `RQ-0076` timeout partial progress now matches `collectTimeoutPartialProgress` / `formatTimeoutPartialProgressText` in code: compiled `qa` shares the `job` step-list path; otherwise planned steps come from JSON-array `batch` stdin (caller-provided or wrapper-generated for `sourceLookup` / `networkSourceLookup`), only when each element is a string[] argv row; optional planned-URL fallback and `PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS` watchdog tuning are called out in [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`README.md`](README.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) now documents `timeoutPartialProgress.summary`, the batch stdin parse rule, the six-step cap on visible `Planned steps` lines, and the `0/0` declared-path count when only page context is recovered.
- batch stdin page-scoped ref preflight clears the ref-invalidating latch when a later `snapshot` step appears in the same JSON plan (`getBatchRefInvalidationMessage` in `extensions/agent-browser/index.ts`), matching documented `snapshot -i` spacing inside `batch`; contract expanded under [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) (`refSnapshot`); regression `agentBrowserExtension allows batch stdin ref steps after snapshot following an invalidating step` in [`test/agent-browser.extension-validation.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-validation.test.ts)

### Fixed
- explicit `--json` calls keep machine-readable visible content parseable even when the wrapper attaches extra diagnostic structs such as `details.evalStdinHint`; diagnostic guidance remains available on `details` without being appended after the JSON payload.
- overlay blocker candidate actions (`try-overlay-blocker-candidate-*`) no longer appear under the semantic-action `Agent-browser candidate fallbacks` heading; that prose is now limited to the bounded semantic locator fallback ids.
- packaged Pi smoke now forces its temporary `npm pack` to write a tarball even when invoked from `npm publish --dry-run`, so the release lifecycle dry run validates the same smoke path instead of inheriting npm's outer dry-run mode.

## 0.2.25 - 2026-05-14

### Added
- [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) as the durable upstream support and release-readiness matrix keyed to `CAPABILITY_BASELINE.inventorySections` in `scripts/agent-browser-capability-baseline.mjs`, including maintainer refresh steps, verification gate evidence, and per-inventory documentation/runtime/test pointers; cross-linked from [`README.md`](README.md), [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`docs/RELEASE.md`](docs/RELEASE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and the published tarball `files` list in `package.json`
- machine-readable `details.nextActions` id `retry-semantic-action-after-stale-ref` when a top-level `semanticAction` call fails with `failureCategory: "stale-ref"` and the wrapper still has the compiled upstream `find` argv: it is appended after `refresh-interactive-refs` so agents can retry the same locator-stable target without hand-rebuilding argv, while direct stale `@e…` flows keep snapshot-only recovery; merged in `extensions/agent-browser/index.ts`, documented in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) and [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), agent playbook string in `extensions/agent-browser/lib/playbook.ts`, regression coverage in `test/agent-browser.extension-validation.test.ts`
- optional top-level `semanticAction` on native `agent_browser` as a mutually exclusive alternative to `args`, compiling common locator intents into upstream `find` argv and echoing `{ action, locator, args }` (redacted like other argv) in `details.compiledSemanticAction` when the unified or early-validation `details` object includes that field; contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction), compilation in `extensions/agent-browser/index.ts` (`compileAgentBrowserSemanticAction`), regression coverage in `test/agent-browser.extension-validation.test.ts`
- bounded machine-readable outcome fields on native `agent_browser` tool `details`: `resultCategory` (`success` | `failure`) with `successCategory` or `failureCategory` for stable agent branching without parsing prose; contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), types and classifiers in `extensions/agent-browser/lib/results/shared.ts`, regression coverage in `test/agent-browser.results.test.ts` and related extension tests
- optional `details.pageChangeSummary` (and per-step `batchSteps[].pageChangeSummary` on `batch`) with `changeType`, human-readable `summary`, optional `title`/`url`, artifact hints, and `nextActionIds` aligned to `details.nextActions`; assembly in `extensions/agent-browser/lib/results/presentation.ts` (`buildPageChangeSummary`, `PAGE_CHANGE_SUMMARY_COMMANDS`); contract and examples in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), regression coverage in `test/agent-browser.presentation.test.ts` and `test/agent-browser.extension-validation.test.ts`
- optional experimental top-level `sourceLookup` on native `agent_browser` (mutually exclusive with `args`, `semanticAction`, `job`, and `qa`) that compiles to upstream `batch` steps (`is visible`, `get html`, `react inspect`, and `react tree` when the corresponding fields are set), performs a bounded workspace component scan under the Pi session cwd when `componentName` is present, and merges structured `details.sourceLookup` (`status`, `candidates`, `limitations`, `summary`) plus `details.compiledSourceLookup` for observability; `details.sourceLookup.status` distinguishes `candidates-found`, `no-candidates`, and `unsupported` (the last only when no candidates were collected and a `react` batch step failed). Operator and agent contracts in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#sourcelookup), [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/RELEASE.md`](docs/RELEASE.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); compilation and post-batch analysis in `extensions/agent-browser/index.ts` (`compileAgentBrowserSourceLookup`, `analyzeSourceLookupResults`); regression coverage in `test/agent-browser.extension-validation.test.ts` and a representative scenario in `scripts/agent-browser-efficiency-benchmark.mjs`

### Changed
- documented closed `RQ-0068` (no first-class reusable named browser recipe runtime above constrained `job`, the `qa` preset, experimental `sourceLookup` / `networkSourceLookup`, and raw `batch`): evidence bar tied to deterministic efficiency-benchmark scenario ids in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet), operator and maintainer cross-links in [`README.md`](README.md), [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), and agent playbook guidance in `extensions/agent-browser/lib/playbook.ts`
- presentation layer treats `cookies`, `storage`, `auth`, `dialog`, `frame`, and `state` as stateful: successful `details.data` and per-step `batch` results pass through field-aware or full-tree redaction, argv echo uses `redactInvocationArgs` for cookie/storage set values, failed batch steps strip the same literals from structured errors, and aggregate `batch` tool calls expose a compact redacted `details.data` roll-up—documented in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#use-stateful-browser-context-commands-safely), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/RELEASE.md`](docs/RELEASE.md), [`README.md`](README.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), with regression coverage in `test/agent-browser.presentation.test.ts` and `test/agent-browser.extension-validation.test.ts`
- documented real-upstream suite mechanics (single 120s contract test, output-shape JSON, temp `HOME` / socket / screenshot isolation, React DevTools branch) plus triage notes in [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-suite-mechanics-isolation-and-troubleshooting); cross-links from [`README.md`](README.md) and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- expanded the opt-in `npm run verify -- real-upstream` contract (`PI_AGENT_BROWSER_REAL_UPSTREAM=1`) across `test/agent-browser.real-upstream-contract.test.ts`, `test/fixtures/agent-browser-real-output-shapes.json`, and `test/helpers/agent-browser-harness.ts` (broader core command matrix, `batch` stdin, `pushstate`, `vitals … --json`, `network route … --abort --resource-type`, `cookies set --curl`, missing-renderer `react tree`, and `wait --download` metadata versus on-disk presence); added a separate fast fake-upstream argv matrix in `test/agent-browser.extension-validation.test.ts` for additional passthrough commands (`connect`, `download`, `get url`, `snapshot --compact`, `tab` lifecycle); maintainer inventory and caveat notes in [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-contract-validation), high-level summaries in [`README.md`](README.md) and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), and `scripts/project.mjs` verify help
- read-only `skills list`, `skills get …`, and `skills path …` now share the same implicit-session behavior as plain-text `--help` / `--version` probes: `buildExecutionPlan` still prepends `--json`, but under default `sessionMode: "auto"` it does not inject the extension-managed implicit `--session`, so bundled skill text can be loaded without pinning or rotating the active browser session; allowlisting lives in `extensions/agent-browser/lib/runtime.ts` (`isStatelessInspectionCommand`), with regression coverage in `test/agent-browser.runtime.test.ts` and `test/agent-browser.extension-validation.test.ts`, operator-facing notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#built-in-skills), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- `-p`, `--provider`, and `--device` are now modeled as launch-scoped flags in `LAUNCH_SCOPED_FLAG_DEFINITIONS` (`extensions/agent-browser/lib/runtime.ts`), so implicit `sessionMode: "auto"` reuse fails fast with the same `sessionRecoveryHint` / `sessionMode: "fresh"` guidance as profile, CDP, and state launches when those selectors would otherwise be ignored on an active managed session; contract and operator docs updated in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`README.md`](README.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), with argv matrices in `test/agent-browser.extension-validation.test.ts` and planning assertions in `test/agent-browser.runtime.test.ts`
- `test/agent-browser.process.test.ts` now asserts representative provider and iOS credential env vars (`AGENT_BROWSER_IOS_DEVICE`, `AGENT_BROWSER_IOS_UDID`, `AGENTCORE_API_KEY`, `BROWSERBASE_PROJECT_ID`) reach the upstream child alongside existing `AGENT_BROWSER_*` and provider-prefix forwarding documented in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) and [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#output-provider-policy-and-ai-flags)
- added a concrete `details.nextActions` JSON example in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) for the `refresh-interactive-refs` + `retry-semantic-action-after-stale-ref` chain on semantic `stale-ref` failures, aligned with `extensions/agent-browser/index.ts` and `extensions/agent-browser/lib/results/shared.ts`
- documented how `npm run docs` differs from the default `npm run verify` gate, and linked checkout maintainers to `AGENTS.md` for capability baseline rebaselining and operational testing notes alongside the shipped `docs/` set
- linked [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to the stable `agent_browser` result-category contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) and the TypeScript source in `extensions/agent-browser/lib/results/shared.ts`
- `package.json` `prepublishOnly` now runs `npm run verify -- release` before `npm pack --dry-run`, so publishes enforce packaged Pi smoke and the same live upstream command-reference sampling as [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks); orchestration is the `release` mode in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs), with operator-facing notes in [`README.md`](README.md)
- release guidance now requires `tmux`-driven live-site Pi dogfood with the native `agent_browser` tool before every release, with cleanup and evidence recording expectations in [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks) and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- aligned maintainer wording so configured-source lifecycle (`npm run verify -- lifecycle`) is documented as a pre-publish requirement across [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`README.md`](README.md), [`docs/RELEASE.md`](docs/RELEASE.md), and [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md), while noting it remains a separate `verify` mode from the default gate in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs)
- release-readiness cross-links: `package.json` `prepublishOnly` called out next to the verification facade in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); configured-source lifecycle plus publish-time `release` gate summarized under local validation modes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); configured-source harness subsection in [`docs/RELEASE.md`](docs/RELEASE.md) explicitly ties to [Pre-release checks](docs/RELEASE.md#pre-release-checks)

## 0.2.24 - 2026-05-11

### Added
- added custom `agent_browser` TUI rendering with colorized call/output text and built-in-style visual truncation for long visible output while preserving model-facing tool content

## 0.2.23 - 2026-05-10

### Fixed
- added safe `auth save --password-stdin` support for native tool calls and redacted password stdin from model-visible content, tool details, upstream failure output, and preserved parse-failure spill files
- improved session and launch-flag handling for agent workflows, including disabled `--auto-connect`, optional boolean flag values, dash-starting `--args` values, and stale `@ref` recovery guidance through pinned commands and user batch stdin
- expanded sensitive argument redaction for password and credential command forms

### Changed
- rewrote the public README around outcome-first usage, fastest install paths, profile/auth workflow guidance, and release verification proof
- clarified native-tool command guidance for password stdin, cookie/privacy handling, stable tab ids, and explicit session persistence limits

## 0.2.22 - 2026-05-07

### Compatibility
- migrated the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`
- regenerated the npm lockfile against the current stable dependency graph and confirmed package verification remains green

## 0.2.21 - 2026-05-07

### Fixed
- fixed the published `pi-agent-browser-doctor` bin entrypoint so it runs when invoked through npm's `.bin` symlink

## 0.2.20 - 2026-05-07

### Compatibility
- updated the extension's upstream capability baseline and command reference for `agent-browser` `0.27.0`
- documented and passed through the new React introspection commands (`react tree`, `react inspect`, `react renders`, `react suspense`), Web Vitals (`vitals`), SPA navigation (`pushstate`), init-script flags (`--init-script`, `--enable react-devtools`), `network route --resource-type`, and `cookies set --curl`
- treat `--init-script` and `--enable` as launch-scoped flags in managed-session planning so agents get the same clear `sessionMode: "fresh"` recovery path as profile/state/CDP launches

## 0.2.19 - 2026-05-03

### Fixed
- resolve relative Pi package sources from the settings file directory in `pi-agent-browser-doctor`, so global settings that point at a local checkout are detected correctly

## 0.2.18 - 2026-05-03

### Fixed
- persist oversized parse-failure spill files when Pi provides a session directory without a session file
- isolate the opt-in real-upstream download contract test from the user's global Downloads folder and avoid killing unrelated `agent-browser` processes

### Changed
- clarified the README and repo guidance for the current published package state
- marked the completed implementation plan as superseded so current design guidance stays canonical
- tightened the implicit-session idle-timeout helper to return milliseconds as a number and convert to an environment string only at the process boundary

## 0.2.17 - 2026-05-03

### Fixed
- close the active extension-managed `piab-*` browser session when the originating `pi` process quits, while preserving managed browser continuity across `/reload` and resumable session transitions
- added lifecycle regression coverage for quit-time managed-session cleanup and reload-time preservation

### Changed
- clarified that the managed-session idle timeout is now an abnormal-exit backstop, not the primary cleanup path for normal `pi` exits

## 0.2.16 - 2026-05-02

### Fixed
- made screenshot artifact paths reliable for agent workflows by normalizing explicit screenshot output paths, including dot-directory paths such as `.dogfood/...`, to absolute paths before invoking upstream `agent-browser`
- repaired screenshot outputs from upstream temp files when needed and made the requested path the primary visible artifact path
- extended the screenshot path contract to annotated batch screenshots, so top-level `--annotate` batch calls preserve and verify per-step requested output paths
- blocked per-step batch `--annotate` screenshot forms that upstream parses unsafely and now point agents to the safe top-level `--annotate batch` form
- added wrapper-observed trace/profiler owner guards to prevent known conflicting start/stop sequences from corrupting upstream tracing state

### Changed
- artifact-producing commands now render direct visible artifact metadata, including artifact type, requested path, absolute path, existence, size, status, cwd, session, and temp path when repaired
- explicit `--json` calls now render valid JSON in visible tool content; `stream status` JSON is enriched with `wsUrl` and frame format metadata
- documented the artifact contract, batch annotation guidance, trace/profiler caveat, and package-development bash bypass for upstream debugging

## 0.2.15 - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai` `0.72.0`
- regenerated the npm lockfile against the current stable dependency graph
- aligned pi core peer metadata with current pi package guidance

### Compatibility
- reviewed the pi `0.72.0` changelog and confirmed the extension does not use the removed `compat.reasoningEffortMap` provider shape or depend on the new Xiaomi MiMo/provider base URL behavior


## 0.2.14 - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.71.1`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.71.1` changelog and confirmed the extension is compatible with the current TypeBox 1.x package guidance, session-replacement safety rules, and latest package install/update behavior


## 0.2.13 - 2026-04-30

### Fixed
- improved model-facing redaction across generic output, scalar extraction summaries, diagnostics, console/error previews, and compacted spill files so nested, multiline, and prefixed structured secrets are masked before entering tool content or summaries
- adapted upstream `agent-browser skills get` output for Pi's native `agent_browser` tool by removing bash-oriented allowlist hints and translating quoted and heredoc CLI examples into native tool-call examples
- reduced artifact-retention noise for routine explicit saved files while preserving retention metadata in details, and fixed explicit artifact manifest deduplication for same relative paths in different working directories

### Changed
- documented that oversized spill files contain redacted upstream payloads rather than raw secret-bearing output
- added command-reference guidance for converting upstream standalone CLI examples into native `agent_browser` tool calls

## 0.2.12 - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.70.0`
- migrated published TypeBox integration metadata and source imports from `@sinclair/typebox` to `typebox` for pi `0.69.0` compatibility
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.70.0` changelog and confirmed the extension already follows the current session-replacement guidance while now using the required TypeBox 1.x package name and has no dependency on the changed terminal progress defaults


## 0.2.11 - 2026-04-21

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.68.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.68.0` changelog and confirmed the extension already uses the current named-tool registration model instead of removed cwd-bound tool exports

## 0.2.10 - 2026-04-18

### Changed
- bumped the local pi development baseline to `@mariozechner/pi-coding-agent` `0.67.68` and `typescript` `6.0.3`
- refreshed the release lockfile against the current stable pi patch line

### Fixed
- pinned the transitive `basic-ftp` dependency to `5.3.0` to clear the current audit finding during local verification and publish checks

## 0.2.9 - 2026-04-17

### Fixed
- large non-snapshot outputs such as oversized `eval --stdin` payloads now compact inline content, spill the full payload to a private file, and print the actual spill path directly in tool content instead of dumping huge raw output into model context
- file-save flows now render `download` results as explicit saved-file summaries so agents can see the downloaded path directly
- when a known target tab stays correct at command start but a restored/background tab steals focus after the command completes, the wrapper now best-effort restores the intended tab before returning control
- compact snapshot text now prints the actual raw-spill file path directly instead of only referring agents to `details.fullOutputPath`

### Changed
- added a published `docs/COMMAND_REFERENCE.md` so agents have a repo-readable local command/help surface even when direct `agent-browser` binary usage is blocked
- expanded tool guidance, README, release notes, and repo guidance with download workflows, better `wait` usage, oversized-output handling, and the documentation-sync rule for upstream `agent-browser` updates
- clarified the checkout-versus-installed-package workflow in README, release notes, and repo agent guidance so local development keeps one active Pi package source for this extension at a time instead of treating the published entrypoint file as optional

## 0.2.8 - 2026-04-16

### Fixed
- updated the tab-correction and tab-pinning wrapper paths for `agent-browser` `0.26.0` tab metadata, so profiled launches and follow-up commands now re-select tabs using stable upstream tab ids instead of the retired numeric index shape
- updated tab-list rendering and tool guidance to show `agent-browser`'s stable tab ids/labels instead of suggesting `tab <n>` commands that no longer work in `0.26.0`
- extended the narrow ChatGPT/OpenAI headless user-agent compatibility fallback to cover `chat.com`, so `chat.com` redirects reuse the same authenticated headless path as `chatgpt.com`

## 0.2.7 - 2026-04-16

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.67.4`
- aligned `packageManager` metadata to `npm@10.9.8`, the latest stable npm line compatible with the declared Node runtime floor
- removed the published `@mariozechner/pi-coding-agent` peer dependency so installs rely on pi's bundled runtime instead of npm peer-resolution churn

## 0.2.6 - 2026-04-15

### Changed
- pinned `packageManager` metadata to `npm@11.12.1` so lockfile refreshes resolve consistently during release verification
- refreshed the compatible transitive development dependency resolution pulled by the current pi toolchain without changing the published `agent_browser` runtime contract

## 0.2.5 - 2026-04-14

### Changed
- refreshed the development and release-verification baseline to `@mariozechner/pi-coding-agent` `0.67.2` and `@types/node` `25.6.0`, keeping local typechecking and package verification aligned with the latest stable pi release used for this extension
- re-locked the compatible transitive development dependency set pulled by the updated pi toolchain without changing the published `agent_browser` runtime contract

## 0.2.4 - 2026-04-13

### Fixed
- wrapper-spawned local Unix `agent-browser` runs now use a short private socket directory under `/tmp`, so extension-generated session names no longer fail the upstream Unix socket-path length limit in longer cwd/session-name combinations
- once the wrapper knows which tab a session should stay on, later active-tab commands like `click` and `snapshot -i` now best-effort pin that same tab inside the same upstream invocation instead of letting reconnect drift send the action to a restored/background tab
- persisted `sessionTabTarget` state now survives `/reload` / `/resume` for both managed and explicit sessions, so the reconnect-time tab pinning behavior can continue after restart/resume flows
- README, requirements, architecture notes, and tool-contract docs now describe the socket-path mitigation and the follow-up-command tab-pinning behavior

## 0.2.3 - 2026-04-13

### Fixed
- direct headless local Chrome launches to `chatgpt.com` and `chat.openai.com` now inject a normal Chrome user agent when the caller did not explicitly choose one, keeping authenticated ChatGPT/OpenAI browsing working without forcing `--headed` or `--auto-connect`
- profiled `open` / `goto` / `navigate` calls now best-effort switch back to the page that was just opened when restored profile tabs steal focus during launch, reducing confusing cross-tab drift in profile-backed sessions
- command parsing now treats additional value-taking global flags like `--user-agent`, `--args`, `--allowed-domains`, `--action-policy`, and related launch options as launch metadata instead of accidentally parsing their values as subcommands
- README, requirements, architecture notes, and tool-contract docs now describe the new headless ChatGPT/OpenAI compatibility behavior and the profiled-tab focus recovery path

## 0.2.2 - 2026-04-12

### Fixed
- plain-text inspection commands like `agent_browser --help` and `--version` now stay stateless: they no longer claim the implicit managed session or leave behind ambiguous `parseError` details on success
- extension-managed session ownership is now reconstructed from persisted tool details on resume/reload while still preserving cwd-hash isolation across same-named checkouts and worktrees
- echoed tool updates/details now redact sensitive invocation values and structured secret-bearing fields instead of replaying headers, proxy credentials, cookies, or auth-bearing URL params back into `pi`
- the subprocess wrapper no longer forwards ambient parent-shell `AGENT_BROWSER_*` state into child runs, reducing surprising hidden configuration leaks from the caller environment
- browser-specific system-prompt injection is now minimal and only added for clearly browser-oriented turns, while the full playbook stays in tool metadata where it belongs
- published docs and changelog notes now match the current result/details contract, resume behavior, prompt behavior, and release workflow

## 0.2.1 - 2026-04-12

### Fixed
- the GitHub source trial docs now use `pi --no-extensions -e https://github.com/fitchmultz/pi-agent-browser-native` so published-package users do not hit duplicate `agent_browser` registration conflicts during source-path testing
- successful unnamed `sessionMode: "fresh"` launches now rotate the extension-managed session to the new browser, and later default `sessionMode: "auto"` calls keep following that fresh session instead of silently snapping back to the older one
- mixed-success `batch` failures now preserve per-step rendering, include the first failing step in the visible output and structured details, and still mark the overall tool call as an error so agents can recover from partial progress
- implicit `piab-*` session names now include a stable cwd hash in addition to the `pi` session id so same-named checkouts and worktrees no longer collide onto the same browser session
- value-taking flags like `--session`, `--profile`, `--session-name`, and `--cdp` now fail locally with direct validation errors when the value is missing or replaced by another flag, instead of producing confusing downstream JSON parse failures
- the bash guard now catches wrapped `agent-browser` invocations such as `env agent-browser ...`, `npx --yes agent-browser ...`, `pnpm dlx agent-browser ...`, `yarn dlx agent-browser ...`, `bunx agent-browser ...`, and absolute-path execution, reducing accidental bypasses of the native-tool path

## 0.2.0 - 2026-04-12

### Changed
- `batch` now reuses the richer standalone renderers, so batched snapshots keep the compact main-content-first view and batched screenshots keep inline image attachments instead of degrading to raw JSON-ish text
- the tool schema now uses `sessionMode: "auto" | "fresh"` instead of the old implicit-session boolean so agents have a first-class way to request a fresh profiled/debug launch, and blocked startup-scoped reuse errors now include structured recovery hints
- plain-text inspection commands like `agent_browser --help` and `--version` are now always allowed, removing the old prompt-dependent inspection gate and making the inspection contract local and predictable
- navigation actions like `click`, `dblclick`, `back`, `forward`, and `reload` now include lightweight post-action title/url summaries when the wrapper can address the active session, reducing guess-and-check follow-up snapshots
- compact snapshot rendering is leaner by default: fewer additional sections, fewer refs, smaller role summaries, and the raw spill path now stays in `details.fullOutputPath` instead of dominating the visible snapshot body
- README and tool prompt guidance now include a compact agent quick start with the core call shapes for `open` + `snapshot`, `click` + re-snapshot, `batch`, `eval --stdin`, and fresh profiled launches, while turn-level system-prompt injection stays minimal

### Migration notes
- replace any use of `useActiveSession` with `sessionMode`
- use `sessionMode: "fresh"` when you need a new `--profile`, `--session-name`, or `--cdp` launch after the implicit session is already active

## 0.1.6 - 2026-04-12

### Changed
- hardened the implicit browser-session lifecycle so failed first launches no longer mark the convenience session active, startup-scoped flags behave correctly across launches and closes, and the highest-risk entrypoint paths now have direct automated and isolated-`pi` coverage
- added explicit temp-root ownership markers, aggregate spill-file disk budgeting, inline image size limits, and graceful fallback behavior when large snapshot or stdout artifacts exceed temp budgets
- consolidated the shared browser operating playbook into the tool prompt guidance while keeping turn-level system-prompt injection minimal, and added direct extension-hook coverage for prompt injection, bash blocking, and session resets
- split the old result-rendering god module into focused envelope, presentation, shared, and snapshot modules, and made snapshot compaction fall back to a resilient outline mode when upstream raw snapshot formatting is unfamiliar
- refactored the release-package verification script into smaller testable helpers, preserved the retired autoload-shim guard, and aligned the tarball gate with the split result-rendering module layout

## 0.1.5 - 2026-04-12

### Changed
- pinned the transitive `basic-ftp` dependency to `5.2.2` via `overrides` so local development and GitHub install flows no longer pull the vulnerable `5.2.1` version through `@mariozechner/pi-coding-agent`
- kept the 0.1.4 startup fix and metadata updates intact while clearing the audit failure that surfaced during release verification

## 0.1.4 - 2026-04-12

### Changed
- removed the tracked repo-local `.pi/extensions/agent-browser.ts` autoload shim because it conflicts with the globally installed package and blocks `pi` startup from this repository root
- local checkout validation now uses explicit CLI loading with `pi --no-extensions -e .` instead of repo-local `.pi/extensions/` auto-discovery
- aligned the package description and keywords with the GitHub repository metadata used for your other public `pi` extensions

## 0.1.3 - 2026-04-12

### Changed
- when `BRAVE_API_KEY` is present and non-empty, the extension now tells agents to prefer the Brave Search API via `bash`/`curl` for URL discovery and then open the chosen destination with `agent_browser` instead of driving a search engine results page in the browser
- when `BRAVE_API_KEY` is absent, the extension behavior remains unchanged
- added a small runtime helper and unit coverage for the `BRAVE_API_KEY` gate so the change stays explicit and minimal

## 0.1.2 - 2026-04-11

### Changed
- renamed the public GitHub repository to `pi-agent-browser-native` so the repo name, npm package name, install docs, and package metadata all align
- updated package metadata and install guidance to use the new GitHub source path `https://github.com/fitchmultz/pi-agent-browser-native`
- switched the local global pi install from the repo checkout path to the published npm package `pi-agent-browser-native`

## 0.1.1 - 2026-04-11

### Changed
- startup-scoped flags like `--profile`, `--session-name`, and `--cdp` now fail clearly when reused against an already-active implicit session instead of silently relying on upstream to ignore them
- prompt-based bash/help allowances are now derived from the current user prompt instead of mutable extension-global booleans, and the inspection allowance only triggers for tool-specific requests
- oversized subprocess stdout is now bounded in memory and spilled to private temp files before JSON parsing, reducing unbounded buffering risk without breaking large snapshot handling
- snapshot spill files now live under private temp directories with restrictive permissions and are cleaned up on shutdown
- failed upstream envelopes now synthesize clearer fallback error text when no simple top-level `error` string is present
- package/release verification now has a documented maintainer workflow, a tarball verifier script, a tracked repo-local `.pi` development shim, and a published tarball that excludes agent-only or superseded docs while including `LICENSE`
- npm publish prep now uses the available package name `pi-agent-browser-native`, adds author and gallery-friendly keywords, and updates README install guidance to show npm first and GitHub second

## 0.1.0 - 2026-04-09

### Added
- initial package scaffold for `pi-agent-browser`
- native `agent_browser` extension tool that wraps upstream `agent-browser --json`
- thin implicit-session support for the common path
- lightweight extension-level guards to keep direct bash `agent-browser` usage from becoming the primary path
- plain-text fallback for native `agent_browser --help` and `--version` inspection
- support for observed `batch --json` array output
- local TypeScript typecheck and unit-test setup
- concise product and implementation docs

### Changed
- removed the shipped skill override; extension hooks are the primary mechanism for preferring the native tool
- implicit `piab-*` sessions are now best-effort closed on `pi` shutdown and get an idle timeout so abandoned background daemons do not accumulate as easily
- tightened tool guidance so agents avoid falling back to osascript or other generic browser-driving bash commands when the native tool should be used
- taught the tool a clearer browser operating playbook so agents do not need to rediscover core `open` / `snapshot -i` / auth / tab-management patterns from `--help` on routine tasks
- refined the authenticated-content playbook to prefer `--profile Default` on the first browser call while reusing the extension-managed implicit session for normal personal feeds/dashboards; this avoids stale cross-run browser state from fixed explicit session names
- refined read-only browsing guidance so agents prefer extracting from the current snapshot, ref labels, or page-state eval before navigating away, and clarified that extraction evals should return values instead of relying on `console.log`
- generalized recovery guidance so unexpected `open` failures now point agents to inspect and recover tab/session state before retrying alternate URLs or fallback strategies
- improved native error presentation so upstream JSON error messages are shown to the agent instead of a generic `agent-browser exited with code 1.` when the CLI already reported a specific failure
- oversized `snapshot -i` results now switch to a browser-aware compact view for the model and spill the full raw snapshot JSON to a temp file referenced from tool details instead of always inlining the full snapshot tree
- refined compact snapshots to be main-content-first: prefer the primary content block and nearby sections over top-of-page chrome, ads, and unrelated sidebars when the snapshot structure makes that distinction possible
