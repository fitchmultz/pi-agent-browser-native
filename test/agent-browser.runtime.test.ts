/**
 * Purpose: Verify pure runtime planning and policy helpers for the pi-agent-browser extension.
 * Responsibilities: Assert session naming/state, execution-plan argument injection, and redaction helpers.
 * Scope: Unit-style Node test-runner coverage for stable helper behavior; extension entrypoint lifecycle tests live in focused integration suites.
 * Usage: Run with `npx tsx --test test/agent-browser.runtime.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests preserve existing assertions and isolate filesystem/env side effects with temp directories and explicit cleanup.
 */

import assert from "node:assert/strict";
import { readArray, readRecord, readString } from "./helpers/assertions.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	canonicalizeAgentBrowserNamespace,
	extractRequestedRestoreKey,
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	GLOBAL_VALUE_FLAGS,
	isBooleanFlagEnabled,
} from "../extensions/agent-browser/lib/argv-grammar.js";
import { parseCommandInfo } from "../extensions/agent-browser/lib/argv-descriptor.js";
import {
	isCloseCommand,
	isKnownCommandToken,
	isOpenNavigationCommand,
	isPageChangeSummaryCommand,
	isPageMutationCommand,
	isRecordPageTransitionCommand,
	isRefGuardedCommand,
	isRefInvalidatingBatchCommand,
	isUnverifiedPageTransitionCommand,
} from "../extensions/agent-browser/lib/command-taxonomy.js";

import { isRecord, parsePositiveInteger } from "../extensions/agent-browser/lib/parsing.js";
import { LAUNCH_SCOPED_FLAGS } from "../extensions/agent-browser/lib/launch-scoped-flags.js";
import {
	QUICK_START_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	getAgentBrowserSocketDir,
	getAgentBrowserSocketPathValidationError,
} from "../extensions/agent-browser/lib/process.js";
import {
	buildExecutionPlan,
	canUseHeadlessCompatibilityUserAgent,
	createFreshSessionName,
	createImplicitSessionName,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	parseArgvDescriptor,
	parseWaitCommandTokens,
	redactInvocationArgs,
	redactSensitiveText,
	redactSensitiveValue,
	resolveManagedSessionState,
	restoreManagedSessionStateFromBranch as restoreCanonicalManagedSessionState,
	validateToolArgs,
} from "../extensions/agent-browser/lib/runtime.js";
import { convertBrowserEntries } from "../extensions/agent-browser/lib/browser-session-conversion.js";
const restoreManagedSessionStateFromBranch = (branch: readonly unknown[], baseName: string) =>
	restoreCanonicalManagedSessionState(convertBrowserEntries([...branch]), baseName);
import { createToolBranchEntry } from "./helpers/agent-browser-harness.js";

test("buildExecutionPlan rejects ambiguous session identity flags without rejecting command text", () => {
	const options = {
		freshSessionName: "piab-fresh",
		managedSessionActive: true,
		managedSessionName: "piab-managed",
		sessionMode: "auto" as const,
	};
	const duplicate = buildExecutionPlan(
		["--session", "piab-managed", "--session", "caller-owned", "open", "https://example.com"],
		options,
	);
	assert.match(duplicate.validationError ?? "", /Multiple --session flags/);
	const duplicateNamespace = buildExecutionPlan(
		["--namespace", "managed", "--namespace", "caller", "open", "https://example.com"],
		options,
	);
	assert.match(duplicateNamespace.validationError ?? "", /Multiple --namespace flags/);
	const afterSentinel = buildExecutionPlan(
		["--session", "piab-managed", "fill", "#field", "--", "--session", "caller-owned"],
		options,
	);
	assert.match(afterSentinel.validationError ?? "", /Multiple --session flags/);
	const launchArgValue = buildExecutionPlan(
		[
			"--session",
			"piab-managed",
			"--args",
			"--session=browser-flag-value",
			"open",
			"https://example.com",
		],
		{ ...options, managedSessionActive: false },
	);
	assert.doesNotMatch(launchArgValue.validationError ?? "", /Multiple --session flags/);
	assert.equal(launchArgValue.sessionName, "piab-managed");
	const commandFlagSmuggle = buildExecutionPlan(
		["wait", "--text", "Dashboard", "--timeout", "--session", "caller-owned", "5000"],
		options,
	);
	assert.equal(commandFlagSmuggle.validationError, undefined);
	assert.equal(commandFlagSmuggle.sessionName, "caller-owned");
	assert.equal(commandFlagSmuggle.usedImplicitSession, false);
	const helpWithUnsupportedEqualsSession = buildExecutionPlan(
		["--session=caller-owned", "--help"],
		options,
	);
	assert.equal(helpWithUnsupportedEqualsSession.validationError, undefined);
	assert.deepEqual(helpWithUnsupportedEqualsSession.effectiveArgs, [
		"--session=caller-owned",
		"--help",
	]);
});

test("createImplicitSessionName is stable for a persisted pi session", () => {
	const sessionId = "12345678-1234-5678-9abc-def012345678";
	const cwd = "/Users/example/Projects/pi-agent-browser";
	const one = createImplicitSessionName(sessionId, cwd, "ignored-a", "linux");
	const two = createImplicitSessionName(sessionId, cwd, "ignored-b", "linux");

	assert.equal(one, two);
	assert.match(one, /^piab-pi-agent-browser-[a-f0-9]{12}-[a-f0-9]{8}$/);
});

test("createImplicitSessionName hashes the full Pi session id", () => {
	const cwd = "/Users/example/Projects/pi-agent-browser";
	const one = createImplicitSessionName(
		"019fe81c-92dd-7000-8000-000000000001",
		cwd,
		"ignored",
		"linux",
	);
	const two = createImplicitSessionName(
		"019fe81c-92dd-7000-8000-000000000002",
		cwd,
		"ignored",
		"linux",
	);

	assert.notEqual(one, two);
});

test("createImplicitSessionName includes cwd isolation for same-named checkouts", () => {
	const sessionId = "12345678-1234-5678-9abc-def012345678";
	const one = createImplicitSessionName(sessionId, "/tmp/foo/app", "ignored-a", "linux");
	const two = createImplicitSessionName(sessionId, "/tmp/bar/app", "ignored-b", "linux");

	assert.notEqual(one, two);
	assert.match(one, /^piab-app-[a-f0-9]{12}-[a-f0-9]{8}$/);
	assert.match(two, /^piab-app-[a-f0-9]{12}-[a-f0-9]{8}$/);
});

test("Android managed session names retain full identity entropy within namespaced socket limits", () => {
	const base = createImplicitSessionName(
		"12345678-1234-5678-9abc-def012345678",
		"/data/data/com.termux/files/home/project",
		"ignored",
		"android",
	);
	const fresh = createFreshSessionName(base, "seed", 1);
	const socketDir = getAgentBrowserSocketDir("android", 10_589, "com.termux");

	assert.match(base, /^piab-[a-f0-9]{20}$/);
	assert.notEqual(
		base,
		createImplicitSessionName(
			"12345678-1234-5678-9abc-def012345679",
			"/data/data/com.termux/files/home/project",
			"ignored",
			"android",
		),
	);
	assert.notEqual(
		base,
		createImplicitSessionName(
			"12345678-1234-5678-9abc-def012345678",
			"/data/data/com.termux/files/home/other/project",
			"ignored",
			"android",
		),
	);
	assert.equal(
		getAgentBrowserSocketPathValidationError({
			args: ["--namespace", "termux", "--session", fresh, "open", "about:blank"],
			platform: "android",
			socketDir: String(socketDir),
		}),
		undefined,
	);
});

test("getAgentBrowserSocketDir uses a short user-specific unix socket directory and skips windows", () => {
	assert.equal(getAgentBrowserSocketDir("darwin", 501), "/private/tmp/piab-501");
	assert.equal(getAgentBrowserSocketDir("linux", 1000), "/tmp/piab-1000");
	assert.equal(
		getAgentBrowserSocketDir("android", 10_589, "com.termux"),
		"/data/data/com.termux/piab",
	);
	assert.equal(getAgentBrowserSocketDir("android", 10_589, "../invalid"), "/tmp/piab-10589");
	assert.equal(getAgentBrowserSocketDir("win32", undefined), undefined);
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
	assert.equal(
		canonicalizeAgentBrowserNamespace("Next Dev Loop: /Users/me/worktree!"),
		"next-dev-loop-users-me-worktree",
	);
	assert.equal(canonicalizeAgentBrowserNamespace(" --Agent__ "), "agent");
	assert.equal(
		parseArgvDescriptor(["--hide-scrollbars", "open", "https://example.com"]).commandInfo.command,
		"open",
	);
	assert.equal(
		parseArgvDescriptor(["--hide-scrollbars", "false", "open", "https://example.com"]).commandInfo
			.command,
		"open",
	);
	assert.deepEqual(parseArgvDescriptor(["pdf", "--json", "demo.pdf"]).upstreamCommandTokens, [
		"pdf",
		"demo.pdf",
	]);
	assert.deepEqual(parseArgvDescriptor(["pdf", "--restore", "demo.pdf"]).upstreamCommandTokens, [
		"pdf",
		"demo.pdf",
	]);
	assert.deepEqual(
		parseArgvDescriptor(["pdf", "--quick", "true", "demo.pdf"]).upstreamCommandTokens,
		["pdf", "demo.pdf"],
	);
	assert.deepEqual(
		parseArgvDescriptor(["record", "--json", "start", "demo.webm"]).upstreamCommandTokens,
		["record", "start", "demo.webm"],
	);
	assert.deepEqual(
		parseArgvDescriptor(["pdf", "--restore=key", "demo.pdf"]).upstreamCommandTokens,
		["pdf", "demo.pdf"],
	);
});

test("extractRequestedRestoreKey mirrors optional values and post-command session fallback", () => {
	assert.equal(
		extractRequestedRestoreKey(["open", "https://example.com"], "managed", "env-key"),
		"env-key",
	);
	assert.equal(extractRequestedRestoreKey(["open", "https://example.com"], "managed", ""), null);
	assert.equal(
		extractRequestedRestoreKey(
			["--restore", "caller-key", "open", "https://example.com"],
			"managed",
			undefined,
		),
		"caller-key",
	);
	assert.equal(
		extractRequestedRestoreKey(
			["open", "https://example.com", "--restore=caller-key"],
			"managed",
			undefined,
		),
		"caller-key",
	);
	assert.equal(
		extractRequestedRestoreKey(["--restore=", "open", "https://example.com"], "managed", undefined),
		"managed",
	);
	assert.equal(
		extractRequestedRestoreKey(["--restore", "open", "https://example.com"], "managed", undefined),
		"managed",
	);
	assert.equal(
		extractRequestedRestoreKey(
			["open", "https://example.com", "--restore", "ignored"],
			"managed",
			undefined,
		),
		"managed",
	);
});

test("implicit session timeout helpers prefer explicit overrides and safe defaults", () => {
	assert.equal(
		getImplicitSessionIdleTimeoutMs({
			AGENT_BROWSER_IDLE_TIMEOUT_MS: "2100",
			PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1200",
		}),
		1200,
	);
	assert.equal(getImplicitSessionIdleTimeoutMs({ AGENT_BROWSER_IDLE_TIMEOUT_MS: "2100" }), 2100);
	assert.equal(
		getImplicitSessionIdleTimeoutMs({
			PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "invalid",
		}),
		900000,
	);
	assert.equal(
		getImplicitSessionCloseTimeoutMs({ PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS: "250" }),
		250,
	);
	assert.equal(
		getImplicitSessionCloseTimeoutMs({
			PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS: "invalid",
		}),
		35_000,
	);
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
	assert.deepEqual(
		resolveManagedSessionState({
			command: "close",
			managedSessionName: "piab-demo-123-fresh",
			managedSessionNamespace: undefined,
			priorActive: true,
			priorNamespace: "review",
			priorSessionName: "piab-demo-123-fresh",
			succeeded: true,
		}),
		{ active: true, namespace: "review", sessionName: "piab-demo-123-fresh" },
	);
	assert.deepEqual(
		resolveManagedSessionState({
			command: "open",
			managedSessionName: "piab-demo-123-fresh",
			managedSessionNamespace: "review",
			priorActive: true,
			priorSessionName: "piab-demo-123",
			succeeded: true,
		}),
		{
			active: true,
			namespace: "review",
			sessionName: "piab-demo-123-fresh",
			replacedSessionName: "piab-demo-123",
		},
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
		managedSessionRestoreDisabledIdentities: [],
		replacedSessionName: undefined,
		sessionName: "piab-demo-123-fresh-aaa",
	});
});

