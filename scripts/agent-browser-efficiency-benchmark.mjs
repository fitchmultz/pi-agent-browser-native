#!/usr/bin/env node
/**
 * Purpose: Provide a deterministic benchmark for agent-facing browser workflow efficiency.
 * Responsibilities: Model representative agent_browser workflows, compute comparable efficiency metrics, and optionally compare a future candidate run against this baseline.
 * Scope: Local benchmark accounting only; it does not launch a browser or mutate profiles/sessions.
 * Usage: Run `node scripts/agent-browser-efficiency-benchmark.mjs`, `--json`, or `--compare <path>`.
 * Invariants/Assumptions: Scenarios represent high-value workflow shapes agents perform today; future browser UX tasks should update or compare against this benchmark when claiming call-count, output-size, stale-ref, artifact, or success-rate improvements.
 */

import { readFile } from "node:fs/promises";

const CURRENT_BENCHMARK_VERSION = 1;

export const BENCHMARK_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "open-snapshot",
    title: "Open a page and inspect interactive controls",
    workflow: "current-raw",
    steps: Object.freeze([
      Object.freeze({ call: "agent_browser", args: Object.freeze(["open", "https://example.com"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["snapshot", "-i"]) }),
    ]),
    modelOutputs: Object.freeze([
      "Opened https://example.com\nTitle: Example Domain\nURL: https://example.com/",
      "Page: Example Domain\nURL: https://example.com/\n@e1 [link] \"More information...\"",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 1200,
  }),
  Object.freeze({
    id: "click-verify-navigation",
    title: "Click a link and verify the resulting page",
    workflow: "current-raw",
    steps: Object.freeze([
      Object.freeze({ call: "agent_browser", args: Object.freeze(["snapshot", "-i"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["click", "@e1"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["wait", "--load", "networkidle"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["snapshot", "-i", "--urls"]) }),
    ]),
    modelOutputs: Object.freeze([
      "@e1 [link] \"Docs\" href=\"/docs\"",
      "Clicked @e1\nTitle: Documentation\nURL: https://example.com/docs",
      "Load state reached: networkidle",
      "Page: Documentation\nURL: https://example.com/docs\n@e1 [link] \"API\" href=\"/api\"\n@e2 [button] \"Search\"",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 2600,
  }),
  Object.freeze({
    id: "fill-assert",
    title: "Fill a field and assert the entered value",
    workflow: "current-raw",
    steps: Object.freeze([
      Object.freeze({ call: "agent_browser", args: Object.freeze(["open", "https://example.com/form"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["snapshot", "-i"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["fill", "@e2", "agent@example.com"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["get", "value", "@e2"]) }),
    ]),
    modelOutputs: Object.freeze([
      "Opened https://example.com/form\nTitle: Example Form",
      "@e1 [label] \"Email\"\n@e2 [input type=email] placeholder=\"Email\"\n@e3 [button] \"Submit\"",
      "Filled @e2",
      "agent@example.com",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 2100,
  }),
  Object.freeze({
    id: "stale-ref-recovery",
    title: "Encounter a stale ref after rerender and recover manually",
    workflow: "current-raw",
    steps: Object.freeze([
      Object.freeze({ call: "agent_browser", args: Object.freeze(["snapshot", "-i"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["click", "@e3"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["click", "@e4"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["snapshot", "-i"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["find", "role", "button", "click", "--name", "Continue"]) }),
    ]),
    modelOutputs: Object.freeze([
      "@e3 [button] \"Open panel\"\n@e4 [button] \"Continue\"",
      "Clicked @e3\nPanel opened and page rerendered.",
      "Error: Unknown ref: e4\nRefs may be stale. Run snapshot -i again.",
      "@e1 [button] \"Continue\"\n@e2 [button] \"Cancel\"",
      "Clicked button named Continue",
    ]),
    success: true,
    staleRefFailures: 1,
    staleRefRecoveries: 1,
    artifactSuccesses: 0,
    failureCategories: Object.freeze(["stale-ref"]),
    elapsedMsEstimate: 3600,
  }),
  Object.freeze({
    id: "artifact-download",
    title: "Trigger a download and verify artifact metadata",
    workflow: "current-raw",
    steps: Object.freeze([
      Object.freeze({ call: "agent_browser", args: Object.freeze(["click", "@export"]) }),
      Object.freeze({ call: "agent_browser", args: Object.freeze(["wait", "--download", "/tmp/report.csv"]) }),
    ]),
    modelOutputs: Object.freeze([
      "Clicked @export\nDownload may start asynchronously.",
      "Download completed: /tmp/report.csv\nArtifact: exists=true size=1284 type=text/csv",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 1,
    failureCategories: Object.freeze(["artifact-completion"]),
    elapsedMsEstimate: 2800,
  }),
  Object.freeze({
    id: "batch-open-snapshot",
    title: "Run a small open plus snapshot flow in one batch call",
    workflow: "current-batch",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        args: Object.freeze(["batch"]),
        stdin: '[["open","https://example.com"],["snapshot","-i"]]',
      }),
    ]),
    modelOutputs: Object.freeze([
      "Batch results:\n1. Opened https://example.com\n2. Page: Example Domain\n@e1 [link] \"More information...\"",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 1100,
  }),
  Object.freeze({
    id: "job-open-assert-screenshot",
    title: "Run a constrained job that opens, asserts text, and captures evidence",
    workflow: "native-job",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        job: Object.freeze({
          steps: Object.freeze([
            Object.freeze({ action: "open", url: "https://example.com" }),
            Object.freeze({ action: "assertText", text: "Example Domain" }),
            Object.freeze({ action: "screenshot", path: ".dogfood/example.png" }),
          ]),
        }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "Batch results:\n1. Opened https://example.com\n2. Text appeared: Example Domain\n3. Saved image: .dogfood/example.png\nCompiled job: 3 steps",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 1,
    failureCategories: Object.freeze(["artifact-completion"]),
    elapsedMsEstimate: 1300,
  }),
]);

function usage() {
  return `agent-browser-efficiency-benchmark.mjs

Usage:
  node scripts/agent-browser-efficiency-benchmark.mjs [--json|--markdown] [--compare <path>]

Options:
  --json            Print machine-readable benchmark metrics.
  --markdown        Print a readable benchmark report (default).
  --compare <path>  Compare against a prior JSON benchmark report.
  -h, --help        Show this help.

Exit codes:
  0  Benchmark rendered or comparison completed.
  1  Benchmark comparison found a regression or input could not be read.
  2  Usage error.
`;
}

export function summarizeScenario(scenario) {
  const modelVisibleBytes = scenario.modelOutputs.reduce((total, output) => total + Buffer.byteLength(output, "utf8"), 0);
  return Object.freeze({
    id: scenario.id,
    title: scenario.title,
    workflow: scenario.workflow,
    success: Boolean(scenario.success),
    toolCalls: scenario.steps.length,
    modelVisibleBytes,
    staleRefFailures: scenario.staleRefFailures,
    staleRefRecoveries: scenario.staleRefRecoveries,
    artifactSuccesses: scenario.artifactSuccesses,
    failureCategories: Object.freeze([...scenario.failureCategories]),
    elapsedMsEstimate: scenario.elapsedMsEstimate,
  });
}

export function buildBenchmarkReport({ scenarios = BENCHMARK_SCENARIOS, label = "current-raw-baseline" } = {}) {
  const scenarioSummaries = scenarios.map(summarizeScenario);
  const totals = scenarioSummaries.reduce(
    (accumulator, scenario) => {
      accumulator.scenarios += 1;
      accumulator.successes += scenario.success ? 1 : 0;
      accumulator.toolCalls += scenario.toolCalls;
      accumulator.modelVisibleBytes += scenario.modelVisibleBytes;
      accumulator.staleRefFailures += scenario.staleRefFailures;
      accumulator.staleRefRecoveries += scenario.staleRefRecoveries;
      accumulator.artifactSuccesses += scenario.artifactSuccesses;
      for (const category of scenario.failureCategories) accumulator.failureCategoriesCovered.add(category);
      accumulator.elapsedMsEstimate += scenario.elapsedMsEstimate;
      return accumulator;
    },
    {
      scenarios: 0,
      successes: 0,
      toolCalls: 0,
      modelVisibleBytes: 0,
      staleRefFailures: 0,
      staleRefRecoveries: 0,
      artifactSuccesses: 0,
      failureCategoriesCovered: new Set(),
      elapsedMsEstimate: 0,
    },
  );
  totals.successRate = totals.scenarios === 0 ? 0 : totals.successes / totals.scenarios;
  totals.averageToolCalls = totals.scenarios === 0 ? 0 : totals.toolCalls / totals.scenarios;
  totals.averageModelVisibleBytes = totals.scenarios === 0 ? 0 : Math.round(totals.modelVisibleBytes / totals.scenarios);
  totals.failureCategoriesCovered = Object.freeze([...totals.failureCategoriesCovered].sort());
  totals.failureCategoryCoverage = totals.failureCategoriesCovered.length;

  return Object.freeze({
    version: CURRENT_BENCHMARK_VERSION,
    label,
    generatedAt: "deterministic",
    metrics: Object.freeze(totals),
    scenarios: Object.freeze(scenarioSummaries),
  });
}

function comparableReportMessages(current, candidate) {
  const messages = [];
  if (candidate.version !== current.version) {
    messages.push(`benchmark version changed from ${current.version} to ${candidate.version ?? "unknown"}`);
  }
  const currentScenarioIds = new Set(current.scenarios.map((scenario) => scenario.id));
  const candidateScenarioIds = new Set((candidate.scenarios ?? []).map((scenario) => scenario.id));
  const missingScenarioIds = [...currentScenarioIds].filter((id) => !candidateScenarioIds.has(id));
  const extraScenarioIds = [...candidateScenarioIds].filter((id) => !currentScenarioIds.has(id));
  if (missingScenarioIds.length > 0) {
    messages.push(`candidate omitted benchmark scenarios: ${missingScenarioIds.join(", ")}`);
  }
  if (extraScenarioIds.length > 0) {
    messages.push(`candidate added unknown benchmark scenarios: ${extraScenarioIds.join(", ")}`);
  }
  return messages;
}

function regressionMessages(current, candidate) {
  const messages = comparableReportMessages(current, candidate);
  if (candidate.metrics.successRate < current.metrics.successRate) {
    messages.push(`success rate regressed from ${current.metrics.successRate} to ${candidate.metrics.successRate}`);
  }
  if (candidate.metrics.toolCalls > current.metrics.toolCalls) {
    messages.push(`tool calls increased from ${current.metrics.toolCalls} to ${candidate.metrics.toolCalls}`);
  }
  if (candidate.metrics.modelVisibleBytes > current.metrics.modelVisibleBytes) {
    messages.push(`model-visible bytes increased from ${current.metrics.modelVisibleBytes} to ${candidate.metrics.modelVisibleBytes}`);
  }
  if (candidate.metrics.staleRefFailures > current.metrics.staleRefFailures) {
    messages.push(`stale-ref failures increased from ${current.metrics.staleRefFailures} to ${candidate.metrics.staleRefFailures}`);
  }
  if (candidate.metrics.artifactSuccesses < current.metrics.artifactSuccesses) {
    messages.push(`artifact successes decreased from ${current.metrics.artifactSuccesses} to ${candidate.metrics.artifactSuccesses}`);
  }
  if (candidate.metrics.elapsedMsEstimate > current.metrics.elapsedMsEstimate) {
    messages.push(`elapsed estimate increased from ${current.metrics.elapsedMsEstimate} to ${candidate.metrics.elapsedMsEstimate}`);
  }
  const currentCategories = new Set(current.metrics.failureCategoriesCovered ?? []);
  const candidateCategories = new Set(candidate.metrics.failureCategoriesCovered ?? []);
  const missingCategories = [...currentCategories].filter((category) => !candidateCategories.has(category));
  if (missingCategories.length > 0) {
    messages.push(`failure category coverage dropped missing: ${missingCategories.join(", ")}`);
  }
  return messages;
}

export function compareBenchmarkReports(current, candidate) {
  const regressions = regressionMessages(current, candidate);
  return Object.freeze({
    passed: regressions.length === 0,
    regressions: Object.freeze(regressions),
    delta: Object.freeze({
      successRate: candidate.metrics.successRate - current.metrics.successRate,
      toolCalls: candidate.metrics.toolCalls - current.metrics.toolCalls,
      modelVisibleBytes: candidate.metrics.modelVisibleBytes - current.metrics.modelVisibleBytes,
      staleRefFailures: candidate.metrics.staleRefFailures - current.metrics.staleRefFailures,
      staleRefRecoveries: candidate.metrics.staleRefRecoveries - current.metrics.staleRefRecoveries,
      artifactSuccesses: candidate.metrics.artifactSuccesses - current.metrics.artifactSuccesses,
      elapsedMsEstimate: candidate.metrics.elapsedMsEstimate - current.metrics.elapsedMsEstimate,
    }),
  });
}

function markdownReport(report, comparison) {
  const lines = [
    `# Agent browser efficiency benchmark`,
    "",
    `Label: ${report.label}`,
    "",
    "## Metrics",
    "",
    `- Task success: ${report.metrics.successes}/${report.metrics.scenarios}`,
    `- Tool calls: ${report.metrics.toolCalls}`,
    `- Average tool calls per scenario: ${report.metrics.averageToolCalls.toFixed(2)}`,
    `- Model-visible output size: ${report.metrics.modelVisibleBytes} bytes`,
    `- Average model-visible output size: ${report.metrics.averageModelVisibleBytes} bytes`,
    `- Stale-ref failures: ${report.metrics.staleRefFailures}`,
    `- Stale-ref recoveries: ${report.metrics.staleRefRecoveries}`,
    `- Artifact successes: ${report.metrics.artifactSuccesses}`,
    `- Failure category coverage: ${report.metrics.failureCategoryCoverage} (${report.metrics.failureCategoriesCovered.join(", ")})`,
    `- Estimated elapsed time: ${report.metrics.elapsedMsEstimate} ms`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Workflow | Calls | Bytes | Stale failures | Recoveries | Artifacts | Failure categories |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.scenarios.map(
      (scenario) =>
        `| ${scenario.id} | ${scenario.workflow} | ${scenario.toolCalls} | ${scenario.modelVisibleBytes} | ${scenario.staleRefFailures} | ${scenario.staleRefRecoveries} | ${scenario.artifactSuccesses} | ${scenario.failureCategories.join(", ")} |`,
    ),
  ];
  if (comparison) {
    lines.push("", "## Comparison", "", comparison.passed ? "No regressions detected." : "Regressions detected:");
    for (const regression of comparison.regressions) lines.push(`- ${regression}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readComparison(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const options = { format: "markdown", comparePath: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--markdown") {
      options.format = "markdown";
      continue;
    }
    if (arg === "--compare") {
      const value = argv[index + 1];
      if (!value) throw new Error("--compare requires a path.");
      options.comparePath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run with --help for usage.");
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const report = buildBenchmarkReport();
  let comparison = null;
  if (options.comparePath) {
    try {
      comparison = compareBenchmarkReports(report, await readComparison(options.comparePath));
    } catch (error) {
      console.error(`Failed to read comparison benchmark: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (options.format === "json") {
    console.log(JSON.stringify(comparison ? { ...report, comparison } : report, null, 2));
  } else {
    console.log(markdownReport(report, comparison));
  }
  return comparison?.passed === false ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
