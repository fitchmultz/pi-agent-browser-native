# First-class token-efficient Electron support: Plan

**Date:** 2026-05-20
**Status:** Implemented; final verification/fix pass complete

## Goal

Make Electron desktop apps a first-class, token-efficient target for the
`agent_browser` Pi extension. Today, agents must drive a hand-built dance —
discover the app, build a temp profile, launch with `--remote-debugging-port`,
poll `/json/version`, `connect`, then manually clean up — and then drive
state-probing snapshots that dump VS Code chrome instead of the parts the agent
actually needs. The plan reshapes that into a small, safe, evidence-gated set
of wrapper shorthands and presentation features so an Electron dogfood run
costs few calls and produces clear proof, without breaking the thin-wrapper
posture or the closed `RQ-0068` no-recipe-layer decision.

## Background

### Architectural constraint: `RQ-0068` is the gating decision

A reusable browser-recipe runtime is **not** adopted. Quote from
`docs/ARCHITECTURE.md:53–64`:

> Do **not** add reusable browser recipes as a first-class runtime surface
> yet. … Revisit this only when benchmark or dogfood data shows at least two
> repeated, failure-prone job sequences that cannot be represented clearly by
> `job`, `qa`, or raw `batch`. If that happens, define ownership, versioning,
> schema boundaries, generated docs, and tests before adding executable
> recipes.

Closed in `docs/SUPPORT_MATRIX.md:73`. The Electron-feedback dogfood report is
the evidence that satisfies the revisit trigger: it documents repeated,
failure-prone Electron sequences (app discovery, CDP launch, state probe,
cleanup) that `job`/`qa`/`batch` cannot represent cleanly. The plan must
ship paired with explicit owner / versioning / test / benchmark / docs
artifacts, mirroring how each prior shorthand (`qa`, `sourceLookup`,
`networkSourceLookup`) was added — not as a generic recipe runtime.

Related precedents that shape ownership and scope:

- `RQ-0079` — artifact cleanup stayed host-owned. Maps directly to "if the
  wrapper launched the Electron app, the wrapper cleans up; otherwise the
  user owns it."
- `RQ-0080` — no-op scroll diagnostics. Precedent for adding wrapper-side
  diagnostic detection (sample → detect → emit `details.*` + `nextActions`)
  without a recipe runtime.
- `RQ-0072`/`RQ-0086`/`RQ-0087` — page-scoped refs, profile-restore tab drift,
  same-snapshot form fills. Precedent for wrapper-managed per-session state.
- `RQ-0083` — Grafana stress checklist instead of bundling private skills.
  Precedent for documenting workflows rather than bundling them.

### Existing shorthand pattern (the integration shape)

Five top-level shorthand modes share one compile/route/analyze/present
pattern; a new Electron mode follows the same shape. Load-bearing seams:

- **Schema and routing:** TypeBox schema at
  `extensions/agent-browser/index.ts:262–352`; compile helpers at
  `:386–486` (job), `:505–570` (qa), `:572–651` (sourceLookup),
  `:814–839` (networkSourceLookup), `:1238–1306` (semanticAction);
  mutual exclusion at `:4073–4102`.
- **Pre-spawn planning:** `buildExecutionPlan` at
  `extensions/agent-browser/lib/runtime.ts:984–1138` (pre-spawn only;
  wrapper-virtual subcommands must intercept before it or bypass
  upstream entirely).
- **Persisted state restore:** `restoreSessionRefSnapshotsFromBranch`
  at `index.ts:2467` (read site `:4004`),
  `extractRefSnapshotFromData` at `:2445`.
- **Managed-session outcome:** `buildManagedSessionOutcome` at
  `index.ts:3767`, `formatManagedSessionOutcomeText` at `:3825`.
- **Presentation:** `buildToolPresentation` at
  `extensions/agent-browser/lib/results/presentation.ts:2357`.
- **Tests:** existing shorthand describes in
  `test/agent-browser.extension-validation.test.ts:1499/1654/1734/1851/1918`;
  category/next-action tests in `test/agent-browser.results.test.ts`;
  runtime in `test/agent-browser.runtime.test.ts`; presentation in
  `test/agent-browser.presentation.test.ts`.
- **Doc/playbook/benchmark touchpoints** required for every shorthand
  (`AGENTS.md:72–103`): `docs/TOOL_CONTRACT.md`,
  `docs/COMMAND_REFERENCE.md`, `README.md`,
  `extensions/agent-browser/lib/playbook.ts`,
  `scripts/agent-browser-efficiency-benchmark.mjs`,
  `docs/SUPPORT_MATRIX.md` (new `RQ-####` row).

### Upstream baseline (`agent-browser 0.27.0`)

Upstream already provides what we need to compose against: `connect
<port|url>`, the launch-scoped `--cdp <port|url>` flag (modeled in
`LAUNCH_SCOPED_FLAG_DEFINITIONS` at `lib/runtime.ts:33–74`),
`--auto-connect`, `tab` / `tab <n>` (webviews surface as
`type: "webview"`), and the full `snapshot -i/-c/-d/-s/-u`,
`find role|text|label`, `is visible|enabled|checked`, `get *`, and
`errors` surface.

