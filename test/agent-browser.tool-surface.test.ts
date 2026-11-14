import assert from "node:assert/strict";
import { readArray, readDefined, readRecord } from "./helpers/assertions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import {
	InMemoryCredentialStore,
	normalizeContext,
	validateToolArguments,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	createAgentSession,
	createToolSearchExtension,
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
import { BROWSER_GUIDANCE } from "../extensions/agent-browser/lib/playbook.js";
import { registerAgentBrowserToolSurface } from "../extensions/agent-browser/lib/tool-surface.js";
import { readToolArguments } from "./helpers/tool-result.mjs";

type RecordedBrowserCall = Readonly<Omit<AgentBrowserExecuteParams, "args">> & {
	readonly args?: readonly string[];
};

async function withSurface(
	testContext: TestContext,
	run: (fixture: {
		readonly session: AgentSession;
		readonly call: (name: string, input: JsonObject) => Promise<AgentToolResult<unknown>>;
		readonly active: () => string[];
		readonly all: () => string[];
		readonly calls: readonly RecordedBrowserCall[];
		readonly reload: () => Promise<void>;
	}) => Promise<void>,
	options: {
		readonly tools?: readonly string[];
		readonly defaultTools?: readonly string[];
		readonly sessionManager?: SessionManager;
		readonly result?: AgentToolResult<unknown>;
		readonly toolSearch?: boolean;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "piab-tool-surface-"));
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	const calls: AgentBrowserExecuteParams[] = [];
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
							getBatchPreflightValidationError: (): undefined => {
								// This surface fixture has no batch preflight failure.
							},
						});
						return (
							options.result ?? {
								content: [{ type: "text", text: resolved.status }],
								details: { resolved },
							}
						);
					},
				});
			},
			...(options.toolSearch === true ? [createToolSearchExtension()] : []),
		],
	});
	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: directory,
			modelRuntime,
			resourceLoader,
			...(options.defaultTools === undefined ? { noTools: "builtin" } : {}),
			...(options.tools === undefined ? {} : { tools: [...options.tools] }),
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
					// Use the selected host's complete, current tool context, including after reload.
					context = session.extensionRunner.createToolContext("surface", testContext.signal);
					return tool.execute("surface", params, testContext.signal, undefined, context);
				},
				active: () => session.getActiveToolNames(),
				all: () => session.getAllTools().map(({ name }) => name),
				calls,
				reload: () => session.reload(),
			});
		} finally {
			session.dispose();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const baseTools = ["agent_browser", "unrelated"];
const deferredTools = [
	"agent_browser_action",
	"agent_browser_electron",
	"agent_browser_network_source",
	"agent_browser_qa",
	"agent_browser_source",
];

nodeTest(
	"registered browser tool serializes for Anthropic while Pi still rejects invalid arguments",
	async (t) => {
		await withSurface(t, async ({ session, call, calls }) => {
			const tool = session.getToolDefinition("agent_browser");
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
						{ role: "user", content: "Use the browser.", timestamp: 2 },
					],
				}),
				{
					apiKey: "test-key",
					maxRetries: 0,
					async fetch(url, init) {
						// Consume the real host's wire body; maintained hosts may gzip direct Anthropic requests.
						const request = new Request(url, init);
						const encoding = request.headers.get("content-encoding");
						assert.ok(encoding === null || encoding === "gzip");
						assert.ok(request.body);
						const body =
							encoding === "gzip"
								? request.body.pipeThrough(new DecompressionStream("gzip"))
								: request.body;
						payload = await new Response(body).json();
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
			const wireTool = readDefined(readArray(readRecord(payload).tools).map(readRecord)[0]);
			assert.equal(wireTool.name, "agent_browser");
			assert.equal(
				Object.hasOwn(wireTool, "discovery"),
				false,
				"host discovery metadata must not become provider tool fields",
			);
			// Anthropic rejects integer minimum/maximum in strict tool schemas.
			assert.equal(wireTool.strict ?? false, false);
			assert.deepEqual(readRecord(readRecord(wireTool.input_schema).properties).timeoutMs, {
				type: "integer",
				description: "Timeout in ms; exceed explicit waits.",
				minimum: 1,
			});
			assert.deepEqual(readRecord(wireTool.input_schema).required, ["args"]);
			assert.deepEqual(
				Object.keys(readRecord(readRecord(wireTool.input_schema).properties)).sort(),
				["args", "outputPath", "sessionMode", "stdin", "timeoutMs"],
			);
			assert.ok(Buffer.byteLength(JSON.stringify(tool.parameters)) < 1400);
			const invalidInputs: JsonObject[] = [
				{ args: [] },
				{ args: ["get", "url"], outputPath: "" },
				{ args: ["get", "url"], timeoutMs: 0 },
				{ args: ["get", "url"], sessionMode: "never" },
				{ args: ["get", "url"], code: "emit(1)" },
				{ code: "emit(1)" },
			];
			for (const input of invalidInputs) {
				await t.test(`invalid input ${JSON.stringify(input)}`, async () => {
					const rejection = assert.rejects(
						call(tool.name, input),
						/Validation failed/,
						JSON.stringify(input),
					);

					await rejection;
				});
			}
			assert.deepEqual(calls, []);
			await call(tool.name, {
				args: ["get", "url"],
				stdin: null,
				timeoutMs: null,
				outputPath: null,
			});
			assert.deepEqual(calls, [{ args: ["get", "url"] }]);
			// Pi 1.5 validation truncates a fractional number for an integer field instead of rejecting it.
			await call(tool.name, { args: ["get", "url"], timeoutMs: 1.5 });
			assert.deepEqual(calls, [{ args: ["get", "url"] }, { args: ["get", "url"], timeoutMs: 1 }]);
		});
	},
);

