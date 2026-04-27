#!/usr/bin/env node
/**
 * Purpose: Prevent drift between canonical agent-browser capability metadata and checked-in command-reference generated blocks.
 * Responsibilities: Render versioned baseline Markdown from scripts/agent-browser-capability-baseline.mjs, update marked blocks in write mode, and fail verification when docs are stale.
 * Scope: Documentation synchronization only; it does not execute agent-browser or validate live upstream help.
 * Usage: Run `npm run docs:command-reference:check` or `npm run docs:command-reference:write` after editing the capability baseline.
 * Invariants/Assumptions: Generated blocks are bounded by stable HTML comments and all capability data comes from the canonical metadata source.
 */

import { readFile, writeFile } from "node:fs/promises";

import {
  CAPABILITY_BASELINE,
  CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX,
  CAPABILITY_BASELINE_SOURCE,
  COMMAND_REFERENCE_BASELINE_BLOCK_IDS,
  COMMAND_REFERENCE_DOC_PATH,
} from "./agent-browser-capability-baseline.mjs";

const GENERATED_NOTICE = `<!-- Generated from ${CAPABILITY_BASELINE_SOURCE}. Run \`npm run docs:command-reference:write\` to update. Do not edit manually. -->`;

function printHelp() {
  console.log(`Usage: node ./scripts/check-command-reference-baseline.mjs [--check|--write]

Checks or rewrites generated Markdown blocks sourced from the canonical agent-browser capability baseline.

Options:
  --check     Verify checked-in generated blocks match the canonical baseline (default)
  --write     Rewrite generated blocks in-place
  -h, --help  Show this help

Examples:
  npm run docs:command-reference:check
  npm run docs:command-reference:write

Exit codes:
  0  generated blocks match, write completed, or help was shown
  1  drift found, invalid arguments, missing markers, or file update failed`);
}

function parseMode(argv) {
  if (argv.length === 0) return "check";
  if (argv.length === 1 && argv[0] === "--check") return "check";
  if (argv.length === 1 && argv[0] === "--write") return "write";
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) return "help";
  throw new Error(`Invalid arguments: ${argv.join(" ")}`);
}

function bullets(lines) {
  return lines.map((line) => `- ${line}`).join("\n");
}

export function renderCommandReferenceBaselineBlock(id) {
  switch (id) {
    case "upstream-baseline":
      return [
        `This reference is baselined to the locally installed \`agent-browser ${CAPABILITY_BASELINE.targetVersion}\` command/help surface. Upstream \`agent-browser\` remains the source of truth for command semantics; this file is the local fallback for Pi agent sessions where direct binary help is blocked or discouraged.`,
        "",
        "The lightweight drift check is `npm run verify:command-reference`. Run it whenever the installed upstream `agent-browser` version changes or this reference is edited.",
      ].join("\n");
    case "capability-token-baseline":
      return [
        `<details>`,
        `<summary>Generated verifier capability baseline for agent-browser ${CAPABILITY_BASELINE.targetVersion}</summary>`,
        "",
        "This generated block is review data for maintainers. The human-authored reference sections above remain the readable command guide.",
        "",
        "#### Upstream help commands sampled",
        bullets(CAPABILITY_BASELINE.helpCommands.map((command) => `${command.label}: \`agent-browser ${command.args.join(" ")}\``)),
        "",
        "#### Upstream help tokens expected",
        bullets(CAPABILITY_BASELINE.upstreamExpectations.map((entry) => `${entry.help}: \`${entry.token}\``)),
        "",
        `</details>`,
      ].join("\n");
    default:
      throw new Error(`Unknown command-reference baseline block: ${id}`);
  }
}

export function markedCommandReferenceBaselineBlock(id) {
  return [
    `<!-- ${CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX}:start ${id} -->`,
    GENERATED_NOTICE,
    renderCommandReferenceBaselineBlock(id),
    `<!-- ${CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX}:end ${id} -->`,
  ].join("\n");
}

function replaceBlock(content, id, path) {
  const start = `<!-- ${CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX}:start ${id} -->`;
  const end = `<!-- ${CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX}:end ${id} -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`${path} is missing generated command-reference baseline block markers for ${id}`);
  }
  const afterEndIndex = endIndex + end.length;
  const current = content.slice(startIndex, afterEndIndex);
  const expected = markedCommandReferenceBaselineBlock(id);
  return {
    next: `${content.slice(0, startIndex)}${expected}${content.slice(afterEndIndex)}`,
    drifted: current !== expected,
  };
}

async function processTarget(mode) {
  let content = await readFile(COMMAND_REFERENCE_DOC_PATH, "utf8");
  const staleBlocks = [];
  for (const block of COMMAND_REFERENCE_BASELINE_BLOCK_IDS) {
    const result = replaceBlock(content, block, COMMAND_REFERENCE_DOC_PATH);
    content = result.next;
    if (result.drifted) staleBlocks.push(`${COMMAND_REFERENCE_DOC_PATH}#${block}`);
  }
  if (mode === "write" && staleBlocks.length > 0) {
    await writeFile(COMMAND_REFERENCE_DOC_PATH, content, "utf8");
  }
  return staleBlocks;
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  if (mode === "help") {
    printHelp();
    return 0;
  }

  const staleBlocks = await processTarget(mode);
  if (staleBlocks.length === 0) {
    console.log(`agent-browser command-reference baseline docs are ${mode === "check" ? "in sync" : "up to date"}.`);
    return 0;
  }
  if (mode === "write") {
    console.log(`Updated generated command-reference baseline blocks:\n${staleBlocks.map((block) => `- ${block}`).join("\n")}`);
    return 0;
  }
  throw new Error(
    `Generated command-reference baseline blocks are stale. Run \`npm run docs:command-reference:write\`.\n${staleBlocks.map((block) => `- ${block}`).join("\n")}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