What does **not** exist upstream and would have to be wrapper-side:
Electron discovery/launch/cleanup, compact state-summary probe, snapshot
role/name/region filters, `find --preview`, `batch --summary`, native
current-session `qa` (the existing `qa` is wrapper-only here), and
native assertions.

The upstream
[`skill-data/electron/SKILL.md`](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skill-data/electron/SKILL.md)
skill is text-only — it documents the manual
`open --args --remote-debugging-port=9222` → `connect` → `snapshot -i`
sequence, but provides no discovery, isolation, or cleanup helpers.

### External CDP guidance (summary)

Key choices the Approach inherits from current Electron / CDP /
Chrome-security guidance (full citations in References):

- Use `--remote-debugging-port=0` + `$USER_DATA_DIR/DevToolsActivePort`
  to avoid port collisions.
- Custom `--user-data-dir` is the strongest isolation primitive (Chrome
  136+ requires non-default user data dir for remote debugging).
- macOS: scan `Contents/Frameworks/Electron Framework.framework`;
  rebranded helpers may rename. Linux: see the Approach's scan rules.
- Many Electron apps enforce single-instance and silently drop the
  `--remote-debugging-port` flag on second launch — must detect and
  refuse cleanly.
- Keep the wrapper thin: upstream `agent-browser` provides CDP attach
  via `connect`/`--cdp`; in-house discovery + launch + cleanup is
  enough, and we don't bundle `chrome-remote-interface` or
  `puppeteer-core`.

## Approach

### Decision: top-level `electron: {...}` shorthand, not pseudo-argv

Add a new top-level shorthand object that follows the `qa`/`job` pattern.
**Do not** intercept `args: ["electron", "list"]` before `buildExecutionPlan`
in v1. Pseudo-argv would bypass the established TypeBox schema + mutual
exclusion + docs/tests flow without a clear benefit; the established shape
already gives us typed inputs, redactable compiled output, and a uniform
contract surface.

### Lifecycle ownership

Wrapper-virtual subcommands (`list`, `status`, `cleanup`) **bypass** the
upstream-spawn path — they do host-side work and emit a unified result
shape directly. `launch` is hybrid: it performs host-side discovery /
profile / process work, then enters the existing upstream path by composing
`agent-browser connect <webSocketDebuggerUrl-or-port>` (and optionally
`tab list` / `snapshot -i`) so the launched app becomes the managed session
for follow-up calls.

Cleanup is **host-owned for wrapper-launched apps only**, mirroring
`RQ-0079`'s decision for artifacts: `cleanup` operates on tracked
`launchId`s the wrapper created, never on externally-launched debug ports
or other Electron processes. Raw `agent-browser connect <port>` remains
available for "I launched it manually, just attach."

### Safety posture

**Security is user-owned, not wrapper-enforced.** The wrapper ships safe
isolation defaults and gives the user customization knobs; it does **not**
classify apps as high-risk or refuse to launch them.

Wrapper-enforced defaults (non-negotiable):

- Always launch with isolated `--user-data-dir=<temp>` and
  `--remote-debugging-port=0` (read `DevToolsActivePort` after spawn).
- Default to `--disable-extensions --no-first-run --no-default-browser-check`.
- Reuse the existing presentation redaction layer for any echoed `appArgs`,
  CDP URLs, and target metadata.
- Reject `electron.launch` only when the wrapper cannot find Electron
  framework evidence at the target — i.e., refuse to blindly launch a
  non-Electron executable as one. This is a correctness gate, not a
  security gate.

User-owned customization (optional `electron.allow` / `electron.deny`):

- Both lists accept app identifiers (`appName`, `bundleId`, or substring
  match on `appPath`).
- If `allow` is set, only matching apps may launch.
- If `deny` is set, matching apps cannot launch.
- If both are set, `deny` wins on conflict.
- Default behavior with neither set: **launch is permitted**.
- Lists are configurable per call via `electron.allow` / `electron.deny`
  arrays; persistence across calls is not in scope for v1 (the user's
  agent prompt or scripts hold the policy).

Chrome's 2025 remote-debugging security warning is documented in
`README.md` and `docs/TOOL_CONTRACT.md`; the wrapper's responsibility is
to give the user honest tools, not to override their judgment.

### MVP shorthand shape

```ts
electron: {
  action: "list" | "launch" | "status" | "cleanup",

  // list
  query?: string,
  maxResults?: number,

  // launch target (exactly one)
  appPath?: string,
  appName?: string,
  bundleId?: string,
  executablePath?: string,

  // launch behavior
  appArgs?: string[],
  handoff?: "connect" | "tabs" | "snapshot",   // default "snapshot"
  targetType?: "page" | "webview" | "any",     // default "page"
  timeoutMs?: number,                          // bounded; default chosen in implementation

  // safety (user-owned, optional)
  allow?: string[],   // app identifiers permitted; if set, only these may launch
  deny?: string[],    // app identifiers blocked; takes precedence over allow

  // status / cleanup
  launchId?: string,
  all?: boolean
}
```

