/**
 * Purpose: Verify pi-agent-browser-native package config loading, credential classification, safety rules, and redaction helpers.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
	BRAVE_API_KEY_ENV,
	EXA_API_KEY_ENV,
	canRegisterWebSearchTool,
	getCredentialSourceSummary,
	loadAgentBrowserConfig,
	loadAgentBrowserConfigSync,
	resolveBraveApiKey,
} from "../extensions/agent-browser/lib/config.js";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createConfigFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-config-test-"));
	const home = join(root, "home");
	const cwd = join(root, "repo");
	await mkdir(home, { recursive: true });
	await mkdir(cwd, { recursive: true });
	return {
		cwd,
		env: { HOME: home, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: undefined } as NodeJS.ProcessEnv,
		globalPath: join(home, ".pi", "config", "pi-agent-browser-native", "config.json"),
		projectPath: join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json"),
		root,
	};
}

test("loads Pi-scoped global config and env fallback without leaking secret summaries", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, { version: 1, webSearch: { braveApiKey: "$BRAVE_API_KEY" } });
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: { ...fixture.env, BRAVE_API_KEY: "real-secret" } });
	assert.equal(canRegisterWebSearchTool(state, { ...fixture.env, BRAVE_API_KEY: "real-secret" }), true);
	const resolved = await resolveBraveApiKey(state, { env: { ...fixture.env, BRAVE_API_KEY: "real-secret" } });
	assert.equal(resolved?.value, "real-secret");
	assert.equal(getCredentialSourceSummary(state.credentialSource), "configured via environment interpolation (global)");
	assert.doesNotMatch(getCredentialSourceSummary(state.credentialSource), /real-secret/);
});

test("uses project config over global config and rejects unsafe project-local Brave key sources", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, { version: 1, webSearch: { braveApiKey: "$GLOBAL_BRAVE_KEY" } });
	await writeJson(fixture.projectPath, { version: 1, webSearch: { braveApiKey: "plaintext-secret" } });
	const plaintextState = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" } });
	assert.match(plaintextState.errors.join("\n"), /plaintext, interpolation literals, malformed env references, and command-backed project secrets are not allowed/);
	assert.equal(canRegisterWebSearchTool(plaintextState, { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" }), false);

	await writeJson(fixture.projectPath, { version: 1, webSearch: { braveApiKey: "!echo command-secret" } });
	const commandState = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" } });
	assert.match(commandState.errors.join("\n"), /command-backed project secrets are not allowed/);
	assert.equal(canRegisterWebSearchTool(commandState, { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" }), false);

	for (const unsafeValue of ["$", "$-plaintext-secret", "${BRAVE_API_KEY}_suffix"]) {
		await writeJson(fixture.projectPath, { version: 1, webSearch: { braveApiKey: unsafeValue } });
		const malformedState = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" } });
		assert.match(malformedState.errors.join("\n"), /must be exactly \$ENV_VAR or \$\{ENV_VAR\}/);
		assert.equal(canRegisterWebSearchTool(malformedState, { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" }), false);
	}
});

test("registers command credential sources without executing them at startup", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, {
		version: 1,
		webSearch: { braveApiKey: `!${process.execPath} -e "process.stdout.write('command-secret')"` },
	});
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: fixture.env });
	assert.equal(canRegisterWebSearchTool(state, fixture.env), true);
	const resolved = await resolveBraveApiKey(state, { env: fixture.env });
	assert.equal(resolved?.value, "command-secret");
});

test("captures browser defaults with conservative profile policy and executable path", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, {
		version: 1,
		browser: {
			defaultProfile: { name: "Default" },
			executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		},
	});
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: fixture.env });
	assert.deepEqual(state.browserDefaultProfile, { name: "Default", policy: "authenticated-only" });
	assert.equal(state.browserExecutablePath, "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
});

test("uses raw BRAVE_API_KEY only as fallback when no config credential source exists", async () => {
	const fixture = await createConfigFixture();
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: { ...fixture.env, BRAVE_API_KEY: "fallback-secret" } });
	assert.equal(canRegisterWebSearchTool(state, { ...fixture.env, BRAVE_API_KEY: "fallback-secret" }), true);
	assert.equal(getCredentialSourceSummary(state.credentialSource), "configured via BRAVE_API_KEY environment fallback");
	const resolved = await resolveBraveApiKey(state, { env: { ...fixture.env, BRAVE_API_KEY: "fallback-secret" } });
	assert.equal(resolved?.value, "fallback-secret");
});

test("loads Exa config, preferred provider, and disabled web search policy", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, { version: 1, webSearch: { exaApiKey: "$EXA_API_KEY", preferredProvider: "brave" } });
	let state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: { ...fixture.env, EXA_API_KEY: "exa-secret" } });
	assert.equal(state.webSearchPreferredProvider, "brave");
	assert.equal(getCredentialSourceSummary(state.webSearchCredentialSources.exa, "exa"), "configured via environment interpolation (global)");
	assert.equal(canRegisterWebSearchTool(state, { ...fixture.env, EXA_API_KEY: "exa-secret" }), true);
	await writeJson(fixture.projectPath, { version: 1, webSearch: { enabled: false } });
	state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: { ...fixture.env, EXA_API_KEY: "exa-secret" } });
	assert.equal(state.webSearchEnabled, false);
	assert.equal(canRegisterWebSearchTool(state, { ...fixture.env, EXA_API_KEY: "exa-secret" }), false);
});

test("rejects unsafe project-local Exa key sources", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.projectPath, { version: 1, webSearch: { exaApiKey: "plaintext-secret" } });
	const state = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: fixture.env });
	assert.match(state.errors.join("\n"), /webSearch\.exaApiKey must be exactly \$ENV_VAR or \$\{ENV_VAR\}/);
	assert.equal(canRegisterWebSearchTool(state, fixture.env), false);
});
