# Architecture

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)

## Decision

Build this as a **thin `pi` extension/package** that exposes `agent-browser` as one native tool while keeping upstream `agent-browser` as the source of truth.

The package install path is the primary product path. Repo-local `.pi/` wiring exists for development, but package-manifest behavior matters more.

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

## Session model

### Default

If the caller does not provide `--session`, the extension should use an implicit session name derived from the current `pi` session id.

Why:
- works out of the box
- gives continuity across calls
- avoids forcing the agent to invent session names for basic browsing

### Explicit upstream sessions

If the caller provides `--session`, `--profile`, `--cdp`, or similar upstream flags, the extension should respect them with minimal interference.

### Ownership

V1 ownership rule:
- implicit auto-generated sessions are extension-managed convenience sessions
- explicit/user-managed sessions are not auto-managed by default
- implicit sessions should be reusable during an active `pi` session, but should still be cleaned up predictably

Practical policy:
- on normal `pi` shutdown, best-effort close the implicit session
- also set an idle timeout on implicit sessions so abandoned daemons self-clean after inactivity
- leave explicit upstream sessions like `--session`, `--profile`, `--session-name`, and `--cdp` alone unless the caller closes them explicitly

This is primarily about ownership clarity and avoiding surprise, not adding a heavy safety wrapper. If the extension invented the session, the extension should clean it up. If the caller explicitly chose the upstream session model, the extension should stay out of the way.

### Launch flags

`agent-browser` startup flags are sticky once a session is already running.
The extension should surface that clearly and avoid hidden restart behavior in v1.

That means explicit startup-scoping flags like `--profile`, `--session-name`, and `--cdp` should remain explicit upstream choices instead of being wrapped in extra hidden restart or cloning logic.

## Coexisting with the legacy bash skill

Some environments already have the older bash-based `agent-browser` skill installed.

Keep the handling simple:
- prefer the native tool through extension guidance and tool-call guards
- do not rely on package skill overrides to win precedence
- if a user-scoped legacy skill still causes confusion in practice, let the user disable or remove it globally

Observed behavior on this machine: user-scoped legacy skills can beat package-provided skills on precedence, so shipping a skill override is not a reliable primary solution.

## Responsibility split

### `pi-agent-browser` owns

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
