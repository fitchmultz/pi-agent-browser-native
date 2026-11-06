import type { JsonValue } from "@earendil-works/pi-ai";
import { isRecord } from "./parsing.js";

export function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	return isRecord(value) && Object.values(value).every(isJsonValue);
}