test("restoreManagedSessionStateFromBranch preserves managed session namespace", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["--namespace", "review", "open", "https://example.com"],
					command: "open",
					exitCode: 0,
					namespace: "review",
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
					namespace: "review",
					sessionMode: "auto",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.namespace, "review");
	assert.equal(restored.sessionName, "piab-demo-123-fresh-aaa");

	const afterDefaultNamespaceClose = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["--namespace", "review", "open", "https://example.com"],
					command: "open",
					exitCode: 0,
					namespace: "review",
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--session", "piab-demo-123-fresh-aaa", "close"],
					command: "close",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
		],
		"piab-demo-123",
	);
	assert.equal(afterDefaultNamespaceClose.active, true);
	assert.equal(afterDefaultNamespaceClose.namespace, "review");
});

test("restoreManagedSessionStateFromBranch honors managedSessionOutcome replacement on wrapper-level failures", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["batch"],
					command: "batch",
					managedSessionOutcome: {
						activeAfter: true,
						activeBefore: true,
						attemptedSessionName: "piab-demo-123-fresh-aaa",
						currentSessionName: "piab-demo-123-fresh-aaa",
						previousSessionName: "piab-demo-123",
						replacedSessionName: "piab-demo-123",
						sessionMode: "fresh",
						status: "replaced",
						succeeded: false,
					},
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
				isError: true,
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.sessionName, "piab-demo-123-fresh-aaa");
	assert.equal(restored.freshSessionOrdinal, 1);
});

test("restoreManagedSessionStateFromBranch honors a nested close outcome after an active row", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["batch"],
					command: "batch",
					managedSessionOutcome: {
						activeAfter: false,
						activeBefore: true,
						attemptedSessionName: "piab-demo-123",
						previousSessionName: "piab-demo-123",
						sessionMode: "auto",
						status: "closed",
						succeeded: true,
					},
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
				isError: true,
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, false);
	assert.equal(restored.closedSessionName, "piab-demo-123");
});

test("restoreManagedSessionStateFromBranch keeps unknown post-close launches active", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["batch"],
					batchSteps: [
						{ command: ["close"], success: true },
						{ command: ["record", "start", "ghost.webm"], success: true },
					],
					command: "batch",
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.closedSessionName, undefined);
});

test("restoreManagedSessionStateFromBranch preserves a terminal batch close through a non-launching diagnostic", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["batch"],
					batchSteps: [
						{ command: ["close"], success: true },
						{
							command: ["stream", "status"],
							data: { lifecycle: { effectiveLaunch: { browserLaunched: false } } },
							success: true,
						},
					],
					command: "batch",
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, false);
	assert.equal(restored.closedSessionName, "piab-demo-123");
});

test("restoreManagedSessionStateFromBranch keeps a lifecycle-proven post-close record stop active", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["batch"],
					batchSteps: [
						{ command: ["close"], success: true },
						{
							command: ["record", "stop"],
							data: { lifecycle: { effectiveLaunch: { browserLaunched: true } } },
							success: true,
						},
					],
					command: "batch",
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.sessionName, "piab-demo-123");
	assert.equal(restored.closedSessionName, undefined);
});

test("restoreManagedSessionStateFromBranch keeps a first-call failed post-close launch active", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["batch"],
					batchSteps: [
						{ command: ["close"], success: true },
						{ command: ["click", "#missing"], success: false },
					],
					command: "batch",
					managedSessionOutcome: {
						activeAfter: false,
						activeBefore: false,
						attemptedSessionName: "piab-demo-123",
						status: "abandoned",
						succeeded: false,
					},
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
				isError: true,
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.sessionName, "piab-demo-123");
	assert.equal(restored.closedSessionName, undefined);
});

test("restoreManagedSessionStateFromBranch applies close --all to the active namespace", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--session", "caller-owned", "close", "--all"],
					closeAllApplied: true,
					command: "close",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "caller-owned",
					usedImplicitSession: false,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, false);
	assert.equal(restored.closedSessionName, "piab-demo-123");
});

test("restoreManagedSessionStateFromBranch ignores stale base completions after fresh rotation", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--profile", "Default", "open", "https://example.com/fresh"],
					command: "open",
					exitCode: 0,
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/stale-base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.sessionName, "piab-demo-123-fresh-aaa");
	assert.equal(restored.freshSessionOrdinal, 1);
});

test("restoreManagedSessionStateFromBranch ignores stale earlier fresh completions after newer fresh rotation", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["--profile", "Default", "open", "https://example.com/first-fresh"],
					command: "open",
					exitCode: 0,
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--profile", "Work", "open", "https://example.com/second-fresh"],
					command: "open",
					exitCode: 0,
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-bbb",
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

	assert.equal(restored.active, true);
	assert.equal(restored.sessionName, "piab-demo-123-fresh-bbb");
	assert.equal(restored.freshSessionOrdinal, 2);
});

test("restoreManagedSessionStateFromBranch ignores stale close entries for superseded managed sessions", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--profile", "Default", "open", "https://example.com/fresh"],
					command: "open",
					exitCode: 0,
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["close"],
					command: "close",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, true);
	assert.equal(restored.sessionName, "piab-demo-123-fresh-aaa");
	assert.equal(restored.freshSessionOrdinal, 1);
});

test("restoreManagedSessionStateFromBranch treats upstream close aliases as managed-session closes", () => {
	for (const command of ["quit", "exit"] as const) {
		const restored = restoreManagedSessionStateFromBranch(
			[
				createToolBranchEntry({
					details: {
						args: ["open", "https://example.com/base"],
						command: "open",
						exitCode: 0,
						sessionMode: "auto",
						sessionName: "piab-demo-123",
						usedImplicitSession: true,
					},
				}),
				createToolBranchEntry({
					details: {
						args: [command],
						command,
						exitCode: 0,
						sessionMode: "auto",
						sessionName: "piab-demo-123",
						usedImplicitSession: true,
					},
				}),
			],
			"piab-demo-123",
		);

		// All three close aliases must retire ownership in this fixed matrix.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(restored.active, false, command);
		// All close aliases must retain the same restored session identity.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(restored.sessionName, "piab-demo-123", command);
		// All close aliases must publish the retired session identity.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(restored.closedSessionName, "piab-demo-123", command);
	}
});

test("restoreManagedSessionStateFromBranch honors explicit close rows for restorable sessions", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--session", "piab-demo-123", "close"],
					command: "close",
					exitCode: 0,
					managedSessionOutcome: {
						activeAfter: false,
						activeBefore: true,
						attemptedSessionName: "piab-demo-123",
						currentSessionName: "piab-demo-123-fresh-next",
						previousSessionName: "piab-demo-123",
						sessionMode: "auto",
						status: "closed",
						succeeded: true,
						summary: "Managed session piab-demo-123 was closed.",
					},
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: false,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, false);
	assert.equal(restored.sessionName, "piab-demo-123");
	assert.equal(restored.closedSessionName, "piab-demo-123");
});

test("restoreManagedSessionStateFromBranch reserves auto-used generated fresh names after explicit closes", () => {
	const baseSessionName = "piab-demo-123";
	const firstFreshSessionName = createFreshSessionName(baseSessionName, "seed", 1);
	const secondFreshSessionName = createFreshSessionName(baseSessionName, "seed", 2);
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: baseSessionName,
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--session", baseSessionName, "close"],
					command: "close",
					exitCode: 0,
					managedSessionOutcome: {
						activeAfter: false,
						activeBefore: true,
						attemptedSessionName: baseSessionName,
						currentSessionName: firstFreshSessionName,
						previousSessionName: baseSessionName,
						sessionMode: "auto",
						status: "closed",
						succeeded: true,
						summary: `Managed session ${baseSessionName} was closed.`,
					},
					sessionMode: "auto",
					sessionName: baseSessionName,
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["get", "url"],
					command: "get",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: firstFreshSessionName,
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--session", firstFreshSessionName, "close"],
					command: "close",
					exitCode: 0,
					managedSessionOutcome: {
						activeAfter: false,
						activeBefore: true,
						attemptedSessionName: firstFreshSessionName,
						currentSessionName: secondFreshSessionName,
						previousSessionName: firstFreshSessionName,
						sessionMode: "auto",
						status: "closed",
						succeeded: true,
						summary: `Managed session ${firstFreshSessionName} was closed.`,
					},
					sessionMode: "auto",
					sessionName: firstFreshSessionName,
					usedImplicitSession: false,
				},
			}),
		],
		baseSessionName,
	);

	assert.equal(restored.active, false);
	assert.equal(restored.sessionName, firstFreshSessionName);
	assert.equal(restored.closedSessionName, firstFreshSessionName);
	assert.equal(restored.freshSessionOrdinal, 1);
});

test("restoreManagedSessionStateFromBranch honors namespaced Electron cleanup managed-session steps", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["connect", "9222"],
					command: "connect",
					exitCode: 0,
					managedSessionOutcome: {
						activeAfter: true,
						activeBefore: false,
						attemptedSessionName: "piab-demo-123-fresh-electron",
						currentSessionName: "piab-demo-123-fresh-electron",
						previousSessionName: "piab-demo-123",
						sessionMode: "fresh",
						status: "created",
						succeeded: true,
						summary: "Managed session piab-demo-123-fresh-electron is now current.",
					},
					namespace: "team",
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-electron",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: [],
					electron: {
						action: "cleanup",
						cleanup: {
							partial: true,
							results: [
								{
									launchId: "electron-demo",
									partial: true,
									record: {
										cleanupState: "partial",
										launchId: "electron-demo",
										namespace: "record-fallback",
										port: 9222,
										version: 1,
									},
									remainingResources: ["process"],
									steps: [
										{
											namespace: "team",
											resource: "managed-session",
											sessionName: "piab-demo-123-fresh-electron",
											state: "removed",
										},
										{ resource: "process", state: "failed" },
									],
									summary: "Electron cleanup was partial.",
								},
							],
						},
					},
					resultCategory: "failure",
				},
				isError: true,
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, false);
	assert.equal(restored.sessionName, "piab-demo-123-fresh-electron");
	assert.equal(restored.closedSessionName, "piab-demo-123-fresh-electron");
	assert.equal(restored.freshSessionOrdinal, 1);
});

test("restoreManagedSessionStateFromBranch does not resurrect superseded sessions after latest session closes", () => {
	const restored = restoreManagedSessionStateFromBranch(
		[
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["--profile", "Default", "open", "https://example.com/fresh"],
					command: "open",
					exitCode: 0,
					sessionMode: "fresh",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: false,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["close"],
					command: "close",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123-fresh-aaa",
					usedImplicitSession: true,
				},
			}),
			createToolBranchEntry({
				details: {
					args: ["open", "https://example.com/stale-base"],
					command: "open",
					exitCode: 0,
					sessionMode: "auto",
					sessionName: "piab-demo-123",
					usedImplicitSession: true,
				},
			}),
		],
		"piab-demo-123",
	);

	assert.equal(restored.active, false);
	assert.equal(restored.sessionName, "piab-demo-123-fresh-aaa");
	assert.equal(restored.freshSessionOrdinal, 1);
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
		managedSessionRestoreDisabledIdentities: [],
		sessionName: "piab-demo-123",
	});
});

