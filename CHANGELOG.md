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
- removed the shipped skill override after observing that user-scoped legacy skills can still win precedence; the simpler path is to rely on extension hooks and let users disable the old global skill if needed
- implicit `piab-*` sessions are now best-effort closed on `pi` shutdown and get an idle timeout so abandoned background daemons do not accumulate as easily
- tightened tool guidance so agents avoid falling back to osascript or other generic browser-driving bash commands when the native tool should be used
- taught the tool a clearer browser operating playbook so agents do not need to rediscover core `open` / `snapshot -i` / auth / tab-management patterns from `--help` on routine tasks
