/**
 * Purpose: Verify extension entrypoint metadata, diagnostics, TUI rendering, and bash-blocking contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";

import { KeyedAsyncExecutionQueue, mergeBrowserRunArtifactManifest } from "../extensions/agent-browser/index.js";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { mergeSessionArtifactManifest } from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import { canonicalizeExplicitArtifactDestination, getExplicitArtifactDestination } from "../extensions/agent-browser/lib/orchestration/browser-run/artifact-paths.js";
import {
	WEB_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	RUNTIME_PROMPT_GUIDELINES,
	buildInstalledDocsGuideline,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
} from "./helpers/agent-browser-harness.js";

import {
	PLAIN_RENDER_THEME,
	createRenderContext,
} from "./helpers/extension-validation-fixtures.js";

test("agentBrowserExtension names its tools in every prompt guideline", () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Inspect a page." });
	assert.ok(harness.tool.promptGuidelines.length > 0);
	for (const guideline of harness.tool.promptGuidelines) {
		assert.match(guideline, /agent_browser/, guideline);
	}
	assert.match(harness.tool.promptGuidelines.find((guideline) => guideline.includes("one input mode")) ?? "", /\bscript\b/);
	const webSearchTool = harness.getTool("agent_browser_web_search");
	if (webSearchTool) {
		for (const guideline of webSearchTool.promptGuidelines) {
			assert.match(guideline, /agent_browser_web_search/, guideline);
		}
	}
});

test("agentBrowserExtension keeps concise browser guidance plus installed doc pointers in tool metadata", async () => {
	const isolatedHome = await mkdtemp(join(tmpdir(), "pi-agent-browser-guidance-test-"));
	await withPatchedEnv({ BRAVE_API_KEY: "demo-key", EXA_API_KEY: undefined, HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		assert.deepEqual([...harness.handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "session_tree", "tool_call", "tool_result"]);
		assert.equal(harness.tool.name, "agent_browser");
		assert.match(harness.tool.description, /authenticated\/profile-based browser work/);
		assert.match(harness.tool.promptSnippet, /real web workflows/);
		const parameterSchema = harness.tool.parameters as { description?: string; properties?: { args?: { description?: string } } };
		assert.match(parameterSchema.description ?? "", /sourceLookup, networkSourceLookup, or electron/);
		assert.match(parameterSchema.properties?.args?.description ?? "", /snapshot -i/);

		const docsGuideline = buildInstalledDocsGuideline({
			readmePath: join(process.cwd(), "README.md"),
			commandReferencePath: join(process.cwd(), "docs", "COMMAND_REFERENCE.md"),
			toolContractPath: join(process.cwd(), "docs", "TOOL_CONTRACT.md"),
		});
		const guidelineText = harness.tool.promptGuidelines.join("\n");
		const webSearchTool = harness.getTool("agent_browser_web_search");
		assert.ok(webSearchTool, "web search tool should register from BRAVE_API_KEY");
		assert.equal(webSearchTool.promptGuidelines.includes(WEB_SEARCH_PROMPT_GUIDELINE), true);
		assert.equal(harness.tool.promptGuidelines.includes("Prefer agent_browser_web_search for facts; agent_browser for pages."), true);
		const requiredGuidelines = [
			docsGuideline,
			...RUNTIME_PROMPT_GUIDELINES,
			TOOL_PROMPT_GUIDELINES_SUFFIX[0],
		];
		for (const guideline of requiredGuidelines) {
			assert.equal(
				harness.tool.promptGuidelines.includes(guideline),
				true,
				`missing concise runtime guideline: ${guideline}`,
			);
		}
		assert.match(guidelineText, /Use agent_browser with one input mode/);
		assert.match(guidelineText, /For agent_browser, use open → snapshot -i/);
		assert.match(guidelineText, /ordinary requested non-destructive submissions may proceed/);
		assert.match(guidelineText, /require explicit authorization for purchases, production-control, destructive\/irreversible, or account\/security\/privacy changes/);
		assert.equal(
			RUNTIME_PROMPT_GUIDELINES.some((line) => line.includes("ordinary requested non-destructive submissions may proceed")),
			true,
		);
		assert.equal(RUNTIME_PROMPT_GUIDELINES.some((line) => line.includes("Stop before order/post/purchase/submit")), false);
		assert.equal(
			SHARED_BROWSER_PLAYBOOK_GUIDELINES.some((line) => line.includes("ordinary non-destructive form submissions within the requested flow may proceed without separate confirmation")),
			true,
		);
		assert.match(guidelineText, /sessionMode=fresh/);
		assert.match(guidelineText, /macOS profile copies may omit encrypted cookies/);
		assert.match(SHARED_BROWSER_PLAYBOOK_GUIDELINES.join("\n"), /copied Chrome profiles may omit encrypted cookies/);
		assert.match(guidelineText, /exact user paths/);
		assert.match(guidelineText, /requested\/configured profiles only/);
		assert.match(guidelineText, /read <url> for docs\/text/);
		assert.match(guidelineText, /Batch 3\+ getters/);
		assert.match(guidelineText, /get text\/html\/value\/count <selector>/);
		assert.match(guidelineText, /get attr <selector> <name>/);
		assert.doesNotMatch(guidelineText, /get title\/url\/text\/html\/value\/attr\/count/);
		assert.match(guidelineText, /never pass --json/);
		assert.match(harness.tool.description, /Input choice:/);
		assert.match(guidelineText, /record stop needs ffmpeg/);
		assert.match(guidelineText, /Dashboards: verify scroll/);
		assert.match(guidelineText, /When agent_browser details\.nextActions exists/);
		assert.equal(harness.tool.promptGuidelines.includes(SHARED_BROWSER_PLAYBOOK_GUIDELINES[12]), false);
		assert.equal(harness.tool.promptGuidelines.includes(QUICK_START_GUIDELINES[0]), false);
		assert.equal(
			SHARED_BROWSER_PLAYBOOK_GUIDELINES.some((line) => line.includes("evidence-only screenshots")),
			true,
		);
		const fullPlaybookText = [...QUICK_START_GUIDELINES, ...SHARED_BROWSER_PLAYBOOK_GUIDELINES].join("\n");
		assert.match(fullPlaybookText, /react inspect <fiberId>/);
		assert.doesNotMatch(fullPlaybookText, /react tree\/inspect\/renders\/suspense/);
		assert.match(fullPlaybookText, /network route <url>/);
		assert.match(fullPlaybookText, /diff screenshot --baseline <file>/);
		assert.doesNotMatch(fullPlaybookText, /diff snapshot\/screenshot\/url/);
		assert.match(fullPlaybookText, /clipboard write <text>/);
		assert.doesNotMatch(fullPlaybookText, /clipboard read\/write\/copy\/paste/);
		assert.ok(harness.tool.promptGuidelines.length <= 10, "promptGuidelines should stay bounded");
		const normalizedGuidelineText = guidelineText.split(process.cwd()).join("<cwd>");
		assert.ok(
			normalizedGuidelineText.length < 1_850,
			"promptGuidelines should point to docs instead of carrying the full command reference/playbook",
		);
		assert.equal(
			WRAPPER_TAB_RECOVERY_BEHAVIOR.some((line) => line.includes("target tab or ref snapshot")),
			true,
		);

		const [genericTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ prompt: "Please review the repository architecture.", systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(genericTurn, undefined);

		const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ prompt: "Open https://example.com and take a snapshot.", systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(typeof browserTurn?.systemPrompt, "string");
		assert.equal(browserTurn?.systemPrompt.includes("Base system prompt"), true);
		assert.equal(browserTurn?.systemPrompt.includes("Project rule: when browser automation is needed"), true);
		assert.equal(browserTurn?.systemPrompt.includes("Quick start:"), false);
		assert.equal(browserTurn?.systemPrompt.includes("Browser operating playbook:"), false);
	});
});

test("built extension prompt doc pointers resolve to package-root docs", { skip: !existsSync(resolve("dist/extensions/agent-browser/index.js")) }, async () => {
	const extension = await import(pathToFileURL(resolve("dist/extensions/agent-browser/index.js")).href);
	const tools: Array<{ name: string; promptGuidelines: string[] }> = [];
	const pi = {
		on: (..._args: unknown[]) => undefined,
		registerTool: (tool: { name: string; promptGuidelines?: string[] }) => tools.push({ name: tool.name, promptGuidelines: tool.promptGuidelines ?? [] }),
	};
	(extension.default as (api: typeof pi) => void)(pi);

	const guideline = tools.find((tool) => tool.name === "agent_browser")?.promptGuidelines.find((line) => line.includes("COMMAND_REFERENCE.md"));
	assert.ok(guideline);
	assert.doesNotMatch(guideline, /\/dist\/docs\//);
	for (const docsPath of [resolve("README.md"), resolve("docs/COMMAND_REFERENCE.md"), resolve("docs/TOOL_CONTRACT.md")]) {
		assert.match(guideline, new RegExp(docsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(existsSync(docsPath), true, `missing docs path ${docsPath}`);
	}
});

test("agentBrowserExtension includes configured browser executable guidance", async () => {
	const isolatedHome = await mkdtemp(join(tmpdir(), "pi-agent-browser-executable-guidance-test-"));
	const configPath = join(isolatedHome, ".pi", "config", "pi-agent-browser-native", "config.json");
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify({
		version: 1,
		browser: {
			executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		},
	}, null, 2), "utf8");
	await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		const guidelineText = harness.tool.promptGuidelines.join("\n");
		assert.match(guidelineText, /browser\.executablePath/);
		assert.match(guidelineText, /--executable-path/);
		assert.match(guidelineText, /profiles command still lists Chrome profiles only/);
	});
});

test("agentBrowserExtension uses project browser launch guidance when project config shadows global", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-project-shadow-guidance-test-"));
	try {
		const cwd = join(root, "repo");
		const isolatedHome = join(root, "home");
		const globalConfigPath = join(isolatedHome, ".pi", "config", "pi-agent-browser-native", "config.json");
		const projectConfigPath = join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
		await mkdir(dirname(globalConfigPath), { recursive: true });
		await mkdir(dirname(projectConfigPath), { recursive: true });
		await writeFile(globalConfigPath, JSON.stringify({
			version: 1,
			browser: {
				defaultProfile: { name: "Global Profile", policy: "authenticated-only" },
				executablePath: "/Applications/Global Browser.app/Contents/MacOS/Global Browser",
			},
		}, null, 2), "utf8");
		await writeFile(projectConfigPath, JSON.stringify({
			version: 1,
			browser: {
				defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
				executablePath: "/tmp/project-browser",
			},
		}, null, 2), "utf8");
		const previousCwd = process.cwd();
		process.chdir(cwd);
		try {
			await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
				const harness = createExtensionHarness({ cwd });
				const staticGuidelineText = harness.tool.promptGuidelines.join("\n");
				assert.doesNotMatch(staticGuidelineText, /Project Profile/);
				assert.doesNotMatch(staticGuidelineText, /\/tmp\/project-browser/);
				assert.match(staticGuidelineText, /Global Profile/);
				const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
					harness.handlers,
					"before_agent_start",
					{ prompt: "Open https://example.com in the signed-in browser.", systemPrompt: "Base system prompt" },
					harness.ctx,
				);
				assert.match(browserTurn?.systemPrompt ?? "", /Project Profile/);
				assert.match(browserTurn?.systemPrompt ?? "", /\/tmp\/project-browser/);
			});
		} finally {
			process.chdir(previousCwd);
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("agentBrowserExtension includes project-local browser launch guidance", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-project-guidance-test-"));
	try {
		const cwd = join(root, "repo");
		const isolatedHome = join(root, "home");
		const configPath = join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
		await mkdir(dirname(configPath), { recursive: true });
		await mkdir(isolatedHome, { recursive: true });
		await writeFile(configPath, JSON.stringify({
			version: 1,
			browser: {
				defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
				executablePath: "/tmp/project-browser",
			},
		}, null, 2), "utf8");
		const previousCwd = process.cwd();
		process.chdir(cwd);
		try {
			await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
				const harness = createExtensionHarness({ cwd });
				const guidelineText = harness.tool.promptGuidelines.join("\n");
				assert.doesNotMatch(guidelineText, /Project Profile/);
				assert.doesNotMatch(guidelineText, /\/tmp\/project-browser/);
				const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
					harness.handlers,
					"before_agent_start",
					{ prompt: "Open https://example.com with the configured browser profile.", systemPrompt: "Base system prompt" },
					harness.ctx,
				);
				assert.match(browserTurn?.systemPrompt ?? "", /Project Profile/);
				assert.match(browserTurn?.systemPrompt ?? "", /\/tmp\/project-browser/);
			});
		} finally {
			process.chdir(previousCwd);
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects unsupported public schema fields", () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	const schema = harness.tool.parameters;

	assert.equal(Check(schema, { args: ["open", "https://example.test/"], unknown: true }), false);
	assert.equal(Check(schema, { semanticAction: { action: "click", locator: "role", role: "button", name: "Open", unknown: true } }), false);
	assert.equal(Check(schema, { sourceLookup: { selector: "main", unknown: true } }), false);
	assert.equal(Check(schema, { networkSourceLookup: { url: "https://example.test/api", unknown: true } }), false);
	assert.equal(Check(schema, { job: { steps: [{ action: "open", url: "https://example.test/" }], unknown: true } }), false);
	assert.equal(Check(schema, { job: { steps: [{ action: "open", url: "https://example.test/", unknown: true }] } }), false);

	assert.equal(Check(schema, { args: ["open", "https://example.test/"], outputPath: "logs/page.json", timeoutMs: 35_000 }), true);
	assert.equal(Check(schema, { args: ["open", "https://example.test/"], outputPath: "" }), false);
	assert.equal(Check(schema, { args: ["open", "https://example.test/"], timeoutMs: 0 }), false);
	assert.equal(Check(schema, { semanticAction: { action: "click", locator: "role", role: "button", name: "Open" } }), true);
	assert.equal(Check(schema, { sourceLookup: { selector: "main" } }), true);
	assert.equal(Check(schema, { networkSourceLookup: { namespace: "review", url: "https://example.test/api" } }), true);
	assert.equal(Check(schema, { job: { steps: [{ action: "open", url: "https://example.test/" }] } }), true);
});

test("agentBrowserExtension rejects unsupported extra press/key args before upstream spawn", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-press-validation-"));
	try {
		const harness = createExtensionHarness({ cwd: tempDir });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

		const topLevel = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["press", "@e1", "Enter"] });
		assert.equal(topLevel.isError, true);
		assert.match(topLevel.content[0]?.text ?? "", /accepts exactly one key argument/);
		assert.equal(topLevel.details?.validationError, topLevel.content[0]?.text);

		const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["fill", "#todo", "alpha"], ["key", "#todo", "Return"]]),
		});
		assert.equal(batch.isError, true);
		assert.match(batch.content[0]?.text ?? "", /Unsupported batch step 2: agent-browser key\/press accepts exactly one key argument/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects duplicate explicit artifact destinations inside one batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-duplicate-artifact-"));
	try {
		assert.equal(
			canonicalizeExplicitArtifactDestination(tempDir, "capture.png", "darwin"),
			canonicalizeExplicitArtifactDestination(tempDir, "CAPTURE.png", "darwin"),
		);
		assert.equal(
			canonicalizeExplicitArtifactDestination(tempDir, "é.png", "darwin"),
			canonicalizeExplicitArtifactDestination(tempDir, "e\u0301.png", "darwin"),
		);
		assert.equal(
			canonicalizeExplicitArtifactDestination(tempDir, "Straße.png", "darwin"),
			canonicalizeExplicitArtifactDestination(tempDir, "STRASSE.png", "darwin"),
		);
		assert.equal(
			canonicalizeExplicitArtifactDestination(tempDir, "Σ.png", "darwin"),
			canonicalizeExplicitArtifactDestination(tempDir, "ς.png", "darwin"),
		);
		assert.equal(getExplicitArtifactDestination(["diff", "screenshot", "--output", "safe.png", "--output", "final.png"]), "final.png");
		assert.equal(getExplicitArtifactDestination(["diff", "screenshot", "--output", "safe.png", "-o", "short.png"]), "short.png");
		assert.equal(getExplicitArtifactDestination(["diff", "screenshot", "-o", "short.png", "--output", "final.png"]), "final.png");
		assert.equal(getExplicitArtifactDestination(["diff", "screenshot", "--output", "danger.png", "--baseline", "-o"]), "danger.png");
		assert.equal(getExplicitArtifactDestination(["network", "har", "start", "ignored.har"]), undefined);
		assert.equal(getExplicitArtifactDestination(["network", "har", "stop", "-capture.har"]), "-capture.har");
		assert.equal(getExplicitArtifactDestination(["wait", "--timeout", "30000", "-d", "capture.csv"]), "capture.csv");
		assert.equal(getExplicitArtifactDestination(["wait", "--timeout", "1", "--timeout", "--download", "capture.csv"]), "capture.csv");
		assert.equal(getExplicitArtifactDestination(["wait", "--download", "capture.csv", "--url", "**/done"]), undefined);
		assert.equal(getExplicitArtifactDestination(["wait", "-d", "capture.csv", "-t", "Ready"]), undefined);
		assert.equal(getExplicitArtifactDestination(["screenshot", "--full=capture.png"]), "--full=capture.png");
		assert.equal(getExplicitArtifactDestination(["screenshot", "main", "capture.png", "ignored.png"]), "capture.png");
		assert.equal(getExplicitArtifactDestination(["screenshot", "--", "capture"]), "capture");
		assert.equal(getExplicitArtifactDestination(["screenshot", "--full", "true", "capture"]), "capture");
		assert.equal(getExplicitArtifactDestination(["screenshot", "dir/file"]), "dir/file");
		assert.equal(getExplicitArtifactDestination(["screenshot", ".dogfood/run/capture.png"]), ".dogfood/run/capture.png");
		assert.equal(getExplicitArtifactDestination(["screenshot", "#card.png"]), undefined);
		assert.equal(getExplicitArtifactDestination(["screenshot", ".card.png"]), undefined);
		assert.equal(getExplicitArtifactDestination(["screenshot", "@e1.png"]), undefined);
		assert.equal(getExplicitArtifactDestination(["screenshot", "capture.PNG"]), undefined);
		await symlink(tempDir, join(tempDir, "alias"), process.platform === "win32" ? "junction" : "dir");
		const harness = createExtensionHarness({ cwd: tempDir });
		const lexicalAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["screenshot", "artifact.png"], ["screenshot", "./artifact.png"]]),
		});
		assert.equal(lexicalAlias.isError, true);
		assert.match(lexicalAlias.content[0]?.text ?? "", /artifact\.png is already written by step 1/);

		const sentinelAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["screenshot", "--", "capture"], ["screenshot", "--", "capture"]]),
		});
		assert.equal(sentinelAlias.isError, true);
		assert.match(sentinelAlias.content[0]?.text ?? "", /capture is already written by step 1/);

		const slashPathAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["screenshot", "dir/file"], ["screenshot", "dir/file"]]),
		});
		assert.equal(slashPathAlias.isError, true);
		assert.match(slashPathAlias.content[0]?.text ?? "", /dir\/file is already written by step 1/);

		const symlinkAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["screenshot", "artifact.png"], ["screenshot", "alias/artifact.png"]]),
		});
		assert.equal(symlinkAlias.isError, true);
		assert.match(symlinkAlias.content[0]?.text ?? "", /alias\/artifact\.png is already written by step 1/);

		if (process.platform !== "win32") {
			await symlink("dangling-target.png", join(tempDir, "dangling-alias.png"));
			const danglingAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "dangling-target.png"], ["screenshot", "dangling-alias.png"]]),
			});
			assert.equal(danglingAlias.isError, true);
			assert.match(danglingAlias.content[0]?.text ?? "", /dangling-alias\.png is already written by step 1/);
		}

		const argumentAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch", "screenshot argument.png", "screenshot ./argument.png"],
		});
		assert.equal(argumentAlias.isError, true);
		assert.match(argumentAlias.content[0]?.text ?? "", /\.\/argument\.png is already written by step 1/);

		if (process.platform !== "android") {
			await writeFile(join(tempDir, "hardlink-a.png"), "existing artifact");
			await link(join(tempDir, "hardlink-a.png"), join(tempDir, "hardlink-b.png"));
			const hardlinkAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "hardlink-a.png"], ["screenshot", "hardlink-b.png"]]),
			});
			assert.equal(hardlinkAlias.isError, true);
			assert.match(hardlinkAlias.content[0]?.text ?? "", /hardlink-b\.png is already written by step 1/);
		}

		if (process.platform === "darwin") {
			const caseAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "case-artifact.png"], ["screenshot", "CASE-ARTIFACT.png"]]),
			});
			assert.equal(caseAlias.isError, true);
			assert.match(caseAlias.content[0]?.text ?? "", /CASE-ARTIFACT\.png is already written by step 1/);
			const unicodeAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "é.png"], ["screenshot", "e\u0301.png"]]),
			});
			assert.equal(unicodeAlias.isError, true);
			assert.match(unicodeAlias.content[0]?.text ?? "", /é\.png is already written by step 1/);
			const fullFoldAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "Straße.png"], ["screenshot", "STRASSE.png"]]),
			});
			assert.equal(fullFoldAlias.isError, true);
			assert.match(fullFoldAlias.content[0]?.text ?? "", /STRASSE\.png is already written by step 1/);
		}

		const recordingAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["record", "start", "capture.webm"], ["record", "restart", "./capture.webm"]]),
		});
		assert.equal(recordingAlias.isError, true);
		assert.match(recordingAlias.content[0]?.text ?? "", /capture\.webm is already written by step 1/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension handles bare wait commands through artifact preflight", { concurrency: false }, async () => {
	assert.equal(getExplicitArtifactDestination(["wait"]), undefined);
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bare-wait-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.find((token) => token === "wait" || token === "batch");
if (command === "batch") { fs.readFileSync(0, "utf8"); process.stdout.write("[]"); }
else process.stdout.write(JSON.stringify({ success: true, data: { waited: true } }));`,
	);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const params of [
				{ args: ["wait"] },
				{ args: ["batch", "wait"] },
				{ args: ["batch"], stdin: JSON.stringify([["wait"]]) },
			]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(result.isError, false);
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports no-op scroll diagnostics with recovery next actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-noop-scroll-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "scroll-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const amount = args[commandIndex + 2];
let state = { moved: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "scroll" && amount === "701") {
  state.moved = true;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
const snapshot = {
  scrollX: 0,
  scrollY: state.moved ? 701 : 0,
  innerHeight: 600,
  innerWidth: 800,
  scrollHeight: 1600,
  scrollWidth: 800,
  containerCount: 1,
  containers: [{ id: "0:main.dashboard", scrollTop: state.moved ? 701 : 0, scrollLeft: 0 }]
};
const data = command === "eval" ? { result: snapshot } : { lifecycle: { launched: false }, scrolled: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check scroll recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const noopResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "700"], sessionMode: "fresh" });
			assert.equal(noopResult.isError, true);
			assert.equal(noopResult.details?.resultCategory, "failure");
			assert.equal(noopResult.details?.failureCategory, "upstream-error");
			assert.match(noopResult.content[0]?.text ?? "", /Scroll diagnostic: no observed scroll movement/);
			assert.match(noopResult.content[0]?.text ?? "", /"scrolled": false/);
			assert.doesNotMatch(noopResult.content[0]?.text ?? "", /lifecycle/);

			assert.doesNotMatch(noopResult.content[0]?.text ?? "", /"scrolled": true/);
			const noopDetails = noopResult.details as {
				data: { noMovement?: boolean; scrolled?: boolean };
				nextActions: Array<{ id: string; params?: { args: string[] } }>;
				pageChangeSummary: { nextActionIds: string[] };
				scrollNoop: { before: { containers: Array<{ id: string }> }; reason: string };
			};
			assert.equal(noopDetails.data.scrolled, false);
			assert.equal(noopDetails.data.noMovement, true);
			assert.equal(noopDetails.scrollNoop.reason, "no-observed-scroll-position-change");
			assert.equal(noopDetails.scrollNoop.before.containers[0]?.id, "sample-0");
			assert.deepEqual(
				noopDetails.nextActions.map((action) => action.id).filter((id) => id.includes("noop-scroll")),
				["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
			);
			const scrollRecoveryActions = noopDetails.nextActions.filter((action) => action.id.includes("noop-scroll"));
			assert.ok(scrollRecoveryActions.every((action) => action.params?.args[0] === "--session"));
			assert.deepEqual(
				noopDetails.pageChangeSummary.nextActionIds.filter((id) => id.includes("noop-scroll")),
				["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
			);

			const movedResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "701"] });
			assert.equal(movedResult.isError, false);
			const movedDetails = movedResult.details as { scrollNoop?: unknown };
			assert.equal(movedDetails.scrollNoop, undefined);
			assert.doesNotMatch(movedResult.content[0]?.text ?? "", /Scroll diagnostic/);

			const evalCallsBeforeLaunchScopedScroll = (await readInvocationLog(logPath)).filter((entry) => entry.args.includes("eval")).length;
			const launchScopedResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--profile", "Default", "scroll", "down", "700"], sessionMode: "fresh" });
			assert.equal(launchScopedResult.isError, false);
			assert.equal((launchScopedResult.details as { scrollNoop?: unknown }).scrollNoop, undefined);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, evalCallsBeforeLaunchScopedScroll);
			assert.ok(invocations.some((entry) => entry.args.includes("--profile") && entry.args.includes("scroll")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension bounds dialog recovery commands and exposes recovery actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-dialog-timeout-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
if (args.includes("dialog") || (args.includes("eval") && stdin.includes("confirm"))) {
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS: "50", PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS: "60" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["dialog", "status"] });
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
			assert.equal(result.details?.timeoutMs, 50);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; sessionMode?: string } }> | undefined;
			assert.ok(nextActions?.some((action) => action.id === "inspect-dialog-after-timeout"));
			assert.ok(nextActions?.some((action) => action.id === "dismiss-dialog-after-timeout"));
			assert.ok(nextActions?.some((action) => action.id === "recover-fresh-session-after-dialog-timeout" && action.params?.sessionMode === "fresh"));

			const explicitTimeoutResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["dialog", "status"], timeoutMs: 75 });
			assert.equal(explicitTimeoutResult.isError, true);
			assert.equal(explicitTimeoutResult.details?.timeoutMs, 75);

			const evalResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["eval", "--stdin"], stdin: "confirm('Continue?')" });
			assert.equal(evalResult.isError, true);
			assert.equal(evalResult.details?.failureCategory, "timeout");
			assert.equal(evalResult.details?.timeoutMs, 60);
			const evalNextActions = evalResult.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.ok(evalNextActions?.some((action) => action.id === "inspect-dialog-after-timeout"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension scrolls explicit CSS containers before falling back to page scroll", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-container-scroll-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes("document.querySelector")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      selector: "#virtualList",
      direction: "down",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 2500, clientHeight: 210, scrollWidth: 400, clientWidth: 400 },
      after: { scrollTop: 168, scrollLeft: 0, scrollHeight: 2500, clientHeight: 210, scrollWidth: 400, clientWidth: 400 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "#virtualList", "down"] });
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Scrolled container #virtualList down/);
			assert.equal((result.details?.data as { status?: string } | undefined)?.status, "scrolled");
			assert.equal((result.details?.scrollContainer as { request?: { selector?: string } } | undefined)?.request?.selector, "#virtualList");
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("scroll")), false);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension handles scroll to end before upstream page scroll", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-page-scroll-end-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes('target = "end"')) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      target: "end",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 },
      after: { scrollTop: 4500, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "to", "end"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Scrolled page to end/);
			assert.equal((result.details?.data as { status?: string } | undefined)?.status, "scrolled");
			assert.equal((result.details?.scrollPage as { request?: { target?: string } } | undefined)?.request?.target, "end");
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("scroll")), false);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension scrolls the document directly before upstream wheel fallback", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-page-scroll-direction-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes('direction = "down"')) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      direction: "down",
      amount: "700",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 },
      after: { scrollTop: 700, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "700"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Scrolled page down by 700/);
			assert.equal((result.details?.data as { status?: string } | undefined)?.status, "scrolled");
			assert.equal(result.details?.exitCode, 0);
			assert.equal((result.details?.scrollPage as { request?: { direction?: string } } | undefined)?.request?.direction, "down");

			const selectorScroll = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "250", "--selector", "#panel"] });
			assert.equal(selectorScroll.isError, false);
			assert.equal((selectorScroll.details?.data as { scrolled?: string } | undefined)?.scrolled, "unexpected-page-scroll");
			const trailingTokenScroll = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "250", "unexpected"] });
			assert.equal(trailingTokenScroll.isError, false);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("scroll")).length, 2);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension filters snapshot refs with wrapper search and role flags", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-filter-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://dense.example/",
    refs: {
      e1: { role: "link", name: "Cart" },
      e2: { role: "button", name: "Checkout" },
      e3: { role: "combobox", name: "Theme" }
    },
    snapshot: ['- link "Cart" [ref=e1]', '- button "Checkout" [ref=e2]', '- combobox "Theme" [ref=e3]'].join('\\n')
  } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--search", "checkout"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Snapshot filter: 1\/3 direct refs matched search "checkout"; 1 surrounding snapshot line shown\./);
			assert.match(result.content[0]?.text ?? "", /Checkout/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Theme/);
			assert.equal((result.details?.snapshotFilter as { search?: string; matchedRefs?: number } | undefined)?.search, "checkout");
			assert.equal((result.details?.snapshotFilter as { matchedRefs?: number } | undefined)?.matchedRefs, 1);
			assert.deepEqual((result.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1", "e2", "e3"]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--search")), false);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot") && entry.args.includes("-i")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces rendered text missing from the accessibility snapshot", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-rendered-search-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://app.example/settings",
    refs: { e1: { role: "button", name: "Save" }, e2: { role: "button", name: "Add Channel" } },
    snapshot: '- button "Save" [ref=e1]'
  } }));
  return;
}
if (args.includes("eval")) {
  const source = fs.readFileSync(0, "utf8");
  const result = source.includes("does not match")
    ? { matches: [{ kind: "validation", offscreen: true, role: "alert", tagName: "div", text: "This destination does not match any configured notification channel." }], totalMatches: 1, truncated: false }
    : { matches: [{ kind: "text", name: "Add Channel", offscreen: false, tagName: "button", text: "Add Channel" }], totalMatches: 1, truncated: false };
  process.stdout.write(JSON.stringify({ success: true, data: { result } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const warning = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--search", "does not match"] });
			assert.equal(warning.isError, false, JSON.stringify(warning));
			assert.match(warning.content[0]?.text ?? "", /Rendered page text matches:/);
			assert.match(warning.content[0]?.text ?? "", /does not match any configured notification channel/);
			assert.match(warning.content[0]?.text ?? "", /validation, outside viewport, alert, div/);
			const warningFilter = warning.details?.snapshotFilter as { matchedRefs?: number; renderedTextMatches?: Array<{ kind?: string; offscreen?: boolean }> } | undefined;
			assert.equal(warningFilter?.matchedRefs, 0);
			assert.deepEqual(warningFilter?.renderedTextMatches, [{ kind: "validation", offscreen: true, role: "alert", tagName: "div", text: "This destination does not match any configured notification channel." }]);

			const label = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--search", "Add Channel"] });
			assert.equal(label.isError, false, JSON.stringify(label));
			assert.match(label.content[0]?.text ?? "", /Add Channel.*button, @e2/);
			const labelMatches = (label.details?.snapshotFilter as { renderedTextMatches?: Array<{ ref?: string }> } | undefined)?.renderedTextMatches;
			assert.equal(labelMatches?.[0]?.ref, "e2");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports wrapper snapshot diffs against previous refs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-diff-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const prior = fs.existsSync(${JSON.stringify(logPath)}) ? fs.readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  const first = prior === 0;
  const data = first
    ? { origin: "https://dense.example/", refs: { e1: { role: "link", name: "Cart" }, e2: { role: "button", name: "Checkout" } }, snapshot: ['- link "Cart" [ref=e1]', '- button "Checkout" [ref=e2]'].join('\\n') }
    : { origin: "https://dense.example/", refs: { e1: { role: "link", name: "Basket" }, e3: { role: "button", name: "Pay" } }, snapshot: ['- link "Basket" [ref=e1]', '- button "Pay" [ref=e3]'].join('\\n') };
  process.stdout.write(JSON.stringify({ success: true, data }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const first = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--search", "Cart"] });
			assert.equal(first.isError, false, JSON.stringify(first));
			const second = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--diff"] });
			assert.equal(second.isError, false, JSON.stringify(second));
			assert.match(second.content[0]?.text ?? "", /Snapshot diff: \+1 \/ -1 \/ Δ1 refs/);
			const diff = second.details?.snapshotDiff as { addedRefs?: string[]; changedRefs?: string[]; removedRefs?: string[] } | undefined;
			assert.deepEqual(diff?.addedRefs, ["e3"]);
			assert.deepEqual(diff?.changedRefs, ["e1"]);
			assert.deepEqual(diff?.removedRefs, ["e2"]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--diff")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports wrapper snapshot viewport metadata", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-viewport-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { scrollX: 0, scrollY: 240, innerHeight: 900, innerWidth: 1440, scrollHeight: 3000, scrollWidth: 1440, containerCount: 1, containers: [{ id: "0:main", scrollTop: 12, scrollLeft: 0 }] } } }));
  return;
}
if (args.includes("snapshot")) {
  const refs = Object.fromEntries(Array.from({ length: 90 }, (_, index) => ["e" + (index + 1), { role: "button", name: "Checkout " + (index + 1) }]));
  const snapshot = Array.from({ length: 90 }, (_, index) => '- button "Checkout ' + (index + 1) + '" [ref=e' + (index + 1) + ']').join('\\n');
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://dense.example/", refs, snapshot } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--viewport"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Viewport: 1440×900, scroll 0,240/);
			const viewport = result.details?.snapshotViewport as { innerHeight?: number; scrollY?: number } | undefined;
			assert.equal(viewport?.innerHeight, 900);
			assert.equal(viewport?.scrollY, 240);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			assert.equal((result.details?.artifactManifest as { entries?: unknown[] } | undefined)?.entries?.length, 1);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--viewport")), false);
			assert.ok(invocations.some((entry) => entry.args.includes("eval") && entry.args.includes("--stdin")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension filters network requests to the current page origin", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-filter-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://shop.example/products" } }));
  return;
}
if (args.includes("network") && args.includes("requests")) {
  process.stdout.write(JSON.stringify({ success: true, data: { requests: [
    { id: "1", method: "GET", status: 200, url: "https://shop.example/app.js" },
    { id: "2", method: "GET", status: 200, url: "https://cdn.example/lib.js" },
    { id: "3", method: "POST", status: 500, url: "https://shop.example/api/cart" }
  ] } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "review", "network", "requests", "--current-page"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /2\/3 rows matched/);
			assert.match(result.content[0]?.text ?? "", /shop\.example\/app\.js/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /cdn\.example/);
			assert.equal(result.details?.namespace, "review");
			const filter = result.details?.networkRequestsPageFilter as { matchedRows?: number; totalRows?: number } | undefined;
			assert.equal(filter?.matchedRows, 2);
			assert.equal(filter?.totalRows, 3);
			const data = result.details?.data as { requests?: Array<{ url?: string }> } | undefined;
			assert.deepEqual(data?.requests?.map((request) => request.url), ["https://shop.example/app.js", "https://shop.example/api/cart"]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--current-page")), false);
			assert.ok(invocations.every((entry) => entry.args.includes("--namespace") && entry.args.includes("review")));
			assert.ok(invocations.some((entry) => entry.args.includes("network") && entry.args.includes("requests")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports focused combobox diagnostics with option-opening next actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-focus-"));
	const statePath = join(tempDir, "combobox-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const target = args[commandIndex + 1];
const value = args[commandIndex + 2];
const action = args[commandIndex + 3];
const nameIndex = args.indexOf("--name");
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "find" && target === "role" && value === "combobox" && action === "click") {
  state.mode = name === "MissingExpanded" ? "combo-missing" : name === "Open" ? "combo-open" : name === "OptionsVisible" ? "combo-options" : "combo";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else if (command === "click") {
  state.mode = "textbox";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
let result = { ok: true, command, target };
if (command === "eval") {
  result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "Datasource", tagName: "input" } }
    : state.mode === "combo-missing"
      ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", hasPopup: "listbox", name: "MissingExpanded", tagName: "input" } }
      : state.mode === "combo-open"
        ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Open", tagName: "input" } }
        : state.mode === "combo-options"
          ? { comboboxLike: true, visibleListboxCount: 1, visibleOptionCount: 2, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "OptionsVisible", tagName: "input" } }
          : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Search", tagName: "input" } };
}
process.stdout.write(JSON.stringify({ success: true, data: command === "eval" ? { result } : result }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check combobox recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const comboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name: "Datasource" }, sessionMode: "fresh" });
			assert.equal(comboboxResult.isError, false);
			assert.match(comboboxResult.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			const details = comboboxResult.details as {
				comboboxFocus: { reason: string; activeElement: { name?: string; role?: string } };
				nextActions: Array<{ id: string; params?: { args: string[] } }>;
			};
			assert.equal(details.comboboxFocus.reason, "focused-combobox-without-visible-options");
			assert.equal(details.comboboxFocus.activeElement.role, "combobox");
			assert.equal(details.comboboxFocus.activeElement.name, "Datasource");
			const comboboxActionIds = details.nextActions.map((action) => action.id).filter((id) => id.includes("combobox"));
			assert.deepEqual(comboboxActionIds, ["inspect-focused-combobox", "try-open-combobox-with-arrow", "try-open-combobox-with-enter"]);
			assert.ok(details.nextActions.filter((action) => action.id.includes("combobox")).every((action) => action.params?.args[0] === "--session"));
			const openComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name: "Open" } });
			assert.equal(openComboboxResult.isError, false);
			assert.match(openComboboxResult.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			assert.equal((openComboboxResult.details as { comboboxFocus?: { activeElement?: { name?: string; expanded?: string } } }).comboboxFocus?.activeElement?.name, "Open");
			assert.equal((openComboboxResult.details as { comboboxFocus?: { activeElement?: { name?: string; expanded?: string } } }).comboboxFocus?.activeElement?.expanded, "true");

			for (const name of ["MissingExpanded", "OptionsVisible"]) {
				const negativeComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name } });
				assert.equal(negativeComboboxResult.isError, false, name);
				assert.equal((negativeComboboxResult.details as { comboboxFocus?: unknown }).comboboxFocus, undefined, name);
				assert.doesNotMatch(negativeComboboxResult.content[0]?.text ?? "", /Combobox diagnostic/, name);
			}

			const textboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@text"] });
			assert.equal(textboxResult.isError, false);
			assert.equal((textboxResult.details as { comboboxFocus?: unknown }).comboboxFocus, undefined);
			assert.doesNotMatch(textboxResult.content[0]?.text ?? "", /Combobox diagnostic/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves combobox diagnostics after semanticAction visible-ref resolution", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-visible-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "combobox-visible-ref-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "open") {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana", url: "https://grafana.example.test/" } }));
} else if (command === "snapshot") {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://grafana.example.test/",
    refs: { e65: { role: "combobox", name: "Job" } },
    snapshot: '- combobox "Job" [ref=e65]'
  } }));
} else if (command === "click") {
  state.mode = args[commandIndex + 1] === "@e65" ? "combo" : "other";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[commandIndex + 1] } }));
} else if (command === "eval") {
  const result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Job", tagName: "input" } }
    : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Other", tagName: "input" } };
  process.stdout.write(JSON.stringify({ success: true, data: { result } }));
} else if (command === "get" && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana" } }));
} else if (command === "get" && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://grafana.example.test/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check visible-ref combobox recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://grafana.example.test/"] });
			assert.equal(open.isError, false);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "combobox", name: "Job" },
			});
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["click", "@e65"]);
			assert.equal((result.details?.comboboxFocus as { activeElement?: { role?: string; name?: string } } | undefined)?.activeElement?.role, "combobox");
			assert.equal((result.details?.comboboxFocus as { activeElement?: { role?: string; name?: string } } | undefined)?.activeElement?.name, "Job");
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e65"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("KeyedAsyncExecutionQueue drains same-namespace work without deadlocking late arrivals", async () => {
	const queue = new KeyedAsyncExecutionQueue();
	const key = getAgentBrowserSessionIdentityKey("shared", "team");
	const events: string[] = [];
	let releaseActive!: () => void;
	let markActive!: () => void;
	const active = new Promise<void>((resolve) => {
		markActive = resolve;
	});
	const holdActive = new Promise<void>((resolve) => {
		releaseActive = resolve;
	});
	const first = queue.run(key, "team", async () => {
		events.push("first-start");
		markActive();
		await holdActive;
		events.push("first-end");
	});
	await active;
	const exclusive = queue.runExclusive("team", async () => {
		events.push("exclusive");
	});
	const late = queue.run(key, "team", async () => {
		events.push("late");
	});
	releaseActive();
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			Promise.all([first, exclusive, late]),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("namespace-exclusive queue deadlocked")), 1_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
	assert.deepEqual(events, ["first-start", "first-end", "exclusive", "late"]);
});

test("mergeBrowserRunArtifactManifest preserves restart lifecycle order across a concurrent manifest update", () => {
	const initial = mergeSessionArtifactManifest({
		entries: [{ command: "screenshot", createdAtMs: 1, kind: "image", path: "initial.png", retentionState: "live", storageScope: "explicit-path" }],
		nowMs: 1,
	});
	assert.ok(initial);
	const updated = mergeSessionArtifactManifest({
		base: initial,
		entries: [
			{ command: "record", createdAtMs: 2, kind: "video", path: "z-previous.webm", retentionState: "live", session: "shared", storageScope: "explicit-path", subcommand: "restart-previous" },
			{ command: "record", createdAtMs: 2, kind: "video", path: "a-current.webm", retentionState: "live", session: "shared", storageScope: "explicit-path", subcommand: "restart" },
		],
		nowMs: 2,
	});
	const current = mergeSessionArtifactManifest({
		base: initial,
		entries: [{ command: "screenshot", createdAtMs: 3, kind: "image", path: "concurrent.png", retentionState: "live", storageScope: "explicit-path" }],
		nowMs: 3,
	});
	const merged = mergeBrowserRunArtifactManifest(current, initial, updated);
	assert.equal(merged?.entries.some((entry) => entry.path === "z-previous.webm" && entry.subcommand === "restart-previous"), true);
	assert.equal(merged?.entries.some((entry) => entry.path === "a-current.webm" && entry.subcommand === "restart"), true);
	assert.equal(merged?.entries.some((entry) => entry.path === "concurrent.png"), true);
});

test("mergeSessionArtifactManifest retains the active restart when the recent window is one", { concurrency: false }, async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "1" }, async () => {
		const manifest = mergeSessionArtifactManifest({
			entries: [
				{ command: "record", createdAtMs: 1, kind: "video", path: "a-previous.webm", retentionState: "live", session: "shared", storageScope: "explicit-path", subcommand: "restart-previous" },
				{ command: "record", createdAtMs: 1, kind: "video", path: "z-current.webm", retentionState: "live", session: "shared", storageScope: "explicit-path", subcommand: "restart" },
			],
			nowMs: 1,
		});
		assert.deepEqual(manifest?.entries.map((entry) => [entry.path, entry.subcommand]), [["z-current.webm", "restart"]]);
	});
});

test("agentBrowserExtension keeps a direct restart pending through outer manifest merge and replay", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restart-manifest-"));
	const nodeBinDir = dirname(process.execPath);
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const path = args[commandIndex + 2];
if (command === "record" && subcommand === "restart") fs.writeFileSync(${JSON.stringify(join(tempDir, "z-previous.webm"))}, "finished recording");
const data = command === "get" && subcommand === "url"
  ? { result: "https://safe.example/", url: "https://safe.example/" }
  : { command, path, subcommand };
process.stdout.write(JSON.stringify({ success: true, data }));`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${nodeBinDir}` }, async () => {
			const sessionName = "restart-session";
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Restart a browser recording." });
			const started = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", sessionName, "record", "start", "z-previous.webm"] });
			assert.equal(started.isError, false, started.content[0]?.text);
			const restarted = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", sessionName, "record", "restart", "a-current.webm"] });
			assert.equal(restarted.isError, false, restarted.content[0]?.text);
			const manifest = restarted.details?.artifactManifest as { entries?: Array<{ path?: string; subcommand?: string }> } | undefined;
			assert.equal(manifest?.entries?.some((entry) => entry.path === "z-previous.webm" && entry.subcommand === "restart-previous"), true);
			assert.equal(manifest?.entries?.some((entry) => entry.path === "a-current.webm" && entry.subcommand === "restart"), true);

			const replayHarness = createExtensionHarness({
				branch: [{ type: "message", message: { details: restarted.details, isError: restarted.isError, toolName: "agent_browser" } }],
				cwd: tempDir,
			});
			await runExtensionEvent(replayHarness.handlers, "session_start", { reason: "resume" }, replayHarness.ctx);
			const reservedAfterReplay = await executeRegisteredTool(replayHarness.tool, replayHarness.ctx, { args: ["pdf", "a-current.webm"] });
			assert.equal(reservedAfterReplay.isError, true);
			assert.match(reservedAfterReplay.content[0]?.text ?? "", /a-current\.webm is reserved by an active recording/);
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", sessionName, "close"] });
			await executeRegisteredTool(replayHarness.tool, replayHarness.ctx, { args: ["--session", sessionName, "close"] });
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension makes close --all exclusive within its namespace", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-close-all-queue-"));
	const logPath = join(tempDir, "events.log");
	const nodeBinDir = dirname(process.execPath);
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--allow-file-access", "--args", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const commandArgs = args.slice(commandIndex);
const command = commandArgs[0];
const namespaceIndex = args.indexOf("--namespace");
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : "default";
const writeEvent = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, event + "\\n");
const output = () => process.stdout.write(JSON.stringify({ success: true, data: command === "get" ? { url: "https://safe.example/" } : command === "tab" ? { tabs: [] } : { url: "https://safe.example/" } }));
if (command === "close" && commandArgs.includes("--all")) {
  writeEvent("close-start");
  setTimeout(() => { writeEvent("close-end"); output(); }, 150);
} else {
  writeEvent(namespace + ":" + command + "-start");
  output();
}`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${nodeBinDir}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise global close ordering." });
			const first = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://safe.example/"] });
			assert.equal(first.isError, false, first.content[0]?.text);
			await writeFile(logPath, "");

			const closeAll = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "caller-owned", "close", "--all"] });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			const otherNamespace = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "other", "--session", "other-session", "tab", "list"] });
			const overlappingCaller = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "same-namespace", "tab", "list"] });
			const overlappingManaged = executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			const [closeResult, otherResult, callerResult, overlapResult] = await Promise.all([closeAll, otherNamespace, overlappingCaller, overlappingManaged]);
			assert.equal(closeResult.details?.closeAllApplied, true);
			assert.equal(otherResult.isError, false, otherResult.content[0]?.text);
			assert.equal(callerResult.isError, false, callerResult.content[0]?.text);
			assert.equal(overlapResult.isError, false, overlapResult.content[0]?.text);
			const events = (await readFile(logPath, "utf8")).trim().split("\n");
			assert.ok(events.indexOf("other:tab-start") < events.indexOf("close-end"), events.join(","));
			assert.ok(events.indexOf("close-end") < events.indexOf("default:tab-start"), events.join(","));
			assert.ok(events.indexOf("close-end") < events.indexOf("default:get-start"), events.join(","));
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns after record start when ffmpeg is missing", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-ffmpeg-"));
	const noRecordingMarker = join(tempDir, "no-recording");
	const nodeBinDir = dirname(process.execPath);
	const missingFfmpegPath = process.platform === "android" ? join(tempDir, "node-only") : nodeBinDir;
	if (process.platform === "android") {
		await mkdir(missingFfmpegPath);
		await symlink(process.execPath, join(missingFfmpegPath, "node"), "file");
	}
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const commandArgs = args.slice(commandIndex).filter((token) => token !== "--json" && token !== "--quiet");
const command = commandArgs[0];
const subcommand = commandArgs[1];
const path = command === "pdf" ? commandArgs[1] : commandArgs[2];
if (command === "record" && subcommand === "stop" && fs.existsSync(${JSON.stringify(noRecordingMarker)})) {
  process.stdout.write(JSON.stringify({ success: false, error: "No recording in progress" }));
  process.exit(1);
}
if (command === "find") {
  process.stdout.write(JSON.stringify({ success: false, error: "No element found by text 'Missing Control'" }));
  process.exit(1);
}
const batchInput = command === "batch" ? fs.readFileSync(0, "utf8") : "";
const batchSteps = batchInput
  ? JSON.parse(batchInput)
  : commandArgs.slice(1).filter((value) => value !== "--bail" && !value.startsWith("--bail=")).map((value) => value.split(" "));
