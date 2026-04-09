# Native `agent-browser` integration for pi

## Goal

Build a first-class pi package/extension that exposes `agent-browser` as native pi tools instead of only via a bash-backed skill.

## Short answer

Yes — a native pi integration can unlock materially better capabilities than the current skill.

The best initial approach is **not** a deep embedded SDK integration. `agent-browser` is currently shipped here as a native CLI wrapper, not a reusable JS library. So the best v1 is:

- a **pi package**
- with a **project/global extension** that registers native browser tools
- backed by `agent-browser --json` subprocess calls
- with pi-managed session state, rendering, safety defaults, and cleanup

## Why this is the best v1

### What exists today

- `agent-browser` is installed as a CLI (`/opt/homebrew/bin/agent-browser`)
- the npm package on this machine exposes a binary wrapper, not a stable importable SDK
- the existing skill works by allowing `bash` invocations like `agent-browser open ...`
- `agent-browser` already supports structured JSON responses for many commands

### What pi adds on top

A native pi extension can provide:

1. **Typed tools** instead of shell strings
2. **Structured results** instead of stdout parsing
3. **Session ownership + cleanup** instead of manual `--session` juggling
4. **Inline screenshots/images** in tool results
5. **Safer defaults** via extension-managed policies/env/config
6. **UI affordances** like `/browser`, `/browser-sessions`, widgets, status, and overlays
7. **Dynamic tool activation** so browser tools only appear when useful
8. **Better batching** without shell quoting issues

## Key finding

The biggest architectural constraint is this:

> `agent-browser` is currently easiest to integrate as an external process, not as an in-process library.

That makes a **thin native-tool wrapper over the CLI** the right design.

## Options considered

### Option A — keep the current bash skill

**Pros**
- zero engineering
- full CLI surface already available

**Cons**
- shell quoting is fragile
- no typed schemas
- no native rendering
- poor session lifecycle handling
- weak policy integration
- awkward screenshots/streaming UX

### Option B — native pi tools backed by `agent-browser --json` (**recommended**)

**Pros**
- fastest path to real UX gains
- uses stable existing CLI surface
- keeps parity with installed Homebrew version
- unlocks typed params, custom rendering, session/state management, UI hooks

**Cons**
- still subprocess-based
- limited by current CLI JSON shape
- live streaming will need extra glue

### Option C — deep embedded integration

**Pros**
- maximum control
- ideal future architecture if agent-browser exposes a stable SDK/RPC

**Cons**
- not justified yet
- no clear local SDK to build against today
- higher maintenance and upgrade risk

## Recommended architecture

## 1) Ship as a pi package

Package shape:

- `package.json` with `pi` manifest
- `extensions/agent-browser/index.ts`
- optional `skills/agent-browser-native/SKILL.md`
- optional prompts/themes later

Why:

- installable via `pi install ...`
- works globally or per-project
- easy to publish on npm/git

## 2) Extension owns a browser client wrapper

Core internal module responsibilities:

- resolve `agent-browser` binary
- run all commands with `--json`
- normalize `{ success, data, error }`
- map CLI failures to tool errors
- manage owned session names
- track launch-time options per session
- close owned sessions on `session_shutdown`

Important nuance from runtime docs:

- launch-time flags are sticky for a running `agent-browser` session
- the wrapper must treat first-launch config as authoritative
- changing startup flags later should either:
  - fail clearly, or
  - close/restart explicitly

## 3) Register a small set of native tools

Do **not** mirror every CLI command 1:1 at first.

Best v1 surface:

### `browser_session`
Manage browser session lifecycle.

Actions:
- `start`
- `list`
- `select`
- `close`
- `close_all_owned`
- `status`

Params include:
- `sessionName?`
- `headed?`
- `profile?`
- `stateFile?`
- `cdp?`
- `autoConnect?`
- `allowedDomains?`
- `contentBoundaries?`

### `browser_page`
Navigation and browser context.

Actions:
- `open`
- `back`
- `forward`
- `reload`
- `wait`
- `tab_list`
- `tab_new`
- `tab_switch`
- `tab_close`
- `frame`
- `frame_main`

### `browser_snapshot`
Return the page model.

Actions:
- `snapshot`
- `snapshot_interactive`

Return:
- human-readable snapshot text
- typed `refs`
- `origin`
- metadata for invalidation tracking

### `browser_action`
Perform interactions.

Actions:
- `click`
- `fill`
- `type`
- `select`
- `check`
- `uncheck`
- `press`
- `scroll`
- `hover`
- `drag`
- `upload`

