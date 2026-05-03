# Changelog

## Unreleased

## 0.2.18 - 2026-05-03

### Fixed
- persist oversized parse-failure spill files when Pi provides a session directory without a session file
- isolate the opt-in real-upstream download contract test from the user's global Downloads folder and avoid killing unrelated `agent-browser` processes

### Changed
- clarified the README and repo guidance for the current published package state
- marked the completed implementation plan as superseded so current design guidance stays canonical
- tightened the implicit-session idle-timeout helper to return milliseconds as a number and convert to an environment string only at the process boundary

## 0.2.17 - 2026-05-03

### Fixed
- close the active extension-managed `piab-*` browser session when the originating `pi` process quits, while preserving managed browser continuity across `/reload` and resumable session transitions
- added lifecycle regression coverage for quit-time managed-session cleanup and reload-time preservation

### Changed
- clarified that the managed-session idle timeout is now an abnormal-exit backstop, not the primary cleanup path for normal `pi` exits

## 0.2.16 - 2026-05-02

### Fixed
- made screenshot artifact paths reliable for agent workflows by normalizing explicit screenshot output paths, including dot-directory paths such as `.dogfood/...`, to absolute paths before invoking upstream `agent-browser`
- repaired screenshot outputs from upstream temp files when needed and made the requested path the primary visible artifact path
- extended the screenshot path contract to annotated batch screenshots, so top-level `--annotate` batch calls preserve and verify per-step requested output paths
- blocked per-step batch `--annotate` screenshot forms that upstream parses unsafely and now point agents to the safe top-level `--annotate batch` form
- added wrapper-observed trace/profiler owner guards to prevent known conflicting start/stop sequences from corrupting upstream tracing state

### Changed
- artifact-producing commands now render direct visible artifact metadata, including artifact type, requested path, absolute path, existence, size, status, cwd, session, and temp path when repaired
- explicit `--json` calls now render valid JSON in visible tool content; `stream status` JSON is enriched with `wsUrl` and frame format metadata
- documented the artifact contract, batch annotation guidance, trace/profiler caveat, and package-development bash bypass for upstream debugging

## 0.2.15 - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai` `0.72.0`
- regenerated the npm lockfile against the current stable dependency graph
- aligned pi core peer metadata with current pi package guidance

### Compatibility
- reviewed the pi `0.72.0` changelog and confirmed the extension does not use the removed `compat.reasoningEffortMap` provider shape or depend on the new Xiaomi MiMo/provider base URL behavior


## 0.2.14 - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.71.1`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.71.1` changelog and confirmed the extension is compatible with the current TypeBox 1.x package guidance, session-replacement safety rules, and latest package install/update behavior


## 0.2.13 - 2026-04-30

### Fixed
- improved model-facing redaction across generic output, scalar extraction summaries, diagnostics, console/error previews, and compacted spill files so nested, multiline, and prefixed structured secrets are masked before entering tool content or summaries
- adapted upstream `agent-browser skills get` output for Pi's native `agent_browser` tool by removing bash-oriented allowlist hints and translating quoted and heredoc CLI examples into native tool-call examples
- reduced artifact-retention noise for routine explicit saved files while preserving retention metadata in details, and fixed explicit artifact manifest deduplication for same relative paths in different working directories

### Changed
- documented that oversized spill files contain redacted upstream payloads rather than raw secret-bearing output
- added command-reference guidance for converting upstream standalone CLI examples into native `agent_browser` tool calls

## 0.2.12 - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.70.0`
- migrated published TypeBox integration metadata and source imports from `@sinclair/typebox` to `typebox` for pi `0.69.0` compatibility
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.70.0` changelog and confirmed the extension already follows the current session-replacement guidance while now using the required TypeBox 1.x package name and has no dependency on the changed terminal progress defaults


## 0.2.11 - 2026-04-21

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.68.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.68.0` changelog and confirmed the extension already uses the current named-tool registration model instead of removed cwd-bound tool exports

## 0.2.10 - 2026-04-18

### Changed
- bumped the local pi development baseline to `@mariozechner/pi-coding-agent` `0.67.68` and `typescript` `6.0.3`
- refreshed the release lockfile against the current stable pi patch line

### Fixed
- pinned the transitive `basic-ftp` dependency to `5.3.0` to clear the current audit finding during local verification and publish checks

## 0.2.9 - 2026-04-17

