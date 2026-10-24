import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
	open,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
	appendFile,
	type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBrowserEntries } from "../extensions/agent-browser/lib/browser-journal.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { readNumber, readRecord } from "./helpers/assertions.js";

const header = { type: "session", version: 3, id: "cache-fixture" };
function entry(id: string, parentId: string | null) {
	return {
		type: "custom",
		customType: "agent-browser-transition",
		id,
		parentId,
		data: {
			event: {
				version: 1,
				phase: "state",
				operationId: id,
				toolCallId: id,
				commandIndex: 0,
				isError: false,
				state: {},
				pages: [
					{
						key: "shared",
						target: { url: `https://fixture.test/${id}` },
						refs: { kind: "invalidate" },
					},
				],
			},
		},
	};
}
function journal(...entries: readonly unknown[]): string {
	return [header, ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n";
}
function manager(file: string, leaf = "a") {
	return {
		getSessionFile: () => file,
		getSessionId: () => header.id,
		getHeader: () => header,
		getLeafId: () => leaf,
		getEntry() {
			throw new Error("Published replay cannot trust SDK bodies.");
		},
		getEntries() {
			throw new Error("Published replay cannot load eager SDK bodies.");
		},
	};
}
async function target(file: string, leaf = "a"): Promise<string | undefined> {
	return SessionPageState.fromBranch(await readBrowserEntries(manager(file, leaf))).get("shared")
		.tabTarget?.url;
}

test("unchanged published journals skip discarded payload reads across manager contexts and branches", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	await writeFile(
		file,
		journal(
			{
				type: "custom",
				customType: "ignored",
				id: "payload",
				parentId: null,
				data: { ignored: "x".repeat(1024 * 1024) },
			},
			entry("a", "payload"),
			entry("b", "payload"),
		),
	);
	const handle = await open(file, "r");
	const prototype = readRecord(Object.getPrototypeOf(handle));
	const original = prototype.read;
	assert.ok(typeof original === "function");
	await handle.close();
	let bytesRead = 0;
	t.mock.method(
		prototype,
		"read",
		async function (this: FileHandle, ...args: readonly unknown[]) {
			const result: unknown = await Reflect.apply(original, this, args);
			bytesRead += readNumber(readRecord(result).bytesRead);
			return result;
		},
		{},
	);
	assert.equal(await target(file), "https://fixture.test/a");
	assert.ok(bytesRead > 2 * 1024 * 1024, "the cold scan must validate the discarded payload");
	bytesRead = 0;
	assert.equal(await target(file, "b"), "https://fixture.test/b");
	assert.ok(
		bytesRead < 4096,
		`unchanged replay must read only selected browser bodies, read ${bytesRead} bytes`,
	);
	await assert.rejects(readBrowserEntries(manager(file, "unpublished")), /not persisted/);
	await assert.rejects(
		readBrowserEntries({ ...manager(file), getHeader: () => ({ id: "wrong-session" }) }),
		/identity does not match/,
	);
});

test("append and an incomplete tail cannot hide external entries or change selected ancestry", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-append-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	await writeFile(file, journal(entry("a", null)));
	assert.equal(await target(file), "https://fixture.test/a");
	await appendFile(file, JSON.stringify(entry("b", "a")));
	await assert.rejects(target(file, "b"), /not persisted/);
	assert.equal(await target(file), "https://fixture.test/a");
	await appendFile(file, "\n");
	assert.equal(await target(file, "b"), "https://fixture.test/b");
	assert.equal(await target(file), "https://fixture.test/a");
	await appendFile(file, JSON.stringify(entry("a", null)) + "\n");
	await assert.rejects(target(file), /duplicate native entry identity/);
});

