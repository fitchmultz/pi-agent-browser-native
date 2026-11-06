// Opt-in bounded-heap storage proof. No Pi, provider, extension tool or browser is started.
// Run after npm run build: node --max-old-space-size=128 test/helpers/large-browser-journal.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { convertBrowserSession } from "../../dist/extensions/agent-browser/lib/browser-session-conversion.js";
import {
	readBrowserEntries,
	readRange,
} from "../../dist/extensions/agent-browser/lib/browser-journal.js";
import {
	applyArtifactChanges,
	getBrowserRecord,
} from "../../dist/extensions/agent-browser/lib/browser-transcript.js";
import { SessionPageState } from "../../dist/extensions/agent-browser/lib/session-page-state.js";

const root = await mkdtemp(join(tmpdir(), "piab-large-journal-"));
const source = join(root, "original.jsonl"),
	destination = join(root, "converted.jsonl");
/** @param {string} path */
const hashFile = async (path) => {
	const file = await open(path, "r");
	try {
		const hash = createHash("sha256");
		for await (const bytes of readRange(file, { offset: 0, length: (await file.stat()).size })) {
			hash.update(bytes);
		}
		return hash.digest("hex");
	} finally {
		await file.close();
	}
};
try {
	const file = await open(source, "wx", 0o600);
	const timestamp = "2026-09-30T00:00:00.000Z";
	const header = { type: "session", version: 3, id: "large-session", cwd: root, timestamp };
	try {
		await file.write(JSON.stringify(header) + "\n");
		await file.write(
			'{"type":"custom","customType":"unrelated","id":"giant","parentId":null,"timestamp":"' +
				timestamp +
				'","data":{"ignored":"',
		);
		const chunk = Buffer.alloc(1024 * 1024, 120);
		for (let index = 0; index < 1025; index++) {
			// Bounded memory and byte ordering require one completed file write per chunk.
			await file.write(chunk);
		} // The ignored string alone exceeds 1 GiB and Node's whole-string ceiling.
		await file.write('"}}\n');
		// Off-branch records near the 1 MiB native-parse boundary: too dense for native JSON, the
		// densest accepted container shape, and accepted distinct root keys.
		const dense = [
			`"data":{"ignored":[${"{},".repeat(349_000)}{}]}`,
			`"data":{"ignored":[${"{},".repeat(32_000)}{}],"pad":"${"x".repeat(900_000)}"}`,
			Array.from({ length: 32_000 }, (_, index) => `"k${index}":0`).join(","),
		];
		for (const [index, body] of dense.entries()) {
			// Bounded memory and byte ordering require one completed file write per record.
			await file.write(
				`{"type":"custom","customType":"unrelated","id":"dense-${index}","parentId":"giant","timestamp":"${timestamp}",${body}}\n`,
			);
		}
		const refIds = Array.from({ length: 34683 }, (_, index) => `e${index + 1}`);
		const target = { url: "https://fixture.test/large#exact-fragment", targetId: "native-target" };
		const snapshot = {
			refIds,
			refs: Object.fromEntries(
				refIds.map((id) => [id, { role: "textbox", name: "Field", isEditable: true }]),
			),
			target,
		};
		const entries = Array.from({ length: 100 }, (_, index) => ({
			path: join(root, `caller-${index}.png`),
			kind: "image",
			storageScope: "explicit-path",
			retentionState: "live",
			createdAtMs: index,
		}));
		const manifest = {
			version: 1,
			entries,
			liveCount: 100,
			evictedCount: 0,
			maxEntries: 100,
			updatedAtMs: 100,
		};
		/** @param {string} id @param {string} parentId @param {Readonly<Record<string, unknown>>} observation */
		const legacy = (id, parentId, observation) => ({
			type: "custom",
			customType: "agent-browser-transition",
			id,
			parentId,
			timestamp,
			data: { toolCallId: "large-outer", isError: false, details: observation },
		});
		const details = {
			args: ["get", "title"],
			command: "get",
			subcommand: "title",
			sessionName: "large",
			sessionTabTarget: target,
			refSnapshot: snapshot,
			artifactManifest: manifest,
		};
		await file.write(
			JSON.stringify(
				legacy("capture", "giant", { ...details, args: ["snapshot", "-i"], command: "snapshot" }),
			) + "\n",
		);
		let parent = "capture";
		for (let index = 0; index < 220; index++) {
			const id = `read-${index}`;
			// Journal ancestry and physical append order must advance together.
			await file.write(JSON.stringify(legacy(id, parent, details)) + "\n");
			parent = id;
		}
		await file.write(
			JSON.stringify(
				legacy("branch-b", "capture", {
					...details,
					sessionTabTarget: { url: "https://fixture.test/b#branch" },
					refSnapshot: { refIds: ["e7"], refs: { e7: { role: "button", name: "Other" } } },
				}),
			) + "\n",
		);
		parent = "read-219";
		for (let index = 0; index < 4000; index++) {
			const id = `wide-${index}`;
			// Distinct-session ancestry exposes retention of every historical growing page map.
			await file.write(
				JSON.stringify({
					type: "custom",
					customType: "agent-browser-transition",
					id,
					parentId: parent,
					timestamp,
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
									key: `session-${index}`,
									target: { url: `https://fixture.test/session-${index}` },
									refs: { kind: "invalidate" },
								},
							],
						},
					},
				}) + "\n",
			);
			parent = id;
		}
		await file.sync();
	} finally {
		await file.close();
	}
	const before = await hashFile(source);
	const receipt = await convertBrowserSession({ source, destination, confirmedStopped: true });
	assert.equal(receipt.sourceSha256, before);
	assert.equal(await hashFile(source), before);
	assert.equal(receipt.snapshotDefinitions, 2);
	assert.ok(receipt.sourceBytes > 1024 * 1024 * 1024);
	assert.ok(
		receipt.sourceBytes - receipt.destinationBytes > 400 * 1024 * 1024,
		"repeated legacy maps collapse without dropping the ignored value",
	);
	/** @param {string} path @param {string} leaf */
	const manager = (path, leaf) => ({
		getSessionFile: () => path,
		getHeader: () => header,
		getSessionId: () => header.id,
		getLeafId: () => leaf,
		getEntries() {
			throw Error("No eager entries");
		},
		getBranch() {
			throw Error("No eager branch");
		},
		getEntry() {
			throw Error("No eager native payload");
		},
	});
	const observations = [];
	for (const path of [source, destination]) {
		// Read each retained locator independently; neither replay writes or selects a converted copy.
		const branch = await readBrowserEntries(manager(path, "read-219"));
		const page = SessionPageState.fromBranch(branch).get("large");

		let recent;
		for (const entry of branch) {
			recent = applyArtifactChanges(recent, getBrowserRecord(entry)?.event.artifacts);
		}
		// Branch selection on this same file must not borrow refs from its physical sibling.
		const otherBranch = await readBrowserEntries(manager(path, "branch-b"));
		const other = SessionPageState.fromBranch(otherBranch).get("large");
		// Each locator has its own growing selected ancestry, with bounded released parent projections.
		const wide = SessionPageState.fromBranch(await readBrowserEntries(manager(path, "wide-3999")));
		observations.push({
			path,
			refCount: page.refSnapshot?.refIds.length,
			lastRef: page.refSnapshot?.refs?.e34683,
			targetUrl: page.tabTarget?.url,
			artifactCount: recent?.entries.length,
			otherRefs: other.refSnapshot?.refIds,
			otherUrl: other.tabTarget?.url,
			wideCount: wide.views().size,
			wideFirstUrl: wide.get("session-0").tabTarget?.url,
			wideLastUrl: wide.get("session-3999").tabTarget?.url,
			wideRefCount: wide.get("large").refSnapshot?.refIds.length,
		});
	}
	assert.deepEqual(
		observations,
		[source, destination].map((path) => ({
			path,
			refCount: 34683,
			lastRef: { role: "textbox", name: "Field", isEditable: true },
			targetUrl: "https://fixture.test/large#exact-fragment",
			artifactCount: 100,
			otherRefs: ["e7"],
			otherUrl: "https://fixture.test/b#branch",
			wideCount: 4001,
			wideFirstUrl: "https://fixture.test/session-0",
			wideLastUrl: "https://fixture.test/session-3999",
			wideRefCount: 34683,
		})),
	);
	assert.equal(await hashFile(source), before);
	assert.equal((await stat(source)).size, receipt.sourceBytes);
	console.log(
		JSON.stringify({
			...receipt,
			heapLimitBytes: getHeapStatistics().heap_size_limit,
			maxRssKiB: process.resourceUsage().maxRSS,
			selectedRefs: 34683,
			recentReceipts: 100,
			branchesVerified: 3,
			distinctSessionsVerified: 4001,
			locatorsVerified: 2,
		}),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