Validation rules:

- `electron` is mutually exclusive with `args`, `semanticAction`, `job`,
  `qa`, `sourceLookup`, and `networkSourceLookup` (mode-count update at
  `extensions/agent-browser/index.ts:4078–4092`).
- Caller `stdin` is rejected alongside `electron`.
- `launch` requires exactly one of `appPath`, `appName`, `bundleId`, or
  `executablePath`.
- `launch` is rejected only when the resolved target lacks Electron
  framework evidence (correctness, not safety).
- Optional `allow` / `deny` lists are user-supplied; default behavior is
  to permit launch.
- `cleanup` only operates on wrapper-tracked launches.

### Lifecycle data flow

**`electron.list`** (host-only, no upstream spawn):

1. Scan platform app locations (macOS MVP: `/Applications/*.app` and
   `~/Applications/*.app`).
2. Detect Electron by `Contents/Frameworks/Electron Framework.framework`
   AND (`Contents/Resources/app.asar` OR `Contents/Resources/app/`).
3. Parse bounded metadata: name, bundle id, paths, platform tag.
4. Return visible list and `details.electron.apps`.

**`electron.launch`** (host + upstream compose):

1. Resolve target via `appPath` / `appName` / `bundleId` / `executablePath`.
2. Verify Electron framework evidence at the resolved target; reject
   non-Electron targets with a clear error.
3. Apply optional user-supplied `allow`/`deny` lists; on mismatch, reject
   with a clear `policy-blocked` failure category and surface which list
   matched.
4. Create secure temp `userDataDir`.
5. Launch with `--remote-debugging-port=0`, `--user-data-dir=<temp>`,
   `--disable-extensions`, `--no-first-run`, `--no-default-browser-check`,
   plus sanitized `appArgs`.
6. Poll `<userDataDir>/DevToolsActivePort` until populated (bounded by
   `timeoutMs`; polling cadence is an implementation choice).
7. Read `http://127.0.0.1:<port>/json/version` + `/json/list`.
8. Run upstream `agent-browser connect <webSocketDebuggerUrl|port>`
   through the existing process and presentation path with
   `sessionMode: "fresh"`; capture managed session.
9. Persist launch record `{ launchId, port, userDataDir, pid?,
   sessionName, webSocketDebuggerUrl?, createdAtMs, cleanupState }` in
   the same persisted-details branch used by `details.refSnapshot`.
   Concretely: extend the loop in `restoreSessionRefSnapshotsFromBranch`
   (`extensions/agent-browser/index.ts:2467`, read-site `:4004`) to
   also surface a sibling `Map<launchId, ElectronLaunchRecord>`. The
   launch record's lifecycle is per-process and outlives snapshot
   churn, so it needs its own map keyed off `launchId` rather than
   being threaded through `extractRefSnapshotFromData`
   (`index.ts:2445`).
10. Apply handoff: `"connect"` stops after attach; `"tabs"` adds
    session-scoped `tab list`; `"snapshot"` adds `tab list` +
    `snapshot -i` and uses the existing compaction path.
11. Emit `details.compiledElectron`, `details.electron`,
    `details.nextActions`.

Note: `port` is not a user-supplied field in v1. Always use
`--remote-debugging-port=0` and discover the OS-chosen port via
`DevToolsActivePort`. Fixed ports collide between concurrent launches
and make cleanup ambiguous when the same port is reused after a crash.

Treat the new launch internally as a `sessionMode: "fresh"` event for the
embedded `connect` call. Concretely: when `electron.launch` invokes upstream
`connect`, route it through the existing `buildExecutionPlan` path
(`extensions/agent-browser/lib/runtime.ts:984–1138`) with
`sessionMode: "fresh"`, so the implicit-session machinery and
`buildManagedSessionOutcome` (`index.ts:3767`) /
`formatManagedSessionOutcomeText` (`index.ts:3825`) handle outcome
reporting and `RQ-0077` obligations the same way they handle any other
fresh launch. The wrapper does **not** synthesize an outcome record
separately.

**`electron.status`** (host + read-only upstream optional):

- Look up wrapper registry by `launchId` (or single active launch).
- Verify port liveness via `/json/version`.
- Optionally fold in bounded `tab list` / `errors` reads.
- Never mutate app state.

**`electron.cleanup`** (wrapper-owned only):

1. If a tracked managed session exists, run upstream `close` for it.
2. Wait for tracked PID to exit (bounded).
3. On timeout, kill only the tracked PID / process group.
4. Confirm the debug port no longer serves `/json/version`.
5. Remove the wrapper-created `userDataDir`.
6. Mark the launch record cleaned (preserve for audit, drop active flag).
7. Report partial cleanup as a failure category so agents can branch.

### Details contract additions

