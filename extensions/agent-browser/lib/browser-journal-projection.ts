import type { Token } from "stream-json/parser.js";
import { isRecord } from "./parsing.js";

const ENVELOPE_MAX_BYTES = 16 * 1024 * 1024;
type ProjectionFields = readonly (readonly string[])[];
interface ProjectionFrame {
	readonly path: readonly (string | number)[];
	key?: string;
	index: number;
	readonly value?: Record<string, unknown> | unknown[];
}
function matches(field: string | undefined, key: string | number | undefined): boolean {
	return field === key || (field === "*" && typeof key === "number");
}
function selectedPath(path: readonly (string | number)[], fields: ProjectionFields): boolean {
	return fields.some(
		(field) =>
			field.every((key, index) => matches(key, path[index])) ||
			path.every((key, index) => matches(field[index], key)),
	);
}

/** Own only selected JSON values; discarded token streams still receive full syntax validation. */
class JsonProjection {
	private readonly stack: ProjectionFrame[] = [];
	private root: unknown;
	private literal:
		| { value: string; readonly selected: boolean; readonly number: boolean }
		| undefined;
	private inKey = false;
	private keyText = "";
	private bytes = 0;
	constructor(
		private readonly fields: ProjectionFields,
		private readonly maxBytes: number,
	) {}
	result(): Record<string, unknown> | undefined {
		return isRecord(this.root) ? this.root : undefined;
	}
	private reserve(size: number): void {
		this.bytes += size;
		if (this.bytes > this.maxBytes) {
			throw new Error("Selected journal envelope exceeds its bounded read size.");
		}
	}
	private path(): readonly (string | number)[] {
		const frame = this.stack.at(-1);
		return frame ? [...frame.path, frame.key ?? frame.index] : [];
	}
	private excluded(): boolean {
		const frame = this.stack.at(-1);
		return frame !== undefined && frame.value === undefined;
	}
	private frame(): ProjectionFrame {
		const frame = this.stack.at(-1);
		if (!frame) {
			throw new Error("Journal JSON container is missing.");
		}
		return frame;
	}
	private put(value: unknown): void {
		const parent = this.stack.at(-1);
		if (!parent) {
			this.root = value;
			return;
		}
		if (parent.value && value !== undefined) {
			if (Array.isArray(parent.value)) {
				parent.value[parent.index] = value;
			} else {
				if (parent.key === undefined) {
					throw new Error("Journal object key is missing.");
				}
				Object.defineProperty(parent.value, parent.key, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
		}
		parent.key = undefined;
		parent.index += 1;
	}
	consume(token: Token): void {
		if (token.name === "startKey") {
			this.inKey = true;
			this.keyText = "";
			return;
		}
		if (token.name === "endKey") {
			this.inKey = false;
			this.frame().key = this.keyText;
			return;
		}
		if (this.inKey) {
			this.consumeKey(token);
			return;
		}
		switch (token.name) {
			case "startObject":
			case "startArray":
				this.startContainer(token.name);
				break;
			case "endObject":
			case "endArray": {
				const frame = this.stack.pop();
				if (!frame) {
					throw new Error("Journal JSON container is missing.");
				}
				this.put(frame.value);
				break;
			}
			case "startString":
			case "startNumber":
				this.literal = {
					value: "",
					selected: !this.excluded() && selectedPath(this.path(), this.fields),
					number: token.name === "startNumber",
				};
				break;
			case "stringChunk":
			case "numberChunk":
				this.consumeLiteral(token.value);
				break;
			case "endString":
			case "endNumber":
				this.endLiteral();
				break;
			case "trueValue":
			case "falseValue":
			case "nullValue":
				this.consumeConstant(token.name);
				break;
			case "keyValue":
			case "numberValue":
			case "stringValue":
			case "whitespace":
				// The unpacked tokenizer emits chunk events; packed/whitespace tokens need no projection.
				break;
		}
	}
	private consumeKey(token: Token): void {
		if (token.name !== "stringChunk" || this.excluded()) {
			return;
		}
		const path = this.frame().path;
		const wholeContainer = this.fields.some((field) =>
			field.every((key, index) => matches(key, path[index])),
		);
		if (wholeContainer || this.keyText.length <= 1024) {
			if (wholeContainer) {
				this.reserve(Buffer.byteLength(token.value));
			}
			this.keyText += token.value;
		}
	}
	private startContainer(name: "startObject" | "startArray"): void {
		if (this.stack.length >= 1024) {
			throw new Error("Journal JSON nesting exceeds 1024 levels.");
		}
		// Excluded containers cannot contain a requested descendant; don't allocate their keys/paths.
		const currentPath = this.excluded() ? [] : this.path();
		const selected = !this.excluded() && selectedPath(currentPath, this.fields);
		if (selected) {
			this.reserve(32);
		}
		let value: Record<string, unknown> | unknown[] | undefined;
		if (selected) {
			value = name === "startObject" ? {} : [];
		}
		this.stack.push({ path: currentPath, index: 0, value });
	}
	private consumeLiteral(value: string): void {
		if (this.literal?.selected === true) {
			this.reserve(Buffer.byteLength(value));
			this.literal.value += value;
		}
	}
	private endLiteral(): void {
		const literal = this.literal;
		let value: unknown;
		if (literal?.selected === true) {
			value = literal.number ? Number(literal.value) : literal.value;
		}
		this.put(value);
		this.literal = undefined;
	}
	private consumeConstant(name: "trueValue" | "falseValue" | "nullValue"): void {
		const selected = !this.excluded() && selectedPath(this.path(), this.fields);
		if (selected) {
			this.reserve(8);
		}
		let value: unknown;
		if (selected) {
			value = name === "nullValue" ? null : name === "trueValue";
		}
		this.put(value);
	}
}

/** Validate discarded values too; the parser never packs their strings or numbers. */
export async function projectJson(
	// The native async iterator owns a mutable cursor; this reader consumes bytes without mutating them.
	// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
	input: AsyncIterable<Uint8Array>,
	fields: ProjectionFields,
	maxBytes = ENVELOPE_MAX_BYTES,
): Promise<Record<string, unknown> | undefined> {
	const { jsonParser } = await import("stream-json/core/parser.js");
	const chain = await import("stream-chain/defs.js");
	const tokenize = jsonParser({ packValues: false, streamValues: true });
	const projection = new JsonProjection(fields, maxBytes);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const consume = (text: string | typeof chain.none): void => {
		const tokens = tokenize(text);
		if (tokens !== chain.none) {
			for (const token of chain.getManyValues(tokens)) {
				projection.consume(token);
			}
		}
	};
	for await (const chunk of input) {
		consume(decoder.decode(chunk, { stream: true }));
	}
	const tail = decoder.decode();
	if (tail.length > 0) {
		consume(tail);
	}
	// The raw tokenizer requires an explicit flush to reject incomplete discarded values.
	consume(chain.none);
	return projection.result();
}
