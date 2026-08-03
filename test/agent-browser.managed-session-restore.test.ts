/**
 * Purpose: Verify automatic restore policy for wrapper-managed agent-browser sessions.
 * Responsibilities: Assert ownership isolation, incompatible-mode suppression, config/storage fail-closed behavior, and sticky restore state.
 * Scope: Unit-style managed-session restore tests; general runtime planning stays in agent-browser.runtime.test.ts.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	agentBrowserConfigBlocksManagedRestore,
	buildOwnedManagedSessionRestoreContext,
	createManagedSessionRestoreKey,
	ensureManagedSessionRestoreStorageIsSecure,
	getManagedSessionRestoreEnv,
	ManagedSessionRestoreState,
	pruneOwnedManagedSessionRestoreSnapshots,
	resolveOwnedManagedSessionContext,
	withOwnedManagedSessionContext,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import { buildExecutionPlan, restoreManagedSessionStateFromBranch } from "../extensions/agent-browser/lib/runtime.js";

const isolatedHome = mkdtempSync(join(tmpdir(), "piab-restore-suite-home-"));
const managedSessionRestoreState = new ManagedSessionRestoreState();
const clearManagedSessionRestoreDisabled = (sessionName?: string, namespace?: string) => managedSessionRestoreState.clear(sessionName, namespace);
const isManagedSessionRestoreDisabled = (sessionName?: string, namespace?: string) => managedSessionRestoreState.isDisabled(sessionName, namespace);
const markManagedSessionRestoreDisabled = (sessionName?: string, namespace?: string) => managedSessionRestoreState.disable(sessionName, namespace);
const expectedRestoreEnv = (cwd: string) => ({ AGENT_BROWSER_RESTORE: createManagedSessionRestoreKey(cwd) });
test.after(() => rmSync(isolatedHome, { recursive: true, force: true }));

test("managed restore sticky state is isolated per extension instance", () => {
	const first = new ManagedSessionRestoreState();
	const second = new ManagedSessionRestoreState();
	first.disable("piab-session", "team");
	assert.equal(first.isDisabled("piab-session", "team"), true);
	assert.equal(second.isDisabled("piab-session", "team"), false);
	first.clear("piab-session", "team");
	assert.equal(first.isDisabled("piab-session", "team"), false);
});

test("createManagedSessionRestoreKey is cwd-stable across pi session ids", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	assert.equal(createManagedSessionRestoreKey(cwd), createManagedSessionRestoreKey(cwd));
	assert.match(createManagedSessionRestoreKey(cwd), /^piab-r-[a-f0-9]{32}$/);
	assert.notEqual(createManagedSessionRestoreKey(cwd), createManagedSessionRestoreKey(`${cwd}-other`));
	assert.notEqual(
		createManagedSessionRestoreKey("/tmp/piab-collision-20970"),
		createManagedSessionRestoreKey("/tmp/piab-collision-22987"),
	);
});

test("getManagedSessionRestoreEnv isolates ownership and blocks incompatible launch mutations", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-restore-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "piab-restore-home-"));
	const session = "piab-work-abc12345-deadbeef";
	const restore = (args: string[], parentEnv: NodeJS.ProcessEnv = {}) => getManagedSessionRestoreEnv({
		args,
		cwd,
		ownedManagedSession: true,
		parentEnv: { HOME: home, ...parentEnv },
		restoreState: managedSessionRestoreState,
	});
	try {
		assert.deepEqual(
			restore(["--json", "--session", session, "open", "https://app.example.com"]),
			expectedRestoreEnv(cwd),
		);
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", "piab-caller-owned", "open", "https://app.example.com"],
				cwd,
				parentEnv: { HOME: home },
			}),
			{},
		);
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", "custom", "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				parentEnv: { HOME: home },
				restoreState: managedSessionRestoreState,
			}),
			expectedRestoreEnv(cwd),
		);

		const incompatibleArgs = [
			["--json", "--session", session, "--allowed-domains", "example.com", "open", "https://example.com"],
			["--json", "--session", session, "connect", "9222"],
			["--json", "--session", session, "--auto-connect", "open", "https://app.example.com"],
			["--json", "--session", session, "--auto-connect", "off", "open", "https://app.example.com"],
			["--json", "--session", session, "--session-name", "legacy", "open", "https://app.example.com"],
			["--json", "--session", session, "-p", "browserbase", "open", "https://app.example.com"],
			["--json", "--session", session, "open", "https://app.example.com", "--extension", "/tmp/ext"],
			["--json", "--session", session, "open", "https://app.example.com", "--init-script", "/tmp/init.js"],
			["--json", "--session", session, "open", "https://app.example.com", "--args", "--load-extension=/tmp/ext"],
			["--json", "--session", session, "open", "https://app.example.com", "--user-agent", "Custom Browser"],
			["--json", "--session", session, "open", "https://app.example.com", "--executable-path", "/tmp/browser"],
			["--json", "--session", session, "open", "https://app.example.com", "--proxy", "http://127.0.0.1:8080"],
			["--json", "--session", session, "open", "https://app.example.com", "--ignore-https-errors"],
			["--json", "--session", session, "open", "https://app.example.com", "--allow-file-access"],
		] satisfies string[][];
		for (const args of incompatibleArgs) {
			clearManagedSessionRestoreDisabled();
			assert.deepEqual(restore(args), {}, args.join(" "));
			assert.equal(isManagedSessionRestoreDisabled(session), true, args.join(" "));
		}

		const incompatibleEnvs: NodeJS.ProcessEnv[] = [
			{ AGENT_BROWSER_ALLOWED_DOMAINS: "example.com" },
			{ AGENT_BROWSER_PROFILE: "Default" },
			{ AGENT_BROWSER_AUTO_CONNECT: "1" },
			{ AGENT_BROWSER_AUTO_CONNECT: "off" },
			{ AGENT_BROWSER_AUTO_CONNECT: " false " },
			{ AGENT_BROWSER_SESSION_NAME: "legacy-restore" },
			{ AGENT_BROWSER_CDP: "9222" },
			{ AGENT_BROWSER_NAMESPACE: "parent-owned" },
			{ AGENT_BROWSER_EXTENSIONS: "/tmp/ext" },
			{ AGENT_BROWSER_INIT_SCRIPTS: "/tmp/init.js" },
			{ AGENT_BROWSER_ARGS: "--load-extension=/tmp/ext" },
			{ AGENT_BROWSER_USER_AGENT: "Custom Browser" },
			{ AGENT_BROWSER_USER_AGENT: " " },
			{ AGENT_BROWSER_PLUGINS: '[{"name":"mutator"}]' },
			{ AGENT_BROWSER_EXECUTABLE_PATH: "/tmp/browser" },
			{ AGENT_BROWSER_PROXY: "http://127.0.0.1:8080" },
			{ http_proxy: "http://127.0.0.1:8080" },
			{ https_proxy: "http://127.0.0.1:8080" },
			{ all_proxy: "socks5://127.0.0.1:1080" },
			{ AGENT_BROWSER_IGNORE_HTTPS_ERRORS: "1" },
			{ AGENT_BROWSER_ALLOW_FILE_ACCESS: "1" },
		];
		for (const parentEnv of incompatibleEnvs) {
			clearManagedSessionRestoreDisabled();
			assert.deepEqual(
				restore(["--json", "--session", session, "open", "https://app.example.com"], parentEnv),
				{},
				Object.keys(parentEnv)[0],
			);
		}

		for (const disabledValue of ["", "0", "false", "no"]) {
			clearManagedSessionRestoreDisabled();
			assert.deepEqual(
				restore(
					["--json", "--session", session, "open", "https://app.example.com"],
					{ AGENT_BROWSER_AUTO_CONNECT: disabledValue },
				),
				expectedRestoreEnv(cwd),
			);
		}
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(
				["--json", "--session", session, "open", "https://app.example.com"],
				{ PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
			),
			{},
		);
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(["--json", "--session", session, "--auto-connect", "false", "open", "https://app.example.com"]),
			expectedRestoreEnv(cwd),
		);
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(
				["--json", "--session", session, "open", "https://app.example.com"],
				{ AGENT_BROWSER_STATE_EXPIRE_DAYS: "7" },
			),
			{ AGENT_BROWSER_RESTORE: createManagedSessionRestoreKey(cwd) },
		);
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(["--json", "--session", session, "wait", "@e1", "--state", "hidden"]),
			expectedRestoreEnv(cwd),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("getManagedSessionRestoreEnv sticky-disables restore after an incompatible launch", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const session = "piab-work-abc12345-deadbeef";
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", session, "--profile", "Default", "open", "https://app.example.com"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", session, "snapshot", "-i"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);
	clearManagedSessionRestoreDisabled(session);
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", session, "snapshot", "-i"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		expectedRestoreEnv(cwd),
	);
});

test("owned managed session context enables restore for matching helper probes only", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const managed = "piab-work-abc12345-deadbeef";
	assert.equal(
		resolveOwnedManagedSessionContext({
			currentManagedSessionName: managed,
			restoreState: managedSessionRestoreState,
			sessionName: managed,
		})?.sessionName,
		managed,
	);
	assert.equal(
		resolveOwnedManagedSessionContext({
			currentManagedSessionName: managed,
			currentManagedSessionNamespace: undefined,
			namespace: "caller",
			restoreState: managedSessionRestoreState,
			sessionName: managed,
		}),
		undefined,
	);
	assert.equal(
		resolveOwnedManagedSessionContext({
			currentManagedSessionName: managed,
			restoreState: managedSessionRestoreState,
			sessionName: "caller-owned",
		}),
		undefined,
	);
	await withOwnedManagedSessionContext({ restoreState: managedSessionRestoreState, sessionName: managed }, async () => {
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "snapshot", "-i"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			expectedRestoreEnv(cwd),
		);
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", "caller-owned", "snapshot", "-i"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--namespace", "caller", "--session", managed, "snapshot", "-i"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
	});
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "snapshot", "-i"],
			cwd,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);
});

test("main-plan restore policy suppresses helpers without sticky-disabling on preflight-only plans", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const managed = "piab-work-abc12345-deadbeef";
	const owned = buildOwnedManagedSessionRestoreContext({
		args: ["--json", "--session", managed, "--profile", "Default", "click", "xpath=//button"],
		cwd,
		managedSessionName: managed,
		restoreState: managedSessionRestoreState,
	});
	assert.equal(owned?.restoreSuppressed, true);
	await withOwnedManagedSessionContext(owned, async () => {
		// helper probe: ALS-only, suppressed
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "eval", "--stdin"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
		// production main spawn: owned env inside suppressed context still sticky-disables
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "--profile", "Default", "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);
	});
	// later bare owned follow-up stays disabled after the real main spawn path
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "snapshot", "-i"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);
	clearManagedSessionRestoreDisabled();
	const preflightOnly = buildOwnedManagedSessionRestoreContext({
		args: ["--json", "--session", managed, "--profile", "Default", "click", "xpath=//button"],
		cwd,
		managedSessionName: managed,
		restoreState: managedSessionRestoreState,
	});
	await withOwnedManagedSessionContext(preflightOnly, async () => {
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "eval", "--stdin"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
	});
	// preflight-only (no owned incompatible spawn) must not sticky-disable later bare calls
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "snapshot", "-i"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		expectedRestoreEnv(cwd),
	);
});


test("wrapper-injected ChatGPT user agent remains compatible with managed restore", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const managed = "piab-work-abc12345-deadbeef";
	const plan = buildExecutionPlan(["open", "https://chatgpt.com"], {
		freshSessionName: `${managed}-fresh-test`,
		managedSessionActive: false,
		managedSessionName: managed,
		sessionMode: "auto",
	});
	assert.equal(plan.compatibilityWorkaround?.id, "chatgpt-headless-user-agent");
	assert.ok(plan.effectiveArgs.includes("--user-agent"));
	const context = buildOwnedManagedSessionRestoreContext({
		args: plan.effectiveArgs,
		cwd,
		managedSessionName: managed,
		parentEnv: { HOME: isolatedHome },
		restoreState: managedSessionRestoreState,
		wrapperInjectedUserAgent: true,
	});
	assert.equal(context?.restoreLaunchConflict, false);
	await withOwnedManagedSessionContext(context, async () => {
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: plan.effectiveArgs,
				cwd,
				ownedManagedSession: true,
				parentEnv: { HOME: isolatedHome },
				restoreState: managedSessionRestoreState,
			}),
			expectedRestoreEnv(cwd),
		);
	});
	assert.equal(isManagedSessionRestoreDisabled(managed), false);
});

test("any agent-browser config blocks restore without reading caller-selected content", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-config-"));
	const home = mkdtempSync(join(tmpdir(), "piab-home-"));
	const managed = "piab-work-abc12345-deadbeef";
	try {
		writeFileSync(join(cwd, "agent-browser.json"), "{}");
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home },
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);

		clearManagedSessionRestoreDisabled();
		rmSync(join(cwd, "agent-browser.json"));
		assert.equal(agentBrowserConfigBlocksManagedRestore(cwd, { AGENT_BROWSER_CONFIG: "", HOME: home }), true);
		assert.equal(agentBrowserConfigBlocksManagedRestore(cwd, { HOME: ` ${home} ` }), true);
		assert.equal(
			agentBrowserConfigBlocksManagedRestore(cwd, { HOME: home }, [
				"--headers", "--config", "open", "https://app.example.com",
			]),
			false,
		);
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com", "--config", "/dev/zero"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home },
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);

		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com", "--", "--config", "/dev/zero"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home },
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);

		clearManagedSessionRestoreDisabled();
		mkdirSync(join(home, ".agent-browser"));
		writeFileSync(join(home, ".agent-browser", "config.json"), "{}");
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home },
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("managed restore requires a 64-character hex encryption key on Windows", () => {
	assert.equal(ensureManagedSessionRestoreStorageIsSecure({}, "win32"), false);
	assert.equal(ensureManagedSessionRestoreStorageIsSecure({ AGENT_BROWSER_ENCRYPTION_KEY: "weak" }, "win32"), false);
	assert.equal(ensureManagedSessionRestoreStorageIsSecure({ AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64) }, "win32"), true);
	assert.equal(ensureManagedSessionRestoreStorageIsSecure({ AGENT_BROWSER_ENCRYPTION_KEY: ` ${"a".repeat(64)} ` }, "win32"), false);
});

test("managed restore validates encryption keys and secures its POSIX state directory", { skip: process.platform === "win32" }, () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "piab-home-"));
	const managed = "piab-work-abc12345-deadbeef";
	const validKey = "a".repeat(64);
	try {
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { AGENT_BROWSER_ENCRYPTION_KEY: "weak", HOME: home },
			}),
			{},
		);

		clearManagedSessionRestoreDisabled();
		chmodSync(home, 0o755);
		assert.match(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { AGENT_BROWSER_ENCRYPTION_KEY: validKey, HOME: home },
			}).AGENT_BROWSER_RESTORE ?? "",
			/^piab-r-/,
		);
		assert.equal(statSync(join(home, ".agent-browser")).mode & 0o077, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("managed restore rejects symlinked and non-directory POSIX state roots", { skip: process.platform === "win32" }, () => {
	const symlinkHome = mkdtempSync(join(tmpdir(), "piab-home-link-"));
	const fileHome = mkdtempSync(join(tmpdir(), "piab-home-file-"));
	try {
		const target = join(symlinkHome, "state-target");
		mkdirSync(target, { mode: 0o700 });
		symlinkSync(target, join(symlinkHome, ".agent-browser"), "dir");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: symlinkHome }), false);

		writeFileSync(join(fileHome, ".agent-browser"), "not a directory");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: fileHome }), false);
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: ` ${fileHome} ` }), false);
	} finally {
		rmSync(symlinkHome, { recursive: true, force: true });
		rmSync(fileHome, { recursive: true, force: true });
	}
});

test("owned snapshot pruning retains two newest wrapper families and leaves caller state untouched", () => {
	const cwd = "/Users/example/Projects/work-app";
	const home = mkdtempSync(join(tmpdir(), "piab-prune-home-"));
	const sessions = join(home, ".agent-browser", "sessions");
	const namespaceSessions = join(home, ".agent-browser", "namespaces", "team", "state", "sessions");
	const key = createManagedSessionRestoreKey(cwd);
	try {
		mkdirSync(sessions, { recursive: true });
		mkdirSync(namespaceSessions, { recursive: true });
		chmodSync(join(home, ".agent-browser"), 0o700);
		for (const directory of [sessions, namespaceSessions]) {
			for (const [index, suffix] of ["old", "middle", "new"].entries()) {
				const current = join(directory, `${key}-${suffix}.json`);
				const previous = `${current}.previous`;
				writeFileSync(current, "{}");
				writeFileSync(previous, "{}");
				utimesSync(current, index + 1, index + 1);
				utimesSync(previous, index + 1, index + 1);
			}
			writeFileSync(join(directory, "caller-owned.json"), "{}");
		}

		assert.equal(pruneOwnedManagedSessionRestoreSnapshots(cwd, { HOME: home }, "linux"), 4);
		for (const directory of [sessions, namespaceSessions]) {
			assert.equal(existsSync(join(directory, `${key}-old.json`)), false);
			assert.equal(existsSync(join(directory, `${key}-old.json.previous`)), false);
			assert.equal(existsSync(join(directory, `${key}-middle.json`)), true);
			assert.equal(existsSync(join(directory, `${key}-new.json`)), true);
			assert.equal(existsSync(join(directory, "caller-owned.json")), true);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("plan-suppressed owned main spawn sticky-disables even when process argv is rewritten", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const managed = "piab-work-abc12345-deadbeef";
	const owned = buildOwnedManagedSessionRestoreContext({
		args: ["--json", "--session", managed, "--profile", "Default", "click", "@e1"],
		cwd,
		managedSessionName: managed,
		restoreState: managedSessionRestoreState,
	});
	assert.equal(owned?.restoreSuppressed, true);
	await withOwnedManagedSessionContext(owned, async () => {
		// prepare may rewrite processArgs to plain batch while plan suppression remains
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "batch"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);
	});
});

test("restoreManagedSessionStateFromBranch resets sibling state and reapplies branch sticky disable", () => {
	markManagedSessionRestoreDisabled("sibling-session");
	const managed = "piab-project-abc12345-deadbeef";
	const restoredState = restoreManagedSessionStateFromBranch(
		[
			{
				type: "message",
				message: {
					toolName: "agent_browser",
					details: {
						args: ["--session", managed, "--profile", "Default", "open", "https://app.example.com"],
						sessionName: managed,
						usedImplicitSession: false,
						managedSessionRestoreDisabled: true,
						exitCode: 0,
					},
				},
			},
		],
		managed,
	);
	managedSessionRestoreState.replace(restoredState.managedSessionRestoreDisabledIdentities);
	assert.equal(isManagedSessionRestoreDisabled(managed), true);
	assert.equal(isManagedSessionRestoreDisabled("sibling-session"), false);
});

test("managed restore opt-out avoids state-directory permission changes", { skip: process.platform === "win32" }, () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-optout-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "piab-optout-home-"));
	const root = join(home, ".agent-browser");
	const managed = "piab-work-abc12345-deadbeef";
	try {
		mkdirSync(root, { mode: 0o750 });
		chmodSync(root, 0o750);
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "snapshot", "-i"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
			}),
			{},
		);
		assert.equal(statSync(root).mode & 0o077, 0o050);
		assert.equal(isManagedSessionRestoreDisabled(managed), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("incompatible launches sticky-disable even when managed restore is opted out", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const managed = "piab-work-abc12345-deadbeef";
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "--profile", "Default", "open", "https://app.example.com"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
		}),
		{},
	);
	assert.deepEqual(
		getManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "snapshot", "-i"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);

	clearManagedSessionRestoreDisabled();
	const planContext = buildOwnedManagedSessionRestoreContext({
		args: ["--json", "--session", managed, "--profile", "Default", "click", "@e1"],
		cwd,
		managedSessionName: managed,
		restoreState: managedSessionRestoreState,
	});
	await withOwnedManagedSessionContext(planContext, async () => {
		assert.deepEqual(
			getManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "batch"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: isolatedHome, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
			}),
			{},
		);
	});
	assert.equal(isManagedSessionRestoreDisabled(managed), true);
});

test("owned managed session ALS context is isolated across concurrent calls", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = "/Users/example/Projects/work-app";
	const managed = "piab-work-abc12345-deadbeef";
	const key = createManagedSessionRestoreKey(cwd);
	let ownedProbeSawRestore = false;
	let foreignProbeSawRestore = false;
	await Promise.all([
		withOwnedManagedSessionContext({ restoreState: managedSessionRestoreState, sessionName: managed }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			ownedProbeSawRestore =
				getManagedSessionRestoreEnv({
					args: ["--json", "--session", managed, "snapshot", "-i"],
					cwd,
					parentEnv: { HOME: isolatedHome },
				}).AGENT_BROWSER_RESTORE === key;
		}),
		withOwnedManagedSessionContext(undefined, async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			foreignProbeSawRestore =
				getManagedSessionRestoreEnv({
					args: ["--json", "--session", managed, "snapshot", "-i"],
					cwd,
					parentEnv: { HOME: isolatedHome },
				}).AGENT_BROWSER_RESTORE === key;
		}),
	]);
	assert.equal(ownedProbeSawRestore, true);
	assert.equal(foreignProbeSawRestore, false);
});

