import assert from "node:assert/strict";
import { readArray, readRecord, readString } from "./helpers/assertions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import {
	InMemoryCredentialStore,
	normalizeContext,
	validateToolArguments,
	type JsonObject,
	type JsonValue,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentToolResult,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { JsonSchema } from "../extensions/agent-browser/lib/json-schema.js";
import {
	AGENT_BROWSER_ACTION_PARAMS,
	AGENT_BROWSER_QA_PARAMS,
} from "../extensions/agent-browser/lib/input-modes/params.js";
import {
	resolveAgentBrowserInput,
	type AgentBrowserExecuteParams,
} from "../extensions/agent-browser/lib/orchestration/input-plan.js";
import {
	ADVANCED_TOOL_PROMPT_GUIDELINES,
	QUICK_START_GUIDELINES,
	RUNTIME_PROMPT_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
} from "../extensions/agent-browser/lib/playbook.js";
import { registerAgentBrowserToolSurface } from "../extensions/agent-browser/lib/tool-surface.js";

function assertJsonObject(value: unknown): asserts value is JsonObject {
	for (const item of Object.values(readRecord(value))) {
		assertJsonValue(item);
	}
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number") {
		assert.ok(Number.isFinite(value));
		return;
	}
	if (Array.isArray(value)) {
		for (const item of readArray(value)) {
			assertJsonValue(item);
		}
		return;
	}
	assertJsonObject(value);
}

type RecordedBrowserCall = Readonly<Omit<AgentBrowserExecuteParams, "args">> & {
	readonly args?: readonly string[];
};