### Fixed
- large non-snapshot outputs such as oversized `eval --stdin` payloads now compact inline content, spill the full payload to a private file, and print the actual spill path directly in tool content instead of dumping huge raw output into model context
- file-save flows now render `download` results as explicit saved-file summaries so agents can see the downloaded path directly
- when a known target tab stays correct at command start but a restored/background tab steals focus after the command completes, the wrapper now best-effort restores the intended tab before returning control
- compact snapshot text now prints the actual raw-spill file path directly instead of only referring agents to `details.fullOutputPath`

### Changed
- added a published `docs/COMMAND_REFERENCE.md` so agents have a repo-readable local command/help surface even when direct `agent-browser` binary usage is blocked
- expanded tool guidance, README, release notes, and repo guidance with download workflows, better `wait` usage, oversized-output handling, and the documentation-sync rule for upstream `agent-browser` updates
- clarified the checkout-versus-installed-package workflow in README, release notes, and repo agent guidance so local development keeps one active Pi package source for this extension at a time instead of treating the published entrypoint file as optional

## 0.2.8 - 2026-04-16

### Fixed
- updated the tab-correction and tab-pinning wrapper paths for `agent-browser` `0.26.0` tab metadata, so profiled launches and follow-up commands now re-select tabs using stable upstream tab ids instead of the retired numeric index shape
- updated tab-list rendering and tool guidance to show `agent-browser`'s stable tab ids/labels instead of suggesting `tab <n>` commands that no longer work in `0.26.0`
- extended the narrow ChatGPT/OpenAI headless user-agent compatibility fallback to cover `chat.com`, so `chat.com` redirects reuse the same authenticated headless path as `chatgpt.com`

## 0.2.7 - 2026-04-16

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.67.4`
- aligned `packageManager` metadata to `npm@10.9.8`, the latest stable npm line compatible with the declared Node runtime floor
- removed the published `@mariozechner/pi-coding-agent` peer dependency so installs rely on pi's bundled runtime instead of npm peer-resolution churn

## 0.2.6 - 2026-04-15

### Changed
- pinned `packageManager` metadata to `npm@11.12.1` so lockfile refreshes resolve consistently during release verification
- refreshed the compatible transitive development dependency resolution pulled by the current pi toolchain without changing the published `agent_browser` runtime contract

## 0.2.5 - 2026-04-14

### Changed
- refreshed the development and release-verification baseline to `@mariozechner/pi-coding-agent` `0.67.2` and `@types/node` `25.6.0`, keeping local typechecking and package verification aligned with the latest stable pi release used for this extension
- re-locked the compatible transitive development dependency set pulled by the updated pi toolchain without changing the published `agent_browser` runtime contract

## 0.2.4 - 2026-04-13

### Fixed
- wrapper-spawned local Unix `agent-browser` runs now use a short private socket directory under `/tmp`, so extension-generated session names no longer fail the upstream Unix socket-path length limit in longer cwd/session-name combinations
- once the wrapper knows which tab a session should stay on, later active-tab commands like `click` and `snapshot -i` now best-effort pin that same tab inside the same upstream invocation instead of letting reconnect drift send the action to a restored/background tab
- persisted `sessionTabTarget` state now survives `/reload` / `/resume` for both managed and explicit sessions, so the reconnect-time tab pinning behavior can continue after restart/resume flows
- README, requirements, architecture notes, and tool-contract docs now describe the socket-path mitigation and the follow-up-command tab-pinning behavior

## 0.2.3 - 2026-04-13

### Fixed
- direct headless local Chrome launches to `chatgpt.com` and `chat.openai.com` now inject a normal Chrome user agent when the caller did not explicitly choose one, keeping authenticated ChatGPT/OpenAI browsing working without forcing `--headed` or `--auto-connect`
- profiled `open` / `goto` / `navigate` calls now best-effort switch back to the page that was just opened when restored profile tabs steal focus during launch, reducing confusing cross-tab drift in profile-backed sessions
- command parsing now treats additional value-taking global flags like `--user-agent`, `--args`, `--allowed-domains`, `--action-policy`, and related launch options as launch metadata instead of accidentally parsing their values as subcommands
- README, requirements, architecture notes, and tool-contract docs now describe the new headless ChatGPT/OpenAI compatibility behavior and the profiled-tab focus recovery path

## 0.2.2 - 2026-04-12

### Fixed
- plain-text inspection commands like `agent_browser --help` and `--version` now stay stateless: they no longer claim the implicit managed session or leave behind ambiguous `parseError` details on success
- extension-managed session ownership is now reconstructed from persisted tool details on resume/reload while still preserving cwd-hash isolation across same-named checkouts and worktrees
- echoed tool updates/details now redact sensitive invocation values and structured secret-bearing fields instead of replaying headers, proxy credentials, cookies, or auth-bearing URL params back into `pi`
- the subprocess wrapper no longer forwards ambient parent-shell `AGENT_BROWSER_*` state into child runs, reducing surprising hidden configuration leaks from the caller environment
- browser-specific system-prompt injection is now minimal and only added for clearly browser-oriented turns, while the full playbook stays in tool metadata where it belongs
- published docs and changelog notes now match the current result/details contract, resume behavior, prompt behavior, and release workflow

## 0.2.1 - 2026-04-12

### Fixed
- the GitHub source trial docs now use `pi --no-extensions -e https://github.com/fitchmultz/pi-agent-browser-native` so published-package users do not hit duplicate `agent_browser` registration conflicts during source-path testing
- successful unnamed `sessionMode: "fresh"` launches now rotate the extension-managed session to the new browser, and later default `sessionMode: "auto"` calls keep following that fresh session instead of silently snapping back to the older one
- mixed-success `batch` failures now preserve per-step rendering, include the first failing step in the visible output and structured details, and still mark the overall tool call as an error so agents can recover from partial progress
- implicit `piab-*` session names now include a stable cwd hash in addition to the `pi` session id so same-named checkouts and worktrees no longer collide onto the same browser session
- value-taking flags like `--session`, `--profile`, `--session-name`, and `--cdp` now fail locally with direct validation errors when the value is missing or replaced by another flag, instead of producing confusing downstream JSON parse failures
- the bash guard now catches wrapped `agent-browser` invocations such as `env agent-browser ...`, `npx --yes agent-browser ...`, `pnpm dlx agent-browser ...`, `yarn dlx agent-browser ...`, `bunx agent-browser ...`, and absolute-path execution, reducing accidental bypasses of the native-tool path

