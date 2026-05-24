#!/usr/bin/env node
/**
 * Purpose: Provide a deterministic benchmark for agent-facing browser workflow efficiency.
 * Responsibilities: Model representative agent_browser workflows, compute comparable efficiency metrics, and optionally compare a future candidate run against this baseline.
 * Scope: Local benchmark accounting only; it does not launch a browser or mutate profiles/sessions.
 * Usage: Run `node scripts/agent-browser-efficiency-benchmark.mjs`, `--json`, `--compare <path>`, or `--sample-jsonl <path>`.
 * Invariants/Assumptions: Scenarios represent high-value workflow shapes agents perform today; future browser UX tasks should update or compare against this benchmark when claiming call-count, output-size, stale-ref, artifact, or success-rate improvements.
 */

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const CURRENT_BENCHMARK_VERSION = 2;

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
      "Page: Example Domain\nURL: https://example.com/\n@e1 [link] \"Learn more\"",
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
      "Batch results:\n1. Opened https://example.com\n2. Page: Example Domain\n@e1 [link] \"Learn more\"",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 1100,
  }),
  Object.freeze({
    id: "batch-multi-extract",
    title: "Extract several known refs in one batch call",
    workflow: "current-batch",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        args: Object.freeze(["batch"]),
        stdin: '[["get","text","@e10"],["get","text","@e11"],["get","text","@e12"]]',
      }),
    ]),
    modelOutputs: Object.freeze([
      "Batch results:\n1. CPU Usage\n2. Memory Usage\n3. Disk I/O",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 800,
  }),
  Object.freeze({
    id: "qa-open-diagnostics",
    title: "Run a lightweight QA preset with text and diagnostic checks",
    workflow: "native-qa",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        qa: Object.freeze({
          url: "https://example.com",
          expectedText: "Example Domain",
          screenshotPath: ".dogfood/qa-example.png",
        }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "QA preset passed. Batch results: clear diagnostics, open, wait --load, wait --text, network requests, console, errors, screenshot.",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 1,
    failureCategories: Object.freeze(["artifact-completion"]),
    elapsedMsEstimate: 1400,
  }),
  Object.freeze({
    id: "network-source-lookup-failed-request",
    title: "Look up candidate source hints for a failed network request",
    workflow: "native-network-source-lookup-experiment",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        networkSourceLookup: Object.freeze({ requestId: "req-1", url: "/api/fail" }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "Network source lookup found 1 failed request(s) and 2 candidate source hint(s). Evidence: initiator stack and workspace URL literal. Limitations: experimental, not blame.",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 1500,
  }),
  Object.freeze({
    id: "source-lookup-visible-element",
    title: "Look up candidate source locations for a visible local UI element",
    workflow: "native-source-lookup-experiment",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        sourceLookup: Object.freeze({
          selector: "#save",
          reactFiberId: "2",
          componentName: "SaveButton",
        }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "Source lookup found 2 candidate location(s). Status: candidates-found. Evidence: react inspect source and workspace component search. Limitations: experimental, not guaranteed.",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 1500,
  }),
  Object.freeze({
    id: "electron-lifecycle",
    title: "Discover, launch, inspect, and cleanup a wrapper-owned Electron app",
    workflow: "native-electron-lifecycle",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        electron: Object.freeze({ action: "list", query: "code" }),
      }),
      Object.freeze({
        call: "agent_browser",
        electron: Object.freeze({ action: "launch", appName: "Visual Studio Code", handoff: "snapshot" }),
      }),
      Object.freeze({
        call: "agent_browser",
        electron: Object.freeze({ action: "cleanup", launchId: "electron-demo" }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "Electron apps (1 found):\n- Visual Studio Code — com.microsoft.VSCode — /Applications/Visual Studio Code.app",
      "Electron launch: Visual Studio Code attached as pi-demo (launchId electron-demo, port 49152).\n- page Visual Studio Code — vscode-file://index\nSnapshot handoff: 14 interactive ref(s).",
      "Electron cleanup: 1/1 launch(es) fully cleaned.\n- Cleaned Electron launch electron-demo.",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 2600,
  }),
  Object.freeze({
    id: "electron-probe",
    title: "Probe current Electron state in one compact call instead of separate title/url/focus/tab/snapshot reads",
    workflow: "native-electron-probe",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        electron: Object.freeze({ action: "probe" }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "Electron probe: Visual Studio Code — vscode-file://workspace\nFocused: textbox \"Search\" (#search, valueLength=0)\nTabs: 3 total; active 0: Explorer\nSnapshot: 12 interactive ref(s).",
    ]),
    success: true,
    staleRefFailures: 0,
    staleRefRecoveries: 0,
    artifactSuccesses: 0,
    failureCategories: Object.freeze([]),
    elapsedMsEstimate: 900,
  }),
  Object.freeze({
    id: "job-open-assert-screenshot",
    title: "Run a constrained job that opens, selects a native dropdown value, asserts text, and captures evidence",
    workflow: "native-job",
    steps: Object.freeze([
      Object.freeze({
        call: "agent_browser",
        job: Object.freeze({
          steps: Object.freeze([
            Object.freeze({ action: "open", url: "https://forms.example.test/preferences" }),
            Object.freeze({ action: "select", selector: "#flavor", value: "chocolate" }),
            Object.freeze({ action: "assertText", text: "Preferences saved" }),
            Object.freeze({ action: "screenshot", path: ".dogfood/example.png" }),
          ]),
        }),
      }),
    ]),
    modelOutputs: Object.freeze([
      "Batch results:\n1. Opened https://forms.example.test/preferences\n2. Selected #flavor = chocolate\n3. Text appeared: Preferences saved\n4. Saved image: .dogfood/example.png\nCompiled job: 4 steps",
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
  node scripts/agent-browser-efficiency-benchmark.mjs [--json|--markdown] [--compare <path>] [--sample-jsonl <path>]

Options:
  --json                Print machine-readable benchmark metrics.
  --markdown            Print a readable benchmark report (default).
  --compare <path>      Compare against a prior JSON benchmark report.
  --sample-jsonl <path> Opt-in: measure UTF-8 bytes of model-visible agent_browser tool-result text from a Pi session JSONL transcript. Does not change deterministic scenario metrics.
  -h, --help            Show this help.

Exit codes:
  0  Benchmark rendered or comparison completed.
  1  Benchmark comparison found a regression, JSONL sample input could not be read, or the sample file is missing.
  2  Usage error.

Notes:
  --compare ignores optional jsonlSample blocks; only deterministic scenario metrics drive regressions.
`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

export function parseJsonl(text) {
  const entries = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL at line ${index + 1}: ${message}`);
    }
  }
  return entries;
}

export function agentBrowserToolResults(entries) {
  return entries
    .filter((entry) => entry?.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "agent_browser")
    .map((entry) => entry.message);
}

// Keep in sync with extensions/agent-browser/lib/runtime.ts (findCommandStartIndex).
const INFER_COMMAND_VALUE_FLAGS = new Set([
  "--session",
  "--cdp",
  "--config",
  "--profile",
  "--session-name",
  "--proxy",
  "--proxy-bypass",
  "--headers",
  "--executable-path",
  "--extension",
  "--init-script",
  "--enable",
  "--provider",
  "-p",
  "--engine",
  "--state",
  "--download-path",
  "--screenshot-dir",
  "--screenshot-format",
  "--screenshot-quality",
  "--color-scheme",
  "--device",
  "--port",
  "--args",
  "--user-agent",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
  "--max-output",
  "--model",
  "--baseline",
  "--body",
  "--categories",
  "--curl",
  "--depth",
  "-d",
  "--domain",
  "--expires",
  "--filter",
  "--fn",
  "--label",
  "--load",
  "--name",
  "--path",
  "--resource-type",
  "--sameSite",
  "--selector",
  "-s",
  "--text",
  "--timeout",
  "--url",
  "--username",
  "--password",
]);

const INFER_COMMAND_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES = new Set([
  "--allow-file-access",
  "--annotate",
  "--auto-connect",
  "--confirm-interactive",
  "--content-boundaries",
  "--debug",
  "--headed",
  "--ignore-https-errors",
  "--json",
  "--no-auto-dialog",
  "--quiet",
  "-q",
  "--verbose",
  "-v",
]);

function isInferCommandBooleanLiteral(token) {
  const normalized = typeof token === "string" ? token.trim().toLowerCase() : undefined;
  return normalized === "true" || normalized === "false";
}

function inferCommandFromEffectiveArgs(effectiveArgs) {
  if (!Array.isArray(effectiveArgs)) return undefined;
  for (let index = 0; index < effectiveArgs.length; index += 1) {
    const token = effectiveArgs[index];
    if (typeof token !== "string") return token;
    if (token.startsWith("--session=")) continue;
    if (token.startsWith("-")) {
      const normalizedToken = token.split("=", 1)[0] ?? token;
      if (INFER_COMMAND_VALUE_FLAGS.has(normalizedToken) && !token.includes("=")) {
        index += 1;
      } else if (
        INFER_COMMAND_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken) &&
        !token.includes("=") &&
        isInferCommandBooleanLiteral(effectiveArgs[index + 1])
      ) {
        index += 1;
      }
      continue;
    }
    return token;
  }
  return undefined;
}

export function inferJsonlWorkflowId(message) {
  const details = isRecord(message?.details) ? message.details : undefined;
  if (!details) return "unspecified";
  if (details.compiledQaPreset) return "native-qa";
  if (details.compiledNetworkSourceLookup) return "native-network-source-lookup-experiment";
  if (details.compiledSourceLookup) return "native-source-lookup-experiment";
  if (details.compiledElectron) return "native-electron";
  if (details.compiledJob) return "native-job";
  if (details.compiledSemanticAction) return "native-semantic-action";
  const command = typeof details.command === "string" ? details.command : inferCommandFromEffectiveArgs(details.effectiveArgs);
  if (command === "batch") return "current-batch";
  if (command) return "current-raw";
  return "unspecified";
}

export function measureToolResultModelVisibleBytes(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      total += Buffer.byteLength(part.text, "utf8");
    }
  }
  return total;
}

