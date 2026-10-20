#!/usr/bin/env bash
# CI-only recipe. Call with env -i, a private HOME, and sibling source checkouts.
set -euo pipefail
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  printf '%s\n' \
    'Usage: ci-native-lifecycle.sh setup|verify ABSOLUTE_ROOT' \
    'Run model-free, real-browser public Pi lifecycle checks against the' \
    'latest stable official Pi graph selected in ROOT/extension.' \
    'Requires Node 24.21.0, a non-root user, private HOME=ROOT/home, and a' \
    'ROOT/extension source checkout and ROOT/automation pinned helpers.' \
    'OFFICIAL_VERSION freezes the version resolved once by CI; blank resolves latest.' \
    'Example: env -i HOME=/tmp/ci/home PATH="$PATH" bash scripts/ci-native-lifecycle.sh setup /tmp/ci' \
    'Run verify in a loopback-only network namespace after setup (see native-lifecycle.yml).' \
    'Exit codes: 0 passed/help, 1 verification/prerequisite failure, 2 invalid usage.'
  exit 0
fi
if [[ $# != 2 || ( $1 != setup && $1 != verify ) || $2 != /* ]]; then
  echo 'Usage: ci-native-lifecycle.sh setup|verify ABSOLUTE_ROOT (use --help)' >&2
  exit 2
fi
mode=$1
root=$2
cd "$root/extension"
[[ $(id -u) != 0 ]]
[[ $(node --version) == v24.21.0 ]]
[[ $HOME == "$root/home" && $PWD != "$HOME"/* ]]
mkdir -p "$root/logs"
export PATH="$root/browser/bin:$PATH"
export PI_OFFLINE=1 PI_TELEMETRY=0 npm_config_update_notifier=false
export PI_CODING_AGENT_DIR="$root/home/.pi/agent"

case "$mode" in
  setup)
    {
      id
      uname -a
      node --version
      npm --version
      git rev-parse HEAD
      sha256sum package-lock.json
    }
    PI_COMPAT_EVIDENCE_DIR="$root/logs/host" node scripts/ci-host-compat.mjs \
      official install "$root/automation" "${OFFICIAL_VERSION:-latest}"
    # Only host preparation needs GitHub metadata auth; keep lifecycle/browser children token-free.
    unset GH_TOKEN
    npm run build
    # A separate stock installation, never a dependency or a custom browser build.
    npm install --global --prefix "$root/browser" agent-browser@0.38.1
    agent-browser install --with-deps
    {
      agent-browser --version
      ffmpeg -version
      find "$HOME/.agent-browser/browsers" -type f -name chrome -exec '{}' --version \;
      sha256sum "$root/browser/lib/node_modules/agent-browser/bin/agent-browser-linux-x64" \
        "$root/extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js" \
        "$root/extension/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js" \
        "$root/extension/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"
    }
    ;;
  verify)
    status=0
    npm run docs -- playbook check || status=1
    npm run verify -- command-reference || status=1
    # Only fresh downloaded binary resources: the test makes its own empty profiles.
    browsers=("$HOME"/.agent-browser/browsers/chrome-*)
    [[ ${#browsers[@]} == 1 && -d ${browsers[0]} ]]
    PI_NATIVE_LIFECYCLE_REQUIRED=1 \
    PI_NATIVE_LIFECYCLE_SDK="$root/extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js" \
    PI_NATIVE_LIFECYCLE_BROWSER_DIR="${browsers[0]}" \
    PI_NATIVE_LIFECYCLE_ARTIFACT_DIR="$root/logs/native-lifecycle" \
      node --test --test-reporter=tap test/agent-browser.native-lifecycle.test.mjs \
      2>&1 | tee "$root/logs/native-lifecycle.tap" || status=1
    # Missing prerequisites, filtered cases, and skips cannot qualify the gate.
    for summary in 'tests 12' 'pass 12' 'fail 0' 'cancelled 0' 'skipped 0' 'todo 0'; do
      grep -qx "# $summary" "$root/logs/native-lifecycle.tap" || status=1
    done
    git diff --exit-code || status=1
    printf 'Combined verification exit: %s\n' "$status"
    exit "$status"
    ;;
  *) echo "Unknown mode: $mode" >&2; exit 2 ;;
esac