## 0.2.0 - 2026-04-12

### Changed
- `batch` now reuses the richer standalone renderers, so batched snapshots keep the compact main-content-first view and batched screenshots keep inline image attachments instead of degrading to raw JSON-ish text
- the tool schema now uses `sessionMode: "auto" | "fresh"` instead of the old implicit-session boolean so agents have a first-class way to request a fresh profiled/debug launch, and blocked startup-scoped reuse errors now include structured recovery hints
- plain-text inspection commands like `agent_browser --help` and `--version` are now always allowed, removing the old prompt-dependent inspection gate and making the inspection contract local and predictable
- navigation actions like `click`, `dblclick`, `back`, `forward`, and `reload` now include lightweight post-action title/url summaries when the wrapper can address the active session, reducing guess-and-check follow-up snapshots
- compact snapshot rendering is leaner by default: fewer additional sections, fewer refs, smaller role summaries, and the raw spill path now stays in `details.fullOutputPath` instead of dominating the visible snapshot body
- README and tool prompt guidance now include a compact agent quick start with the core call shapes for `open` + `snapshot`, `click` + re-snapshot, `batch`, `eval --stdin`, and fresh profiled launches, while turn-level system-prompt injection stays minimal

### Migration notes
- replace any use of `useActiveSession` with `sessionMode`
- use `sessionMode: "fresh"` when you need a new `--profile`, `--session-name`, or `--cdp` launch after the implicit session is already active

## 0.1.6 - 2026-04-12

### Changed
- hardened the implicit browser-session lifecycle so failed first launches no longer mark the convenience session active, startup-scoped flags behave correctly across launches and closes, and the highest-risk entrypoint paths now have direct automated and isolated-`pi` coverage
- added explicit temp-root ownership markers, aggregate spill-file disk budgeting, inline image size limits, and graceful fallback behavior when large snapshot or stdout artifacts exceed temp budgets
- consolidated the shared browser operating playbook into the tool prompt guidance while keeping turn-level system-prompt injection minimal, and added direct extension-hook coverage for prompt injection, bash blocking, and session resets
- split the old result-rendering god module into focused envelope, presentation, shared, and snapshot modules, and made snapshot compaction fall back to a resilient outline mode when upstream raw snapshot formatting is unfamiliar
- refactored the release-package verification script into smaller testable helpers, preserved the retired autoload-shim guard, and aligned the tarball gate with the split result-rendering module layout

## 0.1.5 - 2026-04-12

### Changed
- pinned the transitive `basic-ftp` dependency to `5.2.2` via `overrides` so local development and GitHub install flows no longer pull the vulnerable `5.2.1` version through `@mariozechner/pi-coding-agent`
- kept the 0.1.4 startup fix and metadata updates intact while clearing the audit failure that surfaced during release verification

