# pi-agent-browser

Dedicated `pi` integration of `agent-browser` as a native tool.

## Product-specific guidance

- Do **not** bundle `agent-browser` in this project.
- Assume `agent-browser` is installed separately and available on `PATH`.
- Target the current locally installed `agent-browser` version only.
- Do **not** add backwards-compatibility shims for older upstream versions.
- Keep the integration thin and close to upstream `agent-browser` behavior.
- The primary UX is the agent invoking the native tool directly, not a slash-command-heavy manual workflow.

## Documentation placement

- Put user-facing product docs in `README.md` and `docs/`.
- Put agent-specific operational notes, workflows, and testing procedures in this `AGENTS.md`.

## Preferred testing workflow

Use an end-to-end interactive `pi` run inside `tmux`.

### Rules

- Launch `pi` from this repository root so project-local extensions load.
- Use `tmux` via bash commands.
- Do **not** use the pi interactive shell extension for this workflow.
- Drive `pi` like a real user by sending prompts normally.
- After extension changes, `/reload` is the minimum, but a full close-and-relaunch of `pi` is preferred for higher confidence.
- If continuing the same conversation after restart, use `/resume` or an explicit session path/id.
- Resumed sessions should reflect the updated extension code after restart.

### Practical tmux notes

- Prefer `tmux send-keys ... Enter` for prompt submission.
- Capture larger pane ranges when debugging: `tmux capture-pane -p -S -300 -t <session>:0.0`.
- Clean up tmux sessions after testing.

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
