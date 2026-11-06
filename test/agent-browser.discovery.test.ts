import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readRecord, readDefined } from "./helpers/assertions.js";
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
	runExtensionEventResults,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

type Harness = ReturnType<typeof createExtensionHarness>;
type Group = {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly instructions: (ctx: Harness["ctx"]) => string;
};

nodeTest(
	"browser instruction ownership is synchronous and dynamic, with identical full eager fallback",
	async () => {
		// Ambient compact settings must not leak into the full-fallback ownership test.
		delete process.env.AGENT_BROWSER_COMPACT_FALLBACK;
		delete process.env.AGENT_BROWSER_PLAYBOOK;
		const harness = createExtensionHarness({ cwd: process.cwd() });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
		const active = harness.getActiveTools();
		const fallback = await getBrowserInstructions(harness);
		assert.ok(fallback.startsWith(PROJECT_RULE_PROMPT));
		assert.match(
			fallback,
			/Still require explicit authorization for purchases, production-control actions, destructive or irreversible actions, and account, security, or privacy changes/,
		);
		assert.doesNotMatch(fallback, /Stop before order\/post\/purchase\/submit/);
		assert.match(
			fallback,
			/ordinary non-destructive form submissions within the requested flow may proceed without separate confirmation/,
		);
		assert.match(fallback, /agent_browser for one native command/);
		assert.match(
			fallback,
			/Standard workflow: open the page, snapshot -i, interact using current @refs/,
		);
		assert.match(fallback, /sessionMode:fresh intentionally launches a separate managed browser/);
		assert.match(
			fallback,
			/Ordinary bare calls share one native browser within your root Pi parent\/subagent group/,
		);
		assert.match(fallback, /copied Chrome profiles may omit encrypted cookies/);
		assert.match(fallback, /use the user's exact requested paths when given/);
		assert.match(fallback, /native config and environment pass through/);
		assert.match(
			fallback,
			/Use requested\/configured profiles and verify authentication after restart/,
		);
		assert.match(fallback, /Prefer refs; inspect screenshots only when the task needs vision/);
		assert.match(fallback, /Use read <url> for readable web text/);
		assert.match(fallback, /get text\/html\/value\/count <selector>/);
		assert.match(fallback, /get attr <selector> <name>/);
		assert.doesNotMatch(fallback, /get title\/url\/text\/html\/value\/attr\/count/);
		assert.match(fallback, /Use --json only when JSON text is needed/);
		assert.doesNotMatch(fallback, /never pass --json/);
		assert.match(fallback, /install ffmpeg before starting and pair start with stop/);
		assert.match(
			fallback,
			/nested scroll containers, verify scroll with a screenshot or fresh snapshot -i/,
		);
		assert.match(fallback, /Follow model-visible nextActions when present/);
		assert.match(
			fallback,
			/serialize each complete browser operation and code cell by native socket context, namespace, and session/,
		);
		assert.match(fallback, /Different identities remain concurrent/);
		assert.match(fallback, /It is not a transaction or rollback/);
		assert.match(
			fallback,
			/Choose agent_browser for one native command, native batch --bail with JSON-array stdin for a known fixed sequence/,
		);
		assert.match(fallback, /Return to the model when a fresh observation needs judgment/);
		assert.match(fallback, /Neither tool is a named recipe registry/);
		assert.match(fallback, /evidence-only screenshots/);
		assert.match(fallback, /Routine same-session calls skip tab-list preflights/);
		assert.match(fallback, /react inspect <fiberId>/);
		assert.doesNotMatch(fallback, /react tree\/inspect\/renders\/suspense/);
		assert.match(fallback, /network route <url>/);
		assert.match(fallback, /diff screenshot --baseline <file>/);
		assert.doesNotMatch(fallback, /diff snapshot\/screenshot\/url/);
		assert.match(fallback, /clipboard write <text>/);
		assert.doesNotMatch(fallback, /clipboard read\/write\/copy\/paste/);
		assert.ok(fallback.includes(join(process.cwd(), "README.md")));
		assert.ok(fallback.includes(join(process.cwd(), "docs/COMMAND_REFERENCE.md")));
		assert.ok(fallback.includes(join(process.cwd(), "docs/TOOL_CONTRACT.md")));
		const fullGuidelines = [
			...QUICK_START_GUIDELINES,
			...SHARED_BROWSER_PLAYBOOK_GUIDELINES,
			...WRAPPER_TAB_RECOVERY_BEHAVIOR,
			...Object.values(ADVANCED_TOOL_PROMPT_GUIDELINES).flat(),
		];
		assert.deepEqual(
			fullGuidelines.filter((line) => !fallback.includes(line)),
			[],
		);
		assert.deepEqual(
			RUNTIME_PROMPT_GUIDELINES.filter((line) => fallback.includes(line)),
			[],
		);
		assert.deepEqual(
			[...harness.tools.values()].map((tool) => ({
				name: tool.name,
				guidelines: tool.promptGuidelines,
			})),
			[...harness.tools.keys()].map((name) => ({ name, guidelines: [] })),
		);
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
		assert.ok(group);
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
			"eager fallback composes a native section, never a full prompt replacement",
		);
		assert.equal(event.systemPrompt, "Base system prompt");
		assert.equal(event.systemPromptOptions.sections.unrelated, "Retain this section");
		assert.equal(event.systemPromptOptions.sections.agent_browser, fallback);
	},
);

