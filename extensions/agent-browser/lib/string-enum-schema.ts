/**
 * Purpose: Build compact JSON-schema string enums without importing pi runtime helpers.
 * Responsibilities: Mirror pi-ai StringEnum's `{ type: "string", enum: [...] }` shape while keeping extension startup imports light.
 * Scope: Schema construction only.
 */

import { Type, type TSchemaOptions, type TUnsafe } from "./schema.js";

export function StringEnum<const Values extends readonly string[]>(
	values: Values,
	options?: TSchemaOptions,
): TUnsafe<Values[number]> {
	return Type.Unsafe<Values[number]>({
		type: "string",
		enum: [...values],
		...options,
	});
}
