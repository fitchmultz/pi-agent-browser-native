/**
 * Purpose: Verify the thin planning helpers, subprocess wrapper, secure temp lifecycle, and high-risk entrypoint lifecycle behavior that power the pi-agent-browser extension.
 * Responsibilities: Assert deterministic implicit session naming, argument injection behavior, prompt-derived policy logic, bounded process capture, temp-budget and ownership enforcement, curated subprocess env forwarding, entrypoint session-state transitions, and high-value result formatting.
 * Scope: Focused automated coverage for stable thin-wrapper behavior; interactive pi/tmux validation remains the primary end-to-end test path.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: These tests intentionally cover the stable thin-wrapper behavior rather than the full upstream agent-browser feature surface.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import agentBrowserExtension from "../extensions/agent-browser/index.js";
import {
	BRAVE_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_PREFIX,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
import { isRecord, parsePositiveInteger } from "../extensions/agent-browser/lib/parsing.js";
import { getAgentBrowserSocketDir, runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
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
	chooseOpenResultTabCorrection,
	createFreshSessionName,
	createImplicitSessionName,
	extractCommandTokens,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	getLatestUserPrompt,
	hasLaunchScopedTabCorrectionFlag,
	hasUsableBraveApiKey,
	parseCommandInfo,
	redactInvocationArgs,
	redactSensitiveValue,
	restoreManagedSessionStateFromBranch,
	resolveManagedSessionState,
	shouldAppendBrowserSystemPrompt,
} from "../extensions/agent-browser/lib/runtime.js";

const TEST_SESSION_ID = "12345678-1234-5678-9abc-def012345678";

function buildUserBranch(prompt = ""): unknown[] {
	return prompt.length === 0
		? []
		: [{ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } }];
}

function createToolBranchEntry(options: { details: Record<string, unknown>; isError?: boolean }): unknown {
	return {
		type: "message",
		message: {
			isError: options.isError,
			details: options.details,
			toolName: "agent_browser",
		},
	};
}

type RegisteredTool = {
	description: string;
	execute: (
		toolCallId: string,
		params: { args: string[]; sessionMode?: "auto" | "fresh"; stdin?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<unknown>;
	name: string;
	promptGuidelines: string[];
	promptSnippet: string;
};

function createExtensionHarness(options: {
	branch?: unknown[];
	cwd: string;
	prompt?: string;
	sessionDir?: string;
	sessionFile?: string;
}) {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	let registeredTool: RegisteredTool | undefined;

	agentBrowserExtension({
		on(event, handler) {
			const existingHandlers = handlers.get(event) ?? [];
			existingHandlers.push(handler as (...args: unknown[]) => unknown);
			handlers.set(event, existingHandlers);
		},
		registerTool(tool) {
			registeredTool = tool as unknown as RegisteredTool;
		},
	} as Parameters<typeof agentBrowserExtension>[0]);

	assert.ok(registeredTool, "expected the extension to register the agent_browser tool");

	const branch = options.branch ?? buildUserBranch(options.prompt);
	const sessionDir = options.sessionDir ?? (options.sessionFile ? dirname(options.sessionFile) : undefined);
	const ctx = {
		cwd: options.cwd,
		sessionManager: {
			getBranch: () => branch,
			getSessionDir: () => sessionDir,
			getSessionFile: () => options.sessionFile,
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

async function readInvocationLog(logPath: string): Promise<Array<{ args: string[]; idleTimeout?: string | null; socketDir?: string | null; stdin?: string | null }>> {
	try {
		const text = await readFile(logPath, "utf8");
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { args: string[]; idleTimeout?: string | null; socketDir?: string | null; stdin?: string | null });
	} catch (error) {
		const errorWithCode = error as NodeJS.ErrnoException;
		if (errorWithCode.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function readChildStdoutJsonLine<T>(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<T> {
	assert.ok(child.stdout, "expected child stdout pipe");
	assert.ok(child.stderr, "expected child stderr pipe");
	let stdout = "";
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	return await new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for child stdout JSON line. stdout=${stdout} stderr=${stderr}`));
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
			if (!firstLine) return;
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(firstLine) as T);
			} catch (error) {
				reject(error);
			}
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Child exited before stdout JSON line: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

async function stopChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
	try {
		await once(child, "exit");
	} finally {
		clearTimeout(timeout);
	}
}

test("createImplicitSessionName is stable for a persisted pi session", () => {
	const sessionId = "12345678-1234-5678-9abc-def012345678";
	const cwd = "/Users/example/Projects/pi-agent-browser";
	const one = createImplicitSessionName(sessionId, cwd, "ignored-a");
	const two = createImplicitSessionName(sessionId, cwd, "ignored-b");

	assert.equal(one, two);
	assert.match(one, /^piab-pi-agent-browser-123456781234-[a-f0-9]{8}$/);
});

test("createImplicitSessionName includes cwd isolation for same-named checkouts", () => {
	const sessionId = "12345678-1234-5678-9abc-def012345678";
	const one = createImplicitSessionName(sessionId, "/tmp/foo/app", "ignored-a");
	const two = createImplicitSessionName(sessionId, "/tmp/bar/app", "ignored-b");

	assert.notEqual(one, two);
	assert.match(one, /^piab-app-123456781234-[a-f0-9]{8}$/);
	assert.match(two, /^piab-app-123456781234-[a-f0-9]{8}$/);
});

test("getAgentBrowserSocketDir uses a short user-specific unix socket directory and skips windows", () => {
	assert.equal(getAgentBrowserSocketDir("darwin", 501), "/tmp/piab-501");
	assert.equal(getAgentBrowserSocketDir("linux", 1000), "/tmp/piab-1000");
	assert.equal(getAgentBrowserSocketDir("win32", undefined), undefined);
});

test("hasUsableBraveApiKey only accepts non-empty values", () => {
	assert.equal(hasUsableBraveApiKey(null), false);
	assert.equal(hasUsableBraveApiKey(""), false);
	assert.equal(hasUsableBraveApiKey("   \n\t  "), false);
	assert.equal(hasUsableBraveApiKey("demo-key"), true);
});

test("shared parsing helpers preserve boundary parsing semantics", () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord([]), true);
	assert.equal(isRecord(null), false);
	assert.equal(isRecord("object"), false);

	assert.equal(parsePositiveInteger(undefined), undefined);
	assert.equal(parsePositiveInteger("42"), 42);
	assert.equal(parsePositiveInteger(" 42 "), 42);
	assert.equal(parsePositiveInteger("0"), undefined);
	assert.equal(parsePositiveInteger("-1"), undefined);
	assert.equal(parsePositiveInteger("1.5"), undefined);
	assert.equal(parsePositiveInteger("9007199254740992"), undefined);
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

test("restoreManagedSessionStateFromBranch ignores inspection entries and reconstructs the latest managed session", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["--version"],
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--profile", "Default", "open", "https://example.com/profile"],
					command: "open",
					exitCode: 0,
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["snapshot", "-i"],
					command: "snapshot",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.deepEqual(restored, {
		active: true,
		freshSessionOrdinal: 1,
		replacedSessionName: undefined,
		sessionName: "piab-demo-123-fresh-aaa",
	});
});

test("restoreManagedSessionStateFromBranch keeps cwd isolation by ignoring sessions from a different base name", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-other-checkout-123456781234-abcd1234",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.deepEqual(restored, {
		active: false,
		freshSessionOrdinal: 0,
		sessionName: "piab-demo-123",
	});
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
	await writeSecureTempRootOwnershipMarker(ownedRoot, { createdAtMs: staleTime.getTime(), ownerPid: 99_999_999 });
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

test("stale temp pruning does not remove a live root owned by another process", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
	const childScript = `
		import { dirname } from "node:path";
		import { openSecureTempFile } from "./extensions/agent-browser/lib/temp.ts";
		const tempFile = await openSecureTempFile("live-root", ".txt");
		await tempFile.fileHandle.close();
		console.log(JSON.stringify({ root: dirname(tempFile.path) }));
		setInterval(() => undefined, 1_000);
	`;
	const childA = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let liveRoot: string | undefined;
	try {
		liveRoot = (await readChildStdoutJsonLine<{ root: string }>(childA)).root;
		const markerPath = join(liveRoot, ".pi-agent-browser-owner.json");
		const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			markerPath,
			JSON.stringify({ ...marker, createdAtMs: staleTime.getTime(), leaseUpdatedAtMs: staleTime.getTime() }, null, 2),
			"utf8",
		);
		await utimes(liveRoot, staleTime, staleTime);
		const before = await stat(liveRoot).then(() => true, () => false);

		const childBScript = `
			import { openSecureTempFile } from "./extensions/agent-browser/lib/temp.ts";
			const tempFile = await openSecureTempFile("prune-trigger", ".txt");
			await tempFile.fileHandle.close();
			console.log(JSON.stringify({ done: true }));
		`;
		const childB = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childBScript], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const childBExit = once(childB, "exit");
		await readChildStdoutJsonLine<{ done: boolean }>(childB);
		const [childBExitCode] = await childBExit;
		assert.equal(childBExitCode, 0);

		const after = await stat(liveRoot).then(() => true, () => false);
		assert.deepEqual({ after, before }, { after: true, before: true });
	} finally {
		await stopChildProcess(childA);
		if (liveRoot) await rm(liveRoot, { force: true, recursive: true }).catch(() => undefined);
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

test("buildExecutionPlan keeps inspection commands stateless", () => {
	const plan = buildExecutionPlan(["--version"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.equal(plan.plainTextInspection, true);
	assert.deepEqual(plan.effectiveArgs, ["--version"]);
	assert.equal(plan.managedSessionName, undefined);
	assert.equal(plan.sessionName, undefined);
	assert.equal(plan.usedImplicitSession, false);
	assert.equal(plan.validationError, undefined);
});

test("buildExecutionPlan rejects missing values for value-taking flags before parsing commands", () => {
	for (const args of [["--session"], ["--profile"], ["--session-name"], ["--cdp"], ["--state"]] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.match(plan.validationError ?? "", /requires a value/i);
		assert.equal(plan.invalidValueFlag?.flag, args[0]);
		assert.equal(plan.invalidValueFlag?.reason, "missing-value");
		assert.deepEqual(plan.commandInfo, {});
		assert.equal(plan.sessionName, undefined);
		assert.equal(plan.usedImplicitSession, false);
	}
});

test("buildExecutionPlan rejects value-taking flags followed by another flag", () => {
	const plan = buildExecutionPlan(["--session", "--profile", "Default", "open", "https://example.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.match(plan.validationError ?? "", /received `--profile`/i);
	assert.equal(plan.invalidValueFlag?.flag, "--session");
	assert.equal(plan.invalidValueFlag?.reason, "unexpected-flag");
	assert.equal(plan.invalidValueFlag?.receivedToken, "--profile");
	assert.deepEqual(plan.commandInfo, {});
	assert.equal(plan.usedImplicitSession, false);
});

test("buildExecutionPlan blocks startup-scoped flags from silently reusing an active implicit session", () => {
	for (const args of [
		["--profile", "Default", "open", "https://example.com"],
		["--session-name", "saved-auth", "open", "https://example.com"],
		["--cdp", "ws://127.0.0.1:9222/devtools/browser/demo", "open", "https://example.com"],
		["--state", "/tmp/auth.json", "open", "https://example.com"],
		["--auto-connect", "open", "https://example.com"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.match(plan.validationError ?? "", /launch-scoped flags/i);
		assert.equal(plan.startupScopedFlags.length, 1);
		assert.equal(plan.startupScopedFlags[0], args[0]);
		assert.equal(plan.usedImplicitSession, false);
		assert.equal(plan.recoveryHint?.recommendedSessionMode, "fresh");
		assert.deepEqual(plan.recoveryHint?.exampleParams, { args: [...args], sessionMode: "fresh" });
	}
});

test("hasLaunchScopedTabCorrectionFlag detects profile, session-name, and state but not cdp or auto-connect", () => {
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--profile", "Default", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--profile=Default", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--session-name", "saved", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--session-name=saved", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--state", "/tmp/auth.json", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--state=/tmp/auth.json", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--cdp", "ws://127.0.0.1:9222/devtools/browser/demo", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--auto-connect", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["open", "https://example.com"]), false);
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

test("buildExecutionPlan injects the ChatGPT headless compatibility user-agent only when needed", () => {
	for (const targetUrl of ["https://chat.com", "https://chatgpt.com"] as const) {
		const plan = buildExecutionPlan(["--profile", "Default", "open", targetUrl], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});
		assert.equal(plan.compatibilityWorkaround?.id, "chatgpt-headless-user-agent");
		const userAgentFlagIndex = plan.effectiveArgs.indexOf("--user-agent");
		assert.ok(userAgentFlagIndex >= 0);
		assert.match(plan.effectiveArgs[userAgentFlagIndex + 1] ?? "", /Chrome\/146\.0\.0\.0/);
		assert.doesNotMatch(plan.effectiveArgs[userAgentFlagIndex + 1] ?? "", /HeadlessChrome/);
	}

	const callerProvidedUserAgentPlan = buildExecutionPlan(
		[
			"--profile",
			"Default",
			"--user-agent",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
			"open",
			"https://chatgpt.com",
		],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(callerProvidedUserAgentPlan.compatibilityWorkaround, undefined);
	assert.equal(callerProvidedUserAgentPlan.effectiveArgs.filter((token) => token === "--user-agent").length, 1);

	const headedPlan = buildExecutionPlan(["--profile", "Default", "--headed", "open", "https://chatgpt.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	assert.equal(headedPlan.compatibilityWorkaround, undefined);
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

test("redactInvocationArgs masks sensitive flags and auth-bearing urls", () => {
	assert.deepEqual(redactInvocationArgs(["--headers", '{"Authorization":"Bearer demo"}', "open", "https://user:pass@example.com/path?token=abc&ok=1#access_token=xyz"]), [
		"--headers",
		"[REDACTED]",
		"open",
		"https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/path?token=%5BREDACTED%5D&ok=1#access_token=%5BREDACTED%5D",
	]);
	assert.deepEqual(redactInvocationArgs(["open", "https://example.com/path?apiKey=abc&refreshToken=def&ok=1"]), [
		"open",
		"https://example.com/path?apiKey=%5BREDACTED%5D&refreshToken=%5BREDACTED%5D&ok=1",
	]);
	assert.deepEqual(redactInvocationArgs(["--proxy=http://user:pass@proxy.example:8080", "open", "https://example.com"]), [
		"--proxy=[REDACTED]",
		"open",
		"https://example.com/",
	]);
});

test("redactSensitiveValue masks obvious secret-bearing object keys", () => {
	assert.deepEqual(
		redactSensitiveValue({
			apiKey: "abc",
			nested: {
				authorization: "Bearer demo",
				ok: "https://example.com/?ok=1&token=abc",
				"set-cookie": "sid=abc",
			},
			status: { code: "ERR_BLOCKED_BY_CLIENT", key: "Enter" },
		}),
		{
			apiKey: "[REDACTED]",
			nested: {
				authorization: "[REDACTED]",
				ok: "https://example.com/?ok=1&token=%5BREDACTED%5D",
				"set-cookie": "[REDACTED]",
			},
			status: { code: "ERR_BLOCKED_BY_CLIENT", key: "Enter" },
		},
	);
});

test("shouldAppendBrowserSystemPrompt only targets clearly browser-oriented prompts", () => {
	assert.equal(shouldAppendBrowserSystemPrompt("Open https://example.com and take a snapshot."), true);
	assert.equal(shouldAppendBrowserSystemPrompt("Please review browser compatibility docs."), false);
	assert.equal(shouldAppendBrowserSystemPrompt("Summarize the article at https://example.com/blog/post for the changelog."), false);
	assert.equal(shouldAppendBrowserSystemPrompt("Please review the repository architecture."), false);
});

test("agentBrowserExtension keeps the full browser playbook in tool metadata and only injects a minimal browser prompt when relevant", async () => {
	await withPatchedEnv({ BRAVE_API_KEY: "demo-key" }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		assert.deepEqual([...harness.handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "tool_call"]);
		assert.equal(harness.tool.name, "agent_browser");
		assert.match(harness.tool.description, /authenticated\/profile-based browser work/);
		assert.match(harness.tool.promptSnippet, /real web workflows/);

		const expectedGuidelines = [
			...TOOL_PROMPT_GUIDELINES_PREFIX,
			...QUICK_START_GUIDELINES,
			SHARED_BROWSER_PLAYBOOK_GUIDELINES[0],
			BRAVE_SEARCH_PROMPT_GUIDELINE,
			...SHARED_BROWSER_PLAYBOOK_GUIDELINES.slice(1),
			...TOOL_PROMPT_GUIDELINES_SUFFIX,
		];
		for (const guideline of expectedGuidelines) {
			assert.equal(
				harness.tool.promptGuidelines.includes(guideline),
				true,
				`missing canonical playbook guideline: ${guideline}`,
			);
		}
		assert.equal(
			WRAPPER_TAB_RECOVERY_BEHAVIOR.some((line) => line.includes("After a successful command")),
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

test("agentBrowserExtension blocks direct and wrapped agent-browser bash unless the prompt explicitly allows it", async () => {
	const defaultHarness = createExtensionHarness({ cwd: process.cwd(), prompt: "Open a page and summarize it." });
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

	const debugHarness = createExtensionHarness({ cwd: process.cwd(), prompt: "Please debug the browser integration via bash." });
	const debugAllowed = await runExtensionEventResults(
		debugHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "npx --yes agent-browser open https://example.com" } },
		debugHarness.ctx,
	);
	assert.deepEqual(debugAllowed, []);
});

test("agentBrowserExtension keeps successful plain-text inspection stateless and machine-readable", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write("agent-browser 9.9.9\\n");`,
	);

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
			assert.equal(result.details?.inspection, true);
			assert.equal(result.details?.stdout, "agent-browser 9.9.9");
			assert.equal(result.details?.parseError, undefined);
			assert.equal(result.details?.sessionName, undefined);
			assert.equal(result.details?.usedImplicitSession, undefined);
			assert.deepEqual(await readInvocationLog(logPath), [{ args: ["--version"] }]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports the documented missing agent-browser binary contract", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-missing-bin-"));

	try {
		await withPatchedEnv({ PATH: tempDir }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--version"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /agent-browser is required but was not found on PATH\./);
			assert.match(text, /This project does not bundle agent-browser\./);
			assert.match(text, /Install it using the upstream docs:/);
			assert.match(text, /https:\/\/agent-browser\.dev\//);
			assert.match(text, /https:\/\/github\.com\/vercel-labs\/agent-browser/);
			assert.match(String(result.details?.spawnError ?? ""), /ENOENT/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension redacts sensitive args in updates and persisted details", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: "https://user:pass@example.com/?token=abc" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const updates: unknown[] = [];
			const result = (await harness.tool.execute(
				"test-tool-call",
				{ args: ["--headers", '{"Authorization":"Bearer s3cr3t-demo"}', "open", "https://user:pass@example.com/?token=abc"] },
				new AbortController().signal,
				(update) => updates.push(update),
				harness.ctx,
			)) as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean };

			assert.equal(result.isError, false);
			assert.equal(Array.isArray(updates), true);
			const update = updates[0] as { content?: Array<{ text?: string }>; details?: Record<string, unknown> } | undefined;
			assert.match(update?.content?.[0]?.text ?? "", /\[REDACTED\]/);
			assert.doesNotMatch(update?.content?.[0]?.text ?? "", /s3cr3t-demo/);
			assert.doesNotMatch(update?.content?.[0]?.text ?? "", /user:pass/);
			assert.deepEqual(result.details?.args, [
				"--headers",
				"[REDACTED]",
				"open",
				"https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/?token=%5BREDACTED%5D",
			]);
			assert.equal(JSON.stringify(result.details?.effectiveArgs).includes("s3cr3t-demo"), false);
			assert.equal(JSON.stringify(result.details?.effectiveArgs).includes("user:pass"), false);
			assert.equal(JSON.stringify(result.details?.data).includes("user:pass"), false);
			assert.equal(JSON.stringify(result.content).includes("user:pass"), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects dangling value-taking flags before spawning agent-browser", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /requires a value immediately after it/i);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.flag,
				"--session",
			);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.reason,
				"missing-value",
			);
			assert.deepEqual(await readInvocationLog(logPath), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";
const NON_BOOLEAN_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: success field must be boolean.";

test("agentBrowserExtension rejects malformed JSON envelopes that omit success", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ error: "boom" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.equal((result.content[0] as { text: string }).text, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.parseError, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.summary, MISSING_SUCCESS_PARSE_ERROR);
			assert.doesNotMatch(String(result.details?.summary ?? ""), /^open completed$/i);
			assert.equal(result.details?.error, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports direct fallback failures with the effective invocation", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, data: { title: "Wrong page" } }));
process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /^agent-browser --json --session \S+ open https:\/\/example\.com\/? reported failure \(exit code 1\)\.$/);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(0, 3), ["--json", "--session", result.details?.sessionName]);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["open", "https://example.com/"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports wrapper-assisted fallback failures with effective batch context", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["tab", "t1"], success: true, result: { tabId: "t1" } },
    { command: ["get", "title"], success: false, result: { title: "Wrong page" } }
  ]));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
  { tabId: "t2", title: "Other", url: "https://other.example/", active: true }
] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "get", "title"],
			});

			assert.equal(result.isError, true, JSON.stringify(result));
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /agent-browser --json --session named batch reported failure \(exit code 1\)\./);
			assert.match(text, /Wrapper recovery hint:/);
			assert.match(text, /tab list/);
			assert.deepEqual(result.details?.effectiveArgs, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String((await readInvocationLog(logPath))[1]?.stdin ?? "[]")), [["tab", "t1"], ["get", "title"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves full spilled stdout for oversized parse failures", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
	const sessionFile = join(sessionDir, "session.jsonl");
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-parse-failure-sentinel";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "-i"],
			});

			assert.equal(result.isError, true);
			assert.match(String(result.details?.parseError ?? ""), /invalid JSON/i);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Full output path: /);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			assert.equal(result.details?.fullOutputUnavailable, undefined);
			const fullOutputPath = result.details?.fullOutputPath as string;
			assert.equal(fullOutputPath.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
			const stats = await stat(fullOutputPath);
			assert.ok(stats.size > 512 * 1024);
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
			await runExtensionEvent(harness.handlers, "session_shutdown");
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns temp full-output path for oversized parse failures without session artifacts", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-temp-parse-failure-sentinel";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "document.body.innerText",
			});

			assert.equal(result.isError, true);
			assert.match(String(result.details?.parseError ?? ""), /invalid JSON/i);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Full output path: /);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			assert.equal(result.details?.fullOutputUnavailable, undefined);
			const fullOutputPath = result.details?.fullOutputPath as string;
			const stats = await stat(fullOutputPath);
			assert.ok(stats.size > 512 * 1024);
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("parseCommandInfo skips global flags with values", () => {
	const commandInfo = parseCommandInfo(["--session", "named", "--profile", "./profile", "tab", "list"]);
	assert.deepEqual(commandInfo, { command: "tab", subcommand: "list" });
});

test("parseCommandInfo treats compatibility and launch flag values as non-command tokens", () => {
	const commandInfo = parseCommandInfo([
		"--user-agent",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		"--args",
		"--disable-gpu,--lang=en-US",
		"open",
		"https://example.com",
	]);
	assert.deepEqual(commandInfo, { command: "open", subcommand: "https://example.com" });
});

test("extractCommandTokens strips wrapper-level global flags and keeps the command tail intact", () => {
	assert.deepEqual(extractCommandTokens(["--session", "named", "snapshot", "-i"]), ["snapshot", "-i"]);
	assert.deepEqual(
		extractCommandTokens([
			"--session",
			"named",
			"--user-agent",
			"Mozilla/5.0",
			"click",
			"@e9",
		]),
		["click", "@e9"],
	);
});

test("chooseOpenResultTabCorrection targets the navigated tab without disturbing already-correct active tabs", () => {
	assert.deepEqual(
		chooseOpenResultTabCorrection({
			tabs: [
				{ active: false, tabId: "t1", title: "Example Domain", url: "https://example.com/" },
				{ active: true, tabId: "t2", title: "Grok", url: "https://grok.com/" },
			],
			targetTitle: "Example Domain",
			targetUrl: "https://example.com",
		}),
		{ selectedTab: "t1", selectionKind: "tabId", targetTitle: "Example Domain", targetUrl: "https://example.com/" },
	);
	assert.equal(
		chooseOpenResultTabCorrection({
			tabs: [{ active: true, tabId: "t1", title: "Example Domain", url: "https://example.com/" }],
			targetTitle: "Example Domain",
			targetUrl: "https://example.com/",
		}),
		undefined,
	);
});

test("buildToolPresentation renders stable tab ids from tab list output", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "tab", subcommand: "list" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				tabs: [
					{ active: false, tabId: "t1", title: "ChatGPT", url: "https://chatgpt.com/" },
					{ active: true, tabId: "t2", title: "Grok", url: "https://grok.com/" },
				],
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /- \[t1\] ChatGPT — https:\/\/chatgpt\.com\//);
	assert.match((presentation.content[0] as { text: string }).text, /\* \[t2\] Grok — https:\/\/grok\.com\//);
	assert.equal(presentation.summary, "Tabs: 2");
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

test("parseAgentBrowserEnvelope rejects object envelopes without boolean success", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ error: "boom" }));

	assert.equal(parsed.envelope, undefined);
	assert.equal(parsed.parseError, MISSING_SUCCESS_PARSE_ERROR);
});

test("parseAgentBrowserEnvelope rejects object envelopes with non-boolean success", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ success: "true", data: { title: "ok" } }));

	assert.equal(parsed.envelope, undefined);
	assert.equal(parsed.parseError, NON_BOOLEAN_SUCCESS_PARSE_ERROR);
});

test("parseAgentBrowserEnvelope accepts valid object envelopes with boolean success", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ success: true, data: { title: "ok" } }));

	assert.equal(parsed.parseError, undefined);
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

test("getAgentBrowserErrorText falls back to stderr or an invocation-aware message when a failed envelope has no simple error field", () => {
	const stderrFallback = getAgentBrowserErrorText({
		aborted: false,
		command: "open",
		effectiveArgs: ["--json", "open", "https://example.com"],
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "Navigation failed upstream",
	});
	const invocationFallback = getAgentBrowserErrorText({
		aborted: false,
		command: "open",
		effectiveArgs: ["--json", "open", "https://example.com"],
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(stderrFallback, "Navigation failed upstream");
	assert.equal(invocationFallback, "agent-browser --json open https://example.com reported failure (exit code 1).");
});

test("getAgentBrowserErrorText falls back to command-aware exit codes when no envelope error exists", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		command: "snapshot",
		envelope: { success: true, data: null },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "agent-browser snapshot exited with code 1.");
});

test("getAgentBrowserErrorText appends wrapper recovery hints only to fallback messages", () => {
	const wrapperRecoveryHint = "Wrapper recovery hint: inspect details.effectiveArgs and run tab list before retrying.";
	const fallbackErrorText = getAgentBrowserErrorText({
		aborted: false,
		command: "batch",
		effectiveArgs: ["--json", "--session", "named", "batch"],
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
		wrapperRecoveryHint,
	});
	const explicitErrorText = getAgentBrowserErrorText({
		aborted: false,
		command: "batch",
		effectiveArgs: ["--json", "--session", "named", "batch"],
		envelope: { success: false, error: "Upstream failure" },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
		wrapperRecoveryHint,
	});

	assert.equal(
		fallbackErrorText,
		"agent-browser --json --session named batch reported failure (exit code 1).\nWrapper recovery hint: inspect details.effectiveArgs and run tab list before retrying.",
	);
	assert.equal(explicitErrorText, "Upstream failure");
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

test("buildToolPresentation formats scalar extraction results for eval and get commands", async () => {
	const evalPresentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				result: "Example Domain",
			},
		},
	});
	assert.equal(evalPresentation.content[0]?.type, "text");
	assert.equal((evalPresentation.content[0] as { text: string }).text, "Example Domain\n\nOrigin: https://example.com/");
	assert.equal(evalPresentation.summary, "Eval result: Example Domain");

	const getPresentation = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "title" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				result: "Example Domain",
			},
		},
	});
	assert.equal(getPresentation.content[0]?.type, "text");
	assert.equal((getPresentation.content[0] as { text: string }).text, "Example Domain\n\nOrigin: https://example.com/");
	assert.equal(getPresentation.summary, "Title: Example Domain");
});

test("buildToolPresentation formats download results as saved-file summaries", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "download", subcommand: "@e5" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				path: "/tmp/report.pdf",
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.equal((presentation.content[0] as { text: string }).text, "Downloaded file: /tmp/report.pdf");
	assert.equal(presentation.summary, "Downloaded file: /tmp/report.pdf");
});

test("buildToolPresentation compacts oversized generic outputs and prints the actual spill path", async () => {
	const largeText = Array.from({ length: 220 }, (_, index) => `Large eval row ${index + 1}: ${"x".repeat(80)}`).join("\n");
	const presentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/large-eval",
				result: largeText,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Large eval output compacted/);
	assert.match(text, /Full output path: /);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(await readFile(String(spillPath), "utf8"), /Large eval row 220/);
	await rm(String(spillPath), { force: true });
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

test("buildToolPresentation keeps eval image-like string results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-image-"));
	const imagePath = join(tempDir, "secret.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "eval", subcommand: "--stdin" },
			cwd: tempDir,
			envelope: { success: true, data: "secret.png" },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, "secret.png");
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation keeps get absolute image path results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-absolute-image-"));
	const imagePath = join(tempDir, "secret.jpg");
	await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "get", subcommand: "text" },
			cwd: process.cwd(),
			envelope: { success: true, data: imagePath },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, imagePath);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation does not inline non-screenshot path records with image extensions", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-download-image-"));
	const imagePath = join(tempDir, "downloaded.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "download", subcommand: "@e5" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "downloaded.png" } },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, "Downloaded file: downloaded.png");
		assert.equal(presentation.summary, "Downloaded file: downloaded.png");
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
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
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal(presentation.batchSteps?.length, 1);
	assert.equal(typeof presentation.batchSteps?.[0]?.fullOutputPath, "string");
	assert.match(presentation.batchSteps?.[0]?.text ?? "", /Compact snapshot view/);

	const spillPath = presentation.batchSteps?.[0]?.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
	assert.match(presentation.summary, /Snapshot: 90 refs on https:\/\/example.com\/huge \(compact\)/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const spillText = await readFile(spillPath, "utf8");
	const spillStats = await stat(spillPath);
	const spillDirStats = await stat(dirname(spillPath));
	assert.match(spillText, /Large snapshot row 120/);
	assert.match(spillText, /Actionable control 1/);
	assert.equal(spillStats.mode & 0o777, 0o600);
	assert.equal(spillDirStats.mode & 0o777, 0o700);
	await rm(spillPath, { force: true });
});

test("buildToolPresentation keeps compact snapshot spill files in the persisted session artifact directory when available", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-store-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Persisted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `- generic \"Persisted snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n");

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "snapshot" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: {
					origin: "https://example.com/persisted",
					refs,
					snapshot,
				},
			},
			persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
		});

		const spillPath = presentation.fullOutputPath;
		assert.equal(typeof spillPath, "string");
		assert.equal(spillPath?.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
		await cleanupSecureTempArtifacts();
		assert.match(await readFile(String(spillPath), "utf8"), /Persisted snapshot row 120/);
		assert.equal((await stat(String(spillPath))).mode & 0o777, 0o600);
		assert.equal((await stat(dirname(String(spillPath)))).mode & 0o777, 0o700);
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation evicts the oldest persisted snapshot spill files when the per-session artifact budget is exceeded", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-budget-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Budgeted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildData("first");
	const secondData = buildData("second");
	const budgetBytes = Math.max(
		Buffer.byteLength(JSON.stringify(firstData, null, 2)),
		Buffer.byteLength(JSON.stringify(secondData, null, 2)),
	) + 512;

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const firstPresentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: { success: true, data: firstData },
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});
			const secondPresentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: { success: true, data: secondData },
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});

			assert.equal(typeof firstPresentation.fullOutputPath, "string");
			assert.equal(typeof secondPresentation.fullOutputPath, "string");
			assert.equal(await readFile(String(firstPresentation.fullOutputPath), "utf8").then(() => true, () => false), false);
			assert.match(await readFile(String(secondPresentation.fullOutputPath), "utf8"), /second snapshot row 120/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation keeps earlier batch snapshot spill paths live when a later persisted spill exceeds the budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-batch-budget-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Batch control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildSnapshotData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} batch snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildSnapshotData("first");
	const secondData = buildSnapshotData("second");
	const budgetBytes = Buffer.byteLength(JSON.stringify(firstData, null, 2)) + 512;

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: process.cwd(),
				envelope: {
					success: true,
					data: [
						{ command: ["snapshot", "-i"], result: firstData, success: true },
						{ command: ["snapshot", "-i"], result: secondData, success: true },
					],
				},
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});
			const firstPath = presentation.batchSteps?.[0]?.fullOutputPath;
			const secondPath = presentation.batchSteps?.[1]?.fullOutputPath;
			assert.equal(typeof firstPath, "string");
			assert.equal(secondPath, undefined);
			assert.match(await readFile(String(firstPath), "utf8"), /first batch snapshot row 120/);
			assert.match(presentation.batchSteps?.[1]?.text ?? "", /persisted spill budget exceeded/i);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
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

test("agentBrowserExtension persists compact snapshot spill files for persisted sessions across shutdown cleanup", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
	const sessionFile = join(sessionDir, "session.jsonl");
	const basePath = process.env.PATH ?? "";
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Extension persisted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `- generic \"Extension persisted snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: ${JSON.stringify({ origin: "https://example.com/persisted-extension", refs, snapshot })} }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(result.isError, false);
			const spillPath = result.details?.fullOutputPath as string | undefined;
			assert.equal(typeof spillPath, "string");
			assert.equal(spillPath?.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
			await runExtensionEvent(harness.handlers, "session_shutdown");
			assert.match(await readFile(String(spillPath), "utf8"), /Extension persisted snapshot row 120/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
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
			assert.match((result.content[0] as { text: string }).text, /Step 1 — open https:\/\/example.com\/? \(succeeded\)/);
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

test("agentBrowserExtension re-selects the navigated tab after profiled opens when restored tabs steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Grok", url: "https://grok.com/", active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.openResultTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.deepEqual(invocations[0]?.args, [
				"--json",
				"--session",
				"named",
				"--profile",
				"Default",
				"open",
				"https://example.com",
			]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pins the intended tab inside a follow-up command when reconnect drift would otherwise steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? exampleSite : gemini;
      return { command: step, success: true, result: active };
    }
    if (command === "click") {
      return { command: step, success: true, result: { clicked: rest[0] } };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.indexOf("click") + 1] } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: gemini.title }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: gemini.url }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: gemini }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
			});
			assert.equal(initialOpen.isError, false, JSON.stringify(initialOpen));

			const clickedSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string } | undefined)?.title,
				"Example Domain",
			);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { url?: string } | undefined)?.url,
				"https://example.com/",
			);
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.match((clickedSelector.content[0] as { text: string }).text, /Current page:/);
			assert.match((clickedSelector.content[0] as { text: string }).text, /Example Domain/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 5);
			assert.deepEqual(invocations[0]?.args, [
				"--json",
				"--session",
				"named",
				"--profile",
				"Default",
				"open",
				"https://example.com",
			]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "t1"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[4]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["get", "title"],
				["get", "url"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-selects the intended tab after a successful command when focus drifts afterward", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
let state = { active: "example", tabListCount: 0 };
try {
  state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
} catch {}
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("tab") && args.includes("list")) {
  state.tabListCount += 1;
  const activeKey = state.tabListCount === 1 ? "example" : state.active;
  const activeSite = activeKey === "example" ? exampleSite : gemini;
  const inactiveSite = activeKey === "example" ? gemini : exampleSite;
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: activeKey === "example" ? "t1" : "t2", title: activeSite.title, url: activeSite.url, active: true },
    { tabId: activeKey === "example" ? "t2" : "t1", title: inactiveSite.title, url: inactiveSite.url, active: false }
  ] } }));
} else if (args.includes("click")) {
  state.active = "gemini";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.indexOf("click") + 1], title: exampleSite.title, url: exampleSite.url } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else {
  save();
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const clickedSelector = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false, JSON.stringify(clickedSelector));
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 4);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "click", "@e9"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "t1"]);
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
		`const readEnv = (name) => process.env[name] ?? null;
const envelope = {
  success: true,
  data: {
    agentBrowserActionPolicy: readEnv("AGENT_BROWSER_ACTION_POLICY"),
    agentBrowserConfig: readEnv("AGENT_BROWSER_CONFIG"),
    agentBrowserConfirmActions: readEnv("AGENT_BROWSER_CONFIRM_ACTIONS"),
    agentBrowserEncryptionKey: readEnv("AGENT_BROWSER_ENCRYPTION_KEY"),
    agentBrowserScreenshotDir: readEnv("AGENT_BROWSER_SCREENSHOT_DIR"),
    agentBrowserSession: readEnv("AGENT_BROWSER_SESSION"),
    agentBrowserSessionName: readEnv("AGENT_BROWSER_SESSION_NAME"),
    agentcoreRegion: readEnv("AGENTCORE_REGION"),
    aiGatewayApiKey: readEnv("AI_GATEWAY_API_KEY"),
    awsAccessKeyId: readEnv("AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: readEnv("AWS_SECRET_ACCESS_KEY"),
    browserbaseApiKey: readEnv("BROWSERBASE_API_KEY"),
    browserlessApiKey: readEnv("BROWSERLESS_API_KEY"),
    browserUseApiKey: readEnv("BROWSER_USE_API_KEY"),
    databaseUrl: readEnv("DATABASE_URL"),
    idleTimeout: readEnv("AGENT_BROWSER_IDLE_TIMEOUT_MS"),
    kernelApiKey: readEnv("KERNEL_API_KEY"),
    lang: readEnv("LANG"),
    openaiApiKey: readEnv("OPENAI_API_KEY"),
    secret: readEnv("PI_AGENT_BROWSER_TEST_SECRET"),
    socketDir: readEnv("AGENT_BROWSER_SOCKET_DIR"),
    unrelatedApiKey: readEnv("UNRELATED_API_KEY"),
    pathStartsWithTemp: (process.env.PATH ?? "").startsWith(${JSON.stringify(tempDir)})
  }
};
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv(
			{
				AGENT_BROWSER_ACTION_POLICY: "/tmp/action-policy.json",
				AGENT_BROWSER_CONFIG: "/tmp/agent-browser.json",
				AGENT_BROWSER_CONFIRM_ACTIONS: "1",
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				AGENT_BROWSER_SCREENSHOT_DIR: "/tmp/agent-browser-screenshots",
				AGENT_BROWSER_SESSION: "from-parent-session",
				AGENT_BROWSER_SESSION_NAME: "from-parent-session-name",
				AGENT_BROWSER_SOCKET_DIR: "/tmp/from-parent-should-not-leak",
				AGENTCORE_REGION: "us-west-2",
				AI_GATEWAY_API_KEY: "ai-gateway-key",
				AWS_ACCESS_KEY_ID: "aws-access-key-id",
				AWS_SECRET_ACCESS_KEY: "aws-secret-access-key",
				BROWSERBASE_API_KEY: "browserbase-key",
				BROWSERLESS_API_KEY: "browserless-key",
				BROWSER_USE_API_KEY: "browser-use-key",
				DATABASE_URL: "postgres://should-not-leak",
				KERNEL_API_KEY: "kernel-key",
				LANG: "en_US.UTF-8",
				OPENAI_API_KEY: "openai-should-not-leak",
				PI_AGENT_BROWSER_TEST_SECRET: "should-not-leak",
				UNRELATED_API_KEY: "unrelated-should-not-leak",
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
					agentBrowserActionPolicy: string | null;
					agentBrowserConfig: string | null;
					agentBrowserConfirmActions: string | null;
					agentBrowserEncryptionKey: string | null;
					agentBrowserScreenshotDir: string | null;
					agentBrowserSession: string | null;
					agentBrowserSessionName: string | null;
					agentcoreRegion: string | null;
					aiGatewayApiKey: string | null;
					awsAccessKeyId: string | null;
					awsSecretAccessKey: string | null;
					browserbaseApiKey: string | null;
					browserlessApiKey: string | null;
					browserUseApiKey: string | null;
					databaseUrl: string | null;
					idleTimeout: string | null;
					kernelApiKey: string | null;
					lang: string | null;
					openaiApiKey: string | null;
					pathStartsWithTemp: boolean;
					secret: string | null;
					socketDir: string | null;
					unrelatedApiKey: string | null;
				};
				assert.equal(data.agentBrowserActionPolicy, "/tmp/action-policy.json");
				assert.equal(data.agentBrowserConfig, "/tmp/agent-browser.json");
				assert.equal(data.agentBrowserConfirmActions, "1");
				assert.equal(data.agentBrowserEncryptionKey, "a".repeat(64));
				assert.equal(data.agentBrowserScreenshotDir, "/tmp/agent-browser-screenshots");
				assert.equal(data.agentBrowserSession, "from-parent-session");
				assert.equal(data.agentBrowserSessionName, "from-parent-session-name");
				assert.equal(data.agentcoreRegion, "us-west-2");
				assert.equal(data.aiGatewayApiKey, "ai-gateway-key");
				assert.equal(data.awsAccessKeyId, "aws-access-key-id");
				assert.equal(data.awsSecretAccessKey, "aws-secret-access-key");
				assert.equal(data.browserbaseApiKey, "browserbase-key");
				assert.equal(data.browserlessApiKey, "browserless-key");
				assert.equal(data.browserUseApiKey, "browser-use-key");
				assert.equal(data.databaseUrl, null);
				assert.equal(data.idleTimeout, "1234");
				assert.equal(data.kernelApiKey, "kernel-key");
				assert.equal(data.lang, "en_US.UTF-8");
				assert.equal(data.openaiApiKey, null);
				assert.equal(data.secret, null);
				assert.equal(data.socketDir, getAgentBrowserSocketDir());
				if (data.socketDir) {
					assert.equal((await stat(data.socketDir)).isDirectory(), true);
				}
				assert.equal(data.unrelatedApiKey, null);
				assert.equal(data.pathStartsWithTemp, true);
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reconstructs managed session state on session_start and keeps startup-scoped flags blocked after resume", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);

			const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["open", "https://example.com/first"],
			});
			assert.equal(firstOpen.isError, false);
			await runExtensionEvent(firstHarness.handlers, "session_shutdown");
			assert.equal((await readInvocationLog(logPath)).length, 1);

			const resumedBranch = [
				createToolBranchEntry({
					details: firstOpen.details ?? {},
					isError: firstOpen.isError,
				}),
			];
			const resumedHarness = createExtensionHarness({ branch: resumedBranch, cwd: tempDir });
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const blocked = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profiled"],
			});
			assert.equal(blocked.isError, true);
			assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
			assert.equal((await readInvocationLog(logPath)).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not restore a managed session from a different cwd/worktree on resume", { concurrency: false }, async () => {
	const firstParent = await mkdtemp(join(tmpdir(), "pi-agent-browser-first-"));
	const secondParent = await mkdtemp(join(tmpdir(), "pi-agent-browser-second-"));
	const firstDir = join(firstParent, "checkout");
	const secondDir = join(secondParent, "checkout");
	const binDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bin-"));
	const logPath = join(binDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await mkdir(firstDir, { recursive: true });
	await mkdir(secondDir, { recursive: true });
	await writeFakeAgentBrowserBinary(
		binDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { url: args[args.length - 1] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${binDir}:${basePath}` }, async () => {
			const firstHarness = createExtensionHarness({ cwd: firstDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);
			const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["open", "https://example.com/first"],
			});
			assert.equal(firstOpen.isError, false);
			const firstSessionName = firstOpen.details?.sessionName;
			assert.equal(typeof firstSessionName, "string");

			const resumedHarness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: firstOpen.details ?? {}, isError: firstOpen.isError })],
				cwd: secondDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const profiledOpen = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profiled"],
			});
			assert.equal(profiledOpen.isError, false);
			assert.equal((profiledOpen.details?.effectiveArgs as string[] | undefined)?.includes("--profile"), true);
			assert.notEqual(profiledOpen.details?.sessionName, firstSessionName);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.equal(invocations[1]?.args.includes("--profile"), true);
			assert.equal(invocations[1]?.args.includes(String(firstSessionName)), false);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", String(profiledOpen.details?.sessionName), "tab", "list"]);
		});
	} finally {
		await rm(firstParent, { force: true, recursive: true });
		await rm(secondParent, { force: true, recursive: true });
		await rm(binDir, { force: true, recursive: true });
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
					assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
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
					assert.equal(finalInvocations.length, 4);
					assert.equal(finalInvocations[2]?.args.includes("--profile"), true);
					assert.deepEqual(finalInvocations[3]?.args, ["--json", "--session", String(reopened.details?.sessionName), "tab", "list"]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("agentBrowserExtension restores the rotated fresh managed session across resume and reuses it on follow-up auto calls", { concurrency: false }, async () => {
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
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);

			const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["open", "https://example.com"],
			});
			assert.equal(firstOpen.isError, false);
			const firstSessionName = firstOpen.details?.sessionName;
			assert.equal(typeof firstSessionName, "string");

			const profiledOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
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
			await runExtensionEvent(firstHarness.handlers, "session_shutdown");

			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({ details: firstOpen.details ?? {}, isError: firstOpen.isError }),
					createToolBranchEntry({ details: profiledOpen.details ?? {}, isError: profiledOpen.isError }),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const followUpSnapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["snapshot", "-i"],
			});
			assert.equal(followUpSnapshot.isError, false);
			assert.equal(followUpSnapshot.details?.sessionName, freshSessionName);
			assert.equal(followUpSnapshot.details?.usedImplicitSession, true);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 6);
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
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", String(freshSessionName), "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--session", String(firstSessionName), "close"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", String(freshSessionName), "tab", "list"]);
			assert.deepEqual(invocations[5]?.args, ["--json", "--session", String(freshSessionName), "snapshot", "-i"]);
			assert.equal(invocations[5]?.idleTimeout, "1234");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension restores pinned tab targets across resume for explicit sessions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? exampleSite : gemini;
      return { command: step, success: true, result: active };
    }
    if (command === "snapshot") {
      return {
        command: step,
        success: true,
        result: {
          origin: active.url,
          refs: { e1: { name: active.title, role: "heading" } },
          snapshot: '- heading "' + active.title + '" [level=1, ref=e1]',
        },
      };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: gemini.url,
    refs: { e1: { name: gemini.title, role: "heading" } },
    snapshot: '- heading "Google Gemini" [level=1, ref=e1]'
  } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const snapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "snapshot", "-i"],
			});
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.deepEqual(snapshot.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.match((snapshot.content[0] as { text: string }).text, /Example Domain/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [["tab", "t1"], ["snapshot", "-i"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pre-pins resumed explicit-session eval stdin before execution", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
let state = { active: "gemini" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
const activeSite = () => state.active === "example" ? exampleSite : gemini;
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: state.active === "example" },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: state.active !== "example" }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: activeSite().title }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: activeSite() }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const evalResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "eval", "--stdin"],
				stdin: "document.title",
			});
			assert.equal(evalResult.isError, false, JSON.stringify(evalResult));
			assert.match((evalResult.content[0] as { text: string }).text, /Example Domain/);
			assert.deepEqual(evalResult.details?.sessionTabTarget, {
				title: "Example Domain",
				url: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "t1"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "eval", "--stdin"]);
			assert.equal(invocations[2]?.stdin, "document.title");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects unsupported stdin before resumed explicit-session tab planning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Wrong", url: "https://wrong.example/" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const result = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
				stdin: "oops",
			});

			assert.equal(result.isError, true, JSON.stringify(result));
			assert.match(String(result.details?.validationError ?? ""), /stdin/i);
			assert.match(String(result.details?.validationError ?? ""), /batch/i);
			assert.match(String(result.details?.validationError ?? ""), /eval --stdin/i);
			assert.match(String((result.content[0] as { text: string }).text ?? ""), /stdin/i);
			assert.equal(result.details?.sessionName, "named");

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations, []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pre-pins resumed explicit-session user batch and derives the resulting target", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const sites = {
  example: { title: "Example Domain", url: "https://example.com/" },
  gemini: { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" },
  org: { title: "Example Org", url: "https://example.org/" }
};
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = sites.gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? sites.example : sites.gemini;
      return { command: step, success: true, result: { tabId: rest[0], ...active } };
    }
    if (command === "open") {
      active = sites.org;
      return { command: step, success: true, result: active };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: sites.example.title, url: sites.example.url, active: false },
    { tabId: "t2", title: sites.gemini.title, url: sites.gemini.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: sites.gemini }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "batch"],
				stdin: JSON.stringify([["open", "https://example.org"], ["get", "title"], ["get", "url"]]),
			});
			assert.equal(batchResult.isError, false, JSON.stringify(batchResult));
			assert.match((batchResult.content[0] as { text: string }).text, /Example Org/);
			assert.deepEqual(batchResult.details?.sessionTabTarget, {
				title: "Example Org",
				url: "https://example.org/",
			});
			const batchSteps = batchResult.details?.batchSteps as Array<{ command?: string[] }> | undefined;
			assert.deepEqual(batchSteps?.map((step) => step.command), [
				["open", "https://example.org/"],
				["get", "title"],
				["get", "url"],
			]);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [
				["tab", "t1"],
				["open", "https://example.org"],
				["get", "title"],
				["get", "url"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects malformed resumed explicit-session batch stdin before user batch execution", { concurrency: false }, async () => {
	const scenarios = [
		{
			name: "invalid JSON",
			stdin: "not-json",
			errorPattern: /could not be parsed as JSON/i,
		},
		{
			name: "non-array step",
			stdin: JSON.stringify([{ oops: 1 }]),
			errorPattern: /step 0 must be a non-empty array of string command tokens/i,
		},
		{
			name: "empty step",
			stdin: JSON.stringify([[]]),
			errorPattern: /step 0 must not be empty/i,
		},
		{
			name: "non-string token",
			stdin: JSON.stringify([["click", 123]]),
			errorPattern: /step 0 token 1 must be a string/i,
		},
	] as const;

	for (const scenario of scenarios) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify({ success: true, data: [{ command: ["batch"], success: true, result: "should not run" }] }));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en", active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Unexpected", url: "https://unexpected.example/" } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const resumedHarness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://example.com"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

				const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["--session", "named", "batch"],
					stdin: scenario.stdin,
				});
				assert.equal(batchResult.isError, true, `${scenario.name}: ${JSON.stringify(batchResult)}`);
				assert.match(String(batchResult.details?.validationError ?? ""), scenario.errorPattern, scenario.name);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 1, scenario.name);
				assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"], scenario.name);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}
});

test("agentBrowserExtension does not combine stale batch title with a later url after intervening commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
let active = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
const example = { title: "Example Domain", url: "https://example.com/" };
const org = { title: "Example Org", url: "https://example.org/" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? example : active;
      return { command: step, success: true, result: { tabId: rest[0], ...active } };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "open") {
      active = org;
      return { command: step, success: true, result: { status: "navigated" } };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: { status: "ok" } };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: example.title, url: example.url, active: false },
    { tabId: "t2", title: active.title, url: active.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: active }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "batch"],
				stdin: JSON.stringify([["get", "title"], ["open", "https://example.org"], ["get", "url"]]),
			});
			assert.equal(batchResult.isError, false, JSON.stringify(batchResult));
			assert.deepEqual(batchResult.details?.sessionTabTarget, { title: undefined, url: "https://example.org/" });

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [
				["tab", "t1"],
				["get", "title"],
				["open", "https://example.org"],
				["get", "url"],
			]);
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
			assert.equal(invocations.length, 3);
			assert.equal(invocations[1]?.args.includes("--profile"), true);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", String(followUp.details?.sessionName), "tab", "list"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks launch-scoped --state and --auto-connect flags after an implicit session is active", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: args[args.length - 1] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});
			assert.equal(firstOpen.isError, false);

			for (const args of [
				["--state", "/tmp/auth.json", "open", "https://example.com/state"],
				["--auto-connect", "open", "https://example.com/auto"],
			] as const) {
				const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(blocked.isError, true, `expected ${args[0]} to be blocked`);
				assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
				assert.equal(blocked.details?.sessionMode, "auto");
				assert.equal(
					(blocked.details?.sessionRecoveryHint as { recommendedSessionMode?: string } | undefined)?.recommendedSessionMode,
					"fresh",
				);
			}

			assert.equal((await readInvocationLog(logPath)).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-selects the navigated tab after --session-name fresh opens when restored tabs steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Restored Tab", url: "https://restored.example.com/", active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session-name", "saved-auth", "open", "https://example.com"],
				sessionMode: "fresh",
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.openResultTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.equal(invocations[0]?.args.includes("--session-name"), true);
			assert.deepEqual(invocations[1]?.args?.slice(-2), ["tab", "list"]);
			assert.deepEqual(invocations[2]?.args?.slice(-2), ["tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
