#!/usr/bin/env bash
# CI-only recipe. Call with env -i, a private HOME, and sibling source checkouts.
set -euo pipefail
mode=${1:?setup or verify}
root=${2:?absolute isolated root}
cd "$root/extension"
[[ $(id -u) != 0 ]]
[[ $(node --version) == v26.9.0 ]]
[[ $HOME == "$root/home" && $PWD != "$HOME"/* ]]
mkdir -p "$root/logs"
export PATH="$root/browser/bin:$PATH"
export PI_OFFLINE=1 npm_config_update_notifier=false

case "$mode" in
  setup)
    {
      id
      uname -a
      node --version
      npm --version
      git rev-parse HEAD
      git -C "$root/pi-host" rev-parse HEAD
      [[ $(git -C "$root/pi-host" rev-parse HEAD) == 97891a8511c101ef1cb53d72dfdcb60e0e2c0e89 ]]
      sha256sum package-lock.json "$root/pi-host/package-lock.json"
    } 2>&1 | tee "$root/logs/provenance.log"
    (
      cd "$root/pi-host"
      npm ci --ignore-scripts
      npm run hydrate:model-data
      npm run build:offline
      git diff --exit-code
    ) 2>&1 | tee "$root/logs/host-build.log"
    npm ci --ignore-scripts 2>&1 | tee "$root/logs/extension-install.log"
    # Same package-managed Linux graph; no second resolution or handmade links.
    [[ $(git -C "$root/startup-baseline" rev-parse HEAD) == b1e083e345d0ed9c2c2f9f20953c657a2e0da8a8 ]]
    cmp package.json "$root/startup-baseline/package.json"
    cmp package-lock.json "$root/startup-baseline/package-lock.json"
    cp -a node_modules "$root/startup-baseline/"
    # A separate stock installation, never a dependency or a custom browser build.
    npm install --global --prefix "$root/browser" agent-browser@0.38.1 2>&1 | tee "$root/logs/browser-install.log"
    agent-browser install --with-deps 2>&1 | tee -a "$root/logs/browser-install.log"
    {
      agent-browser --version
      ffmpeg -version
      find "$HOME/.agent-browser/browsers" -type f -name chrome -exec '{}' --version \;
      sha256sum "$root/browser/lib/node_modules/agent-browser/bin/agent-browser-linux-x64" \
        "$root/pi-host/packages/coding-agent/dist/index.js" \
        "$root/pi-host/packages/coding-agent/dist/core/agent-session.js" \
        "$root/pi-host/packages/coding-agent/dist/core/session-manager.js"
    } 2>&1 | tee -a "$root/logs/provenance.log"
    ;;
  verify)
    # Run both gates even if the first fails, preserving both raw receipts.
    status=0
    npm run verify > "$root/logs/default-verify.log" 2>&1 || status=1
    # Only fresh downloaded binary resources: the test makes its own empty profiles.
    browsers=("$HOME"/.agent-browser/browsers/chrome-*)
    [[ ${#browsers[@]} == 1 && -d ${browsers[0]} ]]
    PI_CHECKPOINT_TEST_REQUIRED=1 \
    PI_CHECKPOINT_TEST_SDK="$root/pi-host/packages/coding-agent/dist/index.js" \
    PI_CHECKPOINT_TEST_BROWSER_DIR="${browsers[0]}" \
      node --test --test-reporter=tap test/agent-browser.checkpoint-native.test.mjs \
      > "$root/logs/native-checkpoint.tap" 2>&1 || status=1
    # No baseline-only run, missing prerequisite, filtered case or skip may pass CI.
    for summary in 'tests 13' 'pass 13' 'fail 0' 'cancelled 0' 'skipped 0' 'todo 0'; do
      grep -qx "# $summary" "$root/logs/native-checkpoint.tap" || status=1
    done
    # Bounded evidence AFTER both ordinary gates; never warm their first budget run.
    # Build only the baseline extension, not the head or native host again.
    if (cd "$root/startup-baseline" && node scripts/build.mjs) \
      > "$root/logs/startup-baseline-build.log" 2>&1; then
      node scripts/ci-startup-diagnostic.mjs "$root" \
        > "$root/logs/startup-diagnostic.log" 2>&1 || status=1
    else
      printf 'Startup diagnostic baseline build failed\n' > "$root/logs/startup-diagnostic.log"
      status=1
    fi
    git -C "$root/startup-baseline" diff --exit-code > "$root/logs/startup-baseline-integrity.log" 2>&1 || status=1
    git diff --exit-code > "$root/logs/source-integrity.log" 2>&1 || status=1
    git -C "$root/pi-host" diff --exit-code >> "$root/logs/source-integrity.log" 2>&1 || status=1
    printf 'Combined verification exit: %s\n' "$status" | tee "$root/logs/result.log"
    exit "$status"
    ;;
  *) echo "Unknown mode: $mode" >&2; exit 2 ;;
esac
