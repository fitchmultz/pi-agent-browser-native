/**
 * Purpose: Validate the deterministic agent-browser efficiency benchmark used before higher-level agent UX abstractions.
 * Responsibilities: Lock representative workflow coverage, aggregate metric accounting, and regression comparison behavior.
 * Scope: Unit tests only; the benchmark intentionally does not launch a browser.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: RQ-0057 requires metrics for task success, tool calls, model-visible output size, stale refs, artifact success, and elapsed time.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error The benchmark is a local ESM maintainer script without a declaration file.
import * as benchmarkModule from "../scripts/agent-browser-efficiency-benchmark.mjs";

interface BenchmarkScenarioInput {
  id: string;
  [key: string]: unknown;
}

interface BenchmarkScenarioSummary {
  artifactSuccesses: number;
  failureCategories: string[];
  id: string;
  modelVisibleBytes: number;
  staleRefFailures: number;
  staleRefRecoveries: number;
  success: boolean;
  toolCalls: number;
  workflow: string;
}

interface BenchmarkMetrics {
  artifactSuccesses: number;
  elapsedMsEstimate: number;
  failureCategoriesCovered: string[];
  failureCategoryCoverage: number;
  modelVisibleBytes: number;
  scenarios: number;
  staleRefFailures: number;
  staleRefRecoveries: number;
  successes: number;
  successRate: number;
  toolCalls: number;
}

interface JsonlWorkflowSample {
  p95ModelVisibleBytes: number;
  toolResultCount: number;
  workflowId: string;
}

interface JsonlSampleReport {
  byWorkflow: JsonlWorkflowSample[];
  toolResultCount: number;
  totalModelVisibleBytes: number;
}

interface BenchmarkReport {
  jsonlSample?: JsonlSampleReport;
  metrics: BenchmarkMetrics;
  scenarios: BenchmarkScenarioSummary[];
  version: number;
}

const {
  BENCHMARK_SCENARIOS,
  agentBrowserToolResults,
  buildBenchmarkReport,
  buildJsonlSampleReport,
  compareBenchmarkReports,
  inferJsonlWorkflowId,
  measureToolResultModelVisibleBytes,
  parseJsonl,
  percentile95,
  sampleAgentBrowserJsonl,
  summarizeScenario,
}: {
  BENCHMARK_SCENARIOS: BenchmarkScenarioInput[];
  agentBrowserToolResults: (entries: unknown[]) => unknown[];
  buildBenchmarkReport: (options?: { jsonlSample?: JsonlSampleReport }) => BenchmarkReport;
  buildJsonlSampleReport: (options: { path: string; results: unknown[] }) => JsonlSampleReport;
  compareBenchmarkReports: (current: BenchmarkReport, candidate: BenchmarkReport) => { passed: boolean; regressions: string[] };
  inferJsonlWorkflowId: (message: unknown) => string;
  measureToolResultModelVisibleBytes: (message: unknown) => number;
  parseJsonl: (text: string) => unknown[];
  percentile95: (values: number[]) => number;
  sampleAgentBrowserJsonl: (path: string) => Promise<JsonlSampleReport>;
  summarizeScenario: (scenario: BenchmarkScenarioInput) => BenchmarkScenarioSummary;
} = benchmarkModule;

const sampleFixturePath = join(import.meta.dirname, "fixtures", "agent-browser-efficiency-sample.jsonl");

const requiredScenarioIds = new Set([
  "open-snapshot",
  "click-verify-navigation",
  "fill-assert",
  "stale-ref-recovery",
  "artifact-download",
  "batch-open-snapshot",
  "batch-multi-extract",
  "electron-lifecycle",
  "electron-probe",
  "job-open-assert-screenshot",
  "qa-open-diagnostics",
  "source-lookup-visible-element",
  "network-source-lookup-failed-request",
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

  assert.equal(report.version, 2);
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

test("benchmark includes deterministic Electron lifecycle and probe scenario metric shapes", () => {
  const report = buildBenchmarkReport();
  const lifecycle = report.scenarios.find((scenario: { id: string }) => scenario.id === "electron-lifecycle");
  const probe = report.scenarios.find((scenario: { id: string }) => scenario.id === "electron-probe");

  assert.ok(lifecycle);
  assert.equal(lifecycle.workflow, "native-electron-lifecycle");
  assert.equal(lifecycle.toolCalls, 3);
  assert.equal(lifecycle.success, true);
  assert.equal(lifecycle.artifactSuccesses, 0);
  assert.deepEqual(lifecycle.failureCategories, []);
  assert.ok(lifecycle.modelVisibleBytes > 0);

  assert.ok(probe);
  assert.equal(probe.workflow, "native-electron-probe");
  assert.equal(probe.toolCalls, 1);
  assert.equal(probe.success, true);
  assert.equal(probe.staleRefFailures, 0);
  assert.ok(probe.modelVisibleBytes > 0);
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

test("percentile95 uses the 95th rank for sorted byte samples", () => {
  assert.equal(percentile95([10, 20, 30, 40, 100]), 100);
  assert.equal(percentile95([5]), 5);
  assert.equal(percentile95([]), 0);
});

test("measureToolResultModelVisibleBytes counts text content only", () => {
  const bytes = measureToolResultModelVisibleBytes({
    content: [{ type: "text", text: "hello" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    details: { command: "open", effectiveArgs: ["open", "https://secret.example/?token=abc"] },
  });
  assert.equal(bytes, Buffer.byteLength("hello", "utf8"));
});

test("inferJsonlWorkflowId maps wrapper details to pragmatic workflow ids", () => {
  assert.equal(inferJsonlWorkflowId({ details: { compiledQaPreset: { checks: {} } } }), "native-qa");
  assert.equal(inferJsonlWorkflowId({ details: { compiledJob: { steps: [] } } }), "native-job");
  assert.equal(inferJsonlWorkflowId({ details: { command: "batch" } }), "current-batch");
  assert.equal(inferJsonlWorkflowId({ details: { command: "snapshot" } }), "current-raw");
  assert.equal(inferJsonlWorkflowId({}), "unspecified");
});

test("inferJsonlWorkflowId infers commands from effectiveArgs without treating --json as a value flag", () => {
  assert.equal(
    inferJsonlWorkflowId({ details: { effectiveArgs: ["--json", "open", "https://example.test"] } }),
    "current-raw",
  );
  assert.equal(
    inferJsonlWorkflowId({ details: { effectiveArgs: ["--json", "--session", "s1", "batch"] } }),
    "current-batch",
  );
  assert.equal(
    inferJsonlWorkflowId({
      details: { effectiveArgs: ["--json", "--profile", "Default", "open", "https://example.test"] },
    }),
    "current-raw",
  );
});

test("parseJsonl and agentBrowserToolResults read agent_browser tool results", () => {
  const entries = parseJsonl([
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "agent_browser", content: [{ type: "text", text: "abc" }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "skip" }] } }),
    "",
  ].join("\n"));
  const results = agentBrowserToolResults(entries);
  assert.equal(results.length, 1);
  assert.equal(measureToolResultModelVisibleBytes(results[0]), Buffer.byteLength("abc", "utf8"));
});

test("parseJsonl reports malformed transcript lines", () => {
  assert.throws(() => parseJsonl('{"ok":true}\nnot-json'), /Invalid JSONL at line 2/);
});

test("buildJsonlSampleReport groups bytes and p95 by workflow", () => {
  const report = buildJsonlSampleReport({
    path: "/tmp/sample.jsonl",
    results: [
      { content: [{ type: "text", text: "a" }], details: { command: "open" } },
      { content: [{ type: "text", text: "bb" }], details: { command: "snapshot" } },
      { content: [{ type: "text", text: "ccc" }], details: { compiledQaPreset: { checks: {} } } },
    ],
  });
  assert.equal(report.toolResultCount, 3);
  assert.equal(report.totalModelVisibleBytes, Buffer.byteLength("a", "utf8") + Buffer.byteLength("bb", "utf8") + Buffer.byteLength("ccc", "utf8"));
  const raw = report.byWorkflow.find((row: { workflowId: string }) => row.workflowId === "current-raw");
  const qa = report.byWorkflow.find((row: { workflowId: string }) => row.workflowId === "native-qa");
  assert.ok(raw);
  assert.equal(raw.toolResultCount, 2);
  assert.equal(raw.p95ModelVisibleBytes, Buffer.byteLength("bb", "utf8"));
  assert.ok(qa);
  assert.equal(qa.p95ModelVisibleBytes, Buffer.byteLength("ccc", "utf8"));
});

test("sampleAgentBrowserJsonl reads fixture transcripts", async () => {
  const report = await sampleAgentBrowserJsonl(sampleFixturePath);
  assert.equal(report.toolResultCount, 4);
  assert.ok(report.totalModelVisibleBytes > 0);
  assert.ok(report.byWorkflow.some((row: { workflowId: string }) => row.workflowId === "current-raw"));
  assert.ok(report.byWorkflow.some((row: { workflowId: string }) => row.workflowId === "native-job"));
  assert.ok(report.byWorkflow.some((row: { workflowId: string }) => row.workflowId === "native-qa"));
});

test("sampleAgentBrowserJsonl rejects missing files", async () => {
  await assert.rejects(() => sampleAgentBrowserJsonl(join(tmpdir(), `missing-${Date.now()}.jsonl`)), /ENOENT|Failed|sample/i);
});

test("default benchmark report omits jsonlSample unless provided", () => {
  const withoutSample = buildBenchmarkReport();
  assert.equal("jsonlSample" in withoutSample, false);

  const withSample = buildBenchmarkReport({
    jsonlSample: buildJsonlSampleReport({
      path: "/tmp/x.jsonl",
      results: [{ content: [{ type: "text", text: "x" }], details: { command: "open" } }],
    }),
  });
  assert.ok(withSample.jsonlSample);
  assert.equal(withSample.jsonlSample.toolResultCount, 1);
});

test("benchmark comparison ignores optional jsonlSample blocks", () => {
  const current = buildBenchmarkReport();
  const candidate = {
    ...current,
    jsonlSample: {
      path: "/tmp/other.jsonl",
      toolResultCount: 99,
      totalModelVisibleBytes: 999_999,
      p95ModelVisibleBytes: 999_999,
      byWorkflow: [],
      errorResultCount: 0,
    },
  };
  const comparison = compareBenchmarkReports(current, candidate);
  assert.equal(comparison.passed, true);
});

test("main rejects invalid JSONL sample paths", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-benchmark-jsonl-"));
  const invalidPath = join(tempDir, "invalid.jsonl");
  await writeFile(invalidPath, '{"ok":true}\nnot-json\n', "utf8");
  const exitCode = await benchmarkModule.main(["--sample-jsonl", invalidPath, "--json"]);
  assert.equal(exitCode, 1);
});
