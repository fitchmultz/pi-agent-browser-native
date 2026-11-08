import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readRecord } from "./helpers/assertions.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agentBrowserExtension from "../extensions/agent-browser/index.js";
import { BROWSER_GUIDANCE } from "../extensions/agent-browser/lib/playbook.js";
import { AGENT_BROWSER_TOOL_INVENTORY } from "../extensions/agent-browser/lib/tool-surface.js";
import {
	createExtensionHarness,
	getBrowserInstructions,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

const BARE_ENV = {
	PI_AGENT_BROWSER_CONFIG: undefined,
	EXA_API_KEY: undefined,
	BRAVE_API_KEY: undefined,
} as const;

nodeTest(
	"browser guidance is one bounded native prompt section that activates nothing",
	async () => {
		await withPatchedEnv(BARE_ENV, async () => {
			const harness = createExtensionHarness({ cwd: process.cwd() });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const active = harness.getActiveTools();
			const guidance = await getBrowserInstructions(harness);
			assert.deepEqual(
				BROWSER_GUIDANCE.filter((line) => !guidance.includes(line)),
				[],
			);
			assert.match(guidance, /Use agent_browser, not bash, for agent-browser/);
			assert.match(guidance, /codemode scripts \(tools\.agent_browser\)/);
			assert.match(guidance, /Find them with tool_search or call them from codemode scripts/);
			assert.deepEqual(
				Object.values(AGENT_BROWSER_TOOL_INVENTORY)
					.map(({ name }) => name)
					.filter((name) => !guidance.includes(name)),
				[],
				"every deferred tool is named in the guidance",
			);
			assert.doesNotMatch(guidance, /agent_browser_tools|agent_browser_code/);
			assert.deepEqual(
				["README.md", "docs/COMMAND_REFERENCE.md", "docs/TOOL_CONTRACT.md"].filter(
					(path) => !guidance.includes(join(process.cwd(), path)),
				),
				[],
				"installed doc paths are named in the guidance",
			);
			assert.ok(
				guidance.length < 3000,
				`always-on guidance must stay bounded: got ${guidance.length}`,
			);
			assert.deepEqual(
				[...harness.tools.values()].map((tool) => ({
					name: tool.name,
					guidelines: tool.promptGuidelines,
				})),
				[...harness.tools.keys()].map((name) => ({ name, guidelines: [] })),
			);
			assert.deepEqual(harness.getActiveTools(), active, "guidance must not activate tools");
			const sections: Record<string, string> = { unrelated: "Retain this section" };
			const event = {
				systemPrompt: "Base system prompt",
				systemPromptOptions: {
					sections,
				},
			};
			assert.deepEqual(
				await runExtensionEventResults(harness.handlers, "before_agent_start", event, harness.ctx),
				[],
				"guidance composes a native section, never a full prompt replacement",
			);
			assert.equal(event.systemPrompt, "Base system prompt");
			assert.equal(event.systemPromptOptions.sections.unrelated, "Retain this section");
			assert.equal(event.systemPromptOptions.sections.agent_browser, guidance);
			assert.equal(harness.handlers.get("tool_call"), undefined, "no bash guard");
		});
	},
);

nodeTest("documentation paths resolve lazily once per extension instance", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-docs-cache-"));
	try {
		await withPatchedEnv({ HOME: root, ...BARE_ENV }, async () => {
			const exists = t.mock.method(fs, "existsSync");
			const reads = t.mock.method(fs, "readFileSync");
			syncBuiltinESMExports();
			const manifest = join(process.cwd(), "package.json");
			const counts = () => ({
				exists: exists.mock.calls.filter((call) => call.arguments[0] === manifest).length,
				reads: reads.mock.calls.filter((call) => call.arguments[0] === manifest).length,
			});
			const harness = createExtensionHarness({ cwd: root });
			assert.deepEqual(counts(), { exists: 0, reads: 0 });
			const guidance = await getBrowserInstructions(harness);
			assert.deepEqual(counts(), { exists: 1, reads: 1 });
			assert.ok(
				["README.md", "docs/COMMAND_REFERENCE.md", "docs/TOOL_CONTRACT.md"].every((path) =>
					guidance.includes(join(process.cwd(), path)),
				),
			);
			const firstWalk = exists.mock.calls
				.map((call) => String(call.arguments[0]))
				.filter((path) => path.endsWith("package.json"));
			assert.ok(firstWalk.length > 0);
			assert.equal(new Set(firstWalk).size, firstWalk.length);
			const repeated = await Promise.all(
				Array.from({ length: 4 }, () => getBrowserInstructions(harness)),
			);
			assert.deepEqual(
				repeated,
				Array.from({ length: 4 }, () => guidance),
			);
			assert.deepEqual(counts(), { exists: 1, reads: 1 });
			const reloaded = createExtensionHarness({ cwd: root });
			assert.equal(await getBrowserInstructions(reloaded), guidance);
			assert.deepEqual(counts(), { exists: 2, reads: 2 });
		});
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

nodeTest("guidance follows live project config and trust", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-docs-live-config-"));
	try {
		await withPatchedEnv({ HOME: join(root, "home"), ...BARE_ENV }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			const initial = await getBrowserInstructions(harness);
			const configPath = join(root, ".pi/config/pi-agent-browser-native/config.json");
			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(
				configPath,
				JSON.stringify({ version: 1, browser: { executablePath: "/tmp/changed-browser" } }),
			);
			const updated = await getBrowserInstructions(harness);
			assert.notEqual(updated, initial);
			assert.ok(updated.includes("/tmp/changed-browser"));
			const trust = t.mock.method(harness.ctx, "isProjectTrusted", () => false);
			assert.equal(await getBrowserInstructions(harness), initial);
			trust.mock.restore();
			assert.equal(await getBrowserInstructions(harness), updated);
		});
	} finally {
		t.mock.restoreAll();
		await rm(root, { recursive: true, force: true });
	}
});

nodeTest(
	"guidance retains trusted config and late web-search registration without leaking secrets",
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "piab-instructions-"));
		try {
			await withPatchedEnv({ HOME: join(root, "home"), ...BARE_ENV }, async () => {
				const loader = new DefaultResourceLoader({
					agentDir: root,
					cwd: root,
					noContextFiles: true,
					noExtensions: true,
					noSkills: true,
					noThemes: true,
					noPromptTemplates: true,
					extensionFactories: [agentBrowserExtension],
				});
				await loader.reload();
				assert.deepEqual(loader.getExtensions().errors, []);
				const modelRuntime = await ModelRuntime.create({
					allowModelNetwork: false,
					credentials: new InMemoryCredentialStore(),
					modelsPath: null,
				});
				const { session } = await createAgentSession({
					cwd: root,
					modelRuntime,
					resourceLoader: loader,
					noTools: "builtin",
					settingsManager: SettingsManager.inMemory(),
					sessionManager: SessionManager.inMemory(root),
				});
				try {
					assert.equal(session.getToolDefinition("agent_browser_web_search"), undefined);
					const configPath = join(root, ".pi/config/pi-agent-browser-native/config.json");
					await mkdir(dirname(configPath), { recursive: true });
					await writeFile(
						configPath,
						JSON.stringify({
							version: 1,
							webSearch: { braveApiKey: "test-only-key" },
							browser: { executablePath: "/tmp/project-browser" },
						}),
					);
					await session.bindExtensions({
						onError: (error) => {
							throw new Error(error.error);
						},
					});
					assert.ok(session.getToolDefinition("agent_browser_web_search"));
					const browserTools = session
						.getAllTools()
						.filter((definition) => definition.name.startsWith("agent_browser"));
					assert.deepEqual(
						browserTools.map((tool) => ({
							name: tool.name,
							discovery: Object.hasOwn(
								readRecord(session.getToolDefinition(tool.name)),
								"discovery",
							),
							guidelines: tool.promptGuidelines ?? [],
						})),
						browserTools.map((tool) => ({ name: tool.name, discovery: false, guidelines: [] })),
					);
					const deferred: string[] = Object.values(AGENT_BROWSER_TOOL_INVENTORY).map(
						({ name }) => name,
					);
					assert.deepEqual(
						browserTools
							.filter((tool) => deferred.includes(tool.name))
							.map((tool) => tool.exposure),
						deferred.map(() => "deferred"),
					);
					const activeNames = new Set(session.getActiveToolNames());
					assert.ok(activeNames.has("agent_browser"));
					assert.ok(activeNames.has("agent_browser_web_search"));
					assert.deepEqual(
						deferred.filter((name) => activeNames.has(name)),
						[],
						"deferred tools are not declared until tool_search loads them",
					);
					for (const trusted of [true, false]) {
						await t.test(`project trust: ${trusted}`, async () => {
							const harness = createExtensionHarness({ cwd: root, projectTrusted: trusted });
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "new" },
								harness.ctx,
							);
							const guidance = await getBrowserInstructions(harness);
							assert.equal(guidance.includes("/tmp/project-browser"), trusted);
							assert.ok(!guidance.includes("test-only-key"));
						});
					}
					await session.reload();
					assert.ok(session.getToolDefinition("agent_browser_web_search"));
				} finally {
					session.dispose();
				}
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
