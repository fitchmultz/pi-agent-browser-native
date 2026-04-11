# Release and package verification

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)

## Purpose

Provide one concrete maintainer workflow for validating repo state, package contents, and install guidance before publishing `pi-agent-browser`.

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

- the tracked repo-local development entrypoint exists at `.pi/extensions/agent-browser.ts`
- `LICENSE` exists in the repo and the packed tarball
- canonical published docs are present
- extension source files are present
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

Before publishing, also validate the repo-local development path:

1. Install `agent-browser` separately.
2. Launch `pi` from this repository root.
3. Confirm the tracked `.pi/extensions/agent-browser.ts` shim loads the current extension code.
4. Run a smoke prompt that exercises `agent_browser`.

Example prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

## Post-publish install validation

After publishing a release, validate the package-first install path explicitly:

```bash
pi install npm:pi-agent-browser-native@<version>
pi -e npm:pi-agent-browser-native@<version>
```

Then confirm `pi` exposes the native `agent_browser` tool and that a basic `open` + `snapshot -i` flow works.

## Release notes checklist

Before publishing:

- update `CHANGELOG.md`
- confirm README install guidance still leads with the package-first flow
- confirm local-checkout instructions still work for pre-release validation
- rerun `npm run verify:release`
- publish only after the tarball contents match expectations
