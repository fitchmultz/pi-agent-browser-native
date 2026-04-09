# Requirements

Related docs:
- [`../README.md`](../README.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`../AGENTS.md`](../AGENTS.md)

## Purpose

Define the product requirements and constraints for `pi-agent-browser`.

## Product requirements

### Dependency model

- `agent-browser` is an external dependency.
- This project does **not** bundle `agent-browser`.
- Users install `agent-browser` separately and keep it available on `PATH`.
- User-facing install guidance should point to the upstream `agent-browser` project/docs.

### Version policy

- Target the current locally installed `agent-browser` version.
- Do **not** support a broad range of older `agent-browser` versions.
- Do **not** add backward-compatibility shims.
- Keep the wrapper close to current upstream behavior as `agent-browser` evolves.

### Design philosophy

- Do **not** overengineer.
- Do **not** reduce usability.
- Keep the integration thin and close to upstream `agent-browser`.
- Give `pi` agents the power they need for practical browser automation.
- Prefer official `pi` mechanisms over bespoke custom integration patterns.
- Do **not** solve hypothetical problems that are not backed by observed behavior.

### Primary UX

- The main UX is the agent invoking the native tool directly, similar to built-in tools like `read` or `write`.
- Do **not** rely on a large set of user-facing slash commands as the main interface.
- This project is not trying to embed a human-browsable browser UI inside `pi`.

### Install priority

- Prioritize the global install path first.
- Most users will install this extension globally rather than as a project-local extension.
- Repo-local `.pi/` wiring is for development convenience and should not drive the product design.

### Legacy skill coexistence

- Some environments already have the older bash-based `agent-browser` skill installed.
- When this native extension is available, that legacy skill must not become the primary path for browser automation.
- Any mitigation for that problem should work for the global-install path, not only local repo testing.

### Documentation standard

- Documentation is a core product artifact.
- Docs must be structured, concise, well-linked, and written for humans first.
- Someone opening the repo should quickly understand the goal, purpose, install model, and usage.
- Documents should read as complete documents, not iterative logs, unless they are explicitly meant to be iterative, such as a changelog.
- Requirements, expectations, and durable rules from user conversations should be reflected in the appropriate docs.

### Testing guidance

- The primary confidence path is a real `pi` session driven in `tmux`.
- Launch `pi` from the repository root for local development so project-local resources load.
- Prefer full `pi` restart over `/reload` when validating extension changes.
- Use `/resume` when needed after restart.
- Keep testing broader than a single smoke site like `example.com`.

## Representative use cases

The design should comfortably support workflows such as:

- UI testing and exploratory QA
- web research
- using browser UIs for other LLMs such as ChatGPT, Grok, Gemini, and Claude
- isolated authenticated browser sessions
- cloned-profile workflows similar to the patterns used in `pi-oracle`

## Implications for the implementation

- Package-manifest behavior matters more than repo-local development wiring.
- The extension should use official `pi` hooks and package resources where possible.
- The wrapper should stay thin, with upstream `agent-browser` remaining the source of truth for command semantics.
- User-facing docs belong in `README.md` and `docs/`.
- Agent workflow and testing procedures belong in `AGENTS.md`.

## Open design questions

- How much session convenience should the extension add by default versus leaving explicit session naming entirely to upstream `agent-browser` semantics?
- Exactly which high-value result renderers belong in v1 beyond screenshots/images and a few compact summaries?