nodeTest(
	"native Pi registration defers advanced tools: callable from scripts, declared only when loaded",
	async (t) => {
		await withSurface(t, async ({ active, all, session }) => {
			assert.deepEqual(
				all()
					.filter((name) => name.startsWith("agent_browser"))
					.sort(),
				[...baseTools.filter((name) => name !== "unrelated"), ...deferredTools].sort(),
			);
			const browserNames = all().filter((name) => name.startsWith("agent_browser"));
			assert.deepEqual(
				browserNames.map((name) => ({
					name,
					type: readRecord(readDefined(session.getToolDefinition(name)).parameters).type,
				})),
				browserNames.map((name) => ({ name, type: "object" })),
			);
			assert.deepEqual(
				session
					.getAllTools()
					.filter((tool) => deferredTools.includes(tool.name))
					.map((tool) => tool.exposure),
				deferredTools.map(() => "deferred"),
			);
			assert.deepEqual(active().sort(), [...baseTools].sort());
			assert.deepEqual(
				deferredTools.filter((name) => !session.getCallableToolNames().includes(name)),
				[],
				"deferred tools stay callable from codemode scripts while inactive",
			);
			session.setActiveToolsByName([...active(), "agent_browser_qa"]);
			assert.deepEqual(active().sort(), [...baseTools, "agent_browser_qa"].sort());
			assert.ok(active().includes("unrelated"));
		});
	},
);

nodeTest(
	"native defaultTools activates deferred tools and transcript restoration stays native",
	async (t) => {
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
				label: "default tools with a transcript removal overriding an addition",
				options: {
					defaultTools: ["agent_browser", "agent_browser_qa"],
					sessionManager: removed,
				},
			},
			{ label: "plain registration without default tools or restoration", options: {} },
		];
		for (const { label, options, restoredTool } of cases) {
			await t.test(label, async (caseContext) => {
				await withSurface(
					caseContext,
					async ({ active, reload }) => {
						const expected = [
							...baseTools,
							...(options.defaultTools ? ["agent_browser_qa"] : []),
							...(restoredTool !== undefined ? [restoredTool] : []),
						].sort();

						assert.deepEqual(active().sort(), expected, label);
						await reload();

						assert.deepEqual(active().sort(), expected, label);
					},
					options,
				);
			});
		}
	},
);

