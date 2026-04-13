# Architecture

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)

## Decision

Build this as a **thin `pi` extension/package** that exposes `agent-browser` as one native tool while keeping upstream `agent-browser` as the source of truth.

The package install path is the primary product path. Local checkout development should use explicit CLI loading, while package-manifest behavior and packaged contents matter more.

## Chosen shape

### One primary tool

V1 should expose one native tool:

- `agent_browser`

Why:
- lowest maintenance cost
- lowest drift risk as upstream changes
- preserves full upstream power
- avoids overengineering

### Direct subprocess execution

The extension should:
- resolve `agent-browser` from `PATH`
- invoke it directly, not through a shell
- inject `--json`
- support optional stdin for commands like `eval --stdin` and `batch`

### Agent-first UX

The primary UX is the agent calling the tool directly.

That means:
- no command-heavy slash-command interface
- no manual user orchestration as the main workflow
- any future slash commands should be minimal and secondary

### Package layout versus local checkout development

The published package should load from the `pi` manifest in `package.json`.

Local checkout development should use explicit CLI loading such as `pi --no-extensions -e .` from the repository root instead of repo-local `.pi/extensions/` auto-discovery.

Why:
- avoids duplicate `agent_browser` registrations when the package is also installed globally
- keeps the product contract centered on the package manifest instead of repo-local autoload wiring
- keeps the published tarball focused on the package manifest, extension code, canonical docs, and license

The published package should exclude agent-only and superseded repo materials such as `AGENTS.md`, `docs/v1-tool-contract.md`, `docs/native-integration-design.md`, and other internal planning notes.

## Session model

### Default

If the caller does not provide `--session`, the extension should default to `sessionMode: "auto"` and use an implicit session name derived from the current `pi` session id plus a hash of the absolute cwd.

Why:
- works out of the box
- gives continuity across calls
- avoids forcing the agent to invent session names for basic browsing

### Explicit upstream sessions and fresh launches

If the caller provides `--session`, `--profile`, `--cdp`, or similar upstream flags, the extension should respect them with minimal interference.

The tool should also expose a first-class `sessionMode: "fresh"` escape hatch so agents can intentionally rotate the extension-managed session to a fresh upstream launch without inventing a fixed explicit session name.

### Ownership

V1 ownership rule:
- implicit auto-generated sessions are extension-managed convenience sessions
- unnamed `sessionMode: "fresh"` launches rotate that extension-managed session to a new upstream browser
- explicit/user-managed sessions are not auto-managed by default
- extension-managed sessions should be reusable during an active `pi` session and across `/reload` / `/resume`, while still being cleaned up predictably

Practical policy:
- preserve the current extension-managed session across normal `pi` shutdown/reload so persisted sessions can keep following the live browser after `/reload` or `/resume`
- set an idle timeout on extension-managed sessions so abandoned daemons self-clean after inactivity
- clean up process-private temp spill artifacts on shutdown, but keep persisted-session snapshot spill files in a private session-scoped artifact directory so `details.fullOutputPath` stays usable after reload/resume
- reconstruct the current extension-managed session from persisted tool details on resume/reload so later default calls keep following the active managed browser
- if an unnamed fresh launch replaces an active extension-managed session, best-effort close the old managed session after the switch succeeds
- leave explicit caller-provided `--session` choices alone unless the caller closes them explicitly

This is primarily about ownership clarity and avoiding surprise, not adding a heavy safety wrapper. If the extension invented the session, the extension should own its lifecycle without breaking reload/resume semantics. If the caller explicitly chose the upstream session model, the extension should stay out of the way.

### Launch flags

`agent-browser` startup flags are sticky once a session is already running.
The extension should surface that clearly and avoid hidden restart behavior in v1.

That means explicit startup-scoping flags like `--profile`, `--session-name`, and `--cdp` should remain explicit upstream choices instead of being wrapped in extra hidden restart or cloning logic.

If the implicit session is already active and one of those startup-scoped flags appears again while `sessionMode` is still `"auto"`, the extension should fail clearly instead of silently sending a command shape that upstream would ignore.

That failure should include a structured recovery hint pointing to `sessionMode: "fresh"` as the first-line fix, while still allowing an explicit `--session` when the caller wants to name the new upstream session.

A successful unnamed `sessionMode: "fresh"` launch should become the new extension-managed session so later default calls follow that browser instead of silently snapping back to the older managed session.

## Preferring the native tool

Keep the handling simple:
- prefer the native tool through extension guidance and tool-call guards
- do not rely on package skill overrides as the primary solution

This keeps the product centered on native tool usage instead of auxiliary skill wiring.

## Responsibility split

### `pi-agent-browser-native` owns

- tool registration and schema
- subprocess execution and JSON parsing
- clear missing-binary errors
- compact result summaries
- inline screenshots/images
- lightweight session convenience
- docs

### Upstream `agent-browser` owns

- browser automation semantics
- command vocabulary
- session/profile behavior
- auth/profile mechanics
- feature evolution

## Not the right design

V1 should avoid:
- a wide family of bespoke browser tools
- compatibility layers for old `agent-browser` versions
- deep embedded SDK-style integration
- embedding a human-browsable browser UI inside `pi`
- a slash-command-heavy UX

## V1 priorities

### Must have

- one native `agent_browser` tool
- direct `--json` execution
- optional stdin support
- implicit-session convenience
- screenshot/image attachment
- clear install and missing-binary messaging
- solid docs

### Nice to have

- compact renderers for snapshots and tab lists
- lightweight status display

## Summary

The architecture should stay:
- thin
- latest-only
- close to upstream
- native where it matters
- low-maintenance
