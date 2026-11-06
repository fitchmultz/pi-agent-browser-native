import assert from "node:assert/strict";
import { Type } from "typebox";
import { Check } from "typebox/value";

const jsonValue = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);
const toolArguments = Type.Record(Type.String(), jsonValue);
const details = Type.Record(Type.String(), Type.Unknown());
const toolResult = Type.Object({
	content: Type.Array(
		Type.Union([
			Type.Object({ type: Type.Literal("text"), text: Type.String() }),
			Type.Object({
				type: Type.Literal("image"),
				data: Type.String(),
				mimeType: Type.String(),
				text: Type.Optional(Type.String()),
			}),
		]),
	),
	details: Type.Optional(details),
	isError: Type.Optional(Type.Boolean()),
	structuredContent: Type.Optional(jsonValue),
});
const browserResult = Type.Intersect([toolResult, Type.Object({ details })]);

/** @typedef {import("typebox").Static<typeof toolResult>} TestToolResult */
/** @typedef {import("typebox").Static<typeof browserResult>} BrowserToolResult */

/** @param {unknown} value @returns {import("@earendil-works/pi-ai").JsonObject} */
export function readToolArguments(value) {
	assert.ok(Check(toolArguments, value), "tool arguments must be a JSON object");
	return value;
}

/** @param {unknown} value @returns {TestToolResult} */
export function readToolResult(value) {
	assert.ok(Check(toolResult, value), "registered tool returned an invalid result envelope");
	return value;
}

/** @param {unknown} value @returns {BrowserToolResult} */
export function readBrowserToolResult(value) {
	assert.ok(
		Check(browserResult, value),
		"browser tool must return an envelope with object details",
	);
	return value;
}