export function percentile95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function buildJsonlSampleReport({ path, results }) {
  const perResult = results.map((message) => ({
    workflowId: inferJsonlWorkflowId(message),
    modelVisibleBytes: measureToolResultModelVisibleBytes(message),
    isError: message?.isError === true,
  }));
  const bytesByWorkflow = new Map();
  for (const row of perResult) {
    const bucket = bytesByWorkflow.get(row.workflowId) ?? [];
    bucket.push(row.modelVisibleBytes);
    bytesByWorkflow.set(row.workflowId, bucket);
  }
  const allBytes = perResult.map((row) => row.modelVisibleBytes);
  const byWorkflow = [...bytesByWorkflow.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([workflowId, byteValues]) =>
      Object.freeze({
        workflowId,
        toolResultCount: byteValues.length,
        totalModelVisibleBytes: byteValues.reduce((sum, value) => sum + value, 0),
        p95ModelVisibleBytes: percentile95(byteValues),
      }),
    );

  return Object.freeze({
    path,
    toolResultCount: perResult.length,
    totalModelVisibleBytes: allBytes.reduce((sum, value) => sum + value, 0),
    p95ModelVisibleBytes: percentile95(allBytes),
    byWorkflow: Object.freeze(byWorkflow),
    errorResultCount: perResult.filter((row) => row.isError).length,
  });
}