const closeStepIndex = batchSteps.findIndex((step) => step[0] === "close");
const postCloseStopIndex = batchSteps.findIndex((step, index) => index > closeStepIndex && step[0] === "record" && step[1] === "stop");
const postCloseStopPath = ${JSON.stringify(join(tempDir, "post-close-stop.webm"))};
if (postCloseStopIndex >= 0 && !fs.existsSync(${JSON.stringify(noRecordingMarker)})) fs.writeFileSync(postCloseStopPath, "recording");
const firstCallFailure = command === "batch" && batchSteps.some((step) => step[0] === "click" && step[1] === "#missing-after-close");
const data = command === "batch"
  ? batchSteps.map((step, index) => step[0] === "click" && step[1] === "#missing-after-close"
    ? { command: step, success: false, error: "Element not found after browser launch" }
    : step[0] === "open" && step[1] === "fail-after-close"
      ? { command: step, success: false, error: "Navigation failed after browser launch", result: { lifecycle: { effectiveLaunch: { browserLaunched: true } } } }
    : step[0] === "record" && step[1] === "stop" && fs.existsSync(${JSON.stringify(noRecordingMarker)})
      ? { command: step, success: false, error: "No recording in progress" }
      : { command: step, success: true, result: {
      command: step[0],
      path: index === postCloseStopIndex ? postCloseStopPath : step[2],
      subcommand: step[1],
        ...(index === postCloseStopIndex
          ? { lifecycle: { effectiveLaunch: { browserLaunched: true } } }
          : step[0] === "stream" && step[1] === "status"
            ? { lifecycle: { effectiveLaunch: { browserLaunched: false } } }
            : {}),
      } })
  : command === "get" && subcommand === "url"
    ? { command, subcommand, url: "https://safe.example/" }
    : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: !firstCallFailure, data }));
