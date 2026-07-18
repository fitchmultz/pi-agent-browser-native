# ADR: First-class Electron support

**Date:** 2026-05-20

**Status:** Implemented; final verification/fix pass complete

## Decision

Adopt a narrow typed top-level `electron` input for Electron discovery, isolated launch, CDP attach, status, probe, and cleanup. Extend the existing `qa` preset with `qa.attached` for attached Electron/CDP sessions. Do not add a reusable browser-recipe runtime.

`RQ-0068` rejected generic executable recipes unless benchmark or dogfood evidence showed repeated failure-prone sequences that `job`, `qa`, or raw `batch` could not represent cleanly. Electron supplied that evidence: agents repeatedly had to discover an app, create an isolated profile, launch with a debug port, poll CDP, attach, probe state across several calls, and clean up. A bounded typed lifecycle owns those Electron-specific host operations without creating a general workflow language. `RQ-0096` records the shipped capability.

## Boundaries

- Wrapper-created launches use an isolated temporary user-data directory and OS-selected remote-debugging port, then attach through upstream `agent-browser connect`.
- `electron.cleanup` may stop only wrapper-tracked launches and remove only wrapper-created profiles. Raw `connect` targets and manually launched authenticated apps remain host-owned.
- App allow/deny choices are caller-owned. Discovery may annotate likely-sensitive apps, but the wrapper does not classify or silently block them.
- Electron framework evidence is required before launch; launch arguments, CDP metadata, and results use the existing redaction policy.
- `electron.list` discovery is macOS/Linux-only. Windows launches require an explicit executable path.
- The input remains mutually exclusive with `args`, `semanticAction`, `job`, `qa`, `sourceLookup`, and `networkSourceLookup`; no pseudo-argv or reusable recipe registry was added.

## Current sources and evidence

- Active rationale and no-recipe boundary: [`../ARCHITECTURE.md`](../ARCHITECTURE.md#no-reusable-recipe-layer-yet)
- Release/readiness decisions: [`../SUPPORT_MATRIX.md`](../SUPPORT_MATRIX.md) (`RQ-0068`, `RQ-0096`)
- Public lifecycle and troubleshooting: [`../ELECTRON.md`](../ELECTRON.md)
- Native input/result contract: [`../TOOL_CONTRACT.md`](../TOOL_CONTRACT.md#electron)
- Agent workflows: [`../COMMAND_REFERENCE.md`](../COMMAND_REFERENCE.md#electron-desktop-apps)
- Input and host orchestration: `extensions/agent-browser/lib/input-modes/electron.ts`, `extensions/agent-browser/lib/orchestration/electron-host/`, `extensions/agent-browser/lib/orchestration/browser-run/`, and `extensions/agent-browser/lib/electron/`
- Deterministic coverage: `test/agent-browser.extension-electron-discovery.test.ts`, `test/agent-browser.extension-electron-lifecycle.test.ts`, `test/agent-browser.extension-validation.test.ts`, `test/agent-browser.extension-ref-guards.test.ts`, and the `electron-lifecycle` / `electron-probe` benchmark scenarios
- Manual evidence: the 2026-05-21 real-app `tmux` dogfood pass covered discovery, launch, attach/handoff, probe, mutation health, and cleanup; follow-up gaps were folded into the tests and public Electron guide above.
