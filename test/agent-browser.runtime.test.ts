/**
 * Purpose: Verify pure runtime planning and policy helpers for the pi-agent-browser extension.
 * Responsibilities: Assert session naming, managed-session restoration, execution-plan argument injection, and redaction helpers.
 * Scope: Unit-style Node test-runner coverage for stable helper behavior; extension entrypoint lifecycle tests live in focused integration suites.
 * Usage: Run with `npx tsx --test test/agent-browser.runtime.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests preserve existing assertions and isolate filesystem/env side effects with temp directories and explicit cleanup.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isRecord, parsePositiveInteger } from "../extensions/agent-browser/lib/parsing.js";
import { getAgentBrowserSocketDir } from "../extensions/agent-browser/lib/process.js";
import {
	buildExecutionPlan,
	createFreshSessionName,
	createImplicitSessionName,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	hasLaunchScopedTabCorrectionFlag,
	hasUsableBraveApiKey,
	redactInvocationArgs,
	redactSensitiveText,
	redactSensitiveValue,
	resolveManagedSessionState,
	restoreManagedSessionStateFromBranch,
} from "../extensions/agent-browser/lib/runtime.js";
import { createToolBranchEntry } from "./helpers/agent-browser-harness.js";

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
		1200,
	);
	assert.equal(getImplicitSessionIdleTimeoutMs({ AGENT_BROWSER_IDLE_TIMEOUT_MS: "2100" }), 2100);
	assert.equal(getImplicitSessionIdleTimeoutMs({ PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "invalid" }), 900000);
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

		assert.equal(restored.active, false, command);
		assert.equal(restored.sessionName, "piab-demo-123", command);
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

test("restoreManagedSessionStateFromBranch honors Electron cleanup managed-session steps", () => {
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
							results: [{
								launchId: "electron-demo",
								partial: true,
								record: { cleanupState: "partial", launchId: "electron-demo", port: 9222, version: 1 },
								remainingResources: ["process"],
								steps: [
									{ resource: "managed-session", sessionName: "piab-demo-123-fresh-electron", state: "removed" },
									{ resource: "process", state: "failed" },
								],
								summary: "Electron cleanup was partial.",
							}],
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
		sessionName: "piab-demo-123",
	});
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

test("buildExecutionPlan treats upstream close aliases as managed-session closes", () => {
	for (const command of ["close", "quit", "exit"] as const) {
		const plan = buildExecutionPlan([command], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "piab-demo-123", command], command);
		assert.equal(plan.managedSessionName, "piab-demo-123", command);
		assert.equal(plan.sessionName, "piab-demo-123", command);
		assert.equal(plan.usedImplicitSession, true, command);
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
});

test("buildExecutionPlan keeps inspection commands stateless", () => {
	for (const args of [["--version"], ["--help"], ["snapshot", "--help"]] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.equal(plan.plainTextInspection, true);
		assert.deepEqual(plan.effectiveArgs, [...args]);
		assert.equal(plan.managedSessionName, undefined);
		assert.equal(plan.sessionName, undefined);
		assert.equal(plan.usedImplicitSession, false);
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
		["dashboard", "start", "--port", "4848"],
		["device", "list"],
		["dashboard", "stop"],
		["dashboard", "stop", "--json"],
		["doctor", "--offline", "--quick"],
		["install", "--with-deps"],
		["install", "-d"],
		["upgrade"],
		["profiles", "--json"],
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
	] as const) {
		const callerArgs = [...args];
		const plan = buildExecutionPlan(callerArgs, {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		const expectedEffectiveArgs = callerArgs.includes("--json") ? callerArgs : ["--json", ...callerArgs];

		assert.equal(plan.plainTextInspection, false);
		assert.deepEqual(plan.effectiveArgs, expectedEffectiveArgs);
		assert.equal(plan.managedSessionName, undefined);
		assert.equal(plan.sessionName, undefined);
		assert.equal(plan.usedImplicitSession, false);
		assert.equal(plan.validationError, undefined);
	}
});

test("buildExecutionPlan still injects managed sessions for browser-backed state and auth commands", () => {
	for (const args of [["state", "save", "./auth.json"], ["state", "load", "./auth.json"], ["auth", "login", "demo"]] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "piab-demo-123", ...args]);
		assert.equal(plan.usedImplicitSession, true);
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
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "piab-demo-123", ...args], args.join(" "));
		assert.equal(plan.usedImplicitSession, true, args.join(" "));
	}
});

test("buildExecutionPlan rejects missing values for global value-taking flags before launching upstream", () => {
	for (const args of [["--session"], ["--profile"], ["--executable-path"], ["--session-name"], ["--cdp"], ["--state"], ["--init-script"], ["--enable"], ["--download-path"], ["--model"], ["--idle-timeout"], ["open", "https://example.com", "--profile"]] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: false,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		const expectedFlag = [...args].reverse().find((token) => token.startsWith("-"));
		assert.match(plan.validationError ?? "", /requires a value/i);
		assert.equal(plan.invalidValueFlag?.flag, expectedFlag);
		assert.equal(plan.invalidValueFlag?.reason, "missing-value");
		assert.deepEqual(plan.commandInfo, {});
		assert.equal(plan.sessionName, undefined);
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

		assert.equal(plan.validationError, undefined, args.join(" "));
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
});

test("buildExecutionPlan allows dash-starting --args values", () => {
	const plan = buildExecutionPlan(["--args", "--disable-gpu,--lang=en-US", "open", "https://example.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});

	assert.equal(plan.validationError, undefined);
	assert.deepEqual(plan.commandInfo, { command: "open", subcommand: "https://example.com" });
	assert.deepEqual(plan.effectiveArgs.slice(-4), ["--args", "--disable-gpu,--lang=en-US", "open", "https://example.com"]);
});

test("buildExecutionPlan blocks startup-scoped flags from silently reusing an active implicit session", () => {
	for (const { args, flag } of [
		{ args: ["--profile", "Default", "open", "https://example.com"], flag: "--profile" },
		{ args: ["--executable-path", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "open", "https://example.com"], flag: "--executable-path" },
		{ args: ["--session-name", "saved-auth", "open", "https://example.com"], flag: "--session-name" },
		{ args: ["--cdp", "ws://127.0.0.1:9222/devtools/browser/demo", "open", "https://example.com"], flag: "--cdp" },
		{ args: ["--state", "/tmp/auth.json", "open", "https://example.com"], flag: "--state" },
		{ args: ["--auto-connect", "open", "https://example.com"], flag: "--auto-connect" },
		{ args: ["--auto-connect", "true", "open", "https://example.com"], flag: "--auto-connect" },
		{ args: ["open", "--enable", "react-devtools", "https://example.com"], flag: "--enable" },
		{ args: ["open", "--init-script", "/tmp/setup.js", "https://example.com"], flag: "--init-script" },
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.match(plan.validationError ?? "", /launch-scoped flags/i);
		assert.equal(plan.startupScopedFlags.length, 1);
		assert.equal(plan.startupScopedFlags[0], flag);
		assert.equal(plan.usedImplicitSession, false);
		assert.equal(plan.recoveryHint?.recommendedSessionMode, "fresh");
		assert.deepEqual(plan.recoveryHint?.exampleParams, { args: [...args], sessionMode: "fresh" });
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

test("buildExecutionPlan allows disabled auto-connect after an active implicit session", () => {
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
});

test("hasLaunchScopedTabCorrectionFlag detects profile, session-name, and state but not executable, cdp, provider, or auto-connect", () => {
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--profile", "Default", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--profile=Default", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--session-name", "saved", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--session-name=saved", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--state", "/tmp/auth.json", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--state=/tmp/auth.json", "open", "https://example.com"]), true);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--executable-path", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--cdp", "ws://127.0.0.1:9222/devtools/browser/demo", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["-p", "ios", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--provider", "browserbase", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["--auto-connect", "open", "https://example.com"]), false);
	assert.equal(hasLaunchScopedTabCorrectionFlag(["open", "https://example.com"]), false);
});

test("buildExecutionPlan treats provider and iOS device flags as launch-scoped", () => {
	for (const args of [
		["-p", "ios", "open", "https://example.com"],
		["--provider", "browserbase", "open", "https://example.com"],
		["-p", "ios", "--device", "iPhone 15 Pro", "open", "https://example.com"],
	] as const) {
		const plan = buildExecutionPlan([...args], {
			freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
			managedSessionActive: true,
			managedSessionName: "piab-demo-123",
			sessionMode: "auto",
		});

		assert.match(plan.validationError ?? "", /launch-scoped flags/i, args.join(" "));
		assert.equal(plan.recoveryHint?.recommendedSessionMode, "fresh", args.join(" "));
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

	const disabledAutoConnectPlan = buildExecutionPlan(["--auto-connect", "false", "open", "https://chatgpt.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	assert.equal(disabledAutoConnectPlan.compatibilityWorkaround?.id, "chatgpt-headless-user-agent");

	const enabledAutoConnectPlan = buildExecutionPlan(["--auto-connect", "open", "https://chatgpt.com"], {
		freshSessionName: createFreshSessionName("piab-demo-123", "seed", 1),
		managedSessionActive: false,
		managedSessionName: "piab-demo-123",
		sessionMode: "auto",
	});
	assert.equal(enabledAutoConnectPlan.compatibilityWorkaround, undefined);
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
	assert.deepEqual(redactInvocationArgs(["network", "route", "**/api", "--body", '{"token":"route-secret"}']), [
		"network",
		"route",
		"**/api",
		"--body",
		"[REDACTED]",
	]);
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
	assert.deepEqual(redactInvocationArgs(["set", "credentials", "user@example.com", "secret-value"]), [
		"set",
		"credentials",
		"[REDACTED]",
		"[REDACTED]",
	]);
	assert.deepEqual(redactInvocationArgs(["--json", "--session", "demo", "cookies", "set", "sid", "cookie-secret", "--url", "https://example.com"]), [
		"--json",
		"--session",
		"demo",
		"cookies",
		"set",
		"sid",
		"[REDACTED]",
		"--url",
		"https://example.com/",
	]);
	assert.deepEqual(redactInvocationArgs(["storage", "local", "set", "authToken", "storage-secret"]), [
		"storage",
		"local",
		"set",
		"authToken",
		"[REDACTED]",
	]);
	assert.deepEqual(redactInvocationArgs(["chat", "Summarize Authorization: Bearer chat-secret"]), [
		"chat",
		"Summarize Authorization: Bearer [REDACTED]",
	]);
});

