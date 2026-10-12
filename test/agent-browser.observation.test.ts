import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { setTimeout as delay } from "node:timers/promises";
import {
	createExtensionHarness,
	executeRegisteredTool,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import {
	buildJsonVisibleContent,
	buildRedactedPresentationContent,
} from "../extensions/agent-browser/lib/orchestration/browser-run/final-result.js";
import { trySnapshotFilter } from "../extensions/agent-browser/lib/orchestration/browser-run/prepare/snapshot-filter.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { buildScreenshotGeometry } from "../extensions/agent-browser/lib/orchestration/browser-run/screenshot-observation.js";
import type {
	AgentBrowserNextAction,
	ScreenshotSample,
} from "../extensions/agent-browser/lib/results/contracts.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import { projectAgentBrowserObservation } from "../extensions/agent-browser/lib/results/presentation/content.js";
import {
	OBSERVATION_INLINE_MAX_CHARS,
	renderAgentBrowserObservation,
} from "../extensions/agent-browser/lib/results/presentation/large-output.js";

const actions: AgentBrowserNextAction[] = [
	{
		id: "recover",
		tool: "agent_browser",
		params: {
			args: ["--namespace", "scope", "--session", "target", "eval", "--stdin"],
			stdin: "'" + "long exact recovery".repeat(60) + "'",
		},
		reason: "Inspect the current page",
		safety: "Read-only; do not retry the mutation.",
	},
];
const verification = {
	artifacts: [{ path: "/tmp/requested.png", state: "missing", kind: "image" }],
	missingCount: 1,
	pendingCount: 0,
	unverifiedCount: 0,
	verified: false,
	verifiedCount: 0,
};

test("canonical JSON preserves array-valued page and code output", async () => {
	const data = ["a1", "a2", { count: 3 }];
	assert.deepEqual(projectAgentBrowserObservation({ data }, true).data, data);
	const rendered = await renderAgentBrowserObservation({
		content: [],
		details: { data },
		json: true,
		succeeded: true,
	});
	assert.deepEqual(
		readRecord(
			JSON.parse(
				readString(readRecord(rendered.content.find((part) => part.type === "text")).text),
			),
		).data,
		data,
	);
	assert.deepEqual(rendered.structuredContent, { success: true, resultCategory: "success", data });
});

test("JSON observations retain exact recovery, failure category and artifact verification", () => {
	const content = buildJsonVisibleContent({
		error: "missing selector",
		presentation: {
			content: [],
			summary: "Selector missing",
			failureCategory: "selector-not-found",
			nextActions: actions,
		},
		details: { artifactVerification: verification },
		succeeded: false,
	});
	const payload = readRecord(JSON.parse(content[0].type === "text" ? content[0].text : ""));
	assert.equal(payload.success, false);
	assert.equal(payload.failureCategory, "selector-not-found");
	assert.deepEqual(payload.nextActions, actions);
	assert.deepEqual(payload.artifactVerification, verification);
});

test("code observations retain identity, un-emitted failures, counters and opaque image handles", () => {
	const fields = {
		sessionName: "code-target",
		namespace: "",
		codeRun: { callCount: 2, failedCallCount: 1 },
		failures: [
			{
				success: false,
				resultCategory: "failure",
				error: "missing selector",
				nextActions: actions,
			},
		],
		imageObservations: [{ id: "image-1", path: "/tmp/selected.png" }],
	};
	const observation = projectAgentBrowserObservation(fields, false);
	for (const [key, value] of Object.entries(fields)) {
		// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(observation[key], value);
	}
});

test("exact string redaction cannot corrupt JSON booleans or structural tokens", () => {
	const content = buildRedactedPresentationContent({
		exactSensitiveValues: ["true"],
		plainTextInspection: false,
		succeeded: true,
		userRequestedJson: true,
		presentation: { content: [], summary: "done", data: { value: "true" } },
	});
	const payload = readRecord(JSON.parse(content[0].type === "text" ? content[0].text : ""));
	assert.equal(payload.success, true);
	assert.deepEqual(payload.data, { value: "[REDACTED]" });
});

test("prose retains full action payloads and projection excludes ownership state", async () => {
	const details = {
		summary: "Failed",
		failureCategory: "artifact-missing",
		nextActions: actions,
		artifactVerification: verification,
		refSnapshot: { private: "unrelated replay state" },
		managedSessionOutcome: { internal: true },
		password: "hidden",
		data: { password: "secret", requested: 42 },
	};
	const observation = projectAgentBrowserObservation(details, false);
	assert.deepEqual(observation.data, { password: "[REDACTED]", requested: 42 });
	assert.equal(
		projectAgentBrowserObservation({ inspection: true, stdout: "Native --help" }, true).data,
		"Native --help",
	);
	assert.equal(observation.refSnapshot, undefined);
	assert.equal(observation.managedSessionOutcome, undefined);
	const rendered = await renderAgentBrowserObservation({
		content: [{ type: "text", text: "Failed" }],
		details,
		json: false,
		succeeded: false,
	});
	const text =
		rendered.content[0].type === "text" ? readString(readRecord(rendered.content[0]).text) : "";
	const metadata = readRecord(JSON.parse(text.split("Observation: ")[1]));
	assert.deepEqual(metadata.nextActions, actions);
	assert.deepEqual(metadata.artifactVerification, verification);
	assert.doesNotMatch(text, /use details.nextActions|secret|unrelated replay/);
});

test("batch observations omit row data while retaining redacted recursive metadata and aggregate data", async () => {
	const rendered = await renderAgentBrowserObservation({
		content: [],
		json: true,
		succeeded: false,
		details: {
			data: { rows: [{ token: "aggregate-secret", value: 42 }], lifecycle: { internal: true } },
			batchSteps: [
				{
					index: 0,
					success: false,
					data: { token: "row-secret" },
					error: "password=error-secret",
					summary: "password=error-secret",
					failureCategory: "timeout",
					nextActions: actions,
					warnings: ["password=warning-secret"],
					refSnapshot: { private: "ownership state" },
				},
				{
					index: 1,
					inspection: true,
					stdout: "password=inspection-secret",
					summary: "Native help",
				},
				{
					index: 2,
					inspection: true,
					stdout: "password=ignored-stdout",
					data: "ignored inspection data",
					batchSteps: [{ index: 3, data: { token: "nested-secret" }, summary: "Nested output" }],
				},
			],
		},
	});
	const expected = {
		success: false,
		resultCategory: "failure",
		data: { rows: [{ token: "[REDACTED]", value: 42 }] },
		batchSteps: [
			{
				index: 0,
				success: false,
				resultCategory: "failure",
				error: "password=[REDACTED]",
				failureCategory: "timeout",
				nextActions: actions,
				warnings: ["password=[REDACTED]"],
			},
			{ index: 1, success: true, resultCategory: "success", summary: "Native help" },
			{
				index: 2,
				success: true,
				resultCategory: "success",
				batchSteps: [
					{ index: 3, success: true, resultCategory: "success", summary: "Nested output" },
				],
			},
		],
	};
	assert.deepEqual(rendered.structuredContent, expected);
	assert.equal(readString(readRecord(rendered.content[0]).text), JSON.stringify(expected, null, 2));
});

test("oversized JSON and prose spill complete redacted recovery and data to a real retrievable file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-observation-"));
	try {
		const nextActions = [
			{
				...actions[0],
				params: { ...actions[0].params, stdin: "'" + "exact payload ".repeat(3000) + "'" },
			},
		];
		for (const json of [true, false]) {
			const requestedActions = json ? nextActions : actions;
			// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
			// oxlint-disable-next-line no-await-in-loop
			const rendered = await renderAgentBrowserObservation({
				content: [{ type: "text", text: "Brief preview." }],
				details: {
					nextActions: requestedActions,
					failureCategory: "timeout",
					data: { requested: "z".repeat(40_000), password: "sensitive-value" },
					artifactVerification: verification,
				},
				json,
				succeeded: false,
				persistentArtifactStore: { sessionDir: dir, sessionId: "bounded" },
			});
			const text =
				rendered.content[0].type === "text" ? readString(readRecord(rendered.content[0]).text) : "";
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(text.length <= OBSERVATION_INLINE_MAX_CHARS);
			const payload = readRecord(JSON.parse(json ? text : text.slice(text.indexOf("{"))));
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(
				rendered.structuredContent,
				payload,
				"native callers receive the same bounded complete-spill envelope",
			);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(payload.success, false);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(payload.failureCategory, "timeout");
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(payload.artifactVerification, verification);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(
				payload.nextActions,
				json ? undefined : actions,
				"keep exact actions or omit oversized actions; never truncate them",
			);
			// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
			// oxlint-disable-next-line no-await-in-loop
			const fullText = await readFile(readString(payload.observationPath), "utf8");
			const full = readRecord(JSON.parse(readString(fullText)));
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(full.nextActions, requestedActions);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(readString(readRecord(full.data).requested).length, 40_000);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(readRecord(full.data).password, "[REDACTED]");
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.doesNotMatch(readString(fullText), /sensitive-value/);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				rendered.artifactManifest?.entries.find((entry) => entry.path === payload.observationPath)
					?.retentionState,
				"live",
			);
		}
		const file = join(dir, "not-a-directory");
		await writeFile(file, "occupied");
		const failed = await renderAgentBrowserObservation({
			content: [],
			details: { data: "x".repeat(50_000), nextActions: actions },
			json: true,
			succeeded: true,
			persistentArtifactStore: { sessionDir: file, sessionId: "failed" },
		});
		const failure = readRecord(
			JSON.parse(
				failed.content[0].type === "text" ? readString(readRecord(failed.content[0]).text) : "",
			),
		);
		assert.deepEqual(failed.structuredContent, failure);
		assert.ok(readString(failure.observationUnavailable).length > 0);
		assert.equal(failure.observationPath, undefined);
		assert.deepEqual(failure.nextActions, actions);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("code observations preserve full snapshot/batch data without model compaction or image encoding", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-code-observation-"));
	try {
		const path = join(dir, "screenshot.png");
		await writeFile(
			path,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const data = {
			snapshot: "- button 'A' [ref=e1]\n".repeat(3000),
			refs: { e1: { role: "button", name: "A" } },
		};
		const snapshot = await buildToolPresentation({
			modelVisible: false,
			commandInfo: { command: "snapshot" },
			cwd: dir,
			envelope: { success: true, data },
		});
		assert.deepEqual(snapshot.content, []);
		assert.deepEqual(snapshot.data, data);
		assert.equal(snapshot.fullOutputPath, undefined);
		const batch = await buildToolPresentation({
			modelVisible: false,
			commandInfo: { command: "batch" },
			cwd: dir,
			envelope: {
				success: true,
				data: [
					{ command: ["snapshot", "-i"], success: true, result: data },
					{ command: ["screenshot", path], success: true, result: { path } },
				],
			},
		});
		assert.deepEqual(batch.content, []);
		assert.equal(batch.fullOutputPath, undefined);
		assert.deepEqual(batch.batchSteps?.[0].data, data);
		assert.deepEqual(batch.imageObservations?.[0].pixels, { width: 1, height: 1 });
		assert.equal(batch.imageObservations[0].geometry.status, "unknown");
		assert.equal(batch.artifactVerification?.verified, true);
		for (const modelVisible of [false, true]) {
			// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
			// oxlint-disable-next-line no-await-in-loop
			const unchanged = await buildToolPresentation({
				modelVisible,
				commandInfo: { command: "screenshot" },
				cwd: dir,
				envelope: { success: true, data: { changed: false, path } },
			});
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(unchanged.imageObservations, undefined);
			// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				unchanged.content.some((part) => part.type === "image"),
				false,
			);
		}
		await utimes(path, new Date(1000), new Date(1000));
		const stale = await buildToolPresentation({
			commandInfo: { command: "screenshot" },
			cwd: dir,
			artifactMinUpdatedAtMs: Date.now(),
			envelope: { success: true, data: { path } },
		});
		assert.equal(stale.failureCategory, "artifact-missing");
		assert.equal(stale.imageObservations, undefined);
		assert.equal(
			stale.content.some((part) => part.type === "image"),
			false,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("code-mode snapshot filters retain full filtered data without an early spill", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-filter-observation-"));
	const data = {
		origin: "https://example.test/",
		snapshot: '- button "needle" [ref=e1]\n'.repeat(3000),
		refs: { e1: { role: "button", name: "needle" } },
	};
	await writeFakeAgentBrowserBinary(
		dir,
		`process.stdout.write(JSON.stringify({success:true,data:process.argv.includes('snapshot')?${JSON.stringify(data)}:{result:[]}}));`,
	);
	try {
		await withPatchedEnv({ PATH: `${dir}:${process.env.PATH ?? ""}` }, async () => {
			const page = SessionPageState.fromBranch([]);
			const result = await trySnapshotFilter({
				modelVisible: false,
				commandTokens: ["snapshot", "--search", "needle"],
				cwd: dir,
				effectiveArgs: [],
				redactedArgs: [],
				managedSessionRestoreDisabled: () => false,
				sessionMode: "auto",
				sessionName: "filter-code",
				usedImplicitSession: false,
				sessionPageState: page,
				sessionPageStateUpdate: page.beginUpdate(),
			});
			assert.ok(result);
			const details = readRecord(result.result.details);
			assert.deepEqual(result.result.content, []);
			assert.equal(details.fullOutputPath, undefined);
			assert.ok(readString(readRecord(details.data).snapshot).length > 60_000);
			assert.notEqual(
				readRecord(projectAgentBrowserObservation(details, true).snapshotFilter),
				undefined,
			);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("aborted dispatched mutations retire prior target/refs, while aborted reads preserve them", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-abort-observation-"));
	const marker = join(dir, "dispatched");
	await writeFakeAgentBrowserBinary(
		dir,
		`const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('click') || args.includes('fill') || args.includes('find') || args.includes('batch') || (args.includes('text') && args.includes('#abort'))) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'dispatched'); setInterval(() => {}, 1000);
} else if (args.includes('snapshot')) process.stdout.write(JSON.stringify({ success:true, data:{ origin:'https://example.test/', snapshot:'- button "Target" [ref=e1]', refs:{ e1:{ role:'button', name:'Target' } } } }));
else process.stdout.write(JSON.stringify({ success:true, data:{ url:'https://example.test/', title:'Fixture' } }));`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${dir}:${process.env.PATH ?? ""}`,
				PI_AGENT_BROWSER_TEST_PAGE_URL: "https://example.test/",
			},
			async () => {
				for (const args of [
					["click", "#target"],
					["fill", "#target", "new"],
					["find", "text", "Target", "click"],
					["find", "nth", "0", "#target"],
					["batch", "--bail"],
					["get", "text", "#abort"],
					["find", "text", "click", "text"],
				]) {
					// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
					// oxlint-disable-next-line no-await-in-loop
					await rm(marker, { force: true });
					const h = createExtensionHarness({ cwd: dir });
					// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
					// oxlint-disable-next-line no-await-in-loop
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
					// oxlint-disable-next-line no-await-in-loop
					await executeRegisteredTool(h.tool, h.ctx, { args: ["open", "https://example.test/"] });
					// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
					// oxlint-disable-next-line no-await-in-loop
					const snapshot = await executeRegisteredTool(h.tool, h.ctx, { args: ["snapshot", "-i"] });
					// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.notEqual(readRecord(readRecord(snapshot.details).refSnapshot), undefined);
					const controller = new AbortController();
					const pending = executeRegisteredTool(
						h.tool,
						h.ctx,
						{
							args,
							...(args[0] === "batch" ? { stdin: JSON.stringify([["click", "#target"]]) } : {}),
						},
						controller.signal,
					);
					try {
						let dispatched = false;
						for (let attempts = 0; attempts < 200; attempts++) {
							if (
								// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
								// oxlint-disable-next-line no-await-in-loop
								await readFile(marker, "utf8").then(
									() => true,
									() => false,
								)
							) {
								dispatched = true;
								break;
							}
							// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
							// oxlint-disable-next-line no-await-in-loop
							await delay(10);
						}
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(dispatched, true, `${args.join(" ")} must reach native dispatch`);
					} finally {
						controller.abort();
					}
					// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
					// oxlint-disable-next-line no-await-in-loop
					const result = await pending;
					// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, true);
					// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(result.details).failureCategory, "aborted");
					if (args[0] === "get" || args.at(-1) === "text") {
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details).sessionTabTargetUnknown, undefined);
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details).refSnapshot, undefined);
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(
							SessionPageState.fromBranch(h.ctx.sessionManager.getBranch()).get(
								readString(readRecord(result.details).sessionName),
							).refSnapshot,
							readRecord(snapshot.details).refSnapshot,
						);
					} else {
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details).sessionTabTargetUnknown, true, args.join(" "));
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details).refSnapshot, undefined);
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							readArray(readRecord(result.details).nextActions).some(
								(action) => readRecord(action).id === "verify-page-target-after-interruption",
							),
						);
						// Finish each observation/cancellation lifecycle before reusing its shared artifact store or dispatch marker.
						// oxlint-disable-next-line no-await-in-loop
						const rejected = await executeRegisteredTool(h.tool, h.ctx, { args: ["click", "@e1"] });
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(rejected.isError, true);
						// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							readString(readRecord(rejected.content[0]).text),
							/get url|unknown|verify/i,
						);
					}
				}
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

const sample: ScreenshotSample = {
	url: "https://example.test/",
	frame: "main",
	childFrameCount: 0,
	viewport: { width: 1200, height: 800 },
	document: { width: 1200, height: 1600 },
	scroll: { x: 0, y: 0 },
	dpr: 2,
	visualViewport: { x: 0, y: 0, scale: 1 },
	element: { x: 100, y: 160, width: 100, height: 60 },
};
test("geometry uses measured DPR and refuses scroll/frame/change or dimension guesses", () => {
	const viewport = buildScreenshotGeometry({
		capture: "viewport",
		pixels: { width: 2400, height: 1600 },
		before: sample,
		after: sample,
	});
	assert.deepEqual(viewport.pixelsPerCssPixel, { x: 2, y: 2 });
	assert.deepEqual(viewport.crop, { x: 0, y: 0, width: 1200, height: 800 });
	assert.equal(
		buildScreenshotGeometry({
			capture: "element",
			pixels: { width: 200, height: 120 },
			before: sample,
			after: sample,
		}).status,
		"measured",
	);
	assert.equal(
		buildScreenshotGeometry({
			capture: "full-page",
			pixels: { width: 2400, height: 3200 },
			before: sample,
			after: sample,
		}).status,
		"measured",
	);
	for (const changed of [
		{ ...sample, frame: "child" as const },
		{ ...sample, scroll: { x: 0, y: 100 } },
		{ ...sample, element: undefined },
	]) {
		// The fixed observation/mutation variants require their own payload/target assertions; every variant also has unconditional outcome checks.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			buildScreenshotGeometry({
				capture: "element",
				pixels: { width: 200, height: 120 },
				before: changed,
				after: changed,
			}).status,
			"unknown",
		);
	}
	assert.equal(
		buildScreenshotGeometry({
			capture: "viewport",
			pixels: { width: 2400, height: 1600 },
			before: sample,
			after: { ...sample, scroll: { x: 0, y: 10 } },
		}).status,
		"unknown",
	);
	assert.equal(
		buildScreenshotGeometry({
			capture: "viewport",
			pixels: { width: 1200, height: 800 },
			before: sample,
			after: sample,
		}).status,
		"unknown",
	);
});

test("compaction keeps an inline diagnostic when summary is deduped against a large error, and preserveContent keeps caller text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-observation-"));
	try {
		const largeError = "E".repeat(20_000);
		const details = { error: largeError, summary: largeError, failureCategory: "upstream-error" };
		const compacted = await renderAgentBrowserObservation({
			content: [{ type: "text", text: "Command failed." }],
			details,
			json: false,
			succeeded: false,
			persistentArtifactStore: { sessionDir: dir, sessionId: "dedupe" },
		});
		const compact = readRecord(compacted.structuredContent);
		assert.equal(compact.compacted, true);
		assert.equal(
			compact.error,
			undefined,
			"oversized error itself stays out of the compact object",
		);
		assert.equal(readString(compact.summary).length, 700);
		assert.ok(
			compact.summary === "E".repeat(699) + "…",
			"700-character error truncation survives the dedupe",
		);
		const full = readRecord(
			JSON.parse(await readFile(readString(compact.observationPath), "utf8")),
		);
		assert.equal(full.error, largeError);
		const preserved = await renderAgentBrowserObservation({
			content: [{ type: "text", text: "Formatted caller output." }],
			details,
			json: false,
			succeeded: false,
			preserveContent: true,
			persistentArtifactStore: { sessionDir: dir, sessionId: "preserve" },
		});
		const preservedText =
			preserved.content[0].type === "text" ? readString(readRecord(preserved.content[0]).text) : "";
		assert.equal(preservedText, "Formatted caller output.");
		assert.doesNotMatch(preservedText, /Browser observation compacted/);
		assert.equal(readRecord(preserved.structuredContent).compacted, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
