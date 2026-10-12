/**
 * Purpose: Verify optional Exa/Brave-backed agent_browser_web_search registration, request shaping, result normalization, and secret redaction.
 */

import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { inspect } from "node:util";

import {
	AGENT_BROWSER_CONFIG_ENV,
	BRAVE_API_KEY_ENV,
	EXA_API_KEY_ENV,
} from "../extensions/agent-browser/lib/config.js";
import {
	AGENT_BROWSER_WEB_SEARCH_TOOL_NAME,
	EXA_SEARCH_SYSTEM_PROMPT,
	WEB_SEARCH_MIN_REQUEST_INTERVAL_MS,
	WebSearchRequestGate,
	buildBraveSearchUrl,
	buildExaSearchRequestBody,
	cleanSearchText,
	decodeHtmlEntities,
	fetchBraveSearchJson,
	fetchExaSearchJson,
	normalizeExaSearchResult,
	normalizeBraveSearchResult,
} from "../extensions/agent-browser/lib/web-search.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	getBrowserInstructions,
	runExtensionEvent,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withFakeFetch<T>(
	handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
	run: () => Promise<T>,
): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (input, init) => Promise.resolve(handler(input, init));
	try {
		return await run();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

async function pathExists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

async function createFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-web-search-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const cwd = join(root, "repo");
	await mkdir(home, { recursive: true });
	await mkdir(cwd, { recursive: true });
	return {
		cwd,
		home,
		overrideConfigPath: join(root, "override-config.json"),
		projectConfigPath: join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json"),
	};
}

async function withTemporaryCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
	const previousCwd = process.cwd();
	process.chdir(cwd);
	try {
		return await run();
	} finally {
		process.chdir(previousCwd);
	}
}

async function withTemporaryArgv<T>(argv: readonly string[], run: () => Promise<T>): Promise<T> {
	const previousArgv = process.argv;
	process.argv = [...argv];
	try {
		return await run();
	} finally {
		process.argv = previousArgv;
	}
}

test("does not register agent_browser_web_search without env or config credential", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
			assert.equal(
				(await getBrowserInstructions(harness)).includes(
					"Use agent_browser for real browser or live web content.",
				),
				true,
			);
		},
	);
});

test("trusted project web-search config registers the companion tool on session start", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.projectConfigPath, {
		version: 1,
		webSearch: { braveApiKey: "plaintext-project-secret" },
	});
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			await withTemporaryCwd(fixture.cwd, async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd });
				assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
				assert.ok(tool);
				await withFakeFetch(
					(input, init) => {
						assert.equal(
							new URL(input instanceof Request ? input.url : input.toString()).searchParams.get(
								"q",
							),
							"project only",
						);
						assert.equal(
							new Headers(init?.headers).get("X-Subscription-Token"),
							"plaintext-project-secret",
						);
						return new Response(
							JSON.stringify({
								query: { original: "project only" },
								web: {
									results: [
										{
											title: "Project Only",
											url: "https://example.com/project",
											description: "Project result",
										},
									],
								},
							}),
							{ status: 200 },
						);
					},
					async () => {
						const result = await executeRegisteredTool(tool, harness.ctx, {
							query: "project only",
							provider: "brave",
						});
						assert.equal(readRecord(result.details).provider, "brave");
						assert.doesNotMatch(JSON.stringify(result), /plaintext-project-secret/);
					},
				);
			});
		},
	);
});

test("untrusted project web-search config does not register the companion tool on session start", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.projectConfigPath, {
		version: 1,
		webSearch: { braveApiKey: "plaintext-project-secret" },
	});
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			await withTemporaryCwd(fixture.cwd, async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd, projectTrusted: false });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
			});
		},
	);
});

test("project config can disable web-search execution despite env fallback", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { enabled: false } });
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "env-secret",
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			await withTemporaryCwd(fixture.cwd, async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd });
				const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
				assert.ok(tool);
				assert.ok(harness.getTool("agent_browser"));
				const result = await executeRegisteredTool(tool, harness.ctx, {
					query: "disabled project config",
				});
				assert.equal(result.isError, true);
				assert.match(
					JSON.stringify(result.structuredContent),
					/"success":false.*agent_browser_web_search is disabled by pi-agent-browser-native config/,
				);
			});
		},
	);
});

