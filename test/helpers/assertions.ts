import assert from "node:assert/strict";

/** Unknown fixture/JSON values stay unknown until their actual shape is checked. */
function assertRecord(value: unknown): asserts value is Record<string, unknown> {
	assert.ok(
		typeof value === "object" && value !== null && !Array.isArray(value),
		"expected an object record",
	);
}

export function readDefined<Value>(value: Value | undefined): Value {
	assert.ok(value !== undefined, "expected a defined fixture value");
	return value;
}

export function readRecord(value: unknown): Record<string, unknown> {
	assertRecord(value);
	return value;
}

export function readArray(value: unknown): unknown[] {
	assert.ok(Array.isArray(value), "expected an array");
	return value;
}

export function readString(value: unknown): string {
	assert.ok(typeof value === "string", "expected a string");
	return value;
}

export function readNumber(value: unknown): number {
	assert.ok(typeof value === "number" && Number.isFinite(value), "expected a finite number");
	return value;
}

export function readBoolean(value: unknown): boolean {
	assert.ok(typeof value === "boolean", "expected a boolean");
	return value;
}

/** Dynamic module callbacks promise only callability, not arbitrary parameter/result types. */
export function readFunction(value: unknown): (...args: readonly unknown[]) => unknown {
	assert.ok(typeof value === "function", "expected a callable");
	return (...args) => {
		const result: unknown = Reflect.apply(value, undefined, args);
		return result;
	};
}

export function hasErrorCode(value: unknown, code: string): boolean {
	return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
