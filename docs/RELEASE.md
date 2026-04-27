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
npm run verify:release
```

`npm run verify:release` runs:

1. `npm run verify` for TypeScript and unit coverage
2. `npm run verify:package:pi`, which first validates package contents via `npm pack --json --dry-run` and then smoke-loads the packed package in Pi isolation

## What package verification checks

`npm run verify:package` confirms that:

- no repo-local `.pi/extensions/agent-browser.ts` autoload shim is present
- `LICENSE` exists in the repo and the packed tarball
- canonical published docs are present
- extension source files are present, including the split result-rendering modules required by the published facade
- agent-only and superseded docs are absent from the tarball

`npm run verify:package:pi` runs the same package-content checks and additionally confirms that:

- the packed package can be loaded through Pi SDK resource loading with the same isolation principle as `pi --no-extensions -e <package-source>`
- exactly one `agent_browser` tool is registered
- the registered `agent_browser` source resolves inside the extracted packed package path, not the working checkout

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

Before publishing, also validate the explicit local-checkout path:

1. Install `agent-browser` separately.
2. Make sure Pi has only one active source for this extension during checkout validation.
3. Launch `pi --no-extensions -e .` from this repository root.
4. Confirm the checkout extension loads from `extensions/agent-browser/index.ts`.
5. Run a smoke prompt that exercises `agent_browser`.
6. Validate managed-session continuity with both `/reload` and a full restart + `/resume`.
7. Re-check local extension-side docs (`README.md`, `docs/COMMAND_REFERENCE.md`, and prompt guidance) if the upstream `agent-browser` version/help surface changed.

Example smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Recommended lifecycle follow-up:

1. Open a page with the implicit managed session and confirm the title.
2. Run `/reload`, then ask for `snapshot -i` and confirm the same page is still active.
3. Exit `pi`, relaunch it against the same session file or use `/resume`, then ask for `snapshot -i` again and confirm the same page is still active.
4. Open a large page that compacts its snapshot output and confirm `details.fullOutputPath` still exists after the restart/resume flow.
5. Trigger an oversized non-snapshot output (for example a deliberately large `eval --stdin` result) and confirm the tool prints the actual spill file path directly in content instead of only referencing a details key.
6. Validate at least one file-download flow with `download <selector> <path>`.

## Post-publish install validation

After publishing a release, validate the package-first path in isolation:

```bash
npm run verify:release
pi --no-extensions -e npm:pi-agent-browser-native@<version>
```

Then run the smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Only use plain `pi` for installed-package validation after temporarily disabling or removing the checkout source or any other active source for this extension from Pi settings. Then confirm `pi` exposes the native `agent_browser` tool, that a basic `open` + `snapshot -i` flow works, and that `/reload` plus restart/`/resume` keep following the same implicit managed browser session.

## Release notes checklist

Before publishing:

- update `CHANGELOG.md`
- confirm README install guidance still leads with the package-first flow
- confirm `docs/COMMAND_REFERENCE.md` still matches the effective upstream command/help surface used by the wrapper
- confirm the explicit local-checkout instructions still work for pre-release validation
- rerun `npm run verify:release`
- manually exercise `/reload` and full restart + `/resume` continuity in local checkout validation
- publish only after the tarball contents and isolated packaged-extension smoke check match expectations