test("project web-search plaintext config passes through at execution without exposing the key", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "env-secret",
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			await withTemporaryCwd(fixture.cwd, async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd });
				const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
				assert.ok(tool);
				await writeJson(fixture.projectConfigPath, {
					version: 1,
					webSearch: { braveApiKey: "plaintext-project-secret" },
				});
				await withFakeFetch(
					(input, init) => {
						const url = new URL(input instanceof Request ? input.url : input.toString());
						assert.equal(
							url.origin + url.pathname,
							"https://api.search.brave.com/res/v1/web/search",
						);
						assert.equal(
							new Headers(init?.headers).get("X-Subscription-Token"),
							"plaintext-project-secret",
						);
						return new Response(
							JSON.stringify({
								query: { original: "must pass through project config" },
								web: {
									results: [
										{
											title: "Project Config",
											url: "https://example.com/project",
											description: "Project result",
										},
									],
								},
							}),
							{ status: 200 },
						);
					},
					async () => {
						const result = await executeRegisteredTool(tool, harness.ctx, {
							query: "must pass through project config",
							provider: "brave",
						});
						assert.equal(readRecord(result.details).provider, "brave");
						assert.doesNotMatch(JSON.stringify(result), /plaintext-project-secret/);
					},
				);
			});
		},
	);
});

test("--no-approve prevents project config from disabling env-backed agent_browser_web_search execution", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { enabled: false } });
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "env-secret",
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			await withTemporaryCwd(fixture.cwd, async () => {
				await withTemporaryArgv(["node", "pi", "--no-approve"], async () => {
					const harness = createExtensionHarness({ cwd: fixture.cwd });
					const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
					assert.ok(tool);
					assert.ok(harness.getTool("agent_browser"));
					await withFakeFetch(
						(input, init) => {
							const url = new URL(input instanceof Request ? input.url : input.toString());
							assert.equal(
								url.origin + url.pathname,
								"https://api.search.brave.com/res/v1/web/search",
							);
							assert.equal(new Headers(init?.headers).get("X-Subscription-Token"), "env-secret");
							return new Response(
								JSON.stringify({
									query: { original: "no-approve execution" },
									web: {
										results: [
											{
												title: "Env Backed Result",
												url: "https://example.com/env",
												description: "Env execution result",
											},
										],
									},
								}),
								{ status: 200 },
							);
						},
						async () => {
							const result = await executeRegisteredTool(tool, harness.ctx, {
								query: "no-approve execution",
								count: 1,
							});
							assert.equal(result.isError, false, JSON.stringify(result));
							assert.equal(readRecord(result.details).provider, "brave");
							assert.match(result.content.at(0)?.text ?? "", /Env Backed Result/);
							assert.doesNotMatch(
								JSON.stringify(result),
								/agent_browser_web_search is disabled by pi-agent-browser-native config/,
							);
						},
					);
				});
			});
		},
	);
});

test("agent_browser_web_search registration and execution ignore project config when project config is not approved", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.projectConfigPath, {
		version: 1,
		webSearch: { enabled: false, preferredProvider: "brave" },
	});
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "brave-secret",
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			await withTemporaryCwd(fixture.cwd, async () => {
				await withTemporaryArgv(["node", "pi", "--approve"], async () => {
					const harness = createExtensionHarness({ cwd: fixture.cwd, projectTrusted: false });
					const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
					assert.ok(tool);
					await withFakeFetch(
						(input, init) => {
							assert.equal(
								input instanceof Request ? input.url : input.toString(),
								"https://api.exa.ai/search",
							);
							assert.equal(new Headers(init?.headers).get("x-api-key"), "exa-secret");
							return new Response(
								JSON.stringify({
									requestId: "req-untrusted",
									results: [
										{ title: "Trusted Exa", url: "https://example.com/exa", text: "Exa result" },
									],
								}),
								{ status: 200 },
							);
						},
						async () => {
							const result = await executeRegisteredTool(tool, harness.ctx, {
								query: "ignore project preference",
								provider: "auto",
								count: 1,
							});
							assert.equal(result.isError, false, JSON.stringify(result));
							assert.equal(readRecord(result.details).provider, "exa");
							assert.match(result.content.at(0)?.text ?? "", /Trusted Exa/);
						},
					);
				});
			});
		},
	);
});

test("registers agent_browser_web_search with actionable search-type and rate-limit guidance", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "test-secret",
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			assert.ok(harness.getTool("agent_browser"));
			const guidelines = await getBrowserInstructions(harness);
			assert.match(guidelines, /Prefer agent_browser_web_search for current or external web facts/);
			assert.match(guidelines, /public search-engine forms/);
			assert.match(guidelines, /anti-bot\/CAPTCHA-gated/);
			assert.match(guidelines, /searchType: deep-lite/);
			assert.match(guidelines, /omit it for everyday lookups/);
			assert.match(guidelines, /Provider rank is not proof of authority/);
			assert.match(guidelines, /primary current docs/);
			assert.match(guidelines, /Exa includeDomains; Brave site:/);
			assert.match(guidelines, /URL aliases/);
			assert.match(guidelines, /after you have a target URL/);
			assert.doesNotMatch(guidelines, /one query, one follow-up max/);
			assert.match(guidelines, /Do not run parallel agent_browser_web_search calls/);
			assert.match(guidelines, /HTTP 429/);
			assert.match(tool.description, /deep-lite/);
			const schemaProperties = readRecord(readRecord(tool.parameters).properties);
			assert.match(
				readString(readRecord(schemaProperties.searchType).description),
				/deep-lite.*4s/,
			);
			assert.match(
				readString(readRecord(schemaProperties.searchType).description),
				/Pass searchType/,
			);
			for (const field of [
				"includeDomains",
				"excludeDomains",
				"category",
				"additionalQueries",
				"highlightsDynamic",
			]) {
				// Every required field in this fixed nonempty schema inventory must be published.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(schemaProperties[field] !== undefined, `missing ${field} from web-search schema`);
			}
			assert.equal(readRecord(schemaProperties.includeDomains).maxItems, 20);
			assert.equal(readRecord(schemaProperties.excludeDomains).maxItems, 20);
			assert.equal(readRecord(schemaProperties.additionalQueries).maxItems, 10);
		},
	);
});

