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
- For this repository, assume a single operator model: no human and no other agent is making changes here besides you.
- Do **not** use subagents for this repository.
- Treat every lingering scratch file, temp artifact, browser session, tmux session, or other side effect related to this repository as your responsibility to clean up.

## Documentation placement

- Put user-facing product docs in `README.md` and `docs/`.
- Put agent-specific operational notes, workflows, and testing procedures in this `AGENTS.md`.
- Write documents as complete documents, not iterative logs, unless the document is explicitly meant to be iterative such as `CHANGELOG.md`.

## Preferred testing workflow

Use an end-to-end interactive `pi` run inside `tmux`.

### Rules

- For local checkout validation, launch `pi --no-extensions -e .` from this repository root and keep only one active source for this extension in Pi settings.
- For code changes, isolated `pi` agent sessions that load this local checkout are a pre-commit requirement; validate behavior there before commit/push.
- Pre-commit validation should exercise the local checkout code, because those changes are not published yet.
- For post-publish installed-package validation, update the real installed package and validate it with only the published package active.
- For installed-package validation, either temporarily disable/remove the checkout path and run plain `pi`, or use an isolated ephemeral run like `pi --no-extensions -e npm:pi-agent-browser-native@<version>`.
- Use `tmux` via bash commands.
- Do **not** use the pi interactive shell extension for this workflow.
- Drive `pi` like a real user by sending prompts normally.
- Do **not** delegate testing or review to other agents or isolated `pi` sessions for this repository.
- After extension changes, `/reload` is the minimum, but a full close-and-relaunch of `pi` is preferred for higher confidence.
- If continuing the same conversation after restart, use `/resume` or an explicit session path/id.
- Resumed sessions should reflect the updated extension code after restart.

### Practical tmux notes

- Prefer `tmux send-keys ... Enter` for prompt submission.
- Capture larger pane ranges when debugging: `tmux capture-pane -p -S -300 -t <session>:0.0`.
- Clean up tmux sessions after testing.
- Before ending a turn, sweep for and remove repo-local scratch files, project-scoped temp artifacts, and lingering browser sessions created during the work unless the user explicitly asked to keep them.
- Do not overfit testing to `example.com`; use it for smoke checks only, then validate against additional realistic pages and flows.

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
- full restart + `/resume` picks up changed extension code
