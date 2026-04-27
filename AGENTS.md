# pi-agent-browser

Dedicated `pi` integration of `agent-browser` as a native tool.

## Product-specific guidance

- Do **not** bundle `agent-browser` in this project.
- Assume `agent-browser` is installed separately and available on `PATH`.
- Target the current locally installed `agent-browser` version only.
- Do **not** add backwards-compatibility shims for older upstream versions.
- Keep the integration thin and close to upstream `agent-browser` behavior.
- The primary UX is the agent invoking the native tool directly, not a slash-command-heavy manual workflow.
- Do **not** overengineer or solve hypothetical problems that do not exist in observed behavior.
- Thoroughly check official `pi` docs/examples/source behavior before inventing bespoke integration patterns. Prefer an official `pi` mechanism whenever one exists.
- Prioritize the global install path first. Most users will install this extension globally, not as a project-local extension.
- Keep the local extension-side documentation good enough that an agent can use the tool without relying on direct `agent-browser` binary help; when upstream `agent-browser` changes, update the repo-readable command reference, prompt guidance, README/docs, and any relevant tests in the same work.
- For this repository, assume a single operator model: no human and no other agent is making changes here besides you.
- Treat every lingering scratch file, temp artifact, browser session, tmux session, or other side effect related to this repository as your responsibility to clean up.

## Documentation placement

- Put user-facing product docs in `README.md` and `docs/`.
- Put agent-specific operational notes, workflows, and testing procedures in this `AGENTS.md`.
- Write documents as complete documents, not iterative logs, unless the document is explicitly meant to be iterative such as `CHANGELOG.md`.

## Preferred testing workflow

Use an end-to-end interactive `pi` run inside `tmux`.

### Rules

- Use two distinct validation modes and do not mix their assumptions:
  - **Quick isolated mode:** launch `pi --no-extensions -e .` from this repository root. Pi settings and auto-discovered extension sources are intentionally bypassed; use this for checkout-only smoke tests and restart the `pi` process after extension edits instead of treating `/reload` as the validation target.
  - **Configured-source lifecycle mode:** run the opt-in `npm run verify:lifecycle` harness for deterministic regression coverage, or configure exactly one active source for this extension in Pi settings and launch plain `pi` for manual validation. Use this mode when validating `/reload`, restart, and `/resume` behavior because `/reload` exercises auto-discovered/configured resources.
- For code changes, an isolated `pi --no-extensions -e .` smoke session is a pre-commit requirement; whoever made the changes should validate unpublished checkout behavior there before commit/push (a published install alone is not a substitute).
- For installed-package validation after publish: update the real installed package, then exercise it with only the published package active—either temporarily disable/remove the checkout path and run plain `pi` for lifecycle validation, or use an isolated ephemeral smoke run like `pi --no-extensions -e npm:pi-agent-browser-native@<version>`.
- Use `tmux` via bash commands.
- Do **not** use the pi interactive shell extension for this workflow.
- Drive `pi` like a real user by sending prompts normally.
- After extension changes in configured-source lifecycle mode, `/reload` is the minimum, but a full close-and-relaunch of `pi` is preferred for higher confidence. The automated `npm run verify:lifecycle` harness creates an isolated `PI_CODING_AGENT_DIR`, configures a temporary package source, drives plain `pi` in `tmux`, uses a deterministic fake upstream `agent-browser`, checks `/reload` plus restart/`/resume`, and captures transcript artifacts on failure.
- If continuing the same conversation after restart, use `/resume` or an explicit session path/id.
- Resumed sessions should reflect the updated configured extension source after restart.

### Practical tmux notes

- Prefer `tmux send-keys ... Enter` for prompt submission.
- Capture larger pane ranges when debugging: `tmux capture-pane -p -S -300 -t <session>:0.0`.
- Clean up tmux sessions after testing.
- Before ending a turn, sweep for and remove repo-local scratch files, project-scoped temp artifacts, and lingering browser sessions created during the work unless the user explicitly asked to keep them.
- Do not overfit testing to `example.com`; use it for smoke checks only, then validate against additional realistic pages and flows. The lifecycle harness intentionally uses a fake upstream browser for deterministic lifecycle assertions and does not replace occasional real-browser manual smoke testing before release.

## Current testing focus

Before calling the first implementation usable, verify at minimum:

- missing-`agent-browser` error path is clear
- native tool invocation works from interactive `pi`
- `open` works
- `snapshot -i` works
- `click` works
- `batch` via stdin works
- `eval --stdin` works
- screenshot attachment works
- implicit session reuse works
- explicit `--session` passthrough works
- configured-source `/reload` picks up changed extension code
- full restart + `/resume` picks up changed extension code