test("auto provider uses Brave when only BRAVE_API_KEY is configured", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "brave-secret",
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await withFakeFetch(
				(input, init) => {
					const url = new URL(input instanceof Request ? input.url : input.toString());
					assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
					assert.equal(url.searchParams.get("q"), "brave only");
					assert.equal(url.searchParams.get("count"), "1");
					assert.equal(url.searchParams.get("offset"), "0");
					assert.equal(url.searchParams.get("country"), "US");
					assert.equal(url.searchParams.get("search_lang"), "en-US");
					assert.equal(url.searchParams.get("safesearch"), "moderate");
					assert.equal(url.searchParams.get("freshness"), "pw");
					assert.equal(new Headers(init?.headers).get("X-Subscription-Token"), "brave-secret");
					return new Response(
						JSON.stringify({
							query: { original: "brave only" },
							web: {
								results: [
									{
										title: "Brave Only",
										url: "https://example.com/brave",
										description: "Brave result",
									},
								],
							},
						}),
						{ status: 200 },
					);
				},
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "brave only",
						provider: "auto",
						count: 1,
						searchType: "deep",
						country: "us",
						searchLang: "en-US",
						safesearch: "moderate",
						freshness: "pw",
					});
					const text = result.content.at(0)?.text ?? "";
					assert.match(text, /Brave web search results/);
					assert.match(text, /Brave Only/);
					assert.equal(readRecord(result.details).provider, "brave");
					assert.equal(readRecord(result.details).searchType, undefined);
					const observation = readRecord(result.structuredContent);
					const observationData = readRecord(observation.data);
					assert.equal(observation.success, true);
					assert.equal(observation.resultCategory, "success");
					assert.equal(observationData.provider, "brave");
					assert.equal(observationData.query, "brave only");
					assert.deepEqual(observationData.results, [
						{ title: "Brave Only", url: "https://example.com/brave", description: "Brave result" },
					]);
					assert.equal(result.isError, false);
					assert.equal(tool.namespace?.name, "browser");
					assert.ok(tool.outputSchema);
					assert.doesNotMatch(JSON.stringify(result), /brave-secret/);
				},
			);
		},
	);
});

