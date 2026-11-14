import type { TSchema, TSchemaOptions, TUnsafe } from "typebox";

const OPTIONAL_SCHEMA = Symbol("pi-agent-browser-optional-schema");

type SchemaProperties = Readonly<Record<string, TSchema>>;

function withOptions(schema: TSchema, options?: TSchemaOptions): TSchema {
	return { ...schema, ...options };
}

function literalType(value: unknown): "boolean" | "number" | "string" | undefined {
	const valueType = typeof value;
	return valueType === "string" || valueType === "number" || valueType === "boolean"
		? valueType
		: undefined;
}

function propertySchema(schema: TSchema): TSchema {
	const clone = { ...schema };
	if (OPTIONAL_SCHEMA in clone) {
		delete clone[OPTIONAL_SCHEMA];
	}
	return clone;
}

function isOptional(schema: TSchema): boolean {
	return OPTIONAL_SCHEMA in schema && schema[OPTIONAL_SCHEMA] === true;
}

// TUnsafe's value type is a caller-owned schema assertion, not a runtime value.
// Preserve the lightweight JSON shape; native Pi validates the supplied schema.
function unsafeSchema<Value>(schema: TSchema): TUnsafe<Value>;
function unsafeSchema(schema: TSchema): TSchema {
	return schema;
}

const nativeJsonSchemaBuilder = {
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
		return withOptions(type !== undefined ? { type, const: value } : { const: value }, options);
	},
	Number(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "number" }, options);
	},
	Object(properties: SchemaProperties, options?: TSchemaOptions): TSchema {
		const required = globalThis.Object.entries(properties)
			.filter(([, schema]) => !isOptional(schema))
			.map(([key]) => key);
		return withOptions(
			{
				type: "object",
				properties: globalThis.Object.fromEntries(
					globalThis.Object.entries(properties).map(([key, schema]) => [
						key,
						propertySchema(schema),
					]),
				),
				...(required.length > 0 ? { required } : {}),
			},
			options,
		);
	},
	Optional(schema: TSchema): TSchema {
		return { ...schema, [OPTIONAL_SCHEMA]: true };
	},
	String(options?: TSchemaOptions): TSchema {
		return withOptions({ type: "string" }, options);
	},
	Union(types: readonly TSchema[], options?: TSchemaOptions): TSchema {
		return withOptions({ anyOf: types }, options);
	},
	Unsafe: unsafeSchema,
};

export const JsonSchema: Readonly<typeof nativeJsonSchemaBuilder> = nativeJsonSchemaBuilder;
export type { TSchema, TSchemaOptions, TUnsafe };
