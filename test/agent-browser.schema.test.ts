/**
 * Purpose: Guard public agent_browser tool schema compatibility while production startup uses lightweight JSON-schema builders.
 * Responsibilities: Independently validate public input constraints and native Pi null normalization.
 * Scope: Schema and semantic compiler agreement; browser behavior remains in extension input-mode tests.
 */

import assert from "node:assert/strict";
import { readRecord } from "./helpers/assertions.js";
import { test } from "node:test";

import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";

import {
	createAgentBrowserParamsSchema,
	createAgentBrowserCodeParamsSchema,
	createAgentBrowserActionParamsSchema,
	createAgentBrowserQaParamsSchema,
	createAgentBrowserElectronParamsSchema,
	createAgentBrowserSourceParamsSchema,
	createAgentBrowserNetworkSourceParamsSchema,
	createAgentBrowserToolsParamsSchema,
} from "../extensions/agent-browser/lib/input-modes/params.js";
import { compileAgentBrowserSemanticAction } from "../extensions/agent-browser/lib/input-modes/semantic-action.js";
import { AGENT_BROWSER_SEMANTIC_LOCATORS } from "../extensions/agent-browser/lib/input-modes/types.js";
import { createAgentBrowserWebSearchParamsSchema } from "../extensions/agent-browser/lib/web-search.js";

test("agent_browser exposes only compact native command input", async (t) => {
	const schema = createAgentBrowserParamsSchema();
	const properties = readRecord(readRecord(schema).properties);
	assert.ok(Object.keys(properties).length > 0);
	assert.deepEqual(Object.keys(properties).sort(), [
		"args",
		"outputPath",
		"sessionMode",
		"stdin",
		"timeoutMs",
	]);
	assert.equal(Check(schema, { args: ["batch", "--bail"], stdin: '[["get","title"]]' }), true);
	assert.equal(Check(schema, {}), false);
	for (const input of [
		{ args: [] },
		{ args: [42] },
		{ args: ["get", "url"], timeoutMs: 0 },
		{ args: ["get", "url"], timeoutMs: 1.5 },
		{ args: ["get", "url"], outputPath: "" },
		{ args: ["get", "url"], sessionMode: "reuse" },
	]) {
		// Each fixed malformed public command input must fail schema validation.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(Check(schema, input), false, JSON.stringify(input));
	}
	const sessionMode = readRecord(properties.sessionMode);
	assert.equal(sessionMode.default, "auto");
	assert.equal(Check(schema, { args: ["get", "url"], sessionMode: sessionMode.default }), true);
	for (const mode of [
		"script",
		"job",
		"semanticAction",
		"qa",
		"electron",
		"sourceLookup",
		"networkSourceLookup",
	]) {
		// Each legacy mode is an independent negative-schema case.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(mode, () => {
			assert.equal(Check(schema, { args: ["get", "url"], [mode]: {} }), false, mode);
		});
	}
	assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 1400);
});

test("semantic schema normalizes every optional null through Pi before compilation", async (t) => {
	const schema = createAgentBrowserActionParamsSchema();
	const tool = { name: "agent_browser_action", description: "Browser", parameters: schema };
	for (const field of [
		"locator",
		"value",
		"values",
		"selector",
		"text",
		"role",
		"name",
		"session",
	]) {
		// Each public optional field must survive native SDK normalization independently.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(field, () => {
			const base: Readonly<Record<string, string>> =
				field === "selector"
					? { action: "click", locator: "text", value: "Target" }
					: { action: "click", selector: "#target" };
			const args =
				field === "selector" ? ["find", "text", "Target", "click"] : ["click", "#target"];
			assert.equal(Check(schema, base), true);
			const validated: unknown = validateToolArguments(tool, {
				type: "toolCall",
				id: "null",
				name: tool.name,
				arguments: { ...base, [field]: null },
			});
			assert.deepEqual(validated, base);
			assert.deepEqual(compileAgentBrowserSemanticAction(validated).compiled?.args, args);
		});
	}
});

