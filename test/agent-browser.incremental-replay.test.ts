import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readBrowserEntries } from "../extensions/agent-browser/lib/browser-journal.js";
import { BROWSER_TRANSITION_ENTRY } from "../extensions/agent-browser/lib/browser-transcript.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { readRecord } from "./helpers/assertions.js";

function capture(id: string, ref: string) {
	return {
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
					key: "fixture",
					target: { url: "https://fixture.test/" },
					refs: { kind: "replace", snapshotId: id },
				},
			],
		},
		snapshot: { id, refs: { [ref]: { role: "button", name: id } } },
	};
}

async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(join(tmpdir(), "piab-incremental-replay-"));
	// Preserve synthetic journals too; this fixture owns no browser or provider resources.
	t.diagnostic(`Retained synthetic replay journal: ${root}`);
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: 0 });
	const first = manager.appendCustomEntry(BROWSER_TRANSITION_ENTRY, capture("first", "e1"));
	return { root, manager, first };
}

function observeReads(t: TestContext) {
	const nativeOpen = fs.open;
	let bytes = 0;
	t.mock.method(fs, "open", async (...args: Readonly<Parameters<typeof nativeOpen>>) => {
		const handle = await nativeOpen(...args);
		const nativeRead = handle.read.bind(handle);
		t.mock.method(
			handle,
			"read",
			async (buffer: Buffer, offset: number, length: number, position: number) => {
				const result = await nativeRead(buffer, offset, length, position);
				bytes += result.bytesRead;
				return result;
			},
		);
		return handle;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return () => {
		const result = bytes;
		bytes = 0;
		return result;
	};
}

function page(entries: readonly unknown[]) {
	return SessionPageState.fromBranch(entries).get("fixture");
}

test("native append and tree replay read only new metadata bytes, without caching ref bodies", async (t) => {
	const { manager, first } = await fixture(t);
	const reads = observeReads(t);
	const cold = await readBrowserEntries(manager);
	assert.deepEqual(page(cold).refSnapshot?.refIds, ["e1"]);
	const coldBytes = reads();
	assert.ok(coldBytes > 2 * 1024 * 1024, "cold replay validates the published file");
	const warm = await readBrowserEntries(manager);
	assert.deepEqual(page(warm).refSnapshot?.refIds, ["e1"]);
	const warmBytes = reads();
	assert.ok(
		warmBytes < 32 * 1024,
		"unchanged replay must not reread discarded native message bodies",
	);
	const definition = readRecord(readRecord(warm[0]).data).snapshot;
	readRecord(readRecord(definition).refs).e1 = { role: "button", name: "caller mutation" };
	assert.equal(page(await readBrowserEntries(manager)).refSnapshot?.refs?.e1.name, "first");
	reads();
	manager.appendCustomEntry(BROWSER_TRANSITION_ENTRY, capture("second", "e2"));
	assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e2"]);
	const appendBytes = reads();
	assert.ok(appendBytes < 32 * 1024, "ordinary native append scans only its suffix");
	manager.branch(first);
	assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e1"]);
	const treeBytes = reads();
	assert.ok(
		treeBytes < 32 * 1024,
		"tree selection reuses metadata, never the last selected ref map",
	);
	t.diagnostic(JSON.stringify({ coldBytes, warmBytes, appendBytes, treeBytes }));
	assert.equal(
		(await readBrowserEntries(manager, true)).length,
		2,
		"physical replay includes both captures",
	);
});

for (const change of [
	"rotation",
	"same-size edit",
	"truncation",
	"native reseed",
	"locator",
] as const) {
	test(`replay invalidates its structural prefix after ${change}`, async (t) => {
		const { manager, first, root } = await fixture(t);
		const file = manager.getSessionFile();
		assert.ok(file !== undefined);
		const original = await fs.readFile(file, "utf8");
		await readBrowserEntries(manager);
		const reads = observeReads(t);
		const updated = original.replace('"e1"', '"e9"');
		if (change === "rotation") {
			await fs.rename(file, `${file}.retained`);
			await fs.writeFile(file, updated);
		} else if (change === "truncation") {
			await fs.writeFile(
				file,
				[
					manager.getHeader(),
					{
						type: "custom",
						id: first,
						parentId: null,
						customType: BROWSER_TRANSITION_ENTRY,
						data: capture("first", "e9"),
					},
				]
					.map((row) => JSON.stringify(row))
					.join("\n") + "\n",
			);
		} else if (change === "locator") {
			const next = join(root, "new-locator.jsonl");
			await fs.writeFile(next, updated);
			manager.setSessionFile(next);
			manager.branch(first);
		} else {
			await fs.writeFile(file, updated + (change === "native reseed" ? " \n" : ""));
			if (change === "native reseed") {
				manager.setSessionFile(file);
				manager.branch(first);
			}
		}
		assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e9"]);
		if (change !== "truncation") {
			// Each non-truncating variant retains the large user record and must revalidate it.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(reads() > 2 * 1024 * 1024, "changed source must fall back to complete validation");
		}
	});
}

test("a torn native append stays unpublished until its complete record is readable", async (t) => {
	const { manager } = await fixture(t);
	const file = manager.getSessionFile();
	assert.ok(file !== undefined);
	await readBrowserEntries(manager);
	await fs.appendFile(file, " \n");
	const nativeAppend = fsSync.appendFileSync;
	const fault = new Error("fixture: interrupted native append");
	let remainder = "";
	const append = t.mock.method(fsSync, "appendFileSync", (path: string, data: string) => {
		assert.equal(path, file, "fault injection is limited to this synthetic journal");
		assert.equal(typeof data, "string");
		nativeAppend(path, data.slice(0, -2));
		remainder = data.slice(-2);
		throw fault;
	});
	syncBuiltinESMExports();
	assert.throws(
		() => manager.appendCustomEntry(BROWSER_TRANSITION_ENTRY, capture("torn", "e3")),
		(error) => error === fault,
	);
	append.mock.restore();
	syncBuiltinESMExports();
	await assert.rejects(readBrowserEntries(manager), /not persisted/);
	await fs.appendFile(file, remainder);
	assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e3"]);
});

test("an incomplete unrelated tail stays uncommitted, but a completed malformed suffix still fails", async (t) => {
	const { manager } = await fixture(t);
	const file = manager.getSessionFile();
	assert.ok(file !== undefined);
	const original = await fs.readFile(file);
	await readBrowserEntries(manager);
	await fs.appendFile(file, '{"broken":');
	assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e1"]);
	await fs.appendFile(file, "bad}\n");
	await assert.rejects(readBrowserEntries(manager), /Parser/);
	await fs.writeFile(file, original);
	assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e1"]);
});

test(
	"a genuine journal open error propagates and discards the previous index",
	{ skip: process.platform === "win32" || process.getuid?.() === 0 },
	async (t) => {
		const { manager } = await fixture(t);
		const file = manager.getSessionFile();
		assert.ok(file !== undefined);
		await readBrowserEntries(manager);
		await fs.chmod(file, 0o000);
		try {
			await assert.rejects(readBrowserEntries(manager), { code: "EACCES" });
		} finally {
			await fs.chmod(file, 0o600);
		}
		const reads = observeReads(t);
		assert.deepEqual(page(await readBrowserEntries(manager)).refSnapshot?.refIds, ["e1"]);
		assert.ok(reads() > 2 * 1024 * 1024, "a failed replay must not leave an admitted prefix");
	},
);
