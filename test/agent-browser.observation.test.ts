import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { readDefined, readRecord, readArray, readString } from "./helpers/assertions.js";
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
import { warnRecordingPersistence } from "../extensions/agent-browser/lib/orchestration/extension-recording.js";
import { getMessageText } from "../extensions/agent-browser/lib/prompt-policy.js";
import {
	OBSERVATION_INLINE_MAX_CHARS,
	renderAgentBrowserObservation,
} from "../extensions/agent-browser/lib/results/presentation/large-output.js";

const actions: [AgentBrowserNextAction] = [
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

nodeTest("canonical JSON preserves array-valued page and code output", async () => {
	const data = ["a1", "a2", { count: 3 }];
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

nodeTest(
	"recording persistence warnings survive canonical JSON and structured rendering",
	async () => {
		const priorWarning = "Earlier refs were invalidated.";
		const input = {
			content: [
				{ type: "text", text: JSON.stringify({ success: true, warnings: [priorWarning] }) },
			],
			details: { warnings: [priorWarning] },
		} satisfies Parameters<typeof warnRecordingPersistence>[1];
		const warned = warnRecordingPersistence(true, input);
		const details = readRecord(warned.details);
		const warning = readString(details.recordingPersistenceWarning);
		assert.match(warning, /not yet durable/);
		const rendered = await renderAgentBrowserObservation({
			content: warned.content,
			details,
			json: true,
			succeeded: true,
		});
		const expected = [priorWarning, warning];
		assert.deepEqual(readRecord(rendered.structuredContent).warnings, expected);
		assert.deepEqual(readRecord(JSON.parse(getMessageText(rendered.content))).warnings, expected);
		assert.deepEqual(input.details.warnings, [priorWarning]);
		assert.equal(warnRecordingPersistence(false, input), input);
	},
);

nodeTest(
	"JSON observations retain exact recovery, failure category and artifact verification",
	() => {
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
		const first = readDefined(content[0]);
		const payload = readRecord(JSON.parse(first.type === "text" ? first.text : ""));
		assert.equal(payload.success, false);
		assert.equal(payload.failureCategory, "selector-not-found");
		assert.deepEqual(payload.nextActions, actions);
		assert.deepEqual(payload.artifactVerification, verification);
	},
);

nodeTest(
	"code observations retain identity, un-emitted failures, counters and opaque image handles",
	() => {
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
		assert.deepEqual(
			Object.fromEntries(Object.keys(fields).map((key) => [key, observation[key]])),
			fields,
		);
	},
);

nodeTest("exact string redaction cannot corrupt JSON booleans or structural tokens", () => {
	const content = buildRedactedPresentationContent({
		exactSensitiveValues: ["true"],
		plainTextInspection: false,
		succeeded: true,
		userRequestedJson: true,
		presentation: { content: [], summary: "done", data: { value: "true" } },
	});
	const first = readDefined(content[0]);
	const payload = readRecord(JSON.parse(first.type === "text" ? first.text : ""));
	assert.equal(payload.success, true);
	assert.deepEqual(payload.data, { value: "[REDACTED]" });
});

nodeTest("prose retains full action payloads and projection excludes ownership state", async () => {
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
	const first = readDefined(rendered.content[0]);
	const text = first.type === "text" ? first.text : "";
	const metadata = readRecord(JSON.parse(readDefined(text.split("Observation: ")[1])));
	assert.deepEqual(metadata.nextActions, actions);
	assert.deepEqual(metadata.artifactVerification, verification);
	assert.doesNotMatch(text, /use details.nextActions|secret|unrelated replay/);
});

nodeTest(
	"batch observations omit row data while retaining redacted recursive metadata and aggregate data",
	async () => {
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
		assert.equal(
			readString(readRecord(rendered.content[0]).text),
			JSON.stringify(expected, null, 2),
		);
	},
);

nodeTest(
	"oversized JSON and prose spill complete redacted recovery and data to a real retrievable file",
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "piab-observation-"));
		try {
			const nextActions = [
				{
					...actions[0],
					params: { ...actions[0].params, stdin: "'" + "exact payload ".repeat(3000) + "'" },
				},
			];
			for (const json of [true, false]) {
				await t.test(json ? "JSON" : "prose", async () => {
					const requestedActions = json ? nextActions : actions;
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
					const first = readDefined(rendered.content[0]);
					const text = first.type === "text" ? first.text : "";
					assert.ok(text.length <= OBSERVATION_INLINE_MAX_CHARS);
					const payload = readRecord(JSON.parse(json ? text : text.slice(text.indexOf("{"))));
					assert.deepEqual(
						rendered.structuredContent,
						payload,
						"native callers receive the same bounded complete-spill envelope",
					);
					assert.equal(payload.success, false);
					assert.equal(payload.failureCategory, "timeout");
					assert.deepEqual(payload.artifactVerification, verification);
					assert.deepEqual(
						payload.nextActions,
						json ? undefined : actions,
						"keep exact actions or omit oversized actions; never truncate them",
					);
					const fullText = await readFile(readString(payload.observationPath), "utf8");
					const full = readRecord(JSON.parse(readString(fullText)));
					assert.deepEqual(full.nextActions, requestedActions);
					assert.equal(readString(readRecord(full.data).requested).length, 40_000);
					assert.equal(readRecord(full.data).password, "[REDACTED]");
					assert.doesNotMatch(readString(fullText), /sensitive-value/);
					assert.equal(
						rendered.artifactManifest?.entries.find(
							(entry) => entry.path === payload.observationPath,
						)?.retentionState,
						"live",
					);
				});
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
			const first = readDefined(failed.content[0]);
			const failure = readRecord(JSON.parse(first.type === "text" ? first.text : ""));
			assert.deepEqual(failed.structuredContent, failure);
			assert.ok(readString(failure.observationUnavailable).length > 0);
			assert.equal(failure.observationPath, undefined);
			assert.deepEqual(failure.nextActions, actions);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"code observations preserve full snapshot/batch data without model compaction or image encoding",
	async (t) => {
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
			assert.deepEqual(batch.batchSteps?.[0]?.data, data);
			const image = readDefined(batch.imageObservations?.[0]);
			assert.deepEqual(image.pixels, { width: 1, height: 1 });
			assert.equal(image.geometry.status, "unknown");
			assert.equal(batch.artifactVerification?.verified, true);
			for (const modelVisible of [false, true]) {
				await t.test(modelVisible ? "model observation" : "code observation", async () => {
					const unchanged = await buildToolPresentation({
						modelVisible,
						commandInfo: { command: "screenshot" },
						cwd: dir,
						envelope: { success: true, data: { changed: false, path } },
					});
					assert.equal(unchanged.imageObservations, undefined);
					assert.equal(
						unchanged.content.some((part) => part.type === "image"),
						false,
					);
				});
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
	},
);

nodeTest(
	"code-mode snapshot filters retain full filtered data without an early spill",
	async () => {
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
				readRecord(projectAgentBrowserObservation(details, true).snapshotFilter);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"aborted dispatched mutations retire prior target/refs, while aborted reads preserve them",
	async (t) => {
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
						await t.test(args.join(" "), async (caseContext) => {
							await rm(marker, { force: true });
							const h = createExtensionHarness({ cwd: dir });
							await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
							await executeRegisteredTool(h.tool, h.ctx, {
								args: ["open", "https://example.test/"],
							});
							const snapshot = await executeRegisteredTool(h.tool, h.ctx, {
								args: ["snapshot", "-i"],
							});
							readRecord(readRecord(snapshot.details).refSnapshot);
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
							let result;
							try {
								let dispatched = false;
								for (let attempts = 0; attempts < 200; attempts++) {
									if (
										await readFile(marker, "utf8").then(
											() => true,
											() => false,
										)
									) {
										dispatched = true;
										break;
									}
									await delay(10);
								}
								assert.equal(dispatched, true, `${args.join(" ")} must reach native dispatch`);
							} finally {
								controller.abort();
								result = await pending;
							}
							assert.equal(result.isError, true);
							assert.equal(readRecord(result.details).failureCategory, "aborted");
							if (args[0] === "get" || args.at(-1) === "text") {
								await caseContext.test("preserves prior refs", () => {
									assert.equal(readRecord(result.details).sessionTabTargetUnknown, undefined);
									assert.equal(readRecord(result.details).refSnapshot, undefined);
									assert.deepEqual(
										SessionPageState.fromBranch(h.ctx.sessionManager.getBranch()).get(
											readString(readRecord(result.details).sessionName),
										).refSnapshot,
										readRecord(snapshot.details).refSnapshot,
									);
								});
							} else {
								await caseContext.test("retires prior refs", async () => {
									assert.equal(
										readRecord(result.details).sessionTabTargetUnknown,
										true,
										args.join(" "),
									);
									assert.equal(readRecord(result.details).refSnapshot, undefined);
									assert.ok(
										readArray(readRecord(result.details).nextActions).some(
											(action) => readRecord(action).id === "verify-page-target-after-interruption",
										),
									);
									const rejected = await executeRegisteredTool(h.tool, h.ctx, {
										args: ["click", "@e1"],
									});
									assert.equal(rejected.isError, true);
									assert.match(
										readString(readRecord(rejected.content[0]).text),
										/get url|unknown|verify/i,
									);
								});
							}
						});
					}
				},
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

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
nodeTest("geometry uses measured DPR and refuses scroll/frame/change or dimension guesses", () => {
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
	assert.deepEqual(
		[
			{ ...sample, frame: "child" as const },
			{ ...sample, scroll: { x: 0, y: 100 } },
			{ ...sample, element: undefined },
		].map(
			(changed) =>
				buildScreenshotGeometry({
					capture: "element",
					pixels: { width: 200, height: 120 },
					before: changed,
					after: changed,
				}).status,
		),
		["unknown", "unknown", "unknown"],
	);
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

nodeTest(
	"compaction keeps an inline diagnostic when summary is deduped against a large error, and preserveContent keeps caller text",
	async () => {
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
			const first = readDefined(preserved.content[0]);
			const preservedText = first.type === "text" ? first.text : "";
			assert.equal(preservedText, "Formatted caller output.");
			assert.doesNotMatch(preservedText, /Browser observation compacted/);
			assert.equal(readRecord(preserved.structuredContent).compacted, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