test("semantic schema rejects non-select values and select text like the compiler", async (t) => {
	const schema = createAgentBrowserActionParamsSchema();
	for (const action of ["check", "click", "fill"]) {
		// These action schemas are independent negative input cases.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(action, () => {
			const semanticAction = {
				action,
				selector: "#target",
				values: ["nope"],
				...(action === "fill" ? { text: "query" } : {}),
			};
			assert.match(
				compileAgentBrowserSemanticAction(semanticAction).error ?? "",
				/values is only supported for select/,
			);
			assert.equal(Check(schema, semanticAction), false, JSON.stringify(semanticAction));
		});
	}
	const semanticAction = {
		action: "select",
		selector: "#flavor",
		value: "chocolate",
		text: "ignored",
	};
	assert.match(
		compileAgentBrowserSemanticAction(semanticAction).error ?? "",
		/text is not supported for select/,
	);
	assert.equal(Check(schema, semanticAction), false);
	for (const input of [
		{ action: "unknown", selector: "#target" },
		{ action: "click", locator: "unknown", value: "Target" },
		{ action: "select", selector: "#flavor", values: [] },
		{ action: "select", selector: "#flavor", values: [42] },
	]) {
		// Each independent action/locator/option violation must fail the public action schema.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(Check(schema, input), false, JSON.stringify(input));
	}
});

test("semantic schema keeps supported locators, role aliases, selectors and select options", () => {
	const schema = createAgentBrowserActionParamsSchema();
	const tool = { name: "agent_browser_action", description: "Browser", parameters: schema };
	const [providerTool] = convertResponsesTools([tool]);
	assert.equal(providerTool.type, "function");
	assert.equal(providerTool.strict, false);
	assert.deepEqual(providerTool.parameters, schema);
	function accepts(semanticAction: Readonly<Record<string, unknown>>, args: readonly string[]) {
		for (const session of [undefined, "schema-session"]) {
			const input = { ...semanticAction, ...(session !== undefined ? { session } : {}) };
			// Both fixed implicit/explicit session variants must validate.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(Check(schema, input), true, JSON.stringify(input));
			const validated: unknown = validateToolArguments(tool, {
				type: "toolCall",
				id: "schema",
				name: tool.name,
				arguments: input,
			});
			// Both fixed implicit/explicit session variants must preserve the validated input.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(validated, input);
			const result = compileAgentBrowserSemanticAction(validated);
			// Every variant must compile without an error.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(result.error, undefined, JSON.stringify(input));
			// Every variant must differ only by its expected session prefix.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(result.compiled?.args, [
				...(session !== undefined ? ["--session", session] : []),
				...args,
			]);
		}
	}
	for (const action of ["check", "click", "fill"]) {
		const text = action === "fill" ? { text: "query" } : {};
		const tail = action === "fill" ? ["query"] : [];
		for (const selector of ["#target", "@e1"]) {
			accepts({ action, selector, ...text }, [action, selector, ...tail]);
		}
		for (const locator of AGENT_BROWSER_SEMANTIC_LOCATORS) {
			accepts({ action, locator, value: "target", ...text }, [
				"find",
				locator,
				"target",
				action,
				...tail,
			]);
		}
		for (const alias of [
			{ role: "button" },
			{ value: "button" },
			{ role: "button", value: "button" },
		]) {
			accepts({ action, locator: "role", ...alias, name: "Open", ...text }, [
				"find",
				"role",
				"button",
				action,
				...tail,
				"--name",
				"Open",
			]);
		}
		accepts({ action, locator: "role", role: "button", name: "", ...text }, [
			"find",
			"role",
			"button",
			action,
			...tail,
		]);
	}
	for (const options of [
		{ value: "chocolate" },
		{ values: ["chocolate"] },
		{ values: ["chocolate", "vanilla"] },
	]) {
		const values = options.values ?? [options.value];
		for (const selector of ["#flavor", "@e2"]) {
			accepts({ action: "select", selector, ...options }, ["select", selector, ...values]);
		}
		for (const role of ["combobox", "listbox", "COMBOBOX"]) {
			accepts({ action: "select", locator: "role", role, name: "Flavor", ...options }, [
				"find",
				"role",
				role,
				"select",
				...values,
				"--name",
				"Flavor",
			]);
		}
		accepts({ action: "select", locator: "label", value: "Flavor", values }, [
			"find",
			"label",
			"Flavor",
			"select",
			...values,
		]);
	}
});

