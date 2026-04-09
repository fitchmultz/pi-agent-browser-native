# Requirements

Related docs:
- [`../README.md`](../README.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)

## Purpose

This file is the living capture of product requirements, constraints, expectations, and design rules provided by the user.

## Maintenance rule

When the user provides new requirements in chat:

1. record them here
2. update linked design docs if the requirement changes architecture or UX
3. update `README.md` if the requirement changes user-facing expectations

## Captured requirements

### 2026-04-09 — dependency model

Source: user chat

- This project must **not** bundle `agent-browser`.
- The user installs `agent-browser` separately.
- `agent-browser` must be available on the user’s `PATH`.
- Recommended installation should point to the upstream `agent-browser` project repository/docs.

### 2026-04-09 — version support policy

Source: user chat

- This project is **not** trying to support a wide range of `agent-browser` versions.
- `agent-browser` changes rapidly and often.
- This project should support the version of `agent-browser` available on the local development machine, which is kept current.
- There should be **no backwards compatibility support** for older `agent-browser` versions, initially or later.
- Avoid compatibility shims.

## Derived product implications

- The integration should stay close to upstream behavior.
- The maintenance burden should be minimized by avoiding large hand-maintained compatibility layers.
- Upstream `agent-browser` docs and command vocabulary should remain authoritative.

### 2026-04-09 — design philosophy

Source: user chat

- Do **not** overengineer.
- Do **not** reduce usability.
- Integrate `agent-browser` into `pi` as natively as possible.
- Give `pi` agents the power they need to automate anything practical in the browser.
- The primary UX should be the agent invoking the tool directly, the same way it uses built-in tools like `read` or `write`.
- Do **not** rely on a large set of user-facing slash commands as the main interface.
- This project is **not** trying to embed a browser inside `pi` for the human user to browse manually.

## Derived product implications

- Prefer a thin native wrapper over a large re-abstracted browser framework.
- Favor native `pi` affordances where they create real value: structured tool calls, result summaries, artifacts, session convenience, and documentation.
- Avoid rebuilding every upstream command as a separate bespoke abstraction unless it clearly improves usability enough to justify maintenance cost.
- Any slash commands should be optional diagnostics or maintenance helpers at most, not the primary product surface.
- "Rendering" in this project means better presentation of tool results inside `pi`, not a full embedded browser UI.

### 2026-04-09 — example use cases to keep in mind

Source: user chat

Representative examples:

- UI testing
- researching information
- querying other LLMs via browser UIs like ChatGPT, Grok, Gemini, and Claude
- using cloned browser profiles in isolated sessions for authenticated access to resources
- learning from `~/Projects/AI/pi-oracle` for authenticated isolated-profile workflows

These are examples, not an exhaustive scope boundary.

### 2026-04-09 — documentation quality bar

Source: user chat

- Documentation is crucial.
- Documentation must be structured, organized, and well-linked.
- Markdown files should be properly formatted and connected to one another.
- README quality matters a lot.
- Docs must be written for human users first.
- Someone opening the repo should rapidly understand the goal, purpose, and how to use the project.
- Requirements, expectations, rules, and similar guidance from chat should be documented.

## Derived product implications

- Documentation updates are part of the main work, not follow-up polish.
- The repo should maintain a clear landing-page README plus focused supporting docs.
- Design decisions should be written down before implementation expands.

### 2026-04-09 — preferred testing workflow

Source: user chat

- Prefer testing through a real `pi` session in `tmux`.
- Drive `pi` by acting like the user and prompting it normally.
- Launch `pi` from this repository working directory so project-local extensions are loaded.
- Do **not** use the pi interactive shell extension for this testing workflow.
- Use `tmux` through bash commands instead.
- After extension changes, `/reload` is the minimum, but a full close-and-relaunch of `pi` is preferred for higher confidence.
- After restart, use `/resume` or a specific session id/path if continuing the same conversation.
- Resumed sessions should pick up the updated extension code after restart.
- Agent-specific testing procedures and operational notes should live in `AGENTS.md`, not general user-facing docs.

## Derived product implications

- The primary integration test should be an end-to-end interactive `pi` run, not only isolated helper tests.
- Validation should include proof that restarted/resumed sessions see updated project-local extension code.
- User-facing docs should stay focused on product usage, while agent workflow details belong in `AGENTS.md`.

## Current open design questions

These are not yet final decisions.

1. How much session convenience should the extension add by default versus leaving explicit session naming entirely to upstream `agent-browser` semantics?
2. Exactly which high-value result renderers belong in v1 beyond screenshots/images and a few compact summaries?
