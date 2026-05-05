<!-- CUELOOP_README_VERSION: 10 -->
# CueLoop runtime files

This repo is using CueLoop. The `cueloop` executable is the primary command name. This project stores runtime state in `.cueloop/`. New repos default to `.cueloop/`.

> This file is generated and owned by CueLoop. `cueloop init` and agent-facing write-enabled commands may refresh it when CueLoop ships a newer template. Avoid hand-editing it unless you intentionally accept that local drift may be replaced.

## Files

- `.cueloop/config.jsonc` — repo-local configuration.
- `.cueloop/queue.jsonc` — JSONC task queue; source of truth for active work.
- `.cueloop/done.jsonc` — JSONC archive for completed tasks; only `done`/`rejected` statuses are valid.
- `.cueloop/cache/` — runtime cache for plans, completions, sessions, and temporary state.
- `.cueloop/logs/` — debug logs; should stay gitignored.
- `.cueloop/trust.jsonc` — machine-local trust decision; should stay gitignored.

Do not rename runtime directories manually. Use `cueloop migrate runtime-dir --check` to preview runtime migration status and `cueloop migrate runtime-dir --apply` to move supported old project state when safe.

## Core commands

### Bootstrap and health

- Bootstrap repo files:
  - `cueloop init`
- Check this generated README:
  - `cueloop init --check`
- Verify environment readiness:
  - `cueloop doctor`
- Validate queue state:
  - `cueloop queue validate`

### Queue management

- Inspect queue:
  - `cueloop queue list`
  - `cueloop queue next --with-title`
- Get next task ID:
  - `cueloop queue next-id`
  - `cueloop queue next-id --count 7`
- Show task details:
  - `cueloop queue show RQ-0001`
- Archive completed tasks:
  - `cueloop queue archive`
- Repair queue issues:
  - `cueloop queue repair`
- Remove queue lock:
  - `cueloop queue unlock`
- Sort and search tasks:
  - `cueloop queue sort`
  - `cueloop queue search "authentication"`
  - `cueloop queue search "TODO" --status todo`
- Queue reports:
  - `cueloop queue stats`
  - `cueloop queue history --days 14`
  - `cueloop queue burndown --days 30`
  - `cueloop queue prune --age 90 --keep-last 100`

### Task creation and updates

- Build a task from a request:
  - `cueloop task "Add tests for X"`
- Insert fully-shaped tasks atomically:
  - `cueloop task insert --input /tmp/task-insert.json`
  - `cueloop task insert --dry-run --format json --input /tmp/task-insert.json`
- Update task fields from repo state:
  - `cueloop task update RQ-0001`
  - `cueloop task update`
- Edit task fields:
  - `cueloop task edit title "New title" RQ-0001`
  - `cueloop task edit tags "rust, cli" RQ-0001`
- Change task status:
  - `cueloop task status doing RQ-0001`
- Show task details:
  - `cueloop task show RQ-0001`

### Execution

- Open the macOS app (macOS-only):
  - `cueloop app open`
- Run one task:
  - `cueloop run one`
  - `cueloop run one --phases 3`
  - `cueloop run one --quick`
  - `cueloop run one --include-draft`
- Run a capped loop:
  - `cueloop run loop --max-tasks 1`
  - `cueloop run loop --phases 2 --max-tasks 1`
- Advanced unlimited loop mode (intentional only):
  - `cueloop run loop --max-tasks 0`

### PRD, context, and scans

- Convert PRD markdown to tasks:
  - `cueloop prd create docs/prd/feature.md`
  - `cueloop prd create docs/prd/feature.md --multi`
  - `cueloop prd create docs/prd/feature.md --dry-run`
- Generate or update AGENTS.md:
  - `cueloop context init`
  - `cueloop context update --section troubleshooting`
  - `cueloop context validate`
- Seed tasks from a scan:
  - `cueloop scan --focus "CI gaps"`
  - `cueloop scan --focus "risk audit" --runner claude --model sonnet`

## Troubleshooting

### Duplicate task ID error

If `cueloop queue validate` reports a duplicate task ID, this usually means a new task was added without incrementing the ID. Do not delete tasks.

1. Run `cueloop queue next-id` to preview the next available ID.
2. Edit `.cueloop/queue.jsonc` and change the colliding task ID.
3. Re-run `cueloop queue validate`.

Task IDs must be unique across both `queue.jsonc` and `done.jsonc`.

