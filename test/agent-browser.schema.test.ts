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

import { createAgentBrowserParamsSchema } from "../extensions/agent-browser/lib/input-modes/params.js";
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

test("agent_browser keeps every input mode in a compact model-facing schema", () => {
	const schema = createAgentBrowserParamsSchema() as { properties?: Record<string, unknown> };
	for (const mode of ["script", "args", "semanticAction", "job", "qa", "sourceLookup", "networkSourceLookup", "electron"]) {
		assert.ok(schema.properties?.[mode], `missing ${mode} input mode`);
	}
	const bytes = Buffer.byteLength(JSON.stringify(schema));
	assert.ok(bytes <= 10 * 1024, `agent_browser parameter schema is ${bytes} bytes; budget is 10 KiB`);
});

test("semantic schema keeps optional properties visible to Pi null normalization", () => {
	const schema = createAgentBrowserParamsSchema() as { properties: { semanticAction: { properties?: Record<string, unknown>; required?: string[] } } };
	const semantic = schema.properties.semanticAction;
	for (const field of ["locator", "value", "values", "selector", "text", "role", "name", "session"]) {
		assert.ok(semantic.properties?.[field], `${field} must remain visible to Pi's optional-null normalization`);
		assert.equal(semantic.required?.includes(field) ?? false, false);
	}
});

test("semantic schema rejects non-select values and select text like the compiler", () => {
	const schema = createAgentBrowserParamsSchema();
	for (const action of ["check", "click", "fill"]) {
		const semanticAction = { action, selector: "#target", values: ["nope"], ...(action === "fill" ? { text: "query" } : {}) };
		assert.match(compileAgentBrowserSemanticAction(semanticAction).error ?? "", /values is only supported for select/);
		assert.equal(Check(schema, { semanticAction }), false, JSON.stringify(semanticAction));
	}
	const semanticAction = { action: "select", selector: "#flavor", value: "chocolate", text: "ignored" };
	assert.match(compileAgentBrowserSemanticAction(semanticAction).error ?? "", /text is not supported for select/);
	assert.equal(Check(schema, { semanticAction }), false);
});

test("semantic schema keeps supported locators, role aliases, selectors and select options", () => {
	const schema = createAgentBrowserParamsSchema();
	const tool = { name: "agent_browser", description: "Browser", parameters: schema };
	const [providerTool] = convertResponsesTools([tool]);
	assert.equal(providerTool.type, "function");
	assert.equal(providerTool.strict, false);
	assert.deepEqual(providerTool.parameters, schema);
	function accepts(semanticAction: Record<string, unknown>, args: string[]) {
		for (const session of [undefined, "schema-session"]) {
			const input = { ...semanticAction, ...(session ? { session } : {}) };
			assert.equal(Check(schema, { semanticAction: input }), true, JSON.stringify(input));
			const validated = validateToolArguments(tool, { type: "toolCall", id: "schema", name: tool.name, arguments: { semanticAction: input } });
			assert.deepEqual(validated, { semanticAction: input });
			const result = compileAgentBrowserSemanticAction(validated.semanticAction);
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

test("production JSON-schema builder matches TypeBox shape for public tool schemas", () => {
	const typeBox = Type as unknown as JsonSchemaBuilder;
	const typeBoxStringEnum = StringEnum as unknown as StringEnumBuilder;
	assert.equal(
		stableJson(createAgentBrowserParamsSchema()),
		stableJson(createAgentBrowserParamsSchema(typeBox, typeBoxStringEnum)),
	);
	assert.equal(
		stableJson(createAgentBrowserWebSearchParamsSchema()),
		stableJson(createAgentBrowserWebSearchParamsSchema(typeBox, typeBoxStringEnum)),
	);
});
