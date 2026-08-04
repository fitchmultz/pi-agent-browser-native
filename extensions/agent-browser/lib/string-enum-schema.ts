import { JsonSchema, type TSchemaOptions, type TUnsafe } from "./json-schema.js";

export type StringEnumBuilder = typeof StringEnum;

export function StringEnum<const Values extends readonly string[]>(
	values: Values,
	options?: TSchemaOptions,
): TUnsafe<Values[number]> {
	return JsonSchema.Unsafe<Values[number]>({
		type: "string",
		enum: [...values],
		...options,
	});
}
