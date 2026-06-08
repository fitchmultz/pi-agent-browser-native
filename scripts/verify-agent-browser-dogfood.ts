#!/usr/bin/env node
/**
 * Purpose: Run a deterministic, model-free live-browser smoke through the native agent_browser extension surface.
 * Responsibilities: Exercise top-level qa, semanticAction, job, artifact verification, and close without relying on an LLM to choose tool calls.
 * Scope: Maintainer verification only; it uses a local file fixture and the local extension harness, and it is not part of the published runtime package.
 * Usage: `npm run verify -- dogfood` or `npx tsx scripts/verify-agent-browser-dogfood.ts [--keep-artifacts] [--artifact-dir <path>] [--json]`.
 * Invariants/Assumptions: `agent-browser` is installed on PATH; the script serves a local file fixture so platform checks do not depend on public network reachability.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
	artifactDir?: string;
	cwd?: string;
	json?: boolean;
	keepArtifacts?: boolean;
}

interface DogfoodStepReport {
	artifactPath?: string;
	artifactSizeBytes?: number;
	failureCategory?: unknown;
	id: string;
	isError: boolean;
	resultCategory?: unknown;
	successCategory?: unknown;
	textPreview: string;
	verifiedArtifact?: boolean;
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
  --artifact-dir <path>  Directory for qa/job screenshots. Defaults to a temp dir.
  --keep-artifacts      Preserve the artifact directory after the run.
  --json                Print the machine-readable report only.
  -h, --help            Show this help.
`;
}

export function parseDogfoodArgs(argv: string[]): DogfoodOptions & { help: boolean } {
	const options: DogfoodOptions & { help: boolean } = { help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
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
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) throw new UsageError("--artifact-dir requires a path.");
			options.artifactDir = value;
			index += 1;
			continue;
		}
		throw new UsageError(`Unknown dogfood argument: ${arg}`);
	}
	return options;
}

function textPreview(result: Awaited<ReturnType<typeof executeRegisteredTool>>): string {
	return (result.content ?? [])
		.filter((part): part is { text: string; type: "text" } => part.type === "text" && typeof part.text === "string")
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

function getArtifactVerification(result: Awaited<ReturnType<typeof executeRegisteredTool>>): { verified?: boolean } | undefined {
	const value = result.details?.artifactVerification;
	return typeof value === "object" && value !== null ? value as { verified?: boolean } : undefined;
}

async function writeDogfoodFixture(rootDir: string): Promise<{ helpUrl: string; origin: string }> {
	const fixtureDir = join(rootDir, "fixture");
	await mkdir(fixtureDir, { recursive: true });
	const helpPath = join(fixtureDir, "example-domains.html");
	const indexPath = join(fixtureDir, "index.html");
	await writeFile(helpPath, `<!doctype html>
<html lang="en">
<head><title>Example Domain Help</title></head>
<body><h1>Example Domain Help</h1><p>Learn more target reached.</p></body>
</html>`);
	const helpUrl = pathToFileURL(helpPath).href;
	await writeFile(indexPath, `<!doctype html>
<html lang="en">
<head><title>Example Domain</title></head>
<body>
<main>
<h1>Example Domain</h1>
<p>This local fixture is reserved for deterministic platform smoke tests.</p>
<a href="${helpUrl}">Learn more</a>
</main>
</body>
</html>`);
	return { helpUrl, origin: pathToFileURL(indexPath).href };
}

type AgentBrowserToolExecutionResult = Awaited<ReturnType<typeof executeRegisteredTool>>;

async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTransientWindowsBrowserLaunchFailure(result: AgentBrowserToolExecutionResult): boolean {
	if (process.platform !== "win32") return false;
	const summary = typeof result.details?.summary === "string" ? result.details.summary : "";
	return result.isError === true
		&& result.details?.failureCategory === "upstream-error"
		&& /connection attempt failed|os error 10060/i.test(summary);
}

async function assertSuccessfulStep(options: {
	artifactPath?: string;
	id: string;
	result: AgentBrowserToolExecutionResult;
	textPattern?: RegExp;
}): Promise<DogfoodStepReport> {
	const { artifactPath, id, result, textPattern } = options;
	assert.equal(result.isError, false, `${id} should succeed: ${JSON.stringify(result.details)}`);
	assert.equal(result.details?.resultCategory, "success", `${id} should report resultCategory=success`);
	const preview = textPreview(result);
	if (textPattern) assert.match(preview, textPattern, `${id} should show expected page/action evidence`);
	let artifactSizeBytes: number | undefined;
	let verifiedArtifact: boolean | undefined;
	if (artifactPath) {
		artifactSizeBytes = await verifiedArtifactSize(artifactPath);
		verifiedArtifact = getArtifactVerification(result)?.verified;
		assert.equal(verifiedArtifact, true, `${id} should verify its screenshot artifact`);
	}
	return {
		artifactPath,
		artifactSizeBytes,
		failureCategory: result.details?.failureCategory,
		id,
		isError: false,
		resultCategory: result.details?.resultCategory,
		successCategory: result.details?.successCategory,
		textPreview: preview,
		verifiedArtifact,
	};
}

async function runSuccessfulStepWithRetry(options: {
	artifactPath?: string;
	execute: () => Promise<AgentBrowserToolExecutionResult>;
	id: string;
	shouldRetry: (result: AgentBrowserToolExecutionResult) => boolean;
	textPattern?: RegExp;
}): Promise<DogfoodStepReport> {
	let result = await options.execute();
	if (options.shouldRetry(result)) {
		await delay(1_000);
		result = await options.execute();
	}
	return await assertSuccessfulStep({
		artifactPath: options.artifactPath,
		id: options.id,
		result,
		textPattern: options.textPattern,
	});
}

export async function runAgentBrowserDogfood(options: DogfoodOptions = {}): Promise<DogfoodStepReport[]> {
	const cwd = options.cwd ?? process.cwd();
	const artifactDir = resolve(options.artifactDir ?? await mkdtemp(join(tmpdir(), "pi-agent-browser-dogfood-")));
	const shouldRemoveArtifacts = !options.keepArtifacts && !options.artifactDir;
	await mkdir(artifactDir, { recursive: true });
	const jobScreenshotPath = join(artifactDir, "job.png");
	const harness = createExtensionHarness({ cwd, sessionId: randomUUID() });
	const fixture = await writeDogfoodFixture(artifactDir);
	const reports: DogfoodStepReport[] = [];
	let closed = false;

	try {
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

		reports.push(await assertSuccessfulStep({
			id: "qa-url",
			textPattern: /Example Domain/,
			result: await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					checkConsole: false,
					checkErrors: false,
					checkNetwork: false,
					expectedText: "Example Domain",
					loadState: "domcontentloaded",
					url: fixture.origin,
				},
			}),
		}));

		reports.push(await assertSuccessfulStep({
			id: "close-after-qa",
			result: await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] }),
			textPattern: /closed/,
		}));

		reports.push(await runSuccessfulStepWithRetry({
			id: "open-fresh-example",
			textPattern: new RegExp(fixture.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			execute: async () => await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", fixture.origin],
				sessionMode: "fresh",
			}),
			shouldRetry: isTransientWindowsBrowserLaunchFailure,
		}));

		reports.push(await assertSuccessfulStep({
			id: "semantic-click-learn-more",
			textPattern: /example-domains\.html/,
			result: await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Learn more" },
			}),
		}));

		reports.push(await assertSuccessfulStep({
			id: "open-current-example",
			textPattern: /Example Domain/,
			result: await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", fixture.origin],
			}),
		}));


		reports.push(await assertSuccessfulStep({
			artifactPath: jobScreenshotPath,
			id: "job-open-assert-screenshot",
			textPattern: /Step 2[\s\S]*Example Domain/,
			result: await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: fixture.origin },
						{ action: "assertText", text: "Example Domain" },
						{ action: "screenshot", path: jobScreenshotPath },
					],
				},
			}),
		}));

		const closeResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
		closed = closeResult.isError !== true;
		reports.push(await assertSuccessfulStep({ id: "close-session", result: closeResult, textPattern: /closed/ }));
		return reports;
	} finally {
		if (!closed) {
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] }).catch(() => undefined);
		}
		await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx).catch(() => undefined);
		if (shouldRemoveArtifacts) {
			await rm(artifactDir, { force: true, recursive: true });
		}
	}
}

function printReport(reports: DogfoodStepReport[], artifactDir: string | undefined) {
	console.log("agent_browser dogfood smoke passed");
	if (artifactDir) console.log(`Artifacts: ${resolve(artifactDir)}`);
	for (const report of reports) {
		const artifact = report.artifactPath ? ` artifact=${report.verifiedArtifact ? "verified" : "missing"} size=${report.artifactSizeBytes ?? 0}` : "";
		console.log(`- ${report.id}: ${report.resultCategory}/${report.successCategory ?? "completed"}${artifact}`);
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	try {
		const options = parseDogfoodArgs(argv);
		if (options.help) {
			console.log(usage());
			return 0;
		}
		const reports = await runAgentBrowserDogfood(options);
		if (options.json) console.log(JSON.stringify({ reports }, null, 2));
		else {
			const retainedArtifactDir = options.artifactDir
				? resolve(options.artifactDir)
				: options.keepArtifacts
					? reports.find((report) => report.artifactPath)?.artifactPath
					: undefined;
			printReport(reports, retainedArtifactDir && !options.artifactDir ? dirname(retainedArtifactDir) : retainedArtifactDir);
		}
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			console.error(usage());
			return 2;
		}
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main();
}
