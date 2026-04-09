# Implementation plan

Related docs:
- [`../README.md`](../README.md)
- [`REQUIREMENTS.md`](REQUIREMENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`../AGENTS.md`](../AGENTS.md) — agent-specific testing workflow and operational notes

## Goal

Ship the thinnest useful native `pi` integration for `agent-browser`.

## Current status

Already in place:
- package scaffold
- native `agent_browser` tool
- direct `--json` subprocess execution
- optional stdin support
- implicit-session convenience
- inline screenshot attachment support
- local typecheck and unit tests
- legacy-skill suppression via official pi hooks

Next focus:
- harden only observed edge cases
- refine docs
- keep validating behavior through real `pi` + `tmux` runs, including installed-package flows

## V1 target

Ship:
- one native tool: `agent_browser`
- external `agent-browser` dependency from `PATH`
- direct `--json` subprocess execution
- optional stdin support
- implicit extension-owned session convenience
- inline screenshot/image attachment
- clear docs

Do not ship:
- a broad family of bespoke browser tools
- compatibility shims
- a slash-command-heavy UX
- embedded browser UI inside `pi`

## Phase 1 — package skeleton

Create:
- `package.json`
- `extensions/agent-browser/index.ts`

Requirements:
- make the external dependency explicit
- point users to upstream install docs
- do not vendor `agent-browser`

## Phase 2 — execution layer

Implement a small wrapper that:
- resolves `agent-browser` from `PATH`
- invokes it directly
- injects `--json`
- supports optional stdin
- captures stdout, stderr, exit status, and parsed JSON
- fails clearly when the binary is missing or output is invalid

## Phase 3 — native tool

Register `agent_browser` with:
- `args: string[]`
- `stdin?: string`
- `useActiveSession?: boolean`

Behavior:
- inject implicit session only when appropriate
- preserve explicit upstream session flags

## Phase 4 — lightweight session tracking

Implement:
- one implicit active session per `pi` session
- implicit session names derived from the official `pi` session id
- deterministic reuse across restart/resume
- no attempt to make browser runtime state branch-replayable

## Phase 5 — result shaping

Implement:
- concise text summaries
- parsed upstream JSON in details
- inline image attachments for screenshots

High-value renderers only:
- snapshot
- screenshot
- tab list
- stream status

## Phase 6 — docs tied to code

Keep these current as implementation lands:
- `README.md`
- `docs/REQUIREMENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/TOOL_CONTRACT.md`

Add user-facing guidance for:
- install expectations
- latest-only support
- session behavior
- missing binary troubleshooting
- sticky launch flags

## Phase 7 — local validation

Validate at minimum:
- missing-binary failure path
- `open`
- `snapshot -i`
- `click`
- `batch` via stdin
- `eval --stdin`
- screenshot image attachment
- implicit session reuse
- explicit `--session` passthrough
- restart + `/resume` behavior with the current extension code

## Acceptance criteria

V1 is good enough when:
- the agent can browse with a native tool instead of bash
- the wrapper stays thin and close to upstream
- screenshots render inline
- session convenience works without hiding upstream power
- the docs are easy to scan and understand