### `browser_data`
Read/extract structured data.

Actions:
- `get_text`
- `get_html`
- `get_value`
- `get_attr`
- `get_title`
- `get_url`
- `eval`
- `network_requests`
- `console`
- `errors`
- `storage`
- `cookies`

### `browser_artifact`
Create visual/debug artifacts.

Actions:
- `screenshot`
- `pdf`
- `record_start`
- `record_stop`
- `trace_start`
- `trace_stop`
- `profiler_start`
- `profiler_stop`
- `stream_status`

This is enough to cover the core workflow without overwhelming the model.

## 4) Use pi-native rendering aggressively

Custom renderers should make results compact and useful.

Examples:

- `browser_snapshot`: show URL + ref count + first lines of snapshot
- `browser_action`: show concise action summary (`clicked @e4`)
- `browser_artifact.screenshot`: attach the actual image
- `browser_page.tab_list`: render a compact tab table
- errors: highlight domain/policy/dialog/session mismatches clearly

This is one of the main wins over bash.

## 5) Persist only the right state

Persist in pi session entries:

- owned session names
- active session
- launch config
- last known URL/title/tab info
- safety policy settings

Do **not** pretend browser runtime is branch-deterministic.

Browser state is external and mutable. So treat persisted state as:

- reconnection metadata
- helpful context for the model
- not a full replayable source of truth

## 6) Add slash commands for humans

Recommended commands:

- `/browser` — open a small session manager / status UI
- `/browser-tools` — enable/disable browser tools dynamically
- `/browser-close` — close owned sessions
- `/browser-reset` — close + clear tracked state

## Capabilities unlocked vs the current skill

### 1) Structured snapshot results

Today:
- model parses text from bash

With native tool:
- return both snapshot text and typed ref objects
- easier follow-up interactions
- easier future ref invalidation warnings

### 2) Inline screenshots

Today:
- screenshot path is just shell output

With native tool:
- return the image directly in tool content
- much better QA/debugging loop

### 3) Safer JS evaluation and batching

Today:
- shell quoting is a footgun

With native tool:
- pass eval scripts and batch arrays as raw typed params
- wrapper handles stdin/base64/JSON safely

### 4) Session lifecycle management

Today:
- manual `--session` discipline
- easy to leak browser processes

With native tool:
- extension tracks owned sessions
- clean shutdown
- consistent active session behavior

### 5) Better safety defaults

Today:
- allowlists/policies are env/file driven and easy to forget

With native tool:
- policy can be first-class tool params / extension config
- extension can inject safe defaults automatically

### 6) Better future streaming UX

Today:
- stream/dashboard are external sidecars

With native tool:
- pi can expose stream status, overlays, widgets, and richer artifact handling
- full live viewport embedding can come later

## Recommended implementation phases

### Phase 1 — core wrapper

Build:
- package scaffold
- extension
- `browser_session`
- `browser_page`
- `browser_snapshot`
- `browser_action`
- screenshot support in `browser_artifact`
- owned-session cleanup

### Phase 2 — data/debug surfaces

Add:
- `browser_data`
- tab/frame helpers
- network/console/errors
- better renderers
- `/browser` slash command

### Phase 3 — rich UX

Add:
- widgets/status indicators
- session picker UI
- stream integration
- optional approval flows for risky actions
- better policy presets

## Recommended defaults

- always invoke `agent-browser` with `--json`
- create a pi-owned default session automatically when needed
- use semantic session names derived from pi session id
- treat screenshots as first-class image results
- close owned sessions on `session_shutdown`
- keep browser tools dynamically enableable
- keep the old bash skill only as a fallback, not the primary UX

## Risks

- CLI JSON may evolve; wrapper needs version-tolerant normalization
- browser state is external, so branch restoration is only partial
- startup-option stickiness must be modeled correctly
- live stream embedding may require additional work beyond the current CLI

## Future upstream asks to `agent-browser`

If we want a stronger v2 later, the ideal upstream additions would be:

1. stable documented JSON schemas
2. long-lived RPC/stdio mode
3. explicit machine-readable event streaming
4. importable JS/TS client library
5. machine-readable capability/version handshake

If upstream exposes those, we can upgrade from a CLI wrapper to a deeper integration.

## Bottom line

The best approach is:

- **build a pi package**
- **register native browser tools in an extension**
- **back them with `agent-browser --json`**
- **lean on pi for state, rendering, safety, commands, and UX**

That gets us meaningful native-tool advantages now, without waiting on upstream SDK work.