test("registers command-sourced config without executing command until search execution", async (t) => {
	const fixture = await createFixture(t);
	const fixtureRoot = dirname(fixture.overrideConfigPath);
	const markerPath = join(fixtureRoot, "credential-command.marker");
	const commandScriptPath = join(fixtureRoot, "credential-command.cjs");
	await writeFile(
		commandScriptPath,
		[
			`require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
			"process.stdout.write('runtime-secret');",
		].join("\n"),
		"utf8",
	);
	await writeJson(fixture.overrideConfigPath, {
		version: 1,
		webSearch: { braveApiKey: `!${process.execPath} ${JSON.stringify(commandScriptPath)}` },
	});
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			assert.equal(
				await pathExists(markerPath),
				false,
				"credential command must not execute during config load or registration",
			);
			await withFakeFetch(
				(input, init) => {
					assert.equal(
						new URL(input instanceof Request ? input.url : input.toString()).searchParams.get("q"),
						"pi browser docs",
					);
					assert.equal(new Headers(init?.headers).get("X-Subscription-Token"), "runtime-secret");
					return new Response(
						JSON.stringify({
							query: { original: "pi browser docs" },
							web: {
								results: [
									{
										title: "Pi Browser",
										url: "https://example.com/pi",
										description: "<b>Docs</b> result",
									},
								],
							},
						}),
						{ status: 200 },
					);
				},
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "pi browser docs",
						count: 1,
					});
					const text = result.content.at(0)?.text ?? "";
					assert.match(text, /Pi Browser/);
					assert.doesNotMatch(JSON.stringify(result), /runtime-secret/);
					assert.equal(readRecord(result.details).provider, "brave");
					assert.equal(
						await pathExists(markerPath),
						true,
						"credential command executes at search execution",
					);
				},
			);
		},
	);
});

test("uses the configured default Exa search type when the call omits it", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await writeJson(fixture.overrideConfigPath, {
				version: 1,
				webSearch: { defaultSearchType: "deep-lite" },
			});
			await withFakeFetch(
				(_input, init) => {
					assert.equal(new Headers(init?.headers).has("Exa-Beta"), false);
					assert.deepEqual(readRecord(JSON.parse(readString(init?.body))), {
						query: "research defaults",
						type: "deep-lite",
						numResults: 1,
						contents: { highlights: true },
						systemPrompt: EXA_SEARCH_SYSTEM_PROMPT,
						additionalQueries: ["second angle"],
					});
					return new Response(
						JSON.stringify({
							requestId: "req-default",
							results: [
								{
									title: "Defaulted",
									url: "https://example.com/default",
									highlights: ["Research result"],
								},
							],
						}),
						{ status: 200 },
					);
				},
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "research defaults",
						count: 1,
						additionalQueries: ["second angle"],
					});
					assert.equal(readRecord(result.details).provider, "exa");
					assert.equal(readRecord(result.details).searchType, "deep-lite");
					assert.equal(readRecord(result.details).requestId, "req-default");
					assert.equal(readRecord(result.details).returnedQuery, "research defaults");
					assert.doesNotMatch(JSON.stringify(result), /exa-secret/);
				},
			);
		},
	);
});

test("per-call Exa search type overrides the configured default and normalizes highlights", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.overrideConfigPath, {
		version: 1,
		webSearch: { defaultSearchType: "deep-lite" },
	});
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: "brave-secret",
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await withFakeFetch(
				(input, init) => {
					assert.equal(
						input instanceof Request ? input.url : input.toString(),
						"https://api.exa.ai/search",
					);
					assert.equal(init?.method, "POST");
					assert.equal(new Headers(init.headers).get("x-api-key"), "exa-secret");
					const body = readRecord(JSON.parse(readString(init.body)));
					assert.equal(body.query, "pi browser docs");
					assert.equal(body.type, "fast");
					assert.equal(body.numResults, 2);
					assert.deepEqual(body.contents, { highlights: { dynamic: true } });
					assert.equal(body.category, "news");
					assert.deepEqual(body.includeDomains, ["example.com"]);
					assert.deepEqual(body.excludeDomains, ["noise.example"]);
					assert.equal(new Headers(init.headers).get("Exa-Beta"), "dynamic-highlights-2026-08-28");
					return new Response(
						JSON.stringify({
							requestId: "req-123",
							searchType: "deep-reasoning",
							results: [
								{ title: "Skipped", url: "https://example.com/skipped", highlights: ["skip"] },
								{
									title: "Exa Pi",
									url: "https://example.com/exa",
									author: "Example",
									publishedDate: "2026-01-01",
									highlights: ["<b>Relevant</b> Exa highlight", "Second highlight"],
								},
							],
						}),
						{ status: 200 },
					);
				},
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "pi browser docs",
						count: 1,
						offset: 1,
						searchType: "fast",
						category: "news",
						includeDomains: ["example.com"],
						excludeDomains: ["noise.example"],
						highlightsDynamic: true,
					});
					const text = result.content.at(0)?.text ?? "";
					assert.match(text, /Exa web search results/);
					assert.match(text, /Relevant Exa highlight/);
					assert.match(text, /Published: 2026-01-01/);
					assert.doesNotMatch(JSON.stringify(result), /exa-secret|brave-secret/);
					assert.equal(readRecord(result.details).provider, "exa");
					assert.equal(readRecord(result.details).searchType, "fast");
					assert.equal(readRecord(result.details).requestId, "req-123");
					assert.equal(readRecord(result.details).returnedQuery, "pi browser docs");
					assert.deepEqual(
						readArray(readRecord(result.details).results).map((item) => readRecord(item).title),
						["Exa Pi"],
					);
				},
			);
		},
	);
});

test("search execution removes exact normalized URL duplicates without collapsing distinct query URLs", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await withFakeFetch(
				(_input, init) => {
					assert.equal(
						readRecord(JSON.parse(readString(init?.body))).systemPrompt,
						EXA_SEARCH_SYSTEM_PROMPT,
					);
					return new Response(
						JSON.stringify({
							results: [
								{ title: "First", url: "https://example.com/docs" },
								{ title: "Duplicate", url: "https://example.com/docs" },
								{ title: "View A", url: "https://example.com/docs?view=a" },
								{ title: "View B", url: "https://example.com/docs?view=b" },
							],
						}),
						{ status: 200 },
					);
				},
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "dedupe docs",
						count: 4,
					});
					const results = readArray(readRecord(result.details).results).map(readRecord);
					assert.deepEqual(
						results.map(({ title, url }) => ({ title, url })),
						[
							{ title: "First", url: "https://example.com/docs" },
							{ title: "View A", url: "https://example.com/docs?view=a" },
							{ title: "View B", url: "https://example.com/docs?view=b" },
						],
					);
					assert.equal(readRecord(result.details).duplicatesRemoved, 1);
					assert.match(result.content.at(0)?.text ?? "", /Duplicate URLs removed: 1/);
				},
			);
		},
	);
});

test("disabled web search config prevents registration despite environment keys", async (t) => {
	const fixture = await createFixture(t);
	await writeJson(fixture.overrideConfigPath, { version: 1, webSearch: { enabled: false } });
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: "brave-secret",
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
		},
	);
});

for (const [count, offset, available, expected] of [
	[5, 0, 20, [1, 2, 3, 4, 5]],
	[5, 5, 20, [6, 7, 8, 9, 10]],
	[5, 3, 20, [4, 5, 6, 7, 8]],
	[10, 9, 20, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]],
	[5, 5, 7, [6, 7]],
	[5, 5, 3, []],
] as const) {
	test(`Brave pagination skips results rather than pages: count ${count}, offset ${offset}, available ${available}`, async (t) => {
		const fixture = await createFixture(t);
		const rankedResults = Array.from({ length: available }, (_, index) => ({
			title: `Result ${index + 1}`,
			url: `https://example.com/${index + 1}`,
		}));
		await withPatchedEnv(
			{
				HOME: fixture.home,
				[AGENT_BROWSER_CONFIG_ENV]: undefined,
				[BRAVE_API_KEY_ENV]: "brave-secret",
				[EXA_API_KEY_ENV]: undefined,
			},
			async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd });
				const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
				assert.ok(tool);
				await withFakeFetch(
					(input) => {
						const url = new URL(input instanceof Request ? input.url : input.toString());
						assert.equal(url.searchParams.get("q"), "pagination");
						assert.equal(url.searchParams.get("count"), String(count + offset));
						assert.equal(url.searchParams.get("offset"), "0");
						return new Response(
							JSON.stringify({
								query: { original: "pagination" },
								web: { results: rankedResults.slice(0, count + offset) },
							}),
						);
					},
					async () => {
						const result = await executeRegisteredTool(tool, harness.ctx, {
							query: "pagination",
							count,
							offset,
						});
						assert.equal(result.isError, false, JSON.stringify(result));
						assert.equal(readRecord(result.details).returnedQuery, "pagination");
						assert.deepEqual(
							readArray(readRecord(result.details).results).map((item) => readRecord(item).title),
							expected.map((rank) => `Result ${rank}`),
						);
					},
				);
			},
		);
	});
}