## 0.1.4 - 2026-04-12

### Changed
- removed the tracked repo-local `.pi/extensions/agent-browser.ts` autoload shim because it conflicts with the globally installed package and blocks `pi` startup from this repository root
- local checkout validation now uses explicit CLI loading with `pi --no-extensions -e .` instead of repo-local `.pi/extensions/` auto-discovery
- aligned the package description and keywords with the GitHub repository metadata used for your other public `pi` extensions

## 0.1.3 - 2026-04-12

### Changed
- when `BRAVE_API_KEY` is present and non-empty, the extension now tells agents to prefer the Brave Search API via `bash`/`curl` for URL discovery and then open the chosen destination with `agent_browser` instead of driving a search engine results page in the browser
- when `BRAVE_API_KEY` is absent, the extension behavior remains unchanged
- added a small runtime helper and unit coverage for the `BRAVE_API_KEY` gate so the change stays explicit and minimal

## 0.1.2 - 2026-04-11

### Changed
- renamed the public GitHub repository to `pi-agent-browser-native` so the repo name, npm package name, install docs, and package metadata all align
- updated package metadata and install guidance to use the new GitHub source path `https://github.com/fitchmultz/pi-agent-browser-native`
- switched the local global pi install from the repo checkout path to the published npm package `pi-agent-browser-native`

## 0.1.1 - 2026-04-11

### Changed
- startup-scoped flags like `--profile`, `--session-name`, and `--cdp` now fail clearly when reused against an already-active implicit session instead of silently relying on upstream to ignore them
- prompt-based bash/help allowances are now derived from the current user prompt instead of mutable extension-global booleans, and the inspection allowance only triggers for tool-specific requests
- oversized subprocess stdout is now bounded in memory and spilled to private temp files before JSON parsing, reducing unbounded buffering risk without breaking large snapshot handling
- snapshot spill files now live under private temp directories with restrictive permissions and are cleaned up on shutdown
- failed upstream envelopes now synthesize clearer fallback error text when no simple top-level `error` string is present
- package/release verification now has a documented maintainer workflow, a tarball verifier script, a tracked repo-local `.pi` development shim, and a published tarball that excludes agent-only or superseded docs while including `LICENSE`
- npm publish prep now uses the available package name `pi-agent-browser-native`, adds author and gallery-friendly keywords, and updates README install guidance to show npm first and GitHub second

## 0.1.0 - 2026-04-09

### Added
- initial package scaffold for `pi-agent-browser`
- native `agent_browser` extension tool that wraps upstream `agent-browser --json`
- thin implicit-session support for the common path
- lightweight extension-level guards to keep direct bash `agent-browser` usage from becoming the primary path
- plain-text fallback for native `agent_browser --help` and `--version` inspection
- support for observed `batch --json` array output
- local TypeScript typecheck and unit-test setup
- concise product and implementation docs

### Changed
- removed the shipped skill override; extension hooks are the primary mechanism for preferring the native tool
- implicit `piab-*` sessions are now best-effort closed on `pi` shutdown and get an idle timeout so abandoned background daemons do not accumulate as easily
- tightened tool guidance so agents avoid falling back to osascript or other generic browser-driving bash commands when the native tool should be used
- taught the tool a clearer browser operating playbook so agents do not need to rediscover core `open` / `snapshot -i` / auth / tab-management patterns from `--help` on routine tasks
- refined the authenticated-content playbook to prefer `--profile Default` on the first browser call while reusing the extension-managed implicit session for normal personal feeds/dashboards; this avoids stale cross-run browser state from fixed explicit session names
- refined read-only browsing guidance so agents prefer extracting from the current snapshot, ref labels, or page-state eval before navigating away, and clarified that extraction evals should return values instead of relying on `console.log`
- generalized recovery guidance so unexpected `open` failures now point agents to inspect and recover tab/session state before retrying alternate URLs or fallback strategies
- improved native error presentation so upstream JSON error messages are shown to the agent instead of a generic `agent-browser exited with code 1.` when the CLI already reported a specific failure
- oversized `snapshot -i` results now switch to a browser-aware compact view for the model and spill the full raw snapshot JSON to a temp file referenced from tool details instead of always inlining the full snapshot tree
- refined compact snapshots to be main-content-first: prefer the primary content block and nearby sections over top-of-page chrome, ads, and unrelated sidebars when the snapshot structure makes that distinction possible