if (firstCallFailure) process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${missingFfmpegPath}`, PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "1" }, async () => {
			const firstCallHarness = createExtensionHarness({ cwd: tempDir, prompt: "Test failed post-close launch ownership.", sessionFile: join(tempDir, "first-call-session.jsonl") });
			const failedFirstCall = await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["close"], ["click", "#missing-after-close"]]),
			});
			assert.equal(failedFirstCall.isError, true, failedFirstCall.content[0]?.text);
			assert.equal((failedFirstCall.details?.managedSessionOutcome as { activeAfter?: boolean } | undefined)?.activeAfter, true);
			assert.equal(typeof failedFirstCall.details?.sessionName, "string");
			const recoveredFirstCall = await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, { args: ["get", "url"] });
			assert.equal(recoveredFirstCall.isError, false, recoveredFirstCall.content[0]?.text);
			assert.equal(recoveredFirstCall.details?.sessionName, failedFirstCall.details?.sessionName);
			const closeAllFirstCall = await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, { args: ["--session", "caller-owned", "close", "--all"] });
			assert.equal(closeAllFirstCall.details?.closeAllApplied, true);
			assert.equal((closeAllFirstCall.details?.managedSessionOutcome as { activeAfter?: boolean } | undefined)?.activeAfter, false);
			const rotatedAfterCloseAll = await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, { args: ["get", "url"] });
			assert.notEqual(rotatedAfterCloseAll.details?.sessionName, failedFirstCall.details?.sessionName);
			await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, { args: ["close"] });

			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Record a browser workflow.", sessionFile: join(tempDir, "session.jsonl") });
			await mkdir(join(tempDir, "ffmpeg"));
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "global-one", "record", "start", "global-one.webm"] });
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "global-two", "record", "start", "global-two.webm"] });
			const otherNamespaceRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "other", "--session", "global-three", "record", "start", "global-three.webm"] });
			assert.equal(otherNamespaceRecording.isError, false, otherNamespaceRecording.content[0]?.text);
			assert.equal(otherNamespaceRecording.details?.namespace, "other");
			const globalClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close", "--all"] });
			assert.equal(globalClose.details?.closeAllApplied, true);
			assert.equal(globalClose.details?.namespace, undefined);
			const releasedGlobalOne = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "global-one.webm"] });
			const releasedGlobalTwo = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "global-two.webm"] });
			assert.doesNotMatch(releasedGlobalOne.content[0]?.text ?? "", /reserved by an active recording/);
			assert.doesNotMatch(releasedGlobalTwo.content[0]?.text ?? "", /reserved by an active recording/);
			const retainedOtherNamespace = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "global-three.webm"] });
			assert.match(retainedOtherNamespace.content[0]?.text ?? "", /reserved by an active recording/);
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "other", "close", "--all"] });

			const missingResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "--quiet", "start", "demo.webm"] });
			assert.equal(missingResult.isError, false);
			assert.equal(missingResult.details?.successCategory, "artifact-pending");
			assert.deepEqual(
				(missingResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.find((action) => action.id === "stop-pending-recording")?.params?.args?.slice(-2),
				["record", "stop"],
			);
			assert.match(missingResult.content[0]?.text ?? "", /Recording dependency warning: ffmpeg not found on PATH/);
			assert.match(missingResult.content[0]?.text ?? "", /Exists: pending until record stop/);
			assert.match(missingResult.content[0]?.text ?? "", /Status: pending/);
			assert.doesNotMatch(missingResult.content[0]?.text ?? "", /Status: missing/);
			const missingArtifacts = missingResult.details?.artifacts as Array<{ exists?: boolean; recordingState?: string; status?: string; willExistOnStop?: boolean }> | undefined;
			assert.equal(missingArtifacts?.[0]?.exists, undefined);
			assert.equal(missingArtifacts?.[0]?.status, "pending");
			assert.equal(missingArtifacts?.[0]?.recordingState, "openRecording");
			assert.equal(missingArtifacts?.[0]?.willExistOnStop, true);
			const missingVerification = missingResult.details?.artifactVerification as { artifacts?: Array<{ recordingState?: string; state?: string; status?: string; willExistOnStop?: boolean }>; missingCount?: number; pendingCount?: number } | undefined;
			assert.equal(missingVerification?.pendingCount, 1);
			assert.equal(missingVerification?.missingCount, 0);
			assert.equal(missingVerification?.artifacts?.[0]?.state, "pending");
			assert.equal(missingVerification?.artifacts?.[0]?.status, "pending");
			assert.equal(missingVerification?.artifacts?.[0]?.willExistOnStop, true);
			const failedWhileRecording = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "text", value: "Missing Control" } });
			assert.equal(failedWhileRecording.isError, true);
			assert.equal(failedWhileRecording.details?.failureCategory, "selector-not-found");
			const stopAfterFailure = (failedWhileRecording.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.find((action) => action.id === "stop-pending-recording");
			assert.deepEqual(stopAfterFailure?.params?.args, ["--session", missingResult.details?.sessionName, "record", "stop"]);
			assert.match(failedWhileRecording.content[0]?.text ?? "", /active recording remains open.*stop-pending-recording/is);
			const noise = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "noise.pdf"] });
			assert.equal(noise.isError, true);
			const reservedExtraPositionalScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", "main", "demo.webm", "ignored.png"] });
			assert.equal(reservedExtraPositionalScreenshot.isError, true);
			assert.match(reservedExtraPositionalScreenshot.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			if (process.platform !== "win32") {
				await symlink("demo.webm", join(tempDir, "--full=demo.png"));
				const reservedEqualsScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", "--full=demo.png"] });
				assert.equal(reservedEqualsScreenshot.isError, true);
				assert.match(reservedEqualsScreenshot.content[0]?.text ?? "", /--full=demo\.png is reserved by an active recording/);
			}
			const reservedGlobalPdf = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "--json", "demo.webm"] });
			assert.equal(reservedGlobalPdf.isError, true);
			assert.match(reservedGlobalPdf.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedQuickPdf = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "--quick", "demo.webm"] });
			assert.equal(reservedQuickPdf.isError, true);
			assert.match(reservedQuickPdf.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const noiseManifest = noise.details?.artifactManifest as { entries?: Array<{ subcommand?: string }> } | undefined;
			assert.equal(noiseManifest?.entries?.some((entry) => entry.subcommand === "start"), false);
			const reservedOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"], outputPath: "demo.webm" });
			assert.equal(reservedOutputPath.isError, true);
			assert.match(reservedOutputPath.content[0]?.text ?? "", /Unsupported outputPath: demo\.webm is reserved by an active recording/);
			const reservedAtOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"], outputPath: "@demo.webm" });
			assert.equal(reservedAtOutputPath.isError, true);
			assert.match(reservedAtOutputPath.content[0]?.text ?? "", /@demo\.webm is reserved by an active recording/);
			const reservedScriptOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, { script: "emit({ ok: true });", outputPath: "demo.webm" });
			assert.equal(reservedScriptOutputPath.isError, true);
			assert.match(reservedScriptOutputPath.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedElectronOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", all: true }, outputPath: "demo.webm" });
			assert.equal(reservedElectronOutputPath.isError, true);
			assert.match(reservedElectronOutputPath.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedWaitDownload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["wait", "--download", "demo.webm"] });
			assert.equal(reservedWaitDownload.isError, true);
			assert.match(reservedWaitDownload.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedShortWaitDownload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["wait", "-d", "demo.webm"] });
			assert.equal(reservedShortWaitDownload.isError, true);
			assert.match(reservedShortWaitDownload.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedReorderedWaitDownload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["wait", "--timeout", "30000", "--download", "demo.webm"] });
			assert.equal(reservedReorderedWaitDownload.isError, true);
			assert.match(reservedReorderedWaitDownload.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedRepeatedTimeoutDownload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["wait", "--timeout", "1", "--timeout", "--download", "demo.webm"] });
			assert.equal(reservedRepeatedTimeoutDownload.isError, true);
			assert.match(reservedRepeatedTimeoutDownload.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const unsupportedInlineWaitDownload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["wait", "--download=demo.webm"] });
			assert.equal(unsupportedInlineWaitDownload.isError, true);
			assert.match(unsupportedInlineWaitDownload.content[0]?.text ?? "", /does not support `wait --download=<path>`/);
			const reservedLastOutput = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["diff", "screenshot", "--output", "safe.png", "--output", "demo.webm"] });
			assert.equal(reservedLastOutput.isError, true);
			assert.match(reservedLastOutput.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedShortOutput = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["diff", "screenshot", "--output", "safe.png", "-o", "demo.webm"] });
			assert.equal(reservedShortOutput.isError, true);
			assert.match(reservedShortOutput.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const reservedHarStop = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["network", "har", "stop", "demo.webm"] });
			assert.equal(reservedHarStop.isError, true);
			assert.match(reservedHarStop.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);
			const sameCallOutput = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "same-call.webm"], outputPath: "same-call.webm" });
			assert.equal(sameCallOutput.isError, true);
			assert.match(sameCallOutput.content[0]?.text ?? "", /same destination as artifact path same-call\.webm/);
			if (process.platform !== "win32") {
				await symlink("same-call-alias-target.webm", join(tempDir, "same-call-output.json"));
				const danglingSameCallOutput = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "same-call-alias-target.webm"], outputPath: "same-call-output.json" });
				assert.equal(danglingSameCallOutput.isError, true);
				assert.match(danglingSameCallOutput.content[0]?.text ?? "", /same destination as artifact path same-call-alias-target\.webm/);
				await rm(join(tempDir, "same-call-output.json"), { force: true });
			}
			if (process.platform !== "win32") {
				await symlink("demo.webm", join(tempDir, "demo.png"));
				const screenshotAlias = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", "demo.png"] });
				assert.equal(screenshotAlias.isError, true);
				assert.match(screenshotAlias.content[0]?.text ?? "", /demo\.png is reserved by an active recording/);
			}
			const restartSamePath = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "restart", "demo.webm"] });
			assert.equal(restartSamePath.isError, true);
			assert.match(restartSamePath.content[0]?.text ?? "", /demo\.webm is reserved by an active recording/);

			const missingDetails = missingResult.details as { recordingDependencyWarning?: { reason?: string; command?: string; dependency?: string } };
			assert.deepEqual(missingDetails.recordingDependencyWarning, {
				command: "record start",
				dependency: "ffmpeg",
				message: "record start can begin recording, but record stop needs ffmpeg on PATH to encode the WebM output.",
				reason: "ffmpeg-missing-for-recording",
				recommendations: [
					"Install ffmpeg before relying on this recording workflow; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.",
					"If ffmpeg was just installed, restart pi or ensure the PATH visible to pi includes the ffmpeg binary before running record stop.",
				],
			});

			if (process.platform !== "win32") await symlink("demo.webm", join(tempDir, "demo.webm"));
			const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(closed.isError, false);
			if (process.platform !== "win32") await rm(join(tempDir, "demo.webm"), { force: true });
			const closedManifest = closed.details?.artifactManifest as { entries?: Array<{ subcommand?: string }> } | undefined;
			assert.equal(closedManifest?.entries?.some((entry) => entry.subcommand === "start" || entry.subcommand === "restart"), false);

			const batchRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "batch-close.webm"] });
			assert.equal(batchRecording.isError, false);
			const batchClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["close"]]) });
			assert.equal(batchClose.isError, false, batchClose.content[0]?.text);
			const releasedAfterBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "batch-close.webm"] });
			assert.doesNotMatch(releasedAfterBatchClose.content[0]?.text ?? "", /reserved by an active recording/);
			assert.notEqual(releasedAfterBatchClose.details?.sessionName, batchRecording.details?.sessionName);
			const diagnosticBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "batch-close-stream.webm"] });
			assert.equal(diagnosticBatchRecording.isError, false);
			const terminalDiagnosticClose = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["close"], ["stream", "status"]]),
			});
			assert.equal(terminalDiagnosticClose.isError, false, terminalDiagnosticClose.content[0]?.text);
			assert.equal((terminalDiagnosticClose.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.activeAfter, false);
			assert.equal((terminalDiagnosticClose.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.status, "closed");
			const releasedAfterDiagnosticClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "batch-close-stream.webm"] });
			assert.doesNotMatch(releasedAfterDiagnosticClose.content[0]?.text ?? "", /reserved by an active recording/);
			assert.notEqual(releasedAfterDiagnosticClose.details?.sessionName, diagnosticBatchRecording.details?.sessionName);
			const postCloseStop = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["close"], ["record", "stop"]]),
			});
			assert.equal(postCloseStop.isError, false, postCloseStop.content[0]?.text);
			assert.equal((postCloseStop.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.activeAfter, true);
			assert.equal((postCloseStop.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.status, "unchanged");
			assert.equal(postCloseStop.details?.sessionName, releasedAfterDiagnosticClose.details?.sessionName);
			const failedPostCloseLaunch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["close"], ["open", "fail-after-close"]]),
			});
			assert.equal(failedPostCloseLaunch.isError, true, failedPostCloseLaunch.content[0]?.text);
			assert.equal((failedPostCloseLaunch.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.activeAfter, true);
			assert.equal((failedPostCloseLaunch.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.status, "unchanged");
			assert.equal(failedPostCloseLaunch.details?.sessionName, postCloseStop.details?.sessionName);
			assert.deepEqual((failedPostCloseLaunch.details?.batchFailure as { failedStep?: { lifecycle?: unknown } } | undefined)?.failedStep?.lifecycle, { effectiveLaunch: { browserLaunched: true } });
			const activeBeforeCombined = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(activeBeforeCombined.details?.sessionName, postCloseStop.details?.sessionName);
			assert.equal(activeBeforeCombined.isError, false, activeBeforeCombined.content[0]?.text);
			assert.equal((activeBeforeCombined.details?.managedSessionOutcome as { activeAfter?: boolean } | undefined)?.activeAfter, true);
			const combinedStartClose = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["record", "start", "batch-start-close.webm"], ["close"]]),
			});
			assert.equal(combinedStartClose.isError, true, combinedStartClose.content[0]?.text);
			assert.equal(combinedStartClose.details?.failureCategory, "artifact-missing");
			const releasedAfterCombinedStartClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "batch-start-close.webm"] });
			assert.doesNotMatch(releasedAfterCombinedStartClose.content[0]?.text ?? "", /reserved by an active recording/);
			const combinedManifest = combinedStartClose.details?.artifactManifest as { entries?: Array<{ path?: string; subcommand?: string }> } | undefined;
			assert.equal(combinedManifest?.entries?.some((entry) => entry.path === "batch-start-close.webm" && entry.subcommand === "start"), false);
			const combinedArtifacts = combinedStartClose.details?.artifacts as Array<{ path?: string; recordingState?: string; status?: string; subcommand?: string; willExistOnStop?: boolean }> | undefined;
			assert.deepEqual(combinedArtifacts?.map((artifact) => ({ path: artifact.path, recordingState: artifact.recordingState, status: artifact.status, subcommand: artifact.subcommand, willExistOnStop: artifact.willExistOnStop })), [{ path: "batch-start-close.webm", recordingState: undefined, status: "missing", subcommand: "close-abandoned", willExistOnStop: undefined }]);
			const combinedVerification = combinedStartClose.details?.artifactVerification as { missingCount?: number; pendingCount?: number } | undefined;
			assert.equal(combinedVerification?.missingCount, 1);
			assert.equal(combinedVerification?.pendingCount, 0);
			assert.equal((combinedStartClose.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "stop-pending-recording"), false);
			assert.equal((combinedStartClose.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.activeAfter, false);
			assert.equal((combinedStartClose.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string } | undefined)?.status, "closed");
			const replayHarness = createExtensionHarness({
				branch: [activeBeforeCombined, combinedStartClose].map((result) => ({ type: "message", message: { details: result.details, isError: result.isError, toolName: "agent_browser" } })),
				cwd: tempDir,
			});
			await runExtensionEvent(replayHarness.handlers, "session_start", { reason: "resume" }, replayHarness.ctx);
			const replayFreshLaunch = await executeRegisteredTool(replayHarness.tool, replayHarness.ctx, { args: ["--headed", "open", "https://example.test/"] });
			assert.doesNotMatch(replayFreshLaunch.content[0]?.text ?? "", /launch-scoped flags would be ignored/i);

			for (const subcommand of ["start", "restart"]) {
				const closeThenRecord = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["close"], ["record", subcommand, `batch-close-${subcommand}.webm`]]),
				});
				assert.equal(closeThenRecord.isError, true, closeThenRecord.content[0]?.text);
				assert.equal(closeThenRecord.details?.failureCategory, "validation-error");
				assert.match(closeThenRecord.content[0]?.text ?? "", new RegExp(`record ${subcommand} cannot follow close.*Split the close and recording`, "s"));
			}

			const staleRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "stale-recording.webm"] });
			assert.equal(staleRecording.isError, false);
			await writeFile(noRecordingMarker, "1", "utf8");
			const staleStop = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "stop"] });
			assert.equal(staleStop.isError, true);
			assert.match(staleStop.content[0]?.text ?? "", /No recording in progress/);
			assert.equal((staleStop.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "stop-pending-recording") ?? false, false);
			await rm(noRecordingMarker, { force: true });
			const releasedAfterDefinitiveStopFailure = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "stale-recording.webm"] });
			assert.doesNotMatch(releasedAfterDefinitiveStopFailure.content[0]?.text ?? "", /reserved by an active recording/);

			const staleBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "stale-batch-recording.webm"] });
			assert.equal(staleBatchRecording.isError, false);
			await writeFile(noRecordingMarker, "1", "utf8");
			const staleBatchStop = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["record", "stop"]]) });
			assert.equal(staleBatchStop.isError, true);
			assert.match(staleBatchStop.content[0]?.text ?? "", /No recording in progress/);
			assert.equal((staleBatchStop.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "stop-pending-recording") ?? false, false);
			await rm(noRecordingMarker, { force: true });
			const releasedAfterDefinitiveBatchStopFailure = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "stale-batch-recording.webm"] });
			assert.doesNotMatch(releasedAfterDefinitiveBatchStopFailure.content[0]?.text ?? "", /reserved by an active recording/);

			const orderedBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "ordered-old.webm"] });
			assert.equal(orderedBatchRecording.isError, false);
			await writeFile(noRecordingMarker, "1", "utf8");
			const orderedBatchRestart = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["record", "stop"], ["record", "start", "ordered-new.webm"]]),
			});
			assert.equal(orderedBatchRestart.isError, true);
			assert.equal((orderedBatchRestart.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "stop-pending-recording"), true);
			const orderedManifest = orderedBatchRestart.details?.artifactManifest as { entries?: Array<{ path?: string; subcommand?: string }> } | undefined;
			assert.equal(orderedManifest?.entries?.some((entry) => entry.path === "ordered-new.webm" && entry.subcommand === "start"), true);
			assert.equal(orderedManifest?.entries?.some((entry) => entry.path === "ordered-new.webm" && entry.subcommand === "close-abandoned"), false);
			await rm(noRecordingMarker, { force: true });
			const releasedOrderedOld = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "ordered-old.webm"] });
			assert.doesNotMatch(releasedOrderedOld.content[0]?.text ?? "", /reserved by an active recording/);
			const reservedOrderedNew = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "ordered-new.webm"] });
			assert.match(reservedOrderedNew.content[0]?.text ?? "", /ordered-new\.webm is reserved by an active recording/);
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });

			const argumentBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "batch-argument-close.webm"] });
			assert.equal(argumentBatchRecording.isError, false);
			const argumentBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch", "close"] });
			assert.equal(argumentBatchClose.isError, false, argumentBatchClose.content[0]?.text);
			const releasedAfterArgumentBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "batch-argument-close.webm"] });
			assert.doesNotMatch(releasedAfterArgumentBatchClose.content[0]?.text ?? "", /reserved by an active recording/);

			const concurrentResults = await Promise.all([
				executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "concurrent.webm"], sessionMode: "fresh" }),
				executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "concurrent.webm"], sessionMode: "fresh" }),
			]);
			assert.equal(concurrentResults.filter((result) => result.isError).length, 1);
			assert.match(concurrentResults.find((result) => result.isError)?.content[0]?.text ?? "", /concurrent\.webm is reserved by an active recording/);
			const replacement = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "replacement.webm"], sessionMode: "fresh" });
			assert.equal(replacement.isError, false);
			const releasedAfterReplacement = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "concurrent.webm"] });
			assert.doesNotMatch(releasedAfterReplacement.content[0]?.text ?? "", /reserved by an active recording/);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] })).isError, false);

			await rm(join(tempDir, "ffmpeg"), { recursive: true, force: true });
			await writeFile(join(tempDir, "ffmpeg"), "#!/bin/sh\nexit 0\n", "utf8");
			await chmod(join(tempDir, "ffmpeg"), 0o755);
			const presentResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "present.webm"], sessionMode: "fresh" });
			assert.equal(presentResult.isError, false);
			assert.equal((presentResult.details as { recordingDependencyWarning?: unknown }).recordingDependencyWarning, undefined);
			assert.doesNotMatch(presentResult.content[0]?.text ?? "", /Recording dependency warning/);
			const reservationEntryCount = harness.appendedEntries.length;
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			assert.ok(harness.appendedEntries.slice(reservationEntryCount).some((entry) => entry.customType === "agent-browser-recording-reservation"
				&& (entry.data as { sessionName?: string; state?: string }).sessionName === presentResult.details?.sessionName
				&& (entry.data as { state?: string }).state === "closed"));
			const resumedHarness = createExtensionHarness({
				branch: harness.appendedEntries.map((entry) => ({ type: "custom", ...entry })),
				cwd: tempDir,
				prompt: "Resume after cleanup.",
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);
			const releasedAfterResume = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, { args: ["pdf", "present.webm"] });
			assert.doesNotMatch(releasedAfterResume.content[0]?.text ?? "", /reserved by an active recording/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension retires recording reservations by namespace plus session", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-namespace-"));
	const nodeBinDir = dirname(process.execPath);
	await writeFakeAgentBrowserBinary(tempDir, `const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const path = command === "pdf" ? args[commandIndex + 1] : args[commandIndex + 2];