async function withSurface(
	run: (fixture: {
		readonly session: AgentSession;
		readonly call: (name: string, input: JsonObject) => Promise<AgentToolResult<unknown>>;
		readonly active: () => string[];
		readonly all: () => string[];
		readonly calls: readonly RecordedBrowserCall[];
		readonly codeCalls: readonly unknown[];
		readonly reload: () => Promise<void>;
	}) => Promise<void>,
	options: {
		readonly tools?: readonly string[];
		readonly defaultTools?: readonly string[];
		readonly sessionManager?: SessionManager;
		readonly result?: AgentToolResult<unknown>;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "piab-tool-surface-"));
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	const calls: AgentBrowserExecuteParams[] = [];
	const codeCalls: unknown[] = [];
	let context: ExtensionToolContext;
	const resourceLoader = new DefaultResourceLoader({
		agentDir: directory,
		cwd: directory,
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "unrelated",
					label: "Unrelated",
					description: "Another extension",
					parameters: JsonSchema.Object({}),
					async execute() {
						return { content: [], details: {} };
					},
				});
				registerAgentBrowserToolSurface(pi, {
					async execute(_id, params, _signal, _onUpdate, ctx) {
						assert.equal(ctx, context);
						calls.push(params);
						const resolved = resolveAgentBrowserInput({
							params,
							getBatchPreflightValidationError: () => undefined,
						});
						return (
							options.result ?? {
								content: [{ type: "text", text: resolved.status }],
								details: { resolved },
							}
						);
					},
					async executeCode(_id, params) {
						codeCalls.push(params);
						return options.result ?? { content: [], details: {} };
					},
				});
				pi.on("session_start", (_event, ctx) => {
					context = {
						...ctx,
						tools: [],
						async executeTool() {
							throw new Error("Nested tool execution is not used by this surface fixture.");
						},
					};
				});
			},
		],
	});
	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: directory,
			modelRuntime,
			resourceLoader,
			noTools: options.defaultTools ? undefined : "builtin",
			tools: options.tools ? [...options.tools] : undefined,
			settingsManager: SettingsManager.inMemory(
				options.defaultTools ? { defaultTools: [...options.defaultTools] } : {},
			),
			sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
		});
		try {
			await session.bindExtensions({
				onError: (error) => {
					throw new Error(error.error);
				},
			});
			await run({
				session,
				async call(name, input) {
					const tool = session.getToolDefinition(name);
					assert.ok(tool, `registered ${name}`);
					const params: unknown = validateToolArguments(tool, {
						type: "toolCall",
						name,
						id: "surface",
						arguments: input,
					});
					return tool.execute("surface", params, undefined, undefined, context);
				},
				active: () => session.getActiveToolNames(),
				all: () => session.getAllTools().map(({ name }) => name),
				calls,
				codeCalls,
				reload: () => session.reload(),
			});
		} finally {
			session.dispose();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const baseTools = ["agent_browser", "agent_browser_code", "agent_browser_tools", "unrelated"];

test("registered browser code serializes for Anthropic while Pi still rejects invalid arguments", async () => {
	await withSurface(async ({ session, call, codeCalls }) => {
		const tool = session.getToolDefinition("agent_browser_code");
		assert.ok(tool);
		let payload: unknown;
		const result = await streamAnthropic(
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 1024,
				compat: { supportsStrictTools: true },
			},
			normalizeContext({
				messages: [
					{ role: "system", content: "", toolsAdded: [tool], timestamp: 1 },
					{ role: "user", content: "Use browser code.", timestamp: 2 },
				],
			}),
			{
				apiKey: "test-key",
				maxRetries: 0,
				async fetch(_url, init) {
					payload = JSON.parse(readString(init?.body));
					return new Response(
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			},
		).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.ok(payload !== undefined);
		const [wireTool] = readArray(readRecord(payload).tools).map(readRecord);
		assert.equal(wireTool.name, "agent_browser_code");
		assert.equal(
			Object.hasOwn(wireTool, "discovery"),
			false,
			"host discovery metadata must not become provider tool fields",
		);
		// Anthropic rejects integer minimum/maximum in strict tool schemas.
		assert.equal(wireTool.strict ?? false, false);
		assert.deepEqual(readRecord(readRecord(wireTool.input_schema).properties).timeoutMs, {
			type: "integer",
			minimum: 1,
			maximum: 300000,
		});
		assert.deepEqual(readRecord(wireTool.input_schema).required, ["code"]);
		assert.deepEqual(Object.keys(readRecord(readRecord(wireTool.input_schema).properties)).sort(), [
			"code",
			"namespace",
			"outputPath",
			"session",
			"timeoutMs",
		]);
		assert.ok(Buffer.byteLength(JSON.stringify(tool.parameters)) < 1400);
		const invalidInputs: JsonObject[] = [
			{ code: "" },
			{ code: "emit(1)", session: "" },
			{ code: "emit(1)", timeoutMs: 0 },
			{ code: "emit(1)", timeoutMs: 300001 },
			{ code: "emit(1)", timeoutMs: 1.5 },
			{ code: "emit(1)", args: [] },
			{ script: "emit(1)" },
		];
		for (const input of invalidInputs) {
			// Every literal invalid code input must reject; the empty dispatch log is checked afterward.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			const rejection = assert.rejects(
				call(tool.name, input),
				/Validation failed/,
				JSON.stringify(input),
			);
			// Fixture transitions and their assertions run in order against this test's shared state.
			// oxlint-disable-next-line no-await-in-loop
			await rejection;
		}
		assert.deepEqual(codeCalls, []);
		await call(tool.name, {
			code: "emit(1)",
			session: null,
			namespace: "",
			timeoutMs: null,
			outputPath: null,
		});
		assert.deepEqual(codeCalls, [{ code: "emit(1)", namespace: "" }]);
	});
});

test("native Pi registration keeps advanced tools discoverable and activation additive", async () => {
	await withSurface(async ({ call, active, all, session }) => {
		assert.deepEqual(
			all()
				.filter((name) => name.startsWith("agent_browser"))
				.sort(),
			[
				"agent_browser",
				"agent_browser_action",
				"agent_browser_code",
				"agent_browser_electron",
				"agent_browser_network_source",
				"agent_browser_qa",
				"agent_browser_source",
				"agent_browser_tools",
			],
		);
		for (const name of all().filter((toolName) => toolName.startsWith("agent_browser"))) {
			const tool = session.getToolDefinition(name);
			// The exact nonempty inventory above requires every registered tool to publish an object root.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(tool, `registered ${name}`);
			// Strict providers reject schemas whose roots lack type: object.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(readRecord(tool.parameters).type, "object", `${name} root schema type`);
		}
		assert.deepEqual(active().sort(), [...baseTools].sort());
		assert.equal(session.getCallableToolNames().includes("agent_browser_qa"), false);
		const inventory = await call("agent_browser_tools", {});
		assert.match(JSON.stringify(inventory.content), /agent_browser_network_source.*inactive/);
		assert.deepEqual(active().sort(), [...baseTools].sort());
		const loaded = await call("agent_browser_tools", { enable: ["qa", "action", "qa"] });
		assert.deepEqual(readRecord(loaded.details).added, [
			"agent_browser_qa",
			"agent_browser_action",
		]);
		assert.deepEqual(loaded.structuredContent, loaded.details);
		assert.equal(session.getCallableToolNames().includes("agent_browser_qa"), true);
		assert.deepEqual(
			active().sort(),
			[...baseTools, "agent_browser_action", "agent_browser_qa"].sort(),
		);
		await call("agent_browser_tools", { enable: ["electron"] });
		assert.ok(active().includes("agent_browser_qa"));
		assert.ok(active().includes("unrelated"));
	});
});

test("native defaultTools survives startup and initial resume restoration is additive", async () => {
	const managerWithRestored = (...tools: readonly ("action" | "qa")[]): SessionManager => {
		const manager = SessionManager.inMemory();
		// Native history declares the complete initial loadout before additive tool deltas.
		manager.appendMessage({
			role: "system",
			content: "",
			timestamp: 0,
			toolsAdded: baseTools.map((name) => ({
				name,
				description: "Initially active tool",
				parameters: JsonSchema.Object({}),
			})),
		});
		manager.appendMessage({
			role: "system",
			content: "",
			timestamp: 1,
			toolsAdded: tools.map((tool) =>
				tool === "action"
					? {
							name: "agent_browser_action",
							description: "Action",
							parameters: AGENT_BROWSER_ACTION_PARAMS,
						}
					: { name: "agent_browser_qa", description: "QA", parameters: AGENT_BROWSER_QA_PARAMS },
			),
		});
		return manager;
	};
	const removed = managerWithRestored("qa", "action");
	removed.appendMessage({
		role: "system",
		content: "",
		timestamp: 2,
		toolsRemoved: [{ name: "agent_browser_action" }],
	});
	const cases: Array<{
		label: string;
		options: { defaultTools?: string[]; sessionManager?: SessionManager };
		restoredTool?: string;
	}> = [
		{
			label: "default tools with a transcript-restored action",
			options: {
				defaultTools: ["agent_browser", "agent_browser_qa"],
				sessionManager: managerWithRestored("qa", "action"),
			},
			restoredTool: "agent_browser_action",
		},
		{
			label: "default tools without restoration",
			options: { defaultTools: ["agent_browser", "agent_browser_qa"] },
		},
		{
			label: "transcript-restored qa without default tools",
			options: { sessionManager: managerWithRestored("qa") },
			restoredTool: "agent_browser_qa",
		},
		{
			label: "transcript removal overrides addition without default tools",
			options: { sessionManager: removed },
			restoredTool: "agent_browser_qa",
		},
		{ label: "plain registration without default tools or restoration", options: {} },
	];
	for (const { label, options, restoredTool } of cases) {
		// Fixture transitions and their assertions run in order against this test's shared state.
		// oxlint-disable-next-line no-await-in-loop
		await withSurface(async ({ active, reload }) => {
			const expected = [
				...baseTools,
				...(options.defaultTools ? ["agent_browser_qa"] : []),
				...(restoredTool !== undefined ? [restoredTool] : []),
			].sort();
			// Each fixed registration/restoration case checks active tools before and after reload.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(active().sort(), expected, label);
			await reload();
			// Each fixed registration/restoration case checks active tools before and after reload.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(active().sort(), expected, label);
		}, options);
	}
});

test("public returns classify failure without a result hook and preserve JSON, images, and redacted recovery", async () => {
	const image = { type: "image" as const, mimeType: "image/png", data: "verified-inline-fixture" };
	const details = {
		resultCategory: "failure",
		failureCategory: "qa-failure",
		data: { password: "do-not-expose", requested: 42 },
		refSnapshot: { internal: "replay-only" },
		nextActions: [
			{
				id: "inspect",
				tool: "agent_browser",
				params: { args: ["get", "url"] },
				reason: "Inspect before retrying.",
			},
		],
	};
	const cases: { name: string; input: JsonObject; json: boolean }[] = [
		{ name: "agent_browser", input: { args: ["get", "url"] }, json: false },
		{ name: "agent_browser", input: { args: ["get", "url", "--json"] }, json: true },
		{ name: "agent_browser_code", input: { code: "emit(42)" }, json: true },
		{ name: "agent_browser_qa", input: { attached: true }, json: false },
	];
	const upstreamText = { type: "text" as const, text: "QA failed." };
	await withSurface(
		async ({ call, session }) => {
			for (const { name, input, json } of cases) {
				upstreamText.text = json ? '{"success":false,"data":42}' : "QA failed.";
				// Each variant must finish before changing this fixture's upstream text.
				// oxlint-disable-next-line no-await-in-loop
				const result = await call(name, input);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(result.isError, true);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(
					result.content.filter((item) => item.type === "image"),
					[image],
				);
				const textItem = result.content.find((item) => item.type === "text");
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(textItem);
				const text = textItem.text;
				if (json) {
					// The fixed tool variants include JSON and prose; each format branch has its own assertion.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(JSON.parse(text), { success: false, data: 42 });
				} else {
					// The fixed tool variants include JSON and prose; each format branch has its own assertion.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						text,
						/Result category: failure; failureCategory: qa-failure; Pi tool isError: true/,
					);
				}
				const observation = result.structuredContent;
				assertJsonObject(observation);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(observation.success, false);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(observation.data, { password: "[REDACTED]", requested: 42 });
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(observation.nextActions, details.nextActions);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(observation.refSnapshot, undefined);
				const tool = session.getToolDefinition(name);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(tool);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(tool.outputSchema);
				validateToolArguments(
					{ ...tool, parameters: tool.outputSchema },
					{ type: "toolCall", id: "output", name, arguments: observation },
				);
				// All four literal tool/result variants check failure, image, recovery, and output contracts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(tool.namespace?.name, "browser");
			}
		},
		{ result: { content: [upstreamText, image], details } },
	);
});

