# Changelog

## Unreleased

## 0.5.0 - 2026-08-20

### Added

- Added Android 17/arm64 Termux runtime support while keeping the integration thin against `agent-browser` 0.34.0. Wrapper-owned sockets now use the private `/data/data/<package>/piab` sandbox instead of inaccessible `/tmp`, policy-lock coordination follows `os.tmpdir()`, and process identity probes use Termux's `ps` beside Node. The documented setup uses the packaged Linux-musl arm64 binary plus Termux system Chromium, `which`, and ffmpeg; upstream Android npm launcher support remains tracked in [vercel-labs/agent-browser#1587](https://github.com/vercel-labs/agent-browser/issues/1587).
- Preserved managed-session restore and isolated `script` workflows on Android. App-sandbox ancestry is validated without weakening other POSIX trust rules, checkout identity uses stable device/inode evidence plus the generation UUID when Node reports mutable ctime as birth time, and generation-marker publication uses exclusive creation because Android app storage rejects hard links.

### Changed

- Android wrapper-managed identities use a compact 80-bit digest so ordinary namespaces and fresh rotations remain within upstream's 103-byte Unix socket limit. Desktop session naming is unchanged.
- Platform-sensitive tests now account for Android's filesystem restrictions, Termux executable layout, and thermally constrained single-process startup timing without loosening desktop budgets.

### Validation

- Passed `npm run verify -- pre-pr` (784 tests, 781 pass, 3 opt-in skips; 130 packed files), `npm run verify -- real-upstream` (2/2), deterministic dogfood, doctor, typecheck, docs, and live command-reference verification. Android live evidence covered managed restore, namespaced fresh sessions, exact-session restart/reuse, isolated `script`, QA, jobs, semantic actions, screenshots, WebM recording, and cleanup with no remaining browser, Chromium, tmux, socket, or test-artifact leaks.
- The isolated configured-source lifecycle harness was environment-blocked by its missing Zai API key; the equivalent authenticated exact-session restart and reuse path passed manually. The Crabbox macOS/Ubuntu/native-Windows release matrix was not rerun for this Android-only GitHub release. npm was not published.

## 0.4.5 - 2026-08-18

### Fixed

- Cut agent round trips on scraping and recovery paths. A failed non-batch `eval`, `back`, `forward`, `reload`, `connect`, `state load`, or `tab` selection now re-probes the live page URL itself: an observed http(s) page stays verified instead of forcing a manual `get url` before the next read, a file page stays gated, and a failed probe keeps the prior unverified-page behavior. Because a failed transition can still have mutated the document, a successful probe also invalidates the prior page-scoped refs (matching the old unknown-target behavior), and transcript replay preserves the invalidation summary.
- Navigation-summary probes reuse the title already observed for an unchanged URL and skip `about:blank`, halving probe cost on non-navigating clicks. URLs remain live-probed on every call.
- `wait --url` timeouts (including compiled `job.assertUrl`) now append `fresh-session-after-url-wait-timeout`: an actionable fresh-session recovery (`open about:blank`, then replace with the target URL and replay as one batch) for silently missed upstream click dispatch, ranked after the inspect action. Fresh-session follow-ups are no longer silently downgraded to reuse the current session by a `--session` prefix.

### Changed

- Compact snapshots promote named action links (row/navigation links such as comment counts, docs sidebar links, and repository-style result links) to first-class high-value controls, so dense-page click targets surface inline instead of only in the spill file.

### Validation

- Passed `npm run verify -- pre-pr` (781 tests, 779 pass, 2 opt-in skips) plus four-seat exact-head review across three waves. Extension-vs-CLI dogfood reruns: HN research flow matched CLI parity (5 calls, 0 failures), Sauce Demo checkout completed with 0 silent no-ops, react.dev navigation unchanged at CLI-parity call count. npm was not published.

## 0.4.4 - 2026-08-18

### Fixed

- Observed the live tab URL after href-less CSS-selector clicks. Upstream never emits `href` for those clicks, so the wrapper skipped the post-command `get url` / `get title` helper and left `sessionTabTarget` on the pre-click page. Login and SPA clicks now report the page the browser is actually on.
- Stopped dumping the raw upstream envelope, internal `lifecycle` block included, when a page title is empty, when `eval` returns an object, array, `null`, `undefined`, or `''`, or when a command has no dedicated presenter. Structured eval results render as JSON; empty strings and nulls are stated plainly; leftover lifecycle-only results say `<command> completed`.

### Changed

- Documented an upstream `agent-browser` 0.34.0 site-specific click-dispatch miss on Sauce Demo under sustained per-command spacing, and the `batch` mitigation.

### Validation

- Passed `npm run verify -- pre-pr` (777 tests, 775 pass, 2 opt-in skips) on the presentation commits. Live dogfood re-checked the four presentation/session fixes against example.com, IANA, httpbingo, react.dev, Hacker News, and Sauce Demo login; wrapper was never worse than the raw CLI on matched-cwd open/eval/box. Full Crabbox matrix and npm publish were not run.

## 0.4.3 - 2026-08-17

### Fixed

- Preserved profiled and other launch-configured browser sessions across native tool calls. The wrapper no longer sends an empty `--args` launch override on every local subprocess because `agent-browser 0.34.0` treats that value as a new launch configuration and replaces a profiled browser with `about:blank`. The protected empty config, cleared raw-args environment, explicit `--allow-file-access false`, and existing raw-argument validation continue to enforce the local-file boundary. Local-file navigation is limited to wrapper-managed local browsers so caller-owned or attached browsers with unknown file-access launch provenance cannot reach it; the wrapper sends its fixed compatibility user agent only when launching or relaunching a browser, not on active follow-ups. Caller `--args` and `--user-agent` are now launch-scoped and require `sessionMode: "fresh"` once the managed session is active.

## 0.4.2 - 2026-08-13

### Changed

- Rebaselined the command/help inventory and package docs to `agent-browser 0.34.0` / vercel-labs/agent-browser@548b159b30eef119ccf6846c8bc807d0eaa3f6f8. Browser-backed calls now require that exact runtime. `--pin-tab` / `--no-pin-tab` (`AGENT_BROWSER_PIN_TAB`) are sticky optional global booleans, not launch-scoped, so they can enable or disable strict tab binding on an already-live session. Shared `--cdp` / `--auto-connect` sessions that lose their bound tab fail as `failureCategory: "tab-gone"` with `list-tabs-after-tab-gone` and `open-tab-after-tab-gone` next actions. `tab list` presentation includes each tab's CDP `targetId` when upstream reports one, and those ids are accepted as tab refs.

### Validation

- Passed `npm run verify -- pre-pr` (768 tests passed, two opt-in skips; 130 packed files), `npm run verify -- real-upstream` (2/2), deterministic dogfood, `npm run doctor`, and isolated checkout tmux smoke on example.com. Full release composition was not rerun.

## 0.4.1 - 2026-08-10

### Fixed