```ts
details.compiledElectron = {
  action,
  target,
  handoff,
  args?,        // redacted upstream connect/connect-args echo
  appArgs?      // redacted
}

details.electron = {
  action,
  status,
  launch?: {
    version: 1,
    launchId,
    launchedByWrapper: true,
    appName,
    bundleId?, appPath?, executablePath?,
    userDataDir,
    port,
    pid?,
    sessionName?,
    webSocketDebuggerUrl?,
    createdAtMs,
    cleanupState
  },
  apps?,        // list results (each tagged with platform)
  targets?,     // status / handoff results
  cleanup?,     // cleanup results
  probe?        // compact state probe (WI-8)
}
```

Extend `AgentBrowserNextAction` (`extensions/agent-browser/lib/results/shared.ts:58`)
to allow `params.electron` payloads, e.g.:

```ts
{
  tool: "agent_browser",
  id: "cleanup-electron-launch",
  params: { electron: { action: "cleanup", launchId } }
}
```

### Scope boundary

In scope for this plan (v1 release): full lifecycle (`list`, `launch`,
`status`, `cleanup`) **plus** the highest-impact token-efficiency
follow-ons (compact state probe in WI-8, current-session QA in WI-9). The
user-mid-flow decision was to bundle WI-8 and WI-9 with the MVP so the
first Electron release lands as one cohesive token-efficient experience.

Out of scope: upstream-only proposals (native `snapshot --role/--region/--changed-since-last`
flags, native `find --preview`, native `batch --summary`, native assertions).
The plan files these as follow-ups against upstream rather than
implementing them wrapper-side.

Platform support in v1: **macOS + Linux** discovery. Windows discovery is
explicit follow-up work. Explicit `executablePath` launch works on all
three from day one because discovery isn't required there.

**Linux discovery scan locations and rules.** Scan locations:

- `~/.local/share/applications/*.desktop`
- `/usr/share/applications/*.desktop`
- `/var/lib/snapd/desktop/applications/*.desktop` (Snap)
- `~/.local/share/flatpak/exports/share/applications/*.desktop` (user Flatpak)
- `/var/lib/flatpak/exports/share/applications/*.desktop` (system Flatpak)

`.desktop` filtering rules: include only `Type=Application`; skip
`NoDisplay=true` and `Hidden=true`. Parse `Exec=` (strip field codes like
`%U` and `%F`) and `Icon=` fields.

For Snap entries, the `Exec=` path usually points at a wrapper script
in `/snap/bin/`; resolve to the actual binary under
`/snap/<name>/current/`. For Flatpak entries, resolve to the binary
under `/var/lib/flatpak/app/<id>/current/active/files/` (system) or
`~/.local/share/flatpak/app/<id>/current/active/files/` (user).

Electron framework evidence gate (resolved binary qualifies if ALL of):

- the binary's parent directory (or one of its sibling resource dirs)
  contains `resources/app.asar` OR `resources/app/`;
- the parent directory contains `chrome_*.pak` files (e.g.,
  `chrome_100_percent.pak`, `resources.pak`).

A `libffmpeg.so` next to the binary is supporting evidence but not a
required gate (custom Electron builds may rename or omit it). Document
v1 Linux discovery as best-effort with a known false-negative list:
heavily customized rebrands, statically-linked Electron forks, and apps
delivered via AppImage without a `.desktop` entry will be missed; users
can always pass `executablePath` directly.

## Work Items

Each item is independently shippable. Sequencing protects the RQ-0068
revisit posture: the docs/tests/benchmark artifacts ship alongside the
behavior they describe.

### WI-1 — Lock decisions in the plan and support matrix

**Goal:** Close the open questions and seed the SUPPORT_MATRIX row before
any code lands, so reviewers see the explicit RQ-0068 revisit framing.

**Done when:**
- This plan no longer carries open questions for v1 scope, shorthand
  surface, cleanup contract, or safety defaults.
- A new `RQ-####` row exists in `docs/SUPPORT_MATRIX.md` stating the
  bounded Electron lifecycle support and naming this plan as the
  revisit evidence for `RQ-0068`.

**Key files:** `docs/plans/electron-extension-2026-05-20.md`;
`docs/SUPPORT_MATRIX.md:60–109`

**Dependencies:** none

**Size:** S

### WI-2 — Implement `electron.list` (discovery)

**Goal:** Expose bounded Electron app discovery as a wrapper-virtual
subcommand under the new top-level shorthand. Covers macOS + Linux per
the Linux discovery scan rules in the Approach.

**Done when:**
- `electron: { action: "list" }` returns app metadata (name, bundle id
  on macOS, paths, platform tag, omitted-count summary) without spawning
  upstream `agent-browser`.
- Exact-one input validation includes `electron`; mutual exclusion errors
  match the existing message shape.
- Validation tests cover schema, mutual exclusion, scan caps, the macOS
  framework heuristic, and the Linux `.desktop` + framework-evidence
  gate; presentation tests cover bounded model-visible output.

**Key files:** `extensions/agent-browser/index.ts:262–352, 4073–4102`;
new `extensions/agent-browser/lib/electron/discovery.ts` (platform
branches for macOS + Linux);
`test/agent-browser.extension-validation.test.ts:1499–2050`

