/**
 * Purpose: Guard public agent_browser tool schema compatibility while production startup uses lightweight JSON-schema builders.
 * Responsibilities: Compare production schema output against the canonical TypeBox/StringEnum builder shape without importing heavy builders on the extension cold path.
 * Scope: Schema parity only; behavioral validation remains in extension input-mode tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { createAgentBrowserParamsSchema } from "../extensions/agent-browser/lib/input-modes/params.js";
import type { JsonSchemaBuilder } from "../extensions/agent-browser/lib/json-schema.js";
import type { StringEnumBuilder } from "../extensions/agent-browser/lib/string-enum-schema.js";
import { createAgentBrowserWebSearchParamsSchema } from "../extensions/agent-browser/lib/web-search.js";

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, nestedValue) => {
		if (!nestedValue || typeof nestedValue !== "object" || Array.isArray(nestedValue)) return nestedValue;
		return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) => left.localeCompare(right)));
	});
}

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
