/**
 * Purpose: Verify browser failure finalization and returned results through the real Pi AgentSession pipeline.
 * Responsibilities: Use a model-free SDK session with a deterministic fake provider and fake upstream agent-browser binary, then inspect persisted tool results.
 * Scope: Pi integration coverage for extension event semantics that direct tool.execute() tests intentionally bypass.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readRecord, readString, readArray, readBoolean } from "./helpers/assertions.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";

import {
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Api,
	type ToolCall,
} from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import * as Pi from "@earendil-works/pi-coding-agent";

import agentBrowserExtension from "../extensions/agent-browser/index.js";
import { finalizeAgentBrowserFailure } from "../extensions/agent-browser/lib/pi-tool-rendering.js";
import {
	PROJECT_RULE_PROMPT,
	RUNTIME_PROMPT_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	ADVANCED_TOOL_PROMPT_GUIDELINES,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	readInvocationLog,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("failure finalization adds the Pi failure notice to prose despite --json args", () => {
	const proseJsonArgsFinalized = finalizeAgentBrowserFailure(
		{
			content: [
				{
					type: "text",
					text: "Wrapper validation failed before upstream JSON output was available.",
				},
			],
			details: {
				args: ["--json", "get", "url"],
				failureCategory: "validation-error",
				resultCategory: "failure",
			},
			isError: false,
		},
		{ args: ["--json", "get", "url"] },
	);
	assert.equal(proseJsonArgsFinalized.isError, true);
	assert.match(
		readString(readRecord(proseJsonArgsFinalized.content[0]).text),
		/Result category: failure; failureCategory: validation-error; Pi tool isError: true\./,
	);
});

const PIPELINE_PROVIDER = "piab-pipeline";
const PIPELINE_MODEL_ID = "tool-pipeline";
const nativeInstructionGroups: unknown = readRecord(Pi).instructionGroupsExtension;
const NATIVE_DISCOVERY_ENABLED =
	process.env.PI_AGENT_BROWSER_NATIVE_DISCOVERY === "1" ||
	("instructionGroupsExtension" in Pi && typeof nativeInstructionGroups === "function");

type PipelineToolResult = {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details: unknown;
	readonly isError: boolean;
	readonly toolName: string;
};

type PipelinePromptResult = {
	inMemoryResult: PipelineToolResult;
	invocations: Array<{ args: string[] }>;
	persistedResult: PipelineToolResult;
	sessionFile: string;
};

function isAgentBrowserToolResult(message: unknown): boolean {
	if (
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		!("toolName" in message)
	) {
		return false;
	}
	return (
		message.role === "toolResult" &&
		typeof message.toolName === "string" &&
		message.toolName.startsWith("agent_browser")
	);
}

function readPipelineToolResult(value: unknown): PipelineToolResult {
	const result = readRecord(value);
	assert.ok(isAgentBrowserToolResult(result));
	return {
		content: readArray(result.content).map((item) => {
			const content = readRecord(item);
			return {
				type: readString(content.type),
				text: content.text === undefined ? undefined : readString(content.text),
			};
		}),
		details: result.details,
		isError: readBoolean(result.isError),
		toolName: readString(result.toolName),
	};
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

function createAssistantMessage(
	model: Model<Api>,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
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

function streamTextResponse(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = createAssistantMessage(model, "stop");
		stream.push({ type: "start", partial: output });
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		const block = output.content.at(0);
		if (block?.type === "text") {
			block.text = text;
		}
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	});
	return stream;
}

function createToolCallingStream(
	toolArguments: Readonly<ToolCall["arguments"]>,
	priorCalls: readonly ToolCall[] = [],
	toolName = "agent_browser",
	toolCallId = "call_agent_browser_pipeline",
) {
	return (model: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
		const hasToolResult = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === toolName,
		);
		if (hasToolResult) {
			return streamTextResponse(model, "Observed agent_browser result.");
		}

		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const output = createAssistantMessage(model, "toolUse");
			const toolCall = {
				arguments: toolArguments,
				id: toolCallId,
				name: toolName,
				type: "toolCall" as const,
			};
			stream.push({ type: "start", partial: output });
			for (const call of [...priorCalls, toolCall]) {
				const contentIndex = output.content.length;
				output.content.push(call);
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex,
					delta: JSON.stringify(call.arguments),
					partial: output,
				});
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
			}
			stream.push({ type: "done", reason: "toolUse", message: output });
			stream.end();
		});
		return stream;
	};
}

function isSessionMessageEntry(value: unknown): boolean {
	return typeof value === "object" && value !== null && "type" in value && value.type === "message";
}

async function listFilesRecursive(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			// Complete each directory traversal before selecting the persisted transcript.
			// oxlint-disable-next-line no-await-in-loop
			files.push(...(await listFilesRecursive(path)));
		} else {
			files.push(path);
		}
	}
	return files;
}

async function readPersistedAgentBrowserResult(
	sessionDir: string,
): Promise<{ result: PipelineToolResult; sessionFile: string }> {
	const sessionFiles = (await listFilesRecursive(sessionDir)).filter((path) =>
		path.endsWith(".jsonl"),
	);
	assert.equal(
		sessionFiles.length,
		1,
		`expected one persisted session file, got ${sessionFiles.join(", ")}`,
	);
	const sessionFile = sessionFiles[0];
	const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").filter(Boolean);
	const results = lines
		.map((line) => {
			const value: unknown = JSON.parse(line);
			return value;
		})
		.filter(isSessionMessageEntry)
		.map((entry) => readRecord(entry).message)
		.filter(isAgentBrowserToolResult)
		.map(readPipelineToolResult);
	const result = results.at(-1);
	assert.ok(result, "persisted session JSONL should include an agent_browser tool result");
	return { result, sessionFile };
}

function registerPipelineProvider(
	modelRuntime: ModelRuntime,
	toolArguments: Readonly<ToolCall["arguments"]>,
	priorCalls?: readonly ToolCall[],
	toolName?: string,
	discoveryStream?: ReturnType<typeof createToolCallingStream>,
): Model<Api> {
	modelRuntime.registerProvider(PIPELINE_PROVIDER, {
		api: "openai-completions",
		apiKey: "piab-pipeline-key",
		baseUrl: "https://pipeline.example.test/v1",
		models: [
			{
				contextWindow: 128_000,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
				id: PIPELINE_MODEL_ID,
				input: ["text"],
				maxTokens: 4096,
				name: "Pi Agent Browser Pipeline Test",
				reasoning: false,
				...(discoveryStream
					? {
							compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
						}
					: {}),
			},
		],
		streamSimple: discoveryStream ?? createToolCallingStream(toolArguments, priorCalls, toolName),
	});
	const model = modelRuntime.getModel(PIPELINE_PROVIDER, PIPELINE_MODEL_ID);
	assert.ok(model, "pipeline test model should be registered");
	return model;
}

async function runPipelinePrompt(options: {
	readonly fakeScript: string;
	readonly discoveryStream?: ReturnType<typeof createToolCallingStream>;
	readonly toolArguments: Readonly<ToolCall["arguments"]>;
	readonly toolName?: string;
	readonly extensionFactory?: ExtensionFactory;
	readonly priorCalls?: readonly ToolCall[];
	readonly runPrompt?: (session: AgentSession) => Promise<void>;
}): Promise<PipelinePromptResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-pipeline-"));
	// Keep real Pi transcripts outside both workspace and qualifier temp-root cleanup.
	const evidenceDir = process.env.PI_COMPAT_EVIDENCE_DIR ?? "";
	if (evidenceDir !== "") {
		await mkdir(evidenceDir, { recursive: true });
	}
	const sessionDir = await mkdtemp(
		join(evidenceDir === "" ? tmpdir() : evidenceDir, "pi-agent-browser-pipeline-sessions-"),
	);
	const invocationLogPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`try { require("node:fs").appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n"); } catch {}\n${options.fakeScript}`,
	);

	try {
		return await withPatchedEnv<PipelinePromptResult>(
			{
				PATH: `${tempDir}:${basePath}`,
				...(options.discoveryStream ? { HOME: join(tempDir, "home") } : {}),
			},
			async () => {
				const modelRuntime = await ModelRuntime.create({
					allowModelNetwork: false,
					credentials: new InMemoryCredentialStore(),
					modelsPath: null,
				});
				const model = registerPipelineProvider(
					modelRuntime,
					options.toolArguments,
					options.priorCalls,
					options.toolName,
					options.discoveryStream,
				);
				const instructionGroups: ExtensionFactory[] = [];
				if (
					options.discoveryStream &&
					"instructionGroupsExtension" in Pi &&
					typeof nativeInstructionGroups === "function"
				) {
					instructionGroups.push(async (api) => {
						await Reflect.apply(nativeInstructionGroups, undefined, [api]);
					});
				}
				const resourceLoader = new DefaultResourceLoader({
					agentDir: tempDir,
					cwd: tempDir,
					extensionFactories: options.extensionFactory
						? [...instructionGroups, options.extensionFactory]
						: [],
					additionalExtensionPaths: options.extensionFactory ? [] : [resolve(".")],
					noContextFiles: true,
					noExtensions: true,
					noPromptTemplates: true,
					noSkills: true,
					noThemes: true,
				});
				await resourceLoader.reload();
				assert.deepEqual(resourceLoader.getExtensions().errors, []);
				assert.equal(
					resourceLoader.getExtensions().extensions.length,
					1 + instructionGroups.length,
				);
				if (!options.extensionFactory) {
					assert.equal(
						resourceLoader.getExtensions().extensions[0]?.resolvedPath,
						resolve("dist/extensions/agent-browser/index.js"),
					);
				}
				const { session } = await createAgentSession({
					cwd: tempDir,
					model,
					modelRuntime,
					noTools: "builtin",
					settingsManager: SettingsManager.inMemory(),
					resourceLoader,
					sessionManager: SessionManager.create(tempDir, sessionDir, {
						id: randomUUID(),
					}),
					tools: options.discoveryStream
						? undefined
						: [
								...(options.priorCalls ?? []).map((call) => call.name),
								options.toolName ?? "agent_browser",
							],
				});
				try {
					await session.bindExtensions({
						onError: (error) => {
							throw new Error(error.error);
						},
					});
					if (options.runPrompt) {
						await options.runPrompt(session);
					} else {
						await session.prompt("Use agent_browser once.");
					}
					const inMemoryMessage = session.messages.find(isAgentBrowserToolResult);
					const inMemoryResult =
						inMemoryMessage === undefined ? undefined : readPipelineToolResult(inMemoryMessage);
					assert.ok(
						inMemoryResult,
						`agent_browser tool result should be recorded by Pi: ${session.messages
							.filter(
								(message) =>
									message.role === "assistant" &&
									message.errorMessage !== undefined &&
									message.errorMessage !== "",
							)
							.map((message) => (message.role === "assistant" ? message.errorMessage : ""))
							.join("; ")}`,
					);
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
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

for (const webSearch of ["absent", "startup", "late"] as const) {
	test(
		`Pi pipeline reveals complete browser instructions after discovery on a generic prompt before execution (web search: ${webSearch})`,
		{ skip: !NATIVE_DISCOVERY_ENABLED },
		async () => {
			assert.ok(
				"instructionGroupsExtension" in Pi && typeof nativeInstructionGroups === "function",
				"candidate must export its public instruction groups factory",
			);
			let hookCalls = 0;
			let executionCalls = 0;
			let requests = 0;
			const pipeline = await withPatchedEnv(
				{
					EXA_API_KEY: undefined,
					BRAVE_API_KEY: webSearch === "startup" ? "test-only-key" : undefined,
					PI_AGENT_BROWSER_CONFIG: undefined,
				},
				() =>
					runPipelinePrompt({
						toolArguments: { args: ["--help"] },
						extensionFactory(pi) {
							if (webSearch === "late") {
								pi.on("session_start", async (_event, ctx) => {
									const directory = join(ctx.cwd, ".pi/config/pi-agent-browser-native");
									await mkdir(directory, { recursive: true });
									await writeFile(
										join(directory, "config.json"),
										JSON.stringify({ version: 1, webSearch: { braveApiKey: "test-only-key" } }),
									);
								});
							}
							agentBrowserExtension(pi, {
								async beforeExecute() {
									executionCalls++;
								},
							});
							pi.on("before_agent_start", () => {
								hookCalls++;
							});
						},
						discoveryStream(model, context, options) {
							requests++;
							const names = getCurrentTools(context.messages).map((tool) => tool.name);
							const prompt = getCurrentSystemPrompt(context.messages);
							if (requests === 1) {
								// Final request-count checks require this first discovery-only phase.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.deepEqual(names, ["discover_tools"]);
								// This required first phase must not eagerly include browser instructions.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(!prompt.includes(PROJECT_RULE_PROMPT));
								return createToolCallingStream(
									{ enable: ["browser"] },
									[],
									"discover_tools",
									"call_discovery_pipeline",
								)(model, context, options);
							}
							const instructions = context.messages
								.filter(
									(message) =>
										message.role === "toolResult" && message.toolName === "discover_tools",
								)
								.flatMap((message) =>
									message.role === "toolResult"
										? message.content
												.filter((part) => part.type === "text")
												.map((part) => part.text)
										: [],
								)
								.join("\n");
							assert.ok(
								instructions.includes(PROJECT_RULE_PROMPT),
								"complete instructions must reach the model before execution",
							);
							for (const guideline of [
								...RUNTIME_PROMPT_GUIDELINES,
								...SHARED_BROWSER_PLAYBOOK_GUIDELINES,
								...Object.values(ADVANCED_TOOL_PROMPT_GUIDELINES).flat(),
							]) {
								// Every guideline in the complete fixed inventory must reach the model.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(instructions.includes(guideline), guideline);
							}
							assert.ok(names.includes("agent_browser"));
							assert.ok(names.includes("agent_browser_code"));
							assert.ok(names.includes("agent_browser_tools"));
							assert.equal(names.includes("agent_browser_web_search"), webSearch !== "absent");
							assert.ok(
								!names.includes("agent_browser_qa"),
								"discovery must not enable advanced tools",
							);
							assert.equal(hookCalls, 1, "activation must not rerun before_agent_start");
							if (requests === 2) {
								// Final request counts require this post-discovery/pre-execution phase.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(executionCalls, 0, "instructions precede first execution");
							}
							return createToolCallingStream({ args: ["--help"] })(model, context, options);
						},
						async runPrompt(session) {
							await session.prompt("Please continue.");
						},
						fakeScript: `process.stdout.write("agent-browser help fixture");`,
					}),
			);
			assert.equal(requests, 3);
			assert.equal(executionCalls, 1);
			assert.equal(pipeline.persistedResult.isError, false);
			assert.deepEqual(
				pipeline.invocations.map(({ args }) => args),
				[["--help"]],
			);
		},
	);
}

test(
	"Pi pipeline refuses same-batch browser execution before discovery instructions are read",
	{ skip: !NATIVE_DISCOVERY_ENABLED },
	async () => {
		assert.ok(
			"instructionGroupsExtension" in Pi && typeof nativeInstructionGroups === "function",
			"candidate must export its public instruction groups factory",
		);
		let requests = 0;
		let executionCalls = 0;
		const pipeline = await runPipelinePrompt({
			toolArguments: { args: ["--help"] },
			extensionFactory(pi) {
				agentBrowserExtension(pi, {
					async beforeExecute() {
						executionCalls++;
					},
				});
				// Make the premature call callable after suppression so it reaches the read gate,
				// rather than Pi's independent unknown-tool preflight.
				pi.on("before_agent_start", (event) => {
					pi.setActiveTools([...pi.getActiveTools(), "agent_browser"]);
					Object.assign(event.systemPromptOptions, { selectedTools: pi.getActiveTools() });
				});
			},
			discoveryStream(model, context, options) {
				requests++;
				if (requests === 1) {
					return createToolCallingStream({ args: ["--help"] }, [
						{
							type: "toolCall",
							id: "samebatch-discover",
							name: "discover_tools",
							arguments: { enable: ["browser"] },
						},
					])(model, context, options);
				}
				return streamTextResponse(model, "Stopped after guarded refusal.");
			},
			async runPrompt(session) {
				const before = session.getActiveToolNames().sort();
				await session.prompt("Discover and try a premature browser call.");
				const terminal = session.messages.at(-1);
				if (terminal?.role !== "assistant") {
					throw new Error("Expected a terminal assistant response");
				}
				assert.equal(terminal.stopReason, "stop", terminal.errorMessage);
				assert.equal(terminal.errorMessage, undefined);
				assert.deepEqual(session.getActiveToolNames().sort(), before);
				assert.ok(!before.includes("agent_browser_qa"));
			},
			fakeScript: `throw Error("browser must not dispatch before discovery");`,
		});
		assert.equal(requests, 2);
		assert.equal(pipeline.inMemoryResult.isError, true);
		assert.match(JSON.stringify(pipeline.inMemoryResult), /prior turn/);
		assert.equal(executionCalls, 0);
		assert.equal(pipeline.persistedResult.isError, true);
		assert.deepEqual(pipeline.invocations, []);
	},
);

test("Pi pipeline captures the owner cwd before an awaited browser policy without moving native ctx", async () => {
	let selected = "";
	let resolutions = 0;
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["download", "#export", "report.txt"], outputPath: "receipt.json" },
		extensionFactory(pi) {
			pi.on("before_agent_start", async (_event, ctx) => {
				selected = join(ctx.cwd, "operation");
				await mkdir(selected);
			});
			pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request) => {
				resolutions++;
				Object.assign(readRecord(request), { result: { cwd: selected } });
			});
			agentBrowserExtension(pi, {
				async beforeExecute(_id, ctx) {
					assert.notEqual(ctx.cwd, selected, "Pi's project context is unchanged");
					await Promise.resolve();
					selected = ctx.cwd;
				},
			});
		},
		fakeScript: `const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
const index = args.indexOf("download");
let data = { title: "Fixture", url: "https://fixture.example.test/" };
if (index >= 0) {
  const target = args[index + 2];
  if (fs.realpathSync(path.dirname(target)) !== fs.realpathSync(path.join(process.cwd(), "operation"))) throw Error("Operation root moved across policy await");
  fs.writeFileSync(target, "captured B");
  data = { path: target };
}
process.stdout.write(JSON.stringify({ success: true, data }));`,
	});
	assert.equal(resolutions, 1);
	assert.equal(
		pipeline.persistedResult.isError,
		false,
		JSON.stringify(pipeline.persistedResult.content),
	);
	const details = readRecord(pipeline.persistedResult.details);
	assert.ok(
		readString(readRecord(details.outputFile).absolutePath).endsWith(
			join("operation", "receipt.json"),
		),
	);
});

test(
	"Pi pipeline awaits beforeExecute after earlier sibling writes and before browser effects",
	{ timeout: 15_000 },
	async () => {
		const capturedIds: string[] = [];
		const writerEntered = Promise.withResolvers<undefined>();
		const writerRelease = Promise.withResolvers<undefined>();
		const captureEntered = Promise.withResolvers<string>();
		const captureRelease = Promise.withResolvers<undefined>();
		const pipeline = await runPipelinePrompt({
			priorCalls: [{ type: "toolCall", id: "writer", name: "write_fixture", arguments: {} }],
			toolArguments: { args: ["open", "https://fixture.example.test/"] },
			extensionFactory(pi) {
				pi.registerTool({
					name: "write_fixture",
					label: "Write fixture",
					description: "Write a file in two stages.",
					parameters: Type.Object({}),
					async execute(_id, _params, _signal, _update, ctx) {
						await writeFile(join(ctx.cwd, "writer.txt"), "partial");
						writerEntered.resolve(undefined);
						await writerRelease.promise;
						await writeFile(join(ctx.cwd, "writer.txt"), "complete");
						return { content: [{ type: "text", text: "Written." }], details: {} };
					},
				});
				agentBrowserExtension(pi, {
					async beforeExecute(id, ctx) {
						capturedIds.push(id);
						assert.ok(ctx.signal instanceof AbortSignal);
						assert.equal(await readFile(join(ctx.cwd, "writer.txt"), "utf8"), "complete");
						captureEntered.resolve(ctx.cwd);
						await captureRelease.promise;
						await writeFile(join(ctx.cwd, "captured.txt"), id);
					},
				});
			},
			async runPrompt(session) {
				const pending = session.prompt("Use agent_browser once.");
				try {
					await Promise.race([
						writerEntered.promise,
						pending.then(() => assert.fail("writer must dispatch")),
					]);
					await new Promise<void>((resolveTurn) => {
						setImmediate(resolveTurn);
					});
					assert.deepEqual(
						capturedIds,
						[],
						"browser capture must await the unfinished earlier writer",
					);
					writerRelease.resolve(undefined);
					const cwd = await Promise.race([
						captureEntered.promise,
						pending.then(() => assert.fail("capture must run")),
					]);
					await new Promise<void>((resolveTurn) => {
						setImmediate(resolveTurn);
					});
					assert.deepEqual(
						await readInvocationLog(join(cwd, "invocations.log")),
						[],
						"no browser effect may precede capture completion",
					);
				} finally {
					writerRelease.resolve(undefined);
					captureRelease.resolve(undefined);
					await pending;
				}
			},
			fakeScript: `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("open")) {
  if (fs.readFileSync("writer.txt", "utf8") !== "complete" || fs.readFileSync("captured.txt", "utf8") !== "call_agent_browser_pipeline") throw Error("Effect preceded capture");
}
process.stdout.write(JSON.stringify({ success: true, data: { title: "Fixture", url: "https://fixture.example.test/" } }));`,
		});
		assert.deepEqual(capturedIds, ["call_agent_browser_pipeline"]);
		assert.equal(
			pipeline.inMemoryResult.isError,
			false,
			JSON.stringify(pipeline.inMemoryResult.content),
		);
		assert.equal(pipeline.persistedResult.isError, false);
		assert.equal(pipeline.invocations.filter(({ args }) => args.includes("open")).length, 1);
	},
);

test("Pi pipeline captures code-created files before the next inner dispatch using the outer call ID", async () => {
	const capturedIds: string[] = [];
	const signals: AbortSignal[] = [];
	const pipeline = await runPipelinePrompt({
		toolName: "agent_browser_code",
		toolArguments: {
			code: `emit(await Promise.all([
  browser({ args: ["download", "#export", "report.txt"] }),
  browser({ args: ["open", "https://fixture.example.test/effect"] })
]));`,
		},
		extensionFactory(pi) {
			agentBrowserExtension(pi, {
				async beforeExecute(id, ctx) {
					capturedIds.push(id);
					assert.ok(ctx.signal instanceof AbortSignal);
					signals.push(ctx.signal);
					if (capturedIds.length === 2) {
						const report = await readFile(join(ctx.cwd, "report.txt"), "utf8");
						// Final captured-ID checks require both hooks; the second must see the download.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(report, "downloaded report");
						await writeFile(join(ctx.cwd, "captured-report.txt"), report);
					}
				},
			});
		},
		fakeScript: `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("download")) fs.writeFileSync("report.txt", "downloaded report");
if (args.includes("open") && fs.readFileSync("captured-report.txt", "utf8") !== "downloaded report") throw Error("Effect preceded file capture");
process.stdout.write(JSON.stringify({ success: true, data: { path: "report.txt", title: "Fixture", url: "https://fixture.example.test/", closed: true } }));`,
	});
	assert.deepEqual(capturedIds, ["call_agent_browser_pipeline", "call_agent_browser_pipeline"]);
	assert.notEqual(signals[0], signals[1], "each inner dispatch supplies its own abort signal");
	assert.equal(
		pipeline.inMemoryResult.isError,
		false,
		JSON.stringify(pipeline.inMemoryResult.content),
	);
	const details = readRecord(pipeline.persistedResult.details);
	assert.deepEqual(
		readArray(details.data).map((result) => readRecord(result).success),
		[true, true],
	);
	assert.equal(pipeline.invocations.filter(({ args }) => args.includes("download")).length, 1);
	assert.equal(pipeline.invocations.filter(({ args }) => args.includes("open")).length, 1);
	assert.equal(pipeline.invocations.filter(({ args }) => args.includes("close")).length, 0);
});

for (const code of [false, true]) {
	test(
		`Pi Stop cancels a pending beforeExecute without dispatching ${code ? "code" : "direct"} browser effects`,
		{ timeout: 15_000 },
		async () => {
			let notifyEntered!: () => void;
			const entered = new Promise<void>((resolveEntered) => {
				notifyEntered = resolveEntered;
			});
			let hookSignal: AbortSignal | undefined;
			const pipeline = await runPipelinePrompt({
				toolName: code ? "agent_browser_code" : "agent_browser",
				toolArguments: code
					? { code: `await browser({ args: ["open", "https://fixture.example.test/effect"] });` }
					: { args: ["open", "https://fixture.example.test/effect"] },
				extensionFactory(pi) {
					agentBrowserExtension(pi, {
						async beforeExecute(id, ctx) {
							assert.equal(id, "call_agent_browser_pipeline");
							assert.ok(ctx.signal instanceof AbortSignal);
							hookSignal = ctx.signal;
							notifyEntered();
							await delay(60_000, undefined, { signal: ctx.signal });
						},
					});
				},
				async runPrompt(session) {
					const pending = session.prompt("Use agent_browser once.");
					try {
						await Promise.race([
							entered,
							pending.then(() => assert.fail("Tool completed without entering beforeExecute")),
						]);
					} finally {
						await session.abort();
					}
					await pending;
				},
				fakeScript: `process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));`,
			});
			assert.equal(hookSignal?.aborted, true);
			assert.equal(pipeline.persistedResult.isError, true);
			assert.equal(pipeline.invocations.filter(({ args }) => args.includes("open")).length, 0);
			assert.equal(pipeline.invocations.filter(({ args }) => args.includes("close")).length, 0);
		},
	);
}

test("Pi pipeline records a rejected beforeExecute without spawning upstream", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["open", "https://fixture.example.test/effect"] },
		extensionFactory(pi) {
			agentBrowserExtension(pi, {
				beforeExecute: async () => {
					throw new Error("Capture failed");
				},
			});
		},
		fakeScript: `throw Error("Unexpected browser effect");`,
	});
	assert.deepEqual(pipeline.invocations, []);
	assert.equal(pipeline.persistedResult.isError, true);
	assert.match(
		pipeline.persistedResult.content.find((item) => item.type === "text")?.text ?? "",
		/Capture failed/,
	);
});

test("Pi pipeline keeps unconfigured browser scheduling and ordinary execution unchanged", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["open", "https://fixture.example.test/"] },
		async runPrompt(session) {
			assert.equal(
				session.agent.state.tools.find((tool) => tool.name === "agent_browser")?.executionMode,
				undefined,
			);
			await session.prompt("Use agent_browser once.");
		},
		fakeScript: `process.stdout.write(JSON.stringify({ success: true, data: { url: "https://fixture.example.test/", title: "Fixture" } }));`,
	});
	assert.equal(pipeline.persistedResult.isError, false);
	assert.equal(pipeline.invocations.filter(({ args }) => args.includes("open")).length, 1);
});

test("Pi pipeline patches persisted QA reclassification failures to isError with model-visible prose", async (t) => {
	const pipeline = await runPipelinePrompt({
		toolName: "agent_browser_qa",
		toolArguments: {
			expectedSelector: "main",
			expectedText: ["Welcome"],
			url: "https://fail.example.test/",
		},
		fakeScript: `const fs = require("node:fs");
if (process.argv.slice(-2).join(" ") === "get url") {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://fail.example.test/" } }));
  process.exit(0);
}
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

	for (const [surface, result] of Object.entries({
		"in-memory": pipeline.inMemoryResult,
		persisted: pipeline.persistedResult,
	})) {
		// Own the independently reported live and persisted result contracts before ending this scenario.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(surface, () => {
			assert.equal(result.isError, true);
			assert.equal(readRecord(result.details).resultCategory, "failure");
			assert.equal(readRecord(result.details).failureCategory, "qa-failure");
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			assert.match(
				text,
				/Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./,
			);
		});
	}
	assert.match(pipeline.sessionFile, /\.jsonl$/);
});

test("Pi pipeline persists covered-click recovery without retrying the blocked action", async (t) => {
	const error =
		"Element '#continue' is covered by <div role=dialog> at its click point, so the input would land on that element instead.";
	for (const originalError of [error, undefined, null, "  "]) {
		// Each model-free session owns separate fixtures; finish it before changing the global environment.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(
			originalError === undefined ? "undefined error" : JSON.stringify(originalError),
			async (scenarioContext) => {
				const json = originalError !== error;
				const pipeline = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "ambient" }, () =>
					runPipelinePrompt({
						toolArguments: {
							args: [
								"--namespace",
								"",
								"--session",
								"overlay-recovery",
								...(json ? ["--json", "find", "nth", "0", "#continue"] : ["click", "#continue"]),
							],
						},
						fakeScript: `const args = process.argv.slice(2);
if (args.includes("click") || args.includes("find")) {
  process.stdout.write(JSON.stringify(${JSON.stringify({ success: false, error: originalError, ...(json ? { data: { error } } : {}) })}));
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://overlay.example.test/", title: "Overlay fixture" } }));
}`,
					}),
				);

				for (const [surface, result] of Object.entries({
					"in-memory": pipeline.inMemoryResult,
					persisted: pipeline.persistedResult,
				})) {
					// Own the independently reported live and persisted result contracts before ending this scenario.
					// oxlint-disable-next-line no-await-in-loop
					await scenarioContext.test(surface, () => {
						assert.equal(result.isError, true);
						const details = readRecord(result.details);
						const nextActions = readArray(details.nextActions).map(readRecord);
						assert.equal(details.failureCategory, "upstream-error");
						assert.deepEqual(
							nextActions.map((action) => action.id),
							["inspect-overlay-state"],
						);
						assert.deepEqual(readRecord(nextActions[0].params).args, [
							"--namespace",
							"",
							"--session",
							"overlay-recovery",
							"snapshot",
							"-i",
						]);
						const text = result.content.find((item) => item.type === "text")?.text ?? "";
						if (json) {
							const visible = readRecord(JSON.parse(text));
							// The fixed JSON variant must retain its parseable native failure envelope.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(visible.success, false);
							// The JSON variant must retain the same failure category as its details.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(visible.resultCategory, "failure");
							// The JSON variant must retain the upstream failure classifier.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(visible.failureCategory, "upstream-error");
							// The JSON variant must retain the recovered upstream error.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(visible.error, error);
							// The JSON variant must retain its structured error payload.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(visible.data, { error });
							// The JSON variant must expose the same executable recovery as its details.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(visible.nextActions, details.nextActions);
						} else {
							// The fixed prose variant must instead render the recovery identifier.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(text, /inspect-overlay-state/);
						}
						assert.match(readString(nextActions[0].safety), /do not blindly retry/i);
					});
				}
				assert.equal(
					pipeline.invocations.filter(({ args }) => args.includes("click") || args.includes("find"))
						.length,
					1,
				);
			},
		);
	}
});

test("Pi pipeline rejects unsupported public schema fields before spawning upstream", async (t) => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["get", "url"], unsupportedRootField: true },
		fakeScript: `process.stdout.write(JSON.stringify({ success: true, data: "unexpected" }));`,
	});

	for (const [surface, result] of Object.entries({
		"in-memory": pipeline.inMemoryResult,
		persisted: pipeline.persistedResult,
	})) {
		// Own the independently reported live and persisted result contracts before ending this scenario.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(surface, () => {
			assert.equal(result.isError, true);
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			assert.match(text, /unsupportedRootField|additional/i);
		});
	}
	assert.deepEqual(pipeline.invocations, []);
});

test("Pi pipeline preserves persisted parseable JSON content while patching isError", async (t) => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["--json", "get", "url"] },
		fakeScript: `process.stdout.write(JSON.stringify({ success: false, error: "json boom", data: { code: "boom" } }));`,
	});

	for (const [surface, result] of Object.entries({
		"in-memory": pipeline.inMemoryResult,
		persisted: pipeline.persistedResult,
	})) {
		// Own the independently reported live and persisted result contracts before ending this scenario.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(surface, () => {
			assert.equal(result.isError, true);
			assert.equal(readRecord(result.details).resultCategory, "failure");
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			assert.doesNotMatch(text, /Pi tool isError/);
			// summary is dropped when byte-identical to error so bounded observations do not double-count failure text.
			assert.deepEqual(JSON.parse(text), {
				error: "json boom",
				data: { code: "boom" },
				success: false,
				resultCategory: "failure",
				failureCategory: "upstream-error",
				sessionName: readRecord(result.details).sessionName,
			});
		});
	}
});