**Dependencies:** WI-1

**Size:** M

### WI-3 — Implement `electron.launch` + `electron.cleanup`

**Goal:** Launch a wrapper-owned Electron app with isolated profile and
attach through upstream `connect`; ship explicit cleanup paired with it
so no half-state can ship.

**Done when:**
- Launch uses `--remote-debugging-port=0`, reads `DevToolsActivePort`,
  connects through upstream `agent-browser`, and persists the launch
  record described in the Details contract via the
  `restoreSessionRefSnapshotsFromBranch` sibling-map extension named in
  the Approach.
- The embedded `connect` call routes through `buildExecutionPlan` with
  `sessionMode: "fresh"`; outcome reporting flows through the existing
  `buildManagedSessionOutcome` path.
- `electron.cleanup` only removes wrapper-tracked resources; cleanup
  failure reports a dedicated failure category and lists remaining
  resources via `nextActions`.
- Non-Electron targets are rejected with a clear correctness error.
- Optional user-supplied `allow`/`deny` lists are enforced; conflicts
  produce a new `policy-blocked` failure category that names the
  matching list entry.
- Launch failure distinguishes timeout (DevToolsActivePort never
  appeared), spawn error (`open`/exec failed), port-not-found
  (`/json/version` never returned a valid payload), and
  single-instance-conflict (existing app process, no debug port). Each
  failure best-effort removes the temp profile and flows through the
  existing managed-session outcome path.
