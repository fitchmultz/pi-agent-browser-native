import { readArray, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	BROWSER_TRANSITION_ENTRY,
	getBrowserRecord,
	applyArtifactChanges,
} from "../extensions/agent-browser/lib/browser-transcript.js";
import {
	appendBrowserRecord,
	captureBrowserBranch,
	projectJson,
	readBrowserEntries,
	scanJournalMetadata,
} from "../extensions/agent-browser/lib/browser-journal.js";
import { convertBrowserSession } from "../extensions/agent-browser/lib/browser-session-conversion.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { restoreAttachedSessionKeysFromBranch } from "../extensions/agent-browser/lib/orchestration/extension-attachment-replay.js";
import {
	createExtensionHarness,
	createShortPrivateSocketDir,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

function manager(file: string, leaf: string | null) {
	return {
		getSessionFile: () => file,
		getHeader: () => ({ id: "fixture-session" }),
		getSessionId: () => "fixture-session",
		getLeafId: () => leaf,
		getBranch() {
			throw new Error("Replay must not request eager branches.");
		},
		getEntries() {
			throw new Error("Replay must not request all payloads.");
		},
		getEntry() {
			throw new Error("Official replay must token-load only the winning definition.");
		},
	};
}

function replaceOpenJournal(file: string, replacement: string): void {
	// Renaming over an open target is not portable to Windows. Each fixture replaces only once
	// in a fresh private directory, so the same-directory backup name is vacant. Keep that exact
	// file for the captured reader, then publish a different inode at the original locator.
	renameSync(file, `${file}.captured`);
	renameSync(replacement, file);
}

async function records(file: string): Promise<Array<Record<string, unknown>>> {
	return (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => readRecord(JSON.parse(line)));
}

test("normal resume reads legacy tool receipts without changing the journal or locator", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-legacy-resume-"));
	try {
		const file = join(root, "original.jsonl");
		const entries = [
			{
				type: "message",
				id: "legacy-capture",
				parentId: null,
				message: {
					role: "toolResult",
					toolName: "agent_browser",
					toolCallId: "capture",
					isError: false,
					content: [{ type: "text", text: "Original native observation" }],
					details: {
						sessionName: "shared",
						namespace: "team",
						args: ["snapshot", "-i"],
						command: "snapshot",
						sessionConfirmActions: "",
						sessionTabTarget: { url: "https://fixture.test/#approved" },
						refSnapshot: {
							refIds: ["e1"],
							refs: { e1: { role: "button", name: "Continue" } },
							target: { url: "https://fixture.test/#approved" },
						},
						readConfirmation: {
							id: "capture-id",
							state: "cleared",
							sessionName: "shared",
							namespace: "team",
							source: "native-guarded-action",
							command: "snapshot",
							action: "snapshot",
							refSnapshotFresh: true,
						},
					},
				},
			},
			{
				type: "custom",
				customType: BROWSER_TRANSITION_ENTRY,
				id: "other-branch",
				parentId: "legacy-capture",
				data: {
					toolCallId: "unresolved",
					isError: false,
					details: { sessionName: "shared", namespace: "team", sessionTabTargetUnknown: true },
				},
			},
		];
		const original = Buffer.from(
			[{ type: "session", version: 3, id: "fixture-session" }, ...entries]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		await writeFile(file, original);
		const selected = manager(file, "legacy-capture");
		const branch = await readBrowserEntries(selected);
		const page = SessionPageState.fromBranch(branch).get("team\0shared");
		assert.equal(page.tabTarget?.url, "https://fixture.test/#approved");
		assert.deepEqual(page.refSnapshot?.refIds, ["e1"]);
		assert.equal(page.refSnapshot.refs?.e1.name, "Continue");
		assert.equal(page.confirmActions, "", "explicit empty native confirmation remains selected");
		assert.equal(
			SessionPageState.fromBranch(branch).getReadConfirmation("team\0shared")?.refSnapshotFresh,
			true,
		);
		const unresolved = SessionPageState.fromBranch(
			await readBrowserEntries(manager(file, "other-branch")),
		).get("team\0shared");
		assert.equal(unresolved.tabTargetUnknown, true);
		assert.equal(unresolved.refSnapshot, undefined);
		const memory = {
			...selected,
			getSessionFile: (): string | undefined => undefined,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
			getEntries: () => entries,
		};
		const inMemory = SessionPageState.fromBranch(await readBrowserEntries(memory)).get(
			"team\0shared",
		);
		assert.deepEqual(inMemory.refSnapshot, page.refSnapshot);
		assert.equal(inMemory.confirmActions, "");
		assert.equal(entries[0].message?.details.refSnapshot.refIds[0], "e1");
		assert.equal(
			Object.hasOwn(entries[0], "data"),
			false,
			"normalization never mutates native entries",
		);
		assert.deepEqual(await readFile(file), original);
		assert.equal(selected.getSessionFile(), file);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy replay cannot downgrade native event validation or grant inherited cleanup leases", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-legacy-ownership-"));
	try {
		const file = join(root, "fork.jsonl");
		const lease = {
			type: "custom",
			customType: "agent-browser-script-session",
			id: "inherited",
			parentId: null,
			data: { sessionName: "old-browser", cleanup: "active", launchAttempted: true },
		};
		await writeFile(
			file,
			[{ type: "session", id: "fixture-session", parentSession: "/archive/parent.jsonl" }, lease]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const fork = {
			...manager(file, lease.id),
			getHeader: () => ({ id: "fixture-session", parentSession: "/archive/parent.jsonl" }),
		};
		const branch = await readBrowserEntries(fork);
		assert.equal(
			readRecord(getBrowserRecord(branch[0])?.event.state.scriptLease).ownerSessionId,
			undefined,
			"unknown original ownership stays unknown on an ordinary fork",
		);
		const owned = {
			...lease,
			id: "known-owner",
			parentId: lease.id,
			data: { ...lease.data, ownerSessionId: "original-parent" },
		};
		appendFileSync(file, `${JSON.stringify(owned)}\n`);
		const ownedBranch = await readBrowserEntries({ ...fork, getLeafId: () => owned.id });
		assert.equal(
			readRecord(getBrowserRecord(ownedBranch[1])?.event.state.scriptLease).ownerSessionId,
			"original-parent",
			"an explicit original owner is retained rather than rebound to the fork",
		);
		const unrelated = {
			type: "custom",
			customType: "other-extension",
			id: "other-event",
			parentId: owned.id,
			data: { event: { kind: "status" } },
		};
		appendFileSync(file, `${JSON.stringify(unrelated)}\n`);
		const independent = await readBrowserEntries({ ...fork, getLeafId: () => unrelated.id });
		assert.equal(
			readRecord(getBrowserRecord(independent[1])?.event.state.scriptLease).ownerSessionId,
			"original-parent",
			"another extension's event field does not acquire browser schema semantics",
		);
		const invalid = {
			type: "custom",
			customType: BROWSER_TRANSITION_ENTRY,
			id: "invalid",
			parentId: owned.id,
			data: {
				event: { version: 2 },
				details: { sessionName: "old-browser", sessionTabTarget: { url: "https://forged.test/" } },
				isError: false,
			},
		};
		appendFileSync(file, `${JSON.stringify(invalid)}\n`);
		await assert.rejects(
			readBrowserEntries({ ...fork, getLeafId: () => invalid.id }),
			/Invalid browser event/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const mode of [
	"direct",
	"batch",
	"batch-failed",
	"batch-diagnostic-failed",
	"failed",
	"unconfirmed",
	"page-data",
] as const) {
	test(`legacy native confirmed close retires page and attachment state (${mode})`, async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-legacy-close-"));
		try {
			const file = join(root, "original.jsonl");
			const receipt = {
				confirmed: mode !== "unconfirmed",
				action: "close",
				result: { success: mode !== "failed", data: { closed: true } },
			};
			const details = mode.startsWith("batch")
				? {
						command: "batch",
						args: ["batch"],
						batchSteps: [
							{ command: ["confirm", "close-id"], success: mode !== "batch-failed", data: receipt },
							...(mode === "batch-diagnostic-failed"
								? [
										{
											command: ["get", "title"],
											success: false,
											lifecycle: { effectiveLaunch: { browserLaunched: false } },
										},
									]
								: []),
						],
					}
				: {
						command: mode === "page-data" ? "eval" : "confirm",
						args: mode === "page-data" ? ["eval", "--stdin"] : ["confirm", "close-id"],
						data: receipt,
					};
			const entries = [
				{
					type: "message",
					id: "capture",
					parentId: null,
					message: {
						role: "toolResult",
						toolName: "agent_browser",
						toolCallId: "capture",
						isError: false,
						details: {
							sessionName: "shared",
							namespace: "team",
							args: ["snapshot", "-i"],
							command: "snapshot",
							attachedBrowserSession: true,
							sessionTabTarget: { url: "https://fixture.test/" },
							refSnapshot: { refIds: ["e1"], target: { url: "https://fixture.test/" } },
						},
					},
				},
				{
					type: "message",
					id: "decision",
					parentId: "capture",
					message: {
						role: "toolResult",
						toolName: "agent_browser",
						toolCallId: "decision",
						isError:
							mode === "failed" || mode === "batch-failed" || mode === "batch-diagnostic-failed",
						details: { ...details, sessionName: "shared", namespace: "team" },
					},
				},
			];
			const original = Buffer.from(
				[{ type: "session", version: 3, id: "fixture-session" }, ...entries]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			await writeFile(file, original);
			const branch = await readBrowserEntries(manager(file, "decision"));
			const closed = mode === "direct" || mode === "batch" || mode === "batch-diagnostic-failed";
			const page = SessionPageState.fromBranch(branch).get("team\0shared");
			assert.equal(page.tabTarget?.url, closed ? undefined : "https://fixture.test/");
			assert.deepEqual(page.refSnapshot?.refIds, closed ? undefined : ["e1"]);
			assert.equal(restoreAttachedSessionKeysFromBranch(branch).has("team\0shared"), !closed);
			assert.deepEqual(await readFile(file), original);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("published replay retains its captured branch while a new leaf is appended", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-replay-boundary-"));
	try {
		const file = join(root, "session.jsonl");
		const header = { type: "session", id: "fixture-session" };
		const entry = (id: string) => ({
			type: "custom",
			customType: BROWSER_TRANSITION_ENTRY,
			id,
			parentId: null,
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
		});
		const before = entry("before"),
			after = entry("after");
		await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(before)}\n`);
		let leaf = before.id,
			appended = false;
		const selected = {
			...manager(file, leaf),
			getLeafId: () => leaf,
			getHeader() {
				if (!appended) {
					// Identity validation follows the awaited scan. Publish and select another
					// root here so both file projection and optional native ancestry must agree.
					appendFileSync(file, `${JSON.stringify(after)}\n`);
					leaf = after.id;
					appended = true;
				}
				return header;
			},
		};
		const first = await readBrowserEntries(selected);
		assert.equal(appended, true, "the fixture must reach the concurrent publication window");
		assert.equal(
			SessionPageState.fromBranch(first).get("shared").tabTarget?.url,
			"https://fixture.test/before",
		);
		const next = await readBrowserEntries(selected);
		assert.equal(
			SessionPageState.fromBranch(next).get("shared").tabTarget?.url,
			"https://fixture.test/after",
			"the next replay observes the newly published selection",
		);
		leaf = "missing";
		await assert.rejects(
			readBrowserEntries(selected),
			/Selected journal entry missing is not persisted/,
		);
		appendFileSync(file, JSON.stringify(entry("uncommitted")));
		leaf = "uncommitted";
		await assert.rejects(
			readBrowserEntries(selected),
			/Selected journal entry uncommitted is not persisted/,
			"an unterminated live entry remains unpublished",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("native branch admission permits descendants and siblings without reading bodies, but validates identity and ancestry", async () => {
	const entries = new Map<string, { id: string; parentId: unknown }>([
		["a", { id: "a", parentId: null }],
		["first", { id: "first", parentId: "a" }],
		["sibling", { id: "sibling", parentId: "a" }],
		["b", { id: "b", parentId: null }],
	]);
	for (const entry of entries.values()) {
		Object.defineProperty(entry, "data", {
			get() {
				throw new Error("Admission must not hydrate bodies.");
			},
		});
	}
	let leaf: string | null = "a",
		sessionId = "fixture",
		generationCurrent = true;
	const native = {
		getSessionId: () => sessionId,
		getHeader: () => ({ id: "fixture-session" }),
		getLeafId: () => leaf,
		getEntry: (id: string) => entries.get(id),
		getSessionFile: (): string | undefined => {
			/* This ancestry fixture has no persisted journal. */ return;
		},
		getEntries() {
			throw new Error("No eager physical scan.");
		},
		getBranch() {
			throw new Error("No eager branch scan.");
		},
	};
	const branch = captureBrowserBranch(native, () => generationCurrent);
	assert.equal(branch.isCurrent(), true);
	generationCurrent = false;
	assert.equal(
		branch.isCurrent(),
		false,
		"a validated prefix cannot outlive its captured generation",
	);
	generationCurrent = true;
	leaf = "first";
	assert.equal(branch.isCurrent(), true);
	leaf = "sibling";
	assert.equal(
		branch.isCurrent(),
		true,
		"another append below the original anchor remains admissible",
	);
	leaf = "b";
	assert.equal(branch.isCurrent(), false);
	leaf = "a";
	sessionId = "replacement";
	assert.equal(
		branch.isCurrent(),
		false,
		"matching entry IDs cannot substitute for native session identity",
	);
	sessionId = "fixture";
	for (const broken of [
		{ id: "bad", parentId: "missing" },
		{ id: "bad", parentId: "bad" },
		{ id: "bad", parentId: 7 },
	]) {
		entries.set("bad", broken);
		leaf = "bad";
		// Missing, cyclic and malformed parents must each fail closed; every variant is asserted.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.throws(
			() => branch.isCurrent(),
			/ancestry/,
			"invalid native ancestry remains a validation error",
		);
	}
	leaf = null;
	const empty = captureBrowserBranch(native, () => true);
	leaf = "b";
	assert.equal(
		empty.isCurrent(),
		false,
		"an empty anchor cannot admit an independent pre-existing root",
	);
	leaf = null;
	const record = {
		event: {
			version: 1 as const,
			phase: "begin" as const,
			operationId: "empty",
			toolCallId: "empty",
			commandIndex: 0,
			isError: true,
			state: {},
		},
	};
	assert.equal(
		await appendBrowserRecord(
			native,
			() => {
				leaf = "a";
			},
			record,
			empty,
		),
		true,
		"an empty in-memory branch advances only from its own synchronous append",
	);
	leaf = "sibling";
	assert.equal(empty.isCurrent(), true);
});

test("captured admission validates its prefix once and bounds subsequent work by the appended suffix", () => {
	const entries = new Map(
		Array.from({ length: 781 }, (_, index) => {
			const id = `e${index}`;
			return [id, { id, parentId: index > 0 ? `e${index - 1}` : null }] as const;
		}),
	);
	let leaf = "e780",
		reads = 0;
	const native = {
		getSessionId: () => "fixture",
		getLeafId: () => leaf,
		getSessionFile: (): string | undefined => {
			/* This ancestry fixture has no persisted journal. */ return;
		},
		getEntry(id: string) {
			reads += 1;
			return entries.get(id);
		},
	};
	const branch = captureBrowserBranch(native, () => true);
	assert.equal(branch.isCurrent(), true);
	assert.ok(reads >= 781, "even leaf === anchor must validate the complete initial prefix");
	reads = 0;
	for (let index = 0; index < 20; index++) {
		// Exhaustive fixture variant (index < 20): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(branch.isCurrent(), true);
	}
	assert.ok(
		reads <= 40,
		`unchanged selection repeatedly traversed the prefix (${reads} indexed reads)`,
	);
	reads = 0;
	for (let index = 0; index < 20; index++) {
		const id = `append${index}`;
		entries.set(id, { id, parentId: leaf });
		leaf = id;
		// Exhaustive fixture variant (index < 20): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(branch.isCurrent(), true);
	}
	assert.ok(
		reads <= 80,
		`ordinary appends repeatedly traversed validated history (${reads} indexed reads)`,
	);
	entries.set("sibling", { id: "sibling", parentId: "e780" });
	leaf = "sibling";
	assert.equal(branch.isCurrent(), true, "cached descendants do not narrow the original anchor");
	// A native reseed can reuse IDs but replaces indexed entry objects.
	entries.set("sibling", { id: "sibling", parentId: "missing" });
	assert.throws(() => branch.isCurrent(), /ancestry/);
});

test("equal-leaf admission does not bypass malformed, missing or cyclic captured prefixes", () => {
	for (const entries of [
		new Map([["anchor", { id: "anchor", parentId: "missing" }]]),
		new Map([
			["anchor", { id: "anchor", parentId: "parent" }],
			["parent", { id: "parent", parentId: "anchor" }],
		]),
		new Map([["anchor", { id: "wrong-id", parentId: null }]]),
		new Map([["anchor", { id: "anchor", parentId: 7 }]]),
	]) {
		const native = {
			getSessionId: () => "fixture",
			getLeafId: () => "anchor",
			getSessionFile: (): string | undefined => {
				/* This ancestry fixture has no persisted journal. */ return;
			},
			getEntry: (id: string) => entries.get(id),
		};
		const branch = captureBrowserBranch(native, () => true);
		// Every invalid captured ancestry variant must fail initial and repeated admission.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.throws(() => branch.isCurrent(), /ancestry/);
		// Every invalid captured ancestry variant must fail initial and repeated admission.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.throws(
			() => branch.isCurrent(),
			/ancestry/,
			"failed validation cannot certify a prefix",
		);
	}
});

for (const change of ["locator", "replace", "truncate"] as const) {
	test(`native ${change} renews captured admission with the same session identity`, async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-admission-reseed-"));
		try {
			const file = join(root, "session.jsonl"),
				replacement = join(root, "replacement.jsonl");
			const header = {
				type: "session",
				version: 3,
				id: "fixture-session",
				cwd: root,
				timestamp: "2026-10-01T00:00:00.000Z",
			};
			const entry = (id: string, parentId: string | null) => ({
				type: "custom",
				customType: "fixture",
				id,
				parentId,
				timestamp: header.timestamp,
				data: {},
			});
			const bytes = (rows: readonly unknown[]) =>
				rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
			await writeFile(file, bytes([header, entry("root", null), entry("anchor", "root")]));
			const native = SessionManager.open(file, root);
			const branch = captureBrowserBranch(native, () => true);
			assert.equal(branch.isCurrent(), true);
			assert.equal(branch.isCurrent(), true);
			await writeFile(
				replacement,
				bytes(
					change === "truncate"
						? [header]
						: [header, entry("root", "missing"), entry("anchor", "root")],
				),
			);
			if (change === "locator") {
				native.setSessionFile(replacement);
			} else {
				renameSync(replacement, file);
				native.setSessionFile(file);
			}
			assert.equal(
				native.getSessionId(),
				branch.sessionId,
				"the native reseed retains the UUID, not its indexed objects",
			);
			if (change === "truncate") {
				// Exhaustive fixture variant (change === "truncate"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(branch.isCurrent(), false, "the selected entry has been withdrawn");
			} else {
				// Exhaustive fixture variant (change === "truncate"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.throws(
					() => branch.isCurrent(),
					/ancestry/,
					"equal entry IDs cannot certify a replacement prefix",
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

for (const change of ["replace", "truncate"] as const) {
	test(`published replay still rejects journal ${change} after capturing its selected prefix`, async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-replay-replacement-"));
		try {
			const file = join(root, "session.jsonl");
			const header = { type: "session", id: "fixture-session" };
			const original = `${JSON.stringify(header)}\n${JSON.stringify({ type: "label", id: "anchor", parentId: null })}\n`;
			await writeFile(file, original);
			const captured = await stat(file);
			let changed = false;
			const native = {
				...manager(file, "anchor"),
				getHeader() {
					if (!changed) {
						if (change === "replace") {
							writeFileSync(`${file}.replacement`, `${JSON.stringify(header)}\n`);
							replaceOpenJournal(file, `${file}.replacement`);
						} else {
							writeFileSync(file, `${JSON.stringify(header)}\n`);
						}
						changed = true;
					}
					return header;
				},
			};
			await assert.rejects(
				readBrowserEntries(native),
				/replaced or truncated/,
				"native ancestry is not a durable file receipt",
			);
			assert.equal(changed, true, "the fixture must reach the captured-file boundary");
			assert.equal(await readFile(file, "utf8"), `${JSON.stringify(header)}\n`);
			if (change === "replace") {
				// The replacement must preserve the held prefix while changing the published file identity.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(await readFile(`${file}.captured`, "utf8"), original);
				const published = await stat(file);
				// The replacement must preserve the held prefix while changing the published file identity.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.notDeepEqual([published.dev, published.ino], [captured.dev, captured.ino]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

for (const earlierHandler of [false, true]) {
	for (const boundary of ["begin", "finish", "observation", "host-finish"] as const) {
		test(
			`branch selection during ${boundary} journal preparation cannot publish old state onto B (${earlierHandler ? "earlier awaited handler" : "immediate event"})`,
			{ concurrency: false, timeout: 30_000 },
			async () => {
				const root = await mkdtemp(join(tmpdir(), "piab-append-branch-"));
				try {
					const file = join(root, "session.jsonl"),
						log = join(root, "commands.jsonl");
					await writeFakeAgentBrowserBinary(
						root,
						`const fs=require('node:fs'),args=process.argv.slice(2),stdin=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');
process.stdout.write(JSON.stringify({success:true,data:args.includes('eval')?{result:'x'.repeat(24000)}:{url:'https://fixture.test/page'}}));`,
					);
					await withPatchedEnv(
						{
							PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
							AGENT_BROWSER_SESSION: undefined,
							AGENT_BROWSER_NAMESPACE: undefined,
						},
						async () => {
							const branch = (id: string) => [
								{
									type: "message",
									id,
									parentId: null,
									message: { role: "user", content: [{ type: "text", text: `Branch ${id}` }] },
								},
							];
							let armed = false,
								selected = false;
							let tree: Promise<void> | undefined;
							let releaseEarlierHandler!: () => void;
							const earlierHandlerHeld = new Promise<void>((resolve) => {
								releaseEarlierHandler = resolve;
							});
							let earlierHandlerEntered = false;
							const harness = createExtensionHarness({
								cwd: root,
								sessionFile: file,
								branch: branch("a"),
								onAppendEntry(type, data) {
									if (type !== BROWSER_TRANSITION_ENTRY) {
										return;
									}
									const phase = readRecord(readRecord(data).event).phase;
									if (phase === (boundary === "observation" ? "finish" : "begin")) {
										armed = true;
									}
								},
							});
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "new" },
								harness.ctx,
							);
							if (earlierHandler) {
								(
									harness.handlers.get("session_tree") ??
									// Exhaustive fixture variant (earlierHandler): this selected path must satisfy its own contract.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.fail("tree handler must be registered")
								).unshift(async () => {
									earlierHandlerEntered = true;
									await earlierHandlerHeld;
								});
							}
							const getSessionFile = harness.ctx.sessionManager.getSessionFile;
							Object.defineProperty(harness.ctx.sessionManager, "getSessionFile", {
								value: () => {
									if (armed && !selected) {
										selected = true;
										// Native tree navigation selects its leaf before emitting the awaited event.
										queueMicrotask(() => {
											harness.setBranch(branch("b"));
											tree = runExtensionEvent(
												harness.handlers,
												"session_tree",
												{ newLeafId: "b", oldLeafId: "a" },
												harness.ctx,
											);
										});
									}
									return getSessionFile();
								},
							});
							armed = boundary === "begin";
							const invokeBoundary = () => {
								switch (boundary) {
									case "observation":
										return executeRegisteredTool(
											harness.getTool("agent_browser_code") ??
												// Exhaustive fixture variant ("observation"): this selected path must satisfy its own contract.
												// oxlint-disable-next-line node-test/no-conditional-assertion
												assert.fail("code tool must be registered"),
											harness.ctx,
											{
												session: "append-race",
												code: 'await browser({args:["get","url"]}); emit("x".repeat(24000));',
											},
										);
									case "host-finish":
										return executeRegisteredTool(
											harness.getTool("agent_browser_electron") ??
												// Exhaustive fixture variant ("host-finish"): this selected path must satisfy its own contract.
												// oxlint-disable-next-line node-test/no-conditional-assertion
												assert.fail("electron tool must be registered"),
											harness.ctx,
											{ action: "probe" },
										);
									case "begin":
									case "finish":
										return executeRegisteredTool(harness.tool, harness.ctx, {
											args: ["--session", "append-race", "eval", "--stdin"],
											stdin: "MUTATE_FIXTURE",
										});
								}
							};
							const result = await invokeBoundary();
							const resultDetails = readRecord(result.details);
							if (earlierHandler) {
								// Exhaustive fixture variant (earlierHandler): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									earlierHandlerEntered,
									true,
									"the earlier extension is still awaiting work before this extension sees the tree event",
								);
							}
							releaseEarlierHandler();
							await tree;
							assert.equal(selected, true, "navigation must reach the awaited publication window");
							assert.deepEqual(
								harness.ctx.sessionManager.getBranch().map((entry) => readRecord(entry).id),
								["b"],
								"the old caller cannot append a begin, finish or artifact receipt beneath B",
							);
							const mutations = (await readInvocationLog(log)).filter(
								(row) => row.stdin === "MUTATE_FIXTURE",
							);
							if (boundary === "begin") {
								// Exhaustive fixture variant (boundary === "begin"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(resultDetails.browserStatePersistence, "begin-unconfirmed");
								// Exhaustive fixture variant (boundary === "begin"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(mutations.length, 0, "stale intent never authorizes dispatch");
							} else if (boundary === "finish") {
								// Exhaustive fixture variant (boundary === "finish"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(resultDetails.browserStatePersistence, "finish-unconfirmed");
								// Exhaustive fixture variant (boundary === "finish"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(mutations.length, 1, "the completed effect is not retried");
								// Exhaustive fixture variant (boundary === "finish"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									readRecord(
										JSON.parse(await readFile(readString(resultDetails.fullOutputPath), "utf8")),
									).result,
									"x".repeat(24000),
									"the stale caller retains its full observation",
								);
								const all = (await records(file)).filter((entry) => entry.type !== "session");
								// Exhaustive fixture variant (boundary === "finish"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									all.map(getBrowserRecord).filter((record) => record?.event.phase === "begin")
										.length,
									1,
								);
								// Exhaustive fixture variant (boundary === "finish"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									all.map(getBrowserRecord).some((record) => record?.event.phase === "finish"),
									false,
								);
								// Exhaustive fixture variant (boundary === "finish"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									SessionPageState.fromBranch(all).get("append-race").tabTargetUnknown,
									true,
									"A keeps its unfinished intent",
								);
							} else if (boundary === "observation") {
								// Exhaustive fixture variant (boundary === "observation"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(result.isError, false, JSON.stringify(result));
								// Exhaustive fixture variant (boundary === "observation"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(resultDetails.data, "x".repeat(24000));
								const observation = readRecord(
									JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "{}"),
								);
								// Exhaustive fixture variant (boundary === "observation"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									readRecord(
										JSON.parse(await readFile(readString(observation.observationPath), "utf8")),
									).data,
									"x".repeat(24000),
								);
							} else {
								// Exhaustive fixture variant (boundary === "observation"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									resultDetails.browserStatePersistence,
									"finish-unconfirmed",
									"host completion does not claim a durable finish after branch withdrawal",
								);
							}
							await runExtensionEvent(
								harness.handlers,
								"session_shutdown",
								{ reason: "quit" },
								harness.ctx,
							);
						},
					);
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			},
		);
	}
}

for (const memory of [false, true]) {
	test(
		`sessionless observations do not require browser replay publication (${memory ? "in-memory" : "unpublished"})`,
		{ concurrency: false },
		async (t) => {
			const root = await mkdtemp(join(tmpdir(), "piab-sessionless-receipt-"));
			try {
				const log = join(root, "commands.jsonl"),
					file = join(root, "session.jsonl");
				await writeFakeAgentBrowserBinary(
					root,
					`const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args})+'\\n');
const data=args.includes('skills')?(args.includes('get')?{content:'x'.repeat(60000),password:'fixture-output-secret'}:{skills:['core']}):args.includes('read')?{content:'Fetched page',source:'http',url:'https://fixture.test/content'}:args.includes('url')?{url:'https://fixture.test/page'}:{active:false,runtime:null};
process.stdout.write(JSON.stringify({success:true,data}));`,
				);
				await withPatchedEnv(
					{
						PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
						PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
						AGENT_BROWSER_SESSION: undefined,
						AGENT_BROWSER_NAMESPACE: undefined,
					},
					async () => {
						const harness = createExtensionHarness({
							cwd: root,
							sessionFile: memory ? null : file,
						});
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						if (!memory) {
							await rm(file);
						}
						const commands = [
							["skills", "list"],
							["session", "info"],
							["read", "https://fixture.test/content"],
						];
						for (const args of commands) {
							// Sessionless commands share the invocation journal; finish each subtest before the next command.
							// oxlint-disable-next-line no-await-in-loop
							await t.test(args.join(" "), async () => {
								const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
								const resultDetails = readRecord(result.details);
								assert.equal(result.isError, false, JSON.stringify(result));
								assert.equal(resultDetails.browserStatePersistence, undefined);
							});
						}
						await t.test("oversized output and selected readback", async () => {
							const selectedPath = join(root, "selected-output.json");
							const large = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["skills", "get", "core", "--full"],
								outputPath: selectedPath,
							});
							const largeDetails = readRecord(large.details);
							assert.equal(large.isError, false, JSON.stringify(large));
							assert.equal(largeDetails.browserStatePersistence, undefined);
							assert.equal(typeof largeDetails.fullOutputPath, "string");
							const full = await readFile(readString(largeDetails.fullOutputPath), "utf8");
							assert.equal(readRecord(JSON.parse(full)).content, "x".repeat(60000));
							assert.doesNotMatch(readString(full), /fixture-output-secret/);
							assert.deepEqual(
								readRecord(JSON.parse(await readFile(selectedPath, "utf8"))),
								readRecord(JSON.parse(full)),
								"selected output retains the complete redacted data",
							);
						});
						const observations = await readInvocationLog(log);
						assert.equal(
							observations.length,
							commands.length + 1,
							"large and small sessionless observations dispatch no browser helpers",
						);
						observations
							.slice(0, commands.length)
							.forEach((row, index) =>
								assert.deepEqual(
									readArray(row.args).map(readString).slice(-commands[index].length),
									commands[index],
								),
							);
						const status = await executeRegisteredTool(
							harness.getTool("agent_browser_electron") ??
								// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.fail("electron tool must be registered"),
							harness.ctx,
							{ action: "status", launchId: "missing" },
						);
						const statusDetails = readRecord(status.details);
						assert.equal(
							statusDetails.failureCategory,
							"validation-error",
							"local host validation keeps its own result without a replay write",
						);
						assert.equal(statusDetails.browserStatePersistence, undefined);
						assert.equal(
							harness.appendedEntries.length,
							0,
							"private observations do not invent replay state",
						);
						const browser = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "memory-boundary", "get", "url"],
						});
						const browserDetails = readRecord(browser.details);
						if (memory) {
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(browser.isError, false, JSON.stringify(browser));
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								browserDetails.browserStatePersistence,
								undefined,
								"direct in-memory state makes no durability claim",
							);
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								harness.appendedEntries.filter(
									(entry) =>
										getBrowserRecord({ type: "custom", ...entry })?.event.phase === "begin",
								).length,
								1,
							);
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								(await readBrowserEntries(harness.ctx.sessionManager)).length,
								harness.appendedEntries.length,
								"public in-memory ancestry retains canonical state",
							);
							const beforeCode = (await readInvocationLog(log)).length;
							const code = await executeRegisteredTool(
								harness.getTool("agent_browser_code") ??
									// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.fail("code tool must be registered"),
								harness.ctx,
								{ code: 'await browser({args:["eval","--stdin"],stdin:"NEVER_DISPATCH"});' },
							);
							const codeDetails = readRecord(code.details);
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(code.isError, true);
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(codeDetails.failureCategory, "validation-error");
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								(await readInvocationLog(log)).length,
								beforeCode,
								"code requires published intent even in an in-memory session",
							);
						} else {
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								browserDetails.browserStatePersistence,
								"begin-unconfirmed",
								"a named but unpublished persistent session still refuses dispatch",
							);
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								(await readInvocationLog(log)).some((row) =>
									readArray(row.args).map(readString).includes("memory-boundary"),
								),
								false,
							);
							// Exhaustive fixture variant (memory): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(harness.appendedEntries.length, 0);
						}
						await runExtensionEvent(
							harness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							harness.ctx,
						);
					},
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

test("converter CLI retains the published copy's receipt when its optional receipt path is occupied", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-conversion-cli-"));
	try {
		const source = join(root, "source.jsonl"),
			destination = join(root, "copy.jsonl"),
			receiptPath = join(root, "receipt.json");
		const bytes = `${JSON.stringify({ type: "session", version: 3, id: "fixture-session", cwd: root })}\n`;
		await writeFile(source, bytes, { mode: 0o600 });
		await writeFile(receiptPath, "retained receipt");
		const cli = join(process.cwd(), "scripts/convert-browser-session.mjs");
		const args = [
			cli,
			"--source",
			source,
			"--output",
			destination,
			"--confirm-stopped",
			"--receipt",
			receiptPath,
		];
		const converted = spawnSync(process.execPath, args, { encoding: "utf8" });
		assert.equal(converted.status, 1, "optional receipt failure remains visible");
		assert.match(readString(converted.stderr), /EEXIST/);
		const receipt = readRecord(JSON.parse(converted.stdout));
		assert.equal(receipt.sourceSha256, createHash("sha256").update(bytes).digest("hex"));
		assert.equal(
			receipt.destinationSha256,
			createHash("sha256")
				.update(await readFile(destination))
				.digest("hex"),
		);
		assert.equal(receipt.sessionId, "fixture-session");
		assert.equal(await readFile(source, "utf8"), bytes);
		assert.equal(await readFile(receiptPath, "utf8"), "retained receipt");
		const occupied = spawnSync(process.execPath, args, { encoding: "utf8" });
		assert.equal(occupied.status, 1);
		assert.match(readString(occupied.stderr), /occupied/);
		assert.equal(occupied.stdout, "", "a refusal does not invent a new conversion receipt");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const repair of ["append", "rewrite"] as const) {
	test(
		`a repaired ${repair} publishes dirty entries and a new matching begin without retrying the failed effect`,
		{ concurrency: false },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "piab-dirty-receipt-"));
			try {
				const log = join(root, "commands.jsonl"),
					file = join(root, "session.jsonl");
				await writeFakeAgentBrowserBinary(
					root,
					`const fs=require('node:fs'); const args=process.argv.slice(2); const stdin=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');
process.stdout.write(JSON.stringify({success:true,data:{url:'https://fixture.test/unchanged'}}));`,
				);
				await withPatchedEnv(
					{
						PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
						AGENT_BROWSER_SESSION: undefined,
						AGENT_BROWSER_NAMESPACE: undefined,
					},
					async () => {
						let dirty: string | undefined;
						let failed = false;
						const harness = createExtensionHarness({
							cwd: root,
							sessionFile: file,
							onAppendEntry(type, data) {
								if (type !== BROWSER_TRANSITION_ENTRY) {
									return;
								}
								if (!failed && readRecord(readRecord(data).event).phase === "begin") {
									failed = true;
									dirty = JSON.stringify(
										harness.ctx.sessionManager.getEntry(
											readString(harness.ctx.sessionManager.getLeafId()),
										),
									);
									throw new Error("accepted native entry could not be persisted");
								}
								if (dirty !== undefined) {
									if (repair === "append") {
										appendFileSync(file, `\n${dirty}\n`);
									} else {
										writeFileSync(`${file}.repair`, `${readFileSync(file, "utf8")}\n${dirty}\n`);
										replaceOpenJournal(file, `${file}.repair`);
									}
									dirty = undefined;
								}
							},
						});
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						const publishedPrefix = await readFile(file);
						const captured = await stat(file);
						const prefix = ["--session", "dirty-receipt"];
						const refused = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...prefix, "eval", "--stdin"],
							stdin: "NEVER_RETRY_MUTATION",
						});
						const refusedDetails = readRecord(refused.details);
						assert.equal(
							refusedDetails.browserStatePersistence,
							"begin-unconfirmed",
							JSON.stringify(refused),
						);
						assert.deepEqual(await readFile(file), publishedPrefix);
						assert.equal(
							(await readInvocationLog(log)).length,
							0,
							"unconfirmed begin never dispatches",
						);
						const inspected = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...prefix, "get", "url"],
						});
						assert.equal(inspected.isError, false, JSON.stringify(inspected));
						assert.equal(
							(await readInvocationLog(log)).some((row) => row.stdin === "NEVER_RETRY_MUTATION"),
							false,
						);
						assert.deepEqual(
							(await readFile(file)).subarray(0, publishedPrefix.length),
							publishedPrefix,
						);
						if (repair === "rewrite") {
							// Rewrite repair retains the captured prefix but publishes a distinct journal file.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(await readFile(`${file}.captured`), publishedPrefix);
							const published = await stat(file);
							// Rewrite repair retains the captured prefix but publishes a distinct journal file.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.notDeepEqual([published.dev, published.ino], [captured.dev, captured.ino]);
						}
						const persisted = await records(file);
						assert.equal(
							persisted.filter((entry) => getBrowserRecord(entry)?.event.phase === "begin").length,
							2,
						);
						assert.equal(
							persisted.filter((entry) => getBrowserRecord(entry)?.event.phase === "finish").length,
							1,
						);
						await runExtensionEvent(
							harness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							harness.ctx,
						);
					},
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

for (const failPhase of ["begin", "finish"] as const) {
	test(
		`a real journal ${failPhase} fault does not retry a browser effect`,
		{ concurrency: false, timeout: 30_000 },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "piab-persistence-fault-"));
			try {
				const log = join(root, "commands.jsonl");
				await writeFakeAgentBrowserBinary(
					root,
					`const fs=require('node:fs'); const args=process.argv.slice(2); const stdin=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');
const command=args.find(arg=>['open','get','snapshot','eval','tab','close'].includes(arg)); const url='https://fixture.test/page';
const data=command==='snapshot' ? {url,snapshot:'- button "Go" [ref=e1]',refs:{e1:{role:'button',name:'Go'}}} : command==='tab' ? {tabs:[{tabId:'t1',url,active:true}]} : command==='get' && args.includes('title') ? {title:'Fixture'} : {url};
process.stdout.write(JSON.stringify({success:true,data}));`,
				);
				await withPatchedEnv(
					{
						PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
						AGENT_BROWSER_SESSION: undefined,
						AGENT_BROWSER_NAMESPACE: undefined,
					},
					async () => {
						let fail = false;
						const journal = join(root, "session.jsonl");
						const harness = createExtensionHarness({
							cwd: root,
							sessionFile: journal,
							onAppendEntry(type, data) {
								if (
									fail &&
									type === BROWSER_TRANSITION_ENTRY &&
									readRecord(readRecord(data).event).phase === failPhase
								) {
									throw new Error("fixture disk write failed");
								}
							},
						});
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "fault", "snapshot", "-i"],
						});
						fail = true;
						const result = await executeRegisteredTool(
							// Exhaustive fixture variant (["begin", "finish"] as const): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							harness.getTool("agent_browser_code") ?? assert.fail("code tool must be registered"),
							harness.ctx,
							{
								session: "fault",
								code: 'await browser({args:["eval","--stdin"],stdin:"MUTATE_FIXTURE"}); await browser({args:["eval","--stdin"],stdin:"MUTATE_FIXTURE"});',
							},
						);
						const mutations = (await readInvocationLog(log)).filter(
							(row) => row.stdin === "MUTATE_FIXTURE",
						);
						assert.equal(
							mutations.length,
							failPhase === "begin" ? 0 : 1,
							"begin failure prevents dispatch; finish failure stops dependent calls",
						);
						assert.equal(result.isError, true);
						fail = false;
						if (failPhase === "finish") {
							const persisted = (await records(journal)).filter(
								(entry) => entry.type !== "session",
							);
							const pending = SessionPageState.fromBranch(persisted).get("fault");
							// Exhaustive fixture variant (failPhase === "finish"): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(pending.tabTargetUnknown, true);
							// Exhaustive fixture variant (failPhase === "finish"): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(pending.refSnapshot, undefined);
							const resumed = createExtensionHarness({
								cwd: root,
								sessionFile: journal,
								branch: persisted,
							});
							await runExtensionEvent(
								resumed.handlers,
								"session_start",
								{ reason: "resume" },
								resumed.ctx,
							);
							// Exhaustive fixture variant (failPhase === "finish"): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								(
									await executeRegisteredTool(resumed.tool, resumed.ctx, {
										args: ["--session", "fault", "get", "url"],
									})
								).isError,
								false,
							);
							const stale = await executeRegisteredTool(resumed.tool, resumed.ctx, {
								args: ["--session", "fault", "click", "@e1"],
							});
							const staleDetails = readRecord(stale.details);
							// Exhaustive fixture variant (failPhase === "finish"): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								staleDetails.failureCategory,
								"stale-ref",
								"URL inspection cannot restore an unfinished operation's refs",
							);
							// Exhaustive fixture variant (failPhase === "finish"): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								(await readInvocationLog(log)).filter((row) => row.stdin === "MUTATE_FIXTURE")
									.length,
								1,
							);
							await runExtensionEvent(
								resumed.handlers,
								"session_shutdown",
								{ reason: "quit" },
								resumed.ctx,
							);
						}
						await runExtensionEvent(
							harness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							harness.ctx,
						);
					},
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

test(
	"an unfinished fresh launch retains only its original owner's cleanup scope",
	{ concurrency: false },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-pending-owner-"));
		const socketDirs: string[] = [];
		try {
			const socketDir = createShortPrivateSocketDir(join(root, "owner"));
			socketDirs.push(socketDir);
			const otherSocketDir = createShortPrivateSocketDir(join(root, "fork"));
			socketDirs.push(otherSocketDir);
			await Promise.all(socketDirs.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
			const log = join(root, "commands.jsonl");
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,socketDir:process.env.AGENT_BROWSER_SOCKET_DIR})+'\\n');
process.stdout.write(JSON.stringify({success:true,data:{url:'https://fixture.test/created'}}));`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const file = join(root, "session.jsonl");
					const harness = createExtensionHarness({
						cwd: root,
						sessionFile: file,
						onAppendEntry(type, data) {
							if (
								type === BROWSER_TRANSITION_ENTRY &&
								readRecord(readRecord(data).event).phase === "finish"
							) {
								throw new Error("finish write failed");
							}
						},
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://fixture.test/created"],
						sessionMode: "fresh",
					});
					const resultDetails = readRecord(result.details);
					assert.equal(resultDetails.browserStatePersistence, "finish-unconfirmed");
					const persisted = (await records(file)).filter((entry) => entry.type !== "session");
					const beginRecord = persisted
						.map(getBrowserRecord)
						.find((record) => record?.event.phase === "begin");
					assert.ok(beginRecord);
					const begin = beginRecord.event;
					assert.equal(readRecord(begin.state).wrapperManaged, true);
					assert.equal(
						readRecord(begin.state).usedImplicitSession,
						false,
						"fresh allocation is owned even though it is not automatic session reuse",
					);
					assert.equal(readRecord(begin.state).managedSessionSocketDir, socketDir);
					const sessionName = readString(readRecord(begin.state).sessionName);
					await writeFile(log, "");
					await withPatchedEnv({ PI_AGENT_BROWSER_SOCKET_DIR: otherSocketDir }, async () => {
						const fork = createExtensionHarness({
							cwd: root,
							sessionId: "ordinary-fork",
							branch: persisted,
						});
						await runExtensionEvent(fork.handlers, "session_start", { reason: "fork" }, fork.ctx);
						await runExtensionEvent(
							fork.handlers,
							"session_shutdown",
							{ reason: "quit" },
							fork.ctx,
						);
						assert.equal(
							(await readInvocationLog(log)).some((row) =>
								readArray(row.args).map(readString).includes("close"),
							),
							false,
						);
						const resumed = createExtensionHarness({ cwd: root, branch: persisted });
						await runExtensionEvent(
							resumed.handlers,
							"session_start",
							{ reason: "resume" },
							resumed.ctx,
						);
						await executeRegisteredTool(resumed.tool, resumed.ctx, {
							args: ["--session", sessionName, "get", "url"],
						});
						await executeRegisteredTool(resumed.tool, resumed.ctx, {
							args: ["--session", "caller-owned", "get", "url"],
						});
						await runExtensionEvent(
							resumed.handlers,
							"session_shutdown",
							{ reason: "quit" },
							resumed.ctx,
						);
						const invocations = readArray(await readInvocationLog(log)).map((value) =>
							readRecord(value),
						);
						assert.equal(
							invocations.filter(
								(row) =>
									readArray(row.args).map(readString).includes("close") &&
									readArray(row.args).map(readString).includes(sessionName),
							).length,
							1,
							"restart can clean its wrapper-selected unresolved launch without claiming it succeeded",
						);
						assert.equal(
							invocations
								.filter((row) => readArray(row.args).map(readString).includes(sessionName))
								.every((row) => row.socketDir === socketDir),
							true,
							"helpers, commands and cleanup retain their original socket root",
						);
						assert.equal(
							invocations
								.filter((row) => readArray(row.args).map(readString).includes("caller-owned"))
								.every((row) => row.socketDir === otherSocketDir),
							true,
							"unrelated caller sessions keep native routing",
						);
					});
				},
			);
		} finally {
			await Promise.all(
				[root, ...socketDirs].map((path) => rm(path, { recursive: true, force: true })),
			);
		}
	},
);

test(
	"an indexed batch whose finish cannot persist keeps index-only public receipts",
	{ concurrency: false },
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "piab-indexed-finish-"));
		try {
			// Native batch JSON is a bare row array; indexed rows keep original input positions.
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs'),args=process.argv.slice(2),stdin=fs.readFileSync(0,'utf8');
if(!args.includes('batch')){process.stdout.write(JSON.stringify({success:true,data:{url:'https://fixture.test/page'}}));}
else{const indexed=args.includes('--omit-command');
process.stdout.write(JSON.stringify(JSON.parse(stdin).flatMap((command,index)=>command.length===0?[]:[{...(indexed?{index}:{command}),...(command[0]==='eval'?{success:false,error:'planned persistence failure'}:{success:true,result:{}})}])));
process.exitCode=1;}`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const run = async (indexed: boolean) => {
						const mode = indexed ? "indexed" : "command";
						const harness = createExtensionHarness({
							cwd: root,
							sessionFile: join(root, `${mode}.jsonl`),
							onAppendEntry(type, data) {
								if (
									type === BROWSER_TRANSITION_ENTRY &&
									readRecord(readRecord(data).event).phase === "finish"
								) {
									throw new Error("finish write failed");
								}
							},
						});
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						const plan = [
							[
								"cookies",
								"set",
								"ordinary",
								"persist-cookie-secret",
								"--url",
								"https://fixture.test/",
							],
							["eval", "(() => { throw new Error('planned persistence failure'); })()"],
						];
						const outputPath = join(root, `${mode}-receipt.json`);
						const result = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [
								"--session",
								`persist-${mode}`,
								"batch",
								"--bail",
								...(indexed ? ["--omit-command"] : []),
							],
							stdin: JSON.stringify(indexed ? [[], ...plan] : plan),
							outputPath,
						});
						const details = readRecord(result.details);
						assert.equal(result.isError, true, JSON.stringify(result));
						assert.equal(details.browserStatePersistence, "finish-unconfirmed");
						assert.deepEqual(
							readArray(details.nextActions).map((action) => readRecord(action).id),
							["inspect-after-browser-state-persistence-failure"],
						);
						assert.equal(details.outputFile, undefined, "an unconfirmed finish claims no file");
						await assert.rejects(stat(outputPath), { code: "ENOENT" });
						const steps = readArray(details.batchSteps).map(readRecord);
						assert.deepEqual(
							steps.map((step) => step.index),
							indexed ? [1, 2] : [0, 1],
						);
						assert.deepEqual(
							steps.map((step) => Object.hasOwn(step, "command")),
							[!indexed, !indexed],
						);
						const failedStep = readRecord(readRecord(details.batchFailure).failedStep);
						assert.equal(failedStep.index, indexed ? 2 : 1);
						assert.equal(Object.hasOwn(failedStep, "command"), !indexed);
						assert.doesNotMatch(JSON.stringify(result), /persist-cookie-secret/);
						assert.equal(/"command":\s*\[/.test(JSON.stringify(result)), !indexed);
						await runExtensionEvent(
							harness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							harness.ctx,
						);
					};
					// Command form is the parity control for the same unconfirmed finish.
					await t.test("command", () => run(false));
					await t.test("indexed", () => run(true));
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("conversion preserves all original ancestry, interrupted prefixes, snapshots and artifact provenance", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-conversion-"));
	try {
		const source = join(root, "original.jsonl"),
			destination = join(root, "converted.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "fixture-session",
			timestamp: "2026-09-30T00:00:00.000Z",
			cwd: root,
		};
		const snapshot = {
			refIds: ["e1", "e2"],
			refs: { e1: { role: "textbox", name: "Name", isEditable: true } },
			target: { url: "https://fixture.test/page#private-fragment", targetId: "native-tab" },
		};
		const row = {
			path: join(root, "caller.png"),
			absolutePath: join(root, "caller.png"),
			createdAtMs: 1,
			storageScope: "explicit-path",
			retentionState: "live",
			kind: "image",
			exists: true,
		};
		const manifest = {
			version: 1,
			entries: [row],
			liveCount: 1,
			evictedCount: 0,
			updatedAtMs: 1,
			maxEntries: 100,
		};
		const legacy = (id: string, parentId: string | null, details: object, isError = false) => ({
			type: "custom",
			customType: BROWSER_TRANSITION_ENTRY,
			id,
			parentId,
			timestamp: header.timestamp,
			data: { toolCallId: "outer", details, isError },
		});
		const originals = [
			header,
			legacy("capture", null, {
				args: ["snapshot", "-i"],
				command: "snapshot",
				sessionName: "shared",
				sessionTabTarget: snapshot.target,
				refSnapshot: snapshot,
				artifactManifest: manifest,
			}),
			legacy(
				"begin",
				"capture",
				{ args: ["fill", "@e1", "Test"], sessionName: "shared", sessionTabTargetUnknown: true },
				true,
			),
			legacy("finish", "begin", {
				args: ["fill", "@e1", "Test"],
				command: "fill",
				sessionName: "shared",
				sessionTabTarget: snapshot.target,
				refSnapshot: snapshot,
				artifactManifest: manifest,
			}),
			legacy("branch-b", "capture", {
				args: ["snapshot", "-i"],
				command: "snapshot",
				sessionName: "shared",
				sessionTabTarget: { url: "https://fixture.test/other#b" },
				refSnapshot: { refIds: ["e3"], refs: { e3: { role: "button", name: "Other" } } },
				artifactManifest: {
					...manifest,
					entries: [{ ...row, retentionState: "missing", exists: false }],
					liveCount: 0,
					updatedAtMs: 2,
				},
			}),
			{
				type: "label",
				id: "label-b",
				parentId: "branch-b",
				targetId: "branch-b",
				label: "Branch B",
				timestamp: header.timestamp,
			},
			{
				type: "message",
				id: "result",
				parentId: "finish",
				timestamp: header.timestamp,
				message: {
					role: "toolResult",
					toolName: "agent_browser",
					toolCallId: "outer",
					isError: false,
					content: [{ type: "image", data: "selected-image-bytes", mimeType: "image/png" }],
					details: {
						args: ["get", "title"],
						sessionName: "shared",
						refSnapshot: snapshot,
						artifactManifest: manifest,
						data: { explicit: "caller data 🧪" },
					},
				},
			},
			{
				type: "message",
				id: "modern",
				parentId: "result",
				timestamp: header.timestamp,
				message: {
					role: "toolResult",
					toolName: "agent_browser",
					toolCallId: "modern",
					isError: false,
					content: [{ type: "text", text: "Requested observation" }],
					details: {
						browserEventVersion: 1,
						args: ["get", "title"],
						sessionName: "shared",
						refSnapshot: { refIds: ["e9"] },
						artifactManifest: { ...manifest, entries: [], liveCount: 0 },
						data: { explicit: "modern caller data" },
					},
				},
			},
			legacy("late-result", "label-b", {
				args: ["get", "title"],
				command: "get",
				sessionName: "shared",
			}),
		];
		const bytes = Buffer.from(originals.map((entry) => JSON.stringify(entry)).join("\n"));
		await writeFile(source, bytes, { mode: 0o600 }); // A sealed valid unterminated record is inspectable, without repairing the source.
		const receipt = await convertBrowserSession({ source, destination, confirmedStopped: true });
		assert.equal(receipt.sourceSha256, createHash("sha256").update(bytes).digest("hex"));
		assert.deepEqual(await readFile(source), bytes);
		const converted = await records(destination);
		assert.deepEqual(
			converted.map((entry) => [entry.id, entry.parentId]),
			originals.map((entry) => [entry.id, "parentId" in entry ? entry.parentId : undefined]),
		);
		assert.equal(
			receipt.snapshotDefinitions,
			2,
			"repeated completions reuse only ancestral definitions",
		);
		const verifyLeaf = async (leaf: string) => {
			const branch = await readBrowserEntries(manager(destination, leaf));
			const state = SessionPageState.fromBranch(branch).get("shared");
			if (leaf === "begin") {
				// Exhaustive fixture variant (leaf === "begin"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(state.tabTargetUnknown, true);
				// Exhaustive fixture variant (leaf === "begin"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(state.refSnapshot, undefined);
			} else {
				// Exhaustive fixture variant (leaf === "begin"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(
					state.refSnapshot?.refIds,
					["branch-b", "label-b", "late-result"].includes(leaf) ? ["e3"] : ["e1", "e2"],
				);
			}
			if (["capture", "finish", "result"].includes(leaf)) {
				// Exhaustive fixture variant (["capture", "finish", "result"].includes(leaf)): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(state.tabTarget?.url, "https://fixture.test/page#private-fragment");
				// Exhaustive fixture variant (["capture", "finish", "result"].includes(leaf)): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(state.refSnapshot?.refs?.e1.isEditable, true);
				// Exhaustive fixture variant (["capture", "finish", "result"].includes(leaf)): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(state.refSnapshot.target?.targetId, "native-tab");
			}
			let recent;
			for (const entry of branch) {
				recent = applyArtifactChanges(recent, getBrowserRecord(entry)?.event.artifacts);
			}
			assert.equal(recent?.entries[0].path, row.path);
			assert.equal(
				recent.entries[0].retentionState,
				["branch-b", "label-b", "late-result"].includes(leaf) ? "missing" : "live",
			);
		};
		await Promise.all(
			["capture", "begin", "finish", "branch-b", "label-b", "result", "modern", "late-result"].map(
				verifyLeaf,
			),
		);
		const result = converted.find((entry) => entry.id === "result");
		assert.ok(result);
		assert.deepEqual(readRecord(readRecord(result.message).details).data, {
			explicit: "caller data 🧪",
		});
		assert.deepEqual(
			readRecord(result.message).content,
			readRecord(
				readRecord(
					originals.find((entry) => entry.id === "result") ??
						// A missing original result fails immediately; conversion equivalence cannot pass without it.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.fail("original result must be present"),
				).message,
			).content,
		);
		assert.deepEqual(
			converted.find((entry) => entry.id === "modern"),
			originals.find((entry) => entry.id === "modern"),
			"modern observations retain explicit bodies and cannot overwrite canonical state with an invocation-only receipt",
		);
		assert.equal(readRecord(readRecord(result.data).archive).sourceSha256, receipt.sourceSha256);
		await assert.rejects(
			convertBrowserSession({ source, destination, confirmedStopped: true }),
			/occupied/,
		);
		await assert.rejects(
			convertBrowserSession({
				source,
				destination: join(root, "unconfirmed.jsonl"),
				confirmedStopped: false,
			}),
			/quiesce/,
		);
		await writeFile(source, `${bytes.toString("utf8")}\n{broken`);
		await assert.rejects(
			convertBrowserSession({
				source,
				destination: join(root, "malformed.jsonl"),
				confirmedStopped: true,
			}),
			/Parser|parse|expected/i,
		);
		const verifyInvalidAncestry = async (invalid: Readonly<object>, index: number) => {
			await writeFile(source, `${bytes.toString("utf8")}\n${JSON.stringify(invalid)}\n`);
			const invalidDestination = join(root, `invalid-${index}.jsonl`);
			await assert.rejects(
				convertBrowserSession({
					source,
					destination: invalidDestination,
					confirmedStopped: true,
				}),
				/missing or duplicate native entry ID|missing or forward parent/,
			);
			await assert.rejects(stat(invalidDestination), { code: "ENOENT" });
		};
		for (const [index, invalid] of [
			legacy("capture", null, {}),
			legacy("missing-parent", "not-an-entry", {}),
			legacy("forward-parent", "future", {}),
			{ type: "custom", parentId: null, timestamp: header.timestamp },
		].entries()) {
			// Each invalid ancestry variant must remain rejected even after unused projections are released.
			// oxlint-disable-next-line no-await-in-loop
			await verifyInvalidAncestry(invalid, index);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("token projection validates skipped values, splits Unicode safely and discards giant unused strings", async () => {
	async function* bytes(text: string) {
		for (const byte of Buffer.from(text)) {
			yield Uint8Array.of(byte);
		}
	}
	assert.deepEqual(
		await projectJson(
			bytes('{"ignored":"unused","id":"🧪é","data":{"event":{"version":1,"ok":true}}}'),
			[["id"], ["data", "event"]],
		),
		{ id: "🧪é", data: { event: { version: 1, ok: true } } },
	);
	await assert.rejects(projectJson(bytes('{"ignored":[false,invalid],"id":"never"}'), [["id"]]));
	await Promise.all(
		['{"ignored":"unfinished', '{"ignored":[true', '{"ignored":1e}', "{}{}"].map((text) =>
			assert.rejects(projectJson(bytes(text), [["id"]]), /Parser/),
		),
	);
	async function* invalidUtf8() {
		yield Buffer.from('{"ignored":"');
		yield Uint8Array.of(0xe2, 0x82); // Incomplete UTF-8 at EOF, even in an ignored value.
	}
	await assert.rejects(projectJson(invalidUtf8(), [["id"]]), /encoded data/);
	await assert.rejects(
		projectJson(bytes(`{"id":"${"x".repeat(1000)}"}`), [["id"]], 128),
		/Selected journal envelope exceeds/,
	);
	await assert.rejects(
		projectJson(bytes(`{"ignored":${"[".repeat(1024)}0${"]".repeat(1024)}}`), [["id"]]),
		/nesting exceeds 1024/,
	);
	const selected =
		'{"data":{"__proto__":{"polluted":true},"constructor":"own","duplicate":1,"duplicate":2,"numbers":[-0,1.25e+2,1E-2,9007199254740993]}}';
	assert.deepEqual(await projectJson(bytes(selected), [["data"]]), JSON.parse(selected));
	async function* ignored() {
		yield Buffer.from('{"ignored":"');
		for (let index = 0; index < 64; index++) {
			yield Buffer.alloc(64 * 1024, 120);
		}
		yield Buffer.from('","id":"kept"}');
	}
	assert.deepEqual(await projectJson(ignored(), [["id"]], 128), { id: "kept" });
});

test("journal scanning keeps token-projection acceptance for retained and streamed records", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-journal-scan-"));
	let files = 0;
	const scan = async (text: string | Uint8Array, sealed = false) => {
		const file = join(root, `journal-${files++}.jsonl`);
		await writeFile(file, text);
		const handle = await open(file, "r");
		try {
			return (await scanJournalMetadata(handle, (await handle.stat()).size, sealed)).map(
				({ value }) => value,
			);
		} finally {
			await handle.close();
		}
	};
	try {
		const record = (ignored: string) =>
			`{"type":"custom","id":"a","parentId":null,"customType":"agent-browser-transition","ignored":${ignored},"data":{"event":{"version":1,"ignored":true},"other":[1]},"message":"plain"}`;
		const expected = {
			type: "custom",
			id: "a",
			parentId: null,
			customType: "agent-browser-transition",
			data: { event: { version: 1 } },
			message: "plain",
		};
		const journal = (ignored: string) => ` \t\r\n${record(ignored)}\n \n{"type":"tail"`;
		assert.deepEqual(
			await Promise.all([
				scan(journal('""')),
				scan(journal(`[${"[],".repeat(100_000)}[]]`)),
				scan(journal(`"${"x".repeat(2 * 1024 * 1024)}"`)),
				scan('{"type":"tail"}', true),
			]),
			[[expected], [expected], [expected], [{ type: "tail" }]],
			"retained, structurally dense and streamed records project alike; blank lines and an unsealed tail are skipped",
		);
		// A fault in a record's first 64 KiB must win over invalid UTF-8 later in the same record.
		const laterInvalidUtf8 = (prefix: string) =>
			Buffer.concat([
				Buffer.from(`${prefix}"${"x".repeat(70 * 1024)}`),
				Buffer.from('\xe2\x82"}\n', "latin1"),
			]);
		const rejected: ReadonlyArray<readonly [string | Uint8Array, RegExp]> = [
			[`{"ignored":${"[".repeat(1024)}0${"]".repeat(1024)}}\n`, /nesting exceeds 1024/],
			['{"id":"a"}{"id":"b"}\n', /Parser/],
			["1\n", /Expected a journal object/],
			[Buffer.from('{"ignored":"\xe2\x82"}\n', "latin1"), /encoded data/],
			[laterInvalidUtf8('{"id":"a" "ignored":'), /Parser/],
			[
				laterInvalidUtf8(`{"ignored":${"[".repeat(1024)}0${"]".repeat(1024)},"pad":`),
				/nesting exceeds 1024/,
			],
		];
		await Promise.all(rejected.map(([text, error]) => assert.rejects(scan(text), error)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a structurally dense record under 1 MiB scans within the per-record heap reserve", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-journal-dense-"));
	try {
		// About 1 MiB of empty objects: native parsing alone would retain more than the record's
		// 16 MiB reserve. The cap allows that reserve above a bare tsx process.
		const file = join(root, "dense.jsonl");
		await writeFile(
			file,
			`{"type":"custom","id":"dense","ignored":[${"{},".repeat(340_000)}{}]}\n`,
		);
		const moduleUrl = new URL("../extensions/agent-browser/lib/browser-journal.ts", import.meta.url)
			.href;
		const script = `import { open } from "node:fs/promises"; import { scanJournalMetadata } from ${JSON.stringify(moduleUrl)}; const handle = await open(${JSON.stringify(file)}, "r"); const entries = await scanJournalMetadata(handle, (await handle.stat()).size, false); await handle.close(); process.stdout.write(JSON.stringify(entries.map(({ value }) => value)));`;
		const child = spawnSync(
			process.execPath,
			["--max-old-space-size=24", "--import", "tsx", "--input-type=module", "--eval", script],
			{ encoding: "utf8" },
		);
		assert.equal(child.status, 0, readString(child.stderr).slice(0, 2000));
		assert.deepEqual(JSON.parse(child.stdout), [{ type: "custom", id: "dense" }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("token projection releases its byte iterator and preserves source error identity", async () => {
	const sourceError = new Error("source read failed");
	let closed = 0;
	async function* interrupted() {
		try {
			yield Buffer.from('{"id":"partial');
			throw sourceError;
		} finally {
			closed++;
		}
	}
	await assert.rejects(projectJson(interrupted(), [["id"]]), (error) => error === sourceError);
	assert.equal(closed, 1);
	async function* oversized() {
		try {
			yield Buffer.from(`{"id":"${"x".repeat(1000)}`);
			throw new Error("projection should reject before reading another chunk");
		} finally {
			closed++;
		}
	}
	await assert.rejects(
		projectJson(oversized(), [["id"]], 128),
		/Selected journal envelope exceeds/,
	);
	assert.equal(closed, 2);
});

test("missing or corrupt winning snapshots fail replay before refs can be used", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-corrupt-snapshot-"));
	try {
		const file = join(root, "session.jsonl");
		const header = { type: "session", id: "fixture-session" };
		const entry = {
			type: "custom",
			customType: BROWSER_TRANSITION_ENTRY,
			id: "capture",
			parentId: null,
			data: {
				event: {
					version: 1,
					phase: "state",
					operationId: "capture",
					toolCallId: "call",
					commandIndex: 0,
					isError: false,
					state: {},
					pages: [
						{
							key: "shared",
							target: { url: "https://fixture.test/same" },
							refs: { kind: "replace", snapshotId: "definition" },
						},
					],
				},
				snapshot: { id: "definition", refs: { e1: { role: "button", name: "Go" } } },
			},
		};
		const unresolved = {
			name: "Error",
			message:
				"Browser snapshot definition has no ancestral definition; inspect and take a fresh snapshot.",
		};
		const invalid = {
			name: "Error",
			message:
				"Missing or invalid browser snapshot definition; take a new complete snapshot before using refs.",
		};
		const validRefs = entry.data.snapshot.refs;
		for (const [snapshot, expected] of [
			[undefined, unresolved],
			[{ id: "definition", refs: { e1: "corrupt" } }, invalid],
			[{ id: "definition", refs: { x1: validRefs.e1 } }, invalid],
			[{ id: "definition" }, invalid],
			[{ id: "definition", refs: validRefs, target: { url: 7 } }, invalid],
			[{ id: "definition", refs: validRefs, generation: 7 }, invalid],
			[{ id: "other", refs: {} }, unresolved],
		] as const) {
			// The next variant overwrites these fixture files; finish this publication and readback first.
			// oxlint-disable-next-line no-await-in-loop
			await writeFile(
				file,
				`${JSON.stringify(header)}\n${JSON.stringify({ ...entry, data: { ...entry.data, snapshot } })}\n`,
			);
			// Missing and mismatched definitions, malformed refs, ref ids, ref maps, targets and
			// generations must each fail replay itself with their exact error.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			const rejected = assert.rejects(readBrowserEntries(manager(file, "capture")), expected);
			// The next variant overwrites these fixture files; finish this publication and readback first.
			// oxlint-disable-next-line no-await-in-loop
			await rejected;
		}
		await writeFile(
			file,
			`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n{"type":"custom","broken":`,
		);
		const live = await readBrowserEntries(manager(file, "capture"));
		assert.deepEqual(
			SessionPageState.fromBranch(live).get("shared").refSnapshot?.refIds,
			["e1"],
			"a torn live tail is not committed or repaired",
		);
		assert.match(readString(await readFile(file, "utf8")), /"broken":$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test(
	"a replacement native generation at the same URL invalidates refs until a new capture",
	{ concurrency: false },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-generation-"));
		try {
			const log = join(root, "commands.jsonl"),
				generation = join(root, "generation");
			await writeFile(generation, "original");
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args})+'\\n');
const url='https://fixture.test/same'; const command=args.find(arg=>['session','snapshot','get','tab'].includes(arg));
const data=command==='session' ? {active:true,runtime:{restoreKey:null,backgroundPid:${process.pid},browserLaunched:true,socketDir:fs.readFileSync(${JSON.stringify(generation)},'utf8')}}
: command==='snapshot' ? {url,snapshot:'- textbox "Name" [ref=e1]',refs:{e1:{role:'textbox',name:'Name'}}}
: command==='tab' ? {tabs:[{tabId:'t1',url,active:true}]} : args.includes('url') ? {url} : {text:'Name'};
process.stdout.write(JSON.stringify({success:true,data}));`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: root });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const prefix = ["--session", "generation"];
					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "snapshot", "-i"],
							})
						).isError,
						false,
					);
					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "get", "text", "@e1"],
							})
						).isError,
						false,
					);
					await writeFile(generation, "replacement");
					await writeFile(log, "");
					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "get", "text", "@e1"],
							})
						).details?.failureCategory,
						"stale-ref",
					);
					assert.equal(
						(await readInvocationLog(log)).some((row) =>
							readArray(row.args).map(readString).includes("text"),
						),
						false,
						"old refs never reach the replacement daemon",
					);
					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "snapshot", "-i"],
							})
						).isError,
						false,
					);
					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "get", "text", "@e1"],
							})
						).isError,
						false,
					);
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"restored generation ambiguity preserves live input and proven replacement reopens once",
	{ concurrency: false, skip: process.platform === "win32" },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-live-generation-"));
		const socketDir = createShortPrivateSocketDir(root);
		try {
			const home = join(root, "home");
			const log = join(root, "calls.jsonl");
			const native = join(root, "native.json");
			const url = "https://fixture.test/draft";
			const draft = "Keep this unsaved draft";
			await mkdir(home, { mode: 0o700 });
			assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args})+'\\n');
let state=fs.existsSync(${JSON.stringify(native)})?JSON.parse(fs.readFileSync(${JSON.stringify(native)},'utf8')):{active:false,value:''};
const url=${JSON.stringify(url)}, command=args.find(arg=>['session','open','fill','snapshot','get','tab','close'].includes(arg));
let data;
if(command==='session') data={active:state.active,runtime:state.active?{restoreKey:state.restoreKey,backgroundPid:${process.pid},browserLaunched:true,socketDir:state.socketDir??${JSON.stringify(socketDir)}}:null};
else if(command==='open') {state={active:true,value:'',socketDir:state.socketDir,restoreKey:process.env.AGENT_BROWSER_RESTORE??null};data={url,title:'Draft',targetId:'live-target'};}
else if(command==='fill') {state.value=args.at(-1);data={filled:true};}
else if(command==='snapshot') data={origin:url,targetId:'live-target',snapshot:'- textbox "Draft" [ref=e1]',refs:{e1:{role:'textbox',name:'Draft'}}};
else if(command==='tab') data={tabs:[{tabId:'t1',targetId:'live-target',url,active:true}]};
else if(command==='get') data=args.includes('value')?{value:state.value}:{url};
else if(command==='close') {state.active=false;data={closed:true};}
fs.writeFileSync(${JSON.stringify(native)},JSON.stringify(state));
process.stdout.write(JSON.stringify({success:true,data}));`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					HOME: home,
					USERPROFILE: home,
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const original = createExtensionHarness({ cwd: root });
					await runExtensionEvent(
						original.handlers,
						"session_start",
						{ reason: "new" },
						original.ctx,
					);
					const opened = await executeRegisteredTool(original.tool, original.ctx, {
						args: ["open", url],
						sessionMode: "fresh",
					});
					assert.equal(opened.isError, false, JSON.stringify(opened));
					assert.notEqual(opened.details?.managedSessionRestoreDisabled, true);
					assert.equal(
						(
							await executeRegisteredTool(original.tool, original.ctx, {
								args: ["fill", "#draft", draft],
							})
						).isError,
						false,
					);
					const snapshot = await executeRegisteredTool(original.tool, original.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
					assert.match(
						readString(readRecord(snapshot.details?.refSnapshot).generation),
						/posix-ps-utc-v1:/,
					);
					await runExtensionEvent(
						original.handlers,
						"session_shutdown",
						{ reason: "reload" },
						original.ctx,
					);
					// Retain genuine owner-produced receipts, but persist the previous POSIX timestamp format.
					const branch = readArray(
						JSON.parse(
							JSON.stringify(original.ctx.sessionManager.getBranch()).replaceAll(
								"posix-ps-utc-v1:",
								"",
							),
						),
					);
					const resumed = createExtensionHarness({ cwd: root, branch });
					await runExtensionEvent(
						resumed.handlers,
						"session_start",
						{ reason: "resume" },
						resumed.ctx,
					);
					const offset = (await readInvocationLog(log)).length;
					const observed = await executeRegisteredTool(resumed.tool, resumed.ctx, {
						args: ["get", "value", "#draft"],
					});
					assert.equal(observed.isError, false, JSON.stringify(observed));
					assert.equal(readRecord(observed.details?.data).value, draft);
					assert.equal(
						(await readInvocationLog(log)).slice(offset).some((row) => row.args.includes("open")),
						false,
						"incomparable start timestamps must not reload a still-live browser",
					);
					assert.equal(
						readRecord(observed.details?.refSnapshotInvalidation).reason,
						"page-transition",
					);
					const stale = await executeRegisteredTool(resumed.tool, resumed.ctx, {
						args: ["get", "value", "@e1"],
					});
					assert.equal(stale.details?.failureCategory, "stale-ref");
					assert.equal(
						(await readInvocationLog(log)).slice(offset).some((row) => row.args.includes("@e1")),
						false,
						"the old refs cannot be trusted merely because the live page was preserved",
					);
					assert.equal(
						(await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["snapshot", "-i"] }))
							.isError,
						false,
					);
					const fresh = await executeRegisteredTool(resumed.tool, resumed.ctx, {
						args: ["get", "value", "@e1"],
					});
					assert.equal(fresh.isError, false, JSON.stringify(fresh));
					assert.equal(readRecord(fresh.details?.data).value, draft);
					await runExtensionEvent(
						resumed.handlers,
						"session_shutdown",
						{ reason: "reload" },
						resumed.ctx,
					);
					const restored = createExtensionHarness({
						cwd: root,
						branch: [...resumed.ctx.sessionManager.getBranch()],
					});
					await runExtensionEvent(
						restored.handlers,
						"session_start",
						{ reason: "resume" },
						restored.ctx,
					);
					const replacementOffset = (await readInvocationLog(log)).length;
					await writeFile(
						native,
						JSON.stringify({
							...readRecord(JSON.parse(await readFile(native, "utf8"))),
							socketDir: `${socketDir}-replacement`,
						}),
					);
					const replaced = await executeRegisteredTool(restored.tool, restored.ctx, {
						args: ["get", "value", "#draft"],
					});
					assert.equal(replaced.isError, false, JSON.stringify(replaced));
					assert.equal(readRecord(replaced.details?.data).value, "");
					const repeated = await executeRegisteredTool(restored.tool, restored.ctx, {
						args: ["get", "value", "#draft"],
					});
					assert.equal(repeated.isError, false, JSON.stringify(repeated));
					assert.deepEqual(
						(await readInvocationLog(log))
							.slice(replacementOffset)
							.filter((row) => row.args.includes("open"))
							.map((row) => row.args.slice(-2)),
						[["open", url]],
						"a proven changed generation reopens the remembered URL exactly once",
					);
					assert.equal(
						(await executeRegisteredTool(restored.tool, restored.ctx, { args: ["close"] })).isError,
						false,
					);
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(socketDir, { recursive: true, force: true });
		}
	},
);

test(
	"restart reuses profiled owned daemon provenance only when its native generation still matches",
	{ concurrency: false },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-profile-generation-"));
		try {
			const active = join(root, "active"),
				generation = join(root, "generation"),
				log = join(root, "calls.jsonl");
			await writeFile(generation, "original");
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args})+'\\n');
let data;
if(args.includes('session')) data={active:fs.existsSync(${JSON.stringify(active)}),runtime:fs.existsSync(${JSON.stringify(active)})?{restoreKey:null,backgroundPid:${process.pid},browserLaunched:true,socketDir:fs.readFileSync(${JSON.stringify(generation)},'utf8')}:null};
else {
  if(args.includes('open')) fs.writeFileSync(${JSON.stringify(active)}, 'active');
  data=args.includes('tab')?{tabs:[{tabId:'t1',url:'https://fixture.test/profile',active:true}]}:{url:'https://fixture.test/profile',title:'Profile fixture'};
}
process.stdout.write(JSON.stringify({success:true,data}));`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const original = createExtensionHarness({ cwd: root });
					await runExtensionEvent(
						original.handlers,
						"session_start",
						{ reason: "new" },
						original.ctx,
					);
					const opened = await executeRegisteredTool(original.tool, original.ctx, {
						args: ["--profile", "Fixture Profile", "open", "https://fixture.test/profile"],
						sessionMode: "fresh",
					});
					assert.equal(opened.isError, false, JSON.stringify(opened));
					const branch = [...original.ctx.sessionManager.getBranch()];
					for (const current of ["original", "replacement"]) {
						// The next variant overwrites these fixture files; finish this publication and readback first.
						// oxlint-disable-next-line no-await-in-loop
						await writeFile(generation, current);
						// The next variant overwrites these fixture files; finish this publication and readback first.
						// oxlint-disable-next-line no-await-in-loop
						await writeFile(log, "");
						const resumed = createExtensionHarness({ cwd: root, branch: [...branch] });
						// The next variant overwrites these fixture files; finish this publication and readback first.
						// oxlint-disable-next-line no-await-in-loop
						await runExtensionEvent(
							resumed.handlers,
							"session_start",
							{ reason: "resume" },
							resumed.ctx,
						);
						// The next variant overwrites these fixture files; finish this publication and readback first.
						// oxlint-disable-next-line no-await-in-loop
						const result = await executeRegisteredTool(resumed.tool, resumed.ctx, {
							args: ["get", "title"],
						});
						// Exhaustive fixture variant (["original", "replacement"]): this selected path must satisfy its own contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(result.isError, current === "replacement", JSON.stringify(result));
						// The next variant overwrites these fixture files; finish this publication and readback first.
						// oxlint-disable-next-line no-await-in-loop
						const titleCalls = (await readInvocationLog(log)).filter(
							(row) =>
								readArray(row.args).map(readString).at(-2) === "get" &&
								readArray(row.args).map(readString).at(-1) === "title",
						);
						// Exhaustive fixture variant (["original", "replacement"]): this selected path must satisfy its own contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							titleCalls.length,
							current === "original" ? 1 : 0,
							"a changed daemon cannot inherit recorded launch provenance",
						);
						if (current === "replacement") {
							// Exhaustive fixture variant (current === "replacement"): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(readString(result.content[0].text ?? ""), /live daemon.*restore policy/);
						}
					}
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