test("flat QA input preserves attached restrictions and optional-null normalization", async (t) => {
	const schema = createAgentBrowserQaParamsSchema();
	const tool = { name: "agent_browser_qa", description: "QA", parameters: schema };
	assert.equal(
		Check(schema, {
			attached: true,
			sessionMode: "auto",
			expectedText: ["Ready"],
			checkErrors: true,
		}),
		true,
	);
	assert.equal(Check(schema, { url: "https://example.com", sessionMode: "fresh" }), true);
	for (const input of [
		{},
		{ attached: false },
		{ attached: true, sessionMode: "fresh" },
		{ attached: true, url: "https://example.com" },
	]) {
		// Each incompatible QA input is an independently reported schema case.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(JSON.stringify(input), () => {
			assert.equal(Check(schema, input), false, JSON.stringify(input));
		});
	}
	assert.deepEqual(
		validateToolArguments(tool, {
			type: "toolCall",
			id: "qa",
			name: tool.name,
			arguments: { attached: true, url: null, sessionMode: null, checkNetwork: null },
		}),
		{ attached: true },
	);
});

test("advanced schemas keep host timeouts and bounded scanner controls", () => {
	const electron = createAgentBrowserElectronParamsSchema();
	assert.equal(Check(electron, { action: "list", outputPath: "apps.json" }), true);
	assert.equal(Check(electron, { action: "list", timeoutMs: 1000 }), false);
	assert.equal(
		Check(electron, {
			action: "launch",
			appName: "Editor",
			timeoutMs: 1000,
			outputPath: "launch.json",
		}),
		true,
	);
	assert.equal(Check(electron, { action: "cleanup", all: true, launchId: "one" }), false);
	for (const createSchema of [
		createAgentBrowserSourceParamsSchema,
		createAgentBrowserNetworkSourceParamsSchema,
	]) {
		// Both fixed lookup schemas must accept their maximum limit.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			Check(createSchema(), { maxWorkspaceFiles: 5000, outputPath: "hints.json", timeoutMs: 1000 }),
			true,
		);
		// Both fixed lookup schemas must reject the next value.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(Check(createSchema(), { maxWorkspaceFiles: 5001 }), false);
	}
	const loader = createAgentBrowserToolsParamsSchema();
	assert.equal(Check(loader, {}), true);
	assert.equal(Check(loader, { enable: ["action", "qa", "electron", "source", "network"] }), true);
	assert.equal(Check(loader, { enable: ["script"] }), false);
	assert.equal(Check(loader, { disable: ["qa"] }), false);
});

test("code and web-search schemas enforce source and filter bounds independently", () => {
	const code = createAgentBrowserCodeParamsSchema();
	assert.equal(Check(code, { code: "x".repeat(65_536), timeoutMs: 300_000 }), true);
	assert.equal(Check(code, { code: "x".repeat(65_537) }), false);
	assert.equal(Check(code, { code: "emit(1)", timeoutMs: 300_001 }), false);
	const search = createAgentBrowserWebSearchParamsSchema();
	assert.equal(
		Check(search, {
			query: "Pi",
			country: "US",
			includeDomains: ["example.com"],
			count: 10,
			offset: 9,
		}),
		true,
	);
	for (const filters of [
		{ country: "USA" },
		{ includeDomains: [] },
		{ includeDomains: [""] },
		{ includeDomains: Array.from({ length: 21 }, () => "example.com") },
		{ count: 0 },
		{ count: 11 },
		{ offset: -1 },
		{ offset: 10 },
		{ searchType: "unknown" },
	]) {
		// Each independent filter bound/enum violation must fail the public search schema.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(Check(search, { query: "Pi", ...filters }), false, JSON.stringify(filters));
	}
});