nodeTest(
	"documentation paths resolve lazily once per extension instance across instruction callers",
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "piab-docs-cache-"));
		try {
			await withPatchedEnv(
				{
					HOME: root,
					PI_AGENT_BROWSER_CONFIG: undefined,
					EXA_API_KEY: undefined,
					BRAVE_API_KEY: undefined,
					AGENT_BROWSER_COMPACT_FALLBACK: undefined,
					AGENT_BROWSER_PLAYBOOK: undefined,
				},
				async () => {
					const exists = t.mock.method(fs, "existsSync");
					const reads = t.mock.method(fs, "readFileSync");
					syncBuiltinESMExports();
					const manifest = join(process.cwd(), "package.json");
					const counts = () => ({
						exists: exists.mock.calls.filter((call) => call.arguments[0] === manifest).length,
						reads: reads.mock.calls.filter((call) => call.arguments[0] === manifest).length,
					});
					const harness = createExtensionHarness({ cwd: root });
					const active = harness.getActiveTools();
					const groups: Group[] = [];
					let managed = true;
					harness.events.emit("pi:instruction-groups", {
						register: (group: Group) => groups.push(group),
						isManaged: () => managed,
					});
					assert.equal(await getBrowserInstructions(harness), "");
					assert.deepEqual(counts(), { exists: 0, reads: 0 });
					const group = readDefined(groups[0]);
					const full = group.instructions(harness.ctx);
					managed = false;
					const fallback = await getBrowserInstructions(harness);
					assert.equal(fallback, full);
					assert.deepEqual(counts(), { exists: 1, reads: 1 });
					assert.ok(
						["README.md", "docs/COMMAND_REFERENCE.md", "docs/TOOL_CONTRACT.md"].every((path) =>
							fallback.includes(join(process.cwd(), path)),
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
						Array.from({ length: 4 }, () => fallback),
					);
					assert.equal(group.instructions(harness.ctx), fallback);
					assert.deepEqual(counts(), { exists: 1, reads: 1 });
					assert.deepEqual(
						exists.mock.calls
							.map((call) => String(call.arguments[0]))
							.filter((path) => path.endsWith("package.json")),
						firstWalk,
					);
					assert.deepEqual(harness.getActiveTools(), active);
					const reloaded = createExtensionHarness({ cwd: root });
					assert.deepEqual(counts(), { exists: 1, reads: 1 });
					assert.equal(await getBrowserInstructions(reloaded), fallback);
					assert.deepEqual(counts(), { exists: 2, reads: 2 });
				},
			);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await rm(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"cached documentation paths retain live config, trust and compact-mode instructions",
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "piab-docs-live-config-"));
		try {
			await withPatchedEnv(
				{
					HOME: join(root, "home"),
					PI_AGENT_BROWSER_CONFIG: undefined,
					EXA_API_KEY: undefined,
					BRAVE_API_KEY: undefined,
					AGENT_BROWSER_COMPACT_FALLBACK: undefined,
					AGENT_BROWSER_PLAYBOOK: undefined,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: root });
					const initial = await getBrowserInstructions(harness);
					const groups: Group[] = [];
					harness.events.emit("pi:instruction-groups", {
						register: (group: Group) => groups.push(group),
						isManaged: () => false,
					});
					const group = readDefined(groups[0]);
					const configPath = join(root, ".pi/config/pi-agent-browser-native/config.json");
					await mkdir(dirname(configPath), { recursive: true });
					await writeFile(
						configPath,
						JSON.stringify({ version: 1, browser: { executablePath: "/tmp/changed-browser" } }),
					);
					const updated = await getBrowserInstructions(harness);
					assert.notEqual(updated, initial);
					assert.ok(updated.includes("/tmp/changed-browser"));
					assert.equal(group.instructions(harness.ctx), updated);
					const trust = t.mock.method(harness.ctx, "isProjectTrusted", () => false);
					assert.equal(await getBrowserInstructions(harness), initial);
					assert.equal(group.instructions(harness.ctx), initial);
					process.env.AGENT_BROWSER_COMPACT_FALLBACK = "true";
					const compact = await getBrowserInstructions(harness);
					assert.ok(compact.length < initial.length);
					assert.equal(group.instructions(harness.ctx), initial);
					delete process.env.AGENT_BROWSER_COMPACT_FALLBACK;
					process.env.AGENT_BROWSER_PLAYBOOK = "minimal";
					assert.equal(await getBrowserInstructions(harness), compact);
					assert.equal(group.instructions(harness.ctx), initial);
					delete process.env.AGENT_BROWSER_PLAYBOOK;
					trust.mock.restore();
					assert.equal(await getBrowserInstructions(harness), updated);
					assert.equal(group.instructions(harness.ctx), updated);
				},
			);
		} finally {
			t.mock.restoreAll();
			await rm(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"compact eager fallback bounds prompt size when AGENT_BROWSER_COMPACT_FALLBACK is set",
	async () => {
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
				assert.deepEqual(
					RUNTIME_PROMPT_GUIDELINES.filter((line) => !fallback.includes(line)),
					[],
				);
				assert.deepEqual(
					SHARED_BROWSER_PLAYBOOK_GUIDELINES.filter((line) => fallback.includes(line)),
					[],
				);
				assert.ok(
					fallback.length < 5000,
					`compact fallback must stay bounded: got ${fallback.length}`,
				);
			},
		);
	},
);

