import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { BROWSER_TRANSITION_ENTRY, getBrowserRecord, applyArtifactChanges } from "../extensions/agent-browser/lib/browser-transcript.js";
import { appendBrowserRecord, captureBrowserBranch, projectJson, readBrowserEntries } from "../extensions/agent-browser/lib/browser-journal.js";
import { convertBrowserSession } from "../extensions/agent-browser/lib/browser-session-conversion.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { createExtensionHarness, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

function manager(file: string, leaf: string | null) {
	return { getSessionFile: () => file, getHeader: () => ({ id: "fixture-session" }), getSessionId: () => "fixture-session", getLeafId: () => leaf,
		getBranch() { throw new Error("Replay must not request eager branches."); }, getEntries() { throw new Error("Replay must not request all payloads."); },
		getEntry() { throw new Error("Official replay must token-load only the winning definition."); } } as unknown as ExtensionContext["sessionManager"];
}

async function records(file: string): Promise<Array<Record<string, unknown>>> {
	return (await readFile(file, "utf8")).trim().split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
}

for (const nativeMetadata of [false, true]) test(`published replay retains its captured branch while a new leaf is appended (${nativeMetadata ? "native metadata" : "official APIs"})`, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-replay-boundary-"));
	try {
		const file = join(root, "session.jsonl");
		const header = { type: "session", id: "fixture-session" };
		const entry = (id: string) => ({ type: "custom", customType: BROWSER_TRANSITION_ENTRY, id, parentId: null, data: {
			event: { version: 1, phase: "state", operationId: id, toolCallId: id, commandIndex: 0, isError: false, state: {},
				pages: [{ key: "shared", target: { url: `https://fixture.test/${id}` }, refs: { kind: "invalidate" } }] },
		} });
		const before = entry("before"), after = entry("after");
		await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(before)}\n`);
		let leaf = before.id, appended = false;
		const selected = { ...manager(file, leaf), getLeafId: () => leaf, getHeader() {
			if (!appended) {
				// Identity validation follows the awaited scan. Publish and select another
				// root here so both file projection and optional native ancestry must agree.
				appendFileSync(file, `${JSON.stringify(after)}\n`);
				leaf = after.id;
				appended = true;
			}
			return header;
		}, ...(nativeMetadata ? {
			*iterateEntryMetadata({ branchFrom }: { branchFrom?: string | null } = {}) {
				for (const item of [before, after]) if (branchFrom === undefined || item.id === branchFrom) yield { id: item.id, parentId: item.parentId };
			},
		} : {}) } as unknown as ExtensionContext["sessionManager"];
		const first = await readBrowserEntries(selected);
		assert.equal(appended, true, "the fixture must reach the concurrent publication window");
		assert.equal(SessionPageState.fromBranch(first).get("shared").tabTarget?.url, "https://fixture.test/before");
		const next = await readBrowserEntries(selected);
		assert.equal(SessionPageState.fromBranch(next).get("shared").tabTarget?.url, "https://fixture.test/after", "the next replay observes the newly published selection");
		leaf = "missing";
		await assert.rejects(readBrowserEntries(selected), /Selected journal entry missing is not persisted/);
		appendFileSync(file, JSON.stringify(entry("uncommitted")));
		leaf = "uncommitted";
		await assert.rejects(readBrowserEntries(selected), /Selected journal entry uncommitted is not persisted/, "an unterminated live entry remains unpublished");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("native branch admission permits descendants and siblings without reading bodies, but validates identity and ancestry", async () => {
	const entries = new Map<string, { id: string; parentId: string | null }>([
		["a", { id: "a", parentId: null }], ["first", { id: "first", parentId: "a" }],
		["sibling", { id: "sibling", parentId: "a" }], ["b", { id: "b", parentId: null }],
	]);
	for (const entry of entries.values()) Object.defineProperty(entry, "data", { get() { throw new Error("Admission must not hydrate bodies."); } });
	let leaf: string | null = "a", sessionId = "fixture";
	const native = { getSessionId: () => sessionId, getLeafId: () => leaf, getEntry: (id: string) => entries.get(id),
		getSessionFile: () => undefined, getEntries() { throw new Error("No eager physical scan."); }, getBranch() { throw new Error("No eager branch scan."); } } as unknown as ExtensionContext["sessionManager"];
	const branch = captureBrowserBranch(native, () => true);
	leaf = "first";
	assert.equal(branch.isCurrent(), true);
	leaf = "sibling";
	assert.equal(branch.isCurrent(), true, "another append below the original anchor remains admissible");
	leaf = "b";
	assert.equal(branch.isCurrent(), false);
	leaf = "a"; sessionId = "replacement";
	assert.equal(branch.isCurrent(), false, "matching entry IDs cannot substitute for native session identity");
	sessionId = "fixture";
	for (const broken of [{ id: "bad", parentId: "missing" }, { id: "bad", parentId: "bad" }, { id: "bad", parentId: 7 }]) {
		entries.set("bad", broken as { id: string; parentId: string });
		leaf = "bad";
		assert.throws(() => branch.isCurrent(), /ancestry/, "invalid native ancestry remains a validation error");
	}
	leaf = null;
	const empty = captureBrowserBranch(native, () => true);
	leaf = "b";
	assert.equal(empty.isCurrent(), false, "an empty anchor cannot admit an independent pre-existing root");
	leaf = null;
	const record = { event: { version: 1 as const, phase: "begin" as const, operationId: "empty", toolCallId: "empty", commandIndex: 0, isError: true, state: {} } };
	assert.equal(await appendBrowserRecord(native, () => { leaf = "a"; }, record, empty), true, "an empty in-memory branch advances only from its own synchronous append");
	leaf = "sibling";
	assert.equal(empty.isCurrent(), true);
});

for (const earlierHandler of [false, true]) for (const boundary of ["begin", "finish", "observation", "host-finish"] as const) test(`branch selection during ${boundary} journal preparation cannot publish old state onto B (${earlierHandler ? "earlier awaited handler" : "immediate event"})`, { concurrency: false, timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-append-branch-"));
	try {
		const file = join(root, "session.jsonl"), log = join(root, "commands.jsonl");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'),args=process.argv.slice(2),stdin=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');
process.stdout.write(JSON.stringify({success:true,data:args.includes('eval')?{result:'x'.repeat(24000)}:{url:'https://fixture.test/page'}}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const branch = (id: string) => [{ type: "message", id, parentId: null, message: { role: "user", content: [{ type: "text", text: `Branch ${id}` }] } }];
			let armed = false, selected = false;
			let tree: Promise<void> | undefined;
			let releaseEarlierHandler!: () => void;
			const earlierHandlerHeld = new Promise<void>(resolve => { releaseEarlierHandler = resolve; });
			let earlierHandlerEntered = false;
			const harness = createExtensionHarness({ cwd: root, sessionFile: file, branch: branch("a"), onAppendEntry(type, data) {
				if (type !== BROWSER_TRANSITION_ENTRY) return;
				const phase = (data as { event: { phase: string } }).event.phase;
				if (phase === (boundary === "observation" ? "finish" : "begin")) armed = true;
			} });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			if (earlierHandler) harness.handlers.get("session_tree")!.unshift(async () => {
				earlierHandlerEntered = true;
				await earlierHandlerHeld;
			});
			const getSessionFile = harness.ctx.sessionManager.getSessionFile;
			Object.defineProperty(harness.ctx.sessionManager, "getSessionFile", { value: () => {
				if (armed && !selected) {
					selected = true;
					// Native tree navigation selects its leaf before emitting the awaited event.
					queueMicrotask(() => {
						harness.setBranch(branch("b"));
						tree = runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "b", oldLeafId: "a" }, harness.ctx);
					});
				}
				return getSessionFile();
			} });
			armed = boundary === "begin";
			const result = boundary === "observation"
				? await executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { session: "append-race", code: 'await browser({args:["get","url"]}); emit("x".repeat(24000));' })
				: boundary === "host-finish"
					? await executeRegisteredTool(harness.getTool("agent_browser_electron")!, harness.ctx, { action: "probe" })
					: await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "append-race", "eval", "--stdin"], stdin: "MUTATE_FIXTURE" });
			if (earlierHandler) assert.equal(earlierHandlerEntered, true, "the earlier extension is still awaiting work before this extension sees the tree event");
			releaseEarlierHandler();
			await tree;
			assert.equal(selected, true, "navigation must reach the awaited publication window");
			assert.deepEqual(harness.ctx.sessionManager.getBranch().map(entry => (entry as { id: string }).id), ["b"], "the old caller cannot append a begin, finish or artifact receipt beneath B");
			const mutations = (await readInvocationLog(log)).filter(row => row.stdin === "MUTATE_FIXTURE");
			if (boundary === "begin") {
				assert.equal(result.details?.browserStatePersistence, "begin-unconfirmed");
				assert.equal(mutations.length, 0, "stale intent never authorizes dispatch");
			} else if (boundary === "finish") {
				assert.equal(result.details?.browserStatePersistence, "finish-unconfirmed");
				assert.equal(mutations.length, 1, "the completed effect is not retried");
				assert.equal(JSON.parse(await readFile(String(result.details?.fullOutputPath), "utf8")).result, "x".repeat(24000), "the stale caller retains its full observation");
				const all = (await records(file)).filter(entry => entry.type !== "session");
				assert.equal(all.map(getBrowserRecord).filter(record => record?.event.phase === "begin").length, 1);
				assert.equal(all.map(getBrowserRecord).some(record => record?.event.phase === "finish"), false);
				assert.equal(SessionPageState.fromBranch(all).get("append-race").tabTargetUnknown, true, "A keeps its unfinished intent");
			} else if (boundary === "observation") {
				assert.equal(result.isError, false, JSON.stringify(result));
				assert.equal(result.details?.data, "x".repeat(24000));
				const observation = JSON.parse(result.content.find(part => part.type === "text")?.text ?? "{}");
				assert.equal(JSON.parse(await readFile(observation.observationPath, "utf8")).data, "x".repeat(24000));
			} else assert.equal(result.details?.browserStatePersistence, "finish-unconfirmed", "host completion does not claim a durable finish after branch withdrawal");
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const memory of [false, true]) test(`sessionless observations do not require browser replay publication (${memory ? "in-memory" : "unpublished"})`, { concurrency: false }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-sessionless-receipt-"));
	try {
		const log = join(root, "commands.jsonl"), file = join(root, "session.jsonl");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args})+'\\n');
const data=args.includes('skills')?(args.includes('get')?{content:'x'.repeat(60000),password:'fixture-output-secret'}:{skills:['core']}):args.includes('read')?{content:'Fetched page',source:'http',url:'https://fixture.test/content'}:args.includes('url')?{url:'https://fixture.test/page'}:{active:false,runtime:null};
process.stdout.write(JSON.stringify({success:true,data}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1", AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const harness = createExtensionHarness({ cwd: root, sessionFile: memory ? null : file });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			if (!memory) await rm(file);
			const commands = [["skills", "list"], ["session", "info"], ["read", "https://fixture.test/content"]];
			for (const args of commands) {
				await t.test(args.join(" "), async () => {
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.equal(result.details?.browserStatePersistence, undefined);
				});
			}
			await t.test("oversized output and selected readback", async () => {
				const selectedPath = join(root, "selected-output.json");
				const large = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "get", "core", "--full"], outputPath: selectedPath });
				assert.equal(large.isError, false, JSON.stringify(large));
				assert.equal(large.details?.browserStatePersistence, undefined);
				assert.equal(typeof large.details?.fullOutputPath, "string");
				const full = await readFile(String(large.details?.fullOutputPath), "utf8");
				assert.equal(JSON.parse(full).content, "x".repeat(60000));
				assert.doesNotMatch(full, /fixture-output-secret/);
				assert.deepEqual(JSON.parse(await readFile(selectedPath, "utf8")), JSON.parse(full), "selected output retains the complete redacted data");
			});
			const observations = await readInvocationLog(log);
			assert.equal(observations.length, commands.length + 1, "large and small sessionless observations dispatch no browser helpers");
			observations.slice(0, commands.length).forEach((row, index) => assert.deepEqual(row.args.slice(-commands[index].length), commands[index]));
			const status = await executeRegisteredTool(harness.getTool("agent_browser_electron")!, harness.ctx, { action: "status", launchId: "missing" });
			assert.equal(status.details?.failureCategory, "validation-error", "local host validation keeps its own result without a replay write");
			assert.equal(status.details?.browserStatePersistence, undefined);
			assert.equal(harness.appendedEntries.length, 0, "private observations do not invent replay state");
			const browser = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "memory-boundary", "get", "url"] });
			if (memory) {
				assert.equal(browser.isError, false, JSON.stringify(browser));
				assert.equal(browser.details?.browserStatePersistence, undefined, "direct in-memory state makes no durability claim");
				assert.equal(harness.appendedEntries.filter(entry => getBrowserRecord({ type: "custom", ...entry })?.event.phase === "begin").length, 1);
				assert.equal((await readBrowserEntries(harness.ctx.sessionManager as unknown as ExtensionContext["sessionManager"])).length, harness.appendedEntries.length, "public in-memory ancestry retains canonical state");
				const beforeCode = (await readInvocationLog(log)).length;
				const code = await executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { code: 'await browser({args:["eval","--stdin"],stdin:"NEVER_DISPATCH"});' });
				assert.equal(code.isError, true);
				assert.equal(code.details?.failureCategory, "validation-error");
				assert.equal((await readInvocationLog(log)).length, beforeCode, "code requires published intent even in an in-memory session");
			} else {
				assert.equal(browser.details?.browserStatePersistence, "begin-unconfirmed", "a named but unpublished persistent session still refuses dispatch");
				assert.equal((await readInvocationLog(log)).some(row => row.args.includes("memory-boundary")), false);
				assert.equal(harness.appendedEntries.length, 0);
			}
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("converter CLI retains the published copy's receipt when its optional receipt path is occupied", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-conversion-cli-"));
	try {
		const source = join(root, "source.jsonl"), destination = join(root, "copy.jsonl"), receiptPath = join(root, "receipt.json");
		const bytes = `${JSON.stringify({ type: "session", version: 3, id: "fixture-session", cwd: root })}\n`;
		await writeFile(source, bytes, { mode: 0o600 });
		await writeFile(receiptPath, "retained receipt");
		const cli = join(process.cwd(), "scripts/convert-browser-session.mjs");
		const args = [cli, "--source", source, "--output", destination, "--confirm-stopped", "--receipt", receiptPath];
		const converted = spawnSync(process.execPath, args, { encoding: "utf8" });
		assert.equal(converted.status, 1, "optional receipt failure remains visible");
		assert.match(converted.stderr, /EEXIST/);
		const receipt = JSON.parse(converted.stdout);
		assert.equal(receipt.sourceSha256, createHash("sha256").update(bytes).digest("hex"));
		assert.equal(receipt.destinationSha256, createHash("sha256").update(await readFile(destination)).digest("hex"));
		assert.equal(receipt.sessionId, "fixture-session");
		assert.equal(await readFile(source, "utf8"), bytes);
		assert.equal(await readFile(receiptPath, "utf8"), "retained receipt");
		const occupied = spawnSync(process.execPath, args, { encoding: "utf8" });
		assert.equal(occupied.status, 1);
		assert.match(occupied.stderr, /occupied/);
		assert.equal(occupied.stdout, "", "a refusal does not invent a new conversion receipt");
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const repair of ["append", "rewrite"] as const) test(`a repaired ${repair} publishes dirty entries and a new matching begin without retrying the failed effect`, { concurrency: false }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-dirty-receipt-"));
	try {
		const log = join(root, "commands.jsonl"), file = join(root, "session.jsonl");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'); const args=process.argv.slice(2); const stdin=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');
process.stdout.write(JSON.stringify({success:true,data:{url:'https://fixture.test/unchanged'}}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			let dirty: string | undefined;
			let failed = false;
			const harness = createExtensionHarness({ cwd: root, sessionFile: file, onAppendEntry(type, data) {
				if (type !== BROWSER_TRANSITION_ENTRY) return;
				if (!failed && (data as { event?: { phase: string } }).event?.phase === "begin") {
					failed = true;
					dirty = JSON.stringify(harness.ctx.sessionManager.getEntry(harness.ctx.sessionManager.getLeafId()!));
					throw new Error("accepted native entry could not be persisted");
				}
				if (dirty) {
					if (repair === "append") appendFileSync(file, `\n${dirty}\n`);
					else { writeFileSync(`${file}.repair`, `${readFileSync(file, "utf8")}\n${dirty}\n`); renameSync(`${file}.repair`, file); }
					dirty = undefined;
				}
			} });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const prefix = ["--session", "dirty-receipt"];
			const refused = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "eval", "--stdin"], stdin: "NEVER_RETRY_MUTATION" });
			assert.equal(refused.details?.browserStatePersistence, "begin-unconfirmed", JSON.stringify(refused));
			const inspected = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "url"] });
			assert.equal(inspected.isError, false, JSON.stringify(inspected));
			assert.equal((await readInvocationLog(log)).some(row => row.stdin === "NEVER_RETRY_MUTATION"), false);
			const persisted = await records(file);
			assert.equal(persisted.filter(entry => getBrowserRecord(entry)?.event.phase === "begin").length, 2);
			assert.equal(persisted.filter(entry => getBrowserRecord(entry)?.event.phase === "finish").length, 1);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const failPhase of ["begin", "finish"] as const) test(`a real journal ${failPhase} fault does not retry a browser effect`, { concurrency: false, timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-persistence-fault-"));
	try {
		const log = join(root, "commands.jsonl");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'); const args=process.argv.slice(2); const stdin=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');
const command=args.find(arg=>['open','get','snapshot','eval','tab','close'].includes(arg)); const url='https://fixture.test/page';
const data=command==='snapshot' ? {url,snapshot:'- button "Go" [ref=e1]',refs:{e1:{role:'button',name:'Go'}}} : command==='tab' ? {tabs:[{tabId:'t1',url,active:true}]} : command==='get' && args.includes('title') ? {title:'Fixture'} : {url};
process.stdout.write(JSON.stringify({success:true,data}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			let fail = false;
			const journal = join(root, "session.jsonl");
			const harness = createExtensionHarness({ cwd: root, sessionFile: journal, onAppendEntry(type, data) {
				if (fail && type === BROWSER_TRANSITION_ENTRY && (data as { event?: { phase: string } }).event?.phase === failPhase) throw new Error("fixture disk write failed");
			} });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "fault", "snapshot", "-i"] });
			fail = true;
			const result = await executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { session: "fault", code: 'await browser({args:["eval","--stdin"],stdin:"MUTATE_FIXTURE"}); await browser({args:["eval","--stdin"],stdin:"MUTATE_FIXTURE"});' });
			const mutations = (await readInvocationLog(log)).filter(row => row.stdin === "MUTATE_FIXTURE");
			assert.equal(mutations.length, failPhase === "begin" ? 0 : 1, "begin failure prevents dispatch; finish failure stops dependent calls");
			assert.equal(result.isError, true);
			fail = false;
			if (failPhase === "finish") {
				const persisted = (await records(journal)).filter(entry => entry.type !== "session");
				const pending = SessionPageState.fromBranch(persisted).get("fault");
				assert.equal(pending.tabTargetUnknown, true);
				assert.equal(pending.refSnapshot, undefined);
				const resumed = createExtensionHarness({ cwd: root, sessionFile: journal, branch: persisted });
				await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
				assert.equal((await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["--session", "fault", "get", "url"] })).isError, false);
				const stale = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["--session", "fault", "click", "@e1"] });
				assert.equal(stale.details?.failureCategory, "stale-ref", "URL inspection cannot restore an unfinished operation's refs");
				assert.equal((await readInvocationLog(log)).filter(row => row.stdin === "MUTATE_FIXTURE").length, 1);
				await runExtensionEvent(resumed.handlers, "session_shutdown", { reason: "quit" }, resumed.ctx);
			}
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an unfinished fresh launch retains only its original owner's cleanup scope", { concurrency: false }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-pending-owner-"));
	const socketDir = await mkdtemp("/tmp/po-");
	const otherSocketDir = await mkdtemp("/tmp/pf-");
	try {
		const log = join(root, "commands.jsonl");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,socketDir:process.env.AGENT_BROWSER_SOCKET_DIR})+'\\n');
process.stdout.write(JSON.stringify({success:true,data:{url:'https://fixture.test/created'}}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const file = join(root, "session.jsonl");
			const harness = createExtensionHarness({ cwd: root, sessionFile: file, onAppendEntry(type, data) {
				if (type === BROWSER_TRANSITION_ENTRY && (data as { event?: { phase: string } }).event?.phase === "finish") throw new Error("finish write failed");
			} });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://fixture.test/created"], sessionMode: "fresh" });
			assert.equal(result.details?.browserStatePersistence, "finish-unconfirmed");
			const persisted = (await records(file)).filter(entry => entry.type !== "session");
			const begin = persisted.map(getBrowserRecord).find(record => record?.event.phase === "begin")!.event;
			assert.equal(begin.state.wrapperManaged, true);
			assert.equal(begin.state.usedImplicitSession, false, "fresh allocation is owned even though it is not automatic session reuse");
			assert.equal(begin.state.managedSessionSocketDir, socketDir);
			const sessionName = String(begin.state.sessionName);
			await writeFile(log, "");
			await withPatchedEnv({ PI_AGENT_BROWSER_SOCKET_DIR: otherSocketDir }, async () => {
			const fork = createExtensionHarness({ cwd: root, sessionId: "ordinary-fork", branch: persisted });
			await runExtensionEvent(fork.handlers, "session_start", { reason: "fork" }, fork.ctx);
			await runExtensionEvent(fork.handlers, "session_shutdown", { reason: "quit" }, fork.ctx);
			assert.equal((await readInvocationLog(log)).some(row => row.args.includes("close")), false);
			const resumed = createExtensionHarness({ cwd: root, branch: persisted });
			await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
			await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["--session", sessionName, "get", "url"] });
			await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["--session", "caller-owned", "get", "url"] });
			await runExtensionEvent(resumed.handlers, "session_shutdown", { reason: "quit" }, resumed.ctx);
			const invocations = await readInvocationLog(log) as Array<{ args: string[]; socketDir: string }>;
			assert.equal(invocations.filter(row => row.args.includes("close") && row.args.includes(sessionName)).length, 1, "restart can clean its wrapper-selected unresolved launch without claiming it succeeded");
			assert.equal(invocations.filter(row => row.args.includes(sessionName)).every(row => row.socketDir === socketDir), true, "helpers, commands and cleanup retain their original socket root");
			assert.equal(invocations.filter(row => row.args.includes("caller-owned")).every(row => row.socketDir === otherSocketDir), true, "unrelated caller sessions keep native routing");
			});
		});
	} finally { await Promise.all([root, socketDir, otherSocketDir].map(path => rm(path, { recursive: true, force: true }))); }
});

test("conversion preserves all original ancestry, interrupted prefixes, snapshots and artifact provenance", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-conversion-"));
	try {
		const source = join(root, "original.jsonl"), destination = join(root, "converted.jsonl");
		const header = { type: "session", version: 3, id: "fixture-session", timestamp: "2026-09-30T00:00:00.000Z", cwd: root };
		const snapshot = { refIds: ["e1", "e2"], refs: { e1: { role: "textbox", name: "Name", isEditable: true } }, target: { url: "https://fixture.test/page#private-fragment", targetId: "native-tab" } };
		const row = { path: join(root, "caller.png"), absolutePath: join(root, "caller.png"), createdAtMs: 1, storageScope: "explicit-path", retentionState: "live", kind: "image", exists: true };
		const manifest = { version: 1, entries: [row], liveCount: 1, evictedCount: 0, updatedAtMs: 1, maxEntries: 100 };
		const legacy = (id: string, parentId: string | null, details: object, isError = false) => ({ type: "custom", customType: BROWSER_TRANSITION_ENTRY, id, parentId, timestamp: header.timestamp, data: { toolCallId: "outer", details, isError } });
		const originals = [header,
			legacy("capture", null, { args: ["snapshot", "-i"], command: "snapshot", sessionName: "shared", sessionTabTarget: snapshot.target, refSnapshot: snapshot, artifactManifest: manifest }),
			legacy("begin", "capture", { args: ["fill", "@e1", "Test"], sessionName: "shared", sessionTabTargetUnknown: true }, true),
			legacy("finish", "begin", { args: ["fill", "@e1", "Test"], command: "fill", sessionName: "shared", sessionTabTarget: snapshot.target, refSnapshot: snapshot, artifactManifest: manifest }),
			legacy("branch-b", "capture", { args: ["snapshot", "-i"], command: "snapshot", sessionName: "shared", sessionTabTarget: { url: "https://fixture.test/other#b" }, refSnapshot: { refIds: ["e3"], refs: { e3: { role: "button", name: "Other" } } }, artifactManifest: { ...manifest, entries: [{ ...row, retentionState: "missing", exists: false }], liveCount: 0, updatedAtMs: 2 } }),
			{ type: "label", id: "label-b", parentId: "branch-b", targetId: "branch-b", label: "Branch B", timestamp: header.timestamp },
			{ type: "message", id: "result", parentId: "finish", timestamp: header.timestamp, message: { role: "toolResult", toolName: "agent_browser", toolCallId: "outer", isError: false, content: [{ type: "image", data: "selected-image-bytes", mimeType: "image/png" }], details: { args: ["get", "title"], sessionName: "shared", refSnapshot: snapshot, artifactManifest: manifest, data: { explicit: "caller data 🧪" } } } },
			{ type: "message", id: "modern", parentId: "result", timestamp: header.timestamp, message: { role: "toolResult", toolName: "agent_browser", toolCallId: "modern", isError: false, content: [{ type: "text", text: "Requested observation" }], details: { browserEventVersion: 1, args: ["get", "title"], sessionName: "shared", refSnapshot: { refIds: ["e9"] }, artifactManifest: { ...manifest, entries: [], liveCount: 0 }, data: { explicit: "modern caller data" } } } },
		];
		const bytes = Buffer.from(originals.map(entry => JSON.stringify(entry)).join("\n"));
		await writeFile(source, bytes, { mode: 0o600 }); // A sealed valid unterminated record is inspectable, without repairing the source.
		const receipt = await convertBrowserSession({ source, destination, confirmedStopped: true });
		assert.equal(receipt.sourceSha256, createHash("sha256").update(bytes).digest("hex"));
		assert.deepEqual(await readFile(source), bytes);
		const converted = await records(destination);
		assert.deepEqual(converted.map(entry => [entry.id, entry.parentId]), originals.map(entry => [entry.id, "parentId" in entry ? entry.parentId : undefined]));
		assert.equal(receipt.snapshotDefinitions, 2, "repeated completions reuse only ancestral definitions");
		for (const leaf of ["capture", "begin", "finish", "branch-b", "label-b", "result", "modern"]) {
			const branch = await readBrowserEntries(manager(destination, leaf));
			const state = SessionPageState.fromBranch(branch).get("shared");
			if (leaf === "begin") { assert.equal(state.tabTargetUnknown, true); assert.equal(state.refSnapshot, undefined); }
			else { assert.deepEqual(state.refSnapshot?.refIds, leaf === "branch-b" || leaf === "label-b" ? ["e3"] : ["e1", "e2"]); }
			if (["capture", "finish", "result"].includes(leaf)) {
				assert.equal(state.tabTarget?.url, "https://fixture.test/page#private-fragment");
				assert.equal(state.refSnapshot?.refs?.e1.isEditable, true);
				assert.equal(state.refSnapshot?.target?.targetId, "native-tab");
			}
			let recent;
			for (const entry of branch) recent = applyArtifactChanges(recent, getBrowserRecord(entry)?.event.artifacts);
			assert.equal(recent?.entries[0].path, row.path);
			assert.equal(recent?.entries[0].retentionState, leaf === "branch-b" || leaf === "label-b" ? "missing" : "live");
		}
		const nativeReads: string[] = [];
		const nativeManager = { ...manager(destination, "result"),
			getEntryMetadata: (id: string) => ({ id }),
			*iterateEntryMetadata() {
				for (const [id, parentId] of [["capture", null], ["begin", "capture"], ["finish", "begin"], ["result", "finish"]]) yield { id, parentId };
			},
			getEntry(id: string) {
				nativeReads.push(id);
				assert.equal(id, "capture", "the optional native adapter loads only the winning ancestral snapshot");
				return converted.find(entry => entry.id === id);
			},
		} as unknown as ExtensionContext["sessionManager"];
		const nativeBranch = await readBrowserEntries(nativeManager);
		assert.deepEqual(nativeReads, ["capture"]);
		assert.deepEqual(SessionPageState.fromBranch(nativeBranch).get("shared").refSnapshot?.refIds, ["e1", "e2"]);
		const result = converted.find(entry => entry.id === "result")!;
		assert.deepEqual((result.message as { details: { data: object }; content: unknown }).details.data, { explicit: "caller data 🧪" });
		assert.deepEqual((result.message as { content: unknown }).content, (originals.find(entry => entry.id === "result")! as { message: { content: unknown } }).message.content);
		assert.deepEqual(converted.find(entry => entry.id === "modern"), originals.at(-1), "modern observations retain explicit bodies and cannot overwrite canonical state with an invocation-only receipt");
		assert.equal((result.data as { archive: { sourceSha256: string } }).archive.sourceSha256, receipt.sourceSha256);
		await assert.rejects(convertBrowserSession({ source, destination, confirmedStopped: true }), /occupied/);
		await assert.rejects(convertBrowserSession({ source, destination: join(root, "unconfirmed.jsonl"), confirmedStopped: false }), /quiesce/);
		await writeFile(source, `${bytes}\n{broken`);
		await assert.rejects(convertBrowserSession({ source, destination: join(root, "malformed.jsonl"), confirmedStopped: true }), /Parser|parse|expected/i);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("token projection validates skipped values, splits Unicode safely and discards giant unused strings", async () => {
	async function* bytes(text: string) { for (const byte of Buffer.from(text)) yield Uint8Array.of(byte); }
	assert.deepEqual(await projectJson(bytes('{"ignored":"unused","id":"🧪é","data":{"event":{"version":1,"ok":true}}}'), [["id"], ["data", "event"]]), { id: "🧪é", data: { event: { version: 1, ok: true } } });
	await assert.rejects(projectJson(bytes('{"ignored":[false,invalid],"id":"never"}'), [["id"]]));
	async function* ignored() { yield Buffer.from('{"ignored":"'); for (let index = 0; index < 64; index++) yield Buffer.alloc(64 * 1024, 120); yield Buffer.from('","id":"kept"}'); }
	assert.deepEqual(await projectJson(ignored(), [["id"]], 128), { id: "kept" });
});

test("missing or corrupt winning snapshots fail replay before refs can be used", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-corrupt-snapshot-"));
	try {
		const file = join(root, "session.jsonl");
		const header = { type: "session", id: "fixture-session" };
		const entry = { type: "custom", customType: BROWSER_TRANSITION_ENTRY, id: "capture", parentId: null, data: {
			event: { version: 1, phase: "state", operationId: "capture", toolCallId: "call", commandIndex: 0, isError: false, state: {},
				pages: [{ key: "shared", target: { url: "https://fixture.test/same" }, refs: { kind: "replace", snapshotId: "definition" } }] },
			snapshot: { id: "definition", refs: { e1: { role: "button", name: "Go" } } },
		} };
		for (const snapshot of [undefined, { id: "definition", refs: { e1: "corrupt" } }, { id: "other", refs: {} }]) {
			await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify({ ...entry, data: { ...entry.data, snapshot } })}\n`);
			await assert.rejects(readBrowserEntries(manager(file, "capture")), /snapshot|definition/i);
		}
		await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n{"type":"custom","broken":`);
		const live = await readBrowserEntries(manager(file, "capture"));
		assert.deepEqual(SessionPageState.fromBranch(live).get("shared").refSnapshot?.refIds, ["e1"], "a torn live tail is not committed or repaired");
		assert.match(await readFile(file, "utf8"), /"broken":$/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a replacement native generation at the same URL invalidates refs until a new capture", { concurrency: false }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-generation-"));
	try {
		const log = join(root, "commands.jsonl"), generation = join(root, "generation");
		await writeFile(generation, "original");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args})+'\\n');
const url='https://fixture.test/same'; const command=args.find(arg=>['session','snapshot','get','tab'].includes(arg));
const data=command==='session' ? {active:true,runtime:{restoreKey:null,backgroundPid:process.ppid,browserLaunched:true,socketDir:fs.readFileSync(${JSON.stringify(generation)},'utf8')}}
: command==='snapshot' ? {url,snapshot:'- textbox "Name" [ref=e1]',refs:{e1:{role:'textbox',name:'Name'}}}
: command==='tab' ? {tabs:[{tabId:'t1',url,active:true}]} : args.includes('url') ? {url} : {text:'Name'};
process.stdout.write(JSON.stringify({success:true,data}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1", AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const prefix = ["--session", "generation"];
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] })).isError, false);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "text", "@e1"] })).isError, false);
			await writeFile(generation, "replacement");
			await writeFile(log, "");
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "text", "@e1"] })).details?.failureCategory, "stale-ref");
			assert.equal((await readInvocationLog(log)).some(row => row.args.includes("text")), false, "old refs never reach the replacement daemon");
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] })).isError, false);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "text", "@e1"] })).isError, false);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("restart reuses profiled owned daemon provenance only when its native generation still matches", { concurrency: false }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-profile-generation-"));
	try {
		const active = join(root, "active"), generation = join(root, "generation"), log = join(root, "calls.jsonl");
		await writeFile(generation, "original");
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args})+'\\n');
let data;
if(args.includes('session')) data={active:fs.existsSync(${JSON.stringify(active)}),runtime:fs.existsSync(${JSON.stringify(active)})?{restoreKey:null,backgroundPid:process.ppid,browserLaunched:true,socketDir:fs.readFileSync(${JSON.stringify(generation)},'utf8')}:null};
else {
  if(args.includes('open')) fs.writeFileSync(${JSON.stringify(active)}, 'active');
  data=args.includes('tab')?{tabs:[{tabId:'t1',url:'https://fixture.test/profile',active:true}]}:{url:'https://fixture.test/profile',title:'Profile fixture'};
}
process.stdout.write(JSON.stringify({success:true,data}));`);
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1", AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const original = createExtensionHarness({ cwd: root });
			await runExtensionEvent(original.handlers, "session_start", { reason: "new" }, original.ctx);
			const opened = await executeRegisteredTool(original.tool, original.ctx, { args: ["--profile", "Fixture Profile", "open", "https://fixture.test/profile"], sessionMode: "fresh" });
			assert.equal(opened.isError, false, JSON.stringify(opened));
			const branch = [...original.ctx.sessionManager.getBranch()];
			for (const current of ["original", "replacement"]) {
				await writeFile(generation, current);
				await writeFile(log, "");
				const resumed = createExtensionHarness({ cwd: root, branch: [...branch] });
				await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
				const result = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["get", "title"] });
				assert.equal(result.isError, current === "replacement", JSON.stringify(result));
				const titleCalls = (await readInvocationLog(log)).filter(row => row.args.at(-2) === "get" && row.args.at(-1) === "title");
				assert.equal(titleCalls.length, current === "original" ? 1 : 0, "a changed daemon cannot inherit recorded launch provenance");
				if (current === "replacement") assert.match(result.content[0]?.text ?? "", /live daemon.*restore policy/);
			}
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});