test("export failures cannot retain a stale successful structured result", async () => {
	await withSurface(
		async ({ call }) => {
			const result = await call("agent_browser", {
				args: ["get", "url"],
				outputPath: "failed.json",
			});
			assert.equal(result.isError, true);
			assert.deepEqual(result.structuredContent, {
				success: false,
				resultCategory: "failure",
				error: "Output file failed.",
				failureCategory: "upstream-error",
			});
		},
		{
			result: {
				content: [{ type: "text", text: "Output file failed." }],
				isError: true,
				details: {
					resultCategory: "failure",
					failureCategory: "upstream-error",
					error: "Output file failed.",
				},
				structuredContent: { success: true, resultCategory: "success", data: "stale" },
			},
		},
	);
});

test("advanced wrappers normalize into one executor while code keeps explicit identity", async () => {
	await withSurface(async ({ call, calls, codeCalls }) => {
		await call("agent_browser", { args: ["get", "url"], timeoutMs: 500 });
		await call("agent_browser_action", {
			action: "fill",
			locator: "label",
			value: "Email",
			text: "user@example.com",
			session: "chosen",
			outputPath: "action.json",
			timeoutMs: 1000,
		});
		await call("agent_browser_qa", {
			attached: true,
			expectedText: "Ready",
			checkNetwork: true,
			outputPath: "qa.json",
			timeoutMs: 2000,
		});
		await call("agent_browser_electron", {
			action: "launch",
			appName: "Editor",
			timeoutMs: 3000,
			outputPath: "electron.json",
		});
		await call("agent_browser_source", {
			componentName: "Editor",
			maxWorkspaceFiles: 42,
			outputPath: "source.json",
			timeoutMs: 4000,
		});
		await call("agent_browser_network_source", {
			requestId: "req1",
			session: "chosen",
			namespace: "",
			outputPath: "network.json",
			timeoutMs: 5000,
		});
		const normalized = calls.map((params) =>
			resolveAgentBrowserInput({ params, getBatchPreflightValidationError: () => undefined }),
		);
		assert.deepEqual(
			normalized.map(({ status }) => status),
			Array(6).fill("valid"),
		);
		assert.deepEqual(
			normalized.map(({ kind }) => kind),
			["args", "semanticAction", "qa", "electron", "sourceLookup", "networkSourceLookup"],
		);
		assert.deepEqual(calls[1].semanticAction, {
			action: "fill",
			locator: "label",
			value: "Email",
			text: "user@example.com",
			session: "chosen",
		});
		assert.equal(calls[2].timeoutMs, 2000);
		assert.deepEqual(calls[3], {
			electron: { action: "launch", appName: "Editor", timeoutMs: 3000 },
			outputPath: "electron.json",
		});
		assert.equal(calls[4].timeoutMs, 4000);
		assert.deepEqual(calls[5].networkSourceLookup, {
			requestId: "req1",
			session: "chosen",
			namespace: "",
		});
		await call("agent_browser_code", {
			code: "emit(1)",
			session: "chosen",
			namespace: "",
			timeoutMs: 300000,
		});
		assert.deepEqual(codeCalls, [
			{ code: "emit(1)", session: "chosen", namespace: "", timeoutMs: 300000 },
		]);
		assert.equal(calls.length, 6);
	});
});

