/**
 * Purpose: Validate command-reference drift verification behavior for the local agent-browser documentation guard.
 * Responsibilities: Ensure token drift detection reports actionable failures for doc omissions and upstream/version mismatches without spawning real binaries in tests.
 * Scope: Unit tests for scripts/verify-command-reference.mjs exported helpers and verifier orchestration.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: Tests inject fake help/version/doc inputs and do not depend on local agent-browser runtime availability.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DOC_REQUIRED_TOKENS,
  UPSTREAM_EXPECTATIONS,
  collectMissingTokens,
  verifyCommandReference,
} from "../scripts/verify-command-reference.mjs";

function fakeHelpFor(label: string): string {
  return UPSTREAM_EXPECTATIONS.filter((expectation) => expectation.help === label)
    .map((expectation) => expectation.token)
    .join("\n");
}

function completeDoc(): string {
  return DOC_REQUIRED_TOKENS.join("\n");
}

function fakeRunWithVersion(version: string): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const key = args.join(" ");
    if (key === "--version") return `agent-browser ${version}`;
    if (key === "--help") return fakeHelpFor("root help");
    if (key === "tab --help") return fakeHelpFor("tab help");
    if (key === "snapshot --help") return fakeHelpFor("snapshot help");
    if (key === "wait --help") return fakeHelpFor("wait help");
    throw new Error(`Unexpected command in fake run: ${key}`);
  };
}

test("collectMissingTokens reports absent tokens only", () => {
  const text = "alpha beta";
  const missing = collectMissingTokens(text, ["alpha", "gamma"]);
  assert.deepEqual(missing, ["gamma"]);
});

test("verifyCommandReference passes for matching fake upstream and doc content", async () => {
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion("0.26.0"),
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
  const run = async (args: string[]) => {
    const key = args.join(" ");
    if (key === "--version") return "agent-browser 0.26.0";
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
    run: fakeRunWithVersion("0.26.0"),
    readDoc: async () => docMissingToken,
  });

  assert.ok(failures.some((entry) => entry.includes("docs/COMMAND_REFERENCE.md is missing token: skills list")));
});
