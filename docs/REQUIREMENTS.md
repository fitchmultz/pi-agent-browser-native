# Requirements

Related docs:
- [`../README.md`](../README.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)
- [`RELEASE.md`](RELEASE.md)

## Purpose

Define the product requirements and constraints for `pi-agent-browser-native`.

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

- Prioritize the package install path first.
- User-facing install docs should lead with `pi install npm:pi-agent-browser-native` and `pi -e npm:pi-agent-browser-native` once releases exist.
- User-facing install docs should also include the GitHub source path `pi install https://github.com/fitchmultz/pi-agent-browser-native`.
- Keep the current local-checkout path documented as the practical pre-release and development flow.
- Most users will install this extension globally rather than as a project-local extension.
- Local checkout development should use explicit CLI loading such as `pi --no-extensions -e .` or `pi --no-extensions -e /absolute/path/to/pi-agent-browser-native`.
- Do **not** rely on repo-local `.pi/extensions/` auto-discovery for this package, because it conflicts with the global installed-package path.

### Native-tool preference

- When this native extension is available, the native `agent_browser` tool should be the preferred path for browser automation.
- Keep the handling simple and global-install-friendly.
- Do not rely on package skill overrides as the primary answer.

### Documentation standard

- Documentation is a core product artifact.
- Docs must be structured, concise, well-linked, and written for humans first.
- Someone opening the repo should quickly understand the goal, purpose, install model, and usage.
- Documents should read as complete documents, not iterative logs, unless they are explicitly meant to be iterative, such as a changelog.
- Requirements, expectations, and durable rules from user conversations should be reflected in the appropriate docs.
- Because direct-binary usage is commonly blocked in normal agent sessions, the repo must carry a local command reference for the effective `agent_browser` surface and keep it in sync with upstream changes.
- Published package contents should include the canonical user-facing docs plus `LICENSE`.
- Published package contents should exclude agent-only and superseded docs such as `AGENTS.md`, `docs/v1-tool-contract.md`, and `docs/native-integration-design.md`.

### Testing guidance

- The primary confidence path is a real `pi` session driven in `tmux`.
- For local checkout validation, launch `pi --no-extensions -e .` from the repository root so only the checkout copy loads.
- Validate both `/reload` and a full `pi` restart with `/resume` when changes touch managed-session continuity, reload behavior, or persisted artifact paths.
- Prefer full `pi` restart over `/reload` when validating extension changes beyond a quick reload smoke check.
- Use `/resume` when needed after restart.
- Keep testing broader than a single smoke site like `example.com`.
- Maintain a concrete release/package verification workflow in `docs/RELEASE.md` and matching repository scripts.

## Representative use cases

The design should comfortably support workflows such as:

- UI testing and exploratory QA
- web research
- using browser UIs for other LLMs such as ChatGPT, Grok, Gemini, and Claude
- isolated authenticated browser sessions
- headless authenticated `chat.com` / ChatGPT / OpenAI browsing without forcing `--headed` or `--auto-connect`
- upstream profile/debug workflows without adding a local profile-cloning layer in this package

## Implications for the implementation

- Package-manifest behavior matters more than repo-local development wiring.
- The extension should use official `pi` hooks and package resources where possible.
- The wrapper should stay thin, with upstream `agent-browser` remaining the source of truth for command semantics.
- User-facing docs belong in `README.md` and the canonical published files under `docs/`.
- Agent workflow and deeper testing procedures can stay in `AGENTS.md`, but published docs must not depend on that file being present.
- When upstream `agent-browser` changes, refresh the local command reference, prompt guidance, and other extension-side docs so agents still have a repo-readable equivalent of the blocked direct-binary help path.
- Keep mitigations for legacy-skill coexistence simple; do not add extra moving parts unless observed behavior justifies them.
- Prefer narrow, evidence-backed compatibility mitigations over broad stealth layers when a specific upstream site starts rejecting the default headless launch fingerprint.
- Preserve the page that a profiled `open` just navigated to; if restored profile tabs steal focus during launch, the wrapper should best-effort switch back to the returned page URL before handing control back to the agent.
- Once a tab target is known for a session, later active-tab commands should best-effort pin that same tab inside the same upstream invocation when reconnect drift would otherwise land on a restored/background tab.
- If a restored/background tab steals focus after a successful command, the wrapper should best-effort restore the intended target tab again before handing control back.
- On local Unix launches, extension-generated session names should not fail just because the upstream default socket path is too long; the wrapper should choose a shorter socket directory when needed.

## Open design questions

- How much session convenience should the extension add by default versus leaving explicit session naming entirely to upstream `agent-browser` semantics?
- Exactly which high-value result renderers belong in v1 beyond screenshots/images and a few compact summaries?
