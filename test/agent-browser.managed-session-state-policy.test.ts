/** Verify wrapper-owned restore capabilities cannot cross checkout or global state-management boundaries. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { parseBatchCommandArgument } from "../extensions/agent-browser/lib/orchestration/batch-stdin.js";
import {
	getCallerOwnedSessionLivePageVerificationRequirement,
	getManagedSessionResultingPageState,
	getManagedSessionStateAccessValidationError,
	getManagedSessionTargetAccessValidationError,
	getObservedBrowserPageValidationError,
	invocationMayNavigateToLocalFile,
} from "../extensions/agent-browser/lib/managed-session-state-policy.js";
import { createManagedSessionRestoreKey } from "../extensions/agent-browser/lib/managed-session-storage.js";

function initializeGitProject(path: string): void {
	execFileSync("git", ["init", "-q", path], { stdio: "ignore" });
}

function validate(cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string, currentPageUrl?: string): string | undefined {
	return getManagedSessionStateAccessValidationError({
		args,
		currentPageUrl,
		cwd,
		env,
		managedSessionRestoreKey: createManagedSessionRestoreKey(cwd),
		parentEnv: {},
		stdin,
	});
}

test("local file navigation detection covers direct and batch calls", () => {
	assert.equal(invocationMayNavigateToLocalFile(["open", "file:///tmp/page.html"]), true);
	assert.equal(invocationMayNavigateToLocalFile(["open", "  file:///tmp/page.html\t"]), true);
	assert.equal(invocationMayNavigateToLocalFile(["open", "fi\tle:///tmp/page.html"]), true);
	assert.equal(invocationMayNavigateToLocalFile(["tab", "new", "f\r\nile:///tmp/page.html"]), true);
	assert.equal(invocationMayNavigateToLocalFile(["batch"], JSON.stringify([["open", "fi\nle:///tmp/page.html"]])), true);
	assert.equal(invocationMayNavigateToLocalFile(["batch", "open fi\tle:///tmp/page.html"]), true);
	assert.equal(invocationMayNavigateToLocalFile(["batch", "open https://example.com"], JSON.stringify([["open", "file:///tmp/ignored.html"]])), false);
	assert.equal(invocationMayNavigateToLocalFile(["open", "https://example.com"]), false);
	assert.equal(invocationMayNavigateToLocalFile(["get", "url"]), false);
});

test("managed session targets require typed ownership", () => {
	assert.equal(getManagedSessionTargetAccessValidationError(["--session", "caller-owned", "snapshot", "-i"], false), undefined);
	assert.equal(getManagedSessionTargetAccessValidationError(["--session", "piab-owned", "snapshot", "-i"], true), undefined);
	for (const sessionName of ["piab-foreign", "PIAB-foreign", "PiAb-foreign"]) {
		assert.match(getManagedSessionTargetAccessValidationError(["--session", sessionName, "snapshot", "-i"], false) ?? "", /reserved/);
		assert.match(getManagedSessionTargetAccessValidationError(["session", "info"], false, { AGENT_BROWSER_SESSION: sessionName }) ?? "", /reserved/);
	}
});

test("non-bail batch page-state branching is bounded", () => {
	const stdin = JSON.stringify([
		...Array.from({ length: 10 }, (_value, index) => ["pushstate", `step-${index}/`]),
		["get", "html", "body"],
	]);
	const options = {
		args: ["--session", "external", "batch"],
		currentPageUrl: "https://initial.example/start/",
		cwd: tmpdir(),
		parentEnv: {},
		stdin,
	};
	assert.match(getManagedSessionStateAccessValidationError(options) ?? "", /--bail/);
	assert.equal(getManagedSessionStateAccessValidationError({ ...options, args: ["--session", "external", "batch", "--bail"] }), undefined);
});

test("managed state policy allows only the current checkout restore capability", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-state-policy-"));
	initializeGitProject(tempDir);
	try {
		const currentKey = createManagedSessionRestoreKey(tempDir);
		const foreignKey = `piab-r2-${"a".repeat(32)}` === currentKey ? `piab-r2-${"b".repeat(32)}` : `piab-r2-${"a".repeat(32)}`;
		assert.equal(validate(tempDir, ["--restore", currentKey, "open", "https://example.com"]), undefined);
		assert.equal(validate(tempDir, ["state", "show", `${currentKey}-managed.json`]), undefined);
		assert.match(validate(tempDir, ["--restore", foreignKey, "open", "https://example.com"]) ?? "", /outside the current checkout/);
		assert.match(validate(tempDir, ["--restore", `piab-r-${"c".repeat(32)}`, "open", "https://example.com"]) ?? "", /outside the current checkout/);
		assert.match(validate(tempDir, ["--state", `/tmp/${foreignKey}-managed.json`, "open", "https://example.com"]) ?? "", /outside the current checkout/);
		assert.match(validate(tempDir, ["open", "https://example.com"], { AGENT_BROWSER_RESTORE: foreignKey }) ?? "", /outside the current checkout/);

		if (process.platform !== "win32") {
			const foreignState = join(tempDir, `${foreignKey}-managed.json`);
			const alias = join(tempDir, "alias.json");
			await writeFile(foreignState, "{}");
			await symlink(foreignState, alias);
			assert.match(validate(tempDir, ["state", "load", alias]) ?? "", /outside the current checkout/);
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("managed state policy blocks browser navigation into local agent-browser storage", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-file-state-policy-"));
	try {
		const localDirectoryUrl = pathToFileURL(`${tempDir}/`).href;
		const localFileUrl = pathToFileURL(join(tempDir, "fixture.html")).href;
		const protectedPath = join(tempDir, ".agent-browser", "sessions", "snapshot.json");
		const protectedUrl = pathToFileURL(protectedPath).href;
		const encodedProtectedUrl = protectedUrl.replace(".agent-browser", "%25252Eagent-browser");
		for (const args of [
			["open", protectedUrl],
			["open", `view-source:${protectedUrl}`],
			["open", `filesystem:${protectedUrl}`],
			["open", "--headed", protectedUrl],
			["a11y", localFileUrl],
			["web-vitals", protectedUrl],
			["auth", "login", "profile", "--url", "-x/../.agent-browser/login.html"],
			["read", encodedProtectedUrl],
			["read", "--filter", "cookies", protectedUrl],
			["open", join(tempDir, ".agent-browser", "sessions")],
			["open", "-x/../.agent-browser/sessions/auth.html"],
			["open", join(tempDir, ".agent-browser.", "sessions", "auth.html")],
			["tab", "new", "--label", "files", "-x/../.agent-browser/sessions/auth.html"],
			["screenshot", "body", join(tempDir, ".agent-browser", "capture.png")],
			["screenshot", "-x/../.agent-browser/capture.png"],
			["upload", "#file", "-tmp/../../.agent-browser/sessions/auth.json"],
			["download", "@e1", "-x/../.agent-browser/download.json"],
			["pdf", "-x/../.agent-browser/page.pdf"],
			["pdf", "C:.agent-browser\\state\\page.pdf"],
			["pdf", "C:.agent-browser:secret\\state\\page.pdf"],
			["pdf", "C:folder\\..\\.agent-browser\\state\\page.pdf"],
			["state", "load", "-x/../.agent-browser/auth.json"],
			["screenshot", "--screenshot-format", "png", join(tempDir, ".agent-browser", "capture.png")],
			["screenshot", "--screenshot-quality", "80", join(tempDir, ".agent-browser", "capture.jpg")],
			["screenshot", "--full", "--annotate", "--screenshot-format", "jpeg", join(tempDir, ".agent-browser", "flagged.jpg")],
			["trace", "stop", join(tempDir, ".agent-browser", "trace.json")],
			["trace", "stop", "--json", join(tempDir, ".agent-browser", "trace-flags.json")],
			["profiler", "stop", join(tempDir, ".agent-browser", "profile.json")],
			["profiler", "stop", "--json", join(tempDir, ".agent-browser", "profile-flags.json")],
			["network", "har", "stop", "--content", "all", join(tempDir, ".agent-browser", "network.har")],
			["wait", "--download", join(tempDir, ".agent-browser", "download.json")],
			["wait", "-d", join(tempDir, ".agent-browser", "download-short.json")],
			["diff", "screenshot", "--baseline", "safe.png", "--output", join(tempDir, ".agent-browser", "diff.png")],
			["--action-policy", "-x/../.agent-browser/policy.json", "open", "https://example.com"],
			["--ca-cert", "-x/../.agent-browser/proxy-ca.pem", "open", "https://example.com"],
			["--config", "-x/../.agent-browser/config.json", "open", "https://example.com"],
			["--download-path", "-x/../.agent-browser/downloads", "open", "https://example.com"],
			["--screenshot-dir", "-x/../.agent-browser/screenshots", "open", "https://example.com"],
			["--state", "-x/../.agent-browser/auth.json", "open", "https://example.com"],
			["--download-path", join(tempDir, ".agent-browser", "downloads"), "open", "https://example.com"],
			["--executable-path", protectedPath, "open", "https://example.com"],
			["--profile", protectedPath, "open", "https://example.com"],
			["--screenshot-dir", join(tempDir, ".agent-browser", "screenshots"), "open", "https://example.com"],
		]) {
			assert.match(validate(tempDir, args) ?? "", /authenticated cookies and storage|Explicit upstream agent-browser config/, args.join(" "));
		}
		if (process.platform !== "win32") {
			const aliasPath = join(tempDir, "state-alias.json");
			await mkdir(join(tempDir, ".agent-browser", "sessions"), { recursive: true });
			await writeFile(protectedPath, "{}");
			await symlink(protectedPath, aliasPath);
			const directoryAlias = join(tempDir, "state-directory-alias");
			await symlink(join(tempDir, ".agent-browser"), directoryAlias);
			assert.match(validate(tempDir, ["open", pathToFileURL(aliasPath).href]) ?? "", /authenticated cookies and storage/);
			assert.match(validate(tempDir, ["open", "state-alias.json"]) ?? "", /authenticated cookies and storage/);
			assert.match(validate(tempDir, ["screenshot", join(directoryAlias, "new", "capture.png")]) ?? "", /authenticated cookies and storage/);
		}
		for (const stdin of [
			JSON.stringify([["screenshot", "--screenshot-quality", "80", join(tempDir, ".agent-browser", "batch-capture.jpg")]]),
			JSON.stringify([["open", localDirectoryUrl], ["snapshot", "-i"], ["click", "@e1"]]),
			JSON.stringify([["tab", "new", "--label", "files", localDirectoryUrl], ["mouse", "down"]]),
			JSON.stringify([["tab", "t2"], ["snapshot", "-i"]]),
			JSON.stringify([["tab", "close"], ["snapshot", "-i"]]),
			JSON.stringify([["connect", "9222"], ["snapshot", "-i"]]),
			JSON.stringify([["state", "load", "caller-owned.json"], ["snapshot", "-i"]]),
		]) {
			assert.match(validate(tempDir, ["batch"], undefined, stdin) ?? "", /authenticated cookies and storage|active page became unverified/);
		}
		for (const args of [["click", "@e1"], ["download", "@e1", join(tempDir, "copied.json")]]) {
			assert.match(validate(tempDir, args, undefined, undefined, localDirectoryUrl) ?? "", /authenticated cookies and storage/);
		}
		assert.match(validate(tempDir, ["screenshot"], undefined, undefined, protectedUrl) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["eval", "--stdin"], undefined, "location.href = ['file:', '/tmp'].join('')", localFileUrl) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["screenshot"], undefined, undefined, localFileUrl) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["pushstate", "/still-local"], undefined, undefined, localFileUrl) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["--allow-file-access", "open", localFileUrl]) ?? "", /exfiltrate authenticated/);
		assert.match(validate(tempDir, ["--allow-file-access=true", "open", localFileUrl]) ?? "", /exfiltrate authenticated/);
		assert.match(validate(tempDir, ["--allow-file-access", "true", "--allow-file-access=false", "open", "https://example.com"]) ?? "", /exfiltrate authenticated/);
		assert.match(validate(tempDir, ["open", localFileUrl], { AGENT_BROWSER_ALLOW_FILE_ACCESS: "true" }) ?? "", /exfiltrate authenticated/);
		for (const rawArgs of ["--allow-file-access-from-files", "--allow-file-access=1", "--disable-web-security", "\u0085--allow-file-access-from-files"]) {
			assert.match(validate(tempDir, ["--args", rawArgs, "open", "https://example.com"]) ?? "", /exfiltrate authenticated/, rawArgs);
			assert.match(validate(tempDir, ["open", "https://example.com"], { AGENT_BROWSER_ARGS: rawArgs }) ?? "", /exfiltrate authenticated/, rawArgs);
		}
		assert.match(validate(tempDir, ["--args", "--user-data-dir=-x/../.agent-browser/chrome", "open", "https://example.com"]) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["open", "https://example.com"], { AGENT_BROWSER_ARGS: `--disable-gpu,\u0085--load-extension=${protectedPath}` }) ?? "", /authenticated cookies and storage/);
		assert.equal(validate(tempDir, ["--args", "--disable-gpu", "open", "https://example.com"]), undefined);
		for (const name of [
			"AGENT_BROWSER_ACTION_POLICY",
			"AGENT_BROWSER_CA_CERT",
			"AGENT_BROWSER_CONFIG",
			"AGENT_BROWSER_DOWNLOAD_PATH",
			"AGENT_BROWSER_EXECUTABLE_PATH",
			"AGENT_BROWSER_PROFILE",
			"AGENT_BROWSER_SCREENSHOT_DIR",
			"AGENT_BROWSER_SKILLS_DIR",
			"AGENT_BROWSER_SOCKET_DIR",
			"AGENT_BROWSER_STATE",
		]) {
			assert.match(validate(tempDir, ["open", "https://example.com"], { [name]: `\u0085${protectedPath}` }) ?? "", /authenticated cookies and storage|Explicit upstream agent-browser config/, name);
		}
		for (const name of ["AGENT_BROWSER_EXTENSIONS", "AGENT_BROWSER_INIT_SCRIPTS"]) {
			assert.match(validate(tempDir, ["open", "https://example.com"], { [name]: `safe.js,\u0085${protectedPath}` }) ?? "", /authenticated cookies and storage/, name);
		}
		assert.equal(validate(tempDir, ["--allow-file-access", "false", "open", localFileUrl]), undefined);
		assert.equal(validate(tempDir, ["pdf", "C:safe\\report.pdf"]), undefined);
		assert.match(validate(tempDir, ["screenshot", join(tempDir, ".agent-browser", "capture.png")]) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["download", "@e1", join(tempDir, ".agent-browser", "download.json")]) ?? "", /authenticated cookies and storage/);
		assert.equal(validate(tempDir, ["get", "text", ".agent-browser"]), undefined);
		assert.equal(validate(tempDir, ["read", "https://example.com", "--filter", ".agent-browser"]), undefined);
		assert.equal(validate(tempDir, ["fill", "#field", ".agent-browser"]), undefined);
		assert.equal(validate(tempDir, ["screenshot", ".agent-browser"]), undefined);
		assert.equal(getObservedBrowserPageValidationError(["get", "url"], localFileUrl, tempDir), undefined);
		assert.equal(getObservedBrowserPageValidationError(["open", localFileUrl], localFileUrl, tempDir), undefined);
		assert.match(getObservedBrowserPageValidationError(["back"], localFileUrl, tempDir) ?? "", /authenticated cookies and storage/);
		assert.match(getObservedBrowserPageValidationError(["open", localFileUrl], protectedUrl, tempDir) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["batch", `open ${protectedUrl}`, "get html"]) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["batch"], undefined, JSON.stringify([
			["batch", `open ${localFileUrl}`],
			["get", "html", "body"],
		]), "https://example.com") ?? "", /Nested batch/);
		assert.match(validate(tempDir, ["batch", `batch 'open ${localFileUrl}'`, "get html body"], undefined, undefined, "https://example.com") ?? "", /Nested batch/);
		assert.match(validate(tempDir, ["batch", `screenshot --screenshot-quality 80 ${join(tempDir, ".agent-browser", "batch-arg.png")}`]) ?? "", /authenticated cookies and storage/);
		assert.equal(validate(tempDir, ["batch", "'unterminated"]), undefined);
		assert.equal(validate(tempDir, ["batch", "open https://example.com", "snapshot -i"]), undefined);
		const unverifiedEvalBatchError = validate(tempDir, ["batch"], undefined, JSON.stringify([["eval", "location.href='file:///tmp/local.html'"], ["snapshot", "-i"]])) ?? "";
		assert.match(unverifiedEvalBatchError, /active page became unverified/);
		assert.match(unverifiedEvalBatchError, /put get url after the transition.*or split the batch/);
		assert.equal(validate(tempDir, ["open", "--headed", "https://example.com"], undefined, undefined, protectedUrl), undefined);
		assert.equal(validate(tempDir, ["close"], undefined, undefined, protectedUrl), undefined);
		assert.equal(validate(tempDir, ["close"], { AGENT_BROWSER_STATE: protectedPath }), undefined);
		const attachNavigateSnapshotBatch = JSON.stringify([
			["connect", "9222"],
			["open", "https://example.com"],
			["snapshot", "-i"],
		]);
		assert.match(validate(tempDir, ["batch"], undefined, attachNavigateSnapshotBatch) ?? "", /--bail/);
		assert.equal(validate(tempDir, ["batch", "--bail"], undefined, attachNavigateSnapshotBatch), undefined);
		assert.deepEqual(getManagedSessionResultingPageState({ args: ["batch"], stdin: JSON.stringify([["connect", "9222"]]) }), {
			pageTargetMayHaveChanged: true,
			pageUrlUnknown: true,
		});
		assert.deepEqual(getManagedSessionResultingPageState({ args: ["eval", "location.href='https://example.com/next'"] }), {
			pageTargetMayHaveChanged: true,
			pageUrlUnknown: true,
		});
		assert.deepEqual(getManagedSessionResultingPageState({ args: ["batch", "open https://example.com", "eval location.reload()"] }), {
			pageTargetMayHaveChanged: true,
			pageUrlUnknown: true,
		});
		assert.deepEqual(getManagedSessionResultingPageState({ args: ["pushstate", "/spa/route"], currentPageUrl: "https://example.com/start" }), {
			currentPageUrl: "https://example.com/spa/route",
			pageTargetMayHaveChanged: true,
			pageUrlUnknown: false,
		});
		assert.deepEqual(getManagedSessionResultingPageState({ args: ["batch"], stdin: JSON.stringify([["connect", "9222"], ["open", "https://example.com"]]) }), {
			currentPageUrl: "https://example.com",
			pageTargetMayHaveChanged: true,
			pageUrlUnknown: false,
		});
		assert.equal(getManagedSessionStateAccessValidationError({ args: ["get", "url"], cwd: tempDir, pageUrlUnknown: true }), undefined);
		assert.equal(getManagedSessionStateAccessValidationError({ args: ["tab", "list"], cwd: tempDir, pageUrlUnknown: true }), undefined);
		assert.equal(getCallerOwnedSessionLivePageVerificationRequirement({ args: ["--session", "external", "session", "info"], cwd: tempDir }), undefined);
		const navigationThenContentBatch = JSON.stringify([["pushstate", "https://safe.example/"], ["get", "html", "body"]]);
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch"],
			cwd: tempDir,
			pageUrlUnknown: true,
			stdin: navigationThenContentBatch,
		}) ?? "", /--bail/);
		assert.equal(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch", "--bail"],
			cwd: tempDir,
			pageUrlUnknown: true,
			stdin: navigationThenContentBatch,
		}), undefined);
		assert.equal(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch"],
			currentPageUrl: "https://initial.example/",
			cwd: tempDir,
			stdin: navigationThenContentBatch,
		}), undefined);
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch"],
			currentPageUrl: protectedUrl,
			cwd: tempDir,
			stdin: navigationThenContentBatch,
		}) ?? "", /--bail/);
		assert.equal(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch", "--bail"],
			currentPageUrl: protectedUrl,
			cwd: tempDir,
			stdin: navigationThenContentBatch,
		}), undefined);
		// Upstream keeps --bail=false as a raw command row (only the exact --bail
		// token is a flag), so the validator scans it as a step and still rejects
		// the continuation hazard fail-closed.
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch", "--bail=false"],
			currentPageUrl: protectedUrl,
			cwd: tempDir,
			stdin: navigationThenContentBatch,
		}) ?? "", /is blocked/);
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch", "open https://safe.example/", "get html body"],
			currentPageUrl: protectedUrl,
			cwd: tempDir,
		}) ?? "", /--bail/);
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch"],
			currentPageUrl: protectedUrl,
			cwd: tempDir,
			stdin: JSON.stringify([["open", "https://one.example/"], ["open", "https://two.example/"], ["get", "html", "body"]]),
		}) ?? "", /--bail/);
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch"],
			currentPageUrl: protectedUrl,
			cwd: tempDir,
			stdin: JSON.stringify([["open", "https://safe.example/"], ["eval", "document.title"]]),
		}) ?? "", /--bail/);
		assert.match(getManagedSessionStateAccessValidationError({
			args: ["--session", "external", "batch"],
			currentPageUrl: "https://initial.example/",
			cwd: tempDir,
			stdin: JSON.stringify([["open", "https://safe.example/"], ["connect", "9222"], ["get", "html", "body"]]),
		}) ?? "", /active page became unverified/);
		assert.equal(getManagedSessionStateAccessValidationError({ args: ["tab", "t2"], cwd: tempDir, pageUrlUnknown: true }), undefined);
		assert.match(getManagedSessionStateAccessValidationError({ args: ["snapshot", "-i"], cwd: tempDir, pageUrlUnknown: true }) ?? "", /active page became unverified/);
		assert.equal(getManagedSessionStateAccessValidationError({
			args: ["batch"],
			currentPageUrl: "https://example.com",
			cwd: tempDir,
			parentEnv: {},
			stdin: JSON.stringify([["tab", "t1"], ["snapshot", "-i"]]),
			trustedFirstBatchTabSelection: true,
		}), undefined);

		assert.match(validate(tempDir, ["--config", "safe-config.json", "open", "https://example.com"]) ?? "", /Explicit upstream agent-browser config/);
		assert.match(validate(tempDir, ["open", "https://example.com"], { AGENT_BROWSER_CONFIG: "safe-config.json" }) ?? "", /Explicit upstream agent-browser config/);
		await writeFile(join(tempDir, "agent-browser.json"), JSON.stringify({ state: protectedPath }));
		assert.equal(validate(tempDir, ["open", "https://example.com"]), undefined);
		assert.equal(validate(tempDir, ["doctor"]), undefined);
		assert.equal(validate(tempDir, ["close"]), undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("batch command strings match upstream ASCII-space and quoting rules", () => {
	assert.deepEqual(parseBatchCommandArgument("open https://example.com").step, ["open", "https://example.com"]);
	assert.deepEqual(parseBatchCommandArgument("open\thttps://example.com").step, ["open\thttps://example.com"]);
	assert.deepEqual(parseBatchCommandArgument("open\u00a0https://example.com").step, ["open\u00a0https://example.com"]);
	assert.deepEqual(parseBatchCommandArgument("get text 'main content'").step, ["get", "text", "main content"]);
	assert.deepEqual(parseBatchCommandArgument('get text "main content"').step, ["get", "text", "main content"]);
	assert.deepEqual(parseBatchCommandArgument("type #name Ada\\ Lovelace").step, ["type", "#name", "Ada Lovelace"]);
	assert.deepEqual(parseBatchCommandArgument("open 'unterminated").step, ["open", "unterminated"]);
	assert.deepEqual(parseBatchCommandArgument("open trailing\\").step, ["open", "trailing"]);
	assert.match(parseBatchCommandArgument("''").error ?? "", /empty/);
});

test("managed state policy blocks broad deletion and wrapper-owned state mutation", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-state-mutation-"));
	initializeGitProject(tempDir);
	try {
		const currentKey = createManagedSessionRestoreKey(tempDir);
		assert.equal(validate(tempDir, ["state", "list"]), undefined);
		assert.equal(validate(tempDir, ["state", "clear", "caller-owned"]), undefined);
		assert.match(validate(tempDir, ["batch"], undefined, JSON.stringify([["state", "clear", "--all"]])) ?? "", /outside the current checkout/);
		for (const args of [
			["state", "clear"],
			["state", "clear", "--all"],
			["state", "clear", "piab-managed-session"],
			["state", "clean", "--older-than", "30"],
			["state", "rename", `${currentKey}-managed`, "renamed"],
			["state", "save", `${currentKey}-managed.json`],
		]) {
			assert.match(validate(tempDir, args) ?? "", /outside the current checkout/, args.join(" "));
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
