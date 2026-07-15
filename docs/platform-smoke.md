# Platform smoke testing

`pi-agent-browser-native` uses a Crabbox-backed local platform smoke gate to prove the package on macOS, Ubuntu Linux, and native Windows before release.

This is a release-blocking gate. Missing Crabbox setup, Docker, macOS SSH, the native Windows template, upstream `agent-browser`, or browser runtime dependencies is a blocked release setup, not a skipped pass.

## Required release gate

Run the cheap harness checks first, build the project-owned Ubuntu image, run doctor explicitly, then run the full matrix and inspect the evidence:

```sh
npm run check:platform-smoke
npm run smoke:platform:ubuntu-image
npm run smoke:platform:doctor
npm run smoke:platform:all
crabbox list --provider local-container
crabbox list --provider parallels
```

`smoke:platform:all` also runs `smoke:platform:doctor` before any target suite starts, so the explicit doctor step is a readable release checklist step rather than a hidden precondition. The canonical `npm run verify -- release` gate also runs the configured-source lifecycle harness, then the same platform doctor and full `macos,ubuntu,windows-native` matrix after default verification and packaged Pi smoke, so `npm publish` cannot pass `prepublishOnly` without lifecycle and platform gates. After the matrix, inspect `.artifacts/platform-smoke/<run-id>/...` summaries and manifests; a green Crabbox exit without matching suite assertions is not release proof. Use provider-specific `crabbox list` commands for cleanup review because this host may have unrelated Crabbox providers configured that require credentials.

Per-target commands are for diagnosis:

```sh
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
npm run smoke:platform:windows-native
npm run verify -- platform-smoke run --target ubuntu --suite platform-build
```

## Targets

| Target | Crabbox provider | Shell contract | Release status |
| --- | --- | --- | --- |
| `macos` | `ssh` static localhost | POSIX shell on macOS | Required |
| `ubuntu` | `local-container` | POSIX shell in a Docker-compatible local container | Required |
| `windows-native` | `parallels` | native Windows PowerShell over OpenSSH | Required |

## Required environment

Install Crabbox on the macOS maintainer host and keep it on `PATH`:

```sh
brew install openclaw/tap/crabbox
crabbox --version
crabbox providers
```

Use Crabbox `0.26.0` or newer. Use `PLATFORM_SMOKE_CRABBOX=/path/to/crabbox` only when testing a non-default Crabbox binary.

Standard configuration knobs:

```sh
PLATFORM_SMOKE_MAC_HOST=localhost
PLATFORM_SMOKE_MAC_USER="$USER"
PLATFORM_SMOKE_MAC_WORK_ROOT="/Users/$USER/crabbox/pi-agent-browser-native"
# Optional only when localhost SSH does not use port 22.
PLATFORM_SMOKE_MAC_PORT=22

# Default local image built by npm run smoke:platform:ubuntu-image.
# The tag suffix is derived from scripts/agent-browser-capability-baseline.mjs.
PLATFORM_SMOKE_UBUNTU_IMAGE="pi-agent-browser-native-platform:node24-agent-browser<baseline-version>"

PLATFORM_SMOKE_WINDOWS_VM="pi-extension-windows-template"
PLATFORM_SMOKE_WINDOWS_SNAPSHOT="crabbox-ready"
PLATFORM_SMOKE_WINDOWS_USER="<windows-ssh-user>"
PLATFORM_SMOKE_WINDOWS_WORK_ROOT="C:\\crabbox\\pi-agent-browser-native"

# Optional: names of secret env vars to redact/forward if future live suites need them.
PLATFORM_SMOKE_AUTH_ENV=""
```

The Ubuntu target image is derived from `node:24-bookworm`, installs the `agent-browser` version from [`scripts/agent-browser-capability-baseline.mjs`](../scripts/agent-browser-capability-baseline.mjs), installs Debian Chromium plus the upstream 0.31.2 Linux WebGPU/Xvfb runtime packages (`libvulkan1`, `mesa-vulkan-drivers`, and `xvfb`) through apt, creates a non-root `circleci` user, and sets `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`. Rebuild it after upstream rebaselining, or override `PLATFORM_SMOKE_UBUNTU_IMAGE` with an equivalent prepared local image. Do not install `agent-browser` ad hoc inside the Ubuntu smoke command; a missing tool is image/template drift.

The configured upstream `agent-browser` baseline is imported from [`scripts/agent-browser-capability-baseline.mjs`](../scripts/agent-browser-capability-baseline.mjs). Target-local browser suites verify that exact `agent-browser` version before running. Bake the exact upstream CLI and browser runtime into the Windows template/snapshot for speed and reproducibility; missing or stale Windows `agent-browser` / browser readiness is a blocked setup, not something the smoke command repairs. The Windows browser suite checks the preinstalled browser cache and prewarms one short local file URL before the extension harness runs.

## Target setup expectations

Crabbox does not install project runtime tools. The macOS host, Ubuntu image, and Windows template must already provide:

