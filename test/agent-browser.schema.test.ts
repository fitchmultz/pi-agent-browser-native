/**
 * Purpose: Guard public agent_browser tool schema compatibility while production startup uses lightweight JSON-schema builders.
 * Responsibilities: Compare production schema output against the canonical TypeBox/StringEnum builder shape without importing heavy builders on the extension cold path.
 * Scope: Schema parity and semantic compiler agreement; browser behavior remains in extension input-mode tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StringEnum } from "@earendil-works/pi-ai/compat";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

import {
	createAgentBrowserParamsSchema, createAgentBrowserCodeParamsSchema, createAgentBrowserActionParamsSchema,
	createAgentBrowserQaParamsSchema, createAgentBrowserElectronParamsSchema, createAgentBrowserSourceParamsSchema,
	createAgentBrowserNetworkSourceParamsSchema, createAgentBrowserToolsParamsSchema,
} from "../extensions/agent-browser/lib/input-modes/params.js";
import { compileAgentBrowserSemanticAction } from "../extensions/agent-browser/lib/input-modes/semantic-action.js";
import { AGENT_BROWSER_SEMANTIC_LOCATORS } from "../extensions/agent-browser/lib/input-modes/types.js";
import type { JsonSchemaBuilder } from "../extensions/agent-browser/lib/json-schema.js";
import type { StringEnumBuilder } from "../extensions/agent-browser/lib/string-enum-schema.js";
import { createAgentBrowserWebSearchParamsSchema } from "../extensions/agent-browser/lib/web-search.js";

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, nestedValue) => {
		if (!nestedValue || typeof nestedValue !== "object" || Array.isArray(nestedValue)) return nestedValue;
		return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
	});
}

test("agent_browser exposes only compact native command input", () => {
	const schema = createAgentBrowserParamsSchema();
	const properties = (schema as { properties?: Record<string, unknown> }).properties;
	assert.ok(properties);
	assert.deepEqual(Object.keys(properties).sort(), ["args", "outputPath", "sessionMode", "stdin", "timeoutMs"]);
	assert.equal(Check(schema, { args: ["batch", "--bail"], stdin: '[["get","title"]]' }), true);
	assert.equal(Check(schema, {}), false);
	for (const mode of ["script", "job", "semanticAction", "qa", "electron", "sourceLookup", "networkSourceLookup"]) {
		assert.equal(Check(schema, { args: ["get", "url"], [mode]: {} }), false, mode);
	}
	assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 1400);
});

test("agent_browser_code has strict portable JSON input with explicit browser identity", () => {
	const schema = createAgentBrowserCodeParamsSchema();
	const tool = { name: "agent_browser_code", description: "Browser code", parameters: schema, constrainedSampling: { type: "json_schema", strict: "prefer" } as const };
	const properties = (schema as { properties?: Record<string, unknown> }).properties;
	assert.ok(properties);
	assert.deepEqual(Object.keys(properties).sort(), ["code", "namespace", "outputPath", "session", "timeoutMs"]);
	assert.equal(Check(schema, { code: "emit(1)", namespace: "", session: "example", timeoutMs: 300000 }), true);
	for (const input of [{ code: "" }, { code: "emit(1)", session: "" }, { code: "emit(1)", timeoutMs: 300001 }, { code: "emit(1)", timeoutMs: 1.5 }, { code: "emit(1)", args: [] }, { script: "emit(1)" }]) {
		assert.equal(Check(schema, input), false, JSON.stringify(input));
	}
	const [providerTool] = convertResponsesTools([tool], { supportsStrictMode: true });
	assert.equal(providerTool.type, "function");
	assert.equal(providerTool.strict, true);
	assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "code", name: tool.name, arguments: { code: "emit(1)", session: null, namespace: "", timeoutMs: null, outputPath: null } }), { code: "emit(1)", namespace: "" });
	assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 1400);
});

test("semantic schema keeps optional properties visible to Pi null normalization", () => {
	const semantic = createAgentBrowserActionParamsSchema() as { properties?: Record<string, unknown>; required?: string[] };
	for (const field of ["locator", "value", "values", "selector", "text", "role", "name", "session"]) {
		assert.ok(semantic.properties?.[field], `${field} must remain visible to Pi's optional-null normalization`);
		assert.equal(semantic.required?.includes(field) ?? false, false);
	}
});

test("semantic schema rejects non-select values and select text like the compiler", () => {
	const schema = createAgentBrowserActionParamsSchema();
	for (const action of ["check", "click", "fill"]) {
		const semanticAction = { action, selector: "#target", values: ["nope"], ...(action === "fill" ? { text: "query" } : {}) };
		assert.match(compileAgentBrowserSemanticAction(semanticAction).error ?? "", /values is only supported for select/);
		assert.equal(Check(schema, semanticAction), false, JSON.stringify(semanticAction));
	}
	const semanticAction = { action: "select", selector: "#flavor", value: "chocolate", text: "ignored" };
	assert.match(compileAgentBrowserSemanticAction(semanticAction).error ?? "", /text is not supported for select/);
	assert.equal(Check(schema, semanticAction), false);
});

test("semantic schema keeps supported locators, role aliases, selectors and select options", () => {
	const schema = createAgentBrowserActionParamsSchema();
	const tool = { name: "agent_browser_action", description: "Browser", parameters: schema };
	const [providerTool] = convertResponsesTools([tool]);
	assert.equal(providerTool.type, "function");
	assert.equal(providerTool.strict, false);
	assert.deepEqual(providerTool.parameters, schema);
	function accepts(semanticAction: Record<string, unknown>, args: string[]) {
		for (const session of [undefined, "schema-session"]) {
			const input = { ...semanticAction, ...(session ? { session } : {}) };
			assert.equal(Check(schema, input), true, JSON.stringify(input));
			const validated = validateToolArguments(tool, { type: "toolCall", id: "schema", name: tool.name, arguments: input });
			assert.deepEqual(validated, input);
			const result = compileAgentBrowserSemanticAction(validated);
			assert.equal(result.error, undefined, JSON.stringify(input));
			assert.deepEqual(result.compiled?.args, [...(session ? ["--session", session] : []), ...args]);
		}
	}
	for (const action of ["check", "click", "fill"]) {
		const text = action === "fill" ? { text: "query" } : {};
		const tail = action === "fill" ? ["query"] : [];
		for (const selector of ["#target", "@e1"]) {
			accepts({ action, selector, ...text }, [action, selector, ...tail]);
		}
		for (const locator of AGENT_BROWSER_SEMANTIC_LOCATORS) {
			accepts({ action, locator, value: "target", ...text }, ["find", locator, "target", action, ...tail]);
		}
		for (const alias of [{ role: "button" }, { value: "button" }, { role: "button", value: "button" }]) {
			accepts({ action, locator: "role", ...alias, name: "Open", ...text }, ["find", "role", "button", action, ...tail, "--name", "Open"]);
		}
		accepts({ action, locator: "role", role: "button", name: "", ...text }, ["find", "role", "button", action, ...tail]);
	}
	for (const options of [{ value: "chocolate" }, { values: ["chocolate"] }, { values: ["chocolate", "vanilla"] }]) {
		const values = options.values ?? [options.value!];
		for (const selector of ["#flavor", "@e2"]) {
			accepts({ action: "select", selector, ...options }, ["select", selector, ...values]);
		}
		for (const role of ["combobox", "listbox", "COMBOBOX"]) {
			accepts({ action: "select", locator: "role", role, name: "Flavor", ...options }, ["find", "role", role, "select", ...values, "--name", "Flavor"]);
		}
		accepts({ action: "select", locator: "label", value: "Flavor", values }, ["find", "label", "Flavor", "select", ...values]);
	}
});

test("flat QA input preserves attached restrictions and optional-null normalization", () => {
	const schema = createAgentBrowserQaParamsSchema();
	const tool = { name: "agent_browser_qa", description: "QA", parameters: schema };
	assert.equal(Check(schema, { attached: true, sessionMode: "auto", expectedText: ["Ready"], checkErrors: true }), true);
	assert.equal(Check(schema, { url: "https://example.com", sessionMode: "fresh" }), true);
	for (const input of [{}, { attached: false }, { attached: true, sessionMode: "fresh" }, { attached: true, url: "https://example.com" }]) {
		assert.equal(Check(schema, input), false, JSON.stringify(input));
	}
	assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "qa", name: tool.name, arguments: { attached: true, url: null, sessionMode: null, checkNetwork: null } }), { attached: true });
});

test("advanced schemas keep host timeouts and bounded scanner controls", () => {
	const electron = createAgentBrowserElectronParamsSchema();
	assert.equal(Check(electron, { action: "list", outputPath: "apps.json" }), true);
	assert.equal(Check(electron, { action: "list", timeoutMs: 1000 }), false);
	assert.equal(Check(electron, { action: "launch", appName: "Editor", timeoutMs: 1000, outputPath: "launch.json" }), true);
	assert.equal(Check(electron, { action: "cleanup", all: true, launchId: "one" }), false);
	for (const createSchema of [createAgentBrowserSourceParamsSchema, createAgentBrowserNetworkSourceParamsSchema]) {
		assert.equal(Check(createSchema(), { maxWorkspaceFiles: 5000, outputPath: "hints.json", timeoutMs: 1000 }), true);
		assert.equal(Check(createSchema(), { maxWorkspaceFiles: 5001 }), false);
	}
	const loader = createAgentBrowserToolsParamsSchema();
	assert.equal(Check(loader, {}), true);
	assert.equal(Check(loader, { enable: ["action", "qa", "electron", "source", "network"] }), true);
	assert.equal(Check(loader, { enable: ["script"] }), false);
	assert.equal(Check(loader, { disable: ["qa"] }), false);
});

test("production JSON-schema builder matches TypeBox shape for public tool schemas", () => {
	const typeBox = Type as unknown as JsonSchemaBuilder;
	const typeBoxStringEnum = StringEnum as unknown as StringEnumBuilder;
	for (const createSchema of [createAgentBrowserParamsSchema, createAgentBrowserActionParamsSchema, createAgentBrowserQaParamsSchema, createAgentBrowserElectronParamsSchema, createAgentBrowserSourceParamsSchema, createAgentBrowserNetworkSourceParamsSchema, createAgentBrowserToolsParamsSchema]) {
		assert.equal(stableJson(createSchema()), stableJson(createSchema(typeBox, typeBoxStringEnum)), createSchema.name);
	}
	assert.equal(stableJson(createAgentBrowserCodeParamsSchema()), stableJson(createAgentBrowserCodeParamsSchema(typeBox)));
	assert.equal(
		stableJson(createAgentBrowserWebSearchParamsSchema()),
		stableJson(createAgentBrowserWebSearchParamsSchema(typeBox, typeBoxStringEnum)),
	);
});
