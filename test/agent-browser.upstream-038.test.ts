import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { extractUpstreamCommandTokens, parseCommandInfo } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { getRecordCommandOperands, isRecordPageTransitionCommand } from "../extensions/agent-browser/lib/command-taxonomy.js";
import { getExplicitArtifactDestination } from "../extensions/agent-browser/lib/orchestration/browser-run/artifact-paths.js";
import { repairScreenshotData } from "../extensions/agent-browser/lib/orchestration/browser-run/prepare.js";
import { getGuardedRefUsage } from "../extensions/agent-browser/lib/orchestration/browser-run/session-state.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import { extractRefSnapshotFromData } from "../extensions/agent-browser/lib/session-page-state.js";
import { createExtensionHarness, executeRegisteredTool, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

const origin = "https://example.test/";
const refs = { e4: { role: "button", name: "Save" } };
const tree = '- button "Save" [ref=e4]';

test("failed full ref reads after native partial snapshots invalidate direct and batch refs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-delta-failure-"));
	try {
		await writeFakeAgentBrowserBinary(cwd, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const partial = { origin: ${JSON.stringify(origin)}, snapshot: { kind: 'unchanged', baseRevision: 1, revision: 2 } };
const delta = args.includes('--delta') || args.some(arg => arg.includes('snapshot --delta')) || args.includes('batch');
let data = { url: ${JSON.stringify(origin)}, title: 'Fixture' };
if (delta) {
  fs.writeFileSync('partial-seen', 'yes');
  data = args.includes('batch') ? [{ command: ['snapshot', '--delta'], success: true, result: partial }] : partial;
} else if (args.includes('snapshot')) {
  if (fs.existsSync('partial-seen')) { console.log(JSON.stringify({ success: false, error: 'Snapshot transport unavailable' })); process.exit(1); }
  data = { origin: ${JSON.stringify(origin)}, snapshot: ${JSON.stringify(tree)}, refs: ${JSON.stringify(refs)} };
}
console.log(JSON.stringify({ success: true, data }));
`);
		await withPatchedEnv({ PATH: `${cwd}${delimiter}${process.env.PATH}` }, async () => {
			for (const args of [["snapshot", "--delta"], ["batch", "snapshot --delta"], ["batch"]]) {
				await rm(join(cwd, "partial-seen"), { force: true });
				const h = createExtensionHarness({ cwd });
				await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
				const call = (args: string[], stdin?: string) => executeRegisteredTool(h.tool, h.ctx, { args: ["--session", "delta-failure", ...args], stdin });
				assert.equal((await call(["snapshot", "-i"])).isError, false);
				const partial = await call(args, args.length === 1 ? '[["snapshot","--delta"]]' : undefined);
				assert.equal(partial.isError, false, partial.content[0]?.text);
				assert.equal((partial.details?.refSnapshotInvalidation as { reason?: string })?.reason, "page-transition");
				const blocked = await call(["click", "@e4"]);
				assert.equal(blocked.isError, true);
				assert.equal(blocked.details?.failureCategory, "stale-ref");
			}
		});
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("contact sheets are pending images until stop and verified separately from video", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-sheet-"));
	try {
		const path = join(cwd, "capture.contact-sheet.png");
		const data = { contactSheetPath: path };
		const start = await buildToolPresentation({ cwd, commandInfo: { command: "record", subcommand: "start" }, envelope: { success: true, data } });
		assert.equal(start.artifacts?.[0]?.kind, "image");
		assert.equal(start.artifactVerification?.pendingCount, 1);
		assert.equal(start.content.some((item) => item.type === "image"), false);
		await writeFile(path, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
		const stop = await buildToolPresentation({ cwd, commandInfo: { command: "record", subcommand: "stop" }, envelope: { success: true, data } });
		assert.equal(stop.artifacts?.[0]?.kind, "image");
		assert.equal(stop.artifactVerification?.verifiedCount, 1);
		assert.equal(stop.artifacts?.[0]?.recording, undefined);
		assert.equal(stop.content.some((item) => item.type === "image"), true);
		const videoPath = join(cwd, "capture.webm");
		await writeFile(videoPath, "native video fixture");
		const batch = await buildToolPresentation({ cwd, sessionName: "recording", commandInfo: { command: "batch" }, envelope: { success: true, data: [
			{ command: ["record", "start", videoPath, "--contact-sheet"], success: true, result: { path: videoPath, contactSheetPath: path } },
			{ command: ["record", "stop"], success: true, result: { path: videoPath, contactSheetPath: path } },
		] } });
		assert.equal(batch.artifacts?.length, 2);
		assert.equal(batch.artifactVerification?.pendingCount, 0);
		assert.equal(batch.artifactVerification?.verifiedCount, 2);
		assert.equal(batch.artifactVerification?.verified, true);
		assert.equal(batch.nextActions?.some((action) => action.id === "stop-pending-recording"), false);
		const restart = await buildToolPresentation({ cwd, commandInfo: { command: "record", subcommand: "restart" }, previousRecordingContactSheetPath: path, envelope: { success: true, data: { path: join(cwd, "next.webm") } } });
		const previousSheet = restart.artifacts?.find((artifact) => artifact.kind === "image");
		assert.equal(previousSheet?.absolutePath, path);
		assert.equal(previousSheet?.exists, true);
		assert.equal(previousSheet?.status, "unverified", "restart omits native terminal sheet evidence");
		assert.equal(previousSheet?.subcommand, "restart-previous");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("helper-only WebMCP updates survive the tool boundary without leaking across calls", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-catalog-"));
	try {
		await writeFakeAgentBrowserBinary(cwd, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1];
const data = { title: 'Fixture', url: ${JSON.stringify(origin)} };
if (args.includes('get') && args.includes('url') && fs.existsSync(session)) {
 fs.unlinkSync(session);
 data.webmcp = { status: 'ready', untrusted: true, tools: [{name: session, description: 'Discovered by helper'}] };
}
console.log(JSON.stringify({ success: true, data }));
`);
		await withPatchedEnv({ PATH: `${cwd}${delimiter}${process.env.PATH}` }, async () => {
			const h = createExtensionHarness({ cwd });
			await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
			await Promise.all(["catalog-a", "catalog-b"].map(async (session) => {
				const call = (args: string[]) => executeRegisteredTool(h.tool, h.ctx, { args: ["--session", session, ...args] });
				await call(["open", origin]);
				await writeFile(join(cwd, session), "advertise");
				const result = await call(["get", "title"]);
				assert.equal(result.isError, false);
				assert.equal((result.details?.data as { webmcp?: unknown }).webmcp, undefined, "keep native main-command data unchanged");
				assert.equal((result.details?.webMcpCatalog as { tools: Array<{ name: string }> }).tools[0].name, session);
				assert.match(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /Discovered by helper/);
				const later = await call(["get", "title"]);
				assert.equal(later.details?.webMcpCatalog, undefined);
				await writeFile(join(cwd, session), "advertise");
				const json = await call(["--json", "get", "title"]);
				assert.doesNotThrow(() => JSON.parse(json.content[0]?.text ?? ""));
				assert.ok(json.details?.webMcpCatalog);
			}));
		});
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("native WebMCP catalog updates remain visible on snapshot and ordinary action results", async () => {
	for (const command of ["snapshot", "click"]) {
		for (const tools of [[{ name: "search", description: "Search this page", frameId: "main", origin }], []]) {
			const data = { origin, snapshot: tree, refs, clicked: "@e4", webmcp: { experimental: true, untrusted: true, status: "ready", available: tools.length > 0, toolCount: tools.length, tools } };
			const result = await buildToolPresentation({ cwd: process.cwd(), commandInfo: { command }, envelope: { success: true, data } });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			assert.match(text, /WebMCP catalog update.*untrusted/);
			assert.match(text, new RegExp(`"toolCount":${tools.length}`));
			if (tools.length) assert.match(text, /Search this page/);
		}
	}
});

test("session input mode is stripped without losing the command or ref", () => {
	for (const args of [["--input-mode", "human", "click", "@e4", "--human"], ["click", "@e4", "--input-mode", "smooth", "--human"]]) {
		assert.equal(parseCommandInfo(args).command, "click");
		assert.deepEqual(extractUpstreamCommandTokens(args), ["click", "@e4", "--human"]);
		assert.deepEqual(getGuardedRefUsage(extractUpstreamCommandTokens(args)), ["e4"]);
	}
});

test("recording presentation options are not paths or navigation URLs", () => {
	for (const subcommand of ["start", "restart"]) {
		for (const args of [
			["record", subcommand, "--cursor", "--contact-sheet", "capture.webm"],
			["record", subcommand, "capture.webm", "--cursor", "--contact-sheet-threshold", "0.1", "--fps", "30"],
		]) {
			assert.deepEqual(getRecordCommandOperands(args), { path: "capture.webm", url: undefined });
			assert.equal(getExplicitArtifactDestination(args), "capture.webm");
			assert.equal(isRecordPageTransitionCommand(args), subcommand === "start");
			assert.equal(getRecordCommandOperands([...args, origin]).url, origin);
		}
	}
});

test("conditional screenshot flags preserve selector and destination operands", () => {
	for (const args of [
		["screenshot", "--if-changed", "@e4", "shots/page.png"],
		["screenshot", "--threshold", "0.01", "@e4", "shots/page.png"],
		["screenshot", "--full", "@e4", "--if-changed", "shots/page.png", "--threshold", "0"],
	]) {
		assert.equal(getExplicitArtifactDestination(args), "shots/page.png");
		assert.deepEqual(getGuardedRefUsage(args), ["e4"]);
	}
	assert.equal(getExplicitArtifactDestination(["screenshot", "--if-changed", "--threshold", "0.01"]), undefined);
});

test("unchanged screenshots never invent a saved path or attach an old image", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-conditional-"));
	try {
		const path = join(cwd, "old.png");
		await writeFile(path, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
		const data = { changed: false, revision: 2, pixelChangeRatio: 0, threshold: 0 };
		const repaired = await repairScreenshotData({ cwd, data, request: { absolutePath: path, path } });
		assert.deepEqual(repaired.data, data);
		const result = await buildToolPresentation({ cwd, commandInfo: { command: "screenshot" }, envelope: { success: true, data: repaired.data }, artifactRequest: repaired.request });
		assert.equal(result.artifacts?.length ?? 0, 0);
		assert.equal(result.content.some((item) => item.type === "image"), false);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /unchanged/i);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("native delta full snapshots expose refs and tree without discarding the native payload", async () => {
	const data = { origin, snapshot: { kind: "full", revision: 1, tree, refs } };
	assert.deepEqual(extractRefSnapshotFromData(data)?.refIds, ["e4"]);
	const result = await buildToolPresentation({ cwd: process.cwd(), commandInfo: { command: "snapshot" }, envelope: { success: true, data } });
	assert.deepEqual(result.data, data);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Save.*ref=e4/);
	assert.match(result.summary, /1 refs/);
});

test("multi-change native deltas stay compact patches rather than empty tree previews", async () => {
	const changes = Array.from({ length: 14 }, (_, index) => ({ op: "replace", ref: `@e${index + 1}`, field: "name", value: `Renamed control ${index + 1}` }));
	const data = { origin, snapshot: { kind: "delta", baseRevision: 1, revision: 2, changes, treeChange: { startLine: 0, deleteCount: 14, lines: changes.map((change) => `- button "${change.value}" [ref=${change.ref.slice(1)}]`) } } };
	assert.ok(JSON.stringify(data.snapshot, null, 2).split("\n").length > 80);
	const result = await buildToolPresentation({ cwd: process.cwd(), commandInfo: { command: "snapshot" }, envelope: { success: true, data } });
	assert.deepEqual(result.data, data);
	assert.equal(result.fullOutputPath, undefined);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	for (const change of changes) { assert.ok(text.includes(change.ref)); assert.ok(text.includes(change.value)); }
	assert.doesNotMatch(text, /Refs: 0|\(no refs\)|Compact snapshot view/);
});

test("partial native snapshots display their revision and changes, not an empty page", async () => {
	for (const snapshot of [
		{ kind: "unchanged", baseRevision: 1, revision: 2 },
		{ kind: "delta", baseRevision: 2, revision: 3, changes: [{ op: "remove", ref: "@e4" }], treeChange: { startLine: 0, deleteCount: 1, lines: [] } },
	]) {
		const data = { origin, snapshot };
		assert.equal(extractRefSnapshotFromData(data), undefined, "partial refs require a native full read rather than an empty ref set");
		const result = await buildToolPresentation({ cwd: process.cwd(), commandInfo: { command: "snapshot" }, envelope: { success: true, data } });
		assert.deepEqual(result.data, data);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, new RegExp(snapshot.kind));
		assert.match(text, /revision/i);
		assert.doesNotMatch(text, /no interactive elements/);
		if (snapshot.kind === "delta") assert.match(text, /@e4/);
	}
});
