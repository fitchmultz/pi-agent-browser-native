---
name: agent-browser
description: Native browser automation in this package goes through the `agent_browser` pi tool, not the legacy bash-backed skill. Use when the task involves opening websites, taking snapshots, clicking, filling forms, scraping, screenshots, UI testing, or other browser automation.
---

# agent-browser

In this package, browser automation should use the native `agent_browser` tool.

## Rules

- Prefer `agent_browser` over bash for browser automation.
- Do **not** call the older bash-based `agent-browser` skill when the native tool is available.
- Pass exact upstream `agent-browser` CLI arguments through the tool's `args` array.
- Use the tool's `stdin` field for commands like `eval --stdin` and `batch`.
- Rely on the implicit session for the common path unless explicit upstream flags like `--session`, `--profile`, or `--cdp` are actually needed.