test("explicit native CLI tool selection stays active and the loader cannot override unavailable tools", async () => {
	const original = process.argv;
	try {
		process.argv = [
			original[0],
			"pi",
			"--tools",
			"agent_browser_action,agent_browser_tools,unrelated",
		];
		await withSurface(
			async ({ call, active }) => {
				assert.deepEqual(active().sort(), [
					"agent_browser_action",
					"agent_browser_tools",
					"unrelated",
				]);
				const result = await call("agent_browser_tools", { enable: ["qa"] });
				assert.match(JSON.stringify(result.content), /agent_browser_qa.*unavailable/);
				assert.equal(active().includes("agent_browser_qa"), false);
				assert.equal(active().includes("agent_browser_action"), true);
			},
			{ tools: ["agent_browser_action", "agent_browser_tools", "unrelated"] },
		);
	} finally {
		process.argv = original;
	}
});

for (const tools of [["agent_browser_qa"], ["agent_browser_qa", "agent_browser_tools"]]) {
	test(`SDK-selected advanced tools stay active with selection ${tools.join(",")}`, async () => {
		await withSurface(
			async ({ active }) => {
				assert.deepEqual(active().sort(), [...tools].sort());
			},
			{ tools },
		);
	});
}

test("internal input normalization rejects retired job/script routes", () => {
	for (const params of [{ script: "emit(1)" }, { job: { steps: [{ action: "snapshot" }] } }]) {
		const resolved = resolveAgentBrowserInput({
			params,
			getBatchPreflightValidationError: () => undefined,
		});
		// Both literal retired input routes must be rejected by raw-input normalization.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(resolved.status, "invalid");
	}
});

