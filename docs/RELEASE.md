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
2. `npm run verify:package` for package-content validation via `npm pack --json --dry-run`

## What package verification checks

`npm run verify:package` confirms that:

- no repo-local `.pi/extensions/agent-browser.ts` autoload shim is present
- `LICENSE` exists in the repo and the packed tarball
- canonical published docs are present
- extension source files are present, including the split result-rendering modules required by the published facade
- agent-only and superseded docs are absent from the tarball

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
2. Launch `pi --no-extensions -e .` from this repository root.
3. Confirm the checkout extension loads from `extensions/agent-browser/index.ts`.
4. Run a smoke prompt that exercises `agent_browser`.
5. Validate managed-session continuity with both `/reload` and a full restart + `/resume`.

Example smoke prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Recommended lifecycle follow-up:

1. Open a page with the implicit managed session and confirm the title.
2. Run `/reload`, then ask for `snapshot -i` and confirm the same page is still active.
3. Exit `pi`, relaunch it against the same session file or use `/resume`, then ask for `snapshot -i` again and confirm the same page is still active.
4. Open a large page that compacts its snapshot output and confirm `details.fullOutputPath` still exists after the restart/resume flow.

## Post-publish install validation

After publishing a release, validate the package-first install path explicitly:

```bash
pi install npm:pi-agent-browser-native@<version>
pi -e npm:pi-agent-browser-native@<version>
```

Then confirm `pi` exposes the native `agent_browser` tool, that a basic `open` + `snapshot -i` flow works, and that `/reload` plus restart/`/resume` keep following the same implicit managed browser session.

## Release notes checklist

Before publishing:

- update `CHANGELOG.md`
- confirm README install guidance still leads with the package-first flow
- confirm the explicit local-checkout instructions still work for pre-release validation
- rerun `npm run verify:release`
- manually exercise `/reload` and full restart + `/resume` continuity in local checkout validation
- publish only after the tarball contents match expectations
