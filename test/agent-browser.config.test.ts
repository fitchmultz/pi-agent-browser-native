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
	DEFAULT_WEB_SEARCH_PROVIDER,
	EXA_API_KEY_ENV,
	WEB_SEARCH_PROVIDER_DESCRIPTORS,
	WEB_SEARCH_PROVIDERS,
	canRegisterWebSearchTool,
	getWebSearchProviderConfigKey,
	getWebSearchProviderEnvVar,
	getCredentialSourceSummary,
	loadAgentBrowserConfig,
	loadAgentBrowserConfigSync,
	resolveWebSearchCredential,
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

test("shared config policy exposes canonical web-search provider descriptors", () => {
	assert.deepEqual(WEB_SEARCH_PROVIDERS, ["exa", "brave"]);
	assert.equal(DEFAULT_WEB_SEARCH_PROVIDER, "exa");
	assert.equal(WEB_SEARCH_PROVIDER_DESCRIPTORS.exa.configKey, "exaApiKey");
	assert.equal(WEB_SEARCH_PROVIDER_DESCRIPTORS.brave.configKey, "braveApiKey");
	assert.equal(getWebSearchProviderConfigKey("exa"), "exaApiKey");
	assert.equal(getWebSearchProviderConfigKey("brave"), "braveApiKey");
	assert.equal(getWebSearchProviderEnvVar("exa"), EXA_API_KEY_ENV);
	assert.equal(getWebSearchProviderEnvVar("brave"), BRAVE_API_KEY_ENV);
});

test("loads Pi-scoped global config and env fallback without leaking secret summaries", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, { version: 1, webSearch: { braveApiKey: "$BRAVE_API_KEY" } });
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: { ...fixture.env, BRAVE_API_KEY: "real-secret" } });
	assert.equal(canRegisterWebSearchTool(state, { ...fixture.env, BRAVE_API_KEY: "real-secret" }), true);
	const resolved = await resolveWebSearchCredential(state, "brave", { env: { ...fixture.env, BRAVE_API_KEY: "real-secret" } });
	assert.equal(resolved?.value, "real-secret");
	assert.equal(getCredentialSourceSummary(state.webSearchCredentialSources.brave, "brave"), "configured via environment interpolation (global)");
	assert.doesNotMatch(getCredentialSourceSummary(state.webSearchCredentialSources.brave, "brave"), /real-secret/);
});

test("uses project config over global config and rejects unsafe project-local Brave key sources", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, { version: 1, webSearch: { braveApiKey: "$GLOBAL_BRAVE_KEY" } });
	await writeJson(fixture.projectPath, { version: 1, webSearch: { braveApiKey: "plaintext-secret" } });
	const plaintextState = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" } });
	assert.match(plaintextState.errors.join("\n"), /plaintext, custom env aliases, interpolation literals, malformed env references, and command-backed project secrets are not allowed/);
	assert.equal(canRegisterWebSearchTool(plaintextState, { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" }), false);

	await writeJson(fixture.projectPath, { version: 1, webSearch: { braveApiKey: "!echo command-secret" } });
	const commandState = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" } });
	assert.match(commandState.errors.join("\n"), /command-backed project secrets are not allowed/);
	assert.equal(canRegisterWebSearchTool(commandState, { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" }), false);

	for (const unsafeValue of ["$", "$-plaintext-secret", "${BRAVE_API_KEY}_suffix", "$AWS_SECRET_ACCESS_KEY", "${EXA_API_KEY}"]) {
		await writeJson(fixture.projectPath, { version: 1, webSearch: { braveApiKey: unsafeValue } });
		const malformedState = await loadAgentBrowserConfig({ cwd: fixture.cwd, env: { ...fixture.env, GLOBAL_BRAVE_KEY: "global-secret" } });
		assert.match(malformedState.errors.join("\n"), /must be exactly \$BRAVE_API_KEY or \$\{BRAVE_API_KEY\}/);
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
	const resolved = await resolveWebSearchCredential(state, "brave", { env: fixture.env });
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
	assert.equal(state.browserDefaultProfileScope, "global");
	assert.equal(state.browserExecutablePath, "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
	assert.equal(state.browserExecutablePathScope, "global");
	assert.deepEqual(state.trustedBrowserDefaultProfile, { name: "Default", policy: "authenticated-only" });
	assert.equal(state.trustedBrowserDefaultProfileScope, "global");
	assert.equal(state.trustedBrowserExecutablePath, "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
	assert.equal(state.trustedBrowserExecutablePathScope, "global");
});

test("records project-local browser guidance scope without trusting it for prompt injection", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.projectPath, {
		version: 1,
		browser: {
			defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
			executablePath: "/tmp/project-browser",
		},
	});
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: fixture.env });
	assert.equal(state.browserDefaultProfileScope, "project");
	assert.equal(state.browserExecutablePathScope, "project");
	assert.equal(state.trustedBrowserDefaultProfile, undefined);
	assert.equal(state.trustedBrowserExecutablePath, undefined);
	assert.match(state.warnings.join("\n"), /authenticated\/always profile prompt guidance is emitted only from global or override config/);
	assert.match(state.warnings.join("\n"), /executable launch prompt guidance is emitted only from global or override config/);
});

test("trusted browser guidance skips project shadowing and keeps global values", async () => {
	const fixture = await createConfigFixture();
	await writeJson(fixture.globalPath, {
		version: 1,
		browser: {
			defaultProfile: { name: "Global Profile", policy: "authenticated-only" },
			executablePath: "/Applications/Global Browser.app/Contents/MacOS/Global Browser",
		},
	});
	await writeJson(fixture.projectPath, {
		version: 1,
		browser: {
			defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
			executablePath: "/tmp/project-browser",
		},
	});
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: fixture.env });
	assert.deepEqual(state.browserDefaultProfile, { name: "Project Profile", policy: "authenticated-only" });
	assert.equal(state.browserExecutablePath, "/tmp/project-browser");
	assert.deepEqual(state.trustedBrowserDefaultProfile, { name: "Global Profile", policy: "authenticated-only" });
	assert.equal(state.trustedBrowserExecutablePath, "/Applications/Global Browser.app/Contents/MacOS/Global Browser");
});

test("uses raw BRAVE_API_KEY only as fallback when no config credential source exists", async () => {
	const fixture = await createConfigFixture();
	const state = loadAgentBrowserConfigSync({ cwd: fixture.cwd, env: { ...fixture.env, BRAVE_API_KEY: "fallback-secret" } });
	assert.equal(canRegisterWebSearchTool(state, { ...fixture.env, BRAVE_API_KEY: "fallback-secret" }), true);
	assert.equal(getCredentialSourceSummary(state.webSearchCredentialSources.brave, "brave"), "configured via BRAVE_API_KEY environment fallback");
	const resolved = await resolveWebSearchCredential(state, "brave", { env: { ...fixture.env, BRAVE_API_KEY: "fallback-secret" } });
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
	assert.match(state.errors.join("\n"), /webSearch\.exaApiKey must be exactly \$EXA_API_KEY or \$\{EXA_API_KEY\}/);
	assert.equal(canRegisterWebSearchTool(state, fixture.env), false);
});
