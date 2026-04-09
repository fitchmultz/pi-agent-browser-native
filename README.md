# pi-agent-browser

Native `pi` integration for [`agent-browser`](https://agent-browser.dev/).

## Status

Early working scaffold.

The package scaffold, native `agent_browser` tool, local typecheck/test setup, and project-local development entrypoint are in place.

## Goal

Expose `agent-browser` to `pi` as a native tool so agents can automate the browser without going through a bash-backed skill.

## Product stance

- **Not bundled**: users install `agent-browser` separately and keep it on `PATH`
- **Latest-version only**: no backward-compatibility support or shims for older `agent-browser` versions
- **Thin wrapper**: stay close to upstream `agent-browser` instead of re-implementing its CLI
- **Agent-invoked first**: the main UX is the agent calling the tool directly, like `read` or `write`
- **Global-install first**: package behavior matters more than repo-local development wiring

Upstream install/docs:
- https://agent-browser.dev/
- https://github.com/vercel-labs/agent-browser

## Why this exists

A native `pi` integration can improve on the current skill by adding:

- structured tool calls instead of shell strings
- parsed results instead of bash stdout
- inline screenshots and artifacts
- lightweight session convenience inside `pi`
- a better base for serious browser automation

## Example use cases

- UI testing and exploratory QA
- web research
- driving web UIs for ChatGPT, Grok, Gemini, and Claude
- authenticated browser sessions and persistent profiles

## Install and try

Today, the practical install path is from a local checkout.

1. Install `agent-browser` separately.
2. Clone this repository.
3. Install the package into `pi` globally:

```bash
pi install /absolute/path/to/pi-agent-browser
```

To try it without installing permanently:

```bash
pi -e /absolute/path/to/pi-agent-browser
```

The native tool exposed to the agent is named `agent_browser`.

## Local development

1. Install `agent-browser` separately via the upstream project.
2. Run `npm install`.
3. Launch `pi` from this repository root.
4. Prompt the agent to use `agent_browser`.

If your environment already has the older bash-based `agent-browser` skill installed globally and it causes confusion, disable or remove that legacy skill. This package does not ship a skill override anymore.

Example prompt:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Validated workflow examples:

- open a page and snapshot it
- click a link and confirm the destination title
- use an explicit `--session` across multiple tool calls
- use an explicit `--profile` and verify persisted browser storage across restarts
- run `batch` with JSON via `stdin`
- run `eval --stdin`
- take a screenshot with inline attachment support
- inspect `agent_browser --help` and `--version`

Current cautions:
- passing `--profile` is an explicit upstream choice; this extension does not add its own profile-cloning or isolation layer
- implicit `piab-*` sessions are extension-managed convenience sessions; they are best-effort closed on `pi` shutdown and also get an idle timeout to reduce stale background daemons
- explicit upstream sessions like `--session`, `--profile`, `--session-name`, and `--cdp` are treated as user-managed and are not auto-closed by the extension

## Docs

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — product requirements and constraints
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture decision
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) — proposed v1 tool shape
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — staged implementation plan

## Documentation rule

When requirements change in chat:

1. update `docs/REQUIREMENTS.md`
2. update the affected design docs
3. update this README if user-facing expectations changed
