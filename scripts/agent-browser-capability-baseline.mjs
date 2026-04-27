/**
 * Purpose: Define the canonical upstream agent-browser capability baseline targeted by this package.
 * Responsibilities: Store the target upstream version, sampled help commands, and verifier/doc token expectations in one importable metadata object.
 * Scope: Versioned capability metadata only; it does not execute agent-browser or validate documentation by itself.
 * Usage: Imported by command-reference verifier, generated docs checker, and tests when upstream agent-browser is re-baselined.
 * Invariants/Assumptions: This package targets the current installed upstream agent-browser only and does not keep compatibility shims for older versions.
 */

export const CAPABILITY_BASELINE_SOURCE = "scripts/agent-browser-capability-baseline.mjs";
export const COMMAND_REFERENCE_DOC_PATH = "docs/COMMAND_REFERENCE.md";
export const CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX = "agent-browser-capability-baseline";
export const COMMAND_REFERENCE_BASELINE_BLOCK_IDS = Object.freeze(["upstream-baseline", "capability-token-baseline"]);

export const CAPABILITY_BASELINE = Object.freeze({
  targetVersion: "0.26.0",
  helpCommands: Object.freeze([
    Object.freeze({ label: "root help", args: Object.freeze(["--help"]) }),
    Object.freeze({ label: "tab help", args: Object.freeze(["tab", "--help"]) }),
    Object.freeze({ label: "snapshot help", args: Object.freeze(["snapshot", "--help"]) }),
    Object.freeze({ label: "wait help", args: Object.freeze(["wait", "--help"]) }),
  ]),
  docRequiredTokens: Object.freeze([
    "skills list",
    "skills get core --full",
    "keyboard type <text>",
    "scroll <dir> [px]",
    "scrollintoview <sel>",
    "connect <port|url>",
    "is <what> <selector>",
    "find <locator> <value> <action>",
    "mouse <action> [args]",
    "set <setting> [value]",
    "network <action>",
    "cookies [get|set|clear]",
    "storage <local|session>",
    "diff snapshot",
    "trace start|stop [path]",
    "profiler start|stop [path]",
    "record start <path> [url]",
    "console [--clear]",
    "errors [--clear]",
    "highlight <sel>",
    "inspect",
    "clipboard <op> [text]",
    "stream enable [--port <n>]",
    "auth save <name>",
    "confirm <id>",
    "deny <id>",
    "chat <message>",
    "dashboard start --port <n>",
    "install --with-deps",
    "upgrade",
    "doctor [--fix]",
    "profiles",
    "snapshot -i --urls",
    "snapshot --urls",
    "wait --download [path]",
    "tab new --label <name> [url]",
    "--action-policy <path>",
    "--confirm-actions <list>",
    "--engine <name>",
    "AGENT_BROWSER_CONFIG",
  ]),
  upstreamExpectations: Object.freeze([
    Object.freeze({ token: "skills", help: "root help" }),
    Object.freeze({ token: "keyboard", help: "root help" }),
    Object.freeze({ token: "scroll", help: "root help" }),
    Object.freeze({ token: "scrollintoview", help: "root help" }),
    Object.freeze({ token: "connect", help: "root help" }),
    Object.freeze({ token: "is", help: "root help" }),
    Object.freeze({ token: "find", help: "root help" }),
    Object.freeze({ token: "mouse", help: "root help" }),
    Object.freeze({ token: "set", help: "root help" }),
    Object.freeze({ token: "network", help: "root help" }),
    Object.freeze({ token: "cookies [get|set|clear]", help: "root help" }),
    Object.freeze({ token: "storage", help: "root help" }),
    Object.freeze({ token: "diff snapshot", help: "root help" }),
    Object.freeze({ token: "trace start|stop [path]", help: "root help" }),
    Object.freeze({ token: "profiler start|stop [path]", help: "root help" }),
    Object.freeze({ token: "record start <path> [url]", help: "root help" }),
    Object.freeze({ token: "console [--clear]", help: "root help" }),
    Object.freeze({ token: "errors [--clear]", help: "root help" }),
    Object.freeze({ token: "highlight <sel>", help: "root help" }),
    Object.freeze({ token: "inspect", help: "root help" }),
    Object.freeze({ token: "clipboard <op> [text]", help: "root help" }),
    Object.freeze({ token: "stream enable [--port <n>]", help: "root help" }),
    Object.freeze({ token: "auth save <name>", help: "root help" }),
    Object.freeze({ token: "confirm <id>", help: "root help" }),
    Object.freeze({ token: "deny <id>", help: "root help" }),
    Object.freeze({ token: "chat <message>", help: "root help" }),
    Object.freeze({ token: "dashboard start --port <n>", help: "root help" }),
    Object.freeze({ token: "install --with-deps", help: "root help" }),
    Object.freeze({ token: "upgrade", help: "root help" }),
    Object.freeze({ token: "doctor [--fix]", help: "root help" }),
    Object.freeze({ token: "profiles", help: "root help" }),
    Object.freeze({ token: "-u, --urls", help: "snapshot help" }),
    Object.freeze({ token: "--download [path]", help: "wait help" }),
    Object.freeze({ token: "new --label <name> [url]", help: "tab help" }),
  ]),
});

export function expectedVersionLabel() {
  return `agent-browser ${CAPABILITY_BASELINE.targetVersion}`;
}