const data = command === "open" ? { title: "Example", url: subcommand }
  : command === "get" && subcommand === "url" ? { result: "https://example.test/", url: "https://example.test/" }
  : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${nodeBinDir}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Keep recording identities isolated." });
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "one", "--session", "shared", "open", "https://example.test/"] })).isError, false);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "two", "--session", "shared", "open", "https://example.test/"] })).isError, false);
			const one = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "one", "--session", "shared", "record", "start", "one.webm"] });
			const two = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "two", "--session", "shared", "record", "start", "two.webm"] });
			assert.equal(one.isError, false, one.content[0]?.text);
			assert.equal(two.isError, false, two.content[0]?.text);
			harness.setBranch([{ type: "message", message: { role: "user", content: [{ type: "text", text: "Switch branches." }] } }]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "other", oldLeafId: null }, harness.ctx);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "one", "--session", "shared", "close"] })).isError, false);
			const stillReserved = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "two.webm"] });
			assert.equal(stillReserved.isError, true);
			assert.match(stillReserved.content[0]?.text ?? "", /two\.webm is reserved by an active recording/);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "two", "--session", "shared", "close"] })).isError, false);
			const released = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "two.webm"] });
			assert.doesNotMatch(released.content[0]?.text ?? "", /reserved by an active recording/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension persists cross-branch recording close tombstones across reload", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-tombstone-"));
	const nodeBinDir = dirname(process.execPath);
	await writeFakeAgentBrowserBinary(tempDir, `const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const path = command === "pdf" ? subcommand : args[commandIndex + 2];
const data = command === "open" ? { title: "Example", url: subcommand }
  : command === "get" && subcommand === "url" ? { result: "https://example.test/", url: "https://example.test/" }
  : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${nodeBinDir}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Keep cross-branch recording state safe." });
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "open", "https://example.test/"] })).isError, false);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "record", "start", "branch.webm"] })).isError, false);
			const activeEntry = harness.appendedEntries.find((entry) => entry.customType === "agent-browser-recording-reservation"
				&& (entry.data as { state?: string }).state === "active");
			assert.ok(activeEntry);
			const branchA = [{ type: "custom", ...activeEntry }];
			harness.setBranch([{ type: "message", message: { role: "user", content: [{ type: "text", text: "Branch B" }] } }]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-b", oldLeafId: null }, harness.ctx);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "close"] })).isError, false);
			harness.setBranch(branchA);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-a", oldLeafId: "branch-b" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
			assert.ok(branchA.some((entry) => entry.customType === "agent-browser-recording-reservation"
				&& (entry.data as { state?: string }).state === "closed"));

			const resumedHarness = createExtensionHarness({ branch: branchA, cwd: tempDir, prompt: "Resume branch A." });
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);
			resumedHarness.setBranch([{ type: "custom", ...activeEntry }]);
			await runExtensionEvent(resumedHarness.handlers, "session_tree", { newLeafId: "older-active-branch", oldLeafId: "branch-a" }, resumedHarness.ctx);
			const released = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, { args: ["pdf", "branch.webm"] });
			assert.doesNotMatch(released.content[0]?.text ?? "", /reserved by an active recording/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension renders long TUI output compactly without changing model-facing content", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Inspect a page." });
	const renderCall = harness.tool.renderCall;
	const renderResult = harness.tool.renderResult;
	assert.ok(renderCall, "expected agent_browser to register custom call rendering");
	assert.ok(renderResult, "expected agent_browser to register custom result rendering");

	const params: AgentBrowserToolParams = {
		args: ["eval", "--stdin"],
		sessionMode: "fresh",
		stdin: "document.body.innerText",
	};
	const callText = renderCall(params, PLAIN_RENDER_THEME, createRenderContext({ args: params })).render(200).join("\n");
	assert.match(callText, /<toolTitle>\*\*agent_browser\*\*<\/toolTitle>/);
	assert.match(callText, /<accent>eval --stdin<\/accent>/);
	assert.match(callText, /sessionMode=fresh/);
	assert.match(callText, /\+ stdin/);
	assert.doesNotMatch(callText, /document\.body/);

	const qaCallText = renderCall(
		{ qa: { url: "https://example.com", expectedText: "Example" } },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(200)
		.join("\n");
	assert.match(qaCallText, /<accent>qa<\/accent>/);
	assert.match(qaCallText, /<dim>→<\/dim> <accent>batch --bail<\/accent>/);

	const semanticActionCallText = renderCall(
		{ semanticAction: { action: "click", locator: "text", value: "Definitely Missing Button" } },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(200)
		.join("\n");
	assert.match(semanticActionCallText, /<accent>semanticAction<\/accent>/);
	assert.match(semanticActionCallText, /<dim>→<\/dim> <accent>find text Definitely Missing Button click<\/accent>/);

	const scriptSource = `const rows = [];\n${"rows.push('visible source'); ".repeat(12)}\n// osc-hidden line\x1B]0;\rawait browser({ args: ["get", "title"] }); //\x07\n// browser call follows\rawait browser({ args: ["get", "url"] });\u2028emit(rows);\x1B[31m\u202E\u200B`;
	const scriptParams: AgentBrowserToolParams = { script: scriptSource };
	const collapsedScriptCallText = renderCall(
		scriptParams,
		PLAIN_RENDER_THEME,
		createRenderContext({ args: scriptParams }),
	).render(200).join("\n");
	assert.match(collapsedScriptCallText, /<accent>script<\/accent>/);
	assert.match(collapsedScriptCallText, /const rows = \[\]/);
	assert.match(collapsedScriptCallText, /↵/);
	assert.match(collapsedScriptCallText, /\.\.\.<\/accent>/);
	assert.doesNotMatch(collapsedScriptCallText, /emit\(rows\)/);
	const expandedScriptCallText = renderCall(
		scriptParams,
		PLAIN_RENDER_THEME,
		createRenderContext({ args: scriptParams, expanded: true }),
	).render(200).join("\n");
	assert.match(expandedScriptCallText, /<dim>Source:<\/dim>/);
	assert.match(expandedScriptCallText, /\/\/ osc-hidden line[^\r\n]*\nawait browser\(\{ args: \["get", "title"\][^\S\r\n]*\}\)/);
	assert.match(expandedScriptCallText, /\/\/ browser call follows[^\S\r\n]*\nawait browser/);
	assert.match(expandedScriptCallText, /emit\(rows\)/);
	assert.doesNotMatch(expandedScriptCallText, /[\r\x1B\u2028\u202E\u200B]/);
	assert.match(expandedScriptCallText, /�/);

	const maliciousParams: AgentBrowserToolParams = {
		args: ["open", "\x1B]0;pwned\x07https://example.com/\x1B[31m"],
		stdin: "secret stdin must not render",
	};
	const maliciousCallText = renderCall(maliciousParams, PLAIN_RENDER_THEME, createRenderContext({ args: maliciousParams }))
		.render(200)
		.join("\n");
	assert.doesNotMatch(maliciousCallText, /[\x00\x07\x1B]/);
	assert.match(maliciousCallText, /https:\/\/example\.com\//);
	assert.doesNotMatch(maliciousCallText, /secret stdin/);

	const longText = JSON.stringify(
		{
			origin: "https://example.com/",
			result: Array.from({ length: 25 }, (_, index) => ({
				href: `https://example.com/${index}`,
				i: index,
				text: `item-${index}`,
			})),
		},
		null,
		2,
	);
	const longResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longText }],
		details: { summary: "large JSON result" },
	};
	const collapsedComponent = renderResult(
		longResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	);
	const collapsedLines = collapsedComponent.render(80);
	const collapsedText = collapsedLines.join("\n");
	const wideCollapsedText = collapsedComponent.render(200).join("\n");
	assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 80), "collapsed render lines must fit width");
	const narrowCollapsedLines = collapsedComponent.render(24);
	assert.ok(narrowCollapsedLines.every((line) => visibleWidth(line) <= 24), "narrow collapsed render lines must fit width");
	assert.match(collapsedText, /\.\.\. \(\d+ more lines, \d+ total,/);
	assert.match(wideCollapsedText, /<dim>ctrl\+o<\/dim> <muted>to expand<\/muted>/);
	assert.match(wideCollapsedText, /<syntaxVariable>"origin"<\/syntaxVariable>/);
	assert.match(wideCollapsedText, /<syntaxString>"https:\/\/example\.com\/"<\/syntaxString>/);
	assert.doesNotMatch(collapsedText, /item-24/);
	assert.match(longText, /item-24/, "renderer must not mutate model-facing content");

	const longFailureText = Array.from({ length: 20 }, (_, index) => `failure-line-${index}`).join("\n");
	const failedResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longFailureText }],
		details: { failureCategory: "selector-not-found", resultCategory: "failure", summary: "selector miss" },
	};
	const failedCollapsedText = renderResult(
		failedResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(100)
		.join("\n");
	assert.match(failedCollapsedText, /Result category: failure; failureCategory: selector-not-found; Pi tool isError: true\./);
	assert.match(failedCollapsedText, /failure-line-0/);
	assert.doesNotMatch(failedCollapsedText, /failure-line-19/);
	assert.match(longFailureText, /failure-line-19/, "renderer must not mutate failed model-facing content");

	const expandedComponent = renderResult(
		longResult,
		{ expanded: true, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params, expanded: true, lastComponent: collapsedComponent }),
	);
	const expandedText = expandedComponent.render(80).join("\n");
	assert.match(expandedText, /item-24/);
	assert.doesNotMatch(expandedText, /\.\.\. \(\d+ more lines/);

	const scalarResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "Clicked: true\x1B[31m red\x1B[0m\nHref: https://example.com/next\x1B]0;pwned\x07\nNull\x00byte\nEmoji: 👩‍💻\nSeparator: left\u2028right" }],
		details: { summary: "click completed" },
	};
	const scalarText = renderResult(
		scalarResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(scalarText, /[\x00\x07\x1B]/);
	assert.match(scalarText, /<toolOutput>Clicked: true red<\/toolOutput>/);
	assert.match(scalarText, /Null�byte/);
	assert.match(scalarText, /Emoji: 👩‍💻/);
	assert.match(scalarText, /Separator: left\u2028right/);

	const fallbackResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "\x1B[31m\x1B[0m" }],
		details: { summary: "\x1B]0;pwned\x07summary ok" },
	};
	const fallbackText = renderResult(
		fallbackResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(fallbackText, /[\x00\x07\x1B]/);
	assert.match(fallbackText, /<success>summary ok<\/success>/);
});

