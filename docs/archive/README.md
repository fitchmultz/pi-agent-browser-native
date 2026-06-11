# Archived planning documents

These files are historical planning or superseded contract drafts. They are **not** canonical for current product behavior, package contents, or agent instructions.

Use the active docs instead:

| Current need | Active source |
| --- | --- |
| User setup and common workflows | [`../../README.md`](../../README.md) |
| Runtime design and decisions | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Native tool schema and result contract | [`../TOOL_CONTRACT.md`](../TOOL_CONTRACT.md) |
| Upstream command workflows | [`../COMMAND_REFERENCE.md`](../COMMAND_REFERENCE.md) |
| Release gates and supported upstream baseline | [`../SUPPORT_MATRIX.md`](../SUPPORT_MATRIX.md) |

Archived files:

- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — original implementation planning notes.
- [`native-integration-design.md`](native-integration-design.md) — superseded design draft for native integration.
- [`v1-tool-contract.md`](v1-tool-contract.md) — superseded v1 contract draft; the active contract is [`../TOOL_CONTRACT.md`](../TOOL_CONTRACT.md).

Do not add this directory to `package.json` `files` unless there is a deliberate public product need. Package verification treats these archives as forbidden packed files.