test("redactSensitiveText preserves help placeholders while redacting bearer credentials", () => {
	assert.equal(
		redactSensitiveText('Headers help: --headers <json> (e.g., Authorization bearer token)'),
		'Headers help: --headers <json> (e.g., Authorization bearer token)',
	);
	assert.equal(redactSensitiveText("Error: Authorization: Bearer raw-token)"), "Error: Authorization: Bearer [REDACTED])");
	assert.equal(redactSensitiveText("Authorization bearer raw-token."), "Authorization bearer [REDACTED].");
	assert.equal(redactSensitiveText("Authorization bearer secrettoken"), "Authorization bearer [REDACTED]");
	assert.equal(redactSensitiveText("Authorization bearer token,"), "Authorization bearer [REDACTED],");
	assert.equal(redactSensitiveText("curl -H 'Bearer secrettoken'"), "curl -H 'Bearer [REDACTED]'");
	assert.equal(redactSensitiveText("curl -H 'Bearer abc123'"), "curl -H 'Bearer [REDACTED]'");
	assert.equal(redactSensitiveText("curl -H 'Bearer token.'"), "curl -H 'Bearer [REDACTED].'");
	assert.equal(
		redactSensitiveText("https://o914390.ingest.sentry.io/api/envelope/?sentry_key=sentry-secret&writeKey=write-secret&ok=1"),
		"https://o914390.ingest.sentry.io/api/envelope/?sentry_key=%5BREDACTED%5D&writeKey=%5BREDACTED%5D&ok=1",
	);
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