test("agentBrowserExtension blocks direct and wrapped agent-browser bash unless the prompt, env, or package dev cwd explicitly allows it", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bash-policy-"));
	const defaultHarness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
	for (const command of [
		"agent-browser open https://example.com",
		"FOO=bar agent-browser --version",
		"FOO=\"bar baz\" agent-browser --version",
		"PATH=/tmp:$PATH agent-browser open https://example.com",
		"echo ready\nagent-browser open https://example.com",
		"which agent-browser && agent-browser open https://example.com",
		"cat <<'EOF'\nwhich agent-browser\nEOF\nagent-browser open https://example.com",
		"env agent-browser --version",
		"npx --yes agent-browser open https://example.com",
		"pnpm dlx agent-browser open https://example.com",
		"/opt/homebrew/bin/agent-browser open https://example.com",
	]) {
		const [blocked] = await runExtensionEventResults<{ block: boolean; reason?: string }>(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		assert.equal(blocked?.block, true, command);
		assert.match(blocked?.reason ?? "", /Use the native agent_browser tool instead of bash/i);
	}

	const inspectionAllowed = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "which agent-browser" } },
		defaultHarness.ctx,
	);
	assert.deepEqual(inspectionAllowed, []);

	for (const command of [
		"echo agent-browser",
		"grep agent-browser README.md",
		"printf '%s\\n' agent-browser",
		"echo ok && grep agent-browser README.md",
		"cat <<'EOF'\nagent-browser open https://example.com\nEOF",
	]) {
		const innocuousResults = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		assert.deepEqual(innocuousResults, [], command);
	}

	const debugHarness = createExtensionHarness({ cwd: tempDir, prompt: "Please debug the browser integration via bash." });
	const debugAllowed = await runExtensionEventResults(
		debugHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "npx --yes agent-browser open https://example.com" } },
		debugHarness.ctx,
	);
	assert.deepEqual(debugAllowed, []);

	await withPatchedEnv({ PI_AGENT_BROWSER_ALLOW_DIRECT_BASH: "1" }, async () => {
		const envAllowed = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
			defaultHarness.ctx,
		);
		assert.deepEqual(envAllowed, []);
	});

	const packageDevDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-dev-"));
	await writeFile(join(packageDevDir, "package.json"), JSON.stringify({ name: "pi-agent-browser-native" }), "utf8");
	const packageDevHarness = createExtensionHarness({ cwd: packageDevDir, prompt: "Open a page and summarize it." });
	const packageDevAllowed = await runExtensionEventResults(
		packageDevHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
		packageDevHarness.ctx,
	);
	assert.deepEqual(packageDevAllowed, []);

	await rm(tempDir, { force: true, recursive: true });
	await rm(packageDevDir, { force: true, recursive: true });
});