export async function sampleAgentBrowserJsonl(path) {
  await access(path, fsConstants.R_OK);
  const entries = parseJsonl(await readFile(path, "utf8"));
  const results = agentBrowserToolResults(entries);
  return buildJsonlSampleReport({ path, results });
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

export function buildBenchmarkReport({ scenarios = BENCHMARK_SCENARIOS, label = "current-raw-baseline", jsonlSample = null } = {}) {
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
    ...(jsonlSample ? { jsonlSample: Object.freeze(jsonlSample) } : {}),
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
  if (report.jsonlSample) {
    const sample = report.jsonlSample;
    lines.push(
      "",
      "## JSONL sample (opt-in)",
      "",
      `Path: ${sample.path}`,
      `- agent_browser tool results: ${sample.toolResultCount}`,
      `- Total model-visible bytes: ${sample.totalModelVisibleBytes}`,
      `- Overall p95 model-visible bytes: ${sample.p95ModelVisibleBytes}`,
      `- Error-marked tool results: ${sample.errorResultCount}`,
      "",
      "| Workflow | Results | Total bytes | p95 bytes |",
      "| --- | ---: | ---: | ---: |",
      ...sample.byWorkflow.map(
        (row) => `| ${row.workflowId} | ${row.toolResultCount} | ${row.totalModelVisibleBytes} | ${row.p95ModelVisibleBytes} |`,
      ),
    );
  }
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
  const options = { format: "markdown", comparePath: null, sampleJsonlPath: null, help: false };
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
    if (arg === "--sample-jsonl") {
      const value = argv[index + 1];
      if (!value) throw new Error("--sample-jsonl requires a path.");
      options.sampleJsonlPath = value;
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

  let jsonlSample = null;
  if (options.sampleJsonlPath) {
    try {
      jsonlSample = await sampleAgentBrowserJsonl(options.sampleJsonlPath);
    } catch (error) {
      console.error(`Failed to sample JSONL transcript: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const report = buildBenchmarkReport({ jsonlSample });
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
