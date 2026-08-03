/** Verify wrapper-owned restore capabilities cannot cross checkout or global state-management boundaries. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
	getManagedSessionStateAccessValidationError,
	getManagedSessionTargetAccessValidationError,
} from "../extensions/agent-browser/lib/managed-session-state-policy.js";
import { createManagedSessionRestoreKey } from "../extensions/agent-browser/lib/managed-session-storage.js";

function initializeGitProject(path: string): void {
	execFileSync("git", ["init", "-q", path], { stdio: "ignore" });
}

function validate(cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string, currentPageUrl?: string): string | undefined {
	return getManagedSessionStateAccessValidationError({ args, currentPageUrl, cwd, env, parentEnv: {}, stdin });
}

test("managed session targets require typed ownership", () => {
	assert.equal(getManagedSessionTargetAccessValidationError(["--session", "caller-owned", "snapshot", "-i"], false), undefined);
	assert.equal(getManagedSessionTargetAccessValidationError(["--session", "piab-owned", "snapshot", "-i"], true), undefined);
	assert.match(getManagedSessionTargetAccessValidationError(["--session", "piab-foreign", "snapshot", "-i"], false) ?? "", /reserved/);
	assert.match(getManagedSessionTargetAccessValidationError(["session", "info"], false, { AGENT_BROWSER_SESSION: "piab-foreign" }) ?? "", /reserved/);
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
		const protectedUrl = pathToFileURL(join(tempDir, ".agent-browser", "sessions", "snapshot.json")).href;
		const encodedProtectedUrl = protectedUrl.replace(".agent-browser", "%25252Eagent-browser");
		for (const args of [
			["open", protectedUrl],
			["read", encodedProtectedUrl],
			["open", join(tempDir, ".agent-browser", "sessions")],
		]) {
			assert.match(validate(tempDir, args) ?? "", /authenticated cookies and storage/, args.join(" "));
		}
		if (process.platform !== "win32") {
			const protectedPath = join(tempDir, ".agent-browser", "sessions", "snapshot.json");
			const aliasPath = join(tempDir, "state-alias.json");
			await mkdir(join(tempDir, ".agent-browser", "sessions"), { recursive: true });
			await writeFile(protectedPath, "{}");
			await symlink(protectedPath, aliasPath);
			assert.match(validate(tempDir, ["open", pathToFileURL(aliasPath).href]) ?? "", /authenticated cookies and storage/);
		}
		for (const stdin of [
			JSON.stringify([["open", localDirectoryUrl], ["snapshot", "-i"], ["click", "@e1"]]),
			JSON.stringify([["tab", "new", "--label", "files", localDirectoryUrl], ["mouse", "down"]]),
		]) {
			assert.match(validate(tempDir, ["batch"], undefined, stdin) ?? "", /authenticated cookies and storage/);
		}
		for (const args of [["click", "@e1"], ["download", "@e1", join(tempDir, "copied.json")]]) {
			assert.match(validate(tempDir, args, undefined, undefined, localDirectoryUrl) ?? "", /authenticated cookies and storage/);
		}
		assert.match(validate(tempDir, ["screenshot"], undefined, undefined, protectedUrl) ?? "", /authenticated cookies and storage/);
		assert.match(validate(tempDir, ["eval", "--stdin"], undefined, `location.href = "${protectedUrl}"`, localDirectoryUrl) ?? "", /authenticated cookies and storage/);
		assert.equal(validate(tempDir, ["screenshot"], undefined, undefined, localDirectoryUrl), undefined);
		assert.equal(validate(tempDir, ["open", "https://example.com"], undefined, undefined, protectedUrl), undefined);
		assert.equal(validate(tempDir, ["close"], undefined, undefined, protectedUrl), undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
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