nodeTest(
	"the surface activates tool_search on start and tree navigation unless the branch removed it",
	async (t) => {
		const record = (manager: SessionManager, added: readonly string[], removed: string[] = []) => {
			manager.appendMessage({
				role: "system",
				content: "",
				timestamp: 0,
				toolsAdded: added.map((name) => ({
					name,
					description: name,
					parameters: JsonSchema.Object({}),
				})),
				toolsRemoved: removed.map((name) => ({ name })),
			});
			const leaf = manager.getLeafId();
			assert.ok(leaf !== null);
			return leaf;
		};
		const options = { toolSearch: true, defaultTools: ["agent_browser"] };
		// A branch recorded before the surface activated tool_search never mentions it.
		const navigated = SessionManager.inMemory();
		const unmentioned = record(navigated, baseTools);
		record(navigated, ["tool_search"]);
		await withSurface(
			t,
			async ({ active, session }) => {
				assert.ok(active().includes("tool_search"));
				const navigation = await session.navigateTree(unmentioned, { summarize: false });
				assert.equal(navigation.cancelled, false);
				assert.ok(active().includes("tool_search"), "tree navigation activates it again");
			},
			{ ...options, sessionManager: navigated },
		);
		// A recorded removal stays inactive, like any other tool Pi restores from the branch.
		const removed = SessionManager.inMemory();
		record(removed, [...baseTools, "tool_search"]);
		record(removed, [], ["tool_search"]);
		await withSurface(
			t,
			async ({ active }) => {
				assert.ok(!active().includes("tool_search"));
			},
			{ ...options, sessionManager: removed },
		);
	},
);

nodeTest(
	"public returns classify failure without a result hook and preserve JSON, images, and redacted recovery",
	async (t) => {
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "verified-inline-fixture",
		};
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
			{ name: "agent_browser_qa", input: { attached: true }, json: false },
		];
		const upstreamText = { type: "text" as const, text: "QA failed." };
		await withSurface(
			t,
			async ({ call, session }) => {
				for (const { name, input, json } of cases) {
					await t.test(`${name} ${json ? "JSON" : "prose"}`, async (output) => {
						upstreamText.text = json ? '{"success":false,"data":42}' : "QA failed.";

						const result = await call(name, input);

						assert.equal(result.isError, true);

						assert.deepEqual(
							result.content.filter((item) => item.type === "image"),
							[image],
						);
						const textItem = result.content.find((item) => item.type === "text");

						assert.ok(textItem);
						const text = textItem.text;
						if (json) {
							await output.test("JSON envelope", () => {
								assert.deepEqual(JSON.parse(text), { success: false, data: 42 });
							});
						} else {
							await output.test("prose failure", () => {
								assert.match(
									text,
									/Result category: failure; failureCategory: qa-failure; Pi tool isError: true/,
								);
							});
						}
						const observation = readToolArguments(result.structuredContent);

						assert.equal(observation.success, false);

						assert.deepEqual(observation.data, { password: "[REDACTED]", requested: 42 });

						assert.deepEqual(observation.nextActions, details.nextActions);

						assert.equal(observation.refSnapshot, undefined);
						const tool = session.getToolDefinition(name);

						assert.ok(tool);

						assert.ok(tool.outputSchema);
						validateToolArguments(
							{ ...tool, parameters: tool.outputSchema },
							{ type: "toolCall", id: "output", name, arguments: observation },
						);

						assert.equal(tool.namespace?.name, "browser");
					});
				}
			},
			{ result: { content: [upstreamText, image], details } },
		);
	},
);