test("prompt routing is compact and preserves browser authority, recovery, and image geometry", () => {
	const runtime = RUNTIME_PROMPT_GUIDELINES.join("\n");
	assert.ok(Buffer.byteLength(runtime) < 3500);
	for (const required of [
		"batch --bail",
		"result.success",
		"emitImage(result.imageObservations[0])",
		"persistent browser",
		"globals do not persist",
		"nextActions",
		"CSS coordinates",
		"profiles",
		"explicit stops",
	]) {
		// All nine literal required prompt tokens must occur in the compact runtime guidance.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(runtime.includes(required), required);
	}
	const playbook = [
		...QUICK_START_GUIDELINES,
		...SHARED_BROWSER_PLAYBOOK_GUIDELINES,
		...Object.values(ADVANCED_TOOL_PROMPT_GUIDELINES).flat(),
	].join("\n");
	assert.doesNotMatch(
		playbook,
		/top-level script|\{\s*(?:script|job):|semanticAction\/job|result\.ok/,
	);
	const advancedGuidelines = Object.entries(ADVANCED_TOOL_PROMPT_GUIDELINES);
	assert.ok(advancedGuidelines.length > 0, "advanced tool guidance must not be empty");
	for (const [key, guidelines] of advancedGuidelines) {
		const toolName = key === "network" ? "agent_browser_network_source" : `agent_browser_${key}`;
		// The asserted nonempty advanced-guidance catalog checks each tool's own instruction lines.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(
			guidelines.every((line) => line.includes(toolName)),
			`${key} guidelines must name their tool`,
		);
	}
});