for (const [searchType, timeoutMs] of [
	["deep-lite", 45_000],
	["deep", 60_000],
	["deep-reasoning", 90_000],
] as const) {
	test(`registered Exa ${searchType} times out at ${timeoutMs}ms`, async (t) => {
		const fixture = await createFixture(t);
		await withPatchedEnv(
			{
				HOME: fixture.home,
				[AGENT_BROWSER_CONFIG_ENV]: undefined,
				[BRAVE_API_KEY_ENV]: undefined,
				[EXA_API_KEY_ENV]: "exa-secret",
			},
			async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd });
				const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
				assert.ok(tool);
				const entered = Promise.withResolvers<AbortSignal>();
				t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
				await withFakeFetch(
					(_input, init) => {
						const signal = init?.signal;
						assert.ok(signal);
						entered.resolve(signal);
						return new Promise<Response>((_resolve, reject) =>
							signal.addEventListener(
								"abort",
								() => {
									const reason: unknown = signal.reason;
									reject(reason instanceof Error ? reason : new Error("Search aborted"));
								},
								{ once: true },
							),
						);
					},
					async () => {
						const pending = executeRegisteredTool(tool, harness.ctx, {
							query: "timeout research",
							searchType,
						});
						const signal = await entered.promise;
						t.mock.timers.tick(timeoutMs - 1);
						assert.equal(signal.aborted, false, "must retain the full provider timeout");
						t.mock.timers.tick(1);
						assert.equal(signal.aborted, true);
						const result = await pending;
						assert.equal(result.isError, true);
						assert.equal(readRecord(result.details).failureCategory, "upstream-error");
						assert.match(readString(readRecord(result.details).error), /Exa search timed out/);
					},
				);
			},
		);
	});
}

test("builds Exa search request body with highlights and provider-compatible options", () => {
	const body = buildExaSearchRequestBody(
		{
			query: "agent browser",
			count: 3,
			offset: 2,
			country: "us",
			safesearch: "moderate",
			freshness: "pd",
			searchType: "deep-lite",
		},
		() => new Date("2026-06-02T00:00:00.000Z"),
	);
	assert.deepEqual(body, {
		query: "agent browser",
		type: "deep-lite",
		numResults: 5,
		contents: { highlights: true },
		systemPrompt: EXA_SEARCH_SYSTEM_PROMPT,
		userLocation: "US",
		moderation: true,
		startPublishedDate: "2026-06-01T00:00:00.000Z",
	});
	assert.equal(buildExaSearchRequestBody({ query: "default", count: 1, offset: 0 }).type, "auto");
});

