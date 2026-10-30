# pi-agent-browser-native

pi-agent-browser-native adds browser tools to [Pi](https://pi.dev). Use it to read pages, test web apps, and save screenshots through [agent-browser](https://agent-browser.dev/).

![A prompt in Pi becomes a native browser tool call. The separately installed agent-browser CLI controls a browser and returns page observations and file artifacts.](.github/readme/browser-flow.png)

## Install and start

Use Node 24.21.0 or later and Pi 1.0.0 or later. This extension requires a separate agent-browser installation.

The recommended agent-browser version is 0.39.2. This extension accepts stable versions 0.35.0 or later. See the [0.39.2 command guide](docs/COMMAND_REFERENCE.md#upstream-0392-rebaseline) for CLI HTTPS trust, experimental Obscura, and inspect-before-retry outcomes.

```bash
npm install -g agent-browser
agent-browser install
pi install npm:pi-agent-browser-native
pi
```

`agent-browser install` downloads Chrome for Testing. On Linux, use `agent-browser install --with-deps` if browser libraries are missing. Android users need the [Termux setup](docs/REFERENCE.md#android--termux).

Ask Pi:

```text
Open https://example.com with agent_browser.
Take an interactive snapshot.
Save a screenshot to /tmp/example.png.
Close the browser when finished.
```

After a package update, quit Pi fully. Start Pi again to load the new tools. `/reload` can retain the previous compiled code.

Existing browser-bearing conversations resume automatically at their original journal path, without rewriting history or running a converter. See [session storage](docs/SESSION_STORAGE.md#resuming-a-retained-legacy-journal) for replay and recovery limits.

Read the [command reference](docs/COMMAND_REFERENCE.md) for your next browser task.

## Browser tools

Describe the task in your conversation. Pi can click controls, fill forms, check text and URLs, and save files.

| Tool                       | Use                                                           |
| -------------------------- | ------------------------------------------------------------- |
| `agent_browser`            | Browser commands and fixed `batch --bail` sequences           |
| `agent_browser_code`       | JavaScript loops and branches in the same browser             |
| `agent_browser_tools`      | Enable action, QA, Electron, source, and network-source tools |
| `agent_browser_web_search` | Optional Exa or Brave search through provider APIs            |

For example, Pi opens and inspects a page with these calls:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
```

Snapshots give Pi current `@eN` references for controls. Refresh the snapshot after navigation or page changes. Check the resulting page after a click; command success alone does not prove the app changed.

For a trial without a saved package setting, run:

```bash
pi --no-extensions -e npm:pi-agent-browser-native
```

This command loads this extension explicitly and disables automatic extension loading. Other Pi settings and resource types still apply.

## Profiles and privacy

Ordinary calls use one named browser per root Pi session. A parent and its subagents share that browser. Separate roots get separate browser names.

Shared root browsers survive Pi exit. Ask Pi to close your group's browser when finished.

Profile access exposes private page content to the model. That content can persist in transcripts and saved files. Use temporary profiles for tests.

Credential-like values are redacted, but ordinary page text stays visible. Verify the signed-in page after you select a profile or restore browser state.

Native `batch --omit-command` keeps indexed results without echoed commands. Cookie/storage redaction, ordered close/reopen effects, snapshot refs, and artifact verification still apply, including when empty stdin rows are skipped.

Ask for a headed browser if you need to watch a task or complete a login. Remote environments can keep the window off your desktop.

See [profiles and sessions](docs/REFERENCE.md#authenticatedprofile-workflows) for profile selection, restore limits, and cleanup.

## Optional search and settings

To enable web search, set `EXA_API_KEY` or `BRAVE_API_KEY` before you start Pi. Exa is the default when both keys work. Provider charges apply.

Set provider preferences and browser defaults in `~/.pi/config/pi-agent-browser-native/config.json`. Trusted projects can use `.pi/config/pi-agent-browser-native/config.json`. `PI_AGENT_BROWSER_CONFIG` selects an override file.

Malformed config files and search-provider JSON report errors without parser previews that could expose credentials, and search-provider HTTP failures report only the status with a fixed hint.

Read [configuration examples](docs/REFERENCE.md#optional-package-config-and-web-search) for secret references, provider selection, and profile defaults.

## Troubleshooting and limits

Run the read-only health check:

```bash
npm exec --package pi-agent-browser-native -- pi-agent-browser-doctor
```

It checks the browser CLI, supported versions, and duplicate Pi package sources. It does not change settings.

For browser execution coordination failures, launch Pi with Node's standard `NODE_DEBUG=pi-agent-browser-policy` environment setting (PowerShell: `$env:NODE_DEBUG = 'pi-agent-browser-policy'`). This optional channel is silent by default and writes failure-stage breadcrumbs to stderr, not tool results. Lines carry Node's PID plus an opaque per-process attempt number and acquisition or release phase (cleanup has separate stage labels); standalone library inspections use attempt `0`. They contain fixed reasons and normalized native error codes/syscalls, never claim contents, paths, session names, or process-start identities. Normal choosing-state missing tickets and confirmed disappearing claims are quiet. A release/cleanup breadcrumb alone does not explain an acquisition failure. Unset `NODE_DEBUG` after collecting diagnostics; these observations do not change coordination policy or budgets.

This is a pre-1.0 package. **Native Windows is best-effort**, not a required PR or release qualification target. macOS/Linux and official/fork host/API qualification remain strict. Windows has unresolved browser session-locking and restored Electron cleanup test failures; a small nonblocking native CI smoke is not full qualification, and broader Windows suites are explicitly on demand. Release tests do not cover Android. Electron desktop tools do not apply to Android apps. See the [support matrix](docs/SUPPORT_MATRIX.md) for details.

For recordings, install `ffmpeg` with the encoder for your WebM or MP4 output. Verify the completed file after you stop the recording.

For remote browsers, use a URL that the browser host can reach. `localhost` refers to the browser host.

Preparatory tab/page checks do not launch a stopped caller-owned explicit `--session` ahead of its launch-flagged command, including after resume. After dispatch, the old browser's tab identity and refs are retired. A successful command observes the replacement page before follow-ups; if it cannot be observed, the target stays unknown. Put launch flags on the launch command; an already-running browser may ignore them.

For stale references or unexpected tabs, follow the returned recovery actions. Take a fresh snapshot before another interaction. A snapshot inside a batch does not protect refs used after a later page-changing step; add another snapshot after that step or split the batch.

## More documentation

- [Detailed reference](docs/REFERENCE.md): platform setup, browser examples, compatibility notes, and development checks.
- [Tool contract](docs/TOOL_CONTRACT.md): exact inputs, results, code limits, and image geometry.
- [Electron guide](docs/ELECTRON.md): desktop discovery, isolated launch, and cleanup.
- [Session storage](docs/SESSION_STORAGE.md): replay, large histories, and session conversion.
- [Architecture](docs/ARCHITECTURE.md): extension design.
- [Performance](docs/PERFORMANCE.md): measured baselines, improvements, and reproducible profiling.
- [Code quality](docs/CODE_QUALITY.md) and [release process](docs/RELEASE.md): maintainer procedures.

## License

[MIT](LICENSE). Copyright Mitch Fultz.
