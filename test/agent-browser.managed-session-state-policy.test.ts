/** Verify wrapper-owned restore capabilities cannot cross checkout or global state-management boundaries. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getManagedSessionStateAccessValidationError } from "../extensions/agent-browser/lib/managed-session-state-policy.js";
import { createManagedSessionRestoreKey } from "../extensions/agent-browser/lib/managed-session-storage.js";

function initializeGitProject(path: string): void {
	execFileSync("git", ["init", "-q", path], { stdio: "ignore" });
}

function validate(cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string): string | undefined {
	return getManagedSessionStateAccessValidationError({ args, cwd, env, parentEnv: {}, stdin });
}

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
