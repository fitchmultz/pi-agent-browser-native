/**
 * Purpose: Build the small JSON Schema subset used by Pi tool schemas without importing TypeBox at runtime.
 * Responsibilities: Preserve the TypeBox-shaped objects Pi consumes while keeping extension startup cheap.
 * Scope: Schema construction only; runtime validation still belongs to Pi and the tool input compilers.
 */

import type { TSchema, TSchemaOptions, TUnsafe } from "typebox";

const OPTIONAL_SCHEMA = Symbol("pi-agent-browser-optional-schema");

type SchemaObject = TSchema & { [OPTIONAL_SCHEMA]?: true };
type SchemaProperties = Record<string, TSchema>;

function withOptions(schema: Record<string, unknown>, options?: TSchemaOptions): TSchema {
	return { ...schema, ...(options ?? {}) } as TSchema;
}

function literalType(value: unknown): "boolean" | "number" | "string" | undefined {
	const valueType = typeof value;
	return valueType === "string" || valueType === "number" || valueType === "boolean" ? valueType : undefined;
}

function propertySchema(schema: TSchema): TSchema {
	const clone = { ...(schema as SchemaObject & Record<PropertyKey, unknown>) };
	delete clone[OPTIONAL_SCHEMA];
	return clone as TSchema;
}

export const Type = {
	Array(items: TSchema, options?: TSchemaOptions): TSchema {
		return withOptions({ type: "array", items }, options);
	},
	Boolean(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "boolean" }, options);
	},
	Integer(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "integer" }, options);
	},
	Literal(value: unknown, options?: TSchemaOptions): TSchema {
		const type = literalType(value);
		return withOptions(type ? { type, const: value } : { const: value }, options);
	},
	Number(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "number" }, options);
	},
	Object(properties: SchemaProperties, options?: TSchemaOptions): TSchema {
		const required = globalThis.Object.entries(properties)
			.filter(([, schema]) => (schema as SchemaObject)[OPTIONAL_SCHEMA] !== true)
			.map(([key]) => key);
		return withOptions({
			type: "object",
			properties: globalThis.Object.fromEntries(
				globalThis.Object.entries(properties).map(([key, schema]) => [key, propertySchema(schema)]),
			),
			...(required.length > 0 ? { required } : {}),
		}, options);
	},
	Optional(schema: TSchema): TSchema {
		return { ...(schema as SchemaObject), [OPTIONAL_SCHEMA]: true } as TSchema;
	},
	String(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "string" }, options);
	},
	Union(types: TSchema[], options?: TSchemaOptions): TSchema {
		return withOptions({ anyOf: types }, options);
	},
	Unsafe<Value>(schema: TSchema): TUnsafe<Value> {
		return schema as TUnsafe<Value>;
	},
};

export type { TSchema, TSchemaOptions, TUnsafe };
