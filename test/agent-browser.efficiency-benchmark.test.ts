/**
 * Purpose: Validate the deterministic agent-browser efficiency benchmark used before higher-level agent UX abstractions.
 * Responsibilities: Lock representative workflow coverage, aggregate metric accounting, and regression comparison behavior.
 * Scope: Unit tests only; the benchmark intentionally does not launch a browser.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: RQ-0057 requires metrics for task success, tool calls, model-visible output size, stale refs, artifact success, and elapsed time.
 */

import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The benchmark is a local ESM maintainer script without a declaration file.
import * as benchmarkModule from "../scripts/agent-browser-efficiency-benchmark.mjs";

const {
  BENCHMARK_SCENARIOS,
  buildBenchmarkReport,
  compareBenchmarkReports,
  summarizeScenario,
}: {
  BENCHMARK_SCENARIOS: Array<{ id: string }>;
  buildBenchmarkReport: () => any;
  compareBenchmarkReports: (current: any, candidate: any) => { passed: boolean; regressions: string[] };
  summarizeScenario: (scenario: any) => any;
} = benchmarkModule;

const requiredScenarioIds = new Set([
  "open-snapshot",
  "click-verify-navigation",
  "fill-assert",
  "stale-ref-recovery",
  "artifact-download",
  "batch-open-snapshot",
  "job-open-assert-screenshot",
  "qa-open-diagnostics",
  "source-lookup-visible-element",
]);

test("benchmark covers representative browser workflow shapes", () => {
  assert.deepEqual(new Set(BENCHMARK_SCENARIOS.map((scenario: { id: string }) => scenario.id)), requiredScenarioIds);
});

test("scenario summary measures model-visible bytes and workflow outcomes", () => {
  const scenario = BENCHMARK_SCENARIOS.find((entry: { id: string }) => entry.id === "stale-ref-recovery");
  assert.ok(scenario);

  const summary = summarizeScenario(scenario);
  assert.equal(summary.toolCalls, 5);
  assert.equal(summary.success, true);
  assert.equal(summary.staleRefFailures, 1);
  assert.equal(summary.staleRefRecoveries, 1);
  assert.ok(summary.modelVisibleBytes > 0);
});

test("benchmark report aggregates required efficiency metrics", () => {
  const report = buildBenchmarkReport();

  assert.equal(report.version, 1);
  assert.equal(report.metrics.scenarios, requiredScenarioIds.size);
  assert.equal(report.metrics.successes, requiredScenarioIds.size);
  assert.equal(report.metrics.staleRefFailures, 1);
  assert.equal(report.metrics.staleRefRecoveries, 1);
  assert.equal(report.metrics.artifactSuccesses, 3);
  assert.deepEqual(report.metrics.failureCategoriesCovered, ["artifact-completion", "stale-ref"]);
  assert.equal(report.metrics.failureCategoryCoverage, 2);
  assert.ok(report.metrics.toolCalls > report.metrics.scenarios);
  assert.ok(report.metrics.modelVisibleBytes > 0);
  assert.ok(report.metrics.elapsedMsEstimate > 0);
});

test("benchmark comparison detects regressions in agent-visible costs and outcomes", () => {
  const current = buildBenchmarkReport();
  const candidate = {
    ...current,
    metrics: {
      ...current.metrics,
      successRate: current.metrics.successRate - 0.1,
      toolCalls: current.metrics.toolCalls + 1,
      modelVisibleBytes: current.metrics.modelVisibleBytes + 1,
      staleRefFailures: current.metrics.staleRefFailures + 1,
      artifactSuccesses: current.metrics.artifactSuccesses - 1,
      elapsedMsEstimate: current.metrics.elapsedMsEstimate + 1,
      failureCategoriesCovered: ["stale-ref"],
    },
  };

  const comparison = compareBenchmarkReports(current, candidate);

  assert.equal(comparison.passed, false);
  assert.equal(comparison.regressions.length, 7);
});

test("benchmark comparison rejects incompatible versions and scenario sets", () => {
  const current = buildBenchmarkReport();
  const candidate = {
    ...current,
    version: current.version + 1,
    scenarios: current.scenarios.slice(1),
  };

  const comparison = compareBenchmarkReports(current, candidate);

  assert.equal(comparison.passed, false);
  assert.match(comparison.regressions.join("\n"), /benchmark version changed/);
  assert.match(comparison.regressions.join("\n"), /candidate omitted benchmark scenarios: open-snapshot/);
});

test("benchmark comparison accepts equal or improved candidate metrics", () => {
  const current = buildBenchmarkReport();
  const candidate = {
    ...current,
    metrics: {
      ...current.metrics,
      toolCalls: current.metrics.toolCalls - 1,
      modelVisibleBytes: current.metrics.modelVisibleBytes - 10,
      staleRefFailures: 0,
    },
  };

  const comparison = compareBenchmarkReports(current, candidate);

  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.regressions, []);
});
