/**
 * Purpose: Verify pure runtime planning and policy helpers for the pi-agent-browser extension.
 * Responsibilities: Assert session naming, managed-session restoration, execution-plan argument injection, prompt policy detection, redaction, and secure temp lifecycle edge cases owned by runtime/temp helpers.
 * Scope: Unit-style Node test-runner coverage for stable helper behavior; extension entrypoint lifecycle tests live in focused integration suites.
 * Usage: Run with `npm test -- test/agent-browser.runtime.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests preserve existing assertions and isolate filesystem/env side effects with temp directories and explicit cleanup.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { isRecord, parsePositiveInteger } from "../extensions/agent-browser/lib/parsing.js";
import { getAgentBrowserSocketDir } from "../extensions/agent-browser/lib/process.js";
import {
	buildExecutionPlan,
	buildPromptPolicy,
	createFreshSessionName,
	createImplicitSessionName,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	getLatestUserPrompt,
	hasLaunchScopedTabCorrectionFlag,
	hasUsableBraveApiKey,
	redactInvocationArgs,
	redactSensitiveValue,
	resolveManagedSessionState,
	restoreManagedSessionStateFromBranch,
	shouldAppendBrowserSystemPrompt,
} from "../extensions/agent-browser/lib/runtime.js";
import {
	cleanupSecureTempArtifacts,
	getSecureTempDebugState,
	openSecureTempFile,
	writeSecureTempFile,
	writeSecureTempRootOwnershipMarker,
} from "../extensions/agent-browser/lib/temp.js";
import {
	createToolBranchEntry,
	readChildStdoutJsonLine,
	stopChildProcess,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

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

