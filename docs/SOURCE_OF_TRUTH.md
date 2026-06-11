# Source-of-truth map

Related docs:
- [`../README.md`](../README.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- [`RELEASE.md`](RELEASE.md)

## Purpose

This map keeps the active documentation set navigable. When changing behavior, update the smallest canonical document below instead of copying the same rule into every file.

| Need | Canonical source | Notes |
| --- | --- | --- |
| Install, quick start, dependencies, user-facing value, common agent guidance | [`README.md`](../README.md) | Keep outcome-first and link deeper docs instead of embedding full command contracts. |
| Runtime design, session model, package config policy, and architecture decisions | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Record design rationale here when it changes implementation shape. |
| Upstream command workflows and examples for agents | [`COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md) | Generated baseline blocks are bounded by HTML comments; regenerate with `npm run docs -- command-reference write`. |
| Native tool input schema, `details` fields, result categories, and machine-readable contracts | [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md) | Keep this as the API contract; avoid release-history prose unless it explains an active field. |
| Electron-specific lifecycle and troubleshooting | [`ELECTRON.md`](ELECTRON.md) | Public desktop app guide; link to contracts instead of duplicating schemas. |
| Targeted upstream support, release gates, and live verification status | [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) | Active checklist only. Implementation-deep closure notes live in [`support-notes.md`](support-notes.md). |
| Maintainer release process and smoke-test procedures | [`RELEASE.md`](RELEASE.md) and [`../AGENTS.md`](../AGENTS.md) | `AGENTS.md` is agent-specific operational guidance; release evidence belongs in `RELEASE.md` or CueLoop. |
| Historical plans and detailed closure notes | [`docs/plans/`](plans/), [`docs/archive/`](archive/), and [`support-notes.md`](support-notes.md) | Not the first place to read current behavior; use when investigating why a decision was made. |

## Update rules

- Prefer links over copied paragraphs.
- Keep `SUPPORT_MATRIX.md` as an index plus evidence gates, not a full per-RQ narrative log.
- Keep generated regions in `COMMAND_REFERENCE.md` and README untouched by hand; update their sources and regenerate.
- When a contract field changes, update `TOOL_CONTRACT.md`, tests, and the command/user docs that teach the workflow.
- When a release gate or supported upstream version changes, update `SUPPORT_MATRIX.md`, `RELEASE.md`, and the capability baseline together.