test("rejects Exa filter combinations the upstream API does not support", () => {
	for (const searchType of ["auto", "fast", "instant"] as const) {
		// Every fixed unsupported Exa type/filter combination must fail before dispatch.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.throws(
			() =>
				buildExaSearchRequestBody({
					query: "agent browser",
					count: 1,
					offset: 0,
					searchType,
					additionalQueries: ["second angle"],
				}),
			new RegExp(
				`additionalQueries requires deep-lite, deep, or deep-reasoning; received ${searchType}`,
			),
		);
	}
	assert.throws(
		() =>
			buildExaSearchRequestBody({
				query: "agent browser",
				count: 1,
				offset: 0,
				category: "company",
				freshness: "pw",
			}),
		/category company cannot be combined with freshness or excludeDomains/,
	);
	assert.throws(
		() =>
			buildExaSearchRequestBody({
				query: "agent browser",
				count: 1,
				offset: 0,
				category: "people",
				excludeDomains: ["example.com"],
			}),
		/category people cannot be combined with freshness or excludeDomains/,
	);
});

test("normalizes Brave results and strips unsafe or noisy values", () => {
	assert.equal(
		decodeHtmlEntities("Pi &amp; browser &#x27;native&#x27; &#40;docs&#41; &AMP; tools"),
		"Pi & browser 'native' (docs) & tools",
	);
	assert.equal(cleanSearchText("<b>Hello</b>   world"), "Hello world");
	assert.equal(
		cleanSearchText("pi --no-extensions -e npm:pkg@&lt;version&gt;"),
		"pi --no-extensions -e npm:pkg@<version>",
	);
	assert.equal(cleanSearchText("&lt;b&gt;Docs&lt;/b&gt; result"), "Docs result");
	assert.equal(
		cleanSearchText(
			"Result &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; safe",
		),
		"Result safe",
	);
	assert.equal(normalizeBraveSearchResult({ title: "Bad", url: "javascript:alert(1)" }), undefined);
	assert.deepEqual(
		normalizeBraveSearchResult({
			title: "<b>Good</b> &amp; useful",
			url: "https://example.com/path",
			description: "One   two &#x27;quoted&#x27;",
			profile: { name: "Example" },
			page_age: "2026-01-02",
		}),
		{
			title: "Good & useful",
			url: "https://example.com/path",
			description: "One two 'quoted'",
			source: "Example",
			age: undefined,
			pageDate: "2026-01-02",
			language: undefined,
		},
	);
	assert.deepEqual(
		normalizeExaSearchResult({
			title: "<b>Exa</b> result",
			url: "https://example.com/exa",
			author: "Example Author",
			publishedDate: "2026-01-01",
			highlights: ["One &amp; two", "<b>Three</b>"],
		}),
		{
			title: "Exa result",
			url: "https://example.com/exa",
			description: "One & two",
			highlights: ["One & two", "Three"],
			source: "Example Author",
			pageDate: "2026-01-01",
		},
	);
});

test("WebSearchRequestGate serializes and spaces searches", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const starts: number[] = [];
	const entered = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();
	const gate = new WebSearchRequestGate();
	const minimumInterval = 1100;
	const first = gate.run(undefined, async () => {
		starts.push(Date.now());
		entered.resolve(undefined);
		await release.promise;
		return "first";
	});
	await entered.promise;
	const second = gate.run(undefined, async () => {
		starts.push(Date.now());
		return "second";
	});
	t.mock.timers.tick(minimumInterval * 2);
	await nextTurn();
	assert.deepEqual(starts, [1000], "second cannot start while the first request remains active");
	release.resolve(undefined);
	assert.equal(await first, "first");
	assert.equal(await second, "second");
	assert.deepEqual(starts, [1000, 1000 + minimumInterval * 2]);
	const failed = assert.rejects(
		gate.run(undefined, async () => {
			starts.push(Date.now());
			throw new Error("provider failed");
		}),
		/provider failed/,
	);
	await nextTurn();
	t.mock.timers.tick(minimumInterval - 1);
	await nextTurn();
	assert.equal(starts.length, 2, "request spacing must not be shortened");
	t.mock.timers.tick(1);
	await failed;
	assert.deepEqual(starts, [1000, 1000 + minimumInterval * 2, 1000 + minimumInterval * 3]);
	const recovered = gate.run(undefined, async () => "recovered");
	await nextTurn();
	t.mock.timers.tick(minimumInterval);
	assert.equal(await recovered, "recovered", "a failed request must release the queue");
});