test("agentBrowserExtension keeps the page verified after a failed eval by probing the live URL", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-reverify-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const sub = args[commandIndex + 1];
let out;
if (command === "open") out = { success: true, data: { title: "Example", url: "https://example.test/" } };
else if (command === "eval") out = { success: false, error: "Evaluation error: SyntaxError: Identifier 'c' has already been declared" };
else if (command === "get" && sub === "url") out = { success: true, data: { url: "https://example.test/" } };
else if (command === "get" && sub === "title") out = { success: true, data: { title: "Example" } };
process.stdout.write(JSON.stringify(out));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Iterate on page evals." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.test/"] });
			assert.equal(opened.isError, false);

			const failed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["eval", "const c = 1;"] });
			assert.equal(failed.isError, true);
			assert.match(failed.content[0]?.text ?? "", /already been declared/);

			const invocationsAfterFailure = await readInvocationLog(logPath);
			const evalIndex = invocationsAfterFailure.findIndex((entry) => entry.args.includes("eval"));
			assert.ok(evalIndex >= 0);
			assert.ok(invocationsAfterFailure.some((entry, index) => index > evalIndex && entry.args.includes("get") && entry.args.includes("url")), "wrapper should probe get url after the failed eval");

			const retried = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["eval", "const c = 2;"] });
			assert.equal(retried.isError, true);
			assert.equal((retried.details as { failureCategory?: string }).failureCategory, "upstream-error");
			assert.doesNotMatch(retried.content[0]?.text ?? "", /became unverified/);
			const finalInvocations = await readInvocationLog(logPath);
			assert.equal(finalInvocations.filter((entry) => entry.args.includes("eval")).length, 2);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension skips the title probe when the live URL already has an observed title", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-title-reuse-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "nav-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const sub = args[commandIndex + 1];
