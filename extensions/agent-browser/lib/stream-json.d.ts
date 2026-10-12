import type { Many, none } from "stream-chain/defs.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

// stream-json 3.7.0 documents/exports the raw tokenizer but omits it from its declarations.
declare module "stream-json/core/parser.js" {
	export function jsonParser(
		options?: Readonly<ParserOptions>,
	): (text: string | typeof none) => Many<Token> | typeof none;
}