- The page-scoped stale-ref preflight and the intra-batch ref-invalidation latch now scan the batch steps upstream actually executes via shared `getUpstreamEffectiveBatchSteps` (raw batch argument strings exclusively when any exist, stdin steps only otherwise): raw argument-mode batches such as `batch "click @e1"` are guarded after a recording page swap, raw-argv `record start` steps latch later ref reuse in the same batch, and stdin refs are no longer falsely rejected when upstream would ignore that stdin because raw arguments exist. That same upstream-effective selection now also drives the tab-pinned batch rewrite (`buildPinnedBatchPlan` dispatches raw argument steps instead of resurrecting ignored caller stdin the guard never scanned, closing a fail-open pinned-batch stale-ref path and no longer silently dropping the caller's raw steps), the artifact/recording lifecycle preflight (`getArtifactCommandSteps`), batch screenshot path preparation (no parent directories for upstream-ignored stdin rows), and stale-ref echo args; raw-argument filtering matches upstream exactly (`--bail` token only, so `--bail=true` stays a raw command and keeps stdin ignored). The pinned rewrite also re-emits the caller's exact `--bail` token (argv or stdin/`job`/`qa` mode), so a validated fail-fast batch no longer executes continue-on-error under tab pinning, and parent directories are now prepared for effective raw batch artifact rows (without rewriting raw strings; screenshot absolute-path normalization stays stdin-only). The pre-spawn state-policy validator keeps unioning parseable stdin alongside argv as a deliberate fail-closed content superset with the same exact-`--bail` raw-token filtering, and treats stdin parse failures as fatal only when upstream would actually read stdin. Regressions in [`test/agent-browser.extension-ref-guards.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-ref-guards.test.ts).

### Added

- Browser-backed calls now require the exact targeted `agent-browser 0.33.2` runtime before launch, with cached cwd/PATH validation and expected/observed mismatch details. Plain help/version, close recovery, and sessionless local setup/diagnostics remain available.
- `semanticAction` native select now resolves active-session role/name combobox/listbox and label locators to exactly one current visible ref before invoking upstream `select`.

### Changed

- Authenticated unattended/auto-approved employee flows may complete ordinary requested non-destructive submissions without a blanket stop; purchases, production control, destructive/irreversible actions, and account/security/privacy changes still require explicit authorization.
- Passive project/user upstream config files are ignored under the wrapper's protected empty config; explicit `--config` and `AGENT_BROWSER_CONFIG` overrides remain incompatible with browser-backed native calls.
- Flattened the Electron launch schema while retaining runtime exactly-one-target validation, and skipped duplicate platform-smoke dependency installs after a successful platform-build suite.

### Fixed

- Electron `launchId` probes retain the tracked launch namespace, and cleanup replay retires the exact namespaced managed session, attached marker, and allowed-domain policy instead of probing or resurrecting a default-namespace peer.
- Same-millisecond recording artifacts preserve their emitted lifecycle order through both inner and concurrent outer manifest merges, so a later stop stays terminal and a restarted recording remains pending even with a one-entry recent window; `record start` now warns that upstream switches to a fresh active page whose in-page state does not carry over and invalidates the session's prior page-scoped refs (direct and batch) on every executed attempt — upstream swaps the page before its already-active check, so failed starts count — and `record restart` with a URL operand invalidates the same way while a plain restart keeps refs, so stale `@e…` refs fail as `stale-ref` until a fresh snapshot; upstream ref-resolving reads and captures (`is`, `screenshot`, `highlight`, `scroll`, `frame`, `diff`) now pass the same stale-ref guards as mutations while literal `@e…`-looking operands (`wait --text`, `find text …`, values of value-taking flags such as `--baseline`) stay unguarded, refs after boolean flags (`click --new-tab @e1`, `screenshot --full @e1`) stay guarded, and a timed-out or row-less batch whose planned steps include a recording page swap still records the ref invalidation from upstream's exclusive raw-argument-else-stdin step source; namespace-exclusive close-all queues its drains before yielding so late same-session arrivals cannot deadlock or overlap it.
- Failed first-call batches that close then relaunch remain tracked for cleanup, and namespace-scoped `close --all` exclusively drains matching session work before retiring every managed, attached, page/ref, route, trace/profiler, and recording owner.
- Tolerated pre-upgrade transcript rows whose managed restore identity list is absent instead of throwing during branch rehydration (contributed by [@coreyallen](https://github.com/coreyallen) in [#96](https://github.com/fitchmultz/pi-agent-browser-native/pull/96)).
- Included `scripts/build.mjs` in the published package contract so source installs can run `prepare` successfully (contributed by [@selimerunkut](https://github.com/selimerunkut) in [#100](https://github.com/fitchmultz/pi-agent-browser-native/pull/100)).
- Scoped managed restore keys to both checkout generation and the full hashed Pi transcript id. Upstream 0.33.2 loads the newest `<key>-*.json` file regardless of browser-session suffix, so the former checkout-wide key let concurrent Pi chats overwrite or inherit each other's cookies/storage. Fresh rotations, reload, restart, and `/resume` of one transcript retain a private restore pool. The new managed name intentionally starts a fresh pool after upgrading; manually close any pre-0.4.1 headed session that remains open because headed daemons are exempt from idle shutdown.
- URL QA clears diagnostics, snapshots and subtracts only unchanged post-clear page-error residue because upstream clear is unreliable, and adds a bounded 150 ms post-load diagnostic settle so immediate timer-driven console/page errors are observed. A matching error that reappears after a successful clear fails correctly.
- Artifact verification rejects clearly old or future-dated output paths outside a bounded command window as `status: "stale"`, tolerates coarse filesystem mtimes, and rejects canonical, symlink-, hardlink-, full Unicode-fold-, or macOS/Windows case-aliased duplicate destinations in stdin and argument-mode batches. Missing/stale recordings finalized by `record restart` retire prior pending manifest state; an unbounded transcript-backed canonical namespace/session reservation index, serialized independently of the bounded artifact manifest, blocks concurrent reuse through lexical, existing/dangling symlink, hardlink, and platform-case aliases until any successful direct, replacement, script, Electron, or shutdown close retires the exact identity. Explicit `wait --download <path>` / `wait -d <path>` in any upstream-accepted position, path-bearing `network har stop [path]`, the final effective `diff screenshot -o|--output`, and normalized `outputPath` writes (including script and Electron host results) use the same serialized reservation preflight; unsupported `wait --download=<path>` fails clearly. Artifact/lifecycle parsing mirrors upstream full-argv global cleanup, wait-mode precedence, and screenshot exact-flag, selector-prefix, case-sensitive extension, slash-path, and positional semantics, and Electron cleanup validates output before retiring reservations, so interspersed flags, repeated timeouts, flag-looking screenshot paths, extra positionals, or cleanup ordering cannot bypass a live path; known same-call output/artifact aliases fail before browser activity. Terminal tombstones persist onto the current branch during reload, and ordered nested-batch lifecycle handling retires or reactivates the exact namespace/session, keeps a close terminal when later diagnostics explicitly report that they did not launch a browser, treats every later lifecycle-proven launch—including failed rows and post-close `record stop`—as active, persists bounded failed-step launch evidence for replay, clears wrapper trace/profiler ownership at every successful direct or nested close before later successful rows can rebuild it, clears only terminal attachment state, resets pre-close ref/page/route state before applying later rows and suppresses stale pre-close `about:blank` recovery after reactivation, reconciles abandoned aggregate artifacts/verification/actions without retaining an intermediate close-abandoned duplicate after a later saved stop, and records a true closed managed-session outcome, so neither an older branch nor transcript replay can resurrect pending state. Only the newest pending path remains authoritative per namespace/session. Legacy batch replay retires it only when ordered lifecycle leaves recording closed; a later successful browser reactivation plus recording start keeps the new reservation, and malformed manifest rows are ignored instead of reaching identity/path folding. Recording starts/restarts after a nested close are rejected because upstream can report success without starting one, and a definitive `No recording in progress` stop failure, direct or nested in a batch, retires stale state at that ordered step while allowing a later successful recording row to open a new path. Any intervening same-session failure retains exact `stop-pending-recording` recovery alongside its normal actions. Batched recordings coalesce pending rows into terminal outcomes, and every result that leaves a recording pending includes an exact `stop-pending-recording` action. Observational `wait --download` still accepts a file that completed just before waiting began.
- Same-page freshness checks cover batched getter refs after rerenders, preventing recycled refs from silently reading different controls.
- Large fallback scrolls with no viewport/container movement now fail as `upstream-error`, set structured and visible `scrolled: false` / `noMovement: true`, and return exact inspection actions instead of claiming success.
- Root-run Pi hosts can select a private wrapper socket directory with `PI_AGENT_BROWSER_SOCKET_DIR`; validation now reports the concrete permission/ownership/path-budget cause, trusts sticky root ancestry for uid 0, and fails overlong Unix launch paths before spawn with short-root remediation. Ambient upstream socket overrides remain ignored.
- Native-Windows command-first adaptation preserves multi-token subcommands while safely omitting wrapper-owned empty namespace/raw-args argv values that PowerShell `.cmd` forwarding drops.
- Script leases always run fail-closed cleanup because preparation helpers may start the isolated browser before the main subprocess; click-dispatch verification avoids a redundant cleanup eval after its check already removed the probe.
- Documented macOS copied-profile encrypted-cookie limits and compatible managed-restore behavior without claiming profile selection proves authentication.

### Validation

- Passed `npm run verify -- pre-pr` (761 tests passed, two opt-in skips; 130 packed files), `npm run verify -- real-upstream` (2/2), deterministic real-browser dogfood, packaged Pi smoke, five-sample startup profiling (67.7 ms median, 74.1 ms maximum; below the 250 ms budget), Ubuntu Crabbox `platform-build` plus `browser-dogfood-smoke`, and rebuilt-checkout interactive tmux missions. Full release composition remained environment-blocked by isolated lifecycle model credentials, the macOS SSH probe, and unavailable Parallels `prlctl`; no npm publish is authorized.

## 0.4.0 - 2026-08-07

### Added

- Added top-level one-shot `script` code mode for loops, conditional page branches, and multi-page aggregation. Sandboxed source uses async `browser({ args, stdin?, timeoutMs? })` plus `emit(value)`, while the parent serializes at most 25 calls through the complete ordinary native-tool executor and returns one bounded JSON value.
- Added a permissioned separate Node child, 64 MiB heap ceiling, disabled VM string/WebAssembly code generation, empty environment, null-prototype task functions, JSON-only bounded IPC, 64 KiB source/output caps, a 120-second default/300-second maximum deadline, cascade abort, and shutdown child reaping.
- Added unique restore-disabled `piab-script-<uuid>` browser isolation, strict model-invisible persisted cleanup leases before first spawn, finally-close, exact active-branch restart recovery, and cleanup-failure details/actions. Script mode fails closed under Pi `--no-session` and deliberately has no profile/attachment/session-control, host API/import, reusable name, registry, or persistent workflow-state surface. Uncaught source exceptions report `script-error`; compact output confirms successful cleanup and distinguishes successful, failed-envelope, and pre-dispatch-rejected inner calls.

### Changed

- Common browser actions, waits, close/tab-close, getter scalars, and diagnostic-buffer resets now render concise useful fields instead of lifecycle-heavy raw JSON. Failed QA presets show a bounded failure/check summary while retaining the full diagnostic matrix in `details.qaPreset` and `details.batchSteps`.
- Failure `details.nextActions` are now mirrored into model-visible output with exact redacted payloads. Generic wait/operation timeouts and navigation-shaped upstream errors add bounded snapshot inspection actions, with text assertions retaining their specific recovery id.
- Raw `batch` stdin shape errors now include a copyable native-tool example. Empty generated semantic role names are treated as omitted. Close cleanup guidance appears only when existing explicit artifacts remain; wrapper-managed spills no longer trigger host cleanup prose.

### Fixed

- Script helpers and cleanup now case-insensitively clear ambient upstream launch/profile/restore/attachment and proxy controls before reapplying wrapper-owned isolation values, so mixed-case Windows environment aliases or shell defaults cannot redirect a supposedly isolated run.
- Final script data is compact-serialized and post-redaction byte/depth checked before presentation, preventing small deeply nested JSON from expanding into megabytes of prose or throwing during result assembly.
- Pi branch changes now abort active scripts and await normal isolated-session cleanup before branch restoration. Missing compiled workers and malformed `browser()` / `emit()` calls return actionable structured failures, script call counters no longer overlap pre-dispatch rejections with dispatched failures, and verified-spill rehydration reserves IPC headroom with bounded summary/text plus a complete serialized-envelope guard.
- Pi call rendering now shows a bounded terminal-safe `script` source preview with visible `↵` line-break markers while collapsed and the full terminal-safe source when expanded; ANSI/OSC payload matching cannot cross JavaScript line terminators, which remain visible newlines, and removed controls are marked visibly so approval does not hide executable lines. Generic browser recovery `nextActions` now preserve the exact originating namespace, including explicit empty namespace overrides, plus the named/managed session. Script-visible next actions strip their wrapper-owned isolated identity and are revalidated before exposure; unsupported suggestions are omitted.

### Validation

- Added focused script schema, sandbox-escape, quota, abort/timeout, child-shutdown/tree-change, ambient-environment isolation, inner-policy, unique-session, durable-lease, cleanup-failure/restart, spill-rehydration/headroom, full-executor, bounded deep-output, malformed bridge-call, missing-worker, no-session, expanded-source-rendering, and session-scoped-recovery tests, plus regression coverage for compact presentation and recovery guidance.

## 0.3.0 - 2026-08-06

### Changed

- Raised the minimum supported Pi runtime to 0.84.0 with no compatibility shims for older Pi releases, bumped the package from 0.2.x to 0.3.0 for the breaking support-floor change, pinned direct Pi development dependencies and the fleet marker to 0.84.0, and retained optional wildcard Pi peer dependencies per Pi package guidance.
- Audited the extension factory, native tool registration, schemas, Pi `tool_result` patching, TUI rendering, SDK/package harnesses, browser/session/profile lifecycle, artifacts, lookups, Electron paths, build/package scripts, docs, fixtures, and tests against all Pi 0.84.0 breaking changes. The package does not consume the renamed model transform, RPC delta accumulator, provider header/refresh/auth APIs, pi-agent-core harness repositories or custom filesystem, or remote-session summary APIs; the existing coding-agent `ModelRuntime`, `createAgentSession`, `SessionManager`, extension, and tool contracts remain valid on 0.84.0.
- Added Pi 0.84.0's `scrollbarThumb` background color to the complete test theme fixture and refreshed the lockfile against the released 0.84.0 packages and TypeBox 1.3.7.
- Updated the `protobufjs` safety override to 7.6.5, clearing the advisory carried by the previous 7.6.4 pin.

### Fixed

- Result `outputPath` writes now fail validation instead of overwriting a screenshot, download, recording, or other browser artifact when both destinations resolve to the same file; the browser artifact and its verified metadata remain intact, including through filesystem aliases such as hard links.

- Headed wrapper-managed launches now disable upstream periodic restore autosave by default and retain that launch environment across every follow-up subprocess, including still-owned off-current sessions, transcript-restored sessions whose replacement cleanup failed, and Electron cleanup closes, preventing agent-browser 0.33.2's multi-origin storage collector from flashing temporary tabs, blocking daemon policy probes, or triggering daemon-configuration mismatches; native close still saves, while direct window close can lose newer state because headed browsers are exempt from idle shutdown. The effective launch-time interval, including an explicit `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS`, is persisted across transcript resume; changing it in either direction on a running wrapper-owned headed session is rejected until close plus a fresh launch. Slow valid daemon inspections now receive the full 35-second policy budget instead of failing after five seconds.
- `--headed` and `--headed false` are now enforced as launch-scoped choices instead of being silently sent to an already-running managed session.
- Bare, review-only, fenced-reference, conditional, permissive/uncertain, directly negated, and Pi clipboard/attachment image/video paths no longer become requested output artifacts that block browser close; output enforcement now requires a direct artifact-creation phrase with a destination, carries that intent across contiguous plain or Markdown path-list lines, handles delimited paths, preserves subordinate requirements such as “do not close until you save,” scopes availability-qualified recordings before, within, or after their list, leaves explicitly optional artifacts unenforced, applies recording availability per path clause, makes required duplicate paths take precedence, handles Markdown-link destinations, scans single-line and multiline path lists once instead of once per path, and avoids pathological backtracking on slash-heavy non-path text.

## 0.2.78 - 2026-08-04

### Changed

- Removed zero-behavior maintainer bloat: Purpose/Responsibilities file banners, barrel-only `lib/results.ts` and `lib/input-modes.ts` facades, the synthetic efficiency benchmark script/tests/verify mode, the completed Electron plan ADR, and the `AgentBrowserNextActionCollector` class (plain array helpers remain).
- Folded tiny one-liner modules (`session-artifacts`, `artifact-state`, `electron/text`) into neighboring owners; pending-recording predicates live in `artifact-manifest.ts`.
- Trimmed docs that only existed to index or advertise the removed surfaces (`AGENTS.md`, `RELEASE.md`, `SUPPORT_MATRIX.md`, `ARCHITECTURE.md`, `ELECTRON.md`, `TOOL_CONTRACT.md`, `COMMAND_REFERENCE.md`, README).

## 0.2.77 - 2026-08-04

### Fixed

- Successful `connect`, `--cdp`, and `--auto-connect` sessions, including environment-configured and wrapper-launched Electron attachments, now keep their attached browser across native-tool follow-ups and cleanup instead of resending local-launch defaults that made upstream replace the connection and prompt again. Content-bearing first use is blocked until the attachment URL is verified, established attachments live-check `get url` before later page reads or interactions so external tab drift cannot expose a local target, and every child clears the file-access environment override even when attached reuse omits the canonical launch flags.

## 0.2.76 - 2026-08-04

### Fixed

- Wrapper-managed compatibility sessions now pin the normal Chrome user agent at browser launch as well as on the active page. New tabs and SSO popups therefore inherit it instead of reverting to `HeadlessChrome` and falling back into Cloudflare Turnstile, while caller-selected raw-argument, headed, attached, provider, custom-UA, and non-Chrome modes remain untouched.

## 0.2.75 - 2026-08-04

### Fixed

- Headless `dash.cloudflare.com` now uses the same normal-Chrome user-agent compatibility path as OpenAI web properties, bypassing the Turnstile loop caused by `HeadlessChrome`. Wrapper-managed sessions retain that wrapper-owned user agent across follow-up calls and Pi reload/resume while preserving checkout-managed authentication restore.

## 0.2.74 - 2026-08-03

### Changed

- Rebaselined the command/help inventory and package docs to `agent-browser 0.33.2` / vercel-labs/agent-browser@93cdda5709e8861c0c26b0b955d8d746e9fda0d7 (0.33.1 daemon idle timeout + tab recovery; 0.33.2 stream quality/size envs and latest-wins streaming).
- Wrapper-owned managed sessions now set a Git-checkout-generation-stable `AGENT_BROWSER_RESTORE` key so SSO cookies/localStorage/sessionStorage survive browser relaunches across Pi chats in the same checkout generation. The wrapper combines checkout-root and Git-admin filesystem identities with a UUID in the Git admin directory, keeps the key across checkout renames, changes it on copied/replaced checkouts, and fails closed outside Git instead of adopting older cwd-only keys. Restore is ownership-gated, and `piab-*` live-session names are reserved for the extension instance that owns them, sticky-disabled after incompatible launches/config (profiles, CDP/providers, extensions/init scripts/raw args/plugins, and related browser mutation), and opt-out with `PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE=0`. Any upstream config discovered while planning blocks browser-backed native calls without being read by the Pi host, while accepted browser-backed subprocesses, including wrapper-owned closes, pin a process-private empty config (`0400` on POSIX) in the marked secure-temp lifecycle to prevent later config creation from changing the receiving browser while preserving PID/start-identity abnormal-exit stale cleanup on POSIX and native Windows while treating legacy Windows identity formats conservatively; ownership marker schema v2 makes older readers ignore new Windows identity records. A user-private immutable ticket-claim lock with PID/start-identity dead-claim/artifact recovery and a fail-closed pre-update v2 bridge serializes cross-process daemon inspection through spawn (its post-v0.2.74 removal is tracked in [#93](https://github.com/fitchmultz/pi-agent-browser-native/issues/93)), failed fresh starts are probed and retained for shutdown cleanup when live or uninspectable, and the wrapper canonicalizes and pins namespace identity (including default-namespace closes and replayable Electron probe state), canonicalizes wrapper-owned close argv so caller config/restore globals cannot redirect saved auth, keeps close from injecting a replacement checkout's restore key into a live daemon while recording returned old-generation snapshots against the observed wrapper key, rejects nested batch attachment, inspects live same-name daemons before incompatible reuse, prevents already-aborted calls from spawning, canonicalizes and pins trusted home roots after caller env merging, rejects writable/unowned POSIX ancestry without silently chmod-tightening it, rejects symlinks through the POSIX state path and `.tmp` write area, enforces owner-only mode `0700`, persists close-proven snapshot ownership as atomic per-key records across Pi restarts, converges concurrent close records without a blocking pruning lock, self-heals malformed regular records, expires wrapper-created snapshots older than 30 days while retaining two fallbacks, and caps young churn at 256 records per restore key, redacts `state show` cookie/storage values, and fails closed when storage is unsafe or an encryption key is malformed; Windows requires a 64-character hex `AGENT_BROWSER_ENCRYPTION_KEY`. An already-live daemon using an older cwd-only restore key must be closed before reuse; the wrapper now refuses to attach when the live same-name daemon's key does not match the checkout generation.
- Closed final review gaps by re-inspecting every same-identity daemon under the policy lock and requiring current-process provenance before reusing a restore-disabled daemon, cleaning Electron processes/profiles after any post-launch prepare failure, using a strict native-Windows command-first global scanner that preserves valued `--restore` semantics through `--restore=<name>`, exact lowercase optional booleans, and invalid-input failure behavior, falling back from `/bin/ps` to `/usr/bin/ps`, repeating checkout/storage/state-access validation after all async setup immediately before spawn, splitting real-upstream verification into force-exiting fail-fast phases, keeping npm's local dependency bin directory from shadowing the host Pi in lifecycle verification, applying managed restore policy to every Electron status/probe subprocess, retaining restore-disabled daemon provenance across same-process branch changes, and making filtered state-list summaries count only caller-visible rows.
- Final merge review also made Electron host launch cancellation no-spawn/cleanup-safe, decoupled managed daemon inspection from shorter caller watchdog overrides, recorded null daemon policy for owned restore-disabled helper starts, classified all-failed Electron probes as upstream errors, reserved managed session names case-insensitively, split daemon policy and managed-list filtering into focused modules, and hardened local boundaries. POSIX daemon socket storage now rejects rather than repairs pre-existing unsafe modes, validates trusted ancestry and planted entries, and uses the canonical macOS temp path. Browser access to `.agent-browser` state is blocked through command-specific input/output operands (including dash-prefixed global and positional paths), every path-bearing upstream environment mirror (state/profile/config, executable/extension/init-script, action-policy, artifact, skills, and socket paths), encoded/nested-file-scheme/Windows-aliased/symlinked paths (including nonexistent descendants), protected top-level `outputPath`, content-returning local URLs, local-page follow-ups, recursively inspected raw batch command strings, and persisted unverified top-level or batch tab/attachment/script/state-load transitions; Electron snapshot/tabs handoff, probes, and later capture share the boundary; handoff/probes verify the live URL before tab/title/content helpers, and handoff failure or cancellation cleans the managed session plus host process/profile. Raw artifact destinations are checked before directory creation with the same screenshot-path parser used by preparation. Enabled file-access argv/env and file-access-enabling or protected-path raw Chrome values are rejected, while every upstream spawn clears raw-args env, strips caller file-access occurrences, and adds canonical `--args "" --allow-file-access false` defaults so project/user config cannot re-enable local access. Post-transition navigation summaries, including forced live probes after arbitrary `eval`, and timeout diagnostics verify `get url` before reading title and fail when an implicit transition lands on a local file page. Failed or unexecuted navigation stays unverified, stale concurrent completions serialize authoritative state only, and replay gives unknown state precedence over inconsistent stale fields. While a target is unverified, `tab list` and non-content `tab <id>` selection remain available, but page reads still require `get url` to verify the selected target.
- Final security review now live-verifies the active URL before content-bearing calls against caller-owned explicit sessions, including sessions restored from stale transcript page state, and fails closed when that probe cannot prove a safe target. Protected-path detection treats Windows drive-relative forms such as `C:.agent-browser\\state\\...` as filesystem paths, nested `batch` steps are rejected instead of being interpreted recursively, and raw batch command strings mirror upstream's ASCII-space tokenizer, including its quote/backslash handling, rather than splitting on other Unicode whitespace.
- Final reviewer remediation models continued execution after failed non-bail batch navigation and blocks later content when any retained page could be local or unverified; exact `batch --bail` and already-safe diagnostic continuation remain available. Non-bail state exploration is capped and fails closed to `--bail` guidance instead of growing without bound. Caller-owned explicit-session calls are serialized per effective canonical namespace/session inside one extension instance, including CLI/environment namespace aliases from live URL verification through semantic snapshot resolution and the main command; macOS and Windows identity keys also case-fold namespace and session components to match case-insensitive daemon paths. Different identities remain concurrent, with policy, route, and artifact deltas merged across unrelated managed-state commits while branch restores still discard stale work. Concurrent artifact results carry the aggregate manifest with monotonic revisions so transcript restore retains all bounded entries. Semantic-action snapshots now run only after the live URL gate succeeds, and cancellation during the live probe propagates instead of becoming a page-verification error.
- Managed `piab-r2-*` restore capabilities, legacy `piab-r-*` capabilities, and capability-bearing paths are now redacted from model-visible text, structured details, JSON-mode content, and persisted tool results. `session list` and `state list` omit wrapper-managed rows; malformed oversized upstream output is discarded instead of being persisted as a secret-bearing parse-failure spill; foreign managed `--restore` / `--state` / `state show` / `state load` references, broad `state clear`, `state clean`, and managed save/rename targets fail before spawn. Retention removes stale ownership-proven snapshots and empty manifests from superseded restore-key generations after 30 days only when a private lineage record proves the same canonical checkout path, while preserving independent checkouts, unrecorded files, and the current checkout key.

### Validation

- Passed `npm run verify -- pre-pr` (690 tests passed, 2 opt-in skips; 125 packed files), real-upstream contract, dogfood, packaged Pi, startup-profile, configured-source lifecycle, isolated Pi explicit-session smoke, and local platform-target verification. The remote Crabbox macOS/Ubuntu/native-Windows matrix was unavailable and explicitly waived for this release.

## 0.2.73 - 2026-08-02

### Changed

- Shrunk the model-facing `agent_browser` parameter schema by trimming redundant field descriptions while keeping every input mode (`args`, `semanticAction`, `job`, `qa`, `sourceLookup`, `networkSourceLookup`, `electron`) and the same validation constraints.
- Updated schema/extension validation coverage, including a compact schema size budget check.

### Validation

- Passed `npm run verify` (591 tests passed, 2 opt-in skips) and live command-reference verification against `agent-browser 0.33.0`. Platform/cloud release smoke was not run for this GitHub-only prep.

## 0.2.72 - 2026-07-23

### Changed

- Rebaselined the command/help inventory, source evidence, prompt guidance, and package docs to `agent-browser 0.33.0` / vercel-labs/agent-browser@1ed371f3af472cc0d6cd8fdaea75d1a085ff7534 (includes 0.32.3–0.32.4 HAR/`find`/`derive-client` surfaces).
- Documented HAR response-body capture modes (`network har start --content text|all|none`), `skills get derive-client`, and the new `a11y [url]` axe-core accessibility audit (`--tags`, `--selector`).
- Documented upstream 0.32.4 `find role` implicit ARIA / accessible-name matching, locator-detail miss text, and the aligned `find` action list (`click, fill, check, hover, text`).
- Added compact model-facing presentation for `a11y` violation/incomplete summaries.

### Fixed

- Classified upstream 0.32.4+ locator-detail misses (`Names seen:`, `No element found: getByRole(...)`, `Element not found: … Verify the selector, role, or name`) as `failureCategory: "selector-not-found"` so snapshot-ref recovery still runs, without treating bare accessible-name text containing `timeout` or `Confirmation required` as unrelated categories.
- Treated command-scoped `--content` and `--tags` as value-taking flags during argv planning so `network har start --content all` and `a11y --tags wcag2a,wcag2aa` keep mode/tag tokens with their flags.

### Validation

- Passed `npm run verify` (590 tests passed, 2 opt-in skips), live command-reference verification, and `npm run verify -- real-upstream` (2/2 tests) against installed `agent-browser 0.33.0`.
- Passed `npm run verify -- release`, including configured-source lifecycle, packaged Pi smoke, and macOS/Ubuntu/native-Windows Crabbox `platform-build` plus `browser-dogfood-smoke` on `agent-browser 0.33.0` (Windows snapshot `crabbox-ready-ab-0.33.0`, Ubuntu image `node24-agent-browser0.33.0`).

## 0.2.71 - 2026-07-18

### Fixed

- Applied the same managed-session `AGENT_BROWSER_IDLE_TIMEOUT_MS` to top-level commands and every wrapper helper subprocess. With upstream 0.32.2, missing the value on hidden snapshots, tab lists, navigation summaries, and diagnostics could restart the background browser, replace the active page with `about:blank`, and make a freshly captured `@ref` fail on the next click or select.
- Refreshed the remaining active tab URL/title after `tab close` so subsequent snapshots, ref guards, and interactions no longer inherit the closed tab's target.
- Made ordinary document `scroll <direction> [amount]` deterministic before upstream wheel fallback, including pages such as Artificial Analysis whose smooth-scroll CSS previously left large scroll commands at offset zero.

### Changed

- Extended the real-upstream contract with snapshot-ref native selection and stable-id/label tab lifecycle coverage, and corrected fake/docs tab examples from unsupported positional `tab 0` to stable `tab t1`.

### Validation

- Passed `npm run verify` (590 tests passed, 2 opt-in skips), live command-reference verification, the expanded 2/2 real-upstream contract, deterministic dogfood, benchmark, packaged Pi smoke, and three-sample startup profiling (50.1 ms maximum against the 250 ms budget).
- Passed isolated checkout-loaded Pi dogfood on Artificial Analysis, React, GitHub, and a deterministic select/tab fixture. Artificial Analysis document scroll moved from offset 0 to 700; snapshot-ref select/click, stable-id/label tab switching, post-close target refresh, and post-close interaction completed with no background restarts, `about:blank` resets, or spurious stale-ref failures.
- Passed `npm run verify -- release`, including configured-source reload/relaunch lifecycle, packaged Pi smoke, and macOS/Ubuntu/native-Windows Crabbox `platform-build` plus `browser-dogfood-smoke`; all provider leases and browser sessions were cleaned.

## 0.2.70 - 2026-07-18

### Changed

- Removed unused TypeScript imports, locals, exports, declaration sidecars, compatibility barrels, inert `browser.defaultLaunchArgs` config handling, and duplicated platform/build orchestration while preserving the browser runtime contract.
- Condensed completed plans and the historical support ledger into current ADR/decision indexes, removed obsolete archive material, and enabled `noUnusedLocals` for ongoing enforcement.
- Kept one guaranteed build owner before every `dist/` consumer; package verification now lets `prepare` create a missing `dist/` before expanding the publish contract and forbids internal `docs/plans/` content by prefix.

### Compatibility

- Undocumented deep imports through `lib/results/shared.js` or `lib/orchestration/browser-run.js`, the inert `browser.defaultLaunchArgs` config field, unused named platform-config exports, and the redundant default-export `supportedTargets` platform-smoke property are no longer supported. Native `agent_browser` behavior and documented package entrypoints are unchanged.

### Validation

- Passed `npm run verify -- release` (587 tests passed, 2 opt-in skips), configured-source lifecycle, packaged Pi smoke, live command-reference verification, and macOS/Ubuntu/native-Windows Crabbox `platform-build` plus `browser-dogfood-smoke` suites.
- Passed opt-in real-upstream, deterministic dogfood, benchmark, and startup-profile gates; the three-sample startup maximum was 51.9 ms against the 250 ms budget.
- Passed a checkout-loaded Pi 0.80.10 tmux smoke on `example.com` and `react.dev`, including QA, fresh-session snapshot/link navigation, verified screenshot evidence, recovery from stale selector attempts, and zero active browser sessions after cleanup.

## 0.2.69 - 2026-07-17

### Changed

- Rebaselined the command/help inventory, source evidence, real-upstream output-shape fixture, and package docs to `agent-browser 0.32.2` / vercel-labs/agent-browser@6ede7a9470ac4b681cabf838af8668b9aa99e957.
- Documented the 0.32.1–0.32.2 eve compatibility, packaging, stable AI SDK, and scoped-config updates without adding an eve-specific Pi runtime or dependency.
- Added the previously missing upstream `read [url]` surface to the local capability inventory and prompt guidance, including markdown/llms/outline/filter options and explicit long-timeout budgeting across upstream's per-request fallback sequence.

### Fixed

- Rendered successful `read` results from upstream `data.content` instead of collapsing them to the fetched URL.
- Kept explicit `read <url>` metadata from replacing the active browser tab target used by later ref and tab recovery.

### Validation

- Passed `npm run verify` (585 tests passed, 2 opt-in skips), live command-reference verification, and `npm run verify -- real-upstream` (2/2 tests) against installed `agent-browser 0.32.2`.
- Passed a checkout-loaded Pi 0.80.10 tmux smoke: `read https://example.com` rendered the full `Example Domain` body and the managed session closed cleanly.

## 0.2.68 - 2026-07-16

### Changed

- Migrated the real Pi SDK pipeline test from removed `AuthStorage`/`ModelRegistry` session options to an isolated async `ModelRuntime` with an in-memory pi-ai credential store.
- Refreshed the Pi development lock and fleet validation marker to 0.80.9 while preserving wildcard runtime peers and the existing 0.80.6 runtime floor.
- Rebaselined upstream capability metadata, command reference, prompt guidance, and support docs to `agent-browser 0.32.0` / vercel-labs/agent-browser@1bda76fa675e2b2dd9936123f6f2f1556d76e960.
- Made argv-supplied `--allowed-domains` launch-scoped and documented upstream's request/worker/popup/WebRTC containment, incompatible launch modes, completed-page wait fix, and separate `@agent-browser/eve` integration package.

### Validation

- Added post-release Windows interactive-desktop WebGPU evidence on a disposable Parallels clone: the `agent-browser 0.31.2` headed doctor render/readback and screenshot subchecks passed (`rgb(255,0,0)`), and a console capture showed Edge rendering the WebGPU triangle. The overall doctor result remained nonzero only because the image has Edge but no separately installed Chrome binary.

## 0.2.67 - 2026-07-14

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, prompt guidance, and real-upstream output-shape metadata for `agent-browser` `0.31.2` / vercel-labs/agent-browser@dcbe3522f931d24f85a786ba6ba7f343d86f7294.
- Added upstream WebGPU launch support across optional-boolean argv parsing, launch-scoped session policy, browser guidance, and `doctor --webgpu` handling. Documented macOS/Windows/Linux rendering requirements, `AGENT_BROWSER_WEBGPU`, `AGENT_BROWSER_NO_XVFB`, config overrides, and incompatible remote/provider launch modes.
- Documented upstream's periodic restore-state autosaves and `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS` without duplicating upstream persistence or claiming its files as wrapper artifacts.
- Added Vulkan, Mesa, and Xvfb packages to the project-owned Ubuntu smoke image so the upstream headed WebGPU capture path is testable in the release environment.
- Refreshed the development lock, fleet marker, and local validation baseline to Pi 0.80.7. The enforced runtime floor remains Pi 0.80.6 because no 0.80.7-only runtime API is required.

### Fixed

- Kept both `doctor --webgpu` and `doctor --webgpu --headed` sessionless while preserving `--webgpu` as a launch-scoped flag for real browser commands.

### Validation

- Passed `npm run verify` (583 tests passed, 2 opt-in skips), live command-reference verification, `npm run verify -- real-upstream`, `npm run verify -- dogfood`, and `npm run verify -- release`, including lifecycle, packaged Pi smoke, and macOS/Ubuntu/native-Windows Crabbox suites against `agent-browser 0.31.2`.
- Passed live WebGPU render/readback and pixel-capture probes on macOS Metal and Linux SwiftShader/Xvfb, verified a real Hello Triangle screenshot, and confirmed periodic restore autosave captured an idle page-driven localStorage change before close. Windows package/browser smokes passed; headed WebGPU screenshot proof is not claimed from the non-interactive SSH validation context.

## 0.2.66 - 2026-07-11

### Changed

- Updated the development and validation baseline to Pi 0.80.6, including the package doctor runtime floor and host-provided Pi peer package checks. Runtime browser behavior is unchanged.

## 0.2.65 - 2026-07-06

### Fixed

- Fixed installed-package prompt guidance so the compiled `dist/` entrypoint points agents at package-root `README.md`, `docs/COMMAND_REFERENCE.md`, and `docs/TOOL_CONTRACT.md` instead of nonexistent `dist/docs/...` paths.
- Tightened managed-session tab recovery so snapshot-scoped `@e...` follow-up commands can re-select the snapshot page after about:blank/tab drift without adding routine tab-list probes to ordinary same-session commands.
- Resolved semantic role `click` / `fill` shortcuts from a fresh visible snapshot when exact current refs exist, avoiding stale cached-ref reuse after tab or page drift.

### Validation

- Ran `npm run verify`, focused extension-validation tests, `npm run docs`, `npm run typecheck`, `git diff --check`, and a thermo-nuclear reviewer subagent loop until it returned no material findings.

## 0.2.64 - 2026-07-01

### Fixed

- Clarified `agent_browser` prompt, command-reference, and error-hint guidance so selector-required getters such as `get text/html/value/count <selector>` and `get attr <selector> <name>` are no longer grouped with selector-less `get title/url`.
- Expanded adjacent shorthand command guidance for React, network, diff, trace/profiler/record, and clipboard families so prompts do not imply missing arguments are valid.

### Validation

- Ran `npm run verify`, focused prompt/error/doc tests, `git diff --check`, and a reviewer subagent loop until both reviewers returned `GREEN`.

## 0.2.63 - 2026-06-26

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, and real-upstream output-shape metadata for `agent-browser` `0.31.1` / vercel-labs/agent-browser@ed2e10598c9064aecfaeb7cf21b540684db4be2c.
- Recorded upstream's React renderer bugfix for `react tree`, `react inspect`, and `react suspense`; no wrapper CLI/schema/runtime compatibility change was needed.
- Isolated the real-upstream `wait --download` contract's browser download directory under the test temp root so upstream's known saveAs limitation no longer spills fixture files into `~/Downloads`.
- Made Windows browser-dogfood platform smoke fail fast instead of hanging silently by bounding `agent-browser` prewarm commands, killing timed-out process trees, and printing per-suite progress for single-suite runs.
- Hardened Windows platform-smoke doctor cleanup so disposable probe stop failures fail the doctor instead of leaking Crabbox VMs/leases.
- Removed a redundant dogfood `domcontentloaded` wait that could race after a successful file-page open on Windows.

### Validation

- Ran `npm run docs -- command-reference check`, `npm run verify -- command-reference`, `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run smoke:platform:ubuntu-image`, `npm run verify -- release`, `npm publish --dry-run`, and `git diff --check`.
- Used subagent and intercom review to confirm 0.31.1 changes are limited to upstream React renderer selection plus version/changelog metadata.

## 0.2.62 - 2026-06-26

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, playbook guidance, and real-upstream output-shape metadata for `agent-browser` `0.31.0` / vercel-labs/agent-browser@5acf7f9.
- Added upstream `--namespace`, `--restore`, restore-check flags, and `session id` / `session info` support to wrapper parsing, session policy, launch-scoped flag handling, and docs.

### Fixed

- Made wrapper-managed browser state namespace-aware across tab/ref tracking, allowed-domain policy, trace/profiler ownership, branch restore, cleanup, nextActions, and fresh-launch recovery.
- Reduced post-click diagnostic fragility for upstream `agent-browser 0.31.0`: CSS selector clicks without upstream href/navigation fields now skip immediate helper probes, while ref/href clicks keep navigation summaries and overlay diagnostics.
- Preserved namespace context for managed-session failure recovery and missing-binary nextActions.

### Validation

- Ran `npm run verify`, `npm run docs -- command-reference check`, `npm run typecheck`, focused runtime/diagnostic/passthrough tests, `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run verify -- lifecycle`, `npm run smoke:platform:doctor`, `npm run smoke:platform:all`, `npm publish --dry-run`, and `git diff --check`.
- Ran the required reviewer subagent loop until it returned `no findings`.

## 0.2.61 - 2026-06-24

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, playbook guidance, and real-upstream output-shape metadata for `agent-browser` `0.30.1` / vercel-labs/agent-browser@7379f7dbea76ad8dbf47f177349c4c3ce9263dcb.
- Removed the constrained `job.assertUrl` glob-to-`wait --fn` workaround now that upstream `wait --url` matches glob patterns such as `**/dashboard` against the full active URL.

### Validation

- Ran `npm run verify`, `npm run docs`, focused `npx tsx --test test/agent-browser.extension-input-modes.test.ts`, `npm run verify -- command-reference`, and `git diff --check`.
- Probed upstream `agent-browser 0.30.1` directly: `wait --url "**/dashboard"` succeeds after `pushstate /dashboard`; `find ... uncheck` and `wait <selector> --state hidden|detached` still fail, so only the URL-glob workaround was removed.

## 0.2.60 - 2026-06-24

### Changed

- Removed a dead `as never` cast and unreachable try/catch from the `agent_browser` collapsed-output "to expand" keybinding hint. `app.tools.expand` is a host-registered keybinding id (coding-agent augments pi-tui's `Keybindings` via declaration merging), so the id is resolved cast-free via `getKeybindings().getKeys(...)` with the stock `ctrl+o` fallback preserved for bare-node test contexts. No behavior change; the `pi-coding-agent` package stays type-only in the entrypoint import path so startup tax is unchanged.

### Validation

- Ran `npm run verify` (default gate: docs, typecheck, 575/575 unit, command-reference baseline + live drift), `npm run verify -- startup-profile --samples 3` (median 50.1ms, < 250ms budget), `npm run verify -- real-upstream`, `npm run verify -- lifecycle`, `npm run verify -- dogfood`, `npm run verify -- pre-pr`, and `npm run doctor` against the local checkout.
- Ran an independent reviewer subagent over the diff; no blockers found and the compaction-orphan audit claim was confirmed disproven against Pi 0.80.2 source.

## 0.2.59 - 2026-06-24

### Changed

- Shortened the always-on `agent_browser` prompt guidance by over 1KB while preserving the native-tool trigger, open → `snapshot -i` workflow, `sessionMode=fresh`, artifact verification, and extraction rules.
- Moved the quick live-search guidance onto `agent_browser_web_search` so browser-search routing stays available without duplicating that guidance in the main browser tool prompt.

### Validation

- Ran `npm run verify -- release`, `npm run doctor`, and `npm run verify -- startup-profile --samples 3` against the local checkout.
- Ran tmux-driven Pi checkout smoke with `pi --approve --model zai/glm-5.2:high --no-extensions --no-skills --session-dir <tmp> -e .`, confirming the model chose `agent_browser` for `open` + `snapshot -i`, chose `agent_browser_web_search` for live search, and closed the managed browser session.
- Ran an independent reviewer subagent over the diff; no blockers found.

## 0.2.58 - 2026-06-23

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.80.1` and raised the doctor/runtime floor to Pi `0.80.1`.
- Moved extension source/test imports that typecheck against old root `@earendil-works/pi-ai` globals to `@earendil-works/pi-ai/compat`, matching the Pi 0.80 migration guidance.

### Validation

- Pending in this release train.

## 0.2.57 - 2026-06-22

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.79.10` and refreshed `.pi-fleet-tested-version` for the installed `pi 0.79.10` runtime.

### Fixed

- Stabilized the timeout-progress regression test by giving the non-timeout setup open a larger per-call watchdog under full release-suite load.

### Validation

- Reviewed the installed Pi `0.79.10` changelog, extension docs, package docs, security/project-trust docs, and extension API types; no wrapper runtime change was required for the new compaction event metadata.
- Ran `npm run verify -- release`, `npm run verify`, `npm run verify -- lifecycle`, `npm run verify -- package-pi`, `npm run docs`, `npm run doctor`, `npm audit --json`, `npm run check:platform-smoke`, `npm run smoke:platform:doctor`, `npm run smoke:platform:all`, and `git diff --check` against `agent-browser 0.29.1` and `pi 0.79.10`.

## 0.2.56 - 2026-06-21

### Fixed

- Corrected the local Pi development baseline to `@earendil-works/*` `0.79.9`, matching the installed `pi 0.79.9` runtime used for release validation.

### Validation

- Re-ran `npm install` and `npm audit --json`; dependency install completed and audit reported zero vulnerabilities.

## 0.2.55 - 2026-06-21

### Changed

- Rebaselined upstream capability metadata, command reference, support docs, playbook guidance, platform smoke image tag, and real-upstream output-shape metadata for `agent-browser` `0.29.1` / vercel-labs/agent-browser@4572acf0d71c0086009206c9c1e2136fc54ec9e5.
- Documented the new upstream `@agent-browser/sandbox` package guidance, `installSystemDependencies: false`, and stricter `install --with-deps` nonzero behavior while keeping sandbox support outside this thin Pi wrapper.
- Updated local Pi development dependencies to `@earendil-works/*` `0.79.8`, kept Pi core package peers host-provided, and marked those peers optional to avoid install-time peer noise for package consumers.

### Fixed

- Kept optional recording paths from being misclassified as required screenshots when release-smoke prompts are collapsed into one line for tmux automation.
- Added npm overrides for vulnerable transitive dev dependencies so `npm audit` reports zero vulnerabilities without adding runtime dependencies.

### Validation

- Ran `npm run verify -- release` against `agent-browser` `0.29.1`; after rebuilding the Ubuntu image and refreshing the Windows `crabbox-ready` snapshot, the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke.
- Ran `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run verify -- benchmark`, `npm run verify -- startup-profile --samples 3`, `npm run docs`, `npm run doctor`, `npm audit --json`, `npm run check:platform-smoke`, `npm run smoke:platform:ubuntu-image`, `npm run smoke:platform:doctor`, focused prompt-guard tests, and `git diff --check`.
- Ran tmux-driven Pi checkout dogfood with `pi --approve --no-extensions --no-skills -e .`, covering the public Sauce Demo checkout-overview flow with screenshot/recording evidence and no order placement; then verified the collapsed one-line screenshot-plus-recording close guard on `https://example.com` after rebuilding `dist/`.

## 0.2.54 - 2026-06-19

### Fixed

- Accepted upstream `plugin list` / `plugin show` JSON and blocked bare `mcp` native-tool calls while preserving `mcp --help`.

### Validation

- Ran `npm run verify -- release` against `agent-browser` `0.28.0`; the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke.
- Ran `npm run verify -- real-upstream`, `npm run docs`, `npm run doctor`, `npm run check:platform-smoke`, `npm run smoke:platform:ubuntu-image`, `npm run smoke:platform:doctor`, and `git diff --check`.
- Ran a tmux-driven Pi checkout dogfood with `pi --approve --no-extensions --no-skills -e .`, covering `--version`, `mcp --help`, `plugin list`, fresh `example.com` open plus `snapshot -i`, `qa` on `react.dev`, and browser close.

## 0.2.53 - 2026-06-18

### Changed

- Rebaselined upstream capability metadata, command reference, support matrix, platform-smoke image tag, and real-upstream output-shape metadata for `agent-browser` `0.28.0` / vercel-labs/agent-browser@6323df571ffd17d14e60ec19fcb56cc1caf498ab.
- Documented upstream `mcp`, `plugin add/list/show/run`, plugin-backed `auth login --credential-provider`, and `AGENT_BROWSER_PLUGINS` surfaces while keeping the wrapper thin and compatibility-shim-free.
- Marked `mcp` and known `plugin` commands as sessionless wrapper calls so local/infra commands do not get an implicit managed browser session.
- Collapsed duplicated release/platform-smoke prose across README, release docs, and agent guidance in favor of `docs/platform-smoke.md` as the detailed source of truth.
- Simplified duplicate internal schema/job compiler plumbing without changing the public tool schema or generated argv behavior.

### Fixed

- Retried the Windows platform dogfood smoke once after transient first browser-open failures, matching the existing Windows browser prewarm tolerance while preserving real dogfood failures.

### Validation

- Ran `npm run verify -- release` against `agent-browser` `0.28.0`; the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke after refreshing the Ubuntu image and Windows `crabbox-ready` snapshot.
- Ran `npm run verify -- real-upstream`, `npm run verify -- dogfood`, `npm run docs`, `npm run verify -- command-reference`, and `git diff --check`.

## 0.2.52 - 2026-06-15

### Changed

- Rebaselined the upstream capability metadata, command reference, support matrix, platform-smoke image tag, and real-upstream output-shape metadata for `agent-browser` `0.27.3` / vercel-labs/agent-browser@2c7991c9eccca1c9db6eee1a26a713414778de5a. This is an install-only upstream update from the prior baseline; no wrapper feature, shim, or inventory-token change was added.
- Updated the local Pi development baseline to `@earendil-works/*` `0.79.4`, refreshed `.pi-fleet-tested-version`, and refreshed `package-lock.json` with npm 11 while keeping the intentional doctor floor at Pi `0.79.0`.

### Fixed

- Updated the lifecycle release harness prompt-readiness check to accept Pi 0.79.4 footer units such as `1.0M`, avoiding false readiness timeouts after successful startup.

### Validation

- Ran `npm publish --dry-run` against `agent-browser` `0.27.3` and Pi `0.79.4`; the gate passed default verification, command-reference checks, build, lifecycle verification, packaged Pi smoke, and macOS/Ubuntu/Windows-native platform smoke.

## 0.2.51 - 2026-06-11

### Fixed

- Made the source-package `prepare` lifecycle install dev dependencies with scripts disabled when Pi's `npm install --omit=dev` package path omits the compiler and peer type packages, so GitHub/source installs can still build `dist/` from a clean clone without changing runtime dependency policy.

### Validation

- Reproduced the `pi install -l --approve https://github.com/fitchmultz/pi-agent-browser-native@v0.2.50` source-install failure, then verified production-dependency source builds, project-local GitHub install, project-local npm install, and release gates before publish.

## 0.2.50 - 2026-06-11

### Changed

- Keep visual/model-facing secret redaction and the native-tool bash guard while allowing loaded config credential sources and parent environment variables to pass through to upstream/provider runtime paths.
- Allow trusted project-local package config to provide web-search credential sources and browser profile/executable prompt guidance instead of limiting those capabilities to global or override config.

### Validation

- Ran focused config/web-search/process/redaction/clipboard/extension tests, `npm run typecheck`, `npm run docs`, `npm run verify -- command-reference`, the default `npm run verify` gate, and the release gate through lifecycle, package Pi, and platform smoke validation.

## 0.2.49 - 2026-06-11

### Changed

- Ship the Pi package entrypoint as compiled JavaScript under `dist/` so installed package startup no longer pays runtime TypeScript loading cost.
- Added clean-build orchestration before verification, package, lifecycle, platform-target, test, startup-profile, and GitHub/source install flows that consume generated `dist/` output.
- Replaced invasive full-Pi startup profiling with a safe direct-entrypoint profiler that clean-builds `dist/`, measures fresh Node import/factory samples, and refuses the old timeout-driven Pi/tmux workflow.

### Fixed

- Prevented clean checkouts from validating missing or stale compiled package entrypoints by building before package/lifecycle/startup consumers, building on GitHub/source install, and ignoring generated `dist/` in the repo.
- Kept local config and doctor helpers aligned with the compiled package entrypoint while avoiding stale local `dist/` policy reads.

### Validation

- Ran focused build/package/lifecycle/config/doctor/startup tests, `npm run typecheck`, `npm run docs`, `npm run verify -- package-pi`, `npm run verify -- startup-profile --samples 10`, an independent reviewer loop to no findings, and a reload smoke using the native `agent_browser` tool against `https://example.com`.

## 0.2.48 - 2026-06-11

### Changed

- Rebaselined the upstream capability metadata, command reference, support matrix, and real-upstream contract metadata for `agent-browser` `0.27.2` after reviewing the upstream changelog.
- Forward explicit long `wait <ms>` / `wait --timeout <ms>` calls now that upstream `agent-browser` `0.27.2` fixes wait timeout and client read-budget handling; the wrapper derives a longer subprocess watchdog when the caller does not provide top-level `timeoutMs`.
- Split `browser-run/prepare.ts` concerns into focused direct-anchor download, network page-filter, wait-timeout, scroll-shim, and snapshot-filter preparation modules while preserving the existing coordinator behavior.
- Refactored constrained `job` step compilation around per-action descriptors so unsupported-field validation and compilation stay paired.
- Added a documentation source-of-truth map and moved implementation-deep support-matrix closure notes into maintainer notes so the active release checklist stays navigable.
- Moved superseded implementation-plan and v1 contract drafts into `docs/archive/` with clear non-canonical archive guidance while keeping them out of the published package.
- Added `npm run verify -- pre-pr` as a named local confidence gate that runs the default verification stack plus package-content checks without release-only lifecycle, platform, live dogfood, or benchmark cost.

### Fixed

- Removed stale docs that said `wait 30000` was intentionally blocked by the wrapper.
- Rejected unsupported fields for every constrained `job` step action instead of silently ignoring irrelevant fields.
- Broke the browser-run orchestration import cycle and added a static acyclic import-boundary regression test.
- Added package verification for local Markdown links in packed docs and converted repo-only documentation references to external GitHub links or plain text so npm docs remain navigable.
- Clarified support-matrix evidence so current `agent-browser 0.27.2` gates are separated from historical pending-refresh release gates.
- Aligned the documented/tested AWS provider environment allowlist with the runtime-forwarded AgentCore AWS variables.
- Kept env/global web-search registration available when project-local config is not approved, while trusted project disables or config errors still suppress unsafe search execution.
- Stopped running click-dispatch probes for unresolved `find … click` locators to avoid false failures on frame-scoped upstream clicks.

### Validation

- Ran focused wrapper/process tests, `npm run typecheck`, `npm run docs`, `npm run verify -- command-reference`, `npm test -- --test-concurrency=1`, `npm run verify -- real-upstream`, `npm run doctor`, `npm run verify -- package`, and `npm run verify -- dogfood` against `agent-browser` `0.27.2`; final release validation evidence is recorded in `docs/SUPPORT_MATRIX.md`.

## 0.2.47 - 2026-06-08

### Changed

- Updated the local Pi development baseline and release guidance to Pi 0.79.0, including Project Trust-aware lifecycle/package/platform validation commands.
- Kept this extension risk-on by loading project-local package config by default while honoring explicit Pi `--no-approve` / `-na` opt-out runs.
- Updated the `pi-extension-development` skill guidance for Pi 0.79.0 and for explicit user consultation before behavioral changes.

### Fixed

- Made platform smoke package install/list checks use Pi 0.79 approval flags so clean target-local package validation is deterministic.
- Ensured project-local package config can be explicitly skipped without losing global, override, or environment-backed web-search configuration.

### Validation

- Ran docs, typecheck, unit/default verify, package smoke, lifecycle, deterministic dogfood, doctor, platform doctor, full release/Crabbox gates, and interactive tmux native-tool smoke before publish.

## 0.2.46 - 2026-06-08

### Changed

- Reduced native extension startup cost by replacing heavy top-level Pi and TypeBox runtime imports with lightweight local schema and event helpers while preserving the public tool schemas.
- Kept custom browser tool rendering compact without importing Pi's full coding-agent runtime during extension load.

### Fixed

- Fixed issue #84 by cutting local cold extension import plus factory registration from roughly 1.1 seconds to roughly 76 milliseconds in checkout measurements.
- Stabilized timeout partial-progress diagnostics so post-navigation timeouts are recognized from later completed-step evidence even when live URL recovery is unavailable under load.

### Validation

- Added a cold-start budget test for the real extension entrypoint, schema parity coverage against the canonical TypeBox/StringEnum builders, rendering coverage for JSON highlighting plus collapsed-output expand hints, and stabilized deterministic dogfood smoke by avoiding a rapid Windows browser close/relaunch race.

## 0.2.45 - 2026-06-06

### Added

- Added top-level `outputPath` for successful browser CLI results so extraction, snapshot, and diagnostic payloads can be saved as durable local files without scraping transcript text. Explicit upstream `--json` output remains parseable, and failed upstream results do not write output files.
- Added direct selector/ref support to `semanticAction` for `click`, `check`, and `fill`, including optional named-session targeting.
- Added constrained `job` `type` steps with optional human-paced `delayMs` and final `press`, capped for delayed typing and compacted in model-visible batch prose.
- Added timeout partial-progress diagnostics with generated-step labels, declared artifact state, live-vs-planned page evidence, safe retry actions for read-only/idempotent steps, and fresh-session retry handling when no live page was recovered.

### Changed

- Increased the default wrapper child-process watchdog to 35 seconds while keeping upstream IPC operation waits clamped below the 30-second upstream read timeout.
- Improved `record start` / `record restart` lifecycle presentation: future WebM outputs are pending/open until `record stop`, `record restart` can show the previous recording saved by the restart, and ffmpeg warnings cover both start-like commands.
- Tightened dialog timeout precedence so explicit top-level `timeoutMs` overrides dialog-specific watchdog defaults.
- Updated README, command reference, tool contract, architecture, requirements, support matrix, and generated playbook guidance for timeout recovery, artifact lifecycle, output files, direct semantic selectors, and paced job typing.

### Fixed

- Avoided executable timeout retry actions for mutating steps that may already have clicked, filled, typed, selected, or submitted state before the watchdog fired.
- Kept `outputPath` write failures aligned with the result-category contract by removing stale success-only category fields when the wrapper-side write fails.
- Rejected unsupported fields on `job` `type` steps instead of silently accepting irrelevant step fields.

### Validation

- Ran full release verification for this change set before publish, including docs drift checks, TypeScript, unit/fake suite, command-reference verification, dogfood smoke, and release/package validation gates.

## 0.2.44 - 2026-06-04

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.78.1` after reviewing the installed Pi 0.78.1 changelog, docs, examples, and extension source. The audit found no runtime migration needed for `ctx.mode` or command-only `ctx.getSystemPromptOptions()`, and kept the public peer dependency ranges non-pinning.
- Extended the read-only package doctor with a warning-only `pi --version` check so release validation can catch a Pi CLI older than the audited 0.78.1 floor without making Pi 0.78.1 a hard runtime requirement.

### Validation

- Ran checkout-based interactive `tmux` Pi dogfood with `pi --no-extensions --no-skills -e .` on Pi 0.78.1: `agent_browser` opened and snapshotted `https://example.com`, ran a QA preset against `https://react.dev` expecting `React`, saved and verified a screenshot, reported no console/network/page errors, closed the browser session, and cleaned the temp artifact directory.

## 0.2.43 - 2026-06-04

### Added

- Added fail-closed artifact verification for explicit saved paths with an `artifact-missing` failure category when upstream reports success but the requested artifact is absent.
- Added wrapper-side allowed-domain tracking for browser sessions so post-navigation escapes from configured allowed domains fail loudly.
- Added route-aware network diagnostics for pending or CORS-likely route mocks, including structured follow-up actions for request inspection and HAR capture plus prose guidance for same-origin/CORS-correct fixture retries.

### Changed

- Made same-snapshot form batching less conservative: `check`/`uncheck` on checkbox or radio refs and `select` on combobox refs remain guarded against stale refs but no longer force a fresh snapshot before later same-batch form work; direct `click @ref` remains conservative.
- Removed unsupported `semanticAction.uncheck` from the public shorthand contract while keeping raw upstream `uncheck <selector-or-ref>` pass-through available.
- Improved `semanticAction.fill` recovery by resolving exact current editable role/name matches, including comboboxes, through a current visible ref before falling back to upstream locator behavior.
- Made benign local QA storage values visible for explicitly safe primitive keys while continuing to redact secret-, identity-, session-, email-, token-, and URL-shaped values.
- Treated the exact upstream “streaming already enabled” response as an idempotent success with cleanup/status next actions, without masking broader stream failures.

### Fixed

- Stopped emitting Electron app-shell broad-selector warnings on ordinary browser pages such as `file://` fixtures; broad Electron `get text` warnings now require wrapper-tracked Electron launch provenance.
- Clarified clipboard permission denials without leaking denied clipboard write payloads across prose, JSON, batch, parse-failure, and detail surfaces.

## 0.2.42 - 2026-06-03

### Fixed

- Corrected package-config docs to show the package helper only through `npm exec` examples or direct JSON edits, because `pi install npm:pi-agent-browser-native` loads the Pi package but does not add package bins to the user's shell `PATH`.

## 0.2.41 - 2026-06-03

### Added

- Added Exa support to the optional `agent_browser_web_search` companion tool. When both Exa and Brave credentials are configured, `provider: "auto"` now prefers Exa by default; set `webSearch.preferredProvider: "brave"` in config to keep Brave as the default provider.
- Added `webSearch.enabled: false` to disable the companion search tool even when `EXA_API_KEY` or `BRAVE_API_KEY` is present.

### Changed

- Tightened project-local web-search credential config: `.pi/config/pi-agent-browser-native/config.json` may only reference the matching provider env var (`$EXA_API_KEY` / `${EXA_API_KEY}` for Exa, `$BRAVE_API_KEY` / `${BRAVE_API_KEY}` for Brave). Project-local custom env aliases now fail config validation; move aliases to global config or `PI_AGENT_BROWSER_CONFIG`.
- Updated package-config helper actions `web-search set-key`, `set-command`, and `clear` to require `--provider`; `set-env` still infers the provider from `EXA_API_KEY` or `BRAVE_API_KEY`.
- Browser profile/executable prompt guidance now comes only from trusted global config or `PI_AGENT_BROWSER_CONFIG`; project-local browser config is status-only for host profile/executable launch guidance and cannot shadow trusted global guidance.
- `--executable-path` is treated as launch-scoped, so using it after an active implicit browser session returns fresh-session recovery guidance instead of being quietly ignored by session reuse.

### Fixed

- Rejected `--session-mode` inside `agent_browser.args` with guidance to use the top-level `sessionMode` field.
- Added profile/config recovery hints and `profiles` / `doctor` next actions for Chrome profile and user-data-dir failures, including upstream `Chrome profile ... not found` errors.
- Added web-search rate-limit guidance and serialized companion web-search requests so agents avoid repeated or parallel provider calls after HTTP 429s.
- Clarified web-search disable precedence: `webSearch.enabled` is evaluated after global → project → `PI_AGENT_BROWSER_CONFIG` merge, so users know when to use global, project, or override-level disable.

## 0.2.40 - 2026-06-02

### Added

- Added Pi-scoped `pi-agent-browser-native` package config at `~/.pi/config/pi-agent-browser-native/config.json`, `.pi/config/pi-agent-browser-native/config.json`, and the `PI_AGENT_BROWSER_CONFIG` override, including a package helper for redacted setup/status and conservative browser profile hints.
- Added the optional Brave-backed `agent_browser_web_search` companion tool, registered only when a usable Brave credential source is configured or resolvable, with compact normalized results for current/live web information.

### Changed

- Documented optional web-search setup, config precedence, credential safety, and browser profile guidance across the README, command reference, tool contract, architecture notes, and support matrix.

### Fixed

- Hardened Brave credential handling so project-local config only accepts exact inert `$ENV_VAR` or `${ENV_VAR}` references, rejects plaintext/malformed/interpolation-literal/command-backed secrets, and keeps raw or entity-encoded API keys out of tool output and errors.
- Cleaned Brave result text by decoding common HTML entities while stripping decoded HTML tags safely and preserving placeholder text such as `<version>`.

## 0.2.39 - 2026-06-02

### Added

- Added a Crabbox-backed platform smoke gate for release validation across macOS, prepared Ubuntu Linux, and native Windows, including packed-package installation and deterministic browser dogfood suites.

### Changed

- Updated the upstream capability baseline, command reference, platform smoke images, and live-contract metadata for `agent-browser` `0.27.1`.
- Reduced per-target platform smoke cost by using a focused `verify -- platform-target` gate inside Crabbox targets instead of rerunning the full default verification suite on every OS.

## 0.2.38 - 2026-05-29

### Changed

- Updated the local Pi development baseline to `@earendil-works/*` `0.78.0` after reviewing the installed Pi changelog, keeping lifecycle docs and exact-session test expectations aligned with Pi 0.78.
- Pinned the default maintainer unit/fake verification gate to Node test concurrency `1` to avoid process-contention flakes in full-suite release runs while preserving the full test inventory.

### Fixed

- Stabilized timing-sensitive fake-upstream, Electron probe/cleanup, temp-root, and session-close tests under release-suite load.

## 0.2.37 - 2026-05-29

### Added

- Added loopback navigation failure guidance for `localhost` / `127.0.0.1` errors such as `net::ERR_EMPTY_RESPONSE`, making clear that the browser host may not be able to reach the shell host's temporary server and pointing agents to host-reachable addresses or `file://` static-fixture fallbacks.
- Extended click-dispatch diagnostics to eligible `@e…` ref clicks using the latest snapshot role/name metadata, so ref and semanticAction-resolved clicks that report upstream success without a trusted DOM event now fail loudly with `details.clickDispatch` and inspect/retry next actions.

### Changed

- Documented programmatic `eval --stdin` `.click()` as a static-fixture/debugging workaround only: it can exercise app handlers when user-like click dispatch fails, but it emits an untrusted scripted event and must not be treated as proof of real click behavior or used to bypass explicit stop boundaries.
- Updated README, command reference, tool contract, playbook guidance, and support matrix for second through fifth-round `agent_browser` UX feedback, including localhost, click dispatch, and port-lifecycle ownership boundaries.

### Fixed

- Normalized malformed native-tool calls like `args: ["eval", "--stdin", "document.title"]` by moving trailing script tokens into stdin before spawning upstream, matching the canonical `eval --stdin` contract.

## 0.2.36 - 2026-05-29

### Added

- Added `details.evalResultWarning` and visible `Eval result warning` guidance for successful `eval --stdin` calls that return `null` on `file://` pages with non-trivial stdin, so agents treat those DOM checks as inconclusive without failing the tool.
- Enriched `get text <selector>` visibility diagnostics with bounded `visibleCandidates` entries (`querySelectorAll` index, tag, optional role, redacted text preview) so agents can resolve broad selector ambiguity without trusting hidden or first-match text.
- Added support-matrix tracking for the 2026-05-29 agent UX/reliability feedback batch (`RQ-0110`–`RQ-0117`) covering headed mode, local loopback, `file://` eval, click verification, selector ambiguity, host-owned fixture servers, fresh-session failures, and headed visibility limits.

### Changed

- Made failed `sessionMode: "fresh"` managed-session recovery prose action-oriented: visible output now avoids generated session ids, distinguishes preserved/abandoned launch failures from post-launch `qa` reclassification failures, and points to safe next actions while keeping full transition details in `details.managedSessionOutcome`.
- Expanded README, command reference, tool contract, and generated playbook guidance for headed demos, browser-host localhost semantics, `file://` fixture limits, post-click verification, and host-owned temporary server cleanup.

### Fixed

- Fresh-session failure next actions now verify or snapshot the current managed session for post-launch failures and avoid unconditional `doctor` guidance when the launch itself succeeded but a later diagnostic failed.

## 0.2.35 - 2026-05-28

### Changed

- Cut the local Pi development baseline to `@earendil-works/*` `0.76.0` and refreshed the npm lockfile with npm 11.14.0. Pi **≥ 0.76** is recommended for branch/session continuity (`session_tree` rehydration and generation-aware guards).
- Updated the configured-source lifecycle harness for Pi 0.76 exact session IDs: launches and relaunches now use `--session-id piab-lifecycle-<pid>` instead of driving `/resume`, assert the JSONL session header id, and include real Pi `tool_result` failure-patch evidence for QA reclassification.
- Rehydrate branch-visible browser state on Pi `session_tree` events as well as `session_start`, while keeping runtime-owned managed-session and Electron cleanup registries separate so branch switches do not orphan resources owned by the current Pi process; `session_tree`, Electron status/probe/cleanup, and wrapper-owned browser commands now share the same serialization boundary where they can touch managed state, while independent caller-owned explicit-session completions are guarded from overwriting newer branch restores.
- Tightened the public TypeBox schema to reject unsupported top-level fields and unsupported fields inside `semanticAction`, `sourceLookup`, `networkSourceLookup`, and constrained `job` steps.
- Centralized upstream command capabilities in `command-taxonomy.ts` (navigation, ref guards, batch invalidation, session close, Electron health probes, page-change summaries, pinning exclusions) and sessionless managed-session policy in `command-policy.ts` with shared argv discovery in `argv-descriptor.ts` / `argv-grammar.ts`.
- Normalized `open` / `goto` / `navigate` navigation handling through the shared taxonomy so page-change summaries and ref invalidation stay consistent across aliases.
- Refactored the extension entrypoint and browser-run orchestration: Electron host actions moved to `orchestration/electron-host/`, click-dispatch and prompt-guard preflight live under `orchestration/browser-run/`, and duplicate browser-run helper ownership was removed (#57).
- Expanded the upstream capability baseline and command reference for agent-browser **0.27.0** (additional help sampling, inventory tokens, and maintainer rebaseline metadata).

### Added

- Prompt-policy preflight guards: block likely final submit/order clicks (including batch steps and Enter/Return keyboard submits) when the latest user message sets an explicit stop boundary, and block `close`/`quit`/`exit` until requested screenshot/recording paths from the prompt are verified in the artifact manifest.
- Model-free real Pi pipeline coverage for `buildAgentBrowserToolResultPatch`, proving prose QA failures become `isError: true` in persisted JSONL tool results and caller-requested `--json` failures keep parseable JSON while still patching `isError`.
- Model-free real Pi pipeline coverage for strict public-schema rejection before upstream spawn.
- Regression tests for prompt guards, click-dispatch diagnostics, command taxonomy/policy, argv descriptor edge cases, temp-root cleanup, and `session_tree` branch rehydration of page-scoped refs, managed browser sessions, artifact manifests, Electron cleanup/status/probe ownership, explicit cleanup serialization, active-Electron reload profile preservation, targeted cleanup without unrelated branch promotion, reload cleanup of off-branch sessions/Electron launches, durable partial off-branch reload/quit profile preservation, protected temp-root process-exit and stale-prune cleanup, partial Electron cleanup session untracking, explicit close live/restore state retirement, explicit close generated-fresh ordinal reservation, explicit-session command branch-generation guarding, multi-branch managed-session cleanup, and monotonic fresh-session allocation.

### Fixed

- Successful explicit `--session <current-wrapper-managed-session> close` and `electron.cleanup` managed-session close steps now clear live managed-session/page state, untrack cleanup ownership, reserve the next generated fresh-session ordinal so repeated closes cannot reuse a just-closed generated name, rotate the next default auto call away from the closed name, and stay honored after reload/resume branch restore.
- `/reload` now preserves the current branch-visible active Electron launch and its isolated temp `userDataDir` for continuity while cleaning off-branch owned Electron launches, preserves off-branch profile dirs across reload, quit, repeated temp cleanup, process-exit cleanup, and stale temp-root pruning after restart when partial cleanup intentionally skips or fails `user-data-dir` removal, and targeted `electron.cleanup` no longer promotes unrelated off-branch launches into the current branch-visible state.
- Stabilized env-patched fake-upstream tests by serializing process environment patches and tightening the inherited-stdio subprocess regression to assert quick post-exit fallback behavior without waiting for the process timeout.
- Hardened maintainer dogfood/smoke safety around release prompts (stop-before-order and required artifact paths) so automated and interactive smokes exercise the new guards without placing orders or closing early.

## 0.2.34 - 2026-05-24

### Added

- Deterministic maintainer dogfood mode: `npm run verify -- dogfood` runs a model-free live-browser smoke through the native wrapper against public `example.com`, covering top-level `qa`, `semanticAction`, `qa.attached`, constrained `job`, screenshot artifact verification, and session close.
- Opt-in efficiency-benchmark JSONL sampling via `--sample-jsonl`, so maintainers can measure real transcript model-visible byte output without changing deterministic scenario metrics.
- Architecture note for the Tier A/Tier B prompt-guidance budget, keeping always-on `promptGuidelines` short while preserving detailed browser playbook guidance in docs.

### Changed

- Always-on `agent_browser` prompt guidance is smaller and focused on Tier A rules: input-mode choice, refs/session/artifacts/nextActions, extraction basics, and explicit stop-before-order/post/purchase/submit boundaries.
- `semanticAction` success output now better mirrors raw browser-action navigation and page-change summaries, while docs make the input-mode chooser clearer.
- QA preset pass output is more compact, and `qa.attached` preflight now treats URL-only current-page checks as valid attached-session evidence.
- Constrained `job` docs now make post-click navigation assertions explicit with `assertUrl` / `assertText` instead of implying hidden automatic navigation checks.

### Fixed

- Stabilized concurrency-sensitive fake-upstream tests by waiting for the older explicit-session open to reach the fake binary before launching the newer one, and by covering the documented planned-URL fallback separately from strict live current-page recovery assertions.

## 0.2.33 - 2026-05-23

### Added

- `npm run typecheck` as a thin alias for the default gate’s `tsc --noEmit` step (`scripts/project.mjs` `verify typecheck`), for fast iteration without docs drift checks, unit tests, or live upstream command-reference sampling.

### Changed

- Maintainer docs now map Pi `details` classifiers, `nextActions`, recovery id registries, and network QA helpers to the split `extensions/agent-browser/lib/results/*` modules (plus the `shared.ts` re-export barrel) and call out `extensions/agent-browser/lib/session-page-state.ts` for ordered tab/ref/pinning state—see [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md), and [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md).
- Real Pi transcripts now treat wrapper-classified failures as tool errors: a `tool_result` hook (`buildAgentBrowserToolResultPatch` in `extensions/agent-browser/index.ts`) sets `isError: true` when `details.resultCategory` is `failure` even if `execute` returned successfully (for example `qa` preset reclassification), appends a model-visible `Result category: failure; …; Pi tool isError: true.` line for prose output, and preserves caller-requested `--json` output as parseable JSON—see [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details).
- Desktop and attach workflows: documented readiness ladders (condition waits, `tab list` → `tab t<N>` → `snapshot -i`, `electron.probe` / `qa.attached`) instead of blind sleeps; clarified that raw `connect` success only means the CDP endpoint accepted the session, and that `close` does not quit manually launched apps or remove explicit artifacts.
- Page-scoped refs: when `snapshot -i` reports `No active page`, prior session refs are cleared and `details.refSnapshotInvalidation` records `reason: "no-active-page"` until a successful snapshot restores refs; compact snapshots’ `Omitted high-value controls` heuristics favor editables, named tab/surface controls, and primary actions on dense desktop-host UIs.
- Semantic `fill` recovery on host-controlled rich inputs: `details.richInputRecovery`, visible `Rich input recovery`, and bounded `focus-current-editable-ref*` / `click-current-editable-ref*` next actions (no embedded fill text, no auto-submit); click misses still get bounded role/name `find` candidates where applicable.
- `get text` selector-visibility warnings now name the matching `details.nextActions` id; `about:blank` drift recovery records the observed blank target when re-selecting the prior tab fails instead of implying the old page stayed active.

## 0.2.32 - 2026-05-21

### Added
- First-class Electron desktop-app support for `agent_browser`: top-level `electron` now covers bounded app discovery, isolated wrapper-owned launch/attach, status, compact probe, and cleanup without requiring agents to hand-build the CDP launch sequence.
- Electron launch safety and lifecycle details: wrapper-owned launches use a temporary profile and OS-chosen debug port, record a `launchId`, surface exact status/probe/cleanup next actions, support caller-owned `allow` / `deny` policies, and avoid touching manually launched apps.
- `qa.attached` for current attached browser/Electron sessions, so agents can run quick smoke checks without opening a URL or replacing the active desktop-app target.
- A dedicated public Electron guide at [`docs/ELECTRON.md`](docs/ELECTRON.md), linked from the README, command reference, tool contract, architecture, requirements, release, and support-matrix docs and included in the published package.

### Changed
- `sourceLookup`, broad `get text`, fill verification, tab/session mismatch, and stale-ref guidance now include Electron-aware context and recovery actions for packaged desktop apps.
- Verification coverage now includes deterministic Electron lifecycle/probe benchmark scenarios, fake-upstream Electron discovery/lifecycle tests, lifecycle restore/shutdown cleanup checks, and real-app dogfood evidence recorded in the Electron plan.
- The configured-source lifecycle harness (`npm run verify -- lifecycle`, `scripts/verify-lifecycle.mjs`) now defaults to Pi model `zai/glm-5.2` with `--model <id>` override; `npm run verify` lifecycle passthrough rejects `--model` without a value.
- Updated the local Pi development baseline to `@earendil-works/*` `0.75.4` and refreshed the npm lockfile.

### Fixed
- Runtime validation now rejects `electron.status` / `electron.cleanup` with `all: false`, keeping runtime behavior aligned with the public schema and contract.
- Electron + caller `stdin` validation now reports a direct Electron-specific error instead of mixing in generated-batch mode guidance.

## 0.2.31 - 2026-05-18

### Added
- First-class native dropdown selection for `agent_browser`: `semanticAction.action = "select"` and constrained `job` `select` steps now compile to upstream `select <selector> <value...>`, with tests against fake and real upstream fixtures.
- Bounded machine `details.nextActions` for compact `network requests` output, including exact request-detail, source-lookup, filter, and HAR-capture follow-ups with session preservation and sensitive path/query suppression.

### Changed
- Release smoke guidance now uses bounded extension-focused prompts with `--no-skills` for Sauce Demo validation, keeping skill-enabled dogfood/report routing as a separate test mode.
- Network diagnostics preserve app page/ref context so request-detail and `networkSourceLookup` URLs do not replace the active browser target or stale current-page refs.

### Fixed
- Narrowed the `eval --stdin` empty-result hint so valid empty array results no longer warn like uninvoked function snippets that serialize to `{}`.

## 0.2.30 - 2026-05-18

### Added
- Current-snapshot ref fallback for locator misses: raw `find` and compiled `semanticAction` selector misses can now surface exact visible `@ref` retry actions when a fresh snapshot shows the intended control.
- Public Sauce Demo checkout smoke guidance for validating natural browser workflows, artifact paths, and final-action stop boundaries before release.
- Efficiency benchmark coverage for multi-ref extraction workflows.

### Changed
- Reduced wrapper-induced click fragility by replacing serial post-click title/URL probes with one read-only navigation summary eval and limiting tab-list pinning/correction probes to sessions with observed drift risk.
- Allowed same-snapshot form-fill batching: `fill @e…` remains stale-ref guarded but no longer invalidates later same-snapshot fills before the first click/submit/navigation row.
- Tightened browser playbook guidance for signed-in profile use, multi-value extraction, exact requested artifact paths, and explicit order/post/purchase/submit stop boundaries.

### Fixed
- Removed stale release/support documentation notes after the post-`v0.2.29` review and kept command-reference, support-matrix, README, and tool-contract guidance aligned with the current wrapper behavior.

## 0.2.29 - 2026-05-18

### Changed
- Updated the local pi package baseline to `@earendil-works/*` `0.75.3`, including the Node.js `>=22.19.0` runtime floor and refreshed npm lockfile.
- Removed tracked CueLoop runtime state from the repository and ignored local `.cueloop/` artifacts.


## 0.2.28 - 2026-05-15

### Added
- Compact runtime guidance now points agents to the installed package's `README.md`, `docs/COMMAND_REFERENCE.md`, and `docs/TOOL_CONTRACT.md` for on-demand detail instead of injecting the full browser playbook into every browser-oriented turn.
- Successful top-level `scroll` calls can now report `details.scrollNoop`, visible no-op scroll diagnostics, and exact snapshot/screenshot recovery `nextActions` when wrapper-side probes show the viewport and sampled scroll containers did not move.
- Successful explicit combobox-targeted actions can now report `details.comboboxFocus` and exact `snapshot -i`, `press ArrowDown`, and `press Enter` recovery `nextActions` when a focused combobox has explicit `aria-expanded` state but no visible options, including after active-session semanticAction role/name clicks resolve through current visible `@ref`s.
- Successful `record start` / `record restart` calls now warn early with `details.recordingDependencyWarning` when executable `ffmpeg` is missing from the Pi process `PATH`, so agents can fix recording prerequisites before `record stop` needs to encode the WebM.
- `docs/RELEASE.md` now includes a repeatable public Grafana Play stress checklist for dense-dashboard release dogfood without bundling private dogfood/VFR skills or adding a recipe runtime.

### Fixed
- Network request redaction now treats secret-like query and field names such as `sentry_key` and `writeKey` as sensitive in model-visible summaries and details.
- README and command-reference setup notes now call out `ffmpeg` as the external dependency required for recording workflows.

## 0.2.27 - 2026-05-14

### Fixed
- `semanticAction` role/name click, check, and uncheck calls in active sessions now resolve through the current `snapshot -i` refs before execution, preventing hidden duplicate upstream `find` matches from stealing the action while preserving the original target in `details.compiledSemanticAction` and showing the executed ref in `details.effectiveArgs`.
- QA presets now default to `loadState: "domcontentloaded"` and accept explicit `domcontentloaded`, `load`, or `networkidle`, avoiding wrapper watchdog timeouts on analytics-heavy or long-polling docs sites while keeping stricter waits opt-in.
- Network request presentation now shows actionable and benign failed rows before successful rows, so late failures remain visible even when request previews are capped.
- Overlay blocker diagnostics now require strong modal context (`dialog` / `alertdialog`) before suggesting close/dismiss candidates, eliminating noisy warnings after ordinary same-page menu opens or app button mutations.
- Artifact lifecycle cleanup guidance now lists only explicit artifact paths that still exist on disk, skipping deleted/stale paths while preserving the close-does-not-delete reminder.

## 0.2.26 - 2026-05-14

### Added
- artifact lifecycle cleanup guidance (`RQ-0079`): successful `close` results now include `details.artifactCleanup` and a visible `Artifact lifecycle` note when recent artifact metadata exists, making explicit that browser close does not delete user-chosen screenshot/download/PDF/trace/HAR/recording paths and listing paths for host-tool cleanup.
- getter/eval discoverability diagnostics (`RQ-0078`): common unknown getter shortcuts such as `title`, `url`, and `text` now get grouped-`get` guidance (with exact `use-get-title` / `use-get-url` next actions where unambiguous), and function-shaped `eval --stdin` snippets that serialize to `{}` now add visible `Eval stdin hint` plus `details.evalStdinHint` so agents know to pass a plain expression or invoke the function explicitly.
- managed-session outcome diagnostics for failed `sessionMode: "fresh"` calls (`RQ-0077`): failed or timed-out fresh launches now report `details.managedSessionOutcome` and, when the plan used `sessionMode: "fresh"` with a failing outcome, append visible `Managed session outcome: …` text so agents know whether the prior managed session was preserved or no managed session became current.
- timeout partial-progress evidence for long `job` / `qa` / `batch` calls (`RQ-0076`): wrapper watchdog timeouts now add best-effort `details.timeoutPartialProgress` with planned steps, current page title/URL, and declared artifact path checks, and append visible `Timeout partial progress` recovery text.
- QA/network failed-request impact classification (`RQ-0075`): `extensions/agent-browser/lib/results/shared.ts` now separates actionable network failures from benign low-impact browser icon misses such as missing `favicon.ico`, `qa` preserves benign misses as `qaPreset.warnings` instead of failing otherwise healthy smoke checks, and `network requests` presentation includes actionable/benign summary lines plus per-row impact tags. Contract and operator notes live in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`README.md`](README.md), and [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md); regression coverage is in `test/agent-browser.extension-validation.test.ts` and `test/agent-browser.presentation.test.ts`.
- post-success `get text <selector>` visibility diagnostics (`RQ-0074`): after a successful `get text` on a non-`@ref` CSS selector, `extensions/agent-browser/index.ts` may run an extra read-only `eval --stdin` probe (`buildVisibleTextProbeScript`), merge `details.selectorTextVisibility` (and `selectorTextVisibilityAll` when several batched selectors qualify), prepend `Selector text visibility warning` lines to visible text, and append `inspect-visible-text-candidates` next actions carrying the same probe script in `stdin`; skipped for `@e…` refs and for selectors whose string would leak secrets after redaction or match sensitive attribute-literal heuristics. Contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), operator notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), maintainer checklist in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); regression `agentBrowserExtension warns when get text may read hidden selector matches` in [`test/agent-browser.extension-validation.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-validation.test.ts)
- optional `semanticAction.session` on native `agent_browser`: compiles to a leading `--session <name>` pair before upstream `find` argv so the locator shorthand targets a named upstream browser session instead of the extension-managed default; `buildExecutionPlan` skips implicit `--session` injection when argv already starts with `--session`; successful unified results echo `details.sessionName`; `retry-semantic-action-after-stale-ref` copies the compiled argv including that prefix, and bounded `try-*-candidate` next actions preserve the same session prefix from `getCompiledSemanticActionSessionPrefix` in `extensions/agent-browser/index.ts`. Contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) and [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#sessionmode); operator notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#direct-subprocess-execution); playbook line in `extensions/agent-browser/lib/playbook.ts`; regression coverage in `test/agent-browser.extension-validation.test.ts`
- bounded `selector-not-found` recovery for top-level `semanticAction`: when the wrapper still has `details.compiledSemanticAction`, `extensions/agent-browser/index.ts` may append `try-*-candidate` entries to `details.nextActions` and an `Agent-browser candidate fallbacks` block in visible text for specific `fill`/`click` locator pairs (`placeholder`, `text`, `label` only; not `select`); contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) and [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), operator notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#direct-subprocess-execution), playbook line in `extensions/agent-browser/lib/playbook.ts`, regression coverage in `test/agent-browser.extension-validation.test.ts`
- compact oversized `snapshot` output now documents the `Omitted high-value controls` prose block and matching `details.data.highValueControlRefIds` (plus related compact snapshot metadata) in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#snapshot), [`README.md`](README.md), and generated playbook guidance from `extensions/agent-browser/lib/playbook.ts`, with implementation in `extensions/agent-browser/lib/results/snapshot.ts` and regression coverage in `test/agent-browser.presentation.test.ts`

### Changed
- documentation for `RQ-0077` managed-session outcomes now matches `buildManagedSessionOutcome` / `formatManagedSessionOutcomeText`: when the visible `Managed session outcome: …` line is emitted (including ordering after other diagnostic tails per `rawAppendedDiagnosticText` in `extensions/agent-browser/index.ts`, and the missing-binary-only case), how `details.managedSessionOutcome` behaves after **`qa`** reclassification, and that `"auto"` failures can populate `details` without the extra prose line; updates in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`README.md`](README.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#session-model), [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), and this changelog.
- documentation for `RQ-0076` timeout partial progress now matches `collectTimeoutPartialProgress` / `formatTimeoutPartialProgressText` in code: compiled `qa` shares the `job` step-list path; otherwise planned steps come from JSON-array `batch` stdin (caller-provided or wrapper-generated for `sourceLookup` / `networkSourceLookup`), only when each element is a string[] argv row; optional planned-URL fallback and `PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS` watchdog tuning are called out in [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`README.md`](README.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) now documents `timeoutPartialProgress.summary`, the batch stdin parse rule, the six-step cap on visible `Planned steps` lines, and the `0/0` declared-path count when only page context is recovered.
- batch stdin page-scoped ref preflight clears the ref-invalidating latch when a later `snapshot` step appears in the same JSON plan (`getBatchRefInvalidationMessage` in `extensions/agent-browser/index.ts`), matching documented `snapshot -i` spacing inside `batch`; contract expanded under [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) (`refSnapshot`); regression `agentBrowserExtension allows batch stdin ref steps after snapshot following an invalidating step` in [`test/agent-browser.extension-validation.test.ts`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/test/agent-browser.extension-validation.test.ts)

### Fixed
- explicit `--json` calls keep machine-readable visible content parseable even when the wrapper attaches extra diagnostic structs such as `details.evalStdinHint`; diagnostic guidance remains available on `details` without being appended after the JSON payload.
- overlay blocker candidate actions (`try-overlay-blocker-candidate-*`) no longer appear under the semantic-action `Agent-browser candidate fallbacks` heading; that prose is now limited to the bounded semantic locator fallback ids.
- packaged Pi smoke now forces its temporary `npm pack` to write a tarball even when invoked from `npm publish --dry-run`, so the release lifecycle dry run validates the same smoke path instead of inheriting npm's outer dry-run mode.

## 0.2.25 - 2026-05-14

### Added
- [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) as the durable upstream support and release-readiness matrix keyed to `CAPABILITY_BASELINE.inventorySections` in `scripts/agent-browser-capability-baseline.mjs`, including maintainer refresh steps, verification gate evidence, and per-inventory documentation/runtime/test pointers; cross-linked from [`README.md`](README.md), [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`docs/RELEASE.md`](docs/RELEASE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and the published tarball `files` list in `package.json`
- machine-readable `details.nextActions` id `retry-semantic-action-after-stale-ref` when a top-level `semanticAction` call fails with `failureCategory: "stale-ref"` and the wrapper still has the compiled upstream `find` argv: it is appended after `refresh-interactive-refs` so agents can retry the same locator-stable target without hand-rebuilding argv, while direct stale `@e…` flows keep snapshot-only recovery; merged in `extensions/agent-browser/index.ts`, documented in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction) and [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), agent playbook string in `extensions/agent-browser/lib/playbook.ts`, regression coverage in `test/agent-browser.extension-validation.test.ts`
- optional top-level `semanticAction` on native `agent_browser` as a mutually exclusive alternative to `args`, compiling common locator intents into upstream `find` argv and echoing `{ action, locator, args }` (redacted like other argv) in `details.compiledSemanticAction` when the unified or early-validation `details` object includes that field; contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#semanticaction), compilation in `extensions/agent-browser/index.ts` (`compileAgentBrowserSemanticAction`), regression coverage in `test/agent-browser.extension-validation.test.ts`
- bounded machine-readable outcome fields on native `agent_browser` tool `details`: `resultCategory` (`success` | `failure`) with `successCategory` or `failureCategory` for stable agent branching without parsing prose; contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), types and classifiers in `extensions/agent-browser/lib/results/shared.ts`, regression coverage in `test/agent-browser.results.test.ts` and related extension tests
- optional `details.pageChangeSummary` (and per-step `batchSteps[].pageChangeSummary` on `batch`) with `changeType`, human-readable `summary`, optional `title`/`url`, artifact hints, and `nextActionIds` aligned to `details.nextActions`; assembly in `extensions/agent-browser/lib/results/presentation.ts` (`buildPageChangeSummary`, `PAGE_CHANGE_SUMMARY_COMMANDS`); contract and examples in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), regression coverage in `test/agent-browser.presentation.test.ts` and `test/agent-browser.extension-validation.test.ts`
- optional experimental top-level `sourceLookup` on native `agent_browser` (mutually exclusive with `args`, `semanticAction`, `job`, and `qa`) that compiles to upstream `batch` steps (`is visible`, `get html`, `react inspect`, and `react tree` when the corresponding fields are set), performs a bounded workspace component scan under the Pi session cwd when `componentName` is present, and merges structured `details.sourceLookup` (`status`, `candidates`, `limitations`, `summary`) plus `details.compiledSourceLookup` for observability; `details.sourceLookup.status` distinguishes `candidates-found`, `no-candidates`, and `unsupported` (the last only when no candidates were collected and a `react` batch step failed). Operator and agent contracts in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#sourcelookup), [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/RELEASE.md`](docs/RELEASE.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); compilation and post-batch analysis in `extensions/agent-browser/index.ts` (`compileAgentBrowserSourceLookup`, `analyzeSourceLookupResults`); regression coverage in `test/agent-browser.extension-validation.test.ts` and a representative scenario in `scripts/agent-browser-efficiency-benchmark.mjs`

