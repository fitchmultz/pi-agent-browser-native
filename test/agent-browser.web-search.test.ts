/**
 * Purpose: Verify optional Exa/Brave-backed agent_browser_web_search registration, request shaping, result normalization, and secret redaction.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

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
	getWebSearchProviderAdapter,
	normalizeExaSearchResult,
	normalizeBraveSearchResult,
} from "../extensions/agent-browser/lib/web-search.js";
import { createExtensionHarness, executeRegisteredTool, runExtensionEvent, withPatchedEnv } from "./helpers/agent-browser-harness.js";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withFakeFetch<T>(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response, run: () => Promise<T>): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (input, init) => Promise.resolve(handler(input, init));
	try {
		return await run();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-web-search-test-"));
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

async function withTemporaryArgv<T>(argv: string[], run: () => Promise<T>): Promise<T> {
	const previousArgv = process.argv;
	process.argv = argv;
	try {
		return await run();
	} finally {
		process.argv = previousArgv;
	}
}

test("does not register agent_browser_web_search without env or config credential", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
		assert.equal(harness.getTool("agent_browser")?.promptGuidelines.includes("Use agent_browser for real browser or live web content."), true);
	});
});

test("trusted project web-search config registers the companion tool on session start", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { braveApiKey: "plaintext-project-secret" } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: undefined }, async () => {
		await withTemporaryCwd(fixture.cwd, async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await withFakeFetch((input, init) => {
				assert.equal(new URL(String(input)).searchParams.get("q"), "project only");
				assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Subscription-Token"], "plaintext-project-secret");
				return new Response(JSON.stringify({
					query: { original: "project only" },
					web: { results: [{ title: "Project Only", url: "https://example.com/project", description: "Project result" }] },
				}), { status: 200 });
			}, async () => {
				const result = await executeRegisteredTool(tool, harness.ctx, { query: "project only", provider: "brave" });
				assert.equal(result.details?.provider, "brave");
				assert.doesNotMatch(JSON.stringify(result), /plaintext-project-secret/);
			});
		});
	});
});

test("untrusted project web-search config does not register the companion tool on session start", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { braveApiKey: "plaintext-project-secret" } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: undefined }, async () => {
		await withTemporaryCwd(fixture.cwd, async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd, projectTrusted: false });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
		});
	});
});

test("project config can disable web-search execution despite env fallback", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { enabled: false } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "env-secret", [EXA_API_KEY_ENV]: undefined }, async () => {
		await withTemporaryCwd(fixture.cwd, async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			assert.ok(harness.getTool("agent_browser"));
			await assert.rejects(
				() => executeRegisteredTool(tool, harness.ctx, { query: "disabled project config" }),
				/agent_browser_web_search is disabled by pi-agent-browser-native config/,
			);
		});
	});
});

test("project web-search plaintext config passes through at execution without exposing the key", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "env-secret", [EXA_API_KEY_ENV]: undefined }, async () => {
		await withTemporaryCwd(fixture.cwd, async () => {
			const harness = createExtensionHarness({ cwd: fixture.cwd });
			const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
			assert.ok(tool);
			await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { braveApiKey: "plaintext-project-secret" } });
			await withFakeFetch((input, init) => {
				const url = new URL(String(input));
				assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
				assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Subscription-Token"], "plaintext-project-secret");
				return new Response(JSON.stringify({
					query: { original: "must pass through project config" },
					web: { results: [{ title: "Project Config", url: "https://example.com/project", description: "Project result" }] },
				}), { status: 200 });
			}, async () => {
				const result = await executeRegisteredTool(tool, harness.ctx, { query: "must pass through project config", provider: "brave" });
				assert.equal(result.details?.provider, "brave");
				assert.doesNotMatch(JSON.stringify(result), /plaintext-project-secret/);
			});
		});
	});
});

test("--no-approve prevents project config from disabling env-backed agent_browser_web_search execution", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { enabled: false } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "env-secret", [EXA_API_KEY_ENV]: undefined }, async () => {
		await withTemporaryCwd(fixture.cwd, async () => {
			await withTemporaryArgv(["node", "pi", "--no-approve"], async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd });
				assert.ok(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME));
				assert.ok(harness.getTool("agent_browser"));
			});
		});
	});
});

test("agent_browser_web_search registration and execution ignore project config when project config is not approved", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.projectConfigPath, { version: 1, webSearch: { enabled: false, preferredProvider: "brave" } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "brave-secret", [EXA_API_KEY_ENV]: "exa-secret" }, async () => {
		await withTemporaryCwd(fixture.cwd, async () => {
			await withTemporaryArgv(["node", "pi", "--no-approve"], async () => {
				const harness = createExtensionHarness({ cwd: fixture.cwd, projectTrusted: false });
				const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
				assert.ok(tool);
				await withFakeFetch((input, init) => {
					assert.equal(String(input), "https://api.exa.ai/search");
					assert.equal(init?.headers && (init.headers as Record<string, string>)["x-api-key"], "exa-secret");
					return new Response(JSON.stringify({ requestId: "req-untrusted", results: [{ title: "Trusted Exa", url: "https://example.com/exa", text: "Exa result" }] }), { status: 200 });
				}, async () => {
					const result = await executeRegisteredTool(tool, harness.ctx, { query: "ignore project preference", provider: "auto", count: 1 });
					assert.equal(result.details?.provider, "exa");
				});
			});
		});
	});
});

test("registers agent_browser_web_search with actionable search-type and rate-limit guidance", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "test-secret", [EXA_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		assert.ok(harness.getTool("agent_browser"));
		const guidelines = tool.promptGuidelines.join("\n");
		assert.match(guidelines, /Prefer agent_browser_web_search for current or external web facts/);
		assert.match(guidelines, /searchType.*deep-lite/);
		assert.match(guidelines, /Do not run parallel agent_browser_web_search calls/);
		assert.match(guidelines, /HTTP 429/);
		assert.match(tool.description, /deep-lite/);
		const schema = tool.parameters as { properties?: Record<string, { description?: string; maxItems?: number }> };
		assert.match(schema.properties?.searchType?.description ?? "", /deep-lite.*4s/);
		assert.match(schema.properties?.searchType?.description ?? "", /Pass searchType/);
		for (const field of ["includeDomains", "excludeDomains", "category", "additionalQueries", "highlightsDynamic"]) {
			assert.ok(schema.properties?.[field], `missing ${field} from web-search schema`);
		}
		assert.equal(schema.properties?.includeDomains?.maxItems, 20);
		assert.equal(schema.properties?.excludeDomains?.maxItems, 20);
		assert.equal(schema.properties?.additionalQueries?.maxItems, 10);
	});
});

test("auto provider uses Brave when only BRAVE_API_KEY is configured", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "brave-secret", [EXA_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		await withFakeFetch((input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
			assert.equal(url.searchParams.get("q"), "brave only");
			assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Subscription-Token"], "brave-secret");
			return new Response(JSON.stringify({
				query: { original: "brave only" },
				web: { results: [{ title: "Brave Only", url: "https://example.com/brave", description: "Brave result" }] },
			}), { status: 200 });
		}, async () => {
			const result = await executeRegisteredTool(tool, harness.ctx, { query: "brave only", provider: "auto", count: 1, searchType: "deep" });
			const text = result.content[0]?.text ?? "";
			assert.match(text, /Brave web search results/);
			assert.match(text, /Brave Only/);
			assert.equal(result.details?.provider, "brave");
			assert.equal(result.details?.searchType, undefined);
			assert.doesNotMatch(JSON.stringify(result), /brave-secret/);
		});
	});
});

test("rejects explicit Exa-only filters when Brave is the resolved provider", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "brave-secret", [EXA_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		await withFakeFetch(() => {
			throw new Error("fetch should not be called");
		}, async () => {
			await assert.rejects(
				() => executeRegisteredTool(tool, harness.ctx, { query: "official docs", includeDomains: ["example.com"] }),
				/includeDomains requires provider exa; resolved provider was brave/,
			);
		});
	});
});

test("registers command-sourced config without executing command until search execution", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.overrideConfigPath, {
		version: 1,
		webSearch: { braveApiKey: `!${process.execPath} -e "process.stdout.write('runtime-secret')"` },
	});
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		await withFakeFetch((input, init) => {
			assert.equal(new URL(String(input)).searchParams.get("q"), "pi browser docs");
			assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Subscription-Token"], "runtime-secret");
			return new Response(JSON.stringify({
				query: { original: "pi browser docs" },
				web: { results: [{ title: "Pi Browser", url: "https://example.com/pi", description: "<b>Docs</b> result" }] },
			}), { status: 200 });
		}, async () => {
			const result = await executeRegisteredTool(tool, harness.ctx, { query: "pi browser docs", count: 1 });
			const text = result.content[0]?.text ?? "";
			assert.match(text, /Pi Browser/);
			assert.doesNotMatch(JSON.stringify(result), /runtime-secret/);
			assert.equal(result.details?.provider, "brave");
		});
	});
});

test("uses the configured default Exa search type when the call omits it", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: "exa-secret" }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		await writeJson(fixture.overrideConfigPath, { version: 1, webSearch: { defaultSearchType: "deep-lite" } });
		await withFakeFetch((_input, init) => {
			assert.equal(new Headers(init?.headers).has("Exa-Beta"), false);
			assert.deepEqual(JSON.parse(String(init?.body)), {
				query: "research defaults",
				type: "deep-lite",
				numResults: 1,
				contents: { highlights: true },
				systemPrompt: EXA_SEARCH_SYSTEM_PROMPT,
				additionalQueries: ["second angle"],
			});
			return new Response(JSON.stringify({ requestId: "req-default", results: [{ title: "Defaulted", url: "https://example.com/default", highlights: ["Research result"] }] }), { status: 200 });
		}, async () => {
			const result = await executeRegisteredTool(tool, harness.ctx, { query: "research defaults", count: 1, additionalQueries: ["second angle"] });
			assert.equal(result.details?.provider, "exa");
			assert.equal(result.details?.searchType, "deep-lite");
			assert.equal(result.details?.requestId, "req-default");
			assert.doesNotMatch(JSON.stringify(result), /exa-secret/);
		});
	});
});

test("per-call Exa search type overrides the configured default and normalizes highlights", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.overrideConfigPath, { version: 1, webSearch: { defaultSearchType: "deep-lite" } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath, [BRAVE_API_KEY_ENV]: "brave-secret", [EXA_API_KEY_ENV]: "exa-secret" }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		await withFakeFetch((input, init) => {
			assert.equal(String(input), "https://api.exa.ai/search");
			assert.equal(init?.method, "POST");
			assert.equal(init?.headers && (init.headers as Record<string, string>)["x-api-key"], "exa-secret");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.query, "pi browser docs");
			assert.equal(body.type, "fast");
			assert.equal(body.numResults, 2);
			assert.deepEqual(body.contents, { highlights: { dynamic: true } });
			assert.equal(body.category, "news");
			assert.deepEqual(body.includeDomains, ["example.com"]);
			assert.deepEqual(body.excludeDomains, ["noise.example"]);
			assert.equal(new Headers(init?.headers).get("Exa-Beta"), "dynamic-highlights-2026-08-28");
			return new Response(JSON.stringify({
				requestId: "req-123",
				searchType: "deep-reasoning",
				results: [
					{ title: "Skipped", url: "https://example.com/skipped", highlights: ["skip"] },
					{ title: "Exa Pi", url: "https://example.com/exa", author: "Example", publishedDate: "2026-01-01", highlights: ["<b>Relevant</b> Exa highlight", "Second highlight"] },
				],
			}), { status: 200 });
		}, async () => {
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
			const text = result.content[0]?.text ?? "";
			assert.match(text, /Exa web search results/);
			assert.match(text, /Relevant Exa highlight/);
			assert.match(text, /Published: 2026-01-01/);
			assert.doesNotMatch(JSON.stringify(result), /exa-secret|brave-secret/);
			assert.equal(result.details?.provider, "exa");
			assert.equal(result.details?.searchType, "fast");
			assert.equal(result.details?.requestId, "req-123");
		});
	});
});

test("search execution removes exact normalized URL duplicates without collapsing distinct query URLs", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath, [BRAVE_API_KEY_ENV]: undefined, [EXA_API_KEY_ENV]: "exa-secret" }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		await withFakeFetch((_input, init) => {
			assert.equal(JSON.parse(String(init?.body)).systemPrompt, EXA_SEARCH_SYSTEM_PROMPT);
			return new Response(JSON.stringify({ results: [
				{ title: "First", url: "https://example.com/docs" },
				{ title: "Duplicate", url: "https://example.com/docs" },
				{ title: "View A", url: "https://example.com/docs?view=a" },
				{ title: "View B", url: "https://example.com/docs?view=b" },
			] }), { status: 200 });
		}, async () => {
			const result = await executeRegisteredTool(tool, harness.ctx, { query: "dedupe docs", count: 4 });
			const results = result.details?.results as Array<{ title?: string; url?: string }>;
			assert.deepEqual(results.map(({ title, url }) => ({ title, url })), [
				{ title: "First", url: "https://example.com/docs" },
				{ title: "View A", url: "https://example.com/docs?view=a" },
				{ title: "View B", url: "https://example.com/docs?view=b" },
			]);
			assert.equal(result.details?.duplicatesRemoved, 1);
			assert.match(result.content[0]?.text ?? "", /Duplicate URLs removed: 1/);
		});
	});
});

test("provider adapters expose provider-agnostic request and normalization contracts", () => {
	const brave = getWebSearchProviderAdapter("brave");
	const braveRequest = brave.buildRequest({ count: 1, offset: 2, query: "adapter brave" });
	assert.ok(braveRequest instanceof URL);
	assert.equal(braveRequest.searchParams.get("q"), "adapter brave");
	const braveNormalized = brave.normalizeResponse({ query: { original: "adapter brave" }, web: { results: [{ title: "Brave", url: "https://example.com/brave" }] } }, { count: 1, offset: 2, query: "adapter brave" });
	assert.equal(braveNormalized.returnedQuery, "adapter brave");
	assert.deepEqual(braveNormalized.results.map((result) => result.title), ["Brave"]);

	const exa = getWebSearchProviderAdapter("exa");
	const exaRequest = exa.buildRequest({ count: 1, offset: 1, query: "adapter exa", searchType: "deep" }) as { body: Record<string, unknown>; timeoutMs: number };
	assert.equal(exaRequest.body.query, "adapter exa");
	assert.equal(exaRequest.body.type, "deep");
	assert.equal(exaRequest.timeoutMs, 60_000);
	const deepLiteRequest = exa.buildRequest({ count: 1, offset: 0, query: "adapter exa", searchType: "deep-lite" }) as { timeoutMs: number };
	const deepReasoningRequest = exa.buildRequest({ count: 1, offset: 0, query: "adapter exa", searchType: "deep-reasoning" }) as { timeoutMs: number };
	assert.equal(deepLiteRequest.timeoutMs, 45_000);
	assert.equal(deepReasoningRequest.timeoutMs, 90_000);
	const exaNormalized = exa.normalizeResponse({ requestId: "req", searchType: "deep", results: [{ title: "Skip", url: "https://example.com/skip" }, { title: "Exa", url: "https://example.com/exa" }] }, { count: 1, offset: 1, query: "adapter exa", searchType: "deep" });
	assert.equal(exaNormalized.returnedQuery, "adapter exa");
	assert.equal(exaNormalized.extraDetails?.requestId, "req");
	assert.deepEqual(exaNormalized.results.map((result) => result.title), ["Exa"]);
});

test("disabled web search config prevents registration despite environment keys", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.overrideConfigPath, { version: 1, webSearch: { enabled: false } });
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath, [BRAVE_API_KEY_ENV]: "brave-secret", [EXA_API_KEY_ENV]: "exa-secret" }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
	});
});

test("builds Brave search URL parameters", () => {
	const url = buildBraveSearchUrl({
		query: "agent browser",
		count: 3,
		offset: 2,
		country: "us",
		searchLang: "en-US",
		safesearch: "moderate",
		freshness: "pw",
	});
	assert.equal(url.searchParams.get("q"), "agent browser");
	assert.equal(url.searchParams.get("count"), "3");
	assert.equal(url.searchParams.get("offset"), "2");
	assert.equal(url.searchParams.get("country"), "US");
	assert.equal(url.searchParams.get("search_lang"), "en-US");
	assert.equal(url.searchParams.get("safesearch"), "moderate");
	assert.equal(url.searchParams.get("freshness"), "pw");
});

test("builds Exa search request body with highlights and provider-compatible options", () => {
	const body = buildExaSearchRequestBody({
		query: "agent browser",
		count: 3,
		offset: 2,
		country: "us",
		safesearch: "moderate",
		freshness: "pd",
		searchType: "deep-lite",
	}, () => new Date("2026-06-02T00:00:00.000Z"));
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
		assert.throws(
			() => buildExaSearchRequestBody({ query: "agent browser", count: 1, offset: 0, searchType, additionalQueries: ["second angle"] }),
			new RegExp(`additionalQueries requires deep-lite, deep, or deep-reasoning; received ${searchType}`),
		);
	}
	assert.throws(
		() => buildExaSearchRequestBody({ query: "agent browser", count: 1, offset: 0, category: "company", freshness: "pw" }),
		/category company cannot be combined with freshness or excludeDomains/,
	);
	assert.throws(
		() => buildExaSearchRequestBody({ query: "agent browser", count: 1, offset: 0, category: "people", excludeDomains: ["example.com"] }),
		/category people cannot be combined with freshness or excludeDomains/,
	);
});

test("normalizes Brave results and strips unsafe or noisy values", () => {
	assert.equal(decodeHtmlEntities("Pi &amp; browser &#x27;native&#x27; &#40;docs&#41; &AMP; tools"), "Pi & browser 'native' (docs) & tools");
	assert.equal(cleanSearchText("<b>Hello</b>   world"), "Hello world");
	assert.equal(cleanSearchText("pi --no-extensions -e npm:pkg@&lt;version&gt;"), "pi --no-extensions -e npm:pkg@<version>");
	assert.equal(cleanSearchText("&lt;b&gt;Docs&lt;/b&gt; result"), "Docs result");
	assert.equal(cleanSearchText("Result &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; safe"), "Result safe");
	assert.equal(normalizeBraveSearchResult({ title: "Bad", url: "javascript:alert(1)" }), undefined);
	assert.deepEqual(normalizeBraveSearchResult({
		title: "<b>Good</b> &amp; useful",
		url: "https://example.com/path",
		description: "One   two &#x27;quoted&#x27;",
		profile: { name: "Example" },
		page_age: "2026-01-02",
	}), {
		title: "Good & useful",
		url: "https://example.com/path",
		description: "One two 'quoted'",
		source: "Example",
		age: undefined,
		pageDate: "2026-01-02",
		language: undefined,
	});
	assert.deepEqual(normalizeExaSearchResult({
		title: "<b>Exa</b> result",
		url: "https://example.com/exa",
		author: "Example Author",
		publishedDate: "2026-01-01",
		highlights: ["One &amp; two", "<b>Three</b>"],
	}), {
		title: "Exa result",
		url: "https://example.com/exa",
		description: "One & two",
		highlights: ["One & two", "Three"],
		source: "Example Author",
		pageDate: "2026-01-01",
	});
});

test("WebSearchRequestGate serializes and spaces searches", async () => {
	let now = 1_000;
	const waits: number[] = [];
	const starts: number[] = [];
	const gate = new WebSearchRequestGate(
		() => now,
		async (ms) => {
			waits.push(ms);
			now += ms;
		},
	);

	const first = gate.run(undefined, async () => {
		starts.push(now);
		return "first";
	});
	const second = gate.run(undefined, async () => {
		starts.push(now);
		return "second";
	});

	assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
	assert.deepEqual(starts, [1_000, 1_000 + WEB_SEARCH_MIN_REQUEST_INTERVAL_MS]);
	assert.deepEqual(waits, [WEB_SEARCH_MIN_REQUEST_INTERVAL_MS]);
});

test("provider fetch helpers do not call fetch when already aborted", async () => {
	await withFakeFetch(() => {
		throw new Error("fetch should not be called");
	}, async () => {
		const braveController = new AbortController();
		braveController.abort(new Error("cancelled before brave"));
		await assert.rejects(
			() => fetchBraveSearchJson(new URL("https://api.search.brave.com/res/v1/web/search?q=test"), "brave-secret", braveController.signal),
			/cancelled before brave/,
		);

		const exaController = new AbortController();
		exaController.abort(new Error("cancelled before exa"));
		await assert.rejects(
			() => fetchExaSearchJson({ query: "test" }, "exa-secret", exaController.signal),
			/cancelled before exa/,
		);
	});
});

test("search execution reports API and JSON failures without leaking key", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "secret-that-must-not-leak", [EXA_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		for (const responseBody of ["upstream failed secret-that-must-not-leak", "upstream failed secret&#45;that&#45;must&#45;not&#45;leak"]) {
			await withFakeFetch(() => new Response(responseBody, { status: 429, statusText: "Too Many Requests" }), async () => {
				await assert.rejects(
					() => fetchBraveSearchJson(buildBraveSearchUrl({ query: "rate limit", count: 1, offset: 0 }), "secret-that-must-not-leak"),
					(error: Error) => {
						assert.match(error.message, /Brave search rate limit exceeded \(HTTP 429\)/);
						assert.match(error.message, /Do not issue parallel or repeated agent_browser_web_search calls/);
						assert.doesNotMatch(error.message, /secret-that-must-not-leak/);
						return true;
					},
				);
				await assert.rejects(
					() => fetchExaSearchJson({ query: "rate limit", contents: { highlights: true } }, "secret-that-must-not-leak"),
					(error: Error) => {
						assert.match(error.message, /Exa search rate limit exceeded \(HTTP 429\)/);
						assert.match(error.message, /Do not issue parallel or repeated agent_browser_web_search calls/);
						assert.doesNotMatch(error.message, /secret-that-must-not-leak/);
						return true;
					},
				);
			});
		}
	});
});