- New `policy-blocked` failure category is added to the union and
  classifier in `lib/results/shared.ts`, the prose list in
  `docs/TOOL_CONTRACT.md`, and tests per `AGENTS.md:62` ("When changing
  categories").
- New `nextActions` ids (`cleanup-electron-launch` and friends) are added
  to `buildAgentBrowserNextActions` with coverage per `AGENTS.md:63`
  ("When changing next-action recommendations").

**Key files:** `extensions/agent-browser/index.ts:1–120, 2445, 2467,
3767, 3825, 4040–4329, 4720–5054`;
`extensions/agent-browser/lib/runtime.ts:33–74, 984–1138`;
new `extensions/agent-browser/lib/electron/{discovery,launch,cleanup}.ts`;
`extensions/agent-browser/lib/temp.ts`;
`extensions/agent-browser/lib/results/shared.ts` (category union +
`buildAgentBrowserNextActions`); `docs/TOOL_CONTRACT.md` (category list);
`test/agent-browser.extension-validation.test.ts:2850–3265`;
`test/agent-browser.results.test.ts` (category + next-action coverage)

**Dependencies:** WI-2

**Size:** L

### WI-4 — Add `electron.status` + tab/snapshot handoff

**Goal:** Make `launch` immediately useful: by default, the agent gets
attach + tab/target summary + a compact snapshot in one call instead of
manually chaining `connect` → `tab list` → `snapshot -i`.

**Done when:**
- `electron.launch` defaults to `handoff: "snapshot"`; `"tabs"` and
  `"connect"` are supported.
- `electron.status` reports liveness, target list, and tracks tab focus.
- Launch / status emit bounded `nextActions` for `tab`, `snapshot`,
  `status`, and `cleanup`. Any new `nextActions` ids land alongside the
  WI-3 update to `buildAgentBrowserNextActions`.
- Presentation tests cover the compact handoff output shape.

**Key files:** `extensions/agent-browser/index.ts:4720–5054`;
`extensions/agent-browser/lib/results/shared.ts`
(`buildAgentBrowserNextActions`);
`extensions/agent-browser/lib/results/presentation.ts:2357`;
`test/agent-browser.presentation.test.ts:1600–1945`;
`test/agent-browser.results.test.ts`

**Dependencies:** WI-3

**Size:** M

### WI-5 — Restore/shutdown wrapper-owned Electron launches

**Goal:** Preserve cleanup ownership across Pi `/reload`, restart, and
`/resume`; clean wrapper-owned Electron apps on session shutdown so
lingering processes don't accumulate.

**Done when:**
- Session start replays active `details.electron.launch` records via the
  `restoreSessionRefSnapshotsFromBranch` sibling-map extension named in
  WI-3.
- A `/reload` or `/resume` that lands on `about:blank` against a stale
  Electron snapshot honors the existing `RQ-0072` page-scoped-ref guard
  and `RQ-0086` tab-drift recovery: tracked launches surface
  `nextActions` to re-snapshot rather than acting on stale `@e…` refs.
  Same-snapshot form-fill behavior from `RQ-0087` is preserved.
- Session shutdown best-effort cleans active wrapper-owned launches.
- Stale or dead records (PID gone, port dead) are reported, not killed.
- Lifecycle tests cover `/reload` + restart + `/resume` for Electron
  launches (extend the existing lifecycle harness rather than adding a
  new one).

**Key files:** `extensions/agent-browser/index.ts:4040–4329, 4720–5054`;
`scripts/verify-lifecycle.mjs`;
`test/agent-browser.extension-validation.test.ts:2850–3265`

**Dependencies:** WI-3

**Size:** M

### WI-6 — Document the contract and command workflow

**Goal:** Make Electron a first-class documented tool mode with the same
contract weight as `qa` / `job` / `sourceLookup`.

**Done when:**
- `docs/TOOL_CONTRACT.md` adds an `electron` section under "Top-level
  shorthand parameters" with action schemas, safety defaults, details
  fields, cleanup ownership, and `nextActions` payloads.
- `docs/COMMAND_REFERENCE.md` adds a workflow section showing
  `list` → `launch` → snapshot → cleanup, plus the "I launched it
  manually, just `connect`" path.
- `README.md` adds a short Electron section under "Common agent calls."
- `extensions/agent-browser/lib/playbook.ts` adds Electron guidance and
  regenerates via `npm run docs -- playbook write`.
- All existing `AGENTS.md` "When changing X" rules for shorthand additions
  are satisfied.

**Key files:** `docs/TOOL_CONTRACT.md`; `docs/COMMAND_REFERENCE.md`;
`docs/SUPPORT_MATRIX.md`; `README.md`;
`extensions/agent-browser/lib/playbook.ts`; `AGENTS.md:72–103`

**Dependencies:** WI-2 through WI-5

**Size:** M

### WI-7 — Add deterministic benchmark coverage

**Goal:** Lock the token-efficiency claim with deterministic scenarios so
later changes are graded against a baseline. Covers the full v1 release
shape: lifecycle + probe.

**Done when:**
- `scripts/agent-browser-efficiency-benchmark.mjs` includes an
  `electron-lifecycle` scenario (discovery + launch+snapshot handoff +
  cleanup) **and** an `electron-probe` scenario showing the WI-8 probe
  replaces ≥ 2 separate calls. `CURRENT_BENCHMARK_VERSION` is bumped.
- `test/agent-browser.efficiency-benchmark.test.ts` asserts the scenario
  IDs and the aggregate metric shape.
- The baseline is checked in.

**Key files:** `scripts/agent-browser-efficiency-benchmark.mjs`;
`test/agent-browser.efficiency-benchmark.test.ts`

**Dependencies:** WI-4, WI-8

**Size:** S

### WI-8 — Compact Electron state probe

**Goal:** Reduce per-step token cost for dense Electron apps. The
dogfood feedback's "state summary" idea collapses title/URL/focused
element/active dialog/top controls into one bounded result. Ships with
the MVP release.

**RQ-0068 framing:** The probe's revisit evidence is *distinct* from
lifecycle's. Lifecycle satisfies `RQ-0068` revisit because of repeated
discover/launch/attach/cleanup failure-prone sequences. The probe
satisfies `RQ-0068` revisit because of repeated multi-call state-probing
sequences in dense Electron apps. The `RQ-####` row in `SUPPORT_MATRIX`
(WI-1) should record both bodies of evidence so future revisits can
distinguish them.

**Done when:**
- A bounded `electron: { action: "probe" }` composes existing upstream
  commands (`get title`, `get url`, focused element via narrow
  `eval --stdin`, `tab list`, bounded `snapshot -i`) into one compact
  `details.electron.probe` result.
- The probe never adds a generic recipe runtime — the compose stays
  inside one analyzer in `index.ts`.

**Key files:** `extensions/agent-browser/index.ts:4720–5054`;
`extensions/agent-browser/lib/results/presentation.ts:2357`;
`test/agent-browser.presentation.test.ts:1600–1945`

**Dependencies:** WI-4

**Size:** M

### WI-9 — Current-session QA for attached Electron

**Goal:** Support smoke checks against an attached Electron session
without requiring a web URL. Today `qa` is URL-oriented and can't be
pointed at "the current Electron page." Ships with the MVP release.

**Decision:** extend `qa` with an `attached: true` (or `current: true`)
flag rather than adding `electron: { action: "qa", ... }`. This keeps
the QA surface in one place and inherits the existing
`compileAgentBrowserQaPreset` validation/redaction/analysis path, which
is a smaller obligation than introducing a new `electron` sub-action
(no new `compile*` helper, no new analyzer wiring).

**Done when:**
- `qa: { attached: true, expectedText?, expectedSelector?, screenshotPath? }`
  asserts bounded text/selector evidence and page errors using existing
  upstream commands; `url` is rejected alongside `attached: true`.
- It does not break or replace existing `qa.url` semantics.
- The existing `compileAgentBrowserQaPreset` and
  `analyzeQaPresetResults` paths handle the attached form; no new
  analyzer is introduced.
- Tests cover the new path under
  `test/agent-browser.extension-validation.test.ts`.

**Key files:** `extensions/agent-browser/index.ts:505–570, 4720–5054`
(`compileAgentBrowserQaPreset`, `analyzeQaPresetResults`);
`docs/TOOL_CONTRACT.md` (`qa` section);
`test/agent-browser.extension-validation.test.ts:1499–2050`

**Dependencies:** WI-3 (an attached session must exist to QA)

**Size:** M

## File-by-file impact

| File | Impact |
| --- | --- |
| `extensions/agent-browser/index.ts` | Add `electron` to `AGENT_BROWSER_PARAMS`, mode-count and routing, compile helper, validation, post-execution details merge, restore/shutdown hooks. |
| `extensions/agent-browser/lib/electron/{discovery,launch,cleanup}.ts` | **New.** Platform-tagged discovery (macOS + Linux), launch argv builder, `DevToolsActivePort` polling, `/json/version` + `/json/list` reads, tracked-process cleanup. Split now so the Windows follow-up doesn't bloat one file. |
| `extensions/agent-browser/lib/temp.ts` | Reuse / extend the secure-temp-dir helper for Electron `userDataDir`. |
| `extensions/agent-browser/lib/results/shared.ts` | Extend `AgentBrowserNextAction.params` to allow `electron`. |
| `extensions/agent-browser/lib/results/presentation.ts` | Bounded presentation for status/probe outputs and Electron-specific `nextActions` (if not entirely formatted in `index.ts`). |
| `extensions/agent-browser/lib/playbook.ts` | Generated Electron guidance, then `npm run docs -- playbook write`. |
| `docs/TOOL_CONTRACT.md` | New `electron` section in the shorthand contract, plus details fields. |
| `docs/COMMAND_REFERENCE.md` | Electron workflow examples and cleanup/safety notes. |
| `docs/SUPPORT_MATRIX.md` | New `RQ-####` row referencing this plan as the RQ-0068 revisit evidence. |
| `README.md` | Short Electron section in "Common agent calls" + safety caveat. |
| `scripts/agent-browser-efficiency-benchmark.mjs` | Add `electron-lifecycle` scenario; bump `CURRENT_BENCHMARK_VERSION`. |
| `scripts/verify-lifecycle.mjs` | Extend the harness for Electron `/reload` + restart + `/resume` (WI-5). |
| `test/agent-browser.extension-validation.test.ts` | Schema, validation, fake-launch, attach, cleanup, safety, details, restore-after-resume tests. |
| `test/agent-browser.presentation.test.ts` | Bounded `nextActions` and status/probe presentation tests. |
| `test/agent-browser.runtime.test.ts` | Touch only if runtime planning changes (e.g., new launch-scoped flag treatment). |
| `test/agent-browser.efficiency-benchmark.test.ts` | New scenario IDs and aggregate metric updates. |

## Risks and migration

- **Cleanup is the primary safety risk.** The implementation must only
  terminate tracked, wrapper-launched PIDs/process groups and only remove
  wrapper-created temp profiles. Misidentification could kill a user app.
  Mitigations: persist `launchedByWrapper: true` + parent-process check,
  refuse to act when registry data is incomplete, and prefer reporting
  partial cleanup over best-effort kills.
- **Single-instance Electron apps.** Many Electron apps enforce
  single-instance and silently drop new `--remote-debugging-port`
  invocations. `electron.launch` must detect this (existing process + no
  active debug port) and refuse with a clear `nextActions` recommendation
  ("quit the running app first") rather than producing a broken attach.
- **User-owned safety policy.** The wrapper does not classify apps as
  high-risk. Attaching to messaging/auth/wallet apps exposes private
  content; the user is responsible for choosing what to launch and for
  using optional `allow`/`deny` lists if they want guardrails.
  Documentation must be loud about this, and the wrapper's existing
  redaction must extend to any Electron echoes.
- **API additivity.** Existing `args`, `semanticAction`, `job`, `qa`,
  `sourceLookup`, `networkSourceLookup` behavior must not change. Older
  code ignoring new `details.electron` is safe rollback.
- **Platform scope.** macOS + Linux discovery in v1; Windows is explicit
  follow-up. The shorthand schema and contract must not paint us into a
  corner that prevents Windows follow-up — keep discovery results
  platform-tagged and avoid hard-coding macOS path assumptions in the
  schema.

## Implementation order

WI-8 and WI-9 are part of the v1 release (user-mid-flow decision), so
they land before the verification gate.

1. WI-1: plan + support matrix decision lock.
2. WI-2: `electron.list` (independently shippable).
3. WI-3: `electron.launch` + `electron.cleanup` together (so no half-state
   ships).
4. WI-4: `electron.status` + handoff defaults.
5. WI-5: restore/shutdown.
6. WI-8: compact Electron state probe.
7. WI-9: current-session QA for attached Electron.
8. WI-6: docs/playbook/contract (covers WI-2..WI-5 + WI-8/WI-9).
9. WI-7: deterministic benchmark (covers full lifecycle + probe).
10. Run `npm test`, `npm run benchmark:agent-browser`,
    `npm run verify`, and an Electron `tmux` dogfood pass per
    `AGENTS.md` "Preferred testing workflow."

## Open Questions

None block implementation. The Phase 6 design critique surfaced specific
seam gaps; they are folded into the relevant Work Items above. The
new SUPPORT_MATRIX row covering this work is `RQ-0096`; it names this
plan as the `RQ-0068` revisit evidence.

## References

### Repo

- `docs/ARCHITECTURE.md` (`#no-reusable-recipe-layer-yet`, `RQ-0068`)
- `docs/SUPPORT_MATRIX.md` rows: `RQ-0068`, `RQ-0072`, `RQ-0079`,
  `RQ-0080`, `RQ-0083`, `RQ-0086`, `RQ-0087`
- `docs/REQUIREMENTS.md:18–44, 66–68, 111–123`
- `docs/COMMAND_REFERENCE.md:362` (skills), `:392` (`connect`),
  `:560` (`--auto-connect`), `:576` (`--cdp`), `:620` (fresh-session)
- `extensions/agent-browser/index.ts:262–352` (schema),
  `:386–839, 1238–1306` (compile helpers),
  `:4073–4102` (mutual exclusion + routing)
- `extensions/agent-browser/lib/runtime.ts:33–74, 984–1138`
- `extensions/agent-browser/lib/results/presentation.ts:2357`
- `test/agent-browser.extension-validation.test.ts:1499, 1654, 1734,
  1851, 1918`
- `scripts/agent-browser-efficiency-benchmark.mjs` (scenario set)
- Prior recipe-layer close: commit "Close browser recipe decision"

### Upstream `agent-browser` 0.27.0

- [Electron skill source](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skill-data/electron/SKILL.md)
- [CDP Mode docs](https://agent-browser.dev/cdp-mode)
- [Commands](https://agent-browser.dev/commands)
- [Snapshots](https://agent-browser.dev/snapshots)
- [Changelog](https://agent-browser.dev/changelog)

### External

- [Electron command-line switches](https://www.electronjs.org/docs/latest/api/command-line-switches)
- [Electron application distribution](https://www.electronjs.org/docs/tutorial/application-distribution/)
- [Chrome remote-debugging security change, 2025](https://developer.chrome.com/blog/remote-debugging-port)
- [CDP HTTP endpoints / FAQ](https://chromedevtools.github.io/devtools-protocol/#endpoints)
- [Puppeteer browser management](https://pptr.dev/guides/browser-management)
- [Playwright Electron](https://playwright.dev/docs/api/class-electron)
- [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)

## Orchestration restart status

**Recorded:** 2026-05-20 after restart recovery.

- [x] WI-1 implemented: `RQ-0096` exists and final wording reflects the shipped release shape.
- [x] WI-2 implemented: `electron.list` discovery, schema, routing, bounded output, and validation coverage exist.
- [x] WI-3 implemented: `electron.launch` and `electron.cleanup` lifecycle implementation, categories, next actions, and tests.
- [x] WI-4 implemented: `electron.status` and launch handoff modes.
- [x] WI-5 implemented: restore/shutdown behavior and lifecycle verification.
- [x] WI-8 implemented: compact `electron.probe`.
- [x] WI-9 implemented: `qa.attached` current-session QA.
- [x] WI-6 implemented: contract docs, command reference, README, playbook, support matrix final wording.
- [x] WI-7 implemented: deterministic benchmark scenarios and tests.

## Post-implementation dogfood verification

**Recorded:** 2026-05-21 from a non-destructive local Electron smoke pass against Visual Studio Code.

The native Electron wrapper path was validated end-to-end against a local app selected from `electron.list` results. VS Code was launched with a wrapper-owned isolated profile, inspected, interacted with through read-only and low-risk UI actions, and fully cleaned up.

Validated capabilities:

- Electron app discovery.
- Wrapper-owned Electron launch and attach.
- `electron.status` liveness and target reporting.
- `electron.probe` current-session state summary.
- `snapshot -i` extraction from VS Code's Electron target.
- Ref-based click and `semanticAction` click flows.
- Page-scoped stale-ref guard behavior.
- `get text`, read-only `eval --stdin`, and `batch` reads.
- `sourceLookup` and `networkSourceLookup` smoke coverage.
- `errors`, `console`, and `network requests` diagnostics.
- Screenshot artifact verification and explicit artifact removal.
- `electron.cleanup` removing the wrapper process, debug port, and isolated user-data-dir.
- Final `electron.status` reporting no active wrapper-tracked launches.

Non-destructive boundary observed: no sign-in, no messages, no chat prompts, no user files, no repository clones, no extension re-enable, and no real user profile mutation.

Follow-ups resolved from dogfood:

1. `semanticAction` role locators now accept `role` as the role locator value for `locator: "role"`, so callers can use `semanticAction: { action: "click", locator: "role", role: "button", name: "Continue without Signing In" }` without also passing `value`. The existing `value: "button"` form still works, and `role` / `value` must match if both are supplied.
2. `electron.probe` now accepts `timeoutMs` and applies it to each bounded underlying probe subprocess read.

Other observed diagnostics behaved as intended: page-scoped ref guard blocked unsafe same-batch post-mutation refs, selector visibility warnings surfaced hidden-first-match risk, overlay blocker diagnostics appeared after a potentially blocked click, and unknown upstream commands failed cleanly with readable partial batch output.

