/**
 * Purpose: Verify automatic restore policy for wrapper-managed agent-browser sessions.
 * Responsibilities: Assert ownership isolation, incompatible-mode suppression, config/storage fail-closed behavior, and sticky restore state.
 * Scope: Unit-style managed-session restore tests; general runtime planning stays in agent-browser.runtime.test.ts.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	agentBrowserConfigBlocksManagedRestore,
	buildOwnedManagedSessionRestoreContext,
	commitManagedSessionRestoreSuppression,
	createManagedSessionRestoreKey,
	ensureManagedSessionRestoreStorageIsSecure,
	getManagedSessionRestoreEnv,
	getManagedSessionRestoreProtectedEnv,
	getManagedSessionRestoreScope,
	getOwnedManagedSessionNamespaceEnv,
	ManagedSessionRestoreState,
	pruneOwnedManagedSessionRestoreSnapshots,
	resolveExplicitAutosaveInterval,
	resolveOwnedManagedSessionContext,
	withOwnedManagedSessionContext,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import { buildExecutionPlan, restoreManagedSessionStateFromBranch } from "../extensions/agent-browser/lib/runtime.js";

function initializeGitProject(cwd: string): void {
	execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
}

const isolatedHome = mkdtempSync(join(tmpdir(), "piab-restore-suite-home-"));
const isolatedProject = mkdtempSync(join(tmpdir(), "piab-restore-suite-project-"));
initializeGitProject(isolatedProject);
const managedSessionRestoreState = new ManagedSessionRestoreState();
const defaultManagedSession = "piab-work-abc12345-deadbeef";
const posixFixturePlatform: NodeJS.Platform = process.platform === "android" ? "android" : "linux";
const clearManagedSessionRestoreDisabled = (sessionName?: string, namespace?: string) => managedSessionRestoreState.clear(sessionName, namespace);
const isManagedSessionRestoreDisabled = (sessionName?: string, namespace?: string) => managedSessionRestoreState.isDisabled(sessionName, namespace);
const markManagedSessionRestoreDisabled = (sessionName?: string, namespace?: string) => managedSessionRestoreState.disable(sessionName, namespace);
const expectedRestoreEnv = (cwd: string, sessionName = defaultManagedSession) => ({
	AGENT_BROWSER_RESTORE: createManagedSessionRestoreKey(cwd, getManagedSessionRestoreScope(sessionName)),
});
const getAndCommitManagedSessionRestoreEnv = (options: Parameters<typeof getManagedSessionRestoreEnv>[0]) => {
	const env = getManagedSessionRestoreEnv(options);
	commitManagedSessionRestoreSuppression(options);
	return env;
};
test("resolveExplicitAutosaveInterval mirrors the upstream u64 fallback", () => {
	assert.equal(resolveExplicitAutosaveInterval(undefined), undefined);
	assert.equal(resolveExplicitAutosaveInterval("0"), "0");
	assert.equal(resolveExplicitAutosaveInterval("001000"), "1000");
	assert.equal(resolveExplicitAutosaveInterval("+1000"), "1000");
	assert.equal(resolveExplicitAutosaveInterval(" 1000 "), "30000");
	assert.equal(resolveExplicitAutosaveInterval("invalid"), "30000");
	assert.equal(resolveExplicitAutosaveInterval("18446744073709551616"), "30000");
});

test.after(() => {
	rmSync(isolatedHome, { recursive: true, force: true });
	rmSync(isolatedProject, { recursive: true, force: true });
});

test("managed restore sticky state is isolated per extension instance", () => {
	const first = new ManagedSessionRestoreState();
	const second = new ManagedSessionRestoreState();
	first.disable("piab-session", "Team");
	assert.equal(first.isDisabled("piab-session", "team"), true);
	assert.equal(second.isDisabled("piab-session", "TEAM"), false);
	first.clear("piab-session", "team");
	assert.equal(first.isDisabled("piab-session", "team"), false);
});

	test("replace tolerates an absent branch restore identity list (undefined from a pre-upgrade runtime)", () => {
		const state = new ManagedSessionRestoreState();
		state.disable("piab-stale", "team");
		// The version-skew path (new index.js restoring against an old cached runtime.js)
		// yields `undefined` for managedSessionRestoreDisabledIdentities. Must not throw.
		state.replace(undefined, { preserveDaemonRestoreKeys: true });
		assert.equal(state.isDisabled("piab-stale", "team"), false);
		assert.equal(state.hasDaemonRestoreKey("piab-stale", "team"), false);
	});

test("branch restore can preserve current-process daemon provenance without persisting it across reload", () => {
	const state = new ManagedSessionRestoreState();
	state.recordDaemonRestoreKey("piab-current", "team", null);
	state.recordDaemonRestoreKey("piab-off-branch", undefined, "caller-key");
	state.replace([{ namespace: "team", sessionName: "piab-current" }], { preserveDaemonRestoreKeys: true });
	assert.equal(state.isDisabled("piab-current", "team"), true);
	assert.equal(state.hasDaemonRestoreKey("piab-current", "team"), true);
	assert.equal(state.getDaemonRestoreKey("piab-current", "team"), null);
	assert.equal(state.getDaemonRestoreKey("piab-off-branch"), "caller-key");

	state.replace([{ namespace: "team", sessionName: "piab-current" }]);
	assert.equal(state.hasDaemonRestoreKey("piab-current", "team"), false);
	assert.equal(state.hasDaemonRestoreKey("piab-off-branch"), false);
});

test("owned managed subprocesses pin canonical and default namespaces", async () => {
	const restoreState = new ManagedSessionRestoreState();
	const base = {
		args: ["--session", "piab-managed", "session", "info"],
		cwd: "/tmp/project",
		restoreState,
	};
	assert.deepEqual(getOwnedManagedSessionNamespaceEnv(base), {});
	assert.deepEqual(getOwnedManagedSessionNamespaceEnv({ ...base, ownedManagedSession: true }), { AGENT_BROWSER_NAMESPACE: "" });
	const context = resolveOwnedManagedSessionContext({
		managedSessionName: "piab-managed",
		namespace: "Team Name",
		restoreState,
	});
	await withOwnedManagedSessionContext(context, async () => {
		assert.deepEqual(getOwnedManagedSessionNamespaceEnv({ ...base, args: ["--namespace", "team-name", "--session", "piab-managed", "session", "info"] }), {
			AGENT_BROWSER_NAMESPACE: "team-name",
		});
	});
});

test("restore env resolution is pure and suppression commits only for a spawned owned main call", () => {
	const restoreState = new ManagedSessionRestoreState();
	const sessionName = "piab-managed";
	const options = {
		args: ["--session", sessionName, "open", "https://example.com"],
		cwd: "/tmp/project",
		ownedManagedSession: true,
		parentEnv: { HOME: isolatedHome, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
		restoreState,
	};
	assert.deepEqual(getManagedSessionRestoreEnv(options), {});
	assert.equal(restoreState.isDisabled(sessionName), false);
	commitManagedSessionRestoreSuppression(options);
	assert.equal(restoreState.isDisabled(sessionName), true);
});

test("createManagedSessionRestoreKey is transcript- and checkout-generation-stable", () => {
	clearManagedSessionRestoreDisabled();
	const root = mkdtempSync(join(tmpdir(), "piab-restore-key-"));
	const cwd = join(root, "project");
	const alias = join(root, "project-link");
	try {
		mkdirSync(cwd);
		initializeGitProject(cwd);
		const firstScope = "piab-project-session-a-deadbeef";
		const rotatedSession = `${firstScope}-fresh-0123456789`;
		const secondScope = "piab-project-session-b-deadbeef";
		assert.equal(getManagedSessionRestoreScope(rotatedSession), firstScope);
		assert.equal(createManagedSessionRestoreKey(cwd, firstScope), createManagedSessionRestoreKey(cwd, getManagedSessionRestoreScope(rotatedSession)));
		assert.equal(createManagedSessionRestoreKey(cwd, firstScope), createManagedSessionRestoreKey(`${cwd}/`, firstScope));
		assert.notEqual(createManagedSessionRestoreKey(cwd, firstScope), createManagedSessionRestoreKey(cwd, secondScope));
		if (process.platform !== "win32") {
			symlinkSync(cwd, alias, "dir");
			assert.equal(createManagedSessionRestoreKey(cwd), createManagedSessionRestoreKey(alias));
		}
		assert.match(createManagedSessionRestoreKey(cwd), /^piab-r2-[a-f0-9]{32}$/);
		assert.notEqual(createManagedSessionRestoreKey(cwd), createManagedSessionRestoreKey(`${cwd}-other`));
		assert.notEqual(
			createManagedSessionRestoreKey("/tmp/piab-collision-20970"),
			createManagedSessionRestoreKey("/tmp/piab-collision-22987"),
		);
		const originalKey = createManagedSessionRestoreKey(cwd);
		const copied = join(root, "copied-project");
		cpSync(cwd, copied, { recursive: true });
		assert.notEqual(createManagedSessionRestoreKey(copied), originalKey);
		const moved = join(root, "moved-project");
		renameSync(cwd, moved);
		assert.equal(createManagedSessionRestoreKey(moved), originalKey);
		mkdirSync(cwd);
		initializeGitProject(cwd);
		assert.notEqual(createManagedSessionRestoreKey(cwd), originalKey);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Android restore identity stays stable without hard links or reliable birth time", { skip: process.platform === "win32" }, () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-android-restore-key-"));
	try {
		initializeGitProject(cwd);
		const first = createManagedSessionRestoreKey(cwd, "android-scope", "android");
		writeFileSync(join(cwd, ".git", "mutable-entry"), "changes directory ctime");
		assert.equal(createManagedSessionRestoreKey(cwd, "android-scope", "android"), first);
		assert.equal(statSync(join(cwd, ".git", "pi-agent-browser-project-generation-v1.json")).mode & 0o777, 0o600);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("linked-worktree copies and retargeted git pointers get distinct restore keys", () => {
	const root = mkdtempSync(join(tmpdir(), "piab-linked-worktree-key-"));
	const source = join(root, "source");
	const linked = join(root, "linked");
	const otherLinked = join(root, "other-linked");
	const copied = join(root, "copied");
	try {
		initializeGitProject(source);
		execFileSync("git", ["-C", source, "config", "user.email", "piab@example.invalid"]);
		execFileSync("git", ["-C", source, "config", "user.name", "piab"]);
		execFileSync("git", ["-C", source, "commit", "--allow-empty", "-qm", "initial"]);
		execFileSync("git", ["-C", source, "worktree", "add", "--detach", "-q", linked]);
		execFileSync("git", ["-C", source, "worktree", "add", "--detach", "-q", otherLinked]);
		const linkedKey = createManagedSessionRestoreKey(linked);
		cpSync(linked, copied, { recursive: true, preserveTimestamps: true });
		assert.notEqual(createManagedSessionRestoreKey(copied), linkedKey);

		writeFileSync(join(linked, ".git"), readFileSync(join(otherLinked, ".git"), "utf8"));
		assert.notEqual(createManagedSessionRestoreKey(linked), linkedKey);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("checkout-generation marker creation converges across processes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-marker-race-project-"));
	try {
		initializeGitProject(cwd);
		const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-restore.ts", import.meta.url).href;
		const children = Array.from({ length: 2 }, () => {
			const script = `import { createManagedSessionRestoreKey } from ${JSON.stringify(moduleUrl)}; process.stdout.write(createManagedSessionRestoreKey(${JSON.stringify(cwd)}));`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			const stderr: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			return { exit: once(child, "exit"), getStdout: () => stdout, stderr };
		});
		const keys: string[] = [];
		for (const result of children) {
			const [code] = await result.exit as [number | null];
			assert.equal(code, 0, Buffer.concat(result.stderr).toString("utf8"));
			keys.push(result.getStdout());
		}
		assert.equal(keys[0], keys[1]);
		assert.match(keys[0] ?? "", /^piab-r2-/);
		if (process.platform !== "win32") assert.equal(statSync(join(cwd, ".git", "pi-agent-browser-project-generation-v1.json")).mode & 0o777, 0o600);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("managed restore rejects a tampered checkout-generation marker", () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-marker-project-"));
	const home = mkdtempSync(join(tmpdir(), "piab-marker-home-"));
	try {
		initializeGitProject(cwd);
		assert.match(createManagedSessionRestoreKey(cwd), /^piab-r2-/);
		const marker = join(cwd, ".git", "pi-agent-browser-project-generation-v1.json");
		chmodSync(marker, 0o644);
		assert.deepEqual(getManagedSessionRestoreEnv({
			args: ["--session", "piab-marker", "open", "https://example.com"],
			cwd,
			ownedManagedSession: true,
			parentEnv: { HOME: home },
			restoreState: new ManagedSessionRestoreState(),
		}), {});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("getManagedSessionRestoreEnv isolates ownership and blocks incompatible launch mutations", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-restore-cwd-"));
	initializeGitProject(cwd);
	const home = mkdtempSync(join(tmpdir(), "piab-restore-home-"));
	const session = defaultManagedSession;
	const restore = (args: string[], parentEnv: NodeJS.ProcessEnv = {}, stdin?: string) => getAndCommitManagedSessionRestoreEnv({
		args,
		cwd,
		ownedManagedSession: true,
		parentEnv: { HOME: home, ...parentEnv },
		restoreState: managedSessionRestoreState,
		stdin,
	});
	try {
		assert.deepEqual(
			restore(["--json", "--session", session, "open", "https://app.example.com"]),
			expectedRestoreEnv(cwd),
		);
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", session, "close"],
				cwd,
				ownedManagedSession: true,
				parentEnv: { HOME: home },
				restoreState: managedSessionRestoreState,
			}),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(session), false);
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", "piab-caller-owned", "open", "https://app.example.com"],
				cwd,
				parentEnv: { HOME: home },
			}),
			{},
		);
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", "custom", "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				parentEnv: { HOME: home },
				restoreState: managedSessionRestoreState,
			}),
			expectedRestoreEnv(cwd, "custom"),
		);

		const incompatibleArgs = [
			["--json", "--session", session, "--allowed-domains", "example.com", "open", "https://example.com"],
			["--json", "--session", session, "connect", "9222"],
			["--json", "--session", session, "--auto-connect", "open", "https://app.example.com"],
			["--json", "--session", session, "--auto-connect", "off", "open", "https://app.example.com"],
			["--json", "--session", session, "--auto-connect", "false", "--auto-connect", "open", "https://app.example.com"],
			["--json", "--session", session, "--auto-connect", "open", "https://app.example.com", "--auto-connect=false"],
			["--json", "--session", session, "--session-name", "legacy", "open", "https://app.example.com"],
			["--json", "--session", session, "-p", "browserbase", "open", "https://app.example.com"],
			["--json", "--session", session, "open", "https://app.example.com", "--extension", "/tmp/ext"],
			["--json", "--session", session, "open", "https://app.example.com", "--init-script", "/tmp/init.js"],
			["--json", "--session", session, "open", "https://app.example.com", "--args", "--load-extension=/tmp/ext"],
			["--json", "--session", session, "open", "https://app.example.com", "--user-agent", "Custom Browser"],
			["--json", "--session", session, "open", "https://app.example.com", "--executable-path", "/tmp/browser"],
			["--json", "--session", session, "open", "https://app.example.com", "--proxy", "http://127.0.0.1:8080"],
			["--json", "--session", session, "open", "https://app.example.com", "--ca-cert", "/tmp/proxy-ca.pem"],
			["--json", "--session", session, "open", "https://app.example.com", "--ignore-https-errors"],
			["--json", "--session", session, "open", "https://app.example.com", "--allow-file-access"],
			["--json", "--session", session, "open", "https://app.example.com", "--webgpu"],
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
			{ AGENT_BROWSER_CA_CERT: "/tmp/proxy-ca.pem" },
			{ http_proxy: "http://127.0.0.1:8080" },
			{ https_proxy: "http://127.0.0.1:8080" },
			{ all_proxy: "socks5://127.0.0.1:1080" },
			{ AGENT_BROWSER_IGNORE_HTTPS_ERRORS: "1" },
			{ AGENT_BROWSER_ALLOW_FILE_ACCESS: "1" },
			{ AGENT_BROWSER_WEBGPU: "1" },
		];
		for (const parentEnv of incompatibleEnvs) {
			clearManagedSessionRestoreDisabled();
			assert.deepEqual(
				restore(["--json", "--session", session, "open", "https://app.example.com"], parentEnv),
				{},
				Object.keys(parentEnv)[0],
			);
		}

		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", session, "open", "https://app.example.com"],
				cwd,
				env: { AGENT_BROWSER_PROXY: undefined, AGENT_BROWSER_WEBGPU: "false" },
				ownedManagedSession: true,
				parentEnv: { AGENT_BROWSER_PROXY: "http://127.0.0.1:8080", AGENT_BROWSER_WEBGPU: "1", HOME: home },
				restoreState: managedSessionRestoreState,
			}),
			expectedRestoreEnv(cwd),
		);

		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", session, "open", "https://app.example.com"],
				cwd,
				env: { PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "1" },
				ownedManagedSession: true,
				parentEnv: { HOME: home, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
				restoreState: managedSessionRestoreState,
			}),
			expectedRestoreEnv(cwd),
		);

		for (const envName of ["AGENT_BROWSER_AUTO_CONNECT", "AGENT_BROWSER_WEBGPU"]) {
			for (const disabledValue of ["", "0", "false", "no"]) {
				clearManagedSessionRestoreDisabled();
				assert.deepEqual(
					restore(
						["--json", "--session", session, "open", "https://app.example.com"],
						{ [envName]: disabledValue },
					),
					expectedRestoreEnv(cwd),
				);
			}
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
			restore(["--json", "--session", session, "--auto-connect", "--auto-connect", "false", "open", "https://app.example.com"]),
			expectedRestoreEnv(cwd),
		);
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(
				["--json", "--session", session, "batch"],
				{},
				JSON.stringify([["connect", "wss://remote.example/devtools/browser/test"], ["snapshot", "-i"]]),
			),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(session), true);
		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(["--json", "--session", session, "batch", "connect wss://remote.example/devtools/browser/test"]),
			{},
		);
		assert.equal(isManagedSessionRestoreDisabled(session), true);

		clearManagedSessionRestoreDisabled();
		assert.deepEqual(
			restore(
				["--json", "--session", session, "open", "https://app.example.com"],
				{ AGENT_BROWSER_STATE_EXPIRE_DAYS: "7" },
			),
			expectedRestoreEnv(cwd, session),
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

test("spawn-time suppression commit sticky-disables restore after an incompatible launch", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = isolatedProject;
	const session = defaultManagedSession;
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
			args: ["--json", "--session", session, "--profile", "Default", "open", "https://app.example.com"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
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
		getAndCommitManagedSessionRestoreEnv({
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
	const cwd = isolatedProject;
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
	assert.equal(
		resolveOwnedManagedSessionContext({
			currentManagedSessionName: managed,
			currentManagedSessionNamespace: "Team",
			namespace: "team",
			restoreState: managedSessionRestoreState,
			sessionName: managed,
		})?.namespace,
		"team",
	);
	await withOwnedManagedSessionContext({ restoreState: managedSessionRestoreState, sessionName: managed }, async () => {
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "snapshot", "-i"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			expectedRestoreEnv(cwd),
		);
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", "caller-owned", "snapshot", "-i"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--namespace", "caller", "--session", managed, "snapshot", "-i"],
				cwd,
				parentEnv: { HOME: isolatedHome },
			}),
			{},
		);
	});
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "snapshot", "-i"],
			cwd,
			parentEnv: { HOME: isolatedHome },
		}),
		{},
	);
});

test("main-plan restore policy suppresses helpers without sticky-disabling on preflight-only plans", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = isolatedProject;
	const managed = "piab-work-abc12345-deadbeef";
	const owned = buildOwnedManagedSessionRestoreContext({
		args: ["--json", "--session", managed, "--profile", "Default", "click", "xpath=//button"],
		cwd,
		managedSessionName: managed,
		restoreState: managedSessionRestoreState,
	});
	assert.equal(owned?.restoreSuppressed, true);
	await withOwnedManagedSessionContext(owned, async () => {
		const helperOptions = {
			args: ["--json", "--session", managed, "eval", "--stdin"],
			cwd,
			parentEnv: { HOME: isolatedHome },
		};
		assert.deepEqual(getManagedSessionRestoreEnv(helperOptions), {});
		assert.equal(isManagedSessionRestoreDisabled(managed), false);
		commitManagedSessionRestoreSuppression(helperOptions);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);
	});
	// later bare owned follow-up stays disabled after the helper subprocess spawn
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
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
		const helperOptions = {
			args: ["--json", "--session", managed, "eval", "--stdin"],
			cwd,
			parentEnv: { HOME: isolatedHome },
		};
		assert.deepEqual(getManagedSessionRestoreEnv(helperOptions), {});
		assert.equal(isManagedSessionRestoreDisabled(managed), false);
	});
	// preflight-only (no owned incompatible spawn) must not sticky-disable later bare calls
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
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
	const cwd = isolatedProject;
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
	await withOwnedManagedSessionContext(context, async () => {
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
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

test("passive agent-browser config preserves automatic restore while explicit overrides suppress it", () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-config-"));
	initializeGitProject(cwd);
	const home = mkdtempSync(join(tmpdir(), "piab-home-"));
	const managed = "piab-work-abc12345-deadbeef";
	try {
		writeFileSync(join(cwd, "agent-browser.json"), "{}");
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home },
			}),
			expectedRestoreEnv(cwd),
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), false);

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
		assert.equal(
			agentBrowserConfigBlocksManagedRestore(cwd, { HOME: home }, [
				"open", "https://app.example.com", "--config=/dev/zero",
			]),
			false,
		);
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
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
			getAndCommitManagedSessionRestoreEnv({
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
		mkdirSync(join(home, ".agent-browser"), { recursive: true });
		writeFileSync(join(home, ".agent-browser", "config.json"), "{}");
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home },
			}),
			expectedRestoreEnv(cwd),
		);
		assert.equal(isManagedSessionRestoreDisabled(managed), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("managed restore rejects relative HOME and USERPROFILE paths", () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-relative-home-cwd-"));
	try {
		assert.equal(agentBrowserConfigBlocksManagedRestore(cwd, { HOME: "relative-home" }), true);
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: "relative-home" }, posixFixturePlatform), false);
		assert.equal(agentBrowserConfigBlocksManagedRestore(cwd, { USERPROFILE: "relative-profile" }, [], "win32"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Windows passive config discovery follows USERPROFILE without blocking pinned restore", () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-windows-config-cwd-"));
	const gitBashHome = mkdtempSync(join(tmpdir(), "piab-windows-git-home-"));
	const userProfile = mkdtempSync(join(tmpdir(), "piab-windows-user-profile-"));
	try {
		mkdirSync(join(userProfile, ".agent-browser"));
		writeFileSync(join(userProfile, ".agent-browser", "config.json"), "{}");
		assert.equal(agentBrowserConfigBlocksManagedRestore(cwd, { HOME: gitBashHome, USERPROFILE: userProfile }, [], "win32"), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(gitBashHome, { recursive: true, force: true });
		rmSync(userProfile, { recursive: true, force: true });
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
	initializeGitProject(cwd);
	const home = mkdtempSync(join(tmpdir(), "piab-home-"));
	const insecureHome = mkdtempSync(join(tmpdir(), "piab-insecure-home-"));
	const managed = "piab-work-abc12345-deadbeef";
	const validKey = "a".repeat(64);
	try {
		mkdirSync(join(insecureHome, ".agent-browser"), { mode: 0o755 });
		chmodSync(join(insecureHome, ".agent-browser"), 0o755);
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: insecureHome }, posixFixturePlatform), false);
		assert.equal(statSync(join(insecureHome, ".agent-browser")).mode & 0o777, 0o755);

		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
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
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "open", "https://app.example.com"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { AGENT_BROWSER_ENCRYPTION_KEY: validKey, HOME: home },
			}).AGENT_BROWSER_RESTORE ?? "",
			/^piab-r2-/,
		);
		assert.equal(statSync(join(home, ".agent-browser")).mode & 0o077, 0);
		assert.equal(statSync(join(home, ".agent-browser", "sessions")).mode & 0o077, 0);
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: home }, posixFixturePlatform, "Team Name"), true);
		assert.equal(statSync(join(home, ".agent-browser", "namespaces", "team-name", "state", "sessions")).mode & 0o077, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(insecureHome, { recursive: true, force: true });
	}
});

test("managed restore pins a trusted canonical HOME and rejects writable ancestry", { skip: process.platform === "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "piab-home-anchor-"));
	const home = join(root, "home");
	const alternate = join(root, "alternate");
	const link = join(root, "home-link");
	try {
		mkdirSync(home, { mode: 0o700 });
		mkdirSync(alternate, { mode: 0o700 });
		symlinkSync(home, link, "dir");
		const context = buildOwnedManagedSessionRestoreContext({
			args: ["--session", "piab-home-anchor", "open", "https://example.com"],
			cwd: isolatedProject,
			managedSessionName: "piab-home-anchor",
			parentEnv: { HOME: link },
			restoreState: new ManagedSessionRestoreState(),
		});
		assert.equal(context?.restoreDecision, "enabled");
		await withOwnedManagedSessionContext(context, async () => {
			const options = { args: ["--session", "piab-home-anchor", "open", "https://example.com"], cwd: isolatedProject };
			const restoreEnv = getManagedSessionRestoreEnv(options);
			assert.equal(getManagedSessionRestoreProtectedEnv(options, restoreEnv).HOME, realpathSync(home));
			rmSync(link);
			symlinkSync(alternate, link, "dir");
			assert.equal(getManagedSessionRestoreProtectedEnv(options, restoreEnv).HOME, realpathSync(home));
		});
		const writableAncestor = join(root, "writable");
		const nestedHome = join(writableAncestor, "nested");
		mkdirSync(nestedHome, { recursive: true, mode: 0o700 });
		chmodSync(writableAncestor, 0o777);
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: nestedHome }), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("managed restore fails closed outside a durable Git checkout generation", () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-non-git-"));
	const home = mkdtempSync(join(tmpdir(), "piab-non-git-home-"));
	try {
		assert.deepEqual(getManagedSessionRestoreEnv({
			args: ["--session", "piab-non-git", "open", "https://example.com"],
			cwd,
			ownedManagedSession: true,
			parentEnv: { HOME: home },
			restoreState: new ManagedSessionRestoreState(),
		}), {});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("managed restore rejects writable checkout ancestry", { skip: process.platform === "win32" }, () => {
	const cwd = mkdtempSync(join(tmpdir(), "piab-writable-checkout-"));
	const home = mkdtempSync(join(tmpdir(), "piab-writable-checkout-home-"));
	try {
		initializeGitProject(cwd);
		chmodSync(cwd, 0o777);
		assert.deepEqual(getManagedSessionRestoreEnv({
			args: ["--session", "piab-writable-checkout", "open", "https://example.com"],
			cwd,
			ownedManagedSession: true,
			parentEnv: { HOME: home },
			restoreState: new ManagedSessionRestoreState(),
		}), {});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("managed restore rejects symlinks and files along POSIX restore state paths", { skip: process.platform === "win32" }, () => {
	const symlinkHome = mkdtempSync(join(tmpdir(), "piab-home-link-"));
	const sessionsSymlinkHome = mkdtempSync(join(tmpdir(), "piab-sessions-link-"));
	const namespaceSymlinkHome = mkdtempSync(join(tmpdir(), "piab-namespace-link-"));
	const stateFileSymlinkHome = mkdtempSync(join(tmpdir(), "piab-state-file-link-"));
	const temporaryFileSymlinkHome = mkdtempSync(join(tmpdir(), "piab-state-tmp-link-"));
	const fileHome = mkdtempSync(join(tmpdir(), "piab-home-file-"));
	const target = mkdtempSync(join(tmpdir(), "piab-state-target-"));
	try {
		symlinkSync(target, join(symlinkHome, ".agent-browser"), "dir");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: symlinkHome }), false);

		mkdirSync(join(sessionsSymlinkHome, ".agent-browser"), { mode: 0o700 });
		symlinkSync(target, join(sessionsSymlinkHome, ".agent-browser", "sessions"), "dir");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: sessionsSymlinkHome }), false);
		assert.deepEqual(getManagedSessionRestoreEnv({
			args: ["--session", "piab-managed", "open", "https://example.com"],
			cwd: sessionsSymlinkHome,
			ownedManagedSession: true,
			parentEnv: { HOME: sessionsSymlinkHome },
			restoreState: new ManagedSessionRestoreState(),
		}), {});

		mkdirSync(join(namespaceSymlinkHome, ".agent-browser"), { mode: 0o700 });
		symlinkSync(target, join(namespaceSymlinkHome, ".agent-browser", "namespaces"), "dir");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: namespaceSymlinkHome }, posixFixturePlatform, "Team"), false);
		assert.deepEqual(readdirSync(target), []);

		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: stateFileSymlinkHome }), true);
		const outsideStateFile = join(target, "outside.json");
		writeFileSync(outsideStateFile, "unchanged");
		symlinkSync(outsideStateFile, join(stateFileSymlinkHome, ".agent-browser", "sessions", "piab-r-unsafe.json"), "file");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: stateFileSymlinkHome }), false);
		assert.equal(readFileSync(outsideStateFile, "utf8"), "unchanged");

		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: temporaryFileSymlinkHome }), true);
		const outsideCandidate = join(target, "candidate.json");
		writeFileSync(outsideCandidate, "unchanged");
		symlinkSync(outsideCandidate, join(temporaryFileSymlinkHome, ".agent-browser", "sessions", ".tmp", "candidate.json"), "file");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: temporaryFileSymlinkHome }), false);
		assert.equal(readFileSync(outsideCandidate, "utf8"), "unchanged");

		writeFileSync(join(fileHome, ".agent-browser"), "not a directory");
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: fileHome }), false);
		assert.equal(ensureManagedSessionRestoreStorageIsSecure({ HOME: ` ${fileHome} ` }), false);
	} finally {
		rmSync(symlinkHome, { recursive: true, force: true });
		rmSync(sessionsSymlinkHome, { recursive: true, force: true });
		rmSync(namespaceSymlinkHome, { recursive: true, force: true });
		rmSync(stateFileSymlinkHome, { recursive: true, force: true });
		rmSync(temporaryFileSymlinkHome, { recursive: true, force: true });
		rmSync(fileHome, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("owned snapshot pruning persists close-proven paths and leaves unrecorded matching state untouched", () => {
	const cwd = isolatedProject;
	const home = mkdtempSync(join(tmpdir(), "piab-prune-home-"));
	const sessions = join(home, ".agent-browser", "sessions");
	const namespaceSessions = join(home, ".agent-browser", "namespaces", "team", "state", "sessions");
	const key = createManagedSessionRestoreKey(cwd);
	try {
		for (const directory of [sessions, namespaceSessions]) {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			for (const [index, suffix] of ["old", "middle", "new"].entries()) {
				const path = join(directory, `${key}-${suffix}.json`);
				writeFileSync(path, "{}");
				utimesSync(path, index + 1, index + 1);
			}
			writeFileSync(join(directory, `${key}-caller.json`), "{}");
		}
		chmodSync(join(home, ".agent-browser"), 0o700);

		for (const [index, suffix] of ["old", "middle", "new"].entries()) {
			assert.equal(pruneOwnedManagedSessionRestoreSnapshots({
				cwd,
				parentEnv: { HOME: home },
				platform: posixFixturePlatform,
				statePath: join(sessions, `${key}-${suffix}.json`),
			}), index === 2 ? 1 : 0);
		}
		assert.equal(existsSync(join(sessions, `${key}-old.json`)), false);
		const manifest = readdirSync(sessions).find((name) => name.startsWith(".pi-agent-browser-owned-snapshots-v2-"));
		assert.ok(manifest);
		const manifestDirectory = join(sessions, manifest);
		assert.equal(statSync(manifestDirectory).mode & 0o077, 0);
		const ownershipRecords = readdirSync(manifestDirectory).filter((name) => name.endsWith(".json"));
		assert.equal(ownershipRecords.length, 2);
		assert.equal(ownershipRecords.every((name) => (statSync(join(manifestDirectory, name)).mode & 0o077) === 0), true);
		assert.equal(existsSync(join(namespaceSessions, `${key}-old.json`)), true);
		assert.equal(existsSync(join(sessions, `${key}-caller.json`)), true);

		for (const [index, suffix] of ["old", "middle", "new"].entries()) {
			assert.equal(pruneOwnedManagedSessionRestoreSnapshots({
				cwd,
				namespace: "Team",
				parentEnv: { HOME: home },
				platform: posixFixturePlatform,
				statePath: join(namespaceSessions, `${key}-${suffix}.json`),
			}), index === 2 ? 1 : 0);
		}
		assert.equal(existsSync(join(namespaceSessions, `${key}-old.json`)), false);
		assert.equal(existsSync(join(namespaceSessions, `${key}-middle.json`)), true);
		assert.equal(existsSync(join(namespaceSessions, `${key}-new.json`)), true);
		assert.equal(existsSync(join(namespaceSessions, `${key}-caller.json`)), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("owned snapshot pruning leaves independent checkout generations untouched", () => {
	const home = mkdtempSync(join(tmpdir(), "piab-prune-independent-home-"));
	const otherProject = mkdtempSync(join(tmpdir(), "piab-prune-independent-project-"));
	initializeGitProject(otherProject);
	const sessions = join(home, ".agent-browser", "sessions");
	const currentKey = createManagedSessionRestoreKey(isolatedProject);
	const otherKey = createManagedSessionRestoreKey(otherProject);
	try {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		chmodSync(join(home, ".agent-browser"), 0o700);
		const otherPath = join(sessions, `${otherKey}-other.json`);
		const currentPath = join(sessions, `${currentKey}-current.json`);
		for (const path of [otherPath, currentPath]) writeFileSync(path, "{}");
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: otherProject, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: otherPath }), 0);
		const oldSeconds = (Date.now() - 31 * 24 * 60 * 60 * 1_000) / 1_000;
		utimesSync(otherPath, oldSeconds, oldSeconds);

		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: isolatedProject, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: currentPath }), 0);
		assert.equal(existsSync(otherPath), true);
		assert.equal(existsSync(join(sessions, `.pi-agent-browser-owned-snapshots-v2-${otherKey}`)), true);
		assert.equal(existsSync(currentPath), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(otherProject, { recursive: true, force: true });
	}
});

test("owned snapshot lineage follows a checkout rename", () => {
	const home = mkdtempSync(join(tmpdir(), "piab-prune-rename-home-"));
	const project = mkdtempSync(join(tmpdir(), "piab-prune-rename-project-"));
	const renamedProject = `${project}-renamed`;
	initializeGitProject(project);
	const sessions = join(home, ".agent-browser", "sessions");
	const key = createManagedSessionRestoreKey(project);
	try {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		chmodSync(join(home, ".agent-browser"), 0o700);
		const paths = ["old", "middle", "new"].map((suffix) => join(sessions, `${key}-${suffix}.json`));
		for (const path of paths) writeFileSync(path, "{}");
		const oldSeconds = (Date.now() - 31 * 24 * 60 * 60 * 1_000) / 1_000;
		utimesSync(paths[0] as string, oldSeconds, oldSeconds);
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: project, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: paths[0] }), 0);

		renameSync(project, renamedProject);
		assert.equal(createManagedSessionRestoreKey(renamedProject), key);
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: renamedProject, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: paths[1] }), 0);
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: renamedProject, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: paths[2] }), 1);
		assert.equal(existsSync(paths[0] as string), false);
	} finally {
		rmSync(project, { recursive: true, force: true });
		rmSync(renamedProject, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("owned snapshot pruning expires stale generations from the same checkout path", () => {
	const home = mkdtempSync(join(tmpdir(), "piab-prune-reused-home-"));
	const reusedProject = mkdtempSync(join(tmpdir(), "piab-prune-reused-project-"));
	initializeGitProject(reusedProject);
	const sessions = join(home, ".agent-browser", "sessions");
	const retiredKey = createManagedSessionRestoreKey(reusedProject);
	try {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		chmodSync(join(home, ".agent-browser"), 0o700);
		const retiredPath = join(sessions, `${retiredKey}-retired.json`);
		const unrecordedPath = join(sessions, `${retiredKey}-caller.json`);
		for (const path of [retiredPath, unrecordedPath]) writeFileSync(path, "{}");
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: reusedProject, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: retiredPath }), 0);
		const oldSeconds = (Date.now() - 31 * 24 * 60 * 60 * 1_000) / 1_000;
		utimesSync(retiredPath, oldSeconds, oldSeconds);

		rmSync(join(reusedProject, ".git"), { recursive: true, force: true });
		initializeGitProject(reusedProject);
		const currentKey = createManagedSessionRestoreKey(reusedProject);
		assert.notEqual(currentKey, retiredKey);
		const currentPath = join(sessions, `${currentKey}-current.json`);
		writeFileSync(currentPath, "{}");
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd: reusedProject, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: currentPath }), 1);
		assert.equal(existsSync(retiredPath), false);
		assert.equal(existsSync(unrecordedPath), true);
		assert.equal(existsSync(join(sessions, `.pi-agent-browser-owned-snapshots-v2-${retiredKey}`)), false);
		assert.equal(existsSync(currentPath), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(reusedProject, { recursive: true, force: true });
	}
});

test("owned snapshot manifest self-heals malformed records without claiming unrecorded files", () => {
	const cwd = isolatedProject;
	const home = mkdtempSync(join(tmpdir(), "piab-prune-recovery-home-"));
	const sessions = join(home, ".agent-browser", "sessions");
	const key = createManagedSessionRestoreKey(cwd);
	try {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		chmodSync(join(home, ".agent-browser"), 0o700);
		const oldPath = join(sessions, `${key}-old.json`);
		const middlePath = join(sessions, `${key}-middle.json`);
		const newPath = join(sessions, `${key}-new.json`);
		for (const path of [oldPath, middlePath, newPath]) writeFileSync(path, "{}");

		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: oldPath }), 0);
		const manifestName = readdirSync(sessions).find((name) => name.startsWith(".pi-agent-browser-owned-snapshots-v2-"));
		assert.ok(manifestName);
		const manifestDirectory = join(sessions, manifestName);
		const firstRecordPath = join(manifestDirectory, readdirSync(manifestDirectory).find((name) => name.endsWith(".json")) as string);
		writeFileSync(firstRecordPath, "not json");
		chmodSync(firstRecordPath, 0o644);

		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: middlePath }), 0);
		const middleRecordPath = join(manifestDirectory, readdirSync(manifestDirectory).find((name) => name.endsWith(".json")) as string);
		assert.equal(statSync(middleRecordPath).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(middleRecordPath, "utf8")), realpathSync(middlePath));
		assert.equal(existsSync(oldPath), true);

		writeFileSync(middleRecordPath, "x".repeat(16 * 1_024 + 1));
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: newPath }), 0);
		const remainingRecords = readdirSync(manifestDirectory).filter((name) => name.endsWith(".json"));
		assert.equal(remainingRecords.length, 1);
		assert.equal(JSON.parse(readFileSync(join(manifestDirectory, remainingRecords[0] as string), "utf8")), realpathSync(newPath));
		assert.equal(existsSync(middlePath), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("owned snapshot manifest converges concurrent process writers without a blocking lock", async () => {
	const cwd = isolatedProject;
	const home = mkdtempSync(join(tmpdir(), "piab-prune-concurrency-home-"));
	const sessions = join(home, ".agent-browser", "sessions");
	const key = createManagedSessionRestoreKey(cwd);
	const parentEnv = process.platform === "win32"
		? { AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), USERPROFILE: home }
		: { HOME: home };
	try {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") chmodSync(join(home, ".agent-browser"), 0o700);
		const paths = ["first", "second", "third"].map((suffix) => join(sessions, `${key}-${suffix}.json`));
		for (const path of paths) writeFileSync(path, "{}");
		assert.equal(pruneOwnedManagedSessionRestoreSnapshots({ cwd, parentEnv, statePath: paths[0] }), 0);
		const manifestName = readdirSync(sessions).find((name) => name.startsWith(".pi-agent-browser-owned-snapshots-v2-"));
		assert.ok(manifestName);
		const manifestPath = join(sessions, manifestName);
		const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-restore.ts", import.meta.url).href;
		const children = paths.slice(1).map((statePath) => {
			const script = `import { pruneOwnedManagedSessionRestoreSnapshots } from ${JSON.stringify(moduleUrl)}; pruneOwnedManagedSessionRestoreSnapshots(${JSON.stringify({ cwd, parentEnv, statePath })});`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
			const stderr: Buffer[] = [];
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			return { exit: once(child, "exit"), stderr };
		});
		for (const child of children) {
			const [code] = await child.exit as [number | null];
			assert.equal(code, 0, Buffer.concat(child.stderr).toString("utf8"));
		}
		const recordedPaths = readdirSync(manifestPath)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(join(manifestPath, name), "utf8")) as string);
		assert.deepEqual(new Set(recordedPaths), new Set(paths.map((path) => realpathSync(path))));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("owned snapshot retention converges concurrent young closes to the newest 256", async () => {
	const cwd = isolatedProject;
	const home = mkdtempSync(join(tmpdir(), "piab-prune-cap-home-"));
	const sessions = join(home, ".agent-browser", "sessions");
	const key = createManagedSessionRestoreKey(cwd);
	try {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		chmodSync(join(home, ".agent-browser"), 0o700);
		const paths = Array.from({ length: 258 }, (_, index) => join(sessions, `${key}-${String(index).padStart(3, "0")}.json`));
		const nowSeconds = Date.now() / 1_000;
		for (const [index, path] of paths.entries()) {
			writeFileSync(path, "{}");
			utimesSync(path, nowSeconds - (paths.length - index), nowSeconds - (paths.length - index));
			if (index < 256) pruneOwnedManagedSessionRestoreSnapshots({ cwd, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath: path });
		}
		const moduleUrl = new URL("../extensions/agent-browser/lib/managed-session-restore.ts", import.meta.url).href;
		const children = paths.slice(256).map((statePath) => {
			const script = `import { pruneOwnedManagedSessionRestoreSnapshots } from ${JSON.stringify(moduleUrl)}; pruneOwnedManagedSessionRestoreSnapshots(${JSON.stringify({ cwd, parentEnv: { HOME: home }, platform: posixFixturePlatform, statePath })});`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
			const stderr: Buffer[] = [];
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			return { exit: once(child, "exit"), stderr };
		});
		for (const child of children) {
			const [code] = await child.exit as [number | null];
			assert.equal(code, 0, Buffer.concat(child.stderr).toString("utf8"));
		}
		assert.equal(existsSync(paths[0] as string), false);
		assert.equal(existsSync(paths[1] as string), false);
		assert.equal(existsSync(paths.at(-1) as string), true);
		const manifestName = readdirSync(sessions).find((name) => name.startsWith(".pi-agent-browser-owned-snapshots-v2-"));
		assert.ok(manifestName);
		assert.equal(readdirSync(join(sessions, manifestName)).filter((name) => name.endsWith(".json")).length, 256);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("plan-suppressed owned main spawn sticky-disables even when process argv is rewritten", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = isolatedProject;
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
			getAndCommitManagedSessionRestoreEnv({
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

test("managed restore opt-out avoids state-directory permission changes and disables the spawned identity", { skip: process.platform === "win32" }, () => {
	clearManagedSessionRestoreDisabled();
	const cwd = mkdtempSync(join(tmpdir(), "piab-optout-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "piab-optout-home-"));
	const root = join(home, ".agent-browser");
	const managed = "piab-work-abc12345-deadbeef";
	try {
		initializeGitProject(cwd);
		mkdirSync(root, { mode: 0o750 });
		chmodSync(root, 0o750);
		assert.deepEqual(
			getAndCommitManagedSessionRestoreEnv({
				args: ["--json", "--session", managed, "snapshot", "-i"],
				cwd,
				ownedManagedSession: true,
				restoreState: managedSessionRestoreState,
				parentEnv: { HOME: home, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
			}),
			{},
		);
		assert.equal(statSync(root).mode & 0o077, 0o050);
		assert.equal(existsSync(join(cwd, ".git", "pi-agent-browser-project-generation-v1.json")), false);
		assert.equal(isManagedSessionRestoreDisabled(managed), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("incompatible launches sticky-disable even when managed restore is opted out", async () => {
	clearManagedSessionRestoreDisabled();
	const cwd = isolatedProject;
	const managed = "piab-work-abc12345-deadbeef";
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
			args: ["--json", "--session", managed, "--profile", "Default", "open", "https://app.example.com"],
			cwd,
			ownedManagedSession: true,
			restoreState: managedSessionRestoreState,
			parentEnv: { HOME: isolatedHome, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
		}),
		{},
	);
	assert.deepEqual(
		getAndCommitManagedSessionRestoreEnv({
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
			getAndCommitManagedSessionRestoreEnv({
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
	const cwd = isolatedProject;
	const managed = "piab-work-abc12345-deadbeef";
	const key = createManagedSessionRestoreKey(cwd, getManagedSessionRestoreScope(managed));
	let ownedProbeSawRestore = false;
	let foreignProbeSawRestore = false;
	await Promise.all([
		withOwnedManagedSessionContext({ restoreState: managedSessionRestoreState, sessionName: managed }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			ownedProbeSawRestore =
				getAndCommitManagedSessionRestoreEnv({
					args: ["--json", "--session", managed, "snapshot", "-i"],
					cwd,
					parentEnv: { HOME: isolatedHome },
				}).AGENT_BROWSER_RESTORE === key;
		}),
		withOwnedManagedSessionContext(undefined, async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			foreignProbeSawRestore =
				getAndCommitManagedSessionRestoreEnv({
					args: ["--json", "--session", managed, "snapshot", "-i"],
					cwd,
					parentEnv: { HOME: isolatedHome },
				}).AGENT_BROWSER_RESTORE === key;
		}),
	]);
	assert.equal(ownedProbeSawRestore, true);
	assert.equal(foreignProbeSawRestore, false);
});
