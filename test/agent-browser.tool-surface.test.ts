import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { JsonSchema } from "../extensions/agent-browser/lib/json-schema.js";
import { AGENT_BROWSER_ACTION_PARAMS, AGENT_BROWSER_QA_PARAMS } from "../extensions/agent-browser/lib/input-modes/params.js";
import { resolveAgentBrowserInput, type AgentBrowserExecuteParams } from "../extensions/agent-browser/lib/orchestration/input-plan.js";
import { ADVANCED_TOOL_PROMPT_GUIDELINES, QUICK_START_GUIDELINES, RUNTIME_PROMPT_GUIDELINES, SHARED_BROWSER_PLAYBOOK_GUIDELINES } from "../extensions/agent-browser/lib/playbook.js";
import { registerAgentBrowserToolSurface } from "../extensions/agent-browser/lib/tool-surface.js";

async function withSurface(
	run: (fixture: {
		call: (name: string, input: JsonObject) => Promise<{ content: unknown; details?: unknown }>;
		active: () => string[];
		all: () => string[];
		calls: AgentBrowserExecuteParams[];
		codeCalls: unknown[];
	}) => Promise<void>,
	options: { tools?: string[]; sessionManager?: SessionManager } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "piab-tool-surface-"));
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, credentials: new InMemoryCredentialStore(), modelsPath: null });
	const calls: AgentBrowserExecuteParams[] = [];
	const codeCalls: unknown[] = [];
	let context: ExtensionContext;
	const resourceLoader = new DefaultResourceLoader({
		agentDir: directory, cwd: directory,
		noContextFiles: true, noExtensions: true, noPromptTemplates: true, noSkills: true, noThemes: true,
		extensionFactories: [(pi) => {
			pi.registerTool({ name: "unrelated", label: "Unrelated", description: "Another extension", parameters: JsonSchema.Object({}), async execute() { return { content: [], details: {} }; } });
			registerAgentBrowserToolSurface(pi, {
				async execute(_id, params, _signal, _onUpdate, ctx) {
					assert.equal(ctx, context);
					calls.push(params);
					const resolved = resolveAgentBrowserInput({ params, getBatchPreflightValidationError: () => undefined });
					return { content: [{ type: "text", text: resolved.status }], details: { resolved } };
				},
				async executeCode(_id, params) { codeCalls.push(params); return { content: [], details: {} }; },
			});
			pi.on("session_start", (_event, ctx) => { context = ctx; });
		}],
	});
	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: directory, modelRuntime, resourceLoader, noTools: "builtin", tools: options.tools,
			settingsManager: SettingsManager.inMemory(), sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
		});
		try {
			await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
			await run({
				async call(name, input) {
					const tool = session.getToolDefinition(name);
					assert.ok(tool, `registered ${name}`);
					const params = validateToolArguments(tool, { type: "toolCall", name, id: "surface", arguments: input });
					return tool.execute("surface", params, undefined, undefined, context);
				},
				active: () => session.getActiveToolNames(),
				all: () => session.getAllTools().map(({ name }) => name),
				calls, codeCalls,
			});
		} finally {
			session.dispose();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const baseTools = ["agent_browser", "agent_browser_code", "agent_browser_tools", "unrelated"];

test("native Pi registration keeps advanced tools discoverable and activation additive", async () => {
	await withSurface(async ({ call, active, all }) => {
		assert.deepEqual(all().filter((name) => name.startsWith("agent_browser")).sort(), ["agent_browser", "agent_browser_action", "agent_browser_code", "agent_browser_electron", "agent_browser_network_source", "agent_browser_qa", "agent_browser_source", "agent_browser_tools"]);
		assert.deepEqual(active().sort(), [...baseTools].sort());
		const inventory = await call("agent_browser_tools", {});
		assert.match(JSON.stringify(inventory.content), /agent_browser_network_source.*inactive/);
		assert.deepEqual(active().sort(), [...baseTools].sort());
		const loaded = await call("agent_browser_tools", { enable: ["qa", "action", "qa"] });
		assert.deepEqual((loaded.details as { added: string[] }).added, ["agent_browser_qa", "agent_browser_action"]);
		assert.deepEqual(active().sort(), [...baseTools, "agent_browser_action", "agent_browser_qa"].sort());
		await call("agent_browser_tools", { enable: ["electron"] });
		assert.ok(active().includes("agent_browser_qa"));
		assert.ok(active().includes("unrelated"));
	});
});

test("advanced wrappers normalize into one executor while code keeps explicit identity", async () => {
	await withSurface(async ({ call, calls, codeCalls }) => {
		await call("agent_browser", { args: ["get", "url"], timeoutMs: 500 });
		await call("agent_browser_action", { action: "fill", locator: "label", value: "Email", text: "user@example.com", session: "chosen", outputPath: "action.json", timeoutMs: 1000 });
		await call("agent_browser_qa", { attached: true, expectedText: "Ready", checkNetwork: true, outputPath: "qa.json", timeoutMs: 2000 });
		await call("agent_browser_electron", { action: "launch", appName: "Editor", timeoutMs: 3000, outputPath: "electron.json" });
		await call("agent_browser_source", { componentName: "Editor", maxWorkspaceFiles: 42, outputPath: "source.json", timeoutMs: 4000 });
		await call("agent_browser_network_source", { requestId: "req1", session: "chosen", namespace: "", outputPath: "network.json", timeoutMs: 5000 });
		const normalized = calls.map((params) => resolveAgentBrowserInput({ params, getBatchPreflightValidationError: () => undefined }));
		assert.deepEqual(normalized.map(({ status }) => status), Array(6).fill("valid"));
		assert.deepEqual(normalized.map(({ kind }) => kind), ["args", "semanticAction", "qa", "electron", "sourceLookup", "networkSourceLookup"]);
		assert.deepEqual(calls[1].semanticAction, { action: "fill", locator: "label", value: "Email", text: "user@example.com", session: "chosen" });
		assert.equal(calls[2].timeoutMs, 2000);
		assert.deepEqual(calls[3], { electron: { action: "launch", appName: "Editor", timeoutMs: 3000 }, outputPath: "electron.json" });
		assert.equal(calls[4].timeoutMs, 4000);
		assert.deepEqual(calls[5].networkSourceLookup, { requestId: "req1", session: "chosen", namespace: "" });
		await call("agent_browser_code", { code: "emit(1)", session: "chosen", namespace: "", timeoutMs: 300000 });
		assert.deepEqual(codeCalls, [{ code: "emit(1)", session: "chosen", namespace: "", timeoutMs: 300000 }]);
		assert.equal(calls.length, 6);
	});
});

test("startup preserves native transcript activation and honors native removals", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "", timestamp: 1, toolsAdded: [
		{ name: "agent_browser_qa", description: "QA", parameters: AGENT_BROWSER_QA_PARAMS },
		{ name: "agent_browser_action", description: "Action", parameters: AGENT_BROWSER_ACTION_PARAMS },
	] });
	manager.appendMessage({ role: "system", content: "", timestamp: 2, toolsRemoved: [{ name: "agent_browser_action" }] });
	await withSurface(async ({ active }) => {
		assert.deepEqual(active().sort(), [...baseTools, "agent_browser_qa"].sort());
	}, { sessionManager: manager });
});

