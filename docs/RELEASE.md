# Release and package verification

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)

## Purpose

Provide one concrete maintainer workflow for validating repo state, package contents, and install guidance before publishing `pi-agent-browser-native`.

## Pre-release checks

From the repository root:

```bash
npm install
npm run doctor
npm run verify:release
```

`npm run doctor` is a read-only first-run diagnostic for PATH, targeted upstream version, and duplicate package/checkout source conflicts. It does not replace upstream `agent-browser doctor` for browser runtime health and does not edit Pi settings.

`npm run verify:release` runs:

1. `npm run verify` for TypeScript, unit coverage, and command-reference drift detection
2. `npm run verify:package:pi`, which first validates package contents via `npm pack --json --dry-run` and then smoke-loads the packed package in Pi isolation

## What package verification checks

`npm run verify:package` confirms that:

- no repo-local `.pi/extensions/agent-browser.ts` autoload shim is present
- `LICENSE` exists in the repo and the packed tarball
- canonical published docs are present
- the package-level doctor command and capability baseline are present
- extension source files are present, including the split result-rendering modules required by the published facade
- agent-only and superseded docs are absent from the tarball

`npm run verify:package:pi` runs the same package-content checks and additionally confirms that:

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
node scripts/verify-package.mjs --list-files
```

## Local development validation

Before publishing, validate both local-checkout modes without mixing their assumptions.

### Quick isolated checkout smoke test

1. Install `agent-browser` separately.
2. Launch `pi --no-extensions -e .` from this repository root.
3. Confirm the checkout extension loads from `extensions/agent-browser/index.ts`.
4. Run a smoke prompt that exercises `agent_browser`.
5. Restart the `pi` process after extension edits; Pi settings and `/reload` are not the validation target in this isolated mode.

### Configured-source lifecycle validation

1. Configure exactly one active source for this extension in Pi settings: this checkout path before publishing, or the installed package after publishing.
2. Launch plain `pi` so extension discovery is active.
3. Validate managed-session continuity with `/reload` and a full restart + `/resume`.
4. Re-check local extension-side docs (`README.md`, `docs/COMMAND_REFERENCE.md`, and prompt guidance) if the upstream `agent-browser` version/help surface changed, then run `npm run verify:command-reference`.

### Real upstream contract validation

The default `npm test` and `npm run verify` paths use fast deterministic tests and fake binaries. When a change touches upstream command planning, result presentation, managed-session behavior, or the canonical capability baseline, also run the opt-in real-upstream contract suite:

```bash
PI_AGENT_BROWSER_REAL_UPSTREAM=1 npm run test:real-upstream
# equivalent release-script alias
npm run verify:real-upstream
```

This suite requires the installed `agent-browser --version` to exactly match `scripts/agent-browser-capability-baseline.mjs`. It serves fixture pages from localhost and validates real runtime output shapes for `--version`, `open`, `eval --stdin`, `snapshot -i`, `batch` stdin, and implicit managed-session reuse. If the suite fails because JSON/detail keys drifted, update the wrapper behavior or refresh `test/fixtures/agent-browser-real-output-shapes.json` together with the presentation work that consumes those shapes.

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
6. Validate at least one file-download flow with `download <selector> <path>`.

## Post-publish install validation

After publishing a release, validate the package-first path in isolation. `npm run verify:release` includes the deterministic fake-binary packaged execution gate, but it does not replace a real-browser installed-package smoke:

```bash
npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
npm run verify:release
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
- run `npm run verify:command-reference` if the installed upstream `agent-browser` version or help surface changed
- run `npm run doctor` and confirm any duplicate-source remediation matches the active package/check-out setup
- run `npm run verify:real-upstream` for upstream runtime, result-presentation, or managed-session changes
- confirm both local-checkout modes still work for pre-release validation: isolated `pi --no-extensions -e .` smoke testing and plain-`pi` configured-source lifecycle validation
- rerun `npm run verify:release`
- manually exercise `/reload` and full restart + `/resume` continuity in configured-source lifecycle validation
- publish only after the tarball contents and isolated packaged-extension smoke check match expectations
