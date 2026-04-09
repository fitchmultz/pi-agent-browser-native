# Changelog

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
