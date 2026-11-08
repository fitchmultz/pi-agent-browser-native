import { readArray, readRecord, readDefined } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import nodeTest from "node:test";

import { BROWSER_TRANSITION_ENTRY } from "../extensions/agent-browser/lib/browser-transcript.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

// The incident repeated a 34,683-ref capture and a 100-row recent artifact view after ordinary reads.
// This exercises the real direct persistence boundary, not a serializer fed synthetic deltas.
nodeTest(
	"ordinary reads retain a large capture without recopying refs or artifact history",
	{ concurrency: false, timeout: 120_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-growth-"));
		try {
			await writeFakeAgentBrowserBinary(
				root,
				`const args=process.argv.slice(2); const command=args.find(arg=>['snapshot','get','close','tab'].includes(arg));
const url='https://fixture.test/page#private-fragment';
const data=command==='snapshot' ? {url, snapshot:'- button "Go" [ref=e1]', refs:Object.fromEntries(Array.from({length:34683},(_,index)=>['e'+(index+1),{role:'button',name:'Go'}]))}
: command==='tab' ? {tabs:[{tabId:'t1',url,active:true}]} : command==='close' ? {closed:true} : args.includes('url') ? {url} : {title:'Fixture'};
process.stdout.write(JSON.stringify({success:true,data}));`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const entries = Array.from({ length: 100 }, (_, index) => ({
						path: join(root, `receipt-${index}.png`),
						absolutePath: join(root, `receipt-${index}.png`),
						kind: "image",
						storageScope: "explicit-path",
						retentionState: "live",
						createdAtMs: index,
						exists: true,
					}));
					const branch = [
						createToolBranchEntry({
							details: {
								artifactManifest: {
									version: 1,
									entries,
									liveCount: 100,
									evictedCount: 0,
									maxEntries: 100,
									updatedAtMs: 100,
								},
							},
						}),
					];
					const harness = createExtensionHarness({
						cwd: root,
						branch,
						sessionFile: join(root, "session.jsonl"),
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const exported = join(root, "capture.json");
					const capture = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "growth", "snapshot", "-i"],
						outputPath: exported,
					});
					assert.equal(capture.isError, false, JSON.stringify(capture));
					const nativeData = readRecord(JSON.parse(await readFile(exported, "utf8")));
					assert.equal(
						Object.keys(readRecord(nativeData.refs)).length,
						34683,
						"explicit structured snapshot exports retain every native ref",
					);
					assert.deepEqual(readRecord(nativeData.refs).e34683, { role: "button", name: "Go" });
					let result;
					for (let read = 0; read < 4; read++) {
						// Each read follows the previous one in the same journal to measure repeated-read growth.
						result = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "growth", "get", "title"],
						});
					}
					assert.ok(result);
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.deepEqual(result.details?.data, { title: "Fixture" });
					const transitions = harness.appendedEntries.filter(
						(entry) => entry.customType === BROWSER_TRANSITION_ENTRY,
					);
					const bytes = transitions.reduce(
						(total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
						0,
					);
					assert.ok(
						bytes < 4 * 1024 * 1024,
						`One capture plus small events must stay below 4 MiB; ordinary reads persisted ${bytes} bytes.`,
					);
					const records = transitions.map((entry) => readRecord(entry.data));
					assert.equal(
						records.filter((record) => record.snapshot !== undefined).length,
						1,
						"the complete ref payload is defined once",
					);
					const reuseRecords = records.filter((record) =>
						readArray(readRecord(record.event).pages ?? [])
							.map(readRecord)
							.some((page) => readRecord(page.refs).kind === "reuse"),
					);
					assert.equal(reuseRecords.length, 4);
					assert.deepEqual(
						reuseRecords.map((record) => {
							const event = readRecord(record.event);
							return [record.snapshot, event.artifacts, readRecord(event.state).artifactManifest];
						}),
						Array.from({ length: 4 }, () => [undefined, undefined, undefined]),
						"each ordinary read reuses refs without copying a capture, artifact delta or manifest view",
					);
					assert.equal(
						readArray(readRecord(result.details.artifactManifest ?? {}).entries ?? []).length,
						0,
						"an invocation does not repeat unrelated receipts",
					);
					const replay = SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch());
					assert.equal(replay.get("growth").refSnapshot?.refIds.length, 34683);
					assert.equal(readDefined(replay.get("growth").refSnapshot?.refs?.e34683).role, "button");
					assert.equal(
						replay.get("growth").tabTarget?.url,
						"https://fixture.test/page#private-fragment",
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
