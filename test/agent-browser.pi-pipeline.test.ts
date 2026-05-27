/**
 * Purpose: Prove Pi applies the agent_browser tool_result patch through the real AgentSession pipeline.
 * Responsibilities: Use a model-free SDK session with a deterministic fake provider and fake upstream agent-browser binary, then inspect persisted tool results.
 * Scope: Pi integration coverage for extension event semantics that direct tool.execute() tests intentionally bypass.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import agentBrowserExtension from "../extensions/agent-browser/index.js";
import {
	readInvocationLog,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const PIPELINE_PROVIDER = "piab-pipeline";
const PIPELINE_MODEL_ID = "tool-pipeline";

type PipelineToolResult = ToolResultMessage<unknown> & { toolName: "agent_browser" };

type PipelinePromptResult = {
	inMemoryResult: PipelineToolResult;
	invocations: Array<{ args: string[] }>;
	persistedResult: PipelineToolResult;
	sessionFile: string;
};

function isAgentBrowserToolResult(message: unknown): message is PipelineToolResult {
	return typeof message === "object" && message !== null &&
		(message as { role?: unknown }).role === "toolResult" &&
		(message as { toolName?: unknown }).toolName === "agent_browser";
}

function usage() {
	return {
		cacheRead: 0,
		cacheWrite: 0,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
		input: 0,
		output: 0,
		totalTokens: 0,
	};
}

function createAssistantMessage(model: Model<any>, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		api: model.api,
		content: [],
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason,
		timestamp: Date.now(),
		usage: usage(),
	};
}

function streamTextResponse(model: Model<any>, text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = createAssistantMessage(model, "stop");
		stream.push({ type: "start", partial: output });
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		const block = output.content[0];
		if (block?.type === "text") block.text = text;
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	});
	return stream;
}

function createToolCallingStream(toolArguments: Record<string, unknown>) {
	return (model: Model<any>, context: Context, _options?: SimpleStreamOptions) => {
		const hasToolResult = context.messages.some((message) => message.role === "toolResult" && message.toolName === "agent_browser");
		if (hasToolResult) return streamTextResponse(model, "Observed agent_browser result.");

		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const output = createAssistantMessage(model, "toolUse");
			const toolCall = {
				arguments: toolArguments,
				id: "call_agent_browser_pipeline",
				name: "agent_browser",
				type: "toolCall" as const,
			};
			stream.push({ type: "start", partial: output });
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolArguments), partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
			stream.push({ type: "done", reason: "toolUse", message: output });
			stream.end();
		});
		return stream;
	};
}

function isSessionMessageEntry(value: unknown): value is { message?: unknown; type?: string } {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "message";
}

async function listFilesRecursive(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await listFilesRecursive(path));
		else files.push(path);
	}
	return files;
}

async function readPersistedAgentBrowserResult(sessionDir: string): Promise<{ result: PipelineToolResult; sessionFile: string }> {
	const sessionFiles = (await listFilesRecursive(sessionDir)).filter((path) => path.endsWith(".jsonl"));
	assert.equal(sessionFiles.length, 1, `expected one persisted session file, got ${sessionFiles.join(", ")}`);
	const sessionFile = sessionFiles[0];
	const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").filter(Boolean);
	const results = lines
		.map((line) => JSON.parse(line) as unknown)
		.filter(isSessionMessageEntry)
		.map((entry) => entry.message)
		.filter(isAgentBrowserToolResult);
	const result = results.at(-1);
	assert.ok(result, "persisted session JSONL should include an agent_browser tool result");
	return { result, sessionFile };
}

function registerPipelineProvider(modelRegistry: ModelRegistry, toolArguments: Record<string, unknown>): Model<any> {
	modelRegistry.registerProvider(PIPELINE_PROVIDER, {
		api: "openai-completions",
		apiKey: "piab-pipeline-key",
		baseUrl: "https://pipeline.example.test/v1",
		models: [{
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: PIPELINE_MODEL_ID,
			input: ["text"],
			maxTokens: 4096,
			name: "Pi Agent Browser Pipeline Test",
			reasoning: false,
		}],
		streamSimple: createToolCallingStream(toolArguments),
	});
	const model = modelRegistry.find(PIPELINE_PROVIDER, PIPELINE_MODEL_ID);
	assert.ok(model, "pipeline test model should be registered");
	return model;
}

async function runPipelinePrompt(options: { fakeScript: string; toolArguments: Record<string, unknown> }): Promise<PipelinePromptResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-pipeline-"));
	const sessionDir = join(tempDir, "sessions");
	const invocationLogPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`try { require("node:fs").appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n"); } catch {}\n${options.fakeScript}`,
	);

	try {
		return await withPatchedEnv<PipelinePromptResult>({ PATH: `${tempDir}:${basePath}` }, async () => {
			const authStorage = AuthStorage.inMemory({ [PIPELINE_PROVIDER]: { key: "piab-pipeline-key", type: "api_key" } });
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			const model = registerPipelineProvider(modelRegistry, options.toolArguments);
			const resourceLoader = new DefaultResourceLoader({
				agentDir: tempDir,
				cwd: tempDir,
				extensionFactories: [agentBrowserExtension],
				noContextFiles: true,
				noExtensions: true,
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				authStorage,
				cwd: tempDir,
				model,
				modelRegistry,
				noTools: "builtin",
				resourceLoader,
				sessionManager: SessionManager.create(tempDir, sessionDir, { id: "piab-pipeline-session" }),
				tools: ["agent_browser"],
			});
			try {
				await session.prompt("Use agent_browser once.");
				const inMemoryResult = session.messages.find(isAgentBrowserToolResult);
				assert.ok(inMemoryResult, "agent_browser tool result should be recorded by Pi");
				const persisted = await readPersistedAgentBrowserResult(sessionDir);
				return {
					inMemoryResult,
					invocations: await readInvocationLog(invocationLogPath),
					persistedResult: persisted.result,
					sessionFile: persisted.sessionFile,
				};
			} finally {
				session.dispose();
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

test("Pi pipeline patches persisted QA reclassification failures to isError with model-visible prose", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { qa: { expectedSelector: "main", expectedText: ["Welcome"], url: "https://fail.example.test/" } },
		fakeScript: `const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
const steps = JSON.parse(stdin || "[]");
const results = steps.map((step) => {
  const name = step[0];
  if (name === "open") return { command: step, success: true, result: { title: "Failure page", url: step[1] } };
  if (name === "network" && step.includes("--clear")) return { command: step, success: true, result: { requests: [] } };
  if (name === "network") return { command: step, success: true, result: { requests: [{ method: "GET", resourceType: "fetch", status: 500, url: "https://fail.example.test/api" }] } };
  if (name === "console" && step.includes("--clear")) return { command: step, success: true, result: { messages: [] } };
  if (name === "console") return { command: step, success: true, result: { messages: [{ type: "error", text: "boom" }] } };
  if (name === "errors" && step.includes("--clear")) return { command: step, success: true, result: { errors: [] } };
  if (name === "errors") return { command: step, success: true, result: { errors: [{ text: "page boom" }] } };
  return { command: step, success: true, result: { ok: true } };
});
process.stdout.write(JSON.stringify(results));`,
	});

	for (const result of [pipeline.inMemoryResult, pipeline.persistedResult]) {
		assert.equal(result.isError, true);
		assert.equal((result.details as { failureCategory?: string; resultCategory?: string } | undefined)?.resultCategory, "failure");
		assert.equal((result.details as { failureCategory?: string } | undefined)?.failureCategory, "qa-failure");
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		assert.match(text, /Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./);
	}
	assert.match(pipeline.sessionFile, /\.jsonl$/);
});

test("Pi pipeline rejects unsupported public schema fields before spawning upstream", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["get", "url"], unsupportedRootField: true },
		fakeScript: `process.stdout.write(JSON.stringify({ success: true, data: "unexpected" }));`,
	});

	for (const result of [pipeline.inMemoryResult, pipeline.persistedResult]) {
		assert.equal(result.isError, true);
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		assert.match(text, /unsupportedRootField|additional/i);
	}
	assert.deepEqual(pipeline.invocations, []);
});

test("Pi pipeline preserves persisted parseable JSON content while patching isError", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["--json", "get", "url"] },
		fakeScript: `process.stdout.write(JSON.stringify({ success: false, error: "json boom", data: { code: "boom" } }));`,
	});

	for (const result of [pipeline.inMemoryResult, pipeline.persistedResult]) {
		assert.equal(result.isError, true);
		assert.equal((result.details as { resultCategory?: string } | undefined)?.resultCategory, "failure");
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		assert.doesNotMatch(text, /Pi tool isError/);
		assert.deepEqual(JSON.parse(text), { error: "json boom", success: false });
	}
});