### Changed
- documented closed `RQ-0068` (no first-class reusable named browser recipe runtime above constrained `job`, the `qa` preset, experimental `sourceLookup` / `networkSourceLookup`, and raw `batch`): evidence bar tied to deterministic efficiency-benchmark scenario ids in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet), operator and maintainer cross-links in [`README.md`](README.md), [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md), and agent playbook guidance in `extensions/agent-browser/lib/playbook.ts`
- presentation layer treats `cookies`, `storage`, `auth`, `dialog`, `frame`, and `state` as stateful: successful `details.data` and per-step `batch` results pass through field-aware or full-tree redaction, argv echo uses `redactInvocationArgs` for cookie/storage set values, failed batch steps strip the same literals from structured errors, and aggregate `batch` tool calls expose a compact redacted `details.data` roll-up—documented in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#use-stateful-browser-context-commands-safely), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/RELEASE.md`](docs/RELEASE.md), [`README.md`](README.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), with regression coverage in `test/agent-browser.presentation.test.ts` and `test/agent-browser.extension-validation.test.ts`
- documented real-upstream suite mechanics (single 120s contract test, output-shape JSON, temp `HOME` / socket / screenshot isolation, React DevTools branch) plus triage notes in [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-suite-mechanics-isolation-and-troubleshooting); cross-links from [`README.md`](README.md) and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- expanded the opt-in `npm run verify -- real-upstream` contract (`PI_AGENT_BROWSER_REAL_UPSTREAM=1`) across `test/agent-browser.real-upstream-contract.test.ts`, `test/fixtures/agent-browser-real-output-shapes.json`, and `test/helpers/agent-browser-harness.ts` (broader core command matrix, `batch` stdin, `pushstate`, `vitals … --json`, `network route … --abort --resource-type`, `cookies set --curl`, missing-renderer `react tree`, and `wait --download` metadata versus on-disk presence); added a separate fast fake-upstream argv matrix in `test/agent-browser.extension-validation.test.ts` for additional passthrough commands (`connect`, `download`, `get url`, `snapshot --compact`, `tab` lifecycle); maintainer inventory and caveat notes in [`docs/RELEASE.md`](docs/RELEASE.md#real-upstream-contract-validation), high-level summaries in [`README.md`](README.md) and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), and `scripts/project.mjs` verify help
- read-only `skills list`, `skills get …`, and `skills path …` now share the same implicit-session behavior as plain-text `--help` / `--version` probes: `buildExecutionPlan` still prepends `--json`, but under default `sessionMode: "auto"` it does not inject the extension-managed implicit `--session`, so bundled skill text can be loaded without pinning or rotating the active browser session; allowlisting lives in `extensions/agent-browser/lib/runtime.ts` (`isStatelessInspectionCommand`), with regression coverage in `test/agent-browser.runtime.test.ts` and `test/agent-browser.extension-validation.test.ts`, operator-facing notes in [`README.md`](README.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#built-in-skills), [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- `-p`, `--provider`, and `--device` are now modeled as launch-scoped flags in `LAUNCH_SCOPED_FLAG_DEFINITIONS` (`extensions/agent-browser/lib/runtime.ts`), so implicit `sessionMode: "auto"` reuse fails fast with the same `sessionRecoveryHint` / `sessionMode: "fresh"` guidance as profile, CDP, and state launches when those selectors would otherwise be ignored on an active managed session; contract and operator docs updated in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md), [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`README.md`](README.md), and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), with argv matrices in `test/agent-browser.extension-validation.test.ts` and planning assertions in `test/agent-browser.runtime.test.ts`
- `test/agent-browser.process.test.ts` now asserts representative provider and iOS credential env vars (`AGENT_BROWSER_IOS_DEVICE`, `AGENT_BROWSER_IOS_UDID`, `AGENTCORE_API_KEY`, `BROWSERBASE_PROJECT_ID`) reach the upstream child alongside existing `AGENT_BROWSER_*` and provider-prefix forwarding documented in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md) and [`docs/COMMAND_REFERENCE.md`](docs/COMMAND_REFERENCE.md#output-provider-policy-and-ai-flags)
- added a concrete `details.nextActions` JSON example in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) for the `refresh-interactive-refs` + `retry-semantic-action-after-stale-ref` chain on semantic `stale-ref` failures, aligned with `extensions/agent-browser/index.ts` and `extensions/agent-browser/lib/results/shared.ts`
- documented how `npm run docs` differs from the default `npm run verify` gate, and linked checkout maintainers to `AGENTS.md` for capability baseline rebaselining and operational testing notes alongside the shipped `docs/` set
- linked [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to the stable `agent_browser` result-category contract in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md#details) and the TypeScript source in `extensions/agent-browser/lib/results/shared.ts`
- `package.json` `prepublishOnly` now runs `npm run verify -- release` before `npm pack --dry-run`, so publishes enforce packaged Pi smoke and the same live upstream command-reference sampling as [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks); orchestration is the `release` mode in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs), with operator-facing notes in [`README.md`](README.md)
- release guidance now requires `tmux`-driven live-site Pi dogfood with the native `agent_browser` tool before every release, with cleanup and evidence recording expectations in [`docs/RELEASE.md`](docs/RELEASE.md#pre-release-checks) and [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md)
- aligned maintainer wording so configured-source lifecycle (`npm run verify -- lifecycle`) is documented as a pre-publish requirement across [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md), [`README.md`](README.md), [`docs/RELEASE.md`](docs/RELEASE.md), and [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md), while noting it remains a separate `verify` mode from the default gate in [`scripts/project.mjs`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/scripts/project.mjs)
- release-readiness cross-links: `package.json` `prepublishOnly` called out next to the verification facade in [`AGENTS.md`](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/AGENTS.md); configured-source lifecycle plus publish-time `release` gate summarized under local validation modes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); configured-source harness subsection in [`docs/RELEASE.md`](docs/RELEASE.md) explicitly ties to [Pre-release checks](docs/RELEASE.md#pre-release-checks)

## 0.2.24 - 2026-05-11

### Added
- added custom `agent_browser` TUI rendering with colorized call/output text and built-in-style visual truncation for long visible output while preserving model-facing tool content

## 0.2.23 - 2026-05-10

### Fixed
- added safe `auth save --password-stdin` support for native tool calls and redacted password stdin from model-visible content, tool details, upstream failure output, and preserved parse-failure spill files
- improved session and launch-flag handling for agent workflows, including disabled `--auto-connect`, optional boolean flag values, dash-starting `--args` values, and stale `@ref` recovery guidance through pinned commands and user batch stdin
- expanded sensitive argument redaction for password and credential command forms

### Changed
- rewrote the public README around outcome-first usage, fastest install paths, profile/auth workflow guidance, and release verification proof
- clarified native-tool command guidance for password stdin, cookie/privacy handling, stable tab ids, and explicit session persistence limits

## 0.2.22 - 2026-05-07

### Compatibility
- migrated the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`
- regenerated the npm lockfile against the current stable dependency graph and confirmed package verification remains green

## 0.2.21 - 2026-05-07

### Fixed
- fixed the published `pi-agent-browser-doctor` bin entrypoint so it runs when invoked through npm's `.bin` symlink

## 0.2.20 - 2026-05-07

### Compatibility
- updated the extension's upstream capability baseline and command reference for `agent-browser` `0.27.0`
- documented and passed through the new React introspection commands (`react tree`, `react inspect`, `react renders`, `react suspense`), Web Vitals (`vitals`), SPA navigation (`pushstate`), init-script flags (`--init-script`, `--enable react-devtools`), `network route --resource-type`, and `cookies set --curl`
- treat `--init-script` and `--enable` as launch-scoped flags in managed-session planning so agents get the same clear `sessionMode: "fresh"` recovery path as profile/state/CDP launches

## 0.2.19 - 2026-05-03

### Fixed
- resolve relative Pi package sources from the settings file directory in `pi-agent-browser-doctor`, so global settings that point at a local checkout are detected correctly

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