test("buildExecutionPlan injects --json and the implicit session when needed", () => {
	const options = {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto" as const,
	};
	const plan = buildExecutionPlan(["open", "https://example.com"], options);

	assert.deepEqual(plan.effectiveArgs, [
		"--json",
		"--session",
		"piab-demo-123",
		"open",
		"https://example.com",
	]);
	assert.equal(plan.managedSessionName, "piab-demo-123");
	assert.equal(plan.sessionName, "piab-demo-123");
	assert.equal(plan.usedImplicitSession, true);
	assert.equal(plan.validationError, undefined);

	const namespaced = buildExecutionPlan(
		["--namespace", "Review Team!", "open", "https://example.com"],
		options,
	);
	assert.deepEqual(namespaced.effectiveArgs, [
		"--json",
		"--namespace",
		"review-team",
		"--session",
		"piab-demo-123",
		"open",
		"https://example.com",
	]);
	assert.equal(namespaced.namespace, "review-team");

	for (const command of ["close", "quit", "exit"] as const) {
		const closePlan = buildExecutionPlan([command], {
			...options,
			managedSessionActive: true,
		});

		// Every declared close alias must preserve exact upstream argv.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(
			closePlan.effectiveArgs,
			["--json", "--session", "piab-demo-123", command],
			command,
		);
		// Every close alias must retain managed identity until its close executes.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(closePlan.managedSessionName, "piab-demo-123", command);
		// Every close alias must target the managed session.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(closePlan.sessionName, "piab-demo-123", command);
		// Every close alias must retain implicit routing in this fixed matrix.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(closePlan.usedImplicitSession, true, command);
	}
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

	const namespaced = buildExecutionPlan(
		["--session", "custom", "--namespace", "review", "snapshot", "-i"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.deepEqual(namespaced.effectiveArgs, [
		"--json",
		"--namespace",
		"review",
		"--session",
		"custom",
		"snapshot",
		"-i",
	]);
	assert.equal(namespaced.sessionName, "custom");
	assert.equal(namespaced.namespace, "review");

	const defaultNamespace = buildExecutionPlan(["--namespace", "", "--session", "custom", "close"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		managedSessionNamespace: "prod",
		sessionMode: "auto",
	});
	assert.deepEqual(defaultNamespace.effectiveArgs, [
		"--json",
		"--namespace",
		"",
		"--session",
		"custom",
		"close",
	]);
	assert.equal(defaultNamespace.namespace, "");

	const sameNamespace = buildExecutionPlan(["--namespace", "Review", "snapshot", "-i"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		managedSessionNamespace: "review",
		sessionMode: "auto",
	});
	assert.deepEqual(sameNamespace.effectiveArgs, [
		"--json",
		"--namespace",
		"review",
		"--session",
		"piab-demo-123",
		"snapshot",
		"-i",
	]);
	assert.equal(sameNamespace.validationError, undefined);
});

test("buildExecutionPlan resolves caller-owned session namespaces from argv before environment", () => {
	const previousNamespace = process.env.AGENT_BROWSER_NAMESPACE;
	try {
		process.env.AGENT_BROWSER_NAMESPACE = "Review Space";
		const inherited = buildExecutionPlan(["--session", "custom", "snapshot", "-i"], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});
		assert.equal(inherited.namespace, "review-space");
		assert.deepEqual(inherited.effectiveArgs, ["--json", "--session", "custom", "snapshot", "-i"]);
		const explicitDefault = buildExecutionPlan(
			["--namespace", "", "--session", "custom", "snapshot", "-i"],
			{
				freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
				managedSessionActive: true,
				managedSessionName: "piab-demo-123",
				sessionMode: "auto",
			},
		);
		assert.equal(explicitDefault.namespace, "");
		const wrapperManaged = buildExecutionPlan(["--session", "piab-demo-123", "close"], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});
		assert.equal(wrapperManaged.namespace, undefined);
		assert.deepEqual(wrapperManaged.effectiveArgs, [
			"--json",
			"--session",
			"piab-demo-123",
			"close",
		]);
		const namespacedManaged = buildExecutionPlan(["--session", "piab-demo-123", "snapshot", "-i"], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			managedSessionNamespace: "Review Space",
			sessionMode: "auto",
		});
		assert.equal(namespacedManaged.namespace, "review-space");
		assert.deepEqual(namespacedManaged.effectiveArgs, [
			"--json",
			"--session",
			"piab-demo-123",
			"snapshot",
			"-i",
		]);
		assert.equal(namespacedManaged.validationError, undefined);
		const callerPrefixed = buildExecutionPlan(
			["--session", "piab-caller-owned", "snapshot", "-i"],
			{
				freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
				managedSessionActive: true,
				managedSessionName: "piab-demo-123",
				sessionMode: "auto",
			},
		);
		assert.equal(callerPrefixed.namespace, "review-space");
		const wrapperExplicitDefault = buildExecutionPlan(
			["--namespace", "", "--session", "piab-demo-123", "close"],
			{
				freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
				managedSessionActive: true,
				managedSessionName: "piab-demo-123",
				sessionMode: "auto",
			},
		);
		assert.deepEqual(wrapperExplicitDefault.effectiveArgs, [
			"--json",
			"--namespace",
			"",
			"--session",
			"piab-demo-123",
			"close",
		]);
		assert.equal(wrapperExplicitDefault.namespace, "");

		for (const override of [undefined, "", "other"]) {
			const args = [...(override !== undefined ? ["--namespace", override] : []), "close", "--all"];
			const freshClose = buildExecutionPlan(args, {
				freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
				managedSessionActive: true,
				managedSessionName: "piab-demo-123",
				managedSessionNamespace: "owned-space",
				sessionMode: "fresh",
			});
			// Every fixed namespace override must preserve native close-all routing.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(freshClose.namespace, override ?? "review-space");
			// Every namespace variant must leave close-all argv unchanged.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(freshClose.effectiveArgs, ["--json", ...args]);
			// Every close-all variant must avoid selecting a single session.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(freshClose.sessionName, undefined);
			// Every close-all variant must avoid assigning managed identity.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(freshClose.managedSessionName, undefined);
			// Every close-all variant must stay namespace-scoped, not implicit-session scoped.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(freshClose.usedImplicitSession, false);
			// Every declared close-all variant must remain supported.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(freshClose.validationError, undefined);
		}
		for (const sessionMode of ["auto", "fresh"] as const) {
			const freshSessionName = createFreshSessionName("piab-demo-123", "seed", 1);
			const opened = buildExecutionPlan(["open", "https://example.com"], {
				freshSessionName,
				managedSessionActive: false,
				managedSessionName: "piab-demo-123",
				sessionMode,
			});
			const selectedSession = sessionMode === "fresh" ? freshSessionName : "piab-demo-123";
			// Both fixed auto/fresh modes must use the default namespace.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(opened.namespace, undefined);
			// Both fixed session modes must emit the exact selected-session argv.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(opened.effectiveArgs, [
				"--json",
				"--session",
				selectedSession,
				"open",
				"https://example.com",
			]);
			// Both fixed session modes must select their expected identity.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(opened.sessionName, selectedSession);
			// Both fixed session modes must retain their selected managed identity.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(opened.managedSessionName, selectedSession);
			// The exhaustive mode matrix distinguishes ordinary implicit reuse from fresh selection.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(opened.usedImplicitSession, sessionMode === "auto");
			// Both declared open modes must remain valid.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(opened.validationError, undefined);

			const listed = buildExecutionPlan(["session", "list"], {
				freshSessionName,
				managedSessionActive: true,
				managedSessionName: "piab-demo-123",
				managedSessionNamespace: "owned-space",
				sessionMode,
			});
			// Both session-mode variants must leave session listing in the native namespace.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(listed.namespace, "review-space");
			// Both fixed session modes must leave local listing argv unchanged.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(listed.effectiveArgs, ["--json", "session", "list"]);
			// Both fixed modes must keep local listing sessionless.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(listed.sessionName, undefined);
			// Both fixed modes must avoid creating managed identity for local listing.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(listed.managedSessionName, undefined);
			// Both fixed modes must avoid implicit-session injection for local listing.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(listed.usedImplicitSession, false);
			// Both declared listing modes must remain valid.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(listed.validationError, undefined);
		}
	} finally {
		if (previousNamespace === undefined) {
			delete process.env.AGENT_BROWSER_NAMESPACE;
		} else {
			process.env.AGENT_BROWSER_NAMESPACE = previousNamespace;
		}
	}
});

test("buildExecutionPlan preserves stored namespace for implicit managed sessions", () => {
	const plan = buildExecutionPlan(["snapshot", "-i"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123-fresh-aaa",
		managedSessionNamespace: "Review",
		sessionMode: "auto",
	});

	assert.deepEqual(plan.effectiveArgs, [
		"--json",
		"--namespace",
		"review",
		"--session",
		"piab-demo-123-fresh-aaa",
		"snapshot",
		"-i",
	]);
	assert.equal(plan.namespace, "review");
	assert.equal(plan.managedSessionName, "piab-demo-123-fresh-aaa");
	assert.equal(plan.sessionName, "piab-demo-123-fresh-aaa");
	assert.equal(plan.usedImplicitSession, true);
});

test("buildExecutionPlan keeps inspection commands stateless", () => {
	for (const args of [["--version"], ["--help"], ["snapshot", "--help"]] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		// Every fixed help/version shape must use native inspection output.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.plainTextInspection, true);
		// Every fixed help/version shape must retain caller argv.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.effectiveArgs, [...args]);
		// Every local/inspection fixture in these nonempty matrices must remain unmanaged.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.managedSessionName, undefined);
		// Every local/inspection or invalid-argv fixture must avoid selecting a session.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.sessionName, undefined);
		// Every local/inspection or invalid-argv fixture must avoid implicit injection.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, false);
		// Every declared valid local/inspection case must remain supported.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.validationError, undefined);
	}
});