test("same-size rewrites with restored mtime, truncation, and replacement invalidate published metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-rewrite-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const original = journal(entry("a", null));
	await writeFile(file, original);
	// Whole seconds let the rewrite restore mtime without rounding away nanoseconds.
	const preservedTime = 1_600_000_000;
	await utimes(file, preservedTime, preservedTime);
	assert.equal(await target(file), "https://fixture.test/a");
	const captured = await stat(file, { bigint: true });
	const wrongHeader = original.replace("cache-fixture", "wrong-fixture");
	assert.equal(wrongHeader.length, original.length);
	await writeFile(file, wrongHeader);
	await utimes(file, preservedTime, preservedTime);
	const rewritten = await stat(file, { bigint: true });
	assert.equal(rewritten.mtimeNs, captured.mtimeNs);
	assert.notEqual(rewritten.ctimeNs, captured.ctimeNs);
	await assert.rejects(target(file), /identity does not match/);
	await writeFile(file, original);
	assert.equal(await target(file), "https://fixture.test/a");
	await writeFile(file, JSON.stringify(header) + "\n");
	await assert.rejects(target(file), /not persisted/);
	await writeFile(file, original);
	assert.equal(await target(file), "https://fixture.test/a");
	const replacement = join(root, "replacement.jsonl");
	await writeFile(replacement, journal(entry("b", null)));
	await rename(file, `${file}.captured`);
	await rename(replacement, file);
	assert.equal(await target(file, "b"), "https://fixture.test/b");
	await assert.rejects(target(file), /not persisted/);
});

test("invalid ignored JSON and cyclic ancestry are rejected after a successful cached replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	await writeFile(file, journal(entry("a", null)));
	assert.equal(await target(file), "https://fixture.test/a");
	await appendFile(file, '{"type":"custom","id":"bad","parentId":null,"data":{"ignored":]}}\n');
	await assert.rejects(target(file));
	await writeFile(file, journal(entry("a", "b"), entry("b", "a")));
	await assert.rejects(target(file), /cycle/);
	await writeFile(file, journal(entry("a", null)));
	assert.equal(await target(file), "https://fixture.test/a");
	assert.equal(
		await readFile(file, "utf8"),
		journal(entry("a", null)),
		"replay never rewrites journals",
	);
});

test("cached metadata still rejects a same-size rewrite during replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const original = journal(entry("a", null));
	await writeFile(file, original);
	assert.equal(await target(file), "https://fixture.test/a");
	const selected = {
		...manager(file),
		getHeader() {
			writeFileSync(file, original.replace("cache-fixture", "wrong-fixture"));
			return header;
		},
	};
	await assert.rejects(readBrowserEntries(selected), /changed during replay/);
	await assert.rejects(target(file), /identity does not match/);
});

test("the four-file index evicts older journals without changing replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-bound-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "oldest.jsonl");
	const text = journal(
		{ type: "custom", id: "payload", parentId: null, data: { ignored: "x".repeat(65536) } },
		entry("a", "payload"),
	);
	await writeFile(file, text);
	assert.equal(await target(file), "https://fixture.test/a");
	for (let index = 0; index < 4; index++) {
		const next = join(root, `${index}.jsonl`);
		// These ordered restores deliberately replace the four recent index slots.
		// oxlint-disable-next-line no-await-in-loop
		await writeFile(next, journal(entry("a", null)));
		// Each restore must publish its index before the next one can evict it.
		// oxlint-disable-next-line no-await-in-loop
		await target(next);
	}
	const handle = await open(file, "r");
	const prototype = readRecord(Object.getPrototypeOf(handle));
	const original = prototype.read;
	assert.ok(typeof original === "function");
	await handle.close();
	let bytesRead = 0;
	t.mock.method(
		prototype,
		"read",
		async function (this: FileHandle, ...args: readonly unknown[]) {
			const result: unknown = await Reflect.apply(original, this, args);
			bytesRead += readNumber(readRecord(result).bytesRead);
			return result;
		},
		{},
	);
	assert.equal(await target(file), "https://fixture.test/a");
	assert.ok(bytesRead > 2 * 65536, "an evicted journal must be fully validated again");
});

test("cached metadata cannot certify a rewrite plus growth after stat capture", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-cache-grow-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const original = journal(entry("a", null));
	await writeFile(file, original);
	assert.equal(await target(file), "https://fixture.test/a");
	const handle = await open(file, "r");
	const prototype = readRecord(Object.getPrototypeOf(handle));
	const originalStat = prototype.stat;
	assert.ok(typeof originalStat === "function");
	await handle.close();
	let armed = true;
	t.mock.method(
		prototype,
		"stat",
		async function (this: FileHandle, ...args: readonly unknown[]) {
			const captured: unknown = await Reflect.apply(originalStat, this, args);
			if (armed) {
				armed = false;
				writeFileSync(
					file,
					original.replace("cache-fixture", "wrong-fixture") +
						JSON.stringify(entry("b", "a")) +
						"\n",
				);
			}
			return captured;
		},
		{},
	);
	await assert.rejects(target(file), /identity does not match/);
	assert.equal(armed, false, "the rewrite must land between descriptor capture and metadata reuse");
});