test("provider fetch helpers do not call fetch when already aborted", async () => {
	await withFakeFetch(
		() => {
			throw new Error("fetch should not be called");
		},
		async () => {
			const braveController = new AbortController();
			braveController.abort(new Error("cancelled before brave"));
			await assert.rejects(
				() =>
					fetchBraveSearchJson(
						new URL("https://api.search.brave.com/res/v1/web/search?q=test"),
						"brave-secret",
						braveController.signal,
					),
				/cancelled before brave/,
			);

			const exaController = new AbortController();
			exaController.abort(new Error("cancelled before exa"));
			await assert.rejects(
				() => fetchExaSearchJson({ query: "test" }, "exa-secret", exaController.signal),
				/cancelled before exa/,
			);
			const primitiveController = new AbortController();
			const primitiveReason = "caller-owned abort reason";
			primitiveController.abort(primitiveReason);
			await assert.rejects(
				() =>
					fetchBraveSearchJson(
						buildBraveSearchUrl({ query: "test", count: 1, offset: 0 }),
						"brave-secret",
						primitiveController.signal,
					),
				(reason: unknown) => {
					assert.equal(reason, primitiveReason);
					return true;
				},
			);
			await assert.rejects(
				() => fetchExaSearchJson({ query: "test" }, "exa-secret", primitiveController.signal),
				(reason: unknown) => {
					assert.equal(reason, primitiveReason);
					return true;
				},
			);
		},
	);
});

test("search execution reports API and JSON failures without leaking key", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: undefined,
			[BRAVE_API_KEY_ENV]: "skey7",
			[EXA_API_KEY_ENV]: "skey7",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			for (const responseBody of ["upstream failed skey7", "upstream failed skey&#55;"]) {
				// The fetch stub is process-global; finish one response case before replacing it.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(responseBody, async () => {
					await withFakeFetch(
						() => new Response(responseBody, { status: 429, statusText: "Too Many Requests" }),
						async () => {
							await assert.rejects(
								() =>
									fetchBraveSearchJson(
										buildBraveSearchUrl({ query: "rate limit", count: 1, offset: 0 }),
										"skey7",
									),
								(error: unknown) => {
									assert.ok(error instanceof Error);
									assert.match(error.message, /Brave search rate limit exceeded \(HTTP 429\)/);
									assert.match(
										error.message,
										/Do not issue parallel or repeated agent_browser_web_search calls/,
									);
									assert.doesNotMatch(error.message, /skey7/);
									return true;
								},
							);
							await assert.rejects(
								() =>
									fetchExaSearchJson(
										{ query: "rate limit", contents: { highlights: true } },
										"skey7",
									),
								(error: unknown) => {
									assert.ok(error instanceof Error);
									assert.match(error.message, /Exa search rate limit exceeded \(HTTP 429\)/);
									assert.match(
										error.message,
										/Do not issue parallel or repeated agent_browser_web_search calls/,
									);
									assert.doesNotMatch(error.message, /skey7/);
									return true;
								},
							);
							const result = await executeRegisteredTool(tool, harness.ctx, {
								query: "rate limit",
								count: 1,
								provider: "brave",
							});
							assert.equal(result.isError, true);
							assert.match(
								JSON.stringify(result.structuredContent),
								/"success":false.*Brave search rate limit exceeded/,
							);
							assert.doesNotMatch(JSON.stringify(result), /skey7/);
						},
					);
				});
				t.mock.timers.setTime(Date.now() + WEB_SEARCH_MIN_REQUEST_INTERVAL_MS);
			}
			for (const provider of ["brave", "exa"] as const) {
				// Each malformed response must finish before replacing the process-global fetch stub.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(`${provider} invalid JSON`, async () => {
					await withFakeFetch(
						() => new Response("skey7", { status: 200 }),
						async () => {
							const fetchJson =
								provider === "brave"
									? () =>
											fetchBraveSearchJson(
												buildBraveSearchUrl({ query: "bad JSON", count: 1, offset: 0 }),
												"skey7",
											)
									: () => fetchExaSearchJson({ query: "bad JSON" }, "skey7");
							await assert.rejects(fetchJson, (error: unknown) => {
								assert.ok(error instanceof Error);
								assert.match(error.message, /search returned invalid JSON/);
								assert.doesNotMatch(
									inspect(error),
									/skey7/,
									"source-bearing causes must not leak either",
								);
								return true;
							});
							const result = await executeRegisteredTool(tool, harness.ctx, {
								query: "bad JSON",
								count: 1,
								provider,
							});
							assert.equal(result.isError, true);
							assert.equal(readRecord(result.structuredContent).success, false);
							assert.match(JSON.stringify(result), /search returned invalid JSON/);
							assert.doesNotMatch(JSON.stringify(result), /skey7/);
						},
					);
				});
				t.mock.timers.setTime(Date.now() + WEB_SEARCH_MIN_REQUEST_INTERVAL_MS);
			}
			for (const { provider, response } of [
				{ provider: "brave", response: { web: { results: "invalid" } } },
				{ provider: "brave", response: { web: { results: [{ profile: [] }] } } },
				{ provider: "exa", response: { results: 42 } },
			]) {
				// Provider cases share the global fetch stub and credential environment.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(`${provider}: ${JSON.stringify(response)}`, async () => {
					await withFakeFetch(
						() => new Response(JSON.stringify(response), { status: 200 }),
						async () => {
							const result = await executeRegisteredTool(tool, harness.ctx, {
								query: "malformed success",
								count: 1,
								provider,
							});
							assert.equal(result.isError, true);
							assert.equal(readRecord(result.details).failureCategory, "upstream-error");
							const observation = readRecord(result.structuredContent);
							assert.equal(observation.success, false);
							assert.equal(observation.resultCategory, "failure");
							assert.match(readString(observation.error), /invalid result structure/i);
							assert.doesNotMatch(JSON.stringify(result), /skey7/);
						},
					);
				});
				t.mock.timers.setTime(Date.now() + WEB_SEARCH_MIN_REQUEST_INTERVAL_MS);
			}
			const controller = new AbortController();
			controller.abort(new Error("cancelled search"));
			await withFakeFetch(
				() => assert.fail("aborted tool must not fetch"),
				async () => {
					const result = await executeRegisteredTool(
						tool,
						harness.ctx,
						{ query: "cancelled", count: 1 },
						controller.signal,
					);
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "aborted");
					assert.match(JSON.stringify(result.structuredContent), /"success":false/);
				},
			);
		},
	);
});

