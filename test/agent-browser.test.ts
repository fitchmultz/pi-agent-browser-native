/**
 * Purpose: Verify the thin planning helpers, subprocess wrapper, secure temp lifecycle, and high-risk entrypoint lifecycle behavior that power the pi-agent-browser extension.
 * Responsibilities: Assert deterministic implicit session naming, argument injection behavior, prompt-derived policy logic, bounded process capture, temp-budget and ownership enforcement, curated subprocess env forwarding, entrypoint session-state transitions, and high-value result formatting.
 * Scope: Focused automated coverage for stable thin-wrapper behavior; interactive pi/tmux validation remains the primary end-to-end test path.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: These tests intentionally cover the stable thin-wrapper behavior rather than the full upstream agent-browser feature surface.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import agentBrowserExtension from "../extensions/agent-browser/index.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import {
	buildToolPresentation,
	getAgentBrowserErrorText,
	parseAgentBrowserEnvelope,
} from "../extensions/agent-browser/lib/results.js";
import {
	cleanupSecureTempArtifacts,
	getSecureTempDebugState,
	openSecureTempFile,
	writeSecureTempFile,
	writeSecureTempRootOwnershipMarker,
} from "../extensions/agent-browser/lib/temp.js";
import {
	buildExecutionPlan,
	buildPromptPolicy,
	createFreshSessionName,
	createImplicitSessionName,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	getLatestUserPrompt,
	hasUsableBraveApiKey,
	parseCommandInfo,
	resolveManagedSessionState,
} from "../extensions/agent-browser/lib/runtime.js";

const TEST_SESSION_ID = "12345678-1234-5678-9abc-def012345678";

function buildUserBranch(prompt = ""): unknown[] {
	return prompt.length === 0
		? []
		: [{ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } }];
}

function createExtensionHarness(options: { cwd: string; prompt?: string }) {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	let registeredTool:
		| {
				description: string;
				execute: (
					toolCallId: string,
					params: { args: string[]; sessionMode?: "auto" | "fresh"; stdin?: string },
					signal: AbortSignal,
					onUpdate: ((update: unknown) => void) | undefined,
					ctx: unknown,
				) => Promise<unknown>;
				name: string;
				promptGuidelines: string[];
				promptSnippet: string;
		  }
		| undefined;

	agentBrowserExtension({
		on(event, handler) {
			const existingHandlers = handlers.get(event) ?? [];
			existingHandlers.push(handler as (...args: unknown[]) => unknown);
			handlers.set(event, existingHandlers);
		},
		registerTool(tool) {
			registeredTool = tool as typeof registeredTool;
		},
	} as Parameters<typeof agentBrowserExtension>[0]);

	assert.ok(registeredTool, "expected the extension to register the agent_browser tool");

	const ctx = {
		cwd: options.cwd,
		sessionManager: {
			getBranch: () => buildUserBranch(options.prompt),
			getSessionId: () => TEST_SESSION_ID,
		},
	} as const;

	return { ctx, handlers, tool: registeredTool };
}

async function runExtensionEvent(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	eventName: string,
	...args: unknown[]
): Promise<void> {
	for (const handler of handlers.get(eventName) ?? []) {
		await handler(...args);
	}
}

async function runExtensionEventResults<T>(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	eventName: string,
	...args: unknown[]
): Promise<T[]> {
	const results: T[] = [];
	for (const handler of handlers.get(eventName) ?? []) {
		const result = await handler(...args);
		if (result !== undefined) {
			results.push(result as T);
		}
	}
	return results;
}

async function executeRegisteredTool(
	tool: NonNullable<ReturnType<typeof createExtensionHarness>["tool"]>,
	ctx: ReturnType<typeof createExtensionHarness>["ctx"],
	params: { args: string[]; sessionMode?: "auto" | "fresh"; stdin?: string },
) {
	return (await tool.execute("test-tool-call", params, new AbortController().signal, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	};
}

async function withPatchedEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(patch)) {
		previousValues.set(name, process.env[name]);
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [name, value] of previousValues) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

async function writeFakeAgentBrowserBinary(tempDir: string, scriptBody: string): Promise<string> {
	const fakeAgentBrowserPath = join(tempDir, "agent-browser");
	await writeFile(fakeAgentBrowserPath, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
	await chmod(fakeAgentBrowserPath, 0o755);
	return fakeAgentBrowserPath;
}

async function readInvocationLog(logPath: string): Promise<Array<{ args: string[]; idleTimeout?: string | null }>> {
	try {
		const text = await readFile(logPath, "utf8");
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { args: string[]; idleTimeout?: string | null });
	} catch (error) {
		const errorWithCode = error as NodeJS.ErrnoException;
		if (errorWithCode.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

test("createImplicitSessionName is stable for a persisted pi session", () => {
	const sessionId = "12345678-1234-5678-9abc-def012345678";
	const cwd = "/Users/example/Projects/pi-agent-browser";
	const one = createImplicitSessionName(sessionId, cwd, "ignored-a");
	const two = createImplicitSessionName(sessionId, cwd, "ignored-b");

	assert.equal(one, two);
	assert.equal(one, "piab-pi-agent-browser-123456781234");
});

test("hasUsableBraveApiKey only accepts non-empty values", () => {
	assert.equal(hasUsableBraveApiKey(null), false);
	assert.equal(hasUsableBraveApiKey(""), false);
	assert.equal(hasUsableBraveApiKey("   \n\t  "), false);
	assert.equal(hasUsableBraveApiKey("demo-key"), true);
});

test("implicit session timeout helpers prefer explicit overrides and safe defaults", () => {
	assert.equal(
		getImplicitSessionIdleTimeoutMs({
			AGENT_BROWSER_IDLE_TIMEOUT_MS: "2100",
			PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1200",
		}),
		"1200",
	);
	assert.equal(getImplicitSessionIdleTimeoutMs({ AGENT_BROWSER_IDLE_TIMEOUT_MS: "2100" }), "2100");
	assert.equal(getImplicitSessionIdleTimeoutMs({ PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "invalid" }), "900000");
	assert.equal(getImplicitSessionCloseTimeoutMs({ PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS: "250" }), 250);
	assert.equal(getImplicitSessionCloseTimeoutMs({ PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS: "invalid" }), 5_000);
});

test("resolveManagedSessionState only adopts successful managed sessions and identifies replaced sessions", () => {
	assert.deepEqual(
		resolveManagedSessionState({
			command: "open",
			managedSessionName: "piab-demo-123",
			priorActive: false,
			priorSessionName: "piab-demo-123",
			succeeded: false,
		}),
		{ active: false, sessionName: "piab-demo-123" },
	);
	assert.deepEqual(
		resolveManagedSessionState({
			command: "open",
			managedSessionName: "piab-demo-123",
			priorActive: false,
			priorSessionName: "piab-demo-123",
			succeeded: true,
		}),
		{ active: true, sessionName: "piab-demo-123", replacedSessionName: undefined },
	);
	assert.deepEqual(
		resolveManagedSessionState({
			command: "open",
			managedSessionName: "piab-demo-123-fresh",
			priorActive: true,
			priorSessionName: "piab-demo-123",
			succeeded: true,
		}),
		{ active: true, sessionName: "piab-demo-123-fresh", replacedSessionName: "piab-demo-123" },
	);
	assert.deepEqual(
		resolveManagedSessionState({
			command: "close",
			managedSessionName: "piab-demo-123-fresh",
			priorActive: true,
			priorSessionName: "piab-demo-123-fresh",
			succeeded: true,
		}),
		{ active: false, sessionName: "piab-demo-123-fresh" },
	);
});

test("secure temp cleanup can recreate and track a later temp root", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();

	const firstFile = await openSecureTempFile("debug-a", ".txt");
	await firstFile.fileHandle.close();
	const firstRoot = dirname(firstFile.path);
	assert.equal((await getSecureTempDebugState()).currentTempRoot, firstRoot);

	await cleanupSecureTempArtifacts();
	await assert.rejects(stat(firstRoot), { code: "ENOENT" });
	assert.deepEqual((await getSecureTempDebugState()).ownedTempRoots, []);

	const secondFile = await openSecureTempFile("debug-b", ".txt");
	await secondFile.fileHandle.close();
	const secondRoot = dirname(secondFile.path);
	assert.notEqual(secondRoot, firstRoot);

	const debugState = await getSecureTempDebugState();
	assert.equal(debugState.currentTempRoot, secondRoot);
	assert.deepEqual(debugState.ownedTempRoots, [secondRoot]);

	await cleanupSecureTempArtifacts();
});

test("stale temp pruning only removes explicitly owned roots", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
	const unownedRoot = await mkdtemp(join(tmpdir(), "pi-agent-browser-unowned-"));
	const ownedRoot = await mkdtemp(join(tmpdir(), "pi-agent-browser-owned-"));
	await chmod(unownedRoot, 0o700);
	await chmod(ownedRoot, 0o700);
	await writeFile(join(unownedRoot, "leftover.txt"), "keep", "utf8");
	await writeSecureTempRootOwnershipMarker(ownedRoot, staleTime.getTime());
	await utimes(unownedRoot, staleTime, staleTime);
	await utimes(ownedRoot, staleTime, staleTime);

	try {
		const tempFile = await openSecureTempFile("prune-check", ".txt");
		await tempFile.fileHandle.close();

		await assert.rejects(stat(ownedRoot), { code: "ENOENT" });
		await stat(unownedRoot);
		await rm(unownedRoot, { force: true, recursive: true });
		await cleanupSecureTempArtifacts();
	} finally {
		await rm(unownedRoot, { force: true, recursive: true }).catch(() => undefined);
		await rm(ownedRoot, { force: true, recursive: true }).catch(() => undefined);
		await cleanupSecureTempArtifacts();
	}
});

test("writeSecureTempFile enforces the aggregate temp-root disk budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1024" }, async () => {
		await writeSecureTempFile({ content: "a".repeat(600), prefix: "budget-a", suffix: ".txt" });
		await assert.rejects(
			writeSecureTempFile({ content: "b".repeat(500), prefix: "budget-b", suffix: ".txt" }),
			/temp spill budget exceeded/i,
		);
	});
	await cleanupSecureTempArtifacts();
});

test("buildExecutionPlan injects --json and the implicit session when needed", () => {
	const plan = buildExecutionPlan(["open", "https://example.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "piab-demo-123", "open", "https://example.com"]);
	assert.equal(plan.managedSessionName, "piab-demo-123");
	assert.equal(plan.sessionName, "piab-demo-123");
	assert.equal(plan.usedImplicitSession, true);
	assert.equal(plan.validationError, undefined);
});

test("buildExecutionPlan respects explicit upstream sessions", () => {
	const plan = buildExecutionPlan(["--session", "custom", "snapshot", "-i"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "custom", "snapshot", "-i"]);
	assert.equal(plan.managedSessionName, undefined);
	assert.equal(plan.sessionName, "custom");
	assert.equal(plan.usedImplicitSession, false);
});

test("buildExecutionPlan blocks startup-scoped flags from silently reusing an active implicit session", () => {
	for (const args of [
		["--profile", "Default", "open", "https://example.com"],
		["--session-name", "saved-auth", "open", "https://example.com"],
		["--cdp", "ws://127.0.0.1:9222/devtools/browser/demo", "open", "https://example.com"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.match(plan.validationError ?? "", /startup-scoped flags/i);
		assert.equal(plan.startupScopedFlags.length, 1);
		assert.equal(plan.startupScopedFlags[0], args[0]);
		assert.equal(plan.usedImplicitSession, false);
		assert.equal(plan.recoveryHint?.recommendedSessionMode, "fresh");
		assert.deepEqual(plan.recoveryHint?.exampleParams, { args: [...args], sessionMode: "fresh" });
	}
});

test("buildExecutionPlan assigns a new managed session for fresh session mode", () => {
	const args = ["--profile", "Default", "open", "https://example.com/profile"];
	const freshSessionName = createFreshSessionName("piab-demo-123", "seed", 1);
	const plan = buildExecutionPlan(args, {
		freshSessionName,
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "fresh",
	});

	assert.equal(plan.validationError, undefined);
	assert.equal(plan.usedImplicitSession, false);
	assert.equal(plan.managedSessionName, freshSessionName);
	assert.deepEqual(plan.effectiveArgs, ["--json", "--session", freshSessionName, ...args]);
	assert.equal(plan.recoveryHint, undefined);
});

test("buildPromptPolicy and getLatestUserPrompt derive legacy bash policy from prompt text without globals", () => {
	const prompt = getLatestUserPrompt([
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Not relevant" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Please debug the browser integration via bash." }] } },
	]);
	const policy = buildPromptPolicy(prompt);

	assert.equal(prompt, "Please debug the browser integration via bash.");
	assert.equal(policy.allowLegacyAgentBrowserBash, true);
});

test("buildPromptPolicy does not allow legacy bash for generic docs prompts unrelated to agent-browser", () => {
	const policy = buildPromptPolicy("Please review the repo docs and summarize the architecture.");

	assert.equal(policy.allowLegacyAgentBrowserBash, false);
});

test("buildPromptPolicy allows explicit tool-specific legacy bash inspection requests", () => {
	const policy = buildPromptPolicy("Show me the agent-browser docs and explain agent-browser --help output.");

	assert.equal(policy.allowLegacyAgentBrowserBash, true);
});

test("agentBrowserExtension registers shared browser guidance across hooks and tool metadata", async () => {
	await withPatchedEnv({ BRAVE_API_KEY: "demo-key" }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		assert.deepEqual([...harness.handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "tool_call"]);
		assert.equal(harness.tool.name, "agent_browser");
		assert.match(harness.tool.description, /authenticated\/profile-based browser work/);
		assert.match(harness.tool.promptSnippet, /real web workflows/);

		const sharedGuidelineFragments = [
			"Quick start mental model: args are the exact agent-browser CLI args after the binary",
			"Common first calls: { args: [\"open\", \"https://example.com\"] } then { args: [\"snapshot\", \"-i\"] }",
			"Common advanced calls: { args: [\"batch\"]",
			"Standard workflow: open the page, snapshot -i, interact using refs",
			"When a non-empty BRAVE_API_KEY is available in the current environment",
			"Do not invent fixed explicit session names for routine tasks.",
			"When using eval --stdin for extraction, return the value you want",
			"Do not call --help or other exploratory inspection commands unless the user explicitly asks",
		];
		for (const fragment of sharedGuidelineFragments) {
			assert.equal(harness.tool.promptGuidelines.some((guideline) => guideline.includes(fragment)), true);
		}
		assert.equal(
			harness.tool.promptGuidelines.filter((guideline) => guideline.includes("Do not invent fixed explicit session names")).length,
			1,
		);

		const [beforeAgentStart] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(typeof beforeAgentStart?.systemPrompt, "string");
		assert.equal(beforeAgentStart?.systemPrompt.includes("Base system prompt"), true);
		assert.equal(beforeAgentStart?.systemPrompt.includes("Project rule: when browser automation is needed"), true);
		assert.equal(beforeAgentStart?.systemPrompt.includes("Quick start:"), true);
		assert.equal(beforeAgentStart?.systemPrompt.includes("Browser operating playbook:"), true);
		assert.equal(beforeAgentStart?.systemPrompt.split("Quick start:").length - 1, 1);
		assert.equal(beforeAgentStart?.systemPrompt.split("Browser operating playbook:").length - 1, 1);
		for (const fragment of sharedGuidelineFragments) {
			assert.equal(beforeAgentStart?.systemPrompt.includes(fragment), true);
		}
	});
});

test("agentBrowserExtension blocks direct agent-browser bash unless the prompt explicitly allows it", async () => {
	const defaultHarness = createExtensionHarness({ cwd: process.cwd(), prompt: "Open a page and summarize it." });
	const [blocked] = await runExtensionEventResults<{ block: boolean; reason?: string }>(
		defaultHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
		defaultHarness.ctx,
	);
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /Use the native agent_browser tool instead of bash/i);

	const inspectionAllowed = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "which agent-browser" } },
		defaultHarness.ctx,
	);
	assert.deepEqual(inspectionAllowed, []);

	const debugHarness = createExtensionHarness({ cwd: process.cwd(), prompt: "Please debug the browser integration via bash." });
	const debugAllowed = await runExtensionEventResults(
		debugHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
		debugHarness.ctx,
	);
	assert.deepEqual(debugAllowed, []);
});

test("agentBrowserExtension allows plain-text inspection commands regardless of prompt wording", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `process.stdout.write("agent-browser 9.9.9\\n");`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--version"],
			});

			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /agent-browser 9\.9\.9/);
			assert.equal(result.details?.inspectionBlocked, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("parseCommandInfo skips global flags with values", () => {
	const commandInfo = parseCommandInfo(["--session", "named", "--profile", "./profile", "tab", "list"]);
	assert.deepEqual(commandInfo, { command: "tab", subcommand: "list" });
});

test("parseAgentBrowserEnvelope reports invalid JSON clearly", async () => {
	const parsed = await parseAgentBrowserEnvelope("not-json");
	assert.match(parsed.parseError ?? "", /invalid JSON/i);
});

test("parseAgentBrowserEnvelope accepts batch JSON arrays", async () => {
	const parsed = await parseAgentBrowserEnvelope(
		JSON.stringify([
			{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
			{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
		]),
	);

	assert.equal(parsed.parseError, undefined);
	assert.equal(Array.isArray(parsed.envelope?.data), true);
	assert.equal(parsed.envelope?.success, true);
});

test("getAgentBrowserErrorText prefers envelope errors over generic exit codes", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: false, error: "Navigation failed: net::ERR_BLOCKED_BY_CLIENT" },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "Navigation failed: net::ERR_BLOCKED_BY_CLIENT");
});

test("getAgentBrowserErrorText extracts nested envelope error messages", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: false, error: { details: { message: "Profile directory is locked" } } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "Profile directory is locked");
});

test("getAgentBrowserErrorText falls back to stderr or a generic message when a failed envelope has no simple error field", () => {
	const stderrFallback = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "Navigation failed upstream",
	});
	const genericFallback = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(stderrFallback, "Navigation failed upstream");
	assert.equal(genericFallback, "agent-browser reported failure (exit code 1)");
});

test("getAgentBrowserErrorText falls back to generic exit codes when no envelope error exists", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: true, data: null },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "agent-browser exited with code 1.");
});

test("getAgentBrowserErrorText defers mixed batch failures to batch rendering", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: {
			success: false,
			data: [
				{ command: ["open", "https://example.com"], result: { title: "Example Domain" }, success: true },
				{ command: ["click", "@zzz"], error: "Unknown ref: zzz", success: false },
			],
		},
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, undefined);
});

test("getAgentBrowserErrorText prefers spill/write failures over downstream parse errors", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		exitCode: 0,
		parseError: "agent-browser returned invalid JSON: Unexpected end of JSON input",
		plainTextInspection: false,
		spawnError: new Error("pi-agent-browser temp spill budget exceeded"),
		stderr: "",
	});

	assert.equal(errorText, "pi-agent-browser temp spill budget exceeded");
});

test("buildToolPresentation formats snapshot output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				refs: {
					e1: { name: "Example Domain", role: "heading" },
					e2: { name: "More", role: "link" },
				},
				snapshot: '- heading "Example Domain" [level=1, ref=e1]\n- link "More" [ref=e2]',
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Origin: https:\/\/example.com\//);
	assert.match((presentation.content[0] as { text: string }).text, /Refs: 2/);
	assert.match(presentation.summary, /Snapshot: 2 refs/);
});

test("buildToolPresentation enriches click results with a current-page navigation summary", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				clicked: true,
				href: "https://example.com/docs",
				navigationSummary: {
					title: "Destination Docs",
					url: "https://example.com/docs",
				},
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Clicked: true/);
	assert.match((presentation.content[0] as { text: string }).text, /Href: https:\/\/example.com\/docs/);
	assert.match((presentation.content[0] as { text: string }).text, /Current page:/);
	assert.match((presentation.content[0] as { text: string }).text, /Destination Docs/);
	assert.match((presentation.content[0] as { text: string }).text, /https:\/\/example.com\/docs/);
	assert.match(presentation.summary, /click → Destination Docs/);
});

test("buildToolPresentation formats batch output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
				{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Step 1 — open https:\/\/developer.mozilla.org/);
	assert.match((presentation.content[0] as { text: string }).text, /MDN Web Docs/);
	assert.equal(Array.isArray(presentation.data), true);
	assert.equal(presentation.batchSteps?.length, 2);
	assert.equal(presentation.batchSteps?.[0]?.commandText, "open https://developer.mozilla.org");
	assert.match(presentation.summary, /Batch: 2\/2 succeeded/);
});

test("buildToolPresentation preserves partial batch results when a later step fails", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: [
				{ command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
				{ command: ["click", "@zzz"], success: false, error: "Unknown ref: zzz" },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Batch failed: 1\/2 succeeded/);
	assert.match((presentation.content[0] as { text: string }).text, /First failing step: 2 — click @zzz/);
	assert.match((presentation.content[0] as { text: string }).text, /Step 1 — open https:\/\/example.com \(succeeded\)/);
	assert.match((presentation.content[0] as { text: string }).text, /Example Domain/);
	assert.match((presentation.content[0] as { text: string }).text, /Step 2 — click @zzz \(failed\)/);
	assert.match((presentation.content[0] as { text: string }).text, /Error: Unknown ref: zzz/);
	assert.equal(presentation.batchFailure?.failedStep.index, 1);
	assert.equal(presentation.batchFailure?.failedStep.commandText, "click @zzz");
	assert.equal(presentation.batchFailure?.failureCount, 1);
	assert.equal(presentation.batchFailure?.successCount, 1);
	assert.equal(presentation.batchFailure?.totalCount, 2);
	assert.match(presentation.summary, /Batch failed: 1\/2 succeeded/);
});

test("buildToolPresentation reuses standalone inline screenshot rendering inside batch output", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-image-"));
	const imagePath = join(tempDir, "batched.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: tempDir,
			envelope: {
				success: true,
				data: [
					{
						command: ["open", "https://example.com"],
						result: { title: "Example Domain", url: "https://example.com/" },
						success: true,
					},
					{ command: ["screenshot"], result: { path: "batched.png" }, success: true },
				],
			},
		});

		const text = (presentation.content[0] as { text: string }).text;
		assert.match(text, /Step 1 — open https:\/\/example.com/);
		assert.match(text, /Example Domain/);
		assert.match(text, /Step 2 — screenshot/);
		assert.match(text, /Saved image: batched.png/);
		assert.match(text, /1 inline image attachment below/);
		assert.equal(presentation.content[1]?.type, "image");
		assert.equal(presentation.imagePath, imagePath);
		assert.deepEqual(presentation.imagePaths, [imagePath]);
		assert.equal(presentation.batchSteps?.[1]?.imagePath, imagePath);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation reuses compact snapshot rendering inside batch output", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large batched snapshot row ${index + 1} that should compact inside batch output\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{
					command: ["snapshot", "-i"],
					result: {
						origin: "https://example.com/batched-huge",
						refs,
						snapshot,
					},
					success: true,
				},
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Step 1 — snapshot -i/);
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /Key refs:/);
	assert.match(text, /details\.fullOutputPath/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal(presentation.batchSteps?.length, 1);
	assert.equal(typeof presentation.batchSteps?.[0]?.fullOutputPath, "string");
	assert.match(presentation.batchSteps?.[0]?.text ?? "", /Compact snapshot view/);

	const spillPath = presentation.batchSteps?.[0]?.fullOutputPath;
	assert.ok(spillPath);
	assert.doesNotMatch(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	if (spillPath) {
		await rm(spillPath, { force: true });
	}
});

test("buildToolPresentation compacts oversized snapshots and spills the raw snapshot to a private temp file", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large snapshot row ${index + 1} with lots of repeated visible text that should not all stay inline\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/huge",
				refs,
				snapshot,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /Key refs:/);
	assert.match(text, /details\.fullOutputPath/);
	assert.match(presentation.summary, /Snapshot: 90 refs on https:\/\/example.com\/huge \(compact\)/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.doesNotMatch(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const spillText = await readFile(spillPath, "utf8");
	const spillStats = await stat(spillPath);
	const spillDirStats = await stat(dirname(spillPath));
	assert.match(spillText, /Large snapshot row 120/);
	assert.match(spillText, /Actionable control 1/);
	assert.equal(spillStats.mode & 0o777, 0o600);
	assert.equal(spillDirStats.mode & 0o777, 0o700);
	await rm(spillPath, { force: true });
});

test("buildToolPresentation prefers main content sections over top-of-page chrome in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Skip to main content", role: "link" }];
			if (id === "e2") return [id, { name: "AD", role: "link" }];
			if (id === "e3") return [id, { name: "JavaScript", role: "heading" }];
			if (id === "e4") return [id, { name: "Beginner's tutorials", role: "region" }];
			if (id === "e5") return [id, { name: "Intermediate", role: "region" }];
			if (id === "e6") return [id, { name: "Reference", role: "region" }];
			return [id, { name: `Content item ${index + 1}`, role: index % 6 === 0 ? "link" : "generic" }];
		}),
	);
	const snapshot = [
		'- link "Skip to main content" [ref=e1]',
		'- link "AD" [ref=e2]',
		'- heading "JavaScript" [level=1, ref=e3]',
		...Array.from({ length: 18 }, (_, index) => `- link "Overview topic ${index + 1}" [ref=e${index + 10}]`),
		'- region "Beginner\'s tutorials" [ref=e4]',
		'  - link "Your first website: Adding interactivity" [ref=e40]',
		'  - link "Dynamic scripting with JavaScript" [ref=e41]',
		'- region "Intermediate" [ref=e5]',
		'  - link "Asynchronous JavaScript" [ref=e42]',
		'  - link "Client-side web APIs" [ref=e43]',
		'- region "Reference" [ref=e6]',
		...Array.from({ length: 70 }, (_, index) => `  - link "Reference entry ${index + 1}" [ref=e${index + 50}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/docs/javascript",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Primary content:/);
	assert.match(text, /heading "JavaScript"/);
	assert.match(text, /Additional sections:/);
	assert.match(text, /region "Beginner's tutorials"/);
	assert.doesNotMatch(text, /Skip to main content/);
	assert.doesNotMatch(text, /^- AD$/m);
	assert.equal((presentation.data as { previewMode?: string }).previewMode, "structured");

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation falls back to an outline when the raw snapshot format is unfamiliar", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [`e${index + 1}`, { name: `Action ${index + 1}`, role: "button" }]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `node e${index + 1}: Action ${index + 1} -> click target`).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/unfamiliar",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact outline:/);
	assert.doesNotMatch(text, /Primary content:/);
	assert.match(text, /node e1: Action 1 -> click target/);
	assert.match(text, /Key refs:/);
	assert.match(text, /Action 1/);
	assert.equal((presentation.data as { previewMode?: string }).previewMode, "outline");

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation degrades gracefully when snapshot spill creation exceeds the temp budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const refs = Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`e${index + 1}`, { name: `Action ${index + 1}`, role: "button" }]));
	const snapshot = Array.from({ length: 120 }, (_, index) => `- button "Budget row ${index + 1}" [ref=e${index + 1}]`).join("\n");

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1024" }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: {
					success: true,
					data: {
						origin: "https://example.com/budgeted",
						refs,
						snapshot,
					},
				},
			});

			assert.equal(presentation.fullOutputPath, undefined);
			assert.match((presentation.content[0] as { text: string }).text, /Full raw snapshot unavailable:/);
			assert.match((presentation.content[0] as { text: string }).text, /temp spill budget exceeded/i);
		});
	} finally {
		await cleanupSecureTempArtifacts();
	}
});

test("buildToolPresentation skips oversized inline image attachments", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-image-"));
	const imagePath = join(tempDir, "large.png");
	await writeFile(imagePath, Buffer.alloc(256, 1));

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES: "128" }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "screenshot" },
				cwd: tempDir,
				envelope: { success: true, data: { path: "large.png" } },
			});

			assert.equal(presentation.content.length, 1);
			assert.equal(presentation.content[0]?.type, "text");
			assert.match((presentation.content[0] as { text: string }).text, /Image attachment skipped:/);
			assert.equal(presentation.imagePath, imagePath);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves rich batch rendering and inline screenshot attachments", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const imagePath = join(tempDir, "batched.png");
	const basePath = process.env.PATH ?? "";
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify([
  { command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
  { command: ["screenshot"], success: true, result: { path: "batched.png" } }
]));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: "[]" });
			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.equal(result.content[1]?.type, "image");
			assert.match((result.content[0] as { text: string }).text, /Step 2 — screenshot/);
			assert.match((result.content[0] as { text: string }).text, /1 inline image attachment below/);
			assert.equal((result.details?.imagePath as string | undefined)?.endsWith("batched.png"), true);
			assert.deepEqual(result.details?.imagePaths, [imagePath]);
			assert.equal(Array.isArray(result.details?.batchSteps), true);
			assert.equal((result.details?.batchSteps as Array<{ imagePath?: string }>)[1]?.imagePath, imagePath);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves mixed batch failure rendering while still marking the tool call as an error", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify([
  { command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
  { command: ["click", "@zzz"], success: false, error: "Unknown ref: zzz" }
]));
process.exitCode = 1;`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: "[]" });
			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Batch failed: 1\/2 succeeded/);
			assert.match((result.content[0] as { text: string }).text, /First failing step: 2 — click @zzz/);
			assert.match((result.content[0] as { text: string }).text, /Step 1 — open https:\/\/example.com \(succeeded\)/);
			assert.match((result.content[0] as { text: string }).text, /Example Domain/);
			assert.match((result.content[0] as { text: string }).text, /Step 2 — click @zzz \(failed\)/);
			assert.match((result.content[0] as { text: string }).text, /Error: Unknown ref: zzz/);
			assert.equal((result.details?.summary as string | undefined)?.includes("Batch failed: 1/2 succeeded"), true);
			assert.equal((result.details?.exitCode as number | undefined) ?? 0, 1);
			assert.equal((result.details?.batchFailure as { failedStep?: { index?: number; commandText?: string } } | undefined)?.failedStep?.index, 1);
			assert.equal(
				(result.details?.batchFailure as { failedStep?: { index?: number; commandText?: string } } | undefined)?.failedStep
					?.commandText,
				"click @zzz",
			);
			assert.equal(Array.isArray(result.details?.batchSteps), true);
			assert.equal((result.details?.stderr as string | undefined) ?? "", "");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension enriches click results with a post-navigation title and url summary", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true, href: "https://example.com/docs" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: "Destination Docs" }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: "https://example.com/docs" }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e2"],
			});
			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Clicked: true/);
			assert.match((result.content[0] as { text: string }).text, /Href: https:\/\/example.com\/docs/);
			assert.match((result.content[0] as { text: string }).text, /Current page:/);
			assert.match((result.content[0] as { text: string }).text, /Destination Docs/);
			assert.equal(
				(result.details?.navigationSummary as { title?: string; url?: string } | undefined)?.title,
				"Destination Docs",
			);
			assert.equal(
				(result.details?.navigationSummary as { title?: string; url?: string } | undefined)?.url,
				"https://example.com/docs",
			);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.equal(invocations[0]?.args.includes("click"), true);
			assert.equal(invocations[1]?.args.includes("title"), true);
			assert.equal(invocations[2]?.args.includes("url"), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess spills oversized stdout while parseAgentBrowserEnvelope still sees the full payload", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const fakeAgentBrowserPath = join(tempDir, "agent-browser");
	const bigSnapshotRows = Array.from({ length: 7_000 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large process snapshot row ${index + 1} that forces stdout spilling without losing parseability\" [ref=${ref}] clickable [onclick]`;
	}).join("\\n");
	const refsLiteral = Array.from({ length: 80 }, (_, index) => `e${index + 1}: { name: "Action ${index + 1}", role: "button" }`).join(",");
	await writeFile(
		fakeAgentBrowserPath,
		`#!/usr/bin/env node
const envelope = {
  success: true,
  data: {
    origin: "https://example.com/process-large",
    refs: {${refsLiteral}},
    snapshot: ${JSON.stringify(bigSnapshotRows)}
  }
};
process.stdout.write(JSON.stringify(envelope));
`,
		"utf8",
	);
	await chmod(fakeAgentBrowserPath, 0o755);

	try {
		const processResult = await runAgentBrowserProcess({
			args: ["snapshot", "-i"],
			cwd: tempDir,
			env: { PATH: `${tempDir}:${process.env.PATH ?? ""}` },
		});

		assert.equal(processResult.exitCode, 0);
		assert.equal(typeof processResult.stdoutSpillPath, "string");
		assert.ok(processResult.stdout.length < bigSnapshotRows.length);

		const parsed = await parseAgentBrowserEnvelope({
			stdout: processResult.stdout,
			stdoutPath: processResult.stdoutSpillPath,
		});
		assert.equal(parsed.parseError, undefined);
		assert.equal(parsed.envelope?.success, true);
		const snapshotData = parsed.envelope?.data as { snapshot?: string } | undefined;
		assert.match(snapshotData?.snapshot ?? "", /Large process snapshot row 7000/);

		if (processResult.stdoutSpillPath) {
			await rm(processResult.stdoutSpillPath, { force: true });
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess stops spilling once the secure temp budget is exceeded", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const oversizedPayload = JSON.stringify({ success: true, data: { snapshot: "x".repeat(700_000) } });
	await writeFakeAgentBrowserBinary(tempDir, `process.stdout.write(${JSON.stringify(oversizedPayload)});`);

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "100000" }, async () => {
			const processResult = await runAgentBrowserProcess({
				args: ["snapshot"],
				cwd: tempDir,
				env: { PATH: `${tempDir}:${basePath}` },
			});

			assert.match(processResult.spawnError?.message ?? "", /temp spill budget exceeded/i);
			if (processResult.stdoutSpillPath) {
				const spillStats = await stat(processResult.stdoutSpillPath);
				assert.ok(spillStats.size <= 100000);
				await rm(processResult.stdoutSpillPath, { force: true });
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
		await cleanupSecureTempArtifacts();
	}
});

test("runAgentBrowserProcess forwards a curated environment instead of the full parent env", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const envelope = {
  success: true,
  data: {
    secret: process.env.PI_AGENT_BROWSER_TEST_SECRET ?? null,
    lang: process.env.LANG ?? null,
    agentBrowserSession: process.env.AGENT_BROWSER_SESSION ?? null,
    idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null,
    pathStartsWithTemp: (process.env.PATH ?? "").startsWith(${JSON.stringify(tempDir)})
  }
};
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv(
			{
				AGENT_BROWSER_SESSION: "from-parent",
				LANG: "en_US.UTF-8",
				PI_AGENT_BROWSER_TEST_SECRET: "should-not-leak",
			},
			async () => {
				const processResult = await runAgentBrowserProcess({
					args: ["session"],
					cwd: tempDir,
					env: {
						AGENT_BROWSER_IDLE_TIMEOUT_MS: "1234",
						PATH: `${tempDir}:${basePath}`,
					},
				});

				assert.equal(processResult.exitCode, 0);
				const parsed = await parseAgentBrowserEnvelope(processResult.stdout);
				assert.equal(parsed.parseError, undefined);
				const data = parsed.envelope?.data as {
					agentBrowserSession: string | null;
					idleTimeout: string | null;
					lang: string | null;
					pathStartsWithTemp: boolean;
					secret: string | null;
				};
				assert.equal(data.secret, null);
				assert.equal(data.lang, "en_US.UTF-8");
				assert.equal(data.agentBrowserSession, "from-parent");
				assert.equal(data.idleTimeout, "1234");
				assert.equal(data.pathStartsWithTemp, true);
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension resets implicit session state on session_start", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { url: args[args.length - 1] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/first"],
			});
			assert.equal(firstOpen.isError, false);

			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const profiledOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profiled"],
			});
			assert.equal(profiledOpen.isError, false);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.equal(invocations[0]?.args.includes("--session"), true);
			assert.equal(invocations[1]?.args.includes("--profile"), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test(
	"agentBrowserExtension only blocks startup-scoped flags after a successful implicit launch and resets after close",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: "Example Domain", url: args[args.length - 1], idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

					const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com"],
					});
					assert.equal(firstOpen.isError, false);
					assert.equal((firstOpen.details?.data as { idleTimeout?: string } | undefined)?.idleTimeout, "1234");

					const afterFirstOpen = await readInvocationLog(logPath);
					assert.equal(afterFirstOpen.length, 1);
					assert.equal(afterFirstOpen[0]?.args.includes("--session"), true);
					assert.equal(afterFirstOpen[0]?.idleTimeout, "1234");

					const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profile"],
					});
					assert.equal(blocked.isError, true);
					assert.match(String(blocked.details?.validationError ?? ""), /startup-scoped flags/i);
					assert.equal(blocked.details?.sessionMode, "auto");
					assert.equal(
						(blocked.details?.sessionRecoveryHint as { recommendedSessionMode?: string } | undefined)?.recommendedSessionMode,
						"fresh",
					);
					assert.equal((await readInvocationLog(logPath)).length, 1);

					const closeResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
					assert.equal(closeResult.isError, false);
					assert.equal((await readInvocationLog(logPath)).length, 2);

					const reopened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profile"],
					});
					assert.equal(reopened.isError, false);

					const finalInvocations = await readInvocationLog(logPath);
					assert.equal(finalInvocations.length, 3);
					assert.equal(finalInvocations[2]?.args.includes("--profile"), true);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("agentBrowserExtension rotates the managed session to a fresh profile launch and reuses it on follow-up auto calls", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: args.includes("--profile") ? "Profiled" : "Public", url: args[args.length - 1], idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});
			assert.equal(firstOpen.isError, false);
			const firstSessionName = firstOpen.details?.sessionName;
			assert.equal(typeof firstSessionName, "string");

			const profiledOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profile"],
				sessionMode: "fresh",
			});
			assert.equal(profiledOpen.isError, false);
			assert.equal(profiledOpen.details?.sessionMode, "fresh");
			assert.equal(profiledOpen.details?.usedImplicitSession, false);
			const freshSessionName = profiledOpen.details?.sessionName;
			assert.equal(typeof freshSessionName, "string");
			assert.notEqual(freshSessionName, firstSessionName);
			assert.equal(
				((profiledOpen.details?.effectiveArgs as string[] | undefined) ?? []).includes(String(freshSessionName)),
				true,
			);

			const followUpSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "-i"],
			});
			assert.equal(followUpSnapshot.isError, false);
			assert.equal(followUpSnapshot.details?.sessionName, freshSessionName);
			assert.equal(followUpSnapshot.details?.usedImplicitSession, true);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 4);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", String(firstSessionName), "open", "https://example.com"]);
			assert.equal(invocations[0]?.idleTimeout, "1234");
			assert.deepEqual(invocations[1]?.args, [
				"--json",
				"--session",
				String(freshSessionName),
				"--profile",
				"Default",
				"open",
				"https://example.com/profile",
			]);
			assert.equal(invocations[1]?.idleTimeout, "1234");
			assert.deepEqual(invocations[2]?.args, ["--session", String(firstSessionName), "close"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", String(freshSessionName), "snapshot", "-i"]);
			assert.equal(invocations[3]?.idleTimeout, "1234");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not mark a failed first implicit command as active", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const shouldFail = args.includes("https://fail.example");
process.stdout.write(JSON.stringify(shouldFail ? { success: false, error: "intentional failure" } : { success: true, data: { title: "Recovered" } }));
process.exit(shouldFail ? 1 : 0);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const failedOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://fail.example"],
			});
			assert.equal(failedOpen.isError, true);
			assert.equal((await readInvocationLog(logPath)).length, 1);

			const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/recovered"],
			});
			assert.equal(followUp.isError, false);
			assert.equal(followUp.details?.validationError, undefined);
			assert.equal((followUp.details?.effectiveArgs as string[] | undefined)?.includes("--profile"), true);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.equal(invocations[1]?.args.includes("--profile"), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