- Node/npm at or above the configured Node major baseline in [`platform-smoke.config.mjs`](../platform-smoke.config.mjs).
- Git and `tar`.
- Upstream `agent-browser` matching this wrapper’s capability baseline. The Ubuntu target gets it from [`scripts/platform-smoke/linux-image/Dockerfile`](../scripts/platform-smoke/linux-image/Dockerfile); the Windows template gets it from the shared `pi-extension-windows-template` / `crabbox-ready` snapshot.
- Browser/runtime dependencies needed by upstream `agent-browser`.
- Native PowerShell and OpenSSH Server on Windows.

For Windows, reuse `pi-extension-windows-template` with the shared canonical `crabbox-ready` power-off snapshot configured in [`platform-smoke.config.mjs`](../platform-smoke.config.mjs). Do not create one-off project VMs or run tests directly on the source VM. If a reusable tool is missing, update the shared template, verify from a fresh SSH session, remove caches/secrets/checkouts, shut down cleanly, and promote a known-good power-off snapshot.

## What the suites prove

Each required target runs `platform-build` and `browser-dogfood-smoke` on one Crabbox lease, serially.

### `platform-build`

1. Verify the target Node major version.
2. Run `npm ci` in the synced checkout.
3. Run `npm run verify -- platform-target`, a fast target-local gate covering generated docs, TypeScript, package/platform harness tests, and runtime planning. The full unit/fake suite still runs once in the host default gate before the release matrix starts; target-local smoke must not duplicate that full suite on every OS. Browser subprocess behavior is then exercised by the target-local `browser-dogfood-smoke` suite against the real upstream binary.
4. Run `npm pack`.
5. Create a clean target-local Pi project.
6. Install the packed tarball with `npm install --no-save`.
7. Run `pi install -l --approve ./node_modules/pi-agent-browser-native` from the clean project so Pi 0.79+ trusts the generated project-local settings for that command.
8. Run `pi list --approve` and assert the package is registered under project packages from the packed install.
9. Assert the release proof did not use `pi -e .` or `pi --extension .`.

### `browser-dogfood-smoke`

1. Run `npm ci` in the synced checkout if needed.
2. Run the deterministic model-free browser smoke through `scripts/verify-agent-browser-dogfood.ts`.
3. Exercise native wrapper surfaces against the deterministic local file fixture from `scripts/verify-agent-browser-dogfood.ts`: top-level `qa`, `semanticAction`, constrained `job`, screenshot artifact verification, and session close.
4. Persist the dogfood JSON report and stdout/stderr evidence.
5. Fail on missing browser artifacts, failed tool calls, leaked secrets, or unclosed sessions.

The dogfood suite intentionally uses the checkout harness while `platform-build` proves packed Pi installation. Together they catch OS-specific packaging, install, path, process, browser, and wrapper bugs without using an LLM.

## Artifact contract

Every target run writes host-side evidence under one run id shared by that target’s suites:

```text
.artifacts/platform-smoke/<run-id>/<target>/<suite>/
```

Required files include:

```text
summary.json           # includes ok, target, suite, exit code, elapsed time, writtenAt
artifact-manifest.json
target.json            # package, package version, Crabbox binary/version, provider, work root/image/template
suite.json
command.txt
exit-code.txt
crabbox.stdout.txt
crabbox.stderr.txt
crabbox.timing.json
assertions.json
failures.md            # only when assertions fail
```

`platform-build` also writes:

```text
node-version.txt
packed-tarball.txt
packed-node-install.stdout.txt
packed-node-install.stderr.txt
pi-install.stdout.txt
pi-install.stderr.txt
pi-list.stdout.txt
pi-list.stderr.txt
```

`browser-dogfood-smoke` also writes:

```text
node-version.txt
dogfood-artifacts.txt
dogfood.stdout.txt
dogfood.stderr.txt
dogfood-report.json
```

Each target also writes a `lease-cleanup` artifact directory with `crabbox.stop.*` files. Cleanup failures are failing test results. Ubuntu and Windows runs also invoke Crabbox cleanup for stale direct-provider state after stopping the owned lease.

Passing suites must satisfy:

```text
summary.ok === assertions.ok
artifact-manifest.missing.length === 0
```

The harness redacts configured secret values and token-like text from persisted artifacts, then fails if a redaction scan still finds raw secrets.

## Source of truth

- Config: [`platform-smoke.config.mjs`](../platform-smoke.config.mjs)
- CLI: [`scripts/platform-smoke.mjs`](../scripts/platform-smoke.mjs)
- Crabbox wrapper: [`scripts/platform-smoke/crabbox-runner.mjs`](../scripts/platform-smoke/crabbox-runner.mjs)
- Target commands/assertions: [`scripts/platform-smoke/targets.mjs`](../scripts/platform-smoke/targets.mjs)
- Platform doctor: [`scripts/platform-smoke/doctor.mjs`](../scripts/platform-smoke/doctor.mjs)
- Artifact helpers: [`scripts/platform-smoke/artifacts.mjs`](../scripts/platform-smoke/artifacts.mjs)
- Windows build suite: [`scripts/platform-smoke/platform-build-windows.ps1`](../scripts/platform-smoke/platform-build-windows.ps1)
- Windows browser suite: [`scripts/platform-smoke/browser-dogfood-windows.ps1`](../scripts/platform-smoke/browser-dogfood-windows.ps1)
