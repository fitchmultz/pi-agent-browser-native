#!/usr/bin/env node
/**
 * Purpose: Run a deterministic, model-free live-browser smoke through the native agent_browser extension surface.
 * Responsibilities: Exercise persistent code, QA, semantic actions, native batch, artifact verification, and close without relying on an LLM to choose tool calls.
 * Scope: Maintainer verification only; it uses a loopback HTTP fixture and the local extension harness, and it is not part of the published runtime package.
 * Usage: `npm run verify -- dogfood` or `npx tsx scripts/verify-agent-browser-dogfood.ts [--keep-artifacts] [--artifact-dir <path>] [--json]`.
 * Invariants/Assumptions: `agent-browser` is installed on PATH; the script serves a loopback fixture so platform checks do not depend on public network reachability.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
	createExtensionHarness,
	executeRegisteredTool,
	runExtensionEvent,
} from "../test/helpers/agent-browser-harness.js";

interface DogfoodOptions {
	readonly artifactDir?: string;
	readonly cwd?: string;
	readonly json?: boolean;
	readonly keepArtifacts?: boolean;
}

interface DogfoodStepReport {
	readonly artifactPath: string | undefined;
	readonly artifactSizeBytes: number | undefined;
	readonly failureCategory?: unknown;
	readonly id: string;
	readonly isError: boolean;
	readonly resultCategory?: unknown;
	readonly successCategory?: unknown;
	readonly textPreview: string;
	readonly verifiedArtifact: boolean | undefined;
}

class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

function usage(): string {
	return `verify-agent-browser-dogfood.ts

Usage:
  npx tsx scripts/verify-agent-browser-dogfood.ts [--keep-artifacts] [--artifact-dir <path>] [--json]

Options:
  --artifact-dir <path>  Directory for QA/batch screenshots. Defaults to a temp dir.
  --keep-artifacts      Preserve the artifact directory after the run.
  --json                Print the machine-readable report only.
  -h, --help            Show this help.
`;
}

export function parseDogfoodArgs(argv: readonly string[]): DogfoodOptions & { help: boolean } {
	const options: { help: boolean; artifactDir?: string; keepArtifacts?: boolean; json?: boolean } =
		{ help: false };
	const words = argv.values();
	for (const arg of words) {
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--keep-artifacts") {
			options.keepArtifacts = true;
			continue;
		}
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg === "--artifact-dir") {
			const value = words.next().value;
			if (value === undefined || value.length === 0 || value.startsWith("-")) {
				throw new UsageError("--artifact-dir requires a path.");
			}
			options.artifactDir = value;
			continue;
		}
		throw new UsageError(`Unknown dogfood argument: ${arg}`);
	}
	return options;
}

type ToolObservation = {
	readonly content: readonly { readonly text?: string; readonly type: string }[];
	readonly details?: Readonly<Record<string, unknown>>;
	readonly isError?: boolean;
};

function textPreview(result: ToolObservation): string {
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.slice(0, 500);
}

async function verifiedArtifactSize(path: string): Promise<number> {
	const stats = await stat(path);
	assert.equal(stats.isFile(), true, `${path} should be a file`);
	assert.ok(stats.size > 0, `${path} should not be empty`);
	return stats.size;
}

function getArtifactVerification(result: ToolObservation): { verified?: boolean } | undefined {
	const value = result.details?.artifactVerification;
	if (typeof value !== "object" || value === null || !("verified" in value)) {
		return;
	}
	return typeof value.verified === "boolean" ? { verified: value.verified } : undefined;
}

async function startDogfoodFixture(): Promise<{
	close: () => Promise<void>;
	helpUrl: string;
	origin: string;
}> {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (request.url === "/script-a") {
			response.end(
				'<!doctype html><html lang="en"><head><title>Script A</title></head><body><div role="dialog"><button id="dismiss" onclick="this.parentElement.remove()">Dismiss</button></div><ul><li data-value="a1">A1</li><li data-value="a2">A2</li></ul></body></html>',
			);
			return;
		}
		if (request.url === "/script-b") {
			response.end(
				'<!doctype html><html lang="en"><head><title>Script B</title></head><body><ul><li data-value="b1">B1</li><li data-value="b2">B2</li></ul></body></html>',
			);
			return;
		}
		if (request.url === "/example-domains.html") {
			response.end(
				'<!doctype html><html lang="en"><head><title>Example Domain Help</title></head><body><h1>Example Domain Help</h1><p>Learn more target reached.</p></body></html>',
			);
			return;
		}
		response.end(
			'<!doctype html><html lang="en"><head><title>Example Domain</title></head><body><main><h1>Example Domain</h1><p>This loopback fixture is reserved for deterministic platform smoke tests.</p><a href="/example-domains.html">Learn more</a></main></body></html>',
		);
	});
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Loopback dogfood server did not expose a TCP port.");
	}
	const origin = `http://127.0.0.1:${address.port}/`;
	return {
		close: async () =>
			await new Promise<void>((done, reject) => {
				server.close((error) => {
					if (error !== undefined) {
						reject(error);
					} else {
						done();
					}
				});
				server.closeAllConnections();
			}),
		helpUrl: `${origin}example-domains.html`,
		origin,
	};
}

type AgentBrowserToolExecutionResult = ToolObservation;
type BrowserHarness = Pick<ReturnType<typeof createExtensionHarness>, "ctx" | "getTool" | "tool">;

async function assertSuccessfulStep(options: {
	readonly artifactPath?: string;
	readonly id: string;
	readonly result: AgentBrowserToolExecutionResult;
	readonly textPattern?: RegExp;
}): Promise<DogfoodStepReport> {
	const { artifactPath, id, result, textPattern } = options;
	assert.equal(result.isError, false, `${id} should succeed: ${JSON.stringify(result.details)}`);
	assert.ok(result.details);
	assert.equal(
		result.details.resultCategory,
		"success",
		`${id} should report resultCategory=success`,
	);
	const preview = textPreview(result);
	if (textPattern) {
		assert.match(preview, textPattern, `${id} should show expected page/action evidence`);
	}
	let artifactSizeBytes: number | undefined;
	let verifiedArtifact: boolean | undefined;
	if (artifactPath !== undefined && artifactPath.length > 0) {
		artifactSizeBytes = await verifiedArtifactSize(artifactPath);
		verifiedArtifact = getArtifactVerification(result)?.verified;
		assert.equal(verifiedArtifact, true, `${id} should verify its screenshot artifact`);
	}
	return {
		artifactPath,
		artifactSizeBytes,
		failureCategory: result.details.failureCategory,
		id,
		isError: false,
		resultCategory: result.details.resultCategory,
		successCategory: result.details.successCategory,
		textPreview: preview,
		verifiedArtifact,
	};
}

function requireTool(
	harness: BrowserHarness,
	name: string,
): NonNullable<ReturnType<typeof harness.getTool>> {
	const tool = harness.getTool(name);
	if (tool === undefined) {
		throw new Error(`Required browser tool ${name} was not registered.`);
	}
	return tool;
}

async function runPersistentCode(
	harness: BrowserHarness,
	origin: string,
): Promise<DogfoodStepReport> {
	const scriptResult = await executeRegisteredTool(
		requireTool(harness, "agent_browser_code"),
		harness.ctx,
		{
			code: `const values = [];
for (const url of ${JSON.stringify([`${origin}script-a`, `${origin}script-b`])}) {
  const opened = await browser({ args: ["open", url] });
  if (!opened.success) throw new Error(opened.error);
  const probe = await browser({ args: ["eval", "--stdin"], stdin: "({ hasBanner: Boolean(document.querySelector('[role=dialog]')), values: [...document.querySelectorAll('[data-value]')].map(node => node.getAttribute('data-value')) })" });
  if (!probe.success) throw new Error(probe.error);
  if (probe.data.result.hasBanner) {
    const dismissed = await browser({ args: ["click", "#dismiss"] });
    if (!dismissed.success) throw new Error(dismissed.error);
  }
  values.push(...probe.data.result.values);
}
emit(values);`,
		},
	);
	assert.ok(scriptResult.details);
	assert.deepEqual(scriptResult.details.data, ["a1", "a2", "b1", "b2"]);
	const afterCode = await executeRegisteredTool(harness.tool, harness.ctx, {
		args: ["get", "url"],
	});
	assert.ok(afterCode.details);
	assert.equal(afterCode.details.sessionName, scriptResult.details.sessionName);
	assert.match(JSON.stringify(afterCode.details.data), /script-b/);
	return assertSuccessfulStep({
		id: "code-branch-and-aggregate",
		result: scriptResult,
		textPattern: /a1/,
	});
}

async function runCoreFlows(
	harness: BrowserHarness,
	origin: string,
	screenshotPath: string,
): Promise<DogfoodStepReport[]> {
	const steps = [
		{
			id: "open-fresh-example",
			textPattern: new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			tool: harness.tool,
			params: { args: ["open", origin], sessionMode: "fresh" },
		},
		{
			id: "semantic-click-learn-more",
			textPattern: /clicked/i,
			tool: requireTool(harness, "agent_browser_action"),
			params: { action: "click", selector: "a" },
		},
		{
			id: "semantic-click-url",
			textPattern: /example-domains\.html/,
			tool: harness.tool,
			params: { args: ["get", "url"] },
		},
		{
			id: "open-current-example",
			textPattern: /Example Domain/,
			tool: harness.tool,
			params: { args: ["open", origin] },
		},
		{
			id: "batch-open-assert-screenshot",
			textPattern: /Step 2[\s\S]*Example Domain/,
			artifactPath: screenshotPath,
			tool: harness.tool,
			params: {
				args: ["batch", "--bail"],
				stdin: JSON.stringify([
					["open", origin],
					["wait", "--text", "Example Domain"],
					["screenshot", screenshotPath],
				]),
			},
		},
	];
	const reports = [];
	for (const step of steps) {
		// Each action consumes the browser state established by the prior observed step.
		const result = await executeRegisteredTool(step.tool, harness.ctx, step.params);
		// Verify each receipt and artifact before moving to the next browser operation.
		reports.push(await assertSuccessfulStep({ ...step, result }));
	}
	return reports;
}

export async function runAgentBrowserDogfood(
	options: DogfoodOptions = {},
): Promise<DogfoodStepReport[]> {
	const cwd = options.cwd ?? process.cwd();
	const artifactDir = resolve(
		options.artifactDir ?? (await mkdtemp(join(tmpdir(), "pi-agent-browser-dogfood-"))),
	);
	const shouldRemoveArtifacts =
		options.keepArtifacts !== true &&
		(options.artifactDir === undefined || options.artifactDir.length === 0);
	await mkdir(artifactDir, { recursive: true });
	const batchScreenshotPath = join(artifactDir, "batch.png");
	const harness = createExtensionHarness({
		cwd,
		sessionFile: join(artifactDir, "dogfood-session.jsonl"),
		sessionId: randomUUID(),
	});
	const fixture = await startDogfoodFixture();
	const reports: DogfoodStepReport[] = [];
	let closed = false;

	try {
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

		reports.push(
			await assertSuccessfulStep({
				id: "qa-url",
				textPattern: /Example Domain/,
				result: await executeRegisteredTool(requireTool(harness, "agent_browser_qa"), harness.ctx, {
					sessionMode: "fresh",
					checkConsole: false,
					checkErrors: false,
					checkNetwork: false,
					expectedText: "Example Domain",
					url: fixture.origin,
				}),
			}),
		);

		reports.push(await runPersistentCode(harness, fixture.origin));
		reports.push(...(await runCoreFlows(harness, fixture.origin, batchScreenshotPath)));

		const closeResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
		closed = closeResult.isError !== true;
		reports.push(
			await assertSuccessfulStep({
				id: "close-session",
				result: closeResult,
				textPattern: /closed/,
			}),
		);
		return reports;
	} finally {
		if (!closed) {
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] }).catch(() => {
				// Preserve the smoke failure while completing the remaining owned-resource cleanup.
			});
		}
		await runExtensionEvent(
			harness.handlers,
			"session_shutdown",
			{ reason: "quit" },
			harness.ctx,
		).catch(() => {
			// Preserve the smoke failure while completing the remaining owned-resource cleanup.
		});
		await fixture.close();
		if (shouldRemoveArtifacts) {
			await rm(artifactDir, { force: true, recursive: true });
		}
	}
}

function categoryText(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}

function printReport(reports: readonly DogfoodStepReport[], artifactDir: string | undefined): void {
	console.log("agent_browser dogfood smoke passed");
	if (artifactDir !== undefined && artifactDir.length > 0) {
		console.log(`Artifacts: ${resolve(artifactDir)}`);
	}
	for (const report of reports) {
		const artifact =
			report.artifactPath !== undefined && report.artifactPath.length > 0
				? ` artifact=${report.verifiedArtifact === true ? "verified" : "missing"} size=${report.artifactSizeBytes ?? 0}`
				: "";
		console.log(
			`- ${report.id}: ${categoryText(report.resultCategory)}/${categoryText(report.successCategory ?? "completed")}${artifact}`,
		);
	}
}

function retainedArtifactDirectory(
	options: DogfoodOptions,
	reports: readonly DogfoodStepReport[],
): string | undefined {
	if (options.artifactDir !== undefined && options.artifactDir.length > 0) {
		return resolve(options.artifactDir);
	}
	const artifactPath =
		options.keepArtifacts === true
			? reports.find((report) => report.artifactPath !== undefined)?.artifactPath
			: undefined;
	return artifactPath === undefined ? undefined : dirname(artifactPath);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	try {
		const options = parseDogfoodArgs(argv);
		if (options.help) {
			console.log(usage());
			return 0;
		}
		const reports = await runAgentBrowserDogfood(options);
		if (options.json === true) {
			console.log(JSON.stringify({ reports }, null, 2));
		} else {
			printReport(reports, retainedArtifactDirectory(options, reports));
		}
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			console.error(usage());
			return 2;
		}
		console.error(error instanceof Error ? (error.stack ?? error.message) : error);
		return 1;
	}
}

const entrypoint = process.argv.at(1);
if (
	entrypoint !== undefined &&
	entrypoint.length > 0 &&
	import.meta.url === pathToFileURL(entrypoint).href
) {
	process.exitCode = await main();
}
