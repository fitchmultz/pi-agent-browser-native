import { StringEnum as createPiStringEnum } from "@earendil-works/pi-ai";
import { Type, type TUnsafe } from "typebox";

export function StringEnum<const Values extends readonly string[]>(
	values: Values,
	options?: {
		readonly default?: Values[number];
		readonly description?: string;
	},
): TUnsafe<Values[number]> {
	return Type.Unsafe<Values[number]>(createPiStringEnum(values, options));
}
