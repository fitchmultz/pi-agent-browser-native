import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tokenizeJson, { type Token } from "stream-json/parser.js";
import ignoreJson from "stream-json/filters/ignore.js";
import stringifyJson from "stream-json/stringer.js";
import disassembleJson from "stream-json/disassembler.js";
import {
	BROWSER_RESULT_TOOLS,
	BROWSER_STATE_FIELDS,
	BROWSER_TRANSITION_ENTRY,
	type BrowserRecord,
} from "./browser-transcript-contracts.js";
import {
	projectJson,
	readRange,
	type JournalEntry,
	type JournalRange,
} from "./browser-journal-reader.js";
import { isRecord } from "./parsing.js";
import { convertLegacyBrowserEntry, emptyProjection } from "./browser-legacy-projection.js";
import { BrowserConversionBranches } from "./browser-conversion-branches.js";
const DETAILS_FIELDS = [
	...BROWSER_STATE_FIELDS,
	"browserEventVersion",
	"electron",
	"compiledNetworkSourceLookup",
	"sessionTabTarget",
	"sessionTabTargetUnknown",
	"sessionTabReopenPending",
	"refSnapshot",
	"refSnapshotInvalidation",
	"artifactManifest",
	"error",
	"summary",
];
const LEGACY_FIELDS = [
	["data", "event"],
	["data", "snapshot"],
	["data", "cleanup"],
	["data", "sessionName"],
	["data", "closeCommandArgs"],
	["data", "launchAttempted"],
	["data", "toolCallId"],
	["data", "isError"],
	["message", "toolName"],
	["message", "toolCallId"],
	["message", "isError"],
	...["data", "message"].flatMap((root) => DETAILS_FIELDS.map((field) => [root, "details", field])),
	...["data", "message"].flatMap((root) =>
		["command", "success", "lifecycle"]
			.map((field) => [root, "details", "batchSteps", "*", field])
			.concat(
				[
					["data", "lifecycle"],
					["result", "lifecycle"],
				].map((field) => [root, "details", "batchSteps", "*"].concat(field)),
			),
	),
	...["data", "message"].flatMap((root) =>
		["command", "success", "error"]
			.map((field) => [root, "details", "data", "*", field])
			.concat(
				["url", "title", "origin", "targetId"].map((field) => [
					root,
					"details",
					"data",
					"*",
					"result",
					field,
				]),
			),
	),
];
export async function sourceChecksum(file: FileHandle, size: number): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of readRange(file, { offset: 0, length: size })) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}
export async function writeBytes(
	file: FileHandle,
	// The native async iterator owns its cursor; yielded byte/string contents are read, never changed.
	// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
	chunks: AsyncIterable<Uint8Array | string>,
): Promise<void> {
	for await (const chunk of chunks) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		let offset = 0;
		while (offset < buffer.length) {
			// Partial writes determine the offset for the next write.
			// oxlint-disable-next-line no-await-in-loop
			const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
			if (bytesWritten === 0) {
				throw new Error("Could not write converted journal.");
			}
			offset += bytesWritten;
		}
	}
}
async function* decodeRange(file: FileHandle, range: JournalRange): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for await (const bytes of readRange(file, range)) {
		yield decoder.decode(bytes, { stream: true });
	}
	const tail = decoder.decode();
	if (tail.length > 0) {
		yield tail;
	}
}
async function rewriteMessage(
	file: FileHandle,
	range: JournalRange,
	destination: FileHandle,
	record: BrowserRecord,
): Promise<void> {
	const tokenizer = tokenizeJson.asStream({ packValues: false, packKeys: true, streamKeys: false });
	const filter = ignoreJson.asStream({
		filter: /^(?:data|message\.details\.(?:refSnapshot|artifactManifest|browserEventVersion))$/,
	});
	async function* inject(
		// Native token iteration advances a mutable cursor; token observations themselves remain readonly.
		// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
		tokens: AsyncIterable<Readonly<Token>>,
	): AsyncGenerator<Token> {
		let depth = 0;
		for await (const token of tokens) {
			if (token.name === "startObject" || token.name === "startArray") {
				depth++;
			}
			if (token.name === "endObject" || token.name === "endArray") {
				depth--;
				if (depth === 0) {
					const key: Token = { name: "keyValue", value: "data" };
					yield key;
					yield* disassembleJson({ packValues: false, packKeys: true, streamKeys: false })(record);
				}
			}
			yield token;
		}
	}
	const output = stringifyJson.asStream({ useKeyValues: true });
	const processing = pipeline(
		Readable.from(decodeRange(file, range)),
		tokenizer,
		filter,
		inject,
		output,
	);
	try {
		await Promise.all([writeBytes(destination, output), processing]);
	} finally {
		tokenizer.destroy();
		filter.destroy();
		output.destroy();
	}
	await destination.write("\n");
}
function isLegacyBrowserEntry(value: Readonly<Record<string, unknown>>): boolean {
	if (
		value.type === "custom" &&
		typeof value.customType === "string" &&
		[BROWSER_TRANSITION_ENTRY, "agent-browser-script-session"].includes(value.customType)
	) {
		return true;
	}
	return (
		isRecord(value.message) &&
		typeof value.message.toolName === "string" &&
		BROWSER_RESULT_TOOLS.has(value.message.toolName)
	);
}
/** Owns branch projection and counters while streaming entries, never whole raw payloads. */
export class BrowserConversionWriter {
	private readonly ids = new Set<string>();
	private readonly branches: BrowserConversionBranches;
	private convertedRecords = 0;
	private snapshotDefinitions = 0;
	constructor(
		private readonly file: FileHandle,
		private readonly stage: FileHandle,
		private readonly source: {
			readonly sessionId: string;
			readonly checksum: string;
		},
		metadata: readonly JournalEntry[],
	) {
		this.branches = new BrowserConversionBranches(
			metadata.map((entry) => (entry.value.type === "session" ? undefined : entry.value.parentId)),
		);
	}
	get counts(): Readonly<{
		entryCount: number;
		convertedRecords: number;
		snapshotDefinitions: number;
	}> {
		return {
			entryCount: this.ids.size,
			convertedRecords: this.convertedRecords,
			snapshotDefinitions: this.snapshotDefinitions,
		};
	}
	private async conversion(entry: JournalEntry): Promise<BrowserRecord | undefined> {
		if (entry.value.type === "session") {
			return undefined;
		}
		const id = entry.value.id;
		if (typeof id !== "string" || this.ids.has(id)) {
			throw new Error("Conversion source contains a missing or duplicate native entry ID.");
		}
		const parentId = entry.value.parentId;
		if (parentId !== null && (typeof parentId !== "string" || !this.ids.has(parentId))) {
			throw new Error("Conversion source contains a missing or forward parent.");
		}
		this.ids.add(id);
		const parent =
			typeof parentId === "string"
				? (this.branches.get(parentId) ?? emptyProjection())
				: emptyProjection();
		if (!isLegacyBrowserEntry(entry.value)) {
			this.branches.advance(id, parentId, parent);
			return undefined;
		}
		const details = await projectJson(readRange(this.file, entry), LEGACY_FIELDS, Infinity);
		const conversion = convertLegacyBrowserEntry(
			{ ...entry.value, ...details },
			parent,
			this.source.sessionId,
		);
		this.branches.advance(id, parentId, conversion.projection);
		return conversion.record;
	}
	async write(entry: JournalEntry, sourceSize: number): Promise<void> {
		const record = await this.conversion(entry);
		if (!record) {
			await writeBytes(this.stage, readRange(this.file, entry));
			if (entry.offset + entry.length === sourceSize) {
				await this.completeLastLine(sourceSize);
			}
			return;
		}
		const data = {
			...record,
			archive: { sourceSha256: this.source.checksum, offset: entry.offset, length: entry.length },
		};
		if (entry.value.type === "message") {
			await rewriteMessage(this.file, entry, this.stage, data);
		} else {
			await this.stage.write(
				`${JSON.stringify({ ...entry.value, customType: BROWSER_TRANSITION_ENTRY, data })}\n`,
			);
		}
		this.convertedRecords++;
		if (record.snapshot !== undefined) {
			this.snapshotDefinitions++;
		}
	}
	private async completeLastLine(size: number): Promise<void> {
		const lastByte = Buffer.alloc(1);
		await this.file.read(lastByte, 0, 1, size - 1);
		if (lastByte[0] !== 10) {
			await this.stage.write("\n");
		}
	}
}