nodeTest("export failures cannot retain a stale successful structured result", async (t) => {
	await withSurface(
		t,
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

nodeTest("advanced wrappers normalize into one executor", async (t) => {
	await withSurface(t, async ({ call, calls }) => {
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
			resolveAgentBrowserInput({
				params,
				getBatchPreflightValidationError: (): undefined => {
					// This surface fixture has no batch preflight failure.
				},
			}),
		);
		assert.deepEqual(
			normalized.map(({ status }) => status),
			Array(6).fill("valid"),
		);
		assert.deepEqual(
			normalized.map(({ kind }) => kind),
			["args", "semanticAction", "qa", "electron", "sourceLookup", "networkSourceLookup"],
		);
		assert.deepEqual(readDefined(calls[1]).semanticAction, {
			action: "fill",
			locator: "label",
			value: "Email",
			text: "user@example.com",
			session: "chosen",
		});
		assert.equal(readDefined(calls[2]).timeoutMs, 2000);
		assert.deepEqual(calls[3], {
			electron: { action: "launch", appName: "Editor", timeoutMs: 3000 },
			outputPath: "electron.json",
		});
		assert.equal(readDefined(calls[4]).timeoutMs, 4000);
		assert.deepEqual(readDefined(calls[5]).networkSourceLookup, {
			requestId: "req1",
			session: "chosen",
			namespace: "",
		});
		assert.equal(calls.length, 6);
	});
});

nodeTest("explicit native CLI tool selection activates deferred tools by name", async (t) => {
	await withSurface(
		t,
		async ({ active }) => {
			assert.deepEqual(active().sort(), ["agent_browser_action", "unrelated"]);
		},
		{ tools: ["agent_browser_action", "unrelated"] },
	);
});

for (const tools of [["agent_browser_qa"], ["agent_browser_qa", "agent_browser"]]) {
	nodeTest(
		`SDK-selected advanced tools stay active with selection ${tools.join(",")}`,
		async (t) => {
			await withSurface(
				t,
				async ({ active }) => {
					assert.deepEqual(active().sort(), [...tools].sort());
				},
				{ tools },
			);
		},
	);
}

nodeTest("internal input normalization rejects retired job/script routes", () => {
	const statuses = [{ script: "emit(1)" }, { job: { steps: [{ action: "snapshot" }] } }].map(
		(params) =>
			resolveAgentBrowserInput({
				params,
				getBatchPreflightValidationError: (): undefined => {
					// This surface fixture has no batch preflight failure.
				},
			}).status,
	);
	assert.deepEqual(statuses, ["invalid", "invalid"]);
});

nodeTest("always-on guidance is compact and names every deferred tool", () => {
	const guidance = BROWSER_GUIDANCE.join("\n");
	assert.ok(Buffer.byteLength(guidance) < 2500, `guidance is ${Buffer.byteLength(guidance)} bytes`);
	const required = [
		"batch --bail",
		"codemode scripts",
		"tool_search",
		"nextActions",
		"artifactVerification",
		"CSS coordinates",
		"sessionMode:fresh",
		"explicit authorization",
		...deferredTools,
	];
	assert.deepEqual(
		required.filter((token) => !guidance.includes(token)),
		[],
	);
	assert.doesNotMatch(guidance, /agent_browser_tools|agent_browser_code|emitImage|result\.ok/);
});

nodeTest(
	"Electron action schemas preserve field boundaries through native Pi validation",
	async (t) => {
		await withSurface(t, async ({ call, calls, session }) => {
			const electron = session.getToolDefinition("agent_browser_electron");
			assert.ok(electron);
			assert.equal(Check(electron.parameters, { action: "list", query: 42 }), false);
			assert.equal(Check(electron.parameters, { action: "list", maxResults: "10" }), false);
			await call("agent_browser_electron", { action: "list", query: 42 });
			assert.deepEqual(calls.at(-1)?.electron, { action: "list", query: "42" });
			await call("agent_browser_electron", { action: "list", maxResults: "10" });
			assert.deepEqual(calls.at(-1)?.electron, { action: "list", maxResults: 10 });
			// Pi 1.5 validation truncates a fractional number for an integer field instead of rejecting it.
			await call("agent_browser_electron", { action: "list", maxResults: 1.5 });
			assert.deepEqual(calls.at(-1)?.electron, { action: "list", maxResults: 1 });
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
				await t.test(action, async (fieldsContext) => {
					await call("agent_browser_electron", { action });
					for (const [field, value] of Object.entries(fields)) {
						const input = { action, [field]: value };
						if (names.includes(field)) {
							await call("agent_browser_electron", input);
						} else {
							await fieldsContext.test(`${field} rejects before dispatch`, async () => {
								const before = calls.length;

								const rejection = assert.rejects(
									call("agent_browser_electron", input),
									/Validation failed/,
								);

								await rejection;

								assert.equal(calls.length, before, `${action}.${field} must not dispatch`);
							});
						}
					}
				});
			}
			const invalid: JsonObject[] = [
				{ action: "status", launchId: "launch-1", all: true },
				{ action: "cleanup", launchId: "launch-1", all: true },
				{ action: "launch", timeoutMs: 0 },
				{ action: "launch", handoff: "invalid" },
				{ action: "list", maxResults: 0 },
				{ action: "list", query: "" },
				{ action: "launch", allow: [""] },
				{ action: "status", all: false },
				{ action: "cleanup", all: false },
				{ action: "probe", timeoutMs: 0 },
				{ action: "unknown" },
				{ action: "list", unknown: true },
				{},
			];
			for (const input of invalid) {
				await t.test(`invalid Electron ${JSON.stringify(input)}`, async () => {
					const before = calls.length;

					const rejection = assert.rejects(
						call("agent_browser_electron", input),
						/Validation failed/,
						JSON.stringify(input),
					);

					await rejection;

					assert.equal(calls.length, before, JSON.stringify(input));
				});
			}
		});
	},
);
