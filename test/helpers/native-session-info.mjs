import assert from "node:assert/strict";
import { Type } from "typebox";
import { Check } from "typebox/value";

const nativeSessionInfo = Type.Object({
	active: Type.Boolean(),
	pid: Type.Union([Type.Number(), Type.Null()]),
	runtime: Type.Union([
		Type.Null(),
		Type.Object({ browserLaunched: Type.Boolean(), pageCount: Type.Number() }),
	]),
});

/** @param {unknown} value */
export function readNativeSessionInfo(value) {
	assert.ok(Check(nativeSessionInfo, value), "Native session info must report active/pid/runtime");
	return value;
}
