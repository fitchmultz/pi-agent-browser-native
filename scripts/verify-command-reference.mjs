/**
 * Purpose: Verify that docs/COMMAND_REFERENCE.md tracks the installed agent-browser help surface targeted by this package.
 * Responsibilities: Execute upstream help commands, compare key command/option tokens against the local reference, and report actionable drift failures.
 * Scope: Documentation drift detection only; it does not validate browser runtime behavior or package contents.
 * Usage: Run with `node scripts/verify-command-reference.mjs`, `npm run verify:command-reference`, or as part of `npm run verify`.
 * Invariants/Assumptions: This package targets the currently installed agent-browser 0.26.0 surface and does not provide backwards-compatibility shims for older upstream versions.
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const EXPECTED_VERSION = "0.26.0";
const DOC_PATH = "docs/COMMAND_REFERENCE.md";

const HELP_COMMANDS = [
  { label: "root help", args: ["--help"] },
  { label: "tab help", args: ["tab", "--help"] },
  { label: "snapshot help", args: ["snapshot", "--help"] },
  { label: "wait help", args: ["wait", "--help"] },
];

export const DOC_REQUIRED_TOKENS = [
  "agent-browser 0.26.0",
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
];

export const UPSTREAM_EXPECTATIONS = [
  { token: "skills", help: "root help" },
  { token: "keyboard", help: "root help" },
  { token: "scroll", help: "root help" },
  { token: "scrollintoview", help: "root help" },
  { token: "connect", help: "root help" },
  { token: "is", help: "root help" },
  { token: "find", help: "root help" },
  { token: "mouse", help: "root help" },
  { token: "set", help: "root help" },
  { token: "network", help: "root help" },
  { token: "cookies [get|set|clear]", help: "root help" },
  { token: "storage", help: "root help" },
  { token: "diff snapshot", help: "root help" },
  { token: "trace start|stop [path]", help: "root help" },
  { token: "profiler start|stop [path]", help: "root help" },
  { token: "record start <path> [url]", help: "root help" },
  { token: "console [--clear]", help: "root help" },
  { token: "errors [--clear]", help: "root help" },
  { token: "highlight <sel>", help: "root help" },
  { token: "inspect", help: "root help" },
  { token: "clipboard <op> [text]", help: "root help" },
  { token: "stream enable [--port <n>]", help: "root help" },
  { token: "auth save <name>", help: "root help" },
  { token: "confirm <id>", help: "root help" },
  { token: "deny <id>", help: "root help" },
  { token: "chat <message>", help: "root help" },
  { token: "dashboard start --port <n>", help: "root help" },
  { token: "install --with-deps", help: "root help" },
  { token: "upgrade", help: "root help" },
  { token: "doctor [--fix]", help: "root help" },
  { token: "profiles", help: "root help" },
  { token: "-u, --urls", help: "snapshot help" },
  { token: "--download [path]", help: "wait help" },
  { token: "new --label <name> [url]", help: "tab help" },
];

export function collectMissingTokens(text, tokens) {
  return tokens.filter((token) => !text.includes(token));
}

function printHelp() {
  console.log(`verify-command-reference.mjs

Usage:
  node scripts/verify-command-reference.mjs

Checks:
  1. agent-browser is installed on PATH.
  2. agent-browser --version is ${EXPECTED_VERSION}.
  3. Expected 0.26.0 help tokens are present upstream.
  4. docs/COMMAND_REFERENCE.md includes the maintained local reference tokens.

Examples:
  npm run verify:command-reference
  npm run verify

Exit codes:
  0  Verification passed.
  1  Verification failed.
  2  Usage error.
`);
}

async function runAgentBrowser(args) {
  try {
    const { stdout, stderr } = await execFile("agent-browser", args, { maxBuffer: 10 * 1024 * 1024 });
    return `${stdout}${stderr}`;
  } catch (error) {
    throw new Error(
      `Failed to run agent-browser ${args.join(" ")}. Install or update agent-browser before verifying the command reference.\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function verifyCommandReference({
  cwd = process.cwd(),
  run = runAgentBrowser,
  readDoc = (path) => readFile(path, "utf8"),
} = {}) {
  const failures = [];

  const versionOutput = await run(["--version"]);
  const version = versionOutput.trim().replace(/^agent-browser\s+/, "");
  if (version !== EXPECTED_VERSION) {
    failures.push(
      `agent-browser version drift: expected ${EXPECTED_VERSION}, found ${version || "<empty>"}. Refresh docs/COMMAND_REFERENCE.md and this verifier.`,
    );
  }

  const helpByLabel = new Map();
  for (const command of HELP_COMMANDS) {
    helpByLabel.set(command.label, await run(command.args));
  }

  for (const expectation of UPSTREAM_EXPECTATIONS) {
    const helpText = helpByLabel.get(expectation.help) ?? "";
    if (!helpText.includes(expectation.token)) {
      failures.push(`Upstream ${expectation.help} no longer includes expected token: ${expectation.token}`);
    }
  }

  const doc = await readDoc(join(cwd, DOC_PATH));
  for (const missingToken of collectMissingTokens(doc, DOC_REQUIRED_TOKENS)) {
    failures.push(`${DOC_PATH} is missing token: ${missingToken}`);
  }

  return failures;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return 0;
  }

  if (argv.length > 0) {
    console.error(`Unknown option(s): ${argv.join(", ")}`);
    console.error("Run with --help for usage.");
    return 2;
  }

  try {
    const failures = await verifyCommandReference();
    if (failures.length > 0) {
      console.error("Command reference verification failed:");
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      return 1;
    }
    console.log("Command reference verification passed.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
