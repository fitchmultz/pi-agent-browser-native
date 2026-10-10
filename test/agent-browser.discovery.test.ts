import assert from "node:assert/strict";
import { readRecord } from "./helpers/assertions.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agentBrowserExtension from "../extensions/agent-browser/index.js";
import {
	PROJECT_RULE_PROMPT,
	QUICK_START_GUIDELINES,
	RUNTIME_PROMPT_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	ADVANCED_TOOL_PROMPT_GUIDELINES,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
	WEB_SEARCH_TOOL_PROMPT_GUIDELINES,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	createExtensionHarness,
	getBrowserInstructions,
	runExtensionEvent,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

type Harness = ReturnType<typeof createExtensionHarness>;
type Group = {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly instructions: (ctx: Harness["ctx"]) => string;
};

test("browser instruction ownership is synchronous and dynamic, with identical full eager fallback", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
	const active = harness.getActiveTools();
	const fallback = await getBrowserInstructions(harness);
	assert.ok(fallback.startsWith(PROJECT_RULE_PROMPT));
	for (const line of [
		...RUNTIME_PROMPT_GUIDELINES,
		...QUICK_START_GUIDELINES,
		...SHARED_BROWSER_PLAYBOOK_GUIDELINES,
		...WRAPPER_TAB_RECOVERY_BEHAVIOR,
		...Object.values(ADVANCED_TOOL_PROMPT_GUIDELINES).flat(),
	]) {
		// Every declared prompt guideline must be included; the inventory is the fixture.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(fallback.includes(line), `missing full guidance: ${line}`);
	}
	for (const tool of harness.tools.values()) {
		// Every registered browser tool must avoid eager guidelines; registration is checked below.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(tool.promptGuidelines, [], `${tool.name} must not leak eager guidelines`);
	}
	let managed = true;
	const groups: Group[] = [];
	harness.events.emit("pi:instruction-groups", {
		register: (group: Group) => {
			groups.push(group);
		},
		isManaged: () => managed,
	});
	assert.equal(groups.length, 1, "registration completes before emit returns");
	const group = groups[0];
	assert.notEqual(group, undefined);
	assert.equal(group.name, "browser");
	assert.match(group.description, /browse/i);
	assert.ok([...harness.tools.keys()].every((name) => group.tools.includes(name)));
	assert.equal(group.instructions(harness.ctx), fallback);
	assert.equal(
		await getBrowserInstructions(harness),
		"",
		"managed ownership suppresses eager instructions",
	);
	assert.deepEqual(
		harness.getActiveTools(),
		active,
		"instruction discovery must not activate tools",
	);
	managed = false;
	assert.equal(
		await getBrowserInstructions(harness),
		fallback,
		"an inactive manager restores full eager guidance",
	);
	assert.deepEqual(harness.getActiveTools(), active);
});

test("compact eager fallback bounds prompt size when AGENT_BROWSER_COMPACT_FALLBACK is set", async () => {
	await withPatchedEnv(
		{
			AGENT_BROWSER_COMPACT_FALLBACK: "true",
			PI_AGENT_BROWSER_CONFIG: undefined,
			EXA_API_KEY: undefined,
			BRAVE_API_KEY: undefined,
		},
		async () => {
			const harness = createExtensionHarness({ cwd: process.cwd() });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const fallback = await getBrowserInstructions(harness);
			assert.ok(fallback.startsWith(PROJECT_RULE_PROMPT));
			assert.ok(fallback.includes("Use agent_browser for real browser or live web content."));
			for (const line of SHARED_BROWSER_PLAYBOOK_GUIDELINES) {
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(
					!fallback.includes(line),
					`compact fallback must omit long playbook line: ${line}`,
				);
			}
			assert.ok(
				fallback.length < 5000,
				`compact fallback must stay bounded: got ${fallback.length}`,
			);
		},
	);
});

test("full instructions retain trusted config and late web-search guidance without legacy metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-instructions-"));
	try {
		await withPatchedEnv(
			{
				HOME: join(root, "home"),
				PI_AGENT_BROWSER_CONFIG: undefined,
				EXA_API_KEY: undefined,
				BRAVE_API_KEY: undefined,
			},
			async () => {
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
					for (const tool of session
						.getAllTools()
						.filter((definition) => definition.name.startsWith("agent_browser"))) {
						// Every loaded browser tool must use supported SDK metadata, not bespoke discovery.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							Object.hasOwn(readRecord(session.getToolDefinition(tool.name)), "discovery"),
							false,
						);
						// Every loaded browser tool must avoid eager prompt leakage; tools are asserted above.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(tool.promptGuidelines ?? [], []);
					}
					for (const trusted of [true, false]) {
						const harness = createExtensionHarness({ cwd: root, projectTrusted: trusted });
						// Trusted-session startup owns tool registration before instruction discovery.
						// oxlint-disable-next-line no-await-in-loop
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						// Read this trust variant's instructions before the next environment-scoped startup.
						// oxlint-disable-next-line no-await-in-loop
						const fallback = await getBrowserInstructions(harness);
						const groups: Group[] = [];
						harness.events.emit("pi:instruction-groups", {
							register: (group: Group) => {
								groups.push(group);
							},
							isManaged: () => true,
						});
						// Both fixed trust variants must expose the identical full instruction-group fallback.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(groups[0]?.instructions(harness.ctx), fallback);
						// Both fixed trust variants must honor project browser-config trust.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(fallback.includes("/tmp/project-browser"), trusted);
						for (const line of WEB_SEARCH_TOOL_PROMPT_GUIDELINES) {
							// Every declared search guideline is checked under both fixed trust variants.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(fallback.includes(line), trusted);
						}
						// Neither fixed trust variant may leak the independent credential canary.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(!fallback.includes("test-only-key"));
					}
					await session.reload();
					assert.ok(session.getToolDefinition("agent_browser_web_search"));
				} finally {
					session.dispose();
				}
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
