# Release and package verification

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- Bounded `agent_browser` outcome metadata on `details` (`resultCategory`, `successCategory`, `failureCategory`, optional `nextActions`, optional `pageChangeSummary` with per-step summaries on `batch`): contract in [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); maintainer checklists under “Tool result categories” and “Page-change summaries” in [`../AGENTS.md`](../AGENTS.md)
- Stateful context commands (`cookies`, `storage`, `auth`, `dialog`, `frame`, `state`) and aggregate `batch` results: model-facing `details.data` is summarized or redacted per [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md#details); aggregate `batch` replaces top-level `details.data` with a compact per-step matrix (`success`, argv-redacted `command`, redacted `result` or scrubbed `error`) while full per-step payloads, artifacts, and categories remain on `batchSteps[]`—operational notes in [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md#use-stateful-browser-context-commands-safely), assembly in `extensions/agent-browser/lib/results/presentation.ts`

## Purpose

Provide one concrete maintainer workflow for validating repo state, package contents, and install guidance before publishing `pi-agent-browser-native`.

## Pre-release checks

From the repository root:

```bash
npm install
npm run doctor
npm run verify -- release
```

`npm run doctor` is a read-only first-run diagnostic for PATH, targeted upstream version, and duplicate package/checkout source conflicts. It does not replace upstream `agent-browser doctor` for browser runtime health and does not edit Pi settings.

`npm run verify -- release` runs:

1. `npm run verify` for generated playbook drift, TypeScript, unit/fake coverage, command-reference generated-block drift, and live command-reference verification against the targeted upstream on `PATH`
2. `npm run verify -- package-pi`, which first validates package contents via `npm pack --json --dry-run` and then smoke-loads the packed package in Pi isolation

The configured-source lifecycle regression harness is opt-in because it launches an interactive `pi` process under `tmux` and requires a usable local model configuration:

```bash
npm run verify -- lifecycle
```

Use `npm run verify -- lifecycle --keep-artifacts` when debugging failures.

## Deterministic agent efficiency benchmark

[`scripts/agent-browser-efficiency-benchmark.mjs`](../scripts/agent-browser-efficiency-benchmark.mjs) is an accounting-only benchmark: it does not shell out to `agent-browser`, launch a browser, or read or write Pi sessions. It models representative `agent_browser` call shapes (including optional `stdin` for `batch`) and aggregates success rate, tool-call counts, UTF-8 size of model-visible strings, stale-ref failure and recovery counts, artifact success, distinct failure-category coverage, and summed elapsed-time estimates.

- **During development:** `npm run benchmark:agent-browser` prints a Markdown report; `npm run benchmark:agent-browser -- --json` saves machine-readable metrics; `npm run benchmark:agent-browser -- --compare path/to/prior.json` fails with exit code `1` on regressions (see the script’s `--help` for exit codes).
- **Default gate:** `npm run verify` checks generated playbook drift, runs `tsc --noEmit`, runs the full unit/fake suite under `test/**/*.test.ts` (including [`test/agent-browser.efficiency-benchmark.test.ts`](../test/agent-browser.efficiency-benchmark.test.ts) for scenario coverage and comparison behavior), verifies generated command-reference baseline blocks, and samples live upstream command-reference tokens. It does not spawn the standalone benchmark script’s JSON/Markdown run; that is what the opt-in slice below adds.
- **Opt-in slice:** `npm run verify -- benchmark` runs the benchmark script once with `--json` and then that same test module alone. It is intentionally **not** part of `npm run verify -- release`, so routine publish gates stay decoupled from benchmark churn while still allowing a focused check after editing scenarios or `CURRENT_BENCHMARK_VERSION`.

Maintainer constraints for evolving scenarios and version bumps are summarized under “Agent browser efficiency benchmark” in [`../AGENTS.md`](../AGENTS.md).

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
- exactly one `agent_browser` tool is registered
- the registered `agent_browser` source resolves inside the extracted packed package path, not the working checkout
- the packaged `agent_browser` tool can be executed through Pi's loaded native tool definition with a deterministic fake upstream `agent-browser --version` binary

The packaged execution smoke intentionally uses a temporary fake `agent-browser` binary and the `--version` inspection path. It proves first invocation of the packaged Pi tool without launching a real browser. Real browser coverage remains part of local checkout validation and post-publish install validation.

Current forbidden packed files include:

- `AGENTS.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/native-integration-design.md`
- `docs/v1-tool-contract.md`
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
2. Launch `pi --no-extensions -e .` from this repository root.
3. Confirm the checkout extension loads from `extensions/agent-browser/index.ts`.
4. Run a smoke prompt that exercises `agent_browser`.
5. Restart the `pi` process after extension edits; Pi settings and `/reload` are not the validation target in this isolated mode.

For expanded-surface validation, the smoke prompt should cover native tool invocation rather than shelling out to `agent-browser`: `--version`, `--help`, `skills list`, `skills get core --full`, `open` with `sessionMode: "fresh"`, `snapshot -i`, `click`, `eval --stdin`, `batch` via stdin, `screenshot <path>`, explicit `--session … open` plus `--session … close`, `network requests`, `console` / `errors`, `diff snapshot`, `stream status` plus `stream disable`, `dashboard start` plus `dashboard stop`, and `chat <message>` (credential failure is acceptable evidence of wrapper pass-through when `AI_GATEWAY_API_KEY` is intentionally unset). Clean up any opened browser session with `close`, remove temporary files, and kill the tmux session before ending validation.

This checklist assumes a real `agent-browser` on `PATH`. It complements, but does not overlap, `npm run verify -- lifecycle`: that harness swaps in a fake upstream binary and focuses on `/reload`, full restart, `/resume`, managed-session continuity, and spill-path persistence (`scripts/verify-lifecycle.mjs`), not the full command matrix above.

### Configured-source lifecycle validation

Prefer the automated harness for deterministic configured-source lifecycle regression coverage:

```bash
npm run verify -- lifecycle
```

The harness creates an isolated `PI_CODING_AGENT_DIR`, writes settings with exactly one temporary configured package source, runs plain `pi` in `tmux`, puts a deterministic fake `agent-browser` first on `PATH`, and drives `/reload`, full restart, and `/resume`. It asserts same-page managed-session continuity, persisted `details.fullOutputPath` reachability after resume, and updated extension-code pickup through a temporary sentinel command. On failure it retains transcripts/session artifacts; on success it performs best-effort cleanup. It does not replace occasional real-browser manual smoke testing.

Manual validation remains useful for release confidence and installed-package checks:

1. Configure exactly one active source for this extension in Pi settings: this checkout path before publishing, or the installed package after publishing.
2. Launch plain `pi` so extension discovery is active.
3. Validate managed-session continuity with `/reload` and a full restart + `/resume`.
4. Re-check local extension-side docs (`README.md`, `docs/COMMAND_REFERENCE.md`, `docs/TOOL_CONTRACT.md`, including the [`semanticAction`](TOOL_CONTRACT.md#semanticaction) rules when that shorthand or upstream `find` behavior changes) and regenerated prompt fragments from `extensions/agent-browser/lib/playbook.ts` via `npm run docs -- playbook check` or `npm run docs`. When the upstream `agent-browser` version or help surface changed, run `npm run verify -- command-reference`.

### Real upstream contract validation

The default `npm test` and `npm run verify` paths use fast deterministic tests and fake binaries. When a change touches upstream command planning, result presentation, managed-session behavior, or the canonical capability baseline, also run the opt-in real-upstream contract suite:

```bash
npm run verify -- real-upstream
```

That npm script sets `PI_AGENT_BROWSER_REAL_UPSTREAM=1` for the test process. To run `test/agent-browser.real-upstream-contract.test.ts` directly (for example with `node --test` and `tsx`), set the same variable yourself; the suite is skipped when it is unset.

This suite requires the installed `agent-browser --version` to exactly match `scripts/agent-browser-capability-baseline.mjs`. It serves fixture pages from localhost and checks stable `details`/`data` keys via `test/fixtures/agent-browser-real-output-shapes.json`. Coverage groups:

- **Inspection and skills (stateless JSON):** `--version`, `--help`, `snapshot --help`, `skills list`, `skills get … --full`, `skills path …` (no managed `sessionName` / `usedImplicitSession`).
- **Managed session core and safe diagnostic matrix:** fresh `open` on the contract fixture, then implicit reuse across `eval --stdin`, `snapshot -i`, interaction commands (`click`, `dblclick`, `fill`, `type`, `focus`, `keyboard` with `type` / `inserttext`, `press`, `hover`, `check`, `uncheck`, `select`, `upload`, `drag`, `mouse`, `scroll`, `scrollintoview`, `wait` on a selector), extraction (`get` variants, `is` variants, label `find … fill`, inline `eval`), file outputs (`screenshot`, `pdf`), navigation (`back`, `forward`, `reload`, `tab list`, another `open` to the same fixture), `batch` stdin, `pushstate`, `vitals … --json`, network route/requests/HAR, diff snapshot/screenshot/url, trace/profiler, console/errors/highlight, stream enable/status/disable, and `cookies set --curl`.
- **Failure shape:** `react tree` on a page opened with `--enable react-devtools` but without a React app (expects a clear missing-renderer error with session-bound `details`).
- **Async download:** `open` on the `/download` fixture, anchor-triggered export, then `wait --download <path>` metadata and wrapper artifact reporting for the requested path.

The default unit suite also runs `agentBrowserExtension passes through core command coverage fallback matrix` in [`test/agent-browser.extension-validation.test.ts`](../test/agent-browser.extension-validation.test.ts): a fake upstream records argv so `connect 9222`, `download` with a selector and path, `get url`, `snapshot --compact`, and `tab new` / `tab 0` / `tab close` still prove `--json` plus implicit `--session` ordering without a browser. A second fake-upstream matrix in the same file (`agentBrowserExtension passes through non-core network debug diff stream dashboard and chat families`) pins representative `network`, `diff`, `trace` / `profiler` / `record`, `console` / `errors` / `highlight` / `inspect` / `clipboard`, `stream`, `dashboard`, and `chat` JSON shapes plus redacted `details.data` and argv echoes without a browser. A third matrix (`agentBrowserExtension passes through provider and specialized skill workflows`) asserts provider `open` argv shapes still receive `--json` plus implicit `--session` while read-only `skills get …` stays stateless (no managed session fields) and provider credential env vars are forwarded into the fake upstream log. Extend those matrices when adding passthrough coverage that should stay out of the slow real-upstream loop.

### Real upstream suite mechanics, isolation, and troubleshooting

- **Single bundled test:** `test/agent-browser.real-upstream-contract.test.ts` registers one long-running case (120s timeout) so browser startup, the command matrix, and teardown stay in one place.
- **Output-shape locking:** Expected `details` / `data` keys per step live in `test/fixtures/agent-browser-real-output-shapes.json`, keyed by logical groups (`version`, `rootHelp`, `commandHelp`, `skillsList`, `skillsGetFull`, `skillsPath`, `open`, `eval`, `snapshot`, `coreCommand`, `coreSubcommand`, `coreFileArtifact`, `batch`, `pushstate`, `vitals`, `networkRoute`, `nonCoreStatus`, `nonCoreArtifact`, `diffScreenshotArtifact`, `streamControl`, `streamStatus`, `cookiesCurl`, `reactMissingRenderer`, `waitDownload`). Keep `targetVersion` in that file aligned with `scripts/agent-browser-capability-baseline.mjs`, and extend entries whenever the suite starts asserting on new presentation fields.
- **Isolation:** The harness allocates a throwaway directory under the system temp folder, points `HOME`, `AGENT_BROWSER_SOCKET_DIR`, and `AGENT_BROWSER_SCREENSHOT_DIR` at that tree, serves HTML fixtures from loopback (`startAgentBrowserContractFixtureServer` in `test/helpers/agent-browser-harness.ts`), and closes the managed session before deleting the temp tree. The main matrix does not reuse your normal profile or socket locations.
- **React DevTools branch:** After the core matrix, the suite performs another `open` with `--enable react-devtools` and `sessionMode: "fresh"`, then expects `react tree` to fail with a missing-renderer style error on the same non-React contract page. The following download fixture + `wait --download` assertions run against whichever managed session is current after that fresh `open` (typically the React DevTools session), not the original pre-matrix session name.

**Troubleshooting**

- **Version mismatch:** Install the `agent-browser` version declared in the capability baseline, or follow the maintainer rebaselining sequence in `AGENTS.md` if you intentionally move the target.
- **Missing or extra `details` / `data` keys:** Update `test/fixtures/agent-browser-real-output-shapes.json` in the same change as the wrapper or presentation code that shifts those keys.
- **Timeouts:** A 120s bound covers the full matrix; repeated timeouts usually mean a hung browser, blocked loopback, or an environment preventing headful/headless launch—check upstream logs and local security tooling before loosening timeouts.

The current upstream `agent-browser 0.27.0` `wait --download <path>` saveAs persistence limitation is tracked at [vercel-labs/agent-browser#1300](https://github.com/vercel-labs/agent-browser/issues/1300); until it is fixed, release validation must treat `details.savedFilePath` as upstream-reported metadata and use `details.artifacts[].exists` as the filesystem truth (the contract asserts the requested path is absent on disk while upstream still reports success). If the suite fails because JSON/detail keys drifted, update the wrapper behavior or refresh `test/fixtures/agent-browser-real-output-shapes.json` together with the presentation work that consumes those shapes.

Example smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Recommended configured-source lifecycle follow-up:

1. Open a page with the implicit managed session and confirm the title.
2. Run `/reload`, then ask for `snapshot -i` and confirm the same page is still active.
3. Exit `pi`, relaunch it against the same session file or use `/resume`, then ask for `snapshot -i` again and confirm the same page is still active.
4. Open a large page that compacts its snapshot output and confirm `details.fullOutputPath` still exists after the restart/resume flow.
5. Trigger an oversized non-snapshot output (for example a deliberately large `eval --stdin` result) and confirm the tool prints the actual spill file path directly in content instead of only referencing a details key.
6. Validate at least one direct file-download flow with `download <selector> <path>`.
7. Validate at least one asynchronous export flow with `click` followed by `wait --download <path>`, confirming the wait result reports `savedFilePath`/`savedFile` and checking `details.artifacts[].exists` before relying on the requested path being present on disk.

## Post-publish install validation

After publishing a release, validate the package-first path in isolation. `npm run verify -- release` includes the deterministic fake-binary packaged execution gate, but it does not replace a real-browser installed-package smoke:

```bash
npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
npm run verify -- release
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

Then run the real-browser smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Only use plain `pi` for installed-package validation after temporarily disabling or removing the checkout source or any other active source for this extension from Pi settings. Then confirm `pi` exposes the native `agent_browser` tool, that a basic `open` + `snapshot -i` flow works, and that `/reload` plus restart/`/resume` keep following the same implicit managed browser session.

## Release notes checklist

Before publishing:

- update `CHANGELOG.md`
- confirm README install guidance still leads with the package-first flow
- confirm `docs/COMMAND_REFERENCE.md` still matches the effective upstream command/help surface used by the wrapper
- if you changed `scripts/agent-browser-capability-baseline.mjs` or the human inventory prose outside the generated HTML-comment blocks, run `npm run docs -- command-reference write` before verification; see `AGENTS.md` (upstream capability baseline section) for the three-layer model
- run `npm run verify -- command-reference` if the installed upstream `agent-browser` version or help surface changed
- run `npm run doctor` and confirm any duplicate-source remediation matches the active package/checkout setup
- run `npm run verify -- real-upstream` for upstream runtime, result-presentation, or managed-session changes
- confirm both local-checkout modes still work for pre-release validation: isolated `pi --no-extensions -e .` smoke testing and configured-source lifecycle validation
- rerun `npm run verify -- release`
- run `npm run verify -- lifecycle` for opt-in configured-source `/reload` plus restart/`/resume` regression coverage
- confirm [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) still maps every current baseline inventory section to docs, runtime handling, tests, and validation status
- manually exercise real-browser `/reload` and full restart + `/resume` continuity when release risk warrants browser-level confidence beyond the fake upstream harness
- publish only after the tarball contents and isolated packaged-extension smoke check match expectations