let state = { navigated: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "reload") { state.navigated = true; fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state)); }
const url = state.navigated ? "https://example.test/b" : "https://example.test/a";
let out;
if (command === "open") out = { success: true, data: { title: "Example A", url: "https://example.test/a" } };
else if (command === "click") out = { success: true, data: { clicked: args[commandIndex + 1] } };
else if (command === "reload") out = { success: true, data: { reloaded: true } };
else if (command === "get" && sub === "url") out = { success: true, data: { url } };
else if (command === "get" && sub === "title") out = { success: true, data: { title: state.navigated ? "Example B" : "Example A" } };
process.stdout.write(JSON.stringify(out));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Click around a docs page." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.test/a"] });
			assert.equal(opened.isError, false);

			const clicked = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "#x"] });
			assert.equal(clicked.isError, false);
			const afterClick = await readInvocationLog(logPath);
			assert.ok(afterClick.some((entry) => entry.args.includes("get") && entry.args.includes("url")), "href-less click should probe get url");
			assert.equal(afterClick.filter((entry) => entry.args.includes("get") && entry.args.includes("title")).length, 0, "same-URL probe should reuse the observed title");

			const reloaded = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["reload"] });
			assert.equal(reloaded.isError, false);
			assert.match(reloaded.content[0]?.text ?? "", /Example B/);
			const afterReload = await readInvocationLog(logPath);
			assert.equal(afterReload.filter((entry) => entry.args.includes("get") && entry.args.includes("title")).length, 1, "changed-URL probe should read the title once");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
