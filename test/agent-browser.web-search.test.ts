/**
 * Purpose: Verify optional Brave-backed agent_browser_web_search registration, request shaping, result normalization, and secret redaction.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	AGENT_BROWSER_CONFIG_ENV,
	BRAVE_API_KEY_ENV,
} from "../extensions/agent-browser/lib/config.js";
import {
	AGENT_BROWSER_WEB_SEARCH_TOOL_NAME,
	buildBraveSearchUrl,
	cleanSearchText,
	decodeHtmlEntities,
	normalizeSearchResult,
} from "../extensions/agent-browser/lib/web-search.js";
import { createExtensionHarness, executeRegisteredTool, withPatchedEnv } from "./helpers/agent-browser-harness.js";

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
	};
}

test("does not register agent_browser_web_search without env or config credential", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		assert.equal(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME), undefined);
		assert.ok(harness.getTool("agent_browser"));
	});
});

test("registers agent_browser_web_search with env fallback", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "test-secret" }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		assert.ok(harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME));
		assert.ok(harness.getTool("agent_browser"));
	});
});

test("registers command-sourced config without executing command until search execution", async () => {
	const fixture = await createFixture();
	await writeJson(fixture.overrideConfigPath, {
		version: 1,
		webSearch: { braveApiKey: `!${process.execPath} -e "process.stdout.write('runtime-secret')"` },
	});
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: fixture.overrideConfigPath, [BRAVE_API_KEY_ENV]: undefined }, async () => {
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

test("normalizes Brave results and strips unsafe or noisy values", () => {
	assert.equal(decodeHtmlEntities("Pi &amp; browser &#x27;native&#x27; &#40;docs&#41; &AMP; tools"), "Pi & browser 'native' (docs) & tools");
	assert.equal(cleanSearchText("<b>Hello</b>   world"), "Hello world");
	assert.equal(cleanSearchText("pi --no-extensions -e npm:pkg@&lt;version&gt;"), "pi --no-extensions -e npm:pkg@<version>");
	assert.equal(cleanSearchText("&lt;b&gt;Docs&lt;/b&gt; result"), "Docs result");
	assert.equal(cleanSearchText("Result &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; safe"), "Result safe");
	assert.equal(normalizeSearchResult({ title: "Bad", url: "javascript:alert(1)" }), undefined);
	assert.deepEqual(normalizeSearchResult({
		title: "<b>Good</b> &amp; useful",
		url: "https://example.com/path",
		description: "One   two &#x27;quoted&#x27;",
		profile: { name: "Example" },
	}), {
		title: "Good & useful",
		url: "https://example.com/path",
		description: "One two 'quoted'",
		source: "Example",
		age: undefined,
		language: undefined,
	});
});

test("search execution reports API and JSON failures without leaking key", async () => {
	const fixture = await createFixture();
	await withPatchedEnv({ HOME: fixture.home, [AGENT_BROWSER_CONFIG_ENV]: undefined, [BRAVE_API_KEY_ENV]: "secret-that-must-not-leak" }, async () => {
		const harness = createExtensionHarness({ cwd: fixture.cwd });
		const tool = harness.getTool(AGENT_BROWSER_WEB_SEARCH_TOOL_NAME);
		assert.ok(tool);
		for (const responseBody of ["upstream failed secret-that-must-not-leak", "upstream failed secret&#45;that&#45;must&#45;not&#45;leak"]) {
			await withFakeFetch(() => new Response(responseBody, { status: 429, statusText: "Too Many Requests" }), async () => {
				await assert.rejects(
					() => executeRegisteredTool(tool, harness.ctx, { query: "rate limit" }),
					(error: Error) => {
						assert.match(error.message, /HTTP 429/);
						assert.doesNotMatch(error.message, /secret-that-must-not-leak/);
						return true;
					},
				);
			});
		}
	});
});