### Generating multiple task IDs

Use `--count` to generate IDs in one call:

```bash
cueloop queue next-id --count 7
```

`next-id` does not reserve IDs. For agent or script queue growth, prefer `cueloop task insert` so CueLoop assigns IDs under the queue lock. Keep `next-id` for manual recovery or one-off JSON surgery.

## Template variables

Prompt templates support variable interpolation for environment variables and config values:

- `${VAR}` — expand environment variable, leaving the literal when unset.
- `${VAR:-default}` — expand with a default value when unset.
- `{{config.agent.runner}}` — current runner.
- `{{config.agent.model}}` — current model.
- `{{config.queue.file}}` — queue file path, for example `.cueloop/queue.jsonc`.
- `{{config.queue.done_file}}` — done archive path, for example `.cueloop/done.jsonc`.
- `{{config.queue.id_prefix}}` — task ID prefix, for example `RQ`.
- `{{config.queue.id_width}}` — task ID width, for example `4`.
- `{{config.project_type}}` — project type.

Escaping:

- `$${VAR}` — outputs literal `${VAR}`.
- `\${VAR}` — outputs literal `${VAR}`.

Standard placeholders like `{{USER_REQUEST}}` are still processed after variable expansion.

## Prompt overrides

Default prompts are embedded in the `cueloop` binary. Custom prompt files should live in `.cueloop/prompts/`.

Useful commands:

- `cueloop prompt worker --phase 1`
- `cueloop prompt worker --phase 2`
- `cueloop prompt worker --phase 3`
- `cueloop prompt list`
- `cueloop prompt show worker --raw`
- `cueloop prompt diff worker`
- `cueloop prompt export --all`
- `cueloop prompt sync --dry-run`
- `cueloop prompt sync`

## Runner configuration

CueLoop can use built-in runner IDs (`codex`, `opencode`, `gemini`, `claude`, `cursor`, `kimi`, `pi`) or plugin runner IDs.

One-off usage:

- `cueloop task --runner opencode --model gpt-5.2 "Add tests for X"`
- `cueloop scan --runner gemini --model gemini-3-flash-preview --focus "risk audit"`
- `cueloop task --runner claude --model opus --repo-prompt plan "Add tests for X"`
- `cueloop run one --phases 3`
- `cueloop run one --phases 2`
- `cueloop run one --quick`

Defaults via config:

```json
{
  "version": 2,
  "agent": {
    "runner": "claude",
    "model": "sonnet",
    "phases": 3,
    "iterations": 1,
    "ci_gate": {
      "enabled": true,
      "argv": ["make", "ci"]
    }
  }
}
```

## Three-phase workflow

CueLoop supports a 3-phase workflow by default:

1. **Phase 1 (Planning):** generate a detailed plan and cache it in `.cueloop/cache/plans/<TASK_ID>.md`.
2. **Phase 2 (Implementation + CI):** implement the plan and pass the configured CI gate.
3. **Phase 3 (Code Review + Completion):** review the diff, refine if needed, rerun the CI gate, and complete the task.

Use `cueloop run one --phases 3` for the full workflow. Use `--quick` as shorthand for `--phases 1`.

## Security: safeguard dumps and redaction

When runner operations fail, CueLoop writes safeguard dumps to temp directories for troubleshooting. By default, dumps are redacted before writing.

Raw, non-redacted dumps require explicit opt-in:

```bash
CUELOOP_RAW_DUMP=1 cueloop run one
cueloop run one --debug
```

Security notes:

- Never commit safeguard dumps.
- Debug mode writes raw runner output to `.cueloop/logs/debug.log`.
- Temporary safeguard dumps use CueLoop-owned temp paths; inspect the reported path when troubleshooting.

## Common flags

- `--quick` — shorthand for `--phases 1`.
- `--include-draft` — include draft tasks when selecting work.
- `--runner <codex|opencode|gemini|claude|cursor|kimi|pi>` — override runner.
- `--model <model-id>` — override model.
- `--repo-prompt <tools|plan|off>` / `-rp` — RepoPrompt mode.
- `--git-revert-mode <ask|enabled|disabled>` — control revert behavior on errors.
- `--git-commit-push-on` / `--git-commit-push-off` — toggle auto commit/push.
- `--debug` — capture raw output and imply raw dumps.
- `--force` — bypass locks or overwrite files where supported.
- `-v`, `--verbose` — increase output verbosity.
