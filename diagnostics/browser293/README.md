# Browser293: bounded offline macOS discriminator v1

Purpose: same-hardware native TUI-only versus unchanged Browser entrypoint import/registration. Diagnostic, not a repair, original-negative replacement, full qualification, or active extension load. Source PR293 remains blocked.

## Operator-selected existing inputs

- An **existing actual Node24.22.1 binary** (absolute executable path, not a mise/npm/Pi wrapper).
- The **existing immutable fork93-feaee / source93a39fcc50b7c460dbde1e3109bd798a37378852** `@earendil-works/pi-coding-agent/package.json` path. This path is supplied by the coordinator, never guessed by the child.
- No package installation, SDK copy/substitution, source build, runtime/extension reload, config/auth/global Git change, service/browser/Pi/tmux/mise/model/provider invocation, or paid inference.

Fail closed on any mismatch: entry1cf8c5f1c6dd020824af15b5c320c05a10b89d173394911eec46433cad39150e; unchanged LF measurement593bf639ac50a8feae90460504523087ce9fe76c56de28fd81fef35e01680c5c; SDK8571698d27d098f224e684565fdf7bbcba72c0172b875adf59f0b7c088a94554; CLI48de46271f1aebdcb42edb289d186793f4d0345510e25df0b0bec92251fdd160; TUI public index6068ae4207de753d9ec00dbe14aee199e6160d1dea0db9c8a92f65d08ffc6e80. Nine coherent1.4.0 native package manifests and native typebox1.3.37 are checked through Node's supported metadata resolver. The SDK root and CLI are hashed/read, **not executed**. A mismatch is a stop/report discriminator, never permission to install, patch, substitute or weaken checks.

The archive contains unchanged entry/measurement and exact existing Browser non-SDK dependency files (MIT/public package licenses retained). **No native SDK/TUI/typebox package is supplied.** The driver makes nine links only inside this new extraction to the selected existing native package directories. Realpath-native dependencies and public TUI exports stay host-owned; no require/deep-import SDK bypass, private TUI bundle, fake native SDK/context, or compatibility callback is introduced. Entry registration reuses the original measurement's exact existing minimal API counters; it never invokes a tool or event handler and does not pretend to be full SDK qualification.

## Containment

Extract once into a fresh `mktemp -d` directory, verify `SHA256SUMS`, and run from there. All writes/results/profiles and new symlinks stay in this extraction. Supply empty per-process HOME/TMPDIR/XDG directories to avoid consulting active user configuration. These are child-only environment variables, not changes to the active shell/runtime/config. No credentials or bridge/NODE_OPTIONS/NODE_PATH are inherited with the command below. Do not remove this directory, any prior JSONL, or any ancestor; retain every outcome. Raw profiles contain selected local module paths: coordinator may inspect before returning them; do not publicly upload private host paths.

The driver must not run from the active extension installation. It does not touch active source/runtime/config/auth/model/profile/bridge files. It opens no inspector port: profile-only children use the official in-process Node Inspector Session plus native V8/module-timer tracing. No monkeypatch or external process attachment. Native preloader self-check and read-only Linux identity-plan checks were performed by the source owner; no Mac execution is claimed.

## Fixed protocol

No concurrent samples, warmup import, acceptance retry, trimming or budget change. Six sequential fresh Node children: **TUI, entry, entry, TUI, TUI, entry** (three per arm). Identity preflight reads hashes but does not import the SDK/TUI; this is fresh module state, not cold OS-file-cache evidence, consistent with the existing benchmark. TUI arm imports only the public selected native TUI; entry arm calls **unchanged `measureColdStartup`**, preserves8tool/8event checks and records all identities/CPU/mainCPU/wall/hardware/load. Then exactly two additional **profile-only** fresh children, TUI then entry, capture CPU profiles, native trace events and sampled module URLs. Profile timing is explicitly not an acceptance sample. Child deadlines/maxBuffer remain the original10000ms/1MiB. The250ms all-entry-sample maximum remains unchanged.

Finish all raw diagnostics, then exit1 if any of the three unprofiled entry samples is >=250ms. Preserve the results and do not repeat to obtain green. Exceptions also remain failed/partial observations and are never retried automatically. This discriminator cannot itself repair the original collector Mac failure or the separate native Windows runtime failure.

## Commands after downloading and extracting this exact archive

Set `NODE24` and `SDK_MANIFEST` to your already verified existing paths; do not install anything to satisfy them. `INPUT` below is the new extraction directory actually created by your shell.

```sh
: "${NODE24:?existing absolute native Node24.22.1 executable required}"
: "${SDK_MANIFEST:?existing immutable93 coding-agent package.json path required}"
: "${INPUT:?fresh extraction directory required}"
cd "$INPUT"
shasum -a 256 -c SHA256SUMS
mkdir home tmp xdg
set +e
env -i PATH="$(dirname "$NODE24"):/usr/bin:/bin" HOME="$INPUT/home" TMPDIR="$INPUT/tmp" XDG_CONFIG_HOME="$INPUT/xdg" LANG=C LC_ALL=C TERM=dumb NO_COLOR=1 PI_OFFLINE=1 PI_TELEMETRY=0 "$NODE24" ./discriminator.mjs "$SDK_MANIFEST" > driver.stdout.log 2> driver.stderr.log
status=$?
set -e
printf 'diagnostic exit status: %s\n' "$status" | tee driver.status.txt
# Retain all files. Return report.json/plan.json, every sample/error, both profiles/traces,
# stdout/stderr/status; no retry/cleanup regardless of status.
tar -czf results-for-coordinator.tar.gz results driver.stdout.log driver.stderr.log driver.status.txt
```

If preflight aborts before `results/` exists, keep stdout/stderr/status and return the exact mismatch instead of invoking tar against a missing path. Existing toolkit/read-only inputs are never altered; missing identities/access are blockers, not fallbacks.
