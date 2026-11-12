/** CLI usage for the project verification facade. */
import { DEFAULT_LIFECYCLE_MODEL, DEFAULT_TIMEOUT_MS } from "./lifecycle-defaults.mjs";

export function printTopLevelHelp() {
	console.log(`project.mjs

Usage:
  node scripts/project.mjs <test|docs|verify> [mode] [options]

Public npm entrypoints:
  npm test                     Build, prepare, then run every parallel and serial contract test.
  npm run docs                 Check generated documentation blocks.
  npm run docs -- write        Rewrite generated documentation blocks.
  npm run verify               Run the default local verification gate.
  npm run verify -- release    Run release verification.

Exit codes:
  0  Requested workflow passed or help was shown.
  1  Requested workflow failed.
  2  Usage error.`);
}

export function printDocsHelp() {
	console.log(`npm run docs -- [target] [mode]

Targets:
  all                 Command-reference generated blocks (default).
  command-reference   Only command-reference baseline blocks.

Modes:
  check               Verify generated blocks are current (default).
  write               Rewrite generated blocks in place.

Examples:
  npm run docs
  npm run docs -- write
  npm run docs -- command-reference check

Exit codes:
  0  Documentation blocks matched, were rewritten, or help was shown.
  1  Drift found or rewrite failed.
  2  Usage error.`);
}

export function printVerifyHelp() {
	console.log(`npm run verify -- [mode] [options]

Modes:
  default             Complete quality, build, typecheck, unit, and documentation gate (default).
  quality             Alias for the complete default gate.
  typecheck           Run TypeScript typecheck only.
  command-reference   Check generated command-reference block and live upstream help drift.
  pre-pr              Run default verification plus package-content checks for larger local handoffs.
  startup-profile     Run the safe package entrypoint startup profiler.
  real-upstream       Run the opt-in real upstream browser contract suite (localhost fixtures, broad core commands).
  dogfood             Run a deterministic model-free live-browser smoke through the native tool wrapper.
  package             Verify package contents.
  package-pi          Verify package contents plus isolated Pi package smoke.
  lifecycle           Run the tmux-driven configured-source lifecycle harness.
  platform-target     Fast platform-local gate used inside Crabbox smoke targets.
  platform-smoke      Run required Apple Silicon macOS/Ubuntu platform smoke.
  release             Run default verification, lifecycle, package-pi, and required macOS/Ubuntu platform smoke;
                      lifecycle options reach only its lifecycle step.

Options:
  --artifact-dir <p>  With dogfood mode, write screenshots to this directory.
  --keep-artifacts    With lifecycle or release mode, preserve lifecycle temp artifacts; with dogfood, keep temp screenshots.
  --json              With dogfood mode, print the machine-readable report only.
  --model <id>        With lifecycle or release mode, Pi model for lifecycle tmux prompts (default ${DEFAULT_LIFECYCLE_MODEL}).
  --verbose           With lifecycle or release mode, print lifecycle progress details.
  --timeout-ms <ms>   With lifecycle or release mode, override the lifecycle per-step wait timeout (default ${DEFAULT_TIMEOUT_MS}).
  --list-files        With package mode, print every packed file path.
  --samples <n>       With startup-profile mode, fresh Node entrypoint samples.
  --json              With startup-profile mode, print machine-readable JSON.
  doctor              With platform-smoke mode, run setup doctor.
  run                 With platform-smoke mode, run target suites.
  --target <names>    With platform-smoke mode, comma-separated target list.
  --suite <name>      With platform-smoke mode, run one suite.

Environment:
  PI_AGENT_BROWSER_RELEASE_TARBALL  Inspect and smoke-load this retained candidate,
                                   including in each release platform-build suite.

Examples:
  npm run verify
  npm run verify -- command-reference
  npm run verify -- pre-pr
  npm run verify -- real-upstream
  npm run verify -- dogfood --keep-artifacts
  npm run verify -- startup-profile --samples 3
  npm run verify -- package --list-files
  npm run verify -- package-pi
  npm run verify -- lifecycle --keep-artifacts --verbose
  npm run verify -- platform-smoke doctor
  npm run verify -- platform-smoke run --target macos --suite platform-build
  npm run verify -- release

Publisher note:
  package.json prepublishOnly runs release (default + lifecycle + package-pi + platform smoke), then npm pack --dry-run during npm publish.
  It does not run real-upstream or dogfood; see docs/RELEASE.md#pre-release-checks.

Exit codes:
  0  Verification passed or help was shown.
  1  Verification failed.
  2  Usage error.`);
}
