/**
 * Purpose: Validate command-reference drift verification behavior for the local agent-browser documentation guard.
 * Responsibilities: Ensure metadata-driven token drift detection reports actionable failures for doc omissions and upstream/version mismatches without spawning real binaries in tests.
 * Scope: Unit tests for scripts/verify-command-reference.mjs and command-reference baseline generator exported helpers.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: Tests inject fake help/version/doc inputs and do not depend on local agent-browser runtime availability.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";
import { renderCommandReferenceBaselineBlock } from "../scripts/check-command-reference-baseline.mjs";
import {
  DOC_REQUIRED_TOKENS,
  EXPECTED_VERSION,
  HELP_COMMANDS,
  UPSTREAM_EXPECTATIONS,
  collectMissingTokens,
  stripGeneratedCapabilityBaselineBlocks,
  verifyCommandReference,
} from "../scripts/verify-command-reference.mjs";

function fakeHelpFor(label: string): string {
  return CAPABILITY_BASELINE.upstreamExpectations
    .filter((expectation) => expectation.help === label)
    .map((expectation) => expectation.token)
    .join("\n");
}

function completeDoc(): string {
  return CAPABILITY_BASELINE.docRequiredTokens.join("\n");
}

function fakeRunWithVersion(version: string): (args: readonly string[]) => Promise<string> {
  return async (args: readonly string[]) => {
    const key = args.join(" ");
    if (key === "--version") return `agent-browser ${version}`;
    if (key === "--help") return fakeHelpFor("root help");
    if (key === "tab --help") return fakeHelpFor("tab help");
    if (key === "snapshot --help") return fakeHelpFor("snapshot help");
    if (key === "wait --help") return fakeHelpFor("wait help");
    throw new Error(`Unexpected command in fake run: ${key}`);
  };
}

test("verifier exports use the canonical capability baseline", () => {
  assert.equal(EXPECTED_VERSION, CAPABILITY_BASELINE.targetVersion);
  assert.equal(HELP_COMMANDS, CAPABILITY_BASELINE.helpCommands);
  assert.equal(DOC_REQUIRED_TOKENS, CAPABILITY_BASELINE.docRequiredTokens);
  assert.equal(UPSTREAM_EXPECTATIONS, CAPABILITY_BASELINE.upstreamExpectations);
});

test("command-reference generated blocks render from the canonical capability baseline", () => {
  const upstreamBlock = renderCommandReferenceBaselineBlock("upstream-baseline");
  assert.match(upstreamBlock, new RegExp(`agent-browser ${CAPABILITY_BASELINE.targetVersion}`));

  const capabilityBlock = renderCommandReferenceBaselineBlock("capability-token-baseline");
  assert.ok(capabilityBlock.includes(`agent-browser ${CAPABILITY_BASELINE.targetVersion}`));
  assert.ok(capabilityBlock.includes(CAPABILITY_BASELINE.upstreamExpectations[0].token));
});

test("collectMissingTokens reports absent tokens only", () => {
  const text = "alpha beta";
  const missing = collectMissingTokens(text, ["alpha", "gamma"]);
  assert.deepEqual(missing, ["gamma"]);
});

test("stripGeneratedCapabilityBaselineBlocks removes generated content before human-token checks", () => {
  const generatedOnlyToken = CAPABILITY_BASELINE.docRequiredTokens[0];
  const content = [
    "human content",
    "<!-- agent-browser-capability-baseline:start capability-token-baseline -->",
    generatedOnlyToken,
    "<!-- agent-browser-capability-baseline:end capability-token-baseline -->",
  ].join("\n");

  assert.equal(stripGeneratedCapabilityBaselineBlocks(content).includes(generatedOnlyToken), false);
});

test("verifyCommandReference passes for matching fake upstream and doc content", async () => {
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion(CAPABILITY_BASELINE.targetVersion),
    readDoc: async () => completeDoc(),
  });

  assert.deepEqual(failures, []);
});

test("verifyCommandReference reports version drift", async () => {
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion("0.25.0"),
    readDoc: async () => completeDoc(),
  });

  assert.ok(failures.some((entry) => entry.includes("agent-browser version drift")));
});

test("verifyCommandReference reports missing upstream token", async () => {
  const run = async (args: readonly string[]) => {
    const key = args.join(" ");
    if (key === "--version") return `agent-browser ${CAPABILITY_BASELINE.targetVersion}`;
    if (key === "--help") return fakeHelpFor("root help").replace("skills", "");
    if (key === "tab --help") return fakeHelpFor("tab help");
    if (key === "snapshot --help") return fakeHelpFor("snapshot help");
    if (key === "wait --help") return fakeHelpFor("wait help");
    throw new Error(`Unexpected command in fake run: ${key}`);
  };

  const failures = await verifyCommandReference({ cwd: "/repo", run, readDoc: async () => completeDoc() });

  assert.ok(failures.some((entry) => entry.includes("Upstream root help no longer includes expected token")));
});

test("verifyCommandReference reports missing doc token", async () => {
  const docMissingToken = completeDoc().replace("skills list", "");
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion(CAPABILITY_BASELINE.targetVersion),
    readDoc: async () => docMissingToken,
  });

  assert.ok(failures.some((entry) => entry.includes("docs/COMMAND_REFERENCE.md is missing human-authored token: skills list")));
});