test("explicit native CLI tool selection stays active and the loader cannot override unavailable tools", async () => {
	const original = process.argv;
	try {
		process.argv = [original[0], "pi", "--tools", "agent_browser_action,agent_browser_tools,unrelated"];
		await withSurface(async ({ call, active }) => {
			assert.deepEqual(active().sort(), ["agent_browser_action", "agent_browser_tools", "unrelated"]);
			const result = await call("agent_browser_tools", { enable: ["qa"] });
			assert.match(JSON.stringify(result.content), /agent_browser_qa.*unavailable/);
			assert.equal(active().includes("agent_browser_qa"), false);
			assert.equal(active().includes("agent_browser_action"), true);
		}, { tools: ["agent_browser_action", "agent_browser_tools", "unrelated"] });
	} finally { process.argv = original; }
});

test("internal input normalization preserves QA semantics without public job/script routes", () => {
	for (const params of [{ script: "emit(1)" }, { job: { steps: [{ action: "snapshot" }] } }]) {
		const resolved = resolveAgentBrowserInput({ params: params as AgentBrowserExecuteParams, getBatchPreflightValidationError: () => undefined });
		assert.equal(resolved.status, "invalid");
	}
	const resolve = (params: AgentBrowserExecuteParams) => resolveAgentBrowserInput({ params, getBatchPreflightValidationError: () => undefined });
	assert.match(resolve({ qa: { attached: true }, sessionMode: "fresh" }).validationError ?? "", /cannot be used/);
	assert.match(resolve({ qa: { url: "https://example.com" }, stdin: "[]" }).validationError ?? "", /generate their own batch stdin/);
	const qa = resolve({ qa: { url: "https://example.com", expectedText: "Ready" } });
	assert.equal(qa.kind, "qa");
	if (qa.kind !== "qa") assert.fail("QA should compile");
	assert.equal(qa.compiledQaPreset.checks.checkNetwork, true);
	assert.equal(qa.compiledQaPreset.checks.diagnosticsResetAtStart, true);
	assert.equal(qa.compiledGeneratedBatch.failFast, true);
	assert.deepEqual(qa.compiledGeneratedBatch.args, ["batch", "--bail"]);
	assert.ok(qa.compiledGeneratedBatch.steps.some(({ args }) => args[0] === "wait" && args[1] === "--fn"));
});

test("prompt routing is compact and preserves browser authority, recovery, and image geometry", () => {
	const runtime = RUNTIME_PROMPT_GUIDELINES.join("\n");
	assert.ok(Buffer.byteLength(runtime) < 3500);
	for (const required of ["batch --bail", "result.success", "emitImage(result.imageObservations[0])", "persistent browser", "globals do not persist", "nextActions", "CSS coordinates", "profiles", "explicit stops"]) assert.ok(runtime.includes(required), required);
	const playbook = [...QUICK_START_GUIDELINES, ...SHARED_BROWSER_PLAYBOOK_GUIDELINES, ...Object.values(ADVANCED_TOOL_PROMPT_GUIDELINES).flat()].join("\n");
	assert.doesNotMatch(playbook, /top-level script|\{\s*(?:script|job):|semanticAction\/job|result\.ok/);
	for (const [key, guidelines] of Object.entries(ADVANCED_TOOL_PROMPT_GUIDELINES)) {
		const toolName = key === "network" ? "agent_browser_network_source" : `agent_browser_${key}`;
		assert.ok(guidelines.every((line) => line.includes(toolName)), `${key} guidelines must name their tool`);
	}
});