test("Electron action schemas preserve field boundaries through native Pi validation", async () => {
	await withSurface(async ({ call, calls, session }) => {
		const electron = session.getToolDefinition("agent_browser_electron");
		assert.ok(electron);
		assert.equal(Check(electron.parameters, { action: "list", query: 42 }), false);
		assert.equal(Check(electron.parameters, { action: "list", maxResults: "10" }), false);
		await call("agent_browser_electron", { action: "list", query: 42 });
		assert.deepEqual(calls.at(-1)?.electron, { action: "list", query: "42" });
		await call("agent_browser_electron", { action: "list", maxResults: "10" });
		assert.deepEqual(calls.at(-1)?.electron, { action: "list", maxResults: 10 });
		await call("agent_browser_electron", { action: "list", appPath: null, maxResults: null });
		assert.deepEqual(calls.at(-1)?.electron, { action: "list" });
		const fields: JsonObject = {
			query: "Editor",
			maxResults: 3,
			appPath: "/Applications/Editor.app",
			appName: "Editor",
			bundleId: "com.example.editor",
			executablePath: "/usr/bin/editor",
			appArgs: ["--test"],
			handoff: "connect",
			targetType: "page",
			timeoutMs: 3000,
			allow: ["example.com"],
			deny: ["blocked.example"],
			launchId: "launch-1",
			all: true,
			outputPath: "result.json",
		};
		const allowed: Record<string, string[]> = {
			list: ["query", "maxResults", "outputPath"],
			launch: [
				"appPath",
				"appName",
				"bundleId",
				"executablePath",
				"appArgs",
				"handoff",
				"targetType",
				"timeoutMs",
				"allow",
				"deny",
				"outputPath",
			],
			status: ["launchId", "all", "timeoutMs", "outputPath"],
			cleanup: ["launchId", "all", "timeoutMs", "outputPath"],
			probe: ["launchId", "timeoutMs", "outputPath"],
		};
		for (const [action, names] of Object.entries(allowed)) {
			// Fixture transitions and their assertions run in order against this test's shared state.
			// oxlint-disable-next-line no-await-in-loop
			await call("agent_browser_electron", { action });
			for (const [field, value] of Object.entries(fields)) {
				const input = { action, [field]: value };
				if (names.includes(field)) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					await call("agent_browser_electron", input);
				} else {
					const before = calls.length;
					// The fixed action/field matrix checks every disallowed pair rejects without dispatching.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					const rejection = assert.rejects(
						call("agent_browser_electron", input),
						/Validation failed/,
					);
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					await rejection;
					// The fixed action/field matrix checks every disallowed pair rejects without dispatching.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(calls.length, before, `${action}.${field} must not dispatch`);
				}
			}
		}
		const invalid: JsonObject[] = [
			{ action: "status", launchId: "launch-1", all: true },
			{ action: "cleanup", launchId: "launch-1", all: true },
			{ action: "launch", timeoutMs: 0 },
			{ action: "launch", handoff: "invalid" },
			{ action: "list", maxResults: 0 },
			{ action: "list", query: "" },
			{ action: "list", maxResults: 1.5 },
			{ action: "launch", allow: [""] },
			{ action: "status", all: false },
			{ action: "cleanup", all: false },
			{ action: "probe", timeoutMs: 0 },
			{ action: "unknown" },
			{ action: "list", unknown: true },
			{},
		];
		for (const input of invalid) {
			const before = calls.length;
			// Every literal invalid Electron input must reject at native schema validation.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			const rejection = assert.rejects(
				call("agent_browser_electron", input),
				/Validation failed/,
				JSON.stringify(input),
			);
			// Fixture transitions and their assertions run in order against this test's shared state.
			// oxlint-disable-next-line no-await-in-loop
			await rejection;
			// Every invalid Electron input must fail before the executor receives it.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(calls.length, before, JSON.stringify(input));
		}
	});
});