nodeTest(
	"full instructions retain trusted config and late web-search guidance without legacy metadata",
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "piab-instructions-"));
		try {
			await withPatchedEnv(
				{
					HOME: join(root, "home"),
					PI_AGENT_BROWSER_CONFIG: undefined,
					EXA_API_KEY: undefined,
					BRAVE_API_KEY: undefined,
					AGENT_BROWSER_COMPACT_FALLBACK: undefined,
					AGENT_BROWSER_PLAYBOOK: undefined,
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
						for (const trusted of [true, false]) {
							await t.test(`project trust: ${trusted}`, async () => {
								const harness = createExtensionHarness({ cwd: root, projectTrusted: trusted });
								// Trusted-session startup owns tool registration before instruction discovery.
								await runExtensionEvent(
									harness.handlers,
									"session_start",
									{ reason: "new" },
									harness.ctx,
								);
								// Read this trust variant's instructions before the next environment-scoped startup.
								const fallback = await getBrowserInstructions(harness);
								const groups: Group[] = [];
								harness.events.emit("pi:instruction-groups", {
									register: (group: Group) => {
										groups.push(group);
									},
									isManaged: () => true,
								});
								const group = readDefined(groups[0]);
								assert.equal(group.instructions(harness.ctx), fallback);
								assert.equal(fallback.includes("/tmp/project-browser"), trusted);
								assert.deepEqual(
									WEB_SEARCH_TOOL_PROMPT_GUIDELINES.filter(
										(line) => fallback.includes(line) !== trusted,
									),
									[],
								);
								assert.equal(
									fallback.includes(
										"Prefer agent_browser_web_search for facts; agent_browser for pages.",
									),
									trusted,
								);
								assert.ok(!fallback.includes("test-only-key"));
							});
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
	},
);