test("buildExecutionPlan keeps sessionless commands free of implicit managed sessions while preserving JSON output", () => {
	for (const args of [
		["skills", "list"],
		["skills", "get", "core", "--full"],
		["skills", "path", "core"],
		["profiles"],
		["auth", "save", "demo", "--url", "https://example.test", "--username", "user"],
		["auth", "list"],
		["auth", "list", "--json"],
		["auth", "show", "demo"],
		["auth", "delete", "demo"],
		["auth", "remove", "demo"],
		["dashboard"],
		["dashboard", "--allowed-origins", "https://dashboard.example.com"],
		["dashboard", "start", "--port", "4848", "--allowed-origins", "https://dashboard.example.com"],
		["device", "list"],
		["dashboard", "stop"],
		["dashboard", "stop", "--json"],
		["doctor", "--offline", "--quick"],
		["doctor", "--webgpu"],
		["doctor", "--webgpu", "--headed"],
		["install", "--with-deps"],
		["install", "-d"],
		["upgrade"],
		["profiles", "--json"],
		["session", "id"],
		["session", "id", "--scope", "worktree", "--prefix", "demo"],
		["session", "id", "--json"],
		["session", "info"],
		["session", "info", "--json"],
		["--namespace", "review", "session", "info"],
		["session", "info", "--namespace", "review"],
		["session", "list"],
		["session", "list", "--json"],
		["state", "list"],
		["state", "list", "--json"],
		["state", "show", "auth.json"],
		["state", "clear", "--all"],
		["state", "clear", "-a"],
		["state", "clear", "piab-demo-123"],
		["state", "clean", "--older-than", "7"],
		["state", "rename", "old", "new"],
		["plugin"],
		["plugin", "list"],
		["plugin", "show", "vault"],
		["plugin", "add", "agent-browser-plugin-vault"],
		["plugin", "run", "captcha", "captcha.solve"],
	] as const) {
		const callerArgs = [...args];
		const plan = buildExecutionPlan(callerArgs, {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		const expectedEffectiveArgs = callerArgs.includes("--json")
			? callerArgs
			: ["--json", ...callerArgs];

		// Every fixed local-command case retains structured output, unlike help/version.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.plainTextInspection, false);
		// Every local-command case must retain its exact argv plus required JSON output.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.effectiveArgs, expectedEffectiveArgs);
		// Every local/inspection fixture in these nonempty matrices must remain unmanaged.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.managedSessionName, undefined);
		// Every local/inspection or invalid-argv fixture must avoid selecting a session.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.sessionName, undefined);
		// Every local/inspection or invalid-argv fixture must avoid implicit injection.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, false);
		// Every declared valid local/inspection case must remain supported.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.validationError, undefined);
	}
});

test("validateToolArgs rejects one-shot mcp server calls but preserves --help/-h", () => {
	assert.match(validateToolArgs(["mcp"]) ?? "", /stdio MCP server/);
	assert.match(validateToolArgs(["mcp", "--tools", "core,network"]) ?? "", /external MCP clients/);
	assert.equal(validateToolArgs(["mcp", "--help"]), undefined);
	assert.equal(validateToolArgs(["mcp", "-h"]), undefined);
	assert.match(validateToolArgs(["mcp", "help"]) ?? "", /external MCP clients/);
});

test("buildExecutionPlan still injects managed sessions for browser-backed state and auth commands", () => {
	for (const args of [
		["state", "save", "./auth.json"],
		["state", "load", "./auth.json"],
		["auth", "login", "demo"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		// Every fixed browser-backed state/auth command must receive managed routing.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "piab-demo-123", ...args]);
		// Every browser-backed state/auth fixture must retain implicit routing.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, true);
		// Every browser-backed state/auth fixture must retain its managed identity.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.managedSessionName, "piab-demo-123");
	}
});

test("buildExecutionPlan limits sessionless allowlists to documented subcommands", () => {
	for (const args of [
		["skills", "future-mutating-subcommand"],
		["auth", "future", "demo"],
		["dashboard", "future"],
		["device", "future"],
		["doctor", "future"],
		["install", "future"],
		["profiles", "future"],
		["session"],
		["state", "clear"],
		["state", "clean"],
		["state", "future"],
		["upgrade", "future"],
		["plugin", "future"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		// Every unknown-subcommand fixture conservatively receives managed routing.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(
			plan.effectiveArgs,
			["--json", "--session", "piab-demo-123", ...args],
			args.join(" "),
		);
		// Every declared browser-backed argv variant must retain implicit routing.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, true, args.join(" "));
	}
});

test("buildExecutionPlan rejects unsupported global equals assignments except restore", () => {
	const options = {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto" as const,
	};
	for (const flag of [...GLOBAL_VALUE_FLAGS, ...GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES]) {
		const args = [`${flag}=demo`, "open", "https://example.com"];
		const plan = buildExecutionPlan(args, options);
		// Validate every declared global flag; none are selected from a runtime result.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			plan.validationError?.includes(`does not support \`${flag}=<value>\``),
			true,
			args.join(" "),
		);
		// Every global-equals fixture must fail before command discovery.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.commandInfo, {}, args.join(" "));
		// Every fixed argv variant must retain the expected empty startup-flag set.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.startupScopedFlags, [], args.join(" "));
	}

	const restore = buildExecutionPlan(["open", "https://example.com", "--restore=auth"], options);
	assert.equal(restore.validationError, undefined);
	assert.equal(restore.effectiveArgs.includes("--restore=auth"), true);
});

test("validateToolArgs applies global equals exceptions only at top level", () => {
	assert.equal(validateToolArgs(["--user-agent", "TARS", "batch"]), undefined);
	assert.match(
		validateToolArgs(["screenshot", "page.png", "--user-agent=TARS", "--help"], {
			batchStep: true,
		}) ?? "",
		/Move `--user-agent` and its value before `batch` as separate top-level args/,
	);
	assert.match(
		validateToolArgs(["screenshot", "page.png", "--restore=auth"], { batchStep: true }) ?? "",
		/`--restore=<key>` belongs before `batch` in top-level args/,
	);
});

test("buildExecutionPlan rejects missing values for global value-taking flags before launching upstream", () => {
	for (const args of [
		["--session"],
		["--namespace"],
		["--args", ""],
		["--allowed-domains"],
		["--ca-cert"],
		["--profile"],
		["--executable-path"],
		["--session-name"],
		["--restore-save"],
		["--restore-check-url"],
		["--restore-check-text"],
		["--restore-check-fn"],
		["--cdp"],
		["--state"],
		["--init-script"],
		["--enable"],
		["--download-path"],
		["--model"],
		["--idle-timeout"],
		["open", "https://example.com", "--profile"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		const expectedFlag = [...args].reverse().find((token) => token.startsWith("-"));
		// Every fixed missing-value fixture must fail validation.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(plan.validationError ?? "", /requires a value/i);
		// Every missing-value fixture must identify its own offending flag.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.invalidValueFlag?.flag, expectedFlag);
		// Every missing-value fixture must retain the structured failure reason.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(readRecord(plan.invalidValueFlag).reason, "missing-value");
		// Every missing-value fixture must fail before discovering a command.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.commandInfo, {});
		// Every local/inspection or invalid-argv fixture must avoid selecting a session.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.sessionName, undefined);
		// Every local/inspection or invalid-argv fixture must avoid implicit injection.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, false);
	}
});

test("buildExecutionPlan leaves command-scoped flags and literal text to upstream parsing", () => {
	for (const args of [
		["find", "role", "button", "click", "--name"],
		["network", "route", "**/*.js", "--resource-type"],
		["cookies", "set", "--curl"],
		["wait", "--load"],
		["dashboard", "start", "--port"],
		["auth", "save", "demo", "--password"],
		["fill", "#password", "--password"],
		["keyboard", "type", "--text"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		// Every fixed literal-operand or valid-global fixture must remain valid.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.validationError, undefined, args.join(" "));
	}
});

test("validateToolArgs rejects press/key commands with selector-like extra args", () => {
	for (const args of [
		["press", "@e1", "Enter"],
		["key", "#todo", "Return"],
		["keydown", "@e1", "Enter"],
		["keyup"],
	] as const) {
		// Every fixed invalid keyboard argv must reject selector-like extra operands.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(
			validateToolArgs([...args]) ?? "",
			/accepts exactly one key argument/,
			args.join(" "),
		);
	}
	assert.equal(validateToolArgs(["press", "Enter"]), undefined);
	assert.equal(validateToolArgs(["key", "Escape"]), undefined);
});

test("buildExecutionPlan rejects value-taking flags followed by another flag", () => {
	const plan = buildExecutionPlan(
		["--cdp", "--profile", "Default", "open", "https://example.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);

	assert.match(plan.validationError ?? "", /received `--profile`/i);
	assert.equal(plan.invalidValueFlag?.flag, "--cdp");
	assert.equal(readRecord(plan.invalidValueFlag).reason, "unexpected-flag");
	assert.equal(readRecord(plan.invalidValueFlag).receivedToken, "--profile");
	assert.deepEqual(plan.commandInfo, {});
	assert.equal(plan.usedImplicitSession, false);
});

for (const flag of ["--download", "-d"]) {
	test(`wait ${flag} keeps the next retained operand and its original index after timeout removal`, () => {
		assert.deepEqual(
			parseWaitCommandTokens(["wait", flag, "--timeout", "30000", "-capture.csv", "ignored.csv"]),
			{
				downloadPath: "-capture.csv",
				downloadPathIndex: 4,
				subcommand: flag,
			},
		);
	});
}

test("buildExecutionPlan allows optional wait download path to be omitted", () => {
	const plan = buildExecutionPlan(["wait", "--download", "--timeout", "25000"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.equal(plan.validationError, undefined);
	assert.deepEqual(plan.commandInfo, { command: "wait", subcommand: "--download" });
	assert.deepEqual(plan.effectiveArgs.slice(-4), ["wait", "--download", "--timeout", "25000"]);

	const shortPlan = buildExecutionPlan(["wait", "-d", "report.csv"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	assert.equal(shortPlan.validationError, undefined);
	assert.deepEqual(shortPlan.commandInfo, { command: "wait", subcommand: "-d" });
	assert.deepEqual(
		parseArgvDescriptor(["wait", "--timeout", "30000", "-d", "report.csv"]).commandInfo,
		{ command: "wait", subcommand: "-d" },
	);
	assert.deepEqual(
		parseArgvDescriptor(["wait", "--timeout", "1", "--timeout", "--download", "report.csv"])
			.commandInfo,
		{ command: "wait", subcommand: "--download" },
	);
	assert.deepEqual(
		parseArgvDescriptor(["wait", "--download", "report.csv", "--url", "**/done"]).commandInfo,
		{ command: "wait", subcommand: "--url" },
	);
	assert.deepEqual(parseArgvDescriptor(["wait", "-d", "report.csv", "-t", "Ready"]).commandInfo, {
		command: "wait",
		subcommand: "-t",
	});

	assert.match(
		validateToolArgs(["wait", "--download=report.csv"]) ?? "",
		/does not support `wait --download=<path>`/,
	);
});

test("parseArgvDescriptor parses restore and namespace globals before command discovery", () => {
	for (const { args, command, subcommand } of [
		{ args: ["--namespace", "review", "session", "info"], command: "session", subcommand: "info" },
		{
			args: ["--session", "work", "--restore", "open", "https://example.com"],
			command: "open",
			subcommand: "https://example.com",
		},
		{
			args: ["--session", "work", "--restore", "authstate", "open", "https://example.com"],
			command: "open",
			subcommand: "https://example.com",
		},
		{
			args: ["--restore=auth", "open", "https://example.com"],
			command: "open",
			subcommand: "https://example.com",
		},
		{ args: ["--restore", "snapshot", "-i"], command: "snapshot", subcommand: "-i" },
		{ args: ["--restore", "wait", "--url", "**/dashboard"], command: "wait", subcommand: "--url" },
		{
			args: ["--restore-save", "never", "open", "https://example.com"],
			command: "open",
			subcommand: "https://example.com",
		},
	] as const) {
		const descriptor = parseArgvDescriptor([...args]);
		// Every fixed restore-flag shape must identify the actual command.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(descriptor.commandInfo.command, command, args.join(" "));
		// Every fixed restore-flag shape must retain its actual first operand.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(descriptor.commandInfo.subcommand, subcommand, args.join(" "));
	}
});

test("buildExecutionPlan only relocates namespace occurrences recognized by upstream global parsing", () => {
	const plan = buildExecutionPlan(
		[
			"--session",
			"caller",
			"--args",
			"--namespace",
			"--namespace",
			"team",
			"open",
			"https://example.com",
		],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);

	assert.equal(plan.validationError, undefined);
	assert.equal(plan.namespace, "team");
	assert.deepEqual(plan.effectiveArgs, [
		"--json",
		"--namespace",
		"team",
		"--session",
		"caller",
		"--args",
		"--namespace",
		"open",
		"https://example.com",
	]);
});

test("buildExecutionPlan allows dash-starting --args values", () => {
	const plan = buildExecutionPlan(
		["--args", "--disable-gpu,--lang=en-US", "open", "https://example.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);

	assert.equal(plan.validationError, undefined);
	assert.deepEqual(plan.commandInfo, { command: "open", subcommand: "https://example.com" });
	assert.deepEqual(plan.effectiveArgs.slice(-4), [
		"--args",
		"--disable-gpu,--lang=en-US",
		"open",
		"https://example.com",
	]);
});

test("launch-scoped flag metadata is reflected in playbook and command reference guidance", () => {
	const playbookText = [
		...QUICK_START_GUIDELINES,
		...SHARED_BROWSER_PLAYBOOK_GUIDELINES,
		...TOOL_PROMPT_GUIDELINES_SUFFIX,
	].join("\n");
	const commandReference = readFileSync("docs/COMMAND_REFERENCE.md", "utf8");
	for (const flag of LAUNCH_SCOPED_FLAGS) {
		// Delimited token: `-p` must not be satisfied by "changed-pixel" and `--restore` by `--restore-save`.
		const delimitedFlag = new RegExp(
			`(?<![\\w-])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
		);
		// Every declared launch flag must be documented; the inventory is the fixture.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(playbookText, delimitedFlag, `playbook missing ${flag}`);
		// Every declared launch flag must also appear in the human command guide.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(commandReference, delimitedFlag, `command reference missing ${flag}`);
	}
});

test("buildExecutionPlan blocks startup-scoped flags from silently reusing an active implicit session", () => {
	for (const { args, flags } of [
		{ args: ["--profile", "Default", "open", "https://example.com"], flags: ["--profile"] },
		{ args: ["--engine", "chrome", "open", "https://example.com"], flags: ["--engine"] },
		{ args: ["--engine", "lightpanda", "open", "https://example.com"], flags: ["--engine"] },
		{
			args: ["--allowed-domains", "example.com", "open", "https://example.com"],
			flags: ["--allowed-domains"],
		},
		{
			args: [
				"--executable-path",
				"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
				"open",
				"https://example.com",
			],
			flags: ["--executable-path"],
		},
		{ args: ["--namespace", "review", "open", "https://example.com"], flags: ["--namespace"] },
		{
			args: ["--session-name", "saved-auth", "open", "https://example.com"],
			flags: ["--session-name"],
		},
		{ args: ["--restore", "open", "https://example.com"], flags: ["--restore"] },
		{ args: ["--restore=auth", "open", "https://example.com"], flags: ["--restore"] },
		{ args: ["--restore-save", "never", "open", "https://example.com"], flags: ["--restore-save"] },
		{
			args: ["--restore-check-url", "**/dashboard", "open", "https://example.com"],
			flags: ["--restore-check-url"],
		},
		{
			args: ["--restore-check-text", "Dashboard", "open", "https://example.com"],
			flags: ["--restore-check-text"],
		},
		{
			args: ["--restore-check-fn", "!!localStorage.length", "open", "https://example.com"],
			flags: ["--restore-check-fn"],
		},
		{
			args: ["--cdp", "ws://127.0.0.1:9222/devtools/browser/demo", "open", "https://example.com"],
			flags: ["--cdp"],
		},
		{
			args: ["--ca-cert", "/tmp/proxy-ca.pem", "open", "https://example.com"],
			flags: ["--ca-cert"],
		},
		{ args: ["--no-ca-cert", "open", "https://example.com"], flags: ["--no-ca-cert"] },
		{ args: ["--state", "/tmp/auth.json", "open", "https://example.com"], flags: ["--state"] },
		{ args: ["--auto-connect", "open", "https://example.com"], flags: ["--auto-connect"] },
		{ args: ["--auto-connect", "true", "open", "https://example.com"], flags: ["--auto-connect"] },
		{ args: ["--webgpu", "open", "https://example.com"], flags: ["--webgpu"] },
		{ args: ["--webgpu", "false", "open", "https://example.com"], flags: ["--webgpu"] },
		{ args: ["--no-webmcp", "open", "https://example.com"], flags: ["--no-webmcp"] },
		{ args: ["--no-webmcp", "false", "open", "https://example.com"], flags: ["--no-webmcp"] },
		{ args: ["open", "--enable", "react-devtools", "https://example.com"], flags: ["--enable"] },
		{
			args: ["open", "--init-script", "/tmp/setup.js", "https://example.com"],
			flags: ["--init-script"],
		},
		{ args: ["--idle-timeout", "5000", "open", "https://example.com"], flags: ["--idle-timeout"] },
		{ args: ["--args", "--disable-gpu", "open", "https://example.com"], flags: ["--args"] },
		{ args: ["--user-agent", "Custom/1", "open", "https://example.com"], flags: ["--user-agent"] },
		{ args: ["--headed", "open", "https://example.com"], flags: ["--headed"] },
		{ args: ["--headed", "false", "open", "https://example.com"], flags: ["--headed"] },
		{ args: ["-p", "ios", "open", "https://example.com"], flags: ["-p"] },
		{ args: ["--provider", "browserbase", "open", "https://example.com"], flags: ["--provider"] },
		{
			args: ["-p", "ios", "--device", "iPhone 15 Pro", "open", "https://example.com"],
			flags: ["--device", "-p"],
		},
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		// Every fixed active-session launch-flag fixture must reject ignored launch options.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(plan.validationError ?? "", /launch-scoped flags/i);
		// Each fixed launch fixture must identify every ignored option, including compound provider/device input.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.startupScopedFlags, flags);
		// Every local/inspection or invalid-argv fixture must avoid implicit injection.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, false);
		// Every fixed active-session launch fixture must provide fresh-session recovery.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.recoveryHint?.recommendedSessionMode, "fresh");
		// Every fixed launch-flag fixture must retain its exact recovery argv.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(readRecord(plan.recoveryHint).exampleParams, {
			args: [...args],
			sessionMode: "fresh",
		});
	}
});

test("buildExecutionPlan preserves engine selection for new, fresh and caller-owned sessions", () => {
	for (const engine of ["chrome", "lightpanda"]) {
		for (const mode of ["new", "fresh", "caller"] as const) {
			const args = [
				...(mode === "caller" ? ["--session", "caller"] : []),
				"--engine",
				engine,
				"open",
				"https://example.com",
			];
			const plan = buildExecutionPlan(args, {
				freshSessionName: "piab-fresh",
				managedSessionActive: mode !== "new",
				managedSessionName: "piab-current",
				sessionMode: mode === "fresh" ? "fresh" : "auto",
			});
			// The complete fixed engine/mode matrix must remain supported.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(plan.validationError, undefined, `${engine} ${mode}`);
			// Every engine/mode pair must select the fixture's expected identity.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				plan.sessionName,
				{ caller: "caller", fresh: "piab-fresh", new: "piab-current" }[mode],
			);
			// Every engine/mode pair must preserve the caller's engine and command tail.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(plan.effectiveArgs.slice(-4), [
				"--engine",
				engine,
				"open",
				"https://example.com",
			]);
			// The exhaustive mode matrix distinguishes new implicit selection from explicit/fresh.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(plan.usedImplicitSession, mode === "new");
		}
	}
});

test("buildExecutionPlan treats wait --state as command-scoped after the command", () => {
	const plan = buildExecutionPlan(["wait", "@button", "--state", "hidden"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.equal(plan.validationError, undefined);
	assert.deepEqual(plan.startupScopedFlags, []);
	assert.deepEqual(plan.commandInfo, { command: "wait", subcommand: "@button" });
	assert.equal(plan.usedImplicitSession, true);
	assert.deepEqual(plan.effectiveArgs.slice(-4), ["wait", "@button", "--state", "hidden"]);
});

test("buildExecutionPlan only treats the last exact lowercase auto-connect false as disabled", () => {
	assert.equal(
		isBooleanFlagEnabled(
			["--args", "--auto-connect", "open", "https://example.com"],
			"--auto-connect",
		),
		false,
	);
	const plan = buildExecutionPlan(["--auto-connect", "false", "open", "https://example.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.equal(plan.validationError, undefined);
	assert.deepEqual(plan.startupScopedFlags, []);
	assert.equal(plan.usedImplicitSession, true);
	assert.deepEqual(plan.commandInfo, { command: "open", subcommand: "https://example.com" });

	const uppercaseFalse = buildExecutionPlan(
		["--auto-connect", "FALSE", "open", "https://example.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.match(uppercaseFalse.validationError ?? "", /launch-scoped flags.*--auto-connect/i);

	const lastEnabled = buildExecutionPlan(
		["--auto-connect", "false", "--auto-connect", "open", "https://example.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.match(lastEnabled.validationError ?? "", /launch-scoped flags.*--auto-connect/i);

	const lastDisabled = buildExecutionPlan(
		["--auto-connect", "--auto-connect", "false", "open", "https://example.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(lastDisabled.validationError, undefined);
	assert.deepEqual(lastDisabled.startupScopedFlags, []);
});

test("buildExecutionPlan treats pin-tab as a sticky global boolean, not launch-scoped", () => {
	const options = {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto" as const,
	};
	for (const args of [
		["--pin-tab", "open", "https://example.com"],
		["--pin-tab", "true", "open", "https://example.com"],
		["--pin-tab", "false", "open", "https://example.com"],
		["--no-pin-tab", "open", "https://example.com"],
		["--no-pin-tab", "false", "open", "https://example.com"],
	] as const) {
		const plan = buildExecutionPlan([...args], options);
		// Every fixed literal-operand or valid-global fixture must remain valid.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.validationError, undefined, args.join(" "));
		// Every fixed argv variant must retain the expected empty startup-flag set.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(plan.startupScopedFlags, [], args.join(" "));
		// Every declared browser-backed argv variant must retain implicit routing.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.usedImplicitSession, true, args.join(" "));
		// Every fixed pinning-flag fixture must discover the unchanged open command.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(
			plan.commandInfo,
			{ command: "open", subcommand: "https://example.com" },
			args.join(" "),
		);
	}
});

test("buildExecutionPlan assigns a new managed session for fresh session mode", () => {
	const args = [
		"--namespace",
		"review",
		"--profile",
		"Default",
		"open",
		"https://example.com/profile",
	];
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
	assert.deepEqual(plan.effectiveArgs, [
		"--json",
		"--namespace",
		"review",
		"--session",
		freshSessionName,
		"--profile",
		"Default",
		"open",
		"https://example.com/profile",
	]);
	assert.equal(plan.namespace, "review");
	assert.equal(plan.recoveryHint, undefined);
});

test("buildExecutionPlan injects and retains site-specific headless compatibility user agents", () => {
	for (const [targetUrl, expectedId] of [
		["https://chat.com", "chatgpt-headless-user-agent"],
		["https://chatgpt.com", "chatgpt-headless-user-agent"],
		["https://dash.cloudflare.com", "cloudflare-headless-user-agent"],
	] as const) {
		const plan = buildExecutionPlan(["--profile", "Default", "open", targetUrl], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});
		// Every fixed affected-site fixture must select its expected workaround.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(plan.compatibilityWorkaround?.id, expectedId);
		const userAgentFlagIndex = plan.effectiveArgs.indexOf("--user-agent");
		// Every fixed affected-site fixture must actually inject a user-agent option.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(userAgentFlagIndex >= 0);
		// Every fixed affected-site fixture must use the qualified Chrome user agent.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(readString(plan.effectiveArgs[userAgentFlagIndex + 1]), /Chrome\/146\.0\.0\.0/);
		// Every fixed affected-site fixture must omit the problematic headless brand.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.doesNotMatch(readString(plan.effectiveArgs[userAgentFlagIndex + 1]), /HeadlessChrome/);
	}

	const cloudflarePlan = buildExecutionPlan(["open", "https://dash.cloudflare.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	const cloudflareFollowup = buildExecutionPlan(["snapshot", "-i"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionCompatibilityWorkaround: cloudflarePlan.compatibilityWorkaround,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	assert.equal(cloudflareFollowup.compatibilityWorkaround?.id, "cloudflare-headless-user-agent");
	assert.equal(
		cloudflareFollowup.effectiveArgs.filter((token) => token === "--user-agent").length,
		0,
	);

	const explicitCloudflareFollowup = buildExecutionPlan(
		["--session", "piab-demo-123", "snapshot", "-i"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionCompatibilityWorkaround: cloudflarePlan.compatibilityWorkaround,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(
		explicitCloudflareFollowup.compatibilityWorkaround?.id,
		"cloudflare-headless-user-agent",
	);
	assert.equal(
		explicitCloudflareFollowup.effectiveArgs.filter((token) => token === "--user-agent").length,
		0,
	);

	const explicitUserAgentFollowup = buildExecutionPlan(
		["--session", "piab-demo-123", "--user-agent", "Custom/1", "snapshot", "-i"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionCompatibilityWorkaround: cloudflarePlan.compatibilityWorkaround,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(explicitUserAgentFollowup.compatibilityWorkaround, undefined);
	assert.match(
		explicitUserAgentFollowup.validationError ?? "",
		/launch-scoped flags.*--user-agent/i,
	);
	assert.deepEqual(explicitUserAgentFollowup.recoveryHint?.exampleParams, {
		args: ["--user-agent", "Custom/1", "snapshot", "-i"],
		sessionMode: "fresh",
	});
	assert.equal(
		explicitUserAgentFollowup.effectiveArgs.filter((token) => token === "--user-agent").length,
		1,
	);
	const explicitUserAgentRetry = buildExecutionPlan(
		readArray(readRecord(explicitUserAgentFollowup.recoveryHint).exampleArgs).map(readString),
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 2),
			managedSessionActive: true,
			managedSessionCompatibilityWorkaround: cloudflarePlan.compatibilityWorkaround,
			managedSessionName: "piab-demo-123",
			sessionMode: "fresh",
		},
	);
	assert.equal(explicitUserAgentRetry.validationError, undefined);
	assert.equal(
		explicitUserAgentRetry.managedSessionName,
		createFreshSessionName("piab-demo-123", "seed", 2),
	);

	const compatibilityUpgrade = buildExecutionPlan(["open", "https://dash.cloudflare.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: true,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	assert.match(
		compatibilityUpgrade.validationError ?? "",
		/fresh.*compatibility user agent|compatibility user agent.*fresh/i,
	);
	assert.equal(compatibilityUpgrade.compatibilityWorkaround, undefined);
	assert.equal(compatibilityUpgrade.effectiveArgs.includes("--user-agent"), false);

	const wrongNamespaceFollowup = buildExecutionPlan(
		["--namespace", "other", "--session", "piab-demo-123", "snapshot", "-i"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionCompatibilityWorkaround: cloudflarePlan.compatibilityWorkaround,
			managedSessionName: "piab-demo-123",
			managedSessionNamespace: "team",
			sessionMode: "auto",
		},
	);
	assert.equal(wrongNamespaceFollowup.compatibilityWorkaround, undefined);

	const rawArgsPlan = buildExecutionPlan(
		["--args", "--disable-gpu", "open", "https://dash.cloudflare.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(rawArgsPlan.compatibilityWorkaround, undefined);
	assert.equal(rawArgsPlan.effectiveArgs.includes("--user-agent"), false);

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
	assert.equal(
		callerProvidedUserAgentPlan.effectiveArgs.filter((token) => token === "--user-agent").length,
		1,
	);

	const headedPlan = buildExecutionPlan(
		["--profile", "Default", "--headed", "open", "https://chatgpt.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(headedPlan.compatibilityWorkaround, undefined);

	const disabledAutoConnectPlan = buildExecutionPlan(
		["--auto-connect", "false", "open", "https://chatgpt.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(disabledAutoConnectPlan.compatibilityWorkaround?.id, "chatgpt-headless-user-agent");

	const enabledAutoConnectPlan = buildExecutionPlan(
		["--auto-connect", "open", "https://chatgpt.com"],
		{
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		},
	);
	assert.equal(enabledAutoConnectPlan.compatibilityWorkaround, undefined);

	for (const env of [
		{ AGENT_BROWSER_ENGINE: "lightpanda" },
		{ AGENT_BROWSER_PROVIDER: "browserbase" },
		{ AGENT_BROWSER_CDP: "9222" },
		{ AGENT_BROWSER_ARGS: "--disable-gpu" },
		{ AGENT_BROWSER_HEADED: "1" },
		{ AGENT_BROWSER_USER_AGENT: "Custom/1" },
		{ AGENT_BROWSER_AUTO_CONNECT: "true" },
	]) {
		// Every fixed caller launch-environment fixture must suppress wrapper compatibility defaults.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			canUseHeadlessCompatibilityUserAgent(["open", "https://dash.cloudflare.com"], env),
			false,
		);
	}
	assert.equal(
		canUseHeadlessCompatibilityUserAgent([
			"--args",
			"--disable-gpu",
			"open",
			"https://dash.cloudflare.com",
		]),
		false,
	);
	assert.equal(
		canUseHeadlessCompatibilityUserAgent(
			["--engine", "chrome", "open", "https://dash.cloudflare.com"],
			{ AGENT_BROWSER_ENGINE: "lightpanda" },
		),
		true,
	);
	assert.equal(
		canUseHeadlessCompatibilityUserAgent(
			["--headed", "false", "open", "https://dash.cloudflare.com"],
			{ AGENT_BROWSER_HEADED: "1" },
		),
		true,
	);
	assert.equal(
		canUseHeadlessCompatibilityUserAgent(
			["--auto-connect", "false", "open", "https://dash.cloudflare.com"],
			{ AGENT_BROWSER_AUTO_CONNECT: "true" },
		),
		true,
	);
	assert.equal(
		canUseHeadlessCompatibilityUserAgent([
			"--engine",
			"chrome",
			"--engine",
			"lightpanda",
			"open",
			"https://dash.cloudflare.com",
		]),
		false,
	);
	assert.equal(
		canUseHeadlessCompatibilityUserAgent([
			"--engine",
			"lightpanda",
			"--engine",
			"chrome",
			"open",
			"https://dash.cloudflare.com",
		]),
		true,
	);

	const previousEngine = process.env.AGENT_BROWSER_ENGINE;
	const previousHeaded = process.env.AGENT_BROWSER_HEADED;
	try {
		process.env.AGENT_BROWSER_ENGINE = "lightpanda";
		const lightpandaPlan = buildExecutionPlan(["open", "https://dash.cloudflare.com"], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});
		assert.equal(lightpandaPlan.compatibilityWorkaround, undefined);
		assert.equal(lightpandaPlan.effectiveArgs.includes("--user-agent"), false);

		delete process.env.AGENT_BROWSER_ENGINE;
		process.env.AGENT_BROWSER_HEADED = "1";
		const explicitHeadlessPlan = buildExecutionPlan(
			["--headed", "false", "open", "https://dash.cloudflare.com"],
			{
				freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
				managedSessionActive: false,
				managedSessionName: "piab-demo-123",
				sessionMode: "auto",
			},
		);
		assert.equal(
			explicitHeadlessPlan.compatibilityWorkaround?.id,
			"cloudflare-headless-user-agent",
		);
	} finally {
		if (previousEngine === undefined) {
			delete process.env.AGENT_BROWSER_ENGINE;
		} else {
			process.env.AGENT_BROWSER_ENGINE = previousEngine;
		}
		if (previousHeaded === undefined) {
			delete process.env.AGENT_BROWSER_HEADED;
		} else {
			process.env.AGENT_BROWSER_HEADED = previousHeaded;
		}
	}
});

test("redaction preserves harmless URL spelling", () => {
	for (const url of [
		"https://EXAMPLE.com",
		"HTTPS://EXAMPLE.com:443/A%2fb?q=a%20b&state=open&nonce=7#part",
		"ws://127.0.0.1:9222",
	]) {
		// Every harmless URL fixture must retain exact source spelling.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redactSensitiveText(`Read ${url}`), `Read ${url}`);
		// Every harmless URL fixture must retain exact invocation spelling.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(redactInvocationArgs(["open", url]), ["open", url]);
		const serialized = JSON.stringify(
			{ evidence: { prehydration: JSON.stringify({ url }) } },
			null,
			2,
		);
		// Every harmless serialized URL fixture must remain byte-preserving.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redactSensitiveText(serialized), serialized);
		// Every harmless nested URL fixture must remain unchanged.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(redactSensitiveValue({ result: serialized }), { result: serialized });
	}
});

test("redactSensitiveText masks plaintext lowercase password assignments", () => {
	const text = "password=synthetic-secret-123";
	assert.equal(redactSensitiveText(text), "password=[REDACTED]");
	assert.deepEqual(redactSensitiveValue({ text }), { text: "password=[REDACTED]" });
	assert.equal(
		redactSensitiveText("Redirect /?password=synthetic-secret-123&ok=1"),
		"Redirect /?password=[REDACTED]&ok=1",
	);
	assert.equal(
		redactSensitiveText("password=synthetic-secret-123&role=admin"),
		"password=[REDACTED]&role=admin",
	);
	assert.equal(
		redactSensitiveText("password=synthetic-secret-123&token=other-secret"),
		"password=[REDACTED]&token=[REDACTED]",
	);
});

test("redactSensitiveText preserves nested serialized JSON through repeated redaction", () => {
	const prehydration = {
		url: "https://example.test/callback?authorization_session_id=private-fixture&state=flow-fixture",
		label: 'A "quoted" value',
		count: 2,
		ready: true,
		missing: null,
	};
	const serialized = JSON.stringify(
		{
			evidence: { prehydration: JSON.stringify(prehydration), apiKey: "adjacent-fixture" },
			values: [1, false, null],
		},
		null,
		2,
	);
	const redacted = redactSensitiveText(serialized);
	const parsed = readRecord(JSON.parse(redacted));
	assert.equal(typeof readRecord(parsed.evidence).prehydration, "string");
	assert.deepEqual(JSON.parse(readString(readRecord(parsed.evidence).prehydration)), {
		...prehydration,
		url: "https://example.test/callback?authorization_session_id=%5BREDACTED%5D&state=%5BREDACTED%5D",
	});
	assert.equal(readRecord(parsed.evidence).apiKey, "[REDACTED]");
	assert.deepEqual(parsed.values, [1, false, null]);
	assert.doesNotMatch(redacted, /private-fixture|flow-fixture|adjacent-fixture/);
	assert.equal(redactSensitiveText(redacted), redacted);
	assert.deepEqual(redactSensitiveValue({ result: redacted }), { result: redacted });
});

test("redactSensitiveText redacts every serialized JSON member without dropping duplicates", () => {
	for (const [source, expected] of [
		[
			'{"url":"https://example.test/callback?token=synthetic-secret","url":"https://example.test/safe"}',
			'{"url":"https://example.test/callback?token=%5BREDACTED%5D","url":"https://example.test/safe"}',
		],
		[
			'{"value":"Authorization: Bearer synthetic-secret","value":"ordinary"}',
			'{"value":"Authorization: Bearer [REDACTED]","value":"ordinary"}',
		],
		[
			'{"value":"Cookie: sid=synthetic-secret","value":"ordinary"}',
			'{"value":"Cookie: [REDACTED]","value":"ordinary"}',
		],
		[
			'{"\\u0061piKey":{"nested":"synthetic-first"},"apiKey":["synthetic-second"],"apiKey":1234,"apiKey":false,"apiKey":null,"apiKey":"synthetic-third"}',
			'{"\\u0061piKey":"[REDACTED]","apiKey":"[REDACTED]","apiKey":"[REDACTED]","apiKey":"[REDACTED]","apiKey":"[REDACTED]","apiKey":"[REDACTED]"}',
		],
	]) {
		const redacted = redactSensitiveText(source);
		// Every fixed duplicate-key fixture must retain the independently specified redacted bytes.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redacted, expected);
		// Every fixed duplicate-key fixture must also be redaction-idempotent.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redactSensitiveText(redacted), expected);
		// Every fixed duplicate-key fixture must retain nested redaction behavior.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(redactSensitiveValue({ result: source }), { result: expected });
	}
});

test("redactSensitiveText preserves serialized JSON numeric and literal source", () => {
	const source =
		'{\n  "url" : "https://example.test/callback?token=synthetic-secret",\n  "requestId":9007199254740993,\n  "values":[-0,1.2300e+02,"0","false","null",null,true,false],\n  "label":"\\u0041"\n}\n';
	const harmless = source.replace("token=synthetic-secret", "view=all");
	assert.equal(redactSensitiveText(harmless), harmless);
	const expected = source.replace("synthetic-secret", "%5BREDACTED%5D");
	assert.equal(redactSensitiveText(source), expected);
	assert.equal(redactSensitiveText(expected), expected);
	for (const value of ['"\\u0041"', '[null,true,false,9007199254740993,"0","false","null"]']) {
		// Both fixed primitive-JSON fixtures must retain exact noncredential bytes.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redactSensitiveText(value), value);
	}
});

test("redactSensitiveText redacts auth URL keys in serialized JSON text", () => {
	const source = '{ "https://example.test/callback?token=synthetic-secret" : 9007199254740993 }';
	const expected = '{ "https://example.test/callback?token=%5BREDACTED%5D" : 9007199254740993 }';
	assert.equal(redactSensitiveText(source), expected);
	assert.equal(redactSensitiveText(expected), expected);
});

test("redactSensitiveText masks embedded JSON secrets before plaintext URL redaction", () => {
	const source =
		"Payload: " +
		JSON.stringify({
			evidence: {
				prehydration: JSON.stringify({
					url: "https://example.test/callback?authorization_session_id=private-fixture&state=flow-fixture",
				}),
				apiKey: "adjacent-fixture",
			},
		});
	const redacted = redactSensitiveText(source);
	assert.match(redacted, /^Payload: /);
	assert.match(redacted, /"apiKey":"\[REDACTED\]"/);
	assert.doesNotMatch(redacted, /private-fixture|flow-fixture|adjacent-fixture/);
	assert.equal(redactSensitiveText(redacted), redacted);
});

test("redactSensitiveText finds embedded secrets after malformed JSON prefixes", () => {
	const value = { label: 'brackets [ { ] } and a "quoted" value', apiKey: "synthetic-secret" };
	const source = JSON.stringify(value);
	const expected = JSON.stringify({ ...value, apiKey: "[REDACTED]" });
	for (const prefix of [
		"Payload: ",
		"Payload: [",
		"Payload: [{]",
		'Payload: ["unclosed ',
		String.raw`Payload: [\"escaped `,
	]) {
		// Every fixed malformed-prefix fixture must still redact embedded credentials.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redactSensitiveText(prefix + source), prefix + expected);
	}
});

test("redactInvocationArgs masks sensitive flags and auth-bearing urls", () => {
	assert.deepEqual(
		redactInvocationArgs([
			"--headers",
			'{"Authorization":"Bearer demo"}',
			"open",
			"https://user:pass@example.com/path?token=abc&ok=1#access_token=xyz",
		]),
		[
			"--headers",
			"[REDACTED]",
			"open",
			"https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/path?token=%5BREDACTED%5D&ok=1#access_token=%5BREDACTED%5D",
		],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"open",
			"https://example.com/?SAMLRequest=request-secret#state=oauth-secret&nonce=oidc-secret",
		]),
		[
			"open",
			"https://example.com/?SAMLRequest=%5BREDACTED%5D#state=%5BREDACTED%5D&nonce=%5BREDACTED%5D",
		],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"open",
			"https://example.com/sso?SAMLRequest=request-secret&RelayState=relay-secret&state=oauth-secret&nonce=oidc-secret&ok=1",
		]),
		[
			"open",
			"https://example.com/sso?SAMLRequest=%5BREDACTED%5D&RelayState=%5BREDACTED%5D&state=%5BREDACTED%5D&nonce=%5BREDACTED%5D&ok=1",
		],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"open",
			"https://signin.example.invalid/?client_id=EXAMPLE_CLIENT&redirect_uri=https%3A%2F%2Fexample.invalid%2Freturn&state=EXAMPLE_STATE&nonce=EXAMPLE_NONCE&Authorization%2DSession%2DId=EXAMPLE_ID",
		]),
		[
			"open",
			"https://signin.example.invalid/?client_id=EXAMPLE_CLIENT&redirect_uri=https%3A%2F%2Fexample.invalid%2Freturn&state=%5BREDACTED%5D&nonce=%5BREDACTED%5D&Authorization-Session-Id=%5BREDACTED%5D",
		],
	);
	assert.deepEqual(
		redactInvocationArgs(["open", "https://example.com/orders?state=open&nonce=7"]),
		["open", "https://example.com/orders?state=open&nonce=7"],
	);
	assert.deepEqual(
		redactInvocationArgs(["open", "https://example.com/path?apiKey=abc&refreshToken=def&ok=1"]),
		["open", "https://example.com/path?apiKey=%5BREDACTED%5D&refreshToken=%5BREDACTED%5D&ok=1"],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"--proxy=http://user:pass@proxy.example:8080",
			"open",
			"https://example.com",
		]),
		["--proxy=[REDACTED]", "open", "https://example.com"],
	);
	assert.deepEqual(
		redactInvocationArgs(["network", "route", "**/api", "--body", '{"token":"route-secret"}']),
		["network", "route", "**/api", "--body", "[REDACTED]"],
	);
	assert.deepEqual(redactInvocationArgs(["auth", "save", "demo", "--password", "secret-value"]), [
		"auth",
		"save",
		"demo",
		"--password",
		"[REDACTED]",
	]);
	assert.deepEqual(redactInvocationArgs(["auth", "save", "demo", "--password=secret-value"]), [
		"auth",
		"save",
		"demo",
		"--password=[REDACTED]",
	]);
	assert.deepEqual(
		redactInvocationArgs(["set", "credentials", "user@example.com", "secret-value"]),
		["set", "credentials", "[REDACTED]", "[REDACTED]"],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"--json",
			"--session",
			"demo",
			"cookies",
			"set",
			"sid",
			"cookie-secret",
			"--url",
			"https://example.com",
		]),
		[
			"--json",
			"--session",
			"demo",
			"cookies",
			"set",
			"sid",
			"[REDACTED]",
			"--url",
			"https://example.com",
		],
	);
	for (const args of [
		["cookies", "set", "--curl", "/tmp/cookies.txt"],
		["--json", "--session", "demo", "cookies", "set", "--curl", "/tmp/cookie file.txt"],
		["cookies", "set", "--domain", "example.test", "--curl", "/tmp/cookies.txt"],
		["cookies", "set", "unused", "ignored", "--curl", "/tmp/cookies.txt"],
		["batch", "cookies set --curl '/tmp/cookie file.txt'"],
	]) {
		// Every fixed curl-cookie path fixture must remain a usable native file operand.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(redactInvocationArgs(args), args);
	}
	assert.deepEqual(
		redactInvocationArgs(["--session", "--curl", "cookies", "set", "sid", "cookie-secret"]),
		["--session", "--curl", "cookies", "set", "sid", "[REDACTED]"],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"cookies",
			"set",
			"--curl",
			"/tmp/cookies.txt",
			"--headers",
			'{"Authorization":"Bearer cookie-secret"}',
		]),
		["cookies", "set", "--curl", "/tmp/cookies.txt", "--headers", "[REDACTED]"],
	);
	assert.deepEqual(redactInvocationArgs(["batch", "cookies set sid cookie-secret"]), [
		"batch",
		"'cookies' 'set' 'sid' '[REDACTED]'",
	]);
	assert.deepEqual(
		redactInvocationArgs(["storage", "local", "set", "authToken", "storage-secret"]),
		["storage", "local", "set", "authToken", "[REDACTED]"],
	);
	assert.deepEqual(
		redactInvocationArgs([
			"--json",
			"--session",
			"demo",
			"clipboard",
			"write",
			"clipboard-secret",
			"extra-secret",
		]),
		["--json", "--session", "demo", "clipboard", "write", "[REDACTED]", "[REDACTED]"],
	);
	assert.deepEqual(redactInvocationArgs(["chat", "Summarize Authorization: Bearer chat-secret"]), [
		"chat",
		"Summarize Authorization: Bearer [REDACTED]",
	]);
});

test("redactSensitiveText redacts bearer tokens before Windows path separators", () => {
	const path = String.raw`C:\fixture\Bearer directory-secret\out.png`;
	const redacted = String.raw`C:\fixture\Bearer [REDACTED]\out.png`;
	assert.equal(redactSensitiveText(path), redacted);
	assert.equal(redactSensitiveText(JSON.stringify({ path })), JSON.stringify({ path: redacted }));
	assert.equal(redactSensitiveText(`mkdir '${path}'`), `mkdir '${redacted}'`);
});

test("redactSensitiveText preserves bearer prose while redacting credential contexts", () => {
	for (const text of [
		"The endpoint requires a bearer token.",
		"Bearer authentication uses an access token.",
		"Do not log bearer tokens or bearer credentials.",
		"The phrase “bearer token.” is public.",
		"Description: Bearer authentication uses an access token.",
		"Authorization bearer tokens are credentials.",
		"Bearer <code>token</code>",
		"Bearer https://docs.example/guide",
		"Use `bearer token.` or **bearer authentication.** as technical terms.",
	]) {
		// Every fixed public bearer-description fixture must remain unredacted.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(redactSensitiveText(text), text);
	}
	assert.equal(
		redactSensitiveText("Headers help: --headers <json> (e.g., Authorization bearer token)"),
		"Headers help: --headers <json> (e.g., Authorization bearer token)",
	);
	assert.equal(
		redactSensitiveText("Error: Authorization: Bearer raw-token)"),
		"Error: Authorization: Bearer [REDACTED])",
	);
	assert.equal(
		redactSensitiveText("Authorization bearer raw-token."),
		"Authorization bearer [REDACTED].",
	);
	assert.equal(
		redactSensitiveText("Authorization bearer secrettoken"),
		"Authorization bearer secrettoken",
	);
	assert.equal(redactSensitiveText("Authorization bearer token,"), "Authorization bearer token,");
	assert.equal(redactSensitiveText("curl -H 'Bearer secrettoken'"), "curl -H 'Bearer [REDACTED]'");
	assert.equal(redactSensitiveText("curl -H 'Bearer abc123'"), "curl -H 'Bearer [REDACTED]'");
	assert.equal(redactSensitiveText("curl -H 'Bearer token.'"), "curl -H 'Bearer [REDACTED].'");
	const proxyHeader = redactSensitiveText("Proxy-Authorization: Bearer token");
	assert.match(proxyHeader, /^Proxy-Authorization:.*\[REDACTED\]$/);
	assert.doesNotMatch(proxyHeader, /\btoken\b/);
	assert.equal(
		redactSensitiveText("curl --header='Bearer token'"),
		"curl --header='Bearer [REDACTED]'",
	);
	for (const text of [
		"Authorization: 'Bearer canary'",
		"Authorization=Bearer canary",
		"X-Api-Key: Bearer canary",
	]) {
		const redacted = redactSensitiveText(text);
		// Every fixed authorization-header fixture must replace its credential.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(redacted, /\[REDACTED\]/);
		// Every fixed authorization-header fixture must remove its independent canary.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.doesNotMatch(redacted, /canary/);
	}
	assert.equal(
		redactSensitiveText("Observed Bearer mF_9.B5f-4.1JqM."),
		"Observed Bearer [REDACTED].",
	);
	assert.deepEqual(
		redactSensitiveValue({
			Authorization: "Bearer token",
			"Proxy-Authorization": "Bearer credentials",
		}),
		{ Authorization: "[REDACTED]", "Proxy-Authorization": "[REDACTED]" },
	);
	assert.equal(
		redactSensitiveText(
			"OPENAI_API_KEY=openai-secret AWS_SECRET_ACCESS_KEY: aws-secret export STRIPE_SECRET_KEY='stripe-secret' PRIVATE_KEY=-----BEGIN_PRIVATE_KEY----- X-Private-Key: prose-header-secret private-key=prose-key API-KEY=prose-api Secret-Key: prose-secret apiKey=camel-api privateKey: camel-private connectionString=camel-connection databaseUrl: camel-db mongodbUri=mongodb://user:pass@example/db MONGODB_URI=mongodb://user:pass@example/db failedChecks=true",
		),
		"OPENAI_API_KEY=[REDACTED] AWS_SECRET_ACCESS_KEY: [REDACTED] export STRIPE_SECRET_KEY=[REDACTED] PRIVATE_KEY=[REDACTED] X-Private-Key: [REDACTED] private-key=[REDACTED] API-KEY=[REDACTED] Secret-Key: [REDACTED] apiKey=[REDACTED] privateKey: [REDACTED] connectionString=[REDACTED] databaseUrl: [REDACTED] mongodbUri=[REDACTED] MONGODB_URI=[REDACTED] failedChecks=true",
	);
	for (const prefix of ["API_KEY=", "X-Api-Key: "]) {
		// Both fixed secret-field spellings must redact their JSON-shaped assignment.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			redactSensitiveText(`${prefix}{"value":"assignment-fixture"} status=ok`),
			`${prefix}[REDACTED] status=ok`,
		);
	}
	assert.equal(
		redactSensitiveText(
			"Redirect /sso?SAMLRequest=request-secret&SAMLResponse=response-secret&RelayState=relay-secret#state=oauth-secret&nonce=oidc-secret",
		),
		"Redirect /sso?SAMLRequest=[REDACTED]&SAMLResponse=[REDACTED]&RelayState=[REDACTED]#state=[REDACTED]&nonce=[REDACTED]",
	);
	assert.equal(
		redactSensitiveText(
			"Redirect /?authorizationSessionId=EXAMPLE_ID&state=EXAMPLE_STATE#nonce=EXAMPLE_NONCE&view=table",
		),
		"Redirect /?authorizationSessionId=[REDACTED]&state=[REDACTED]#nonce=[REDACTED]&view=table",
	);
	assert.equal(
		redactSensitiveText("Login help. Status /orders?state=open&nonce=7"),
		"Login help. Status /orders?state=open&nonce=7",
	);
	assert.equal(
		redactSensitiveText(
			"Redirect /?SAMLRequest=request-secret#state=oauth-secret then /orders?state=open",
		),
		"Redirect /?SAMLRequest=[REDACTED]#state=[REDACTED] then /orders?state=open",
	);
	assert.equal(
		redactSensitiveText(
			"https://o914390.ingest.sentry.io/api/envelope/?sentry_key=sentry-secret&writeKey=write-secret&ok=1",
		),
		"https://o914390.ingest.sentry.io/api/envelope/?sentry_key=%5BREDACTED%5D&writeKey=%5BREDACTED%5D&ok=1",
	);
	assert.equal(
		redactSensitiveText(
			"https://example.com/?private_key=url-private-secret&connection_string=db-secret&mongo_uri=mongo-secret&redis_url=redis-secret&database_url=database-secret&ok=1",
		),
		"https://example.com/?private_key=%5BREDACTED%5D&connection_string=%5BREDACTED%5D&mongo_uri=%5BREDACTED%5D&redis_url=%5BREDACTED%5D&database_url=%5BREDACTED%5D&ok=1",
	);
	assert.equal(
		redactSensitiveText(
			"Error mongodb://user:pass@example/db and mongodb+srv://srv-user:srv-pass@example/db and redis://redis-user:redis-pass@example/0",
		),
		"Error mongodb://%5BREDACTED%5D:%5BREDACTED%5D@example/db and mongodb+srv://%5BREDACTED%5D:%5BREDACTED%5D@example/db and redis://%5BREDACTED%5D:%5BREDACTED%5D@example/0",
	);
	assert.equal(
		redactSensitiveText(
			"Error mongodb://user:pa)ss@example/db?token=secret&ok=1 mongodb://user:p]ss@example/db?private_key=secret&ok=1 mongodb://user:p>ss@example/db#access_token=secret&ok=1",
		),
		"Error mongodb://[REDACTED]:[REDACTED]@example/db?token=[REDACTED]&ok=1 mongodb://[REDACTED]:[REDACTED]@example/db?private_key=[REDACTED]&ok=1 mongodb://[REDACTED]:[REDACTED]@example/db#access_token=[REDACTED]&ok=1",
	);
	assert.equal(
		redactSensitiveText("Error mongodb://[REDACTED]:[REDACTED]@example/db?token=secret&ok=1"),
		"Error mongodb://[REDACTED]:[REDACTED]@example/db?token=[REDACTED]&ok=1",
	);
});

test("redactSensitiveText scans long tokens without blocking the host", () => {
	const input = "A".repeat(200_000);
	const startedAt = Date.now();
	assert.equal(redactSensitiveText(input), input);
	assert.ok(
		Date.now() - startedAt < 1_000,
		"redacting a 200k token should finish in under one second",
	);
});

test("redactSensitiveText does not rescan unmatched JSON prefixes", () => {
	// A separate process makes the watchdog effective even if redaction blocks the event loop.
	const probe = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		import assert from "node:assert/strict";
		import { redactSensitiveText } from ${JSON.stringify(new URL("../extensions/agent-browser/lib/runtime.ts", import.meta.url).href)};
		for (const input of [
			"[".repeat(64_000),
			"[".repeat(64_000) + "]",
			'{\\\\"'.repeat(32_000),
			'["' + '[\\\\"'.repeat(64_000) + '"' + "x".repeat(64_000),
		]) assert.equal(redactSensitiveText(input), input);
	`,
		],
		{ encoding: "utf8", timeout: 5_000 },
	);
	assert.equal(
		probe.error,
		undefined,
		`redaction did not finish: ${probe.error?.message ?? "none"}`,
	);
	assert.equal(probe.status, 0, probe.stderr);
});

test("redactSensitiveValue masks obvious secret-bearing object keys", () => {
	assert.deepEqual(redactSensitiveValue({ state: "ready", nonceCount: 3 }), {
		state: "ready",
		nonceCount: 3,
	});
	assert.deepEqual(
		redactSensitiveValue({
			apiKey: "abc",
			openaiApiKey: "openai-secret",
			OPENAI_API_KEY: "openai-env-secret",
			AWS_SECRET_ACCESS_KEY: "aws-env-secret",
			STRIPE_SECRET_KEY: "stripe-env-secret",
			PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
			private_key: "private-key-secret",
			"X-Private-Key": "header-private-key-secret",
			privateKey: "camel-private-key-secret",
			connectionString: "camel-connection-string-secret",
			mongodbUri: "mongodb://user:pass@example/db",
			MONGODB_URI: "mongodb://user:pass@example/db",
			databaseUrl: "postgres://db-secret",
			DATABASE_URL: "postgres://env-db-secret",
			nested: {
				authorization: "Bearer demo",
				ok: "https://example.com/?ok=1&token=abc",
				"set-cookie": "sid=abc",
			},
			status: { code: "ERR_BLOCKED_BY_CLIENT", key: "Enter" },
		}),
		{
			apiKey: "[REDACTED]",
			openaiApiKey: "[REDACTED]",
			OPENAI_API_KEY: "[REDACTED]",
			AWS_SECRET_ACCESS_KEY: "[REDACTED]",
			STRIPE_SECRET_KEY: "[REDACTED]",
			PRIVATE_KEY: "[REDACTED]",
			private_key: "[REDACTED]",
			"X-Private-Key": "[REDACTED]",
			privateKey: "[REDACTED]",
			connectionString: "[REDACTED]",
			mongodbUri: "[REDACTED]",
			MONGODB_URI: "[REDACTED]",
			databaseUrl: "[REDACTED]",
			DATABASE_URL: "[REDACTED]",
			nested: {
				authorization: "[REDACTED]",
				ok: "https://example.com/?ok=1&token=%5BREDACTED%5D",
				"set-cookie": "[REDACTED]",
			},
			status: { code: "ERR_BLOCKED_BY_CLIENT", key: "Enter" },
		},
	);
});

test("parseCommandInfo recognizes representative current command families", () => {
	for (const { args, expected } of [
		{
			args: ["open", "https://example.com"],
			expected: { command: "open", subcommand: "https://example.com" },
		},
		{
			args: ["find", "role", "button", "click", "--name", "Export"],
			expected: { command: "find", subcommand: "role" },
		},
		{
			args: ["wait", "--download", "/tmp/report.csv", "--timeout", "25000"],
			expected: { command: "wait", subcommand: "--download" },
		},
		{
			args: ["wait", "@button", "--state", "hidden"],
			expected: { command: "wait", subcommand: "@button" },
		},
		{
			args: ["network", "route", "**/*.js", "--resource-type", "script"],
			expected: { command: "network", subcommand: "route" },
		},
		{
			args: ["cookies", "set", "--curl", "/tmp/cookies.txt", "--domain", "example.com"],
			expected: { command: "cookies", subcommand: "set" },
		},
		{
			args: ["auth", "save", "demo", "--password-stdin"],
			expected: { command: "auth", subcommand: "save" },
		},
		{
			args: ["dashboard", "start", "--port", "4567"],
			expected: { command: "dashboard", subcommand: "start" },
		},
		{
			args: ["doctor", "--offline", "--quick"],
			expected: { command: "doctor", subcommand: undefined },
		},
		{
			args: ["install", "--with-deps"],
			expected: { command: "install", subcommand: "--with-deps" },
		},
		{ args: ["upgrade"], expected: { command: "upgrade", subcommand: undefined } },
		{
			args: ["chat", "Summarize", "--model", "gpt-5.1"],
			expected: { command: "chat", subcommand: "Summarize" },
		},
		{
			args: ["react", "renders", "stop", "--json"],
			expected: { command: "react", subcommand: "renders" },
		},
		{
			args: ["vitals", "https://example.com", "--json"],
			expected: { command: "vitals", subcommand: "https://example.com" },
		},
		{
			args: ["stream", "enable", "--port", "7777"],
			expected: { command: "stream", subcommand: "enable" },
		},
		{
			args: ["webmcp", "invoke", "search", "--params", "{}", "--frame", "main"],
			expected: { command: "webmcp", subcommand: "invoke" },
		},
		{
			args: ["tab", "new", "--label", "Docs", "https://example.com"],
			expected: { command: "tab", subcommand: "new" },
		},
		{
			args: ["--session", "named", "--profile", "./profile", "tab", "list"],
			expected: { command: "tab", subcommand: "list" },
		},
		{
			args: [
				"--user-agent",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
				"--args",
				"--disable-gpu,--lang=en-US",
				"open",
				"https://example.com",
			],
			expected: { command: "open", subcommand: "https://example.com" },
		},
	] as const) {
		// Every command-family row is checked against its explicit expected parse result.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(parseCommandInfo([...args]), expected);
	}
});

test("parseCommandInfo recognizes open targets after command-scoped init flags", () => {
	assert.deepEqual(
		parseCommandInfo(["open", "--enable", "react-devtools", "https://example.com"]),
		{
			command: "open",
			subcommand: "https://example.com",
		},
	);
	assert.deepEqual(
		parseCommandInfo(["open", "--init-script", "/tmp/setup.js", "https://example.com"]),
		{
			command: "open",
			subcommand: "https://example.com",
		},
	);
	assert.deepEqual(
		parseCommandInfo(["--enable", "react-devtools", "open", "https://example.com"]),
		{
			command: "open",
			subcommand: "https://example.com",
		},
	);
});

test("parseCommandInfo skips optional boolean flag values before commands", () => {
	assert.deepEqual(parseCommandInfo(["--headed", "false", "open", "https://chatgpt.com"]), {
		command: "open",
		subcommand: "https://chatgpt.com",
	});
	assert.deepEqual(parseCommandInfo(["--debug", "true", "tab", "list"]), {
		command: "tab",
		subcommand: "list",
	});
	assert.deepEqual(parseCommandInfo(["--webgpu", "false", "open", "https://example.com"]), {
		command: "open",
		subcommand: "https://example.com",
	});
	assert.deepEqual(parseCommandInfo(["--no-webmcp", "false", "webmcp", "list"]), {
		command: "webmcp",
		subcommand: "list",
	});
	assert.deepEqual(
		parseCommandInfo([
			"--ca-cert",
			"/tmp/proxy-ca.pem",
			"--no-ca-cert",
			"false",
			"open",
			"https://example.com",
		]),
		{
			command: "open",
			subcommand: "https://example.com",
		},
	);
});

test("command taxonomy resolves aliases through capability predicates", () => {
	assert.equal(isCloseCommand("quit"), true);
	assert.equal(isCloseCommand("exit"), true);
	assert.equal(isOpenNavigationCommand("goto"), true);
	assert.equal(isOpenNavigationCommand("navigate"), true);
	assert.equal(isRefInvalidatingBatchCommand(["key"]), true);
	assert.equal(isRefGuardedCommand("scrollinto"), true);
	assert.equal(isCloseCommand("unknown-command"), false);
});

test("command taxonomy keeps independent capability dimensions explicit", () => {
	assert.equal(isRefGuardedCommand("fill"), true);
	assert.equal(isPageMutationCommand("fill"), true);
	assert.equal(isPageChangeSummaryCommand("fill"), true);
	assert.equal(isRefInvalidatingBatchCommand(["fill"]), false);

	assert.equal(isRefGuardedCommand("download"), true);
	assert.equal(isPageMutationCommand("download"), false);
	assert.equal(isPageChangeSummaryCommand("download"), true);
	assert.equal(isRefInvalidatingBatchCommand(["download"]), false);

	assert.equal(isRefGuardedCommand("scrollintoview"), true);
	assert.equal(isPageMutationCommand("scrollintoview"), true);
	assert.equal(isPageChangeSummaryCommand("scrollintoview"), true);
	assert.equal(isRefInvalidatingBatchCommand(["scrollintoview"]), true);
});

test("command taxonomy guards exactly the upstream ref-resolving selector commands", () => {
	// Complete guarded set from COMMAND_CAPABILITIES, aliases such as `scrollinto` included. The
	// unguarded list covers every other command token the wrapper knows, so dropping `guardsPageRefs`
	// from a real command or adding it to an unrelated one (for example `pdf`) both fail here.
	const guardedCommands = [
		"check",
		"click",
		"dblclick",
		"diff",
		"download",
		"drag",
		"fill",
		"focus",
		"frame",
		"get",
		"highlight",
		"hover",
		"is",
		"screenshot",
		"scroll",
		"scrollinto",
		"scrollintoview",
		"select",
		"tap",
		"type",
		"uncheck",
		"upload",
	];
	const unguardedCommands = [
		"a11y",
		"auth",
		"back",
		"batch",
		"chat",
		"clipboard",
		"close",
		"confirm",
		"connect",
		"console",
		"cookies",
		"dashboard",
		"deny",
		"device",
		"dialog",
		"doctor",
		"errors",
		"eval",
		"exit",
		"find",
		"forward",
		"goto",
		"inspect",
		"install",
		"key",
		"keyboard",
		"keydown",
		"keyup",
		"mcp",
		"mouse",
		"navigate",
		"network",
		"open",
		"pdf",
		"plugin",
		"plugins",
		"press",
		"profiler",
		"profiles",
		"pushstate",
		"quit",
		"react",
		"read",
		"record",
		"reload",
		"removeinitscript",
		"session",
		"set",
		"skills",
		"snapshot",
		"state",
		"storage",
		"stream",
		"swipe",
		"tab",
		"trace",
		"upgrade",
		"vitals",
		"wait",
		"web-vitals",
		"webmcp",
		"window",
	];
	const knownCommands = [...guardedCommands, ...unguardedCommands];
	assert.equal(
		new Set(knownCommands).size,
		knownCommands.length,
		"guarded and unguarded lists must stay disjoint",
	);
	for (const command of knownCommands) {
		// Exhaustive fixture variant (knownCommands): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(isKnownCommandToken(command), true, `${command} is not a known command token`);
	}
	// diff guarding is deliberately command-level: diff screenshot resolves refs while diff snapshot's
	// selector is CSS-only, but the wrapper's stale-ref guidance is a clearer failure than upstream's
	// invalid-selector error and subcommand precision buys nothing observable.
	assert.deepEqual(
		knownCommands.filter(isRefGuardedCommand),
		guardedCommands,
		"guarded set must match the complete ref-resolving list",
	);
	// Upstream passes these selectors/operands through literally and never resolves @e refs for them,
	// so guarding would falsely reject literal tokens such as `wait --text @e1` or `find text @e1 click`.
	for (const command of ["a11y", "find", "wait"]) {
		// Exhaustive fixture variant (["a11y", "find", "wait"]): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(isRefGuardedCommand(command), false, command);
	}
});

test("WebMCP mutation commands invalidate refs while list remains read-only", () => {
	assert.equal(isPageMutationCommand("webmcp", "list"), false);
	assert.equal(isPageMutationCommand("webmcp", "invoke"), true);
	assert.equal(isPageChangeSummaryCommand("webmcp", "result"), true);
	assert.equal(isUnverifiedPageTransitionCommand("webmcp", "cancel"), true);
	assert.equal(isRefInvalidatingBatchCommand(["webmcp", "list"]), false);
	assert.equal(isRefInvalidatingBatchCommand(["webmcp", "invoke", "set_message"]), true);
});

test("recording FPS without a URL preserves restart refs", () => {
	// `out.webm` is the bare path-operand form without Chromium-style flags.
	for (const operands of [
		["take.webm", "--fps", "30"],
		["--fps", "+24", "take.webm"],
		["--fps", "12", "take.webm", "--fps", "24"],
		["out.webm"],
	]) {
		// Every FPS position and start/restart variant must preserve the recording operand contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(isRecordPageTransitionCommand(["record", "restart", ...operands]), false);
		// Every FPS position and start/restart variant must preserve the recording operand contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(isRefInvalidatingBatchCommand(["record", "restart", ...operands]), false);
		// Every FPS position and start/restart variant must preserve the recording operand contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			isRecordPageTransitionCommand(["record", "start", ...operands]),
			true,
			"older native starts replace the page even on failure",
		);
		// Every FPS position and start/restart variant must preserve the recording operand contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			isRefInvalidatingBatchCommand(["record", "start", ...operands]),
			true,
			"older native starts still need conservative ref protection",
		);
		// Every FPS position and start/restart variant must preserve the recording operand contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			isRecordPageTransitionCommand(["record", "restart", ...operands, "https://example.com"]),
			true,
		);
		// Every FPS position and start/restart variant must preserve the recording operand contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			isRefInvalidatingBatchCommand(["record", "restart", ...operands, "https://example.com"]),
			true,
			"a navigating restart replaces the page",
		);
	}
	assert.equal(isRecordPageTransitionCommand(["record", "stop"]), false);
	assert.equal(isRefInvalidatingBatchCommand(["record", "stop"]), false);
});
