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

## Documentation placement

- Put user-facing product docs in `README.md` and `docs/`.
- Put agent-specific operational notes, workflows, and testing procedures in this `AGENTS.md`.
- Write documents as complete documents, not iterative logs, unless the document is explicitly meant to be iterative such as `CHANGELOG.md`.

## Preferred testing workflow

Use an end-to-end interactive `pi` run inside `tmux`.

### Rules

- For local checkout validation, launch `pi --no-extensions -e .` from this repository root so only the checkout copy loads, even if the package is installed globally.
- For code changes, isolated `pi` agent sessions that load this local checkout are a pre-commit requirement; validate behavior there before commit/push.
- Pre-commit validation should exercise the local checkout code, because those changes are not published yet.
- For post-publish installed-package validation, update the real globally installed package and run plain `pi` so verification exercises the published artifact rather than the local checkout.
- For installed-package validation, run plain `pi` and confirm the globally installed package loads without any repo-local `.pi/extensions/` shim.
- Use `tmux` via bash commands.
- Do **not** use the pi interactive shell extension for this workflow.
- Drive `pi` like a real user by sending prompts normally.
- When testing against other isolated `pi` sessions, feel free to ask those agents for candid feedback on the tool UX and behavior, including whether it feels clunky, uninformative, or slower without clear gain.
- After extension changes, `/reload` is the minimum, but a full close-and-relaunch of `pi` is preferred for higher confidence.
- If continuing the same conversation after restart, use `/resume` or an explicit session path/id.
- Resumed sessions should reflect the updated extension code after restart.

### Practical tmux notes

- Prefer `tmux send-keys ... Enter` for prompt submission.
- Capture larger pane ranges when debugging: `tmux capture-pane -p -S -300 -t <session>:0.0`.
- Clean up tmux sessions after testing.
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