test("large search results keep formatted prose inline and compact only the structured observation", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			const capTitle = "T".repeat(180);
			const capHighlight = "H".repeat(320);
			const results = Array.from({ length: 10 }, (_unused, index) => ({
				title: capTitle,
				url: `https://example.com/result-${index + 1}`,
				author: "Example",
				publishedDate: "2026-01-01",
				highlights: [capHighlight, capHighlight, capHighlight],
			}));
			await withFakeFetch(
				() => new Response(JSON.stringify({ requestId: "req-large", results }), { status: 200 }),
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "large caps",
						count: 10,
					});
					const text = result.content.at(0)?.text ?? "";
					assert.match(text, /Exa web search results for: large caps/);
					assert.ok(text.includes(`10. ${capTitle}`), "last capped result must stay inline");
					assert.doesNotMatch(text, /Browser observation compacted/);
					const structured = readRecord(result.structuredContent);
					assert.equal(structured.compacted, true);
					assert.equal(typeof structured.observationPath, "string");
					const spill = readRecord(
						JSON.parse(await readFile(readString(structured.observationPath), "utf8")),
					);
					assert.equal(readArray(readRecord(spill.data).results).length, 10);
					assert.equal(readArray(readRecord(result.details).results).length, 10);
					const manifest = readRecord(readRecord(result.details).artifactManifest);
					const spillEntry = readArray(manifest.entries)
						.map(readRecord)
						.find((entry) => entry.path === structured.observationPath);
					assert.ok(
						spillEntry,
						"oversized search spill keeps its invocation artifact receipt in details",
					);
					assert.equal(spillEntry.storageScope, "process-temp");
					assert.equal(spillEntry.retentionState, "ephemeral");
					assert.doesNotMatch(JSON.stringify(result), /exa-secret/);
				},
			);
		},
	);
});

test("local validation failures report validation-error while provider failures stay upstream-error", async (t) => {
	const fixture = await createFixture(t);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: undefined,
			[EXA_API_KEY_ENV]: "exa-secret",
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await withFakeFetch(
				() => assert.fail("blank query must not fetch"),
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, { query: "   " });
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "validation-error");
					assert.match(
						JSON.stringify(result.structuredContent),
						/"failureCategory":"validation-error"/,
					);
				},
			);
			await withFakeFetch(
				() => new Response("internal provider error", { status: 500 }),
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "provider down",
						count: 1,
					});
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "upstream-error");
				},
			);
		},
	);
	await withPatchedEnv(
		{
			HOME: fixture.home,
			[AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath,
			[BRAVE_API_KEY_ENV]: "brave-secret",
			[EXA_API_KEY_ENV]: undefined,
		},
		async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await withFakeFetch(
				() => assert.fail("exa-only filters must fail before a Brave request"),
				async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, {
						query: "exa filters",
						includeDomains: ["example.com"],
					});
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "validation-error");
					assert.match(
						JSON.stringify(result.structuredContent),
						/"success":false.*includeDomains requires provider exa; resolved provider was brave/,
					);
				},
			);
		},
	);
});
