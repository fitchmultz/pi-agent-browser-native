/**
 * Purpose: Verify artifact, manifest, image, and batch presentation for agent-browser results.
 * Responsibilities: Assert saved-file summaries, artifact verification/manifests, large generic compaction, inline image handling, and batch rendering.
 * Scope: Unit-style Node test-runner coverage for `buildToolPresentation`; extension lifecycle presentation integration lives in focused extension suites.
 * Usage: Run with `npx tsx --test test/agent-browser.presentation-artifacts-batch.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests isolate temp artifacts and preserve existing cleanup for secure temp roots.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { readDefined, readRecord, readString } from "./helpers/assertions.js";

import { parseUserBatchStdin } from "../extensions/agent-browser/lib/orchestration/batch-stdin.js";
import {
	appendBrowserTransition,
	applyArtifactChanges,
	artifactChanges,
	getBrowserRecord,
} from "../extensions/agent-browser/lib/browser-transcript.js";
import { mergeBrowserRunArtifactManifest } from "../extensions/agent-browser/lib/orchestration/browser-run/artifact-merge.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import type {
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
} from "../extensions/agent-browser/lib/results/contracts.js";
import {
	buildEvictedSessionArtifactEntries,
	getSessionArtifactManifestMaxEntries,
	mergeSessionArtifactManifest,
} from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import { withPatchedEnv } from "./helpers/agent-browser-harness.js";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);

nodeTest("batch stdin shape errors include a copyable native-tool example", () => {
	const error =
		parseUserBatchStdin(JSON.stringify([{ action: "get", target: "title" }])).error ?? "";
	assert.match(error, /must be an array of string command tokens/);
	assert.match(
		error,
		/\{ "args": \["batch"\], "stdin": "\[\[\\"get\\",\\"title\\"\],\[\\"get\\",\\"url\\"\]\]" \}/,
	);
});

nodeTest("buildToolPresentation formats download results as saved-file summaries", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-missing-download-"));
	t.after(() => rm(tempDir, { force: true, recursive: true }));
	const downloadPath = join(tempDir, "report.pdf");
	const presentation = await buildToolPresentation({
		commandInfo: { command: "download", subcommand: "@e5" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				path: downloadPath,
			},
		},
	});

	const textContent = readDefined(presentation.content[0]);
	const artifact = readDefined(presentation.artifacts?.[0]);
	assert.equal(textContent.type, "text");
	assert.ok(
		readString(readRecord(textContent).text).includes(
			`Download reported; file not verified: ${downloadPath}`,
		),
	);
	assert.doesNotMatch(readString(readRecord(textContent).text), /Media type:/);
	assert.match(readString(readRecord(textContent).text), /not found on disk/);
	assert.equal(
		presentation.summary,
		`Artifact verification failed: requested download was not found at ${downloadPath}.`,
	);
	assert.equal(presentation.resultCategory, "failure");
	assert.equal(presentation.failureCategory, "artifact-missing");
	assert.equal(presentation.artifacts?.[0]?.kind, "download");
	assert.equal(artifact.path, downloadPath);
	assert.equal(artifact.absolutePath, downloadPath);
	assert.equal(artifact.mediaType, undefined);
	assert.equal(artifact.exists, false);
	assert.equal(presentation.savedFilePath, downloadPath);
	assert.deepEqual(presentation.savedFile, {
		command: "download",
		kind: "download",
		path: downloadPath,
		subcommand: "@e5",
	});
});

nodeTest("buildToolPresentation adds dense-page guidance for annotated screenshots", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-annotated-guidance-"));
	try {
		const imagePath = join(tempDir, "annotated.png");
		await writeFile(imagePath, "fake image");
		const presentation = await buildToolPresentation({
			args: ["--json", "screenshot", "--annotate", imagePath],
			commandInfo: { command: "screenshot", subcommand: "--annotate" },
			cwd: tempDir,
			envelope: { success: true, data: { path: imagePath } },
		});

		const textContent = readDefined(presentation.content[0]);
		assert.match(
			readString(readRecord(textContent).text),
			/Annotated screenshot note: dense pages can produce overlapping labels/,
		);
		assert.match(readString(readRecord(textContent).text), /snapshot -i high-value refs/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

nodeTest(
	"buildToolPresentation does not treat data-url download payloads as verified files",
	async () => {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "download", subcommand: "@e5" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: {
					path: "data:text/plain,hello",
				},
			},
		});

		const textContent = readDefined(presentation.content[0]);
		assert.equal(presentation.artifacts, undefined);
		assert.equal(presentation.artifactVerification, undefined);
		assert.equal(presentation.savedFile, undefined);
		assert.equal(presentation.savedFilePath, undefined);
		assert.equal(presentation.resultCategory, "success");
		assert.doesNotMatch(
			readString(readRecord(textContent).text),
			/Download completed|Downloaded file|not found on disk/,
		);
	},
);

nodeTest(
	"buildToolPresentation renders metadata-first summaries for file artifact commands",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-missing-artifacts-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const cases = [
			{
				commandInfo: { command: "pdf" },
				data: { path: "page.pdf" },
				expectedKind: "pdf",
				expectedText: "Saved PDF: page.pdf",
			},
			{
				commandInfo: { command: "wait", subcommand: "--download" },
				data: { path: "download.txt" },
				expectedKind: "download",
				expectedText: "Download event reported; file not verified: download.txt",
			},
			{
				commandInfo: { command: "trace", subcommand: "stop" },
				data: { eventCount: 382, path: "trace.zip" },
				expectedKind: "trace",
				expectedText: "Saved trace: trace.zip",
			},
			{
				commandInfo: { command: "profiler", subcommand: "stop" },
				data: { eventCount: 350, path: "profile.cpuprofile" },
				expectedKind: "profile",
				expectedText: "Saved profile: profile.cpuprofile",
			},
			{
				commandInfo: { command: "record", subcommand: "stop" },
				data: { frames: 6, path: "recording.webm" },
				expectedKind: "video",
				expectedText: "Recording reported; file not verified: recording.webm",
			},
			{
				commandInfo: { command: "network", subcommand: "har" },
				data: { path: "network.har", requestCount: 0 },
				expectedKind: "har",
				expectedText: "Saved HAR: network.har",
			},
			{
				commandInfo: { command: "state", subcommand: "save" },
				data: { path: "auth-state.json" },
				expectedKind: "file",
				expectedText: "State file: auth-state.json",
			},
		] as const;

		for (const item of cases) {
			await t.test(item.expectedKind, async (caseContext) => {
				const presentation = await buildToolPresentation({
					commandInfo: item.commandInfo,
					cwd: tempDir,
					envelope: { success: true, data: item.data },
				});
				const textContent = readDefined(presentation.content[0]);
				const artifact = readDefined(presentation.artifacts?.[0]);
				const verifiedArtifact = readDefined(presentation.artifactVerification?.artifacts[0]);
				assert.equal(textContent.type, "text");
				assert.match(
					readString(readRecord(textContent).text),
					new RegExp(item.expectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				);
				assert.equal(
					presentation.summary,
					`Artifact verification failed: requested ${item.expectedKind} was not found at ${join(tempDir, item.data.path)}.`,
				);
				assert.equal(presentation.resultCategory, "failure");
				assert.equal(presentation.failureCategory, "artifact-missing");
				assert.equal(presentation.artifacts?.length, 1);
				assert.equal(artifact.kind, item.expectedKind);
				assert.equal(artifact.path, item.data.path);
				assert.equal(artifact.absolutePath, join(tempDir, item.data.path));
				assert.equal(artifact.mediaType, undefined);
				assert.equal(artifact.exists, false);
				assert.equal(presentation.artifactVerification?.missingCount, 1);
				assert.equal(presentation.artifactVerification.verified, false);
				assert.equal(verifiedArtifact.state, "missing");
				assert.equal(verifiedArtifact.absolutePath, join(tempDir, item.data.path));
				assert.equal(presentation.imagePath, undefined);
				assert.equal(presentation.imagePaths, undefined);
				if (item.commandInfo.command === "pdf") {
					await caseContext.test("saved PDF metadata", () => {
						assert.equal(presentation.savedFilePath, "page.pdf");
						assert.equal(presentation.savedFile?.kind, "pdf");
					});
				}
				if (item.commandInfo.command === "wait") {
					await caseContext.test("saved download metadata", () => {
						assert.equal(presentation.savedFilePath, "download.txt");
						assert.deepEqual(presentation.savedFile, {
							command: "wait",
							kind: "download",
							path: "download.txt",
							subcommand: "--download",
						});
					});
				}
			});
		}
	},
);

nodeTest(
	"buildToolPresentation does not classify state load paths as saved artifacts",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-state-load-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		await writeFile(join(tempDir, "auth-state.json"), "{}");

		const presentation = await buildToolPresentation({
			commandInfo: { command: "state", subcommand: "load" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "auth-state.json" } },
		});

		const textContent = readDefined(presentation.content[0]);
		assert.equal(presentation.artifacts, undefined);
		assert.equal(presentation.artifactManifest, undefined);
		assert.equal(presentation.artifactVerification, undefined);
		assert.equal(presentation.summary, "state completed");
		assert.match(readString(readRecord(textContent).text), /auth-state\.json/);
	},
);

nodeTest(
	"buildToolPresentation records path-bearing diff screenshots without inlining them as trusted screenshots",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-missing-diff-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const presentation = await buildToolPresentation({
			commandInfo: { command: "diff", subcommand: "screenshot" },
			cwd: tempDir,
			envelope: {
				success: true,
				data: { baselinePath: "baseline.png", diffPath: "diff.png", mismatchPixels: 12 },
			},
		});

		const textContent = readDefined(presentation.content[0]);
		const artifact = readDefined(presentation.artifacts?.[0]);
		const verifiedArtifact = readDefined(presentation.artifactVerification?.artifacts[0]);
		assert.equal(
			presentation.summary,
			`Artifact verification failed: requested image was not found at ${join(tempDir, "diff.png")}.`,
		);
		assert.equal(presentation.resultCategory, "failure");
		assert.equal(presentation.failureCategory, "artifact-missing");
		assert.equal(textContent.type, "text");
		const text = readString(readRecord(textContent).text);
		assert.match(text, /Diff image reported; file not verified: diff\.png/);
		assert.doesNotMatch(text, /Saved diff image/);
		assert.match(text, /Artifact type: image/);
		assert.doesNotMatch(text, /baseline\.png/);
		assert.equal(presentation.artifacts?.length, 1);
		assert.equal(artifact.kind, "image");
		assert.equal(artifact.path, "diff.png");
		assert.equal(artifact.absolutePath, join(tempDir, "diff.png"));
		assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "missing");
		assert.equal(verifiedArtifact.path, "diff.png");
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	},
);

nodeTest(
	"buildToolPresentation renders record start as a lifecycle state without missing-file copy",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-pending-record-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const presentation = await buildToolPresentation({
			commandInfo: { command: "record", subcommand: "start" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "recording.webm" } },
		});

		const textContent = readDefined(presentation.content[0]);
		const artifact = readDefined(presentation.artifacts?.[0]);
		const verifiedArtifact = readDefined(presentation.artifactVerification?.artifacts[0]);
		const manifestEntry = readDefined(presentation.artifactManifest?.entries[0]);
		assert.equal(
			presentation.summary,
			"Recording started; output will be written on stop: recording.webm",
		);
		assert.equal(textContent.type, "text");
		const text = readString(readRecord(textContent).text);
		assert.match(text, /Recording started; output will be written on stop: recording\.webm/);
		// Page-state guidance requires dispatch evidence; registered-tool tests cover it on success and failure.
		assert.doesNotMatch(text, /Page state:/);
		assert.doesNotMatch(text, /Saved recording/);
		assert.doesNotMatch(text, /not found on disk/);
		assert.doesNotMatch(text, /Session artifacts:/);
		assert.equal(presentation.artifacts?.length, 1);
		assert.equal(artifact.kind, "video");
		assert.equal(artifact.path, "recording.webm");
		assert.equal(artifact.absolutePath, join(tempDir, "recording.webm"));
		assert.equal(artifact.mediaType, undefined);
		assert.equal(artifact.exists, undefined);
		assert.equal(artifact.status, "pending");
		assert.equal(artifact.recordingState, "openRecording");
		assert.equal(artifact.willExistOnStop, true);
		assert.equal(presentation.artifactManifest?.entries[0]?.subcommand, "start");
		assert.equal(manifestEntry.path, "recording.webm");
		assert.match(presentation.artifactRetentionSummary ?? "", /Session artifacts:/);
		assert.equal(presentation.artifactVerification?.pendingCount, 1);
		assert.equal(presentation.artifactVerification.verified, false);
		assert.equal(verifiedArtifact.state, "pending");
		assert.equal(presentation.nextActions?.[0]?.id, "stop-pending-recording");
		assert.deepEqual(presentation.nextActions[0].params?.args, ["record", "stop"]);
	},
);

nodeTest("buildToolPresentation renders record restart as a pending lifecycle state", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-record-restart-"));
	t.after(() => rm(tempDir, { force: true, recursive: true }));

	const presentation = await buildToolPresentation({
		commandInfo: { command: "record", subcommand: "restart" },
		cwd: tempDir,
		envelope: { success: true, data: { path: "recording-restart.webm" } },
	});

	const textContent = readDefined(presentation.content[0]);
	const artifact = readDefined(presentation.artifacts?.[0]);
	const verifiedArtifact = readDefined(presentation.artifactVerification?.artifacts[0]);
	assert.equal(
		presentation.summary,
		"Recording restarted; output will be written on stop: recording-restart.webm",
	);
	const text = readString(readRecord(textContent).text);
	assert.match(
		text,
		/Recording restarted; output will be written on stop: recording-restart\.webm/,
	);
	assert.doesNotMatch(text, /fresh active page|prior in-page DOM/i);
	assert.doesNotMatch(text, /Saved recording/);
	assert.equal(presentation.artifacts?.[0]?.status, "pending");
	assert.equal(artifact.exists, undefined);
	assert.equal(artifact.recordingState, "openRecording");
	assert.equal(artifact.willExistOnStop, true);
	assert.equal(presentation.artifactVerification?.pendingCount, 1);
	assert.equal(verifiedArtifact.state, "pending");
});

nodeTest(
	"unacknowledged recording restarts retain the pending take without a terminal artifact",
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "piab-rejected-restart-"));
		try {
			const path = join(root, "active.webm");
			const started = await buildToolPresentation({
				commandInfo: { command: "record", subcommand: "start" },
				cwd: root,
				sessionName: "recording",
				envelope: { success: true, data: { path } },
			});
			await writeFile(path, "still active");
			for (const envelope of [
				{ success: false, error: "Unexpected argument", data: { type: "invalid_value" } },
				{ success: false, error: "Action denied by policy", data: null },
				{
					success: true,
					data: {
						confirmation_required: true,
						confirmation_id: "r123",
						action: "recording_restart",
					},
				},
			]) {
				await t.test(envelope.error ?? "pending confirmation", async () => {
					const result = await buildToolPresentation({
						artifactManifest: started.artifactManifest,
						commandInfo: { command: "record", subcommand: "restart" },
						cwd: root,
						sessionName: "recording",
						envelope,
						errorText: envelope.error,
					});
					assert.equal(
						result.artifacts?.some((artifact) => artifact.subcommand === "restart-previous") ??
							false,
						false,
					);
					assert.equal(
						(result.artifactManifest ?? started.artifactManifest)?.entries.some(
							(entry) => entry.path === path && entry.subcommand === "start",
						),
						true,
					);
					const activeContents = await readFile(path, "utf8");
					assert.equal(activeContents, "still active");
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"buildToolPresentation keeps a legacy restart file unverified without a terminal native receipt",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-restart-"));
		try {
			const firstPath = join(tempDir, "first.webm");
			const restartedPath = join(tempDir, "restarted.webm");
			const started = await buildToolPresentation({
				commandInfo: { command: "record", subcommand: "start" },
				cwd: tempDir,
				envelope: { success: true, data: { path: firstPath } },
			});
			await writeFile(firstPath, "previous recording");

			const restarted = await buildToolPresentation({
				artifactManifest: started.artifactManifest,
				commandInfo: { command: "record", subcommand: "restart" },
				cwd: tempDir,
				envelope: { success: true, data: { path: restartedPath, restarted: true } },
			});

			assert.match(restarted.summary, /Previous recording unverified: .*first\.webm/);
			assert.match(
				restarted.summary,
				/Recording restarted; output will be written on stop: .*restarted\.webm/,
			);
			const text = readString(readRecord(restarted.content[0]).text);
			assert.match(text, /Previous recording unverified: .*first\.webm/);
			assert.match(text, /Recording restarted; output will be written on stop: .*restarted\.webm/);
			assert.deepEqual(
				restarted.artifacts?.map((artifact) => ({
					exists: artifact.exists,
					path: artifact.path,
					status: artifact.status,
					subcommand: artifact.subcommand,
				})),
				[
					{ exists: true, path: firstPath, status: "unverified", subcommand: "restart-previous" },
					{ exists: undefined, path: restartedPath, status: "pending", subcommand: "restart" },
				],
			);
			assert.equal(restarted.artifactVerification?.verifiedCount, 0);
			assert.equal(restarted.artifactVerification.unverifiedCount, 1);
			assert.equal(restarted.artifactVerification.pendingCount, 1);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation rejects a stale previous recording reported by record restart",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-restart-stale-"));
		try {
			const firstPath = join(tempDir, "first.webm");
			const restartedPath = join(tempDir, "restarted.webm");
			const started = await buildToolPresentation({
				commandInfo: { command: "record", subcommand: "start" },
				cwd: tempDir,
				envelope: { success: true, data: { path: firstPath } },
			});
			await writeFile(firstPath, "stale previous recording");
			const oldSeconds = (Date.now() - 60_000) / 1_000;
			await utimes(firstPath, oldSeconds, oldSeconds);
			const runStartedAtMs = Date.now();

			const restarted = await buildToolPresentation({
				artifactManifest: started.artifactManifest,
				artifactMaxUpdatedAtMs: Date.now(),
				artifactMinUpdatedAtMs: runStartedAtMs,
				commandInfo: { command: "record", subcommand: "restart" },
				cwd: tempDir,
				envelope: { success: true, data: { path: restartedPath, restarted: true } },
			});

			assert.equal(restarted.resultCategory, "failure");
			assert.equal(restarted.failureCategory, "artifact-missing");
			assert.match(restarted.summary, /modification time outside the current command window/);
			assert.match(readString(readRecord(restarted.content[0]).text), /Previous recording stale/);
			assert.doesNotMatch(
				readString(readRecord(restarted.content[0]).text),
				/Previous recording saved/,
			);
			assert.equal(restarted.artifacts?.[0]?.status, "stale");
			assert.equal(restarted.artifactVerification?.artifacts[0]?.state, "unverified");
			assert.equal(restarted.artifactVerification.verifiedCount, 0);
			assert.equal(restarted.artifactVerification.pendingCount, 1);
			assert.equal(
				restarted.artifactManifest?.entries.some((entry) => entry.subcommand === "start"),
				false,
			);
			assert.equal(
				restarted.artifactManifest.entries.some(
					(entry) => entry.subcommand === "restart-previous" && entry.retentionState === "missing",
				),
				true,
			);
			assert.ok(
				restarted.nextActions?.some((action) => action.id === "verify-artifact-path") === true,
			);
			assert.equal(
				restarted.nextActions.some((action) => action.id === "stop-pending-recording"),
				true,
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation rejects a missing previous recording reported by record restart",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-restart-missing-"));
		try {
			const firstPath = join(tempDir, "first.webm");
			const restartedPath = join(tempDir, "restarted.webm");
			const started = await buildToolPresentation({
				commandInfo: { command: "record", subcommand: "start" },
				cwd: tempDir,
				envelope: { success: true, data: { path: firstPath } },
			});

			const restarted = await buildToolPresentation({
				artifactManifest: started.artifactManifest,
				artifactMaxUpdatedAtMs: Date.now(),
				artifactMinUpdatedAtMs: Date.now() - 1_000,
				commandInfo: { command: "record", subcommand: "restart" },
				cwd: tempDir,
				envelope: { success: true, data: { path: restartedPath, restarted: true } },
			});

			assert.equal(restarted.resultCategory, "failure");
			assert.equal(restarted.failureCategory, "artifact-missing");
			assert.match(restarted.summary, /was not found/);
			assert.match(readString(readRecord(restarted.content[0]).text), /Previous recording missing/);
			assert.doesNotMatch(
				readString(readRecord(restarted.content[0]).text),
				/Previous recording saved/,
			);
			assert.equal(restarted.artifacts?.[0]?.status, "missing");
			assert.equal(restarted.artifactVerification?.missingCount, 1);
			assert.equal(restarted.artifactVerification.pendingCount, 1);
			assert.equal(
				restarted.artifactManifest?.entries.some((entry) => entry.subcommand === "start"),
				false,
			);
			assert.ok(
				restarted.nextActions?.some((action) => action.id === "verify-artifact-path") === true,
			);
			assert.equal(
				restarted.nextActions.some((action) => action.id === "stop-pending-recording"),
				true,
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation rejects same-path record restart when the prior output is missing",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-restart-same-missing-"));
		try {
			const recordingPath = join(tempDir, "same.webm");
			const started = await buildToolPresentation({
				commandInfo: { command: "record", subcommand: "start" },
				cwd: tempDir,
				envelope: { success: true, data: { path: recordingPath } },
			});
			const restarted = await buildToolPresentation({
				artifactManifest: started.artifactManifest,
				artifactMaxUpdatedAtMs: Date.now(),
				artifactMinUpdatedAtMs: Date.now() - 1_000,
				commandInfo: { command: "record", subcommand: "restart" },
				cwd: tempDir,
				envelope: { success: true, data: { path: recordingPath, restarted: true } },
			});

			assert.equal(restarted.resultCategory, "failure");
			assert.equal(restarted.failureCategory, "artifact-missing");
			assert.deepEqual(
				restarted.artifacts?.map((artifact) => artifact.subcommand),
				["restart-previous", "restart"],
			);
			assert.equal(
				restarted.nextActions?.some((action) => action.id === "stop-pending-recording"),
				true,
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation coalesces a batched recording to its terminal saved state",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-batch-terminal-"));
		try {
			const recordingPath = join(tempDir, "recording.webm");
			const reportedStopPath = join(tempDir, "final-recording.webm");
			await writeFile(reportedStopPath, "completed recording");
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: tempDir,
				envelope: {
					success: true,
					data: [
						{
							command: ["record", "start", recordingPath],
							result: { path: recordingPath },
							success: true,
						},
						{
							command: ["record", "stop"],
							result: { frames: 3, path: reportedStopPath },
							success: true,
						},
					],
				},
			});

			const artifact = readDefined(presentation.artifacts?.[0]);
			const secondStep = readDefined(presentation.batchSteps?.[1]);
			assert.deepEqual(
				presentation.artifacts?.map((entry) => ({
					status: entry.status,
					subcommand: entry.subcommand,
				})),
				[{ status: "saved", subcommand: "stop" }],
			);
			assert.equal(artifact.absolutePath, reportedStopPath);
			assert.equal(presentation.artifactVerification?.pendingCount, 0);
			assert.equal(presentation.artifactVerification.verifiedCount, 1);
			assert.equal(presentation.successCategory, "artifact-saved");
			assert.equal(
				presentation.nextActions?.some((action) => action.id === "stop-pending-recording"),
				false,
			);
			assert.equal(presentation.batchSteps?.[0]?.artifacts?.[0]?.status, "pending");
			assert.equal(secondStep.artifacts?.[0]?.status, "saved");
			assert.equal(
				presentation.artifactManifest?.entries.some((entry) => entry.subcommand === "start"),
				false,
			);
			assert.equal(
				presentation.artifactManifest.entries.some(
					(entry) => entry.absolutePath === reportedStopPath && entry.subcommand === "stop",
				),
				true,
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation coalesces a recording saved after an intermediate close",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-batch-close-stop-"));
		try {
			const recordingPath = join(tempDir, "recording.webm");
			await writeFile(recordingPath, "completed recording");
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: tempDir,
				envelope: {
					success: true,
					data: [
						{
							command: ["record", "start", recordingPath],
							result: { path: recordingPath },
							success: true,
						},
						{ command: ["close"], result: {}, success: true },
						{
							command: ["record", "stop"],
							result: {
								lifecycle: { effectiveLaunch: { browserLaunched: true } },
								path: recordingPath,
							},
							success: true,
						},
					],
				},
				namespace: "tenant",
				sessionName: "recording-session",
			});

			assert.deepEqual(
				presentation.artifacts?.map((entry) => ({
					status: entry.status,
					subcommand: entry.subcommand,
				})),
				[{ status: "saved", subcommand: "stop" }],
			);
			assert.equal(presentation.artifactVerification?.missingCount, 0);
			assert.equal(presentation.artifactVerification.verifiedCount, 1);
			assert.equal(presentation.resultCategory, "success");
			assert.equal(presentation.successCategory, "artifact-saved");
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation marks a batched recording abandoned by close as missing",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-batch-close-"));
		try {
			const recordingPath = join(tempDir, "recording.webm");
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: tempDir,
				envelope: {
					success: true,
					data: [
						{
							command: ["record", "start", recordingPath],
							result: { path: recordingPath },
							success: true,
						},
						{ command: ["close"], result: {}, success: true },
					],
				},
				namespace: "tenant",
				sessionName: "recording-session",
			});

			assert.deepEqual(
				presentation.artifacts?.map((artifact) => ({
					recordingState: artifact.recordingState,
					status: artifact.status,
					subcommand: artifact.subcommand,
					willExistOnStop: artifact.willExistOnStop,
				})),
				[
					{
						recordingState: undefined,
						status: "missing",
						subcommand: "close-abandoned",
						willExistOnStop: undefined,
					},
				],
			);
			assert.equal(presentation.artifactVerification?.missingCount, 1);
			assert.equal(presentation.artifactVerification.pendingCount, 0);
			assert.equal(
				presentation.nextActions?.some((action) => action.id === "stop-pending-recording"),
				false,
			);
			assert.equal(presentation.resultCategory, "failure");
			assert.equal(presentation.failureCategory, "artifact-missing");
			assert.equal(presentation.batchSteps?.[0]?.artifacts?.[0]?.status, "pending");
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation keeps recording cleanup actionable after a later batch failure",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-batch-failure-"));
		try {
			const recordingPath = join(tempDir, "recording.webm");
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: tempDir,
				envelope: {
					success: true,
					data: [
						{
							command: ["record", "start", recordingPath],
							result: { path: recordingPath },
							success: true,
						},
						{
							command: ["find", "text", "Missing", "click"],
							error: "No element found: text=Missing",
							success: false,
						},
					],
				},
				namespace: "tenant",
				sessionName: "recording-session",
			});

			assert.equal(presentation.resultCategory, "failure");
			assert.equal(presentation.failureCategory, "selector-not-found");
			assert.equal(presentation.artifactVerification?.pendingCount, 1);
			assert.ok(
				presentation.nextActions?.some((action) => action.id === "refresh-interactive-refs") ===
					true,
			);
			assert.deepEqual(
				presentation.nextActions.find((action) => action.id === "stop-pending-recording")?.params
					?.args,
				["--namespace", "tenant", "--session", "recording-session", "record", "stop"],
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation records explicit saved files in the bounded session artifact manifest",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-manifest-"));
		const downloadPath = join(tempDir, "download.txt");
		await writeFile(downloadPath, "manifest download");
		try {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "download" },
				cwd: tempDir,
				envelope: { success: true, data: { path: "download.txt" } },
			});

			const textContent = readDefined(presentation.content[0]);
			const manifestEntry = readDefined(presentation.artifactManifest?.entries[0]);
			assert.equal(presentation.artifactManifest?.version, 1);
			assert.equal(presentation.artifactManifest.liveCount, 1);
			assert.equal(presentation.artifactManifest.evictedCount, 0);
			assert.equal(manifestEntry.path, "download.txt");
			assert.equal(manifestEntry.absolutePath, downloadPath);
			assert.equal(manifestEntry.kind, "download");
			assert.equal(manifestEntry.storageScope, "explicit-path");
			assert.equal(manifestEntry.retentionState, "live");
			assert.match(presentation.artifactRetentionSummary ?? "", /1 live, 0 evicted/);
			assert.doesNotMatch(
				readString(readRecord(textContent).text),
				/Session artifacts: 1 live, 0 evicted/,
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation scopes artifact verification to current-result artifacts and spills",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-verification-scope-"));
		const downloadPath = join(tempDir, "download.txt");
		await writeFile(downloadPath, "verified artifact");
		try {
			const artifactManifest: SessionArtifactManifest = {
				entries: [
					{
						createdAtMs: Date.now() - 1,
						kind: "spill",
						path: join(tempDir, "old-spill.txt"),
						retentionState: "evicted",
						storageScope: "persistent-session",
					},
				],
				evictedCount: 1,
				liveCount: 0,
				maxEntries: 100,
				updatedAtMs: Date.now(),
				version: 1,
			};
			const presentation = await buildToolPresentation({
				artifactManifest,
				commandInfo: { command: "download" },
				cwd: tempDir,
				envelope: { success: true, data: { path: "download.txt" } },
			});

			const verifiedArtifact = readDefined(presentation.artifactVerification?.artifacts[0]);
			assert.equal(presentation.artifactVerification?.verified, true);
			assert.equal(presentation.artifactVerification.verifiedCount, 1);
			assert.equal(presentation.artifactVerification.missingCount, 0);
			assert.equal(presentation.artifactVerification.artifacts.length, 1);
			assert.equal(verifiedArtifact.path, "download.txt");
			assert.equal(presentation.successCategory, "artifact-saved");
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"mergeBrowserRunArtifactManifest preserves restart lifecycle order across a concurrent manifest update",
	() => {
		const initial = mergeSessionArtifactManifest({
			entries: [
				{
					command: "screenshot",
					createdAtMs: 1,
					kind: "image",
					path: "initial.png",
					retentionState: "live",
					storageScope: "explicit-path",
				},
			],
			nowMs: 1,
		});
		assert.ok(initial);
		const updated = mergeSessionArtifactManifest({
			base: initial,
			entries: [
				{
					command: "record",
					createdAtMs: 2,
					kind: "video",
					path: "z-previous.webm",
					retentionState: "live",
					session: "shared",
					storageScope: "explicit-path",
					subcommand: "restart-previous",
				},
				{
					command: "record",
					createdAtMs: 2,
					kind: "video",
					path: "a-current.webm",
					retentionState: "live",
					session: "shared",
					storageScope: "explicit-path",
					subcommand: "restart",
				},
			],
			nowMs: 2,
		});
		const current = mergeSessionArtifactManifest({
			base: initial,
			entries: [
				{
					command: "screenshot",
					createdAtMs: 3,
					kind: "image",
					path: "concurrent.png",
					retentionState: "live",
					storageScope: "explicit-path",
				},
			],
			nowMs: 3,
		});
		const merged = mergeBrowserRunArtifactManifest(current, initial, updated);
		assert.equal(
			merged?.entries.some(
				(entry) => entry.path === "z-previous.webm" && entry.subcommand === "restart-previous",
			),
			true,
		);
		assert.equal(
			merged.entries.some(
				(entry) => entry.path === "a-current.webm" && entry.subcommand === "restart",
			),
			true,
		);
		assert.equal(
			merged.entries.some((entry) => entry.path === "concurrent.png"),
			true,
		);
	},
);

nodeTest(
	"mergeSessionArtifactManifest retains the active restart when the recent window is one",
	{ concurrency: false },
	async () => {
		await withPatchedEnv(
			{ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "1" },
			async () => {
				const manifest = mergeSessionArtifactManifest({
					entries: [
						{
							command: "record",
							createdAtMs: 1,
							kind: "video",
							path: "a-previous.webm",
							retentionState: "live",
							session: "shared",
							storageScope: "explicit-path",
							subcommand: "restart-previous",
						},
						{
							command: "record",
							createdAtMs: 1,
							kind: "video",
							path: "z-current.webm",
							retentionState: "live",
							session: "shared",
							storageScope: "explicit-path",
							subcommand: "restart",
						},
					],
					nowMs: 1,
				});
				assert.deepEqual(
					manifest?.entries.map((entry) => [entry.path, entry.subcommand]),
					[["z-current.webm", "restart"]],
				);
			},
		);
		await withPatchedEnv(
			{ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "20" },
			async () => {
				const older: SessionArtifactManifestEntry = {
					absolutePath: "/tmp/older.webm",
					command: "record",
					createdAtMs: 1,
					cwd: "/tmp",
					kind: "video",
					namespace: "scope",
					path: "older.webm",
					retentionState: "live",
					session: "shared",
					storageScope: "explicit-path",
					subcommand: "start",
				};
				const newer = {
					...older,
					absolutePath: "/tmp/newer.webm",
					createdAtMs: 2,
					path: "newer.webm",
				};
				const incremental = mergeSessionArtifactManifest({
					base: mergeSessionArtifactManifest({ entries: [older] }),
					entries: [newer],
				});
				assert.deepEqual(
					incremental?.entries.map((entry) => [entry.path, entry.subcommand]),
					[["newer.webm", "start"]],
				);
				const newestFirst = mergeSessionArtifactManifest({ entries: [newer, older] });
				assert.deepEqual(
					newestFirst?.entries.map((entry) => [entry.path, entry.subcommand]),
					[["newer.webm", "start"]],
				);
				const sameTimestamp = mergeSessionArtifactManifest({
					entries: [older, { ...newer, createdAtMs: older.createdAtMs }],
				});
				assert.deepEqual(
					sameTimestamp?.entries.map((entry) => [entry.path, entry.subcommand]),
					[["newer.webm", "start"]],
				);
				const stopped = mergeSessionArtifactManifest({
					entries: [older, { ...older, subcommand: "stop" }],
				});
				assert.deepEqual(
					stopped?.entries.map((entry) => [entry.path, entry.subcommand]),
					[["older.webm", "stop"]],
				);
				// A pending take under a redaction-colliding directory is superseded by an ordinary take;
				// its committed removal must retire the persisted receipt on replay as it does live.
				const started = mergeSessionArtifactManifest({
					entries: [
						{
							...older,
							absolutePath: "/tmp/Bearer directory-secret/older.webm",
							path: "Bearer directory-secret/older.webm",
						},
					],
				});
				const superseded = mergeSessionArtifactManifest({ base: started, entries: [newer] });
				const published: unknown[] = [];
				for (const [index, artifacts] of [
					artifactChanges(undefined, started),
					artifactChanges(started, superseded),
				].entries()) {
					appendBrowserTransition(
						{
							appendEntry: (customType: string, data: unknown) => {
								published.push({ type: "custom", customType, data });
							},
						},
						{
							event: {
								version: 1,
								phase: "state",
								operationId: `take-${index}`,
								toolCallId: "take",
								commandIndex: index,
								isError: false,
								state: {},
								artifacts,
							},
						},
					);
				}
				let replayed: SessionArtifactManifest | undefined;
				for (const entry of published) {
					replayed = applyArtifactChanges(replayed, getBrowserRecord(entry)?.event.artifacts);
				}
				assert.deepEqual(
					[superseded, replayed].map((manifest) =>
						manifest?.entries.map((entry) => [entry.path, entry.subcommand]),
					),
					[[["newer.webm", "start"]], [["newer.webm", "start"]]],
					"replay retires the superseded secret-path take like the live view",
				);
				assert.doesNotMatch(
					JSON.stringify(published.map((entry) => getBrowserRecord(entry)?.event.artifacts)),
					/directory-secret/,
				);
			},
		);
	},
);

nodeTest("artifact manifest recent window is configurable and ignores invalid values", () => {
	const values = [undefined, "3", "0", "-1", "3.5", "not-a-number"];
	assert.deepEqual(
		values.map((value) =>
			getSessionArtifactManifestMaxEntries({
				PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: value,
			}),
		),
		[100, 3, 100, 100, 100, 100],
	);
});

nodeTest(
	"artifact manifest evicts oldest metadata entries at the configured recent window",
	async () => {
		const entries: SessionArtifactManifestEntry[] = Array.from({ length: 5 }, (_, index) => ({
			createdAtMs: 1_000 + index,
			kind: "image",
			path: `screenshot-${index + 1}.png`,
			retentionState: "live",
			storageScope: "explicit-path",
		}));

		await withPatchedEnv(
			{ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" },
			async () => {
				const manifest = mergeSessionArtifactManifest({ entries, nowMs: 2_000 });
				assert.equal(manifest?.maxEntries, 3);
				assert.deepEqual(
					manifest.entries.map((entry) => entry.path),
					["screenshot-5.png", "screenshot-4.png", "screenshot-3.png"],
				);
				assert.equal(manifest.liveCount, 3);
				assert.equal(manifest.evictedCount, 0);
			},
		);
	},
);

nodeTest("committed replay derives the live recent artifact order and window", async () => {
	const settled = (path: string, createdAtMs: number): SessionArtifactManifestEntry => ({
		command: "screenshot",
		createdAtMs,
		kind: "image",
		path,
		retentionState: "live",
		storageScope: "explicit-path",
	});

	await withPatchedEnv(
		{ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "4" },
		async () => {
			const first = mergeSessionArtifactManifest({
				entries: [settled("z-settled.png", 2_000), settled("oldest.png", 1_000)],
				nowMs: 2_000,
			});
			// Eviction time outranks an older creation time, a pending recording leads equal-time rows,
			// path breaks the remaining tie, and only then does the window drop the oldest row.
			const second = mergeSessionArtifactManifest({
				base: first,
				entries: [
					settled("a-settled.png", 2_000),
					{
						command: "record",
						createdAtMs: 2_000,
						kind: "video",
						path: "y-pending.webm",
						recordingState: "openRecording",
						retentionState: "live",
						session: "shared",
						status: "pending",
						storageScope: "explicit-path",
						subcommand: "start",
					},
					...buildEvictedSessionArtifactEntries(
						[{ mtimeMs: 900, path: "evicted-spill.json", sizeBytes: 1 }],
						3_000,
					),
				],
				nowMs: 3_000,
			});
			const replayed = applyArtifactChanges(
				applyArtifactChanges(undefined, artifactChanges(undefined, first)),
				artifactChanges(first, second),
			);
			const expected = ["evicted-spill.json", "y-pending.webm", "a-settled.png", "z-settled.png"];
			assert.deepEqual(
				second?.entries.map((entry) => entry.path),
				expected,
			);
			assert.deepEqual(
				replayed?.entries.map((entry) => entry.path),
				expected,
			);
		},
	);
});

nodeTest(
	"buildToolPresentation reports the configured artifact manifest recent window",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-artifact-window-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));

		await withPatchedEnv(
			{ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" },
			async () => {
				const presentation = await buildToolPresentation({
					commandInfo: { command: "screenshot" },
					cwd: tempDir,
					envelope: { success: true, data: { path: "screenshot.png" } },
				});

				const textContent = readDefined(presentation.content[0]);
				assert.equal(presentation.artifactManifest?.maxEntries, 3);
				assert.match(presentation.artifactRetentionSummary ?? "", /\(1\/3 recent\)/);
				assert.doesNotMatch(
					readString(readRecord(textContent).text),
					/Session artifacts: .*\(1\/3 recent\)/,
				);
			},
		);
	},
);

nodeTest(
	"buildToolPresentation compacts oversized generic outputs and prints the actual spill path",
	async () => {
		const largeText = Array.from(
			{ length: 220 },
			(_, index) => `Large eval row ${index + 1}: ${"x".repeat(80)}`,
		).join("\n");
		const presentation = await buildToolPresentation({
			commandInfo: { command: "eval", subcommand: "--stdin" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: {
					origin: "https://example.com/large-eval",
					result: largeText,
				},
			},
		});

		const textContent = readDefined(presentation.content[0]);
		const verifiedArtifact = readDefined(presentation.artifactVerification?.artifacts[0]);
		assert.equal(textContent.type, "text");
		const text = readString(readRecord(textContent).text);
		assert.match(text, /Large eval output compacted/);
		assert.match(text, /Full output path: /);
		assert.equal(typeof presentation.fullOutputPath, "string");
		assert.equal(readRecord(presentation.data).compacted, true);
		assert.equal(presentation.successCategory, "artifact-unverified");
		assert.equal(presentation.artifactVerification?.unverifiedCount, 1);
		assert.equal(verifiedArtifact.kind, "spill");

		const spillPath = presentation.fullOutputPath;
		assert.ok(typeof spillPath === "string" && spillPath.length > 0);
		assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(await readFile(spillPath, "utf8"), /Large eval row 220/);
		await rm(spillPath, { force: true });
	},
);

nodeTest(
	"buildToolPresentation preserves partial batch results when a later step fails",
	async () => {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: process.cwd(),
			envelope: {
				success: false,
				data: [
					{
						command: ["open", "https://example.com"],
						success: true,
						result: { title: "Example Domain", url: "https://example.com/" },
					},
					{
						command: ["click", "@zzz"],
						success: false,
						error: "Unknown ref: zzz",
						result: { lifecycle: { effectiveLaunch: { browserLaunched: true } } },
					},
				],
			},
		});

		const textContent = readDefined(presentation.content[0]);
		assert.equal(textContent.type, "text");
		assert.match(readString(readRecord(textContent).text), /Batch failed: 1\/2 succeeded/);
		assert.match(readString(readRecord(textContent).text), /First failing step: 2 — click @zzz/);
		assert.match(
			readString(readRecord(textContent).text),
			/Step 1 — open https:\/\/example.com \(succeeded\)/,
		);
		assert.match(readString(readRecord(textContent).text), /Example Domain/);
		assert.match(readString(readRecord(textContent).text), /Step 2 — click @zzz \(failed\)/);
		assert.match(readString(readRecord(textContent).text), /Error: Unknown ref: zzz/);
		assert.match(readString(readRecord(textContent).text), /snapshot -i/);
		assert.match(readString(readRecord(textContent).text), /find role\|text\|label/);
		assert.match(readString(readRecord(textContent).text), /scrollintoview/);
		assert.equal(presentation.resultCategory, "failure");
		assert.equal(presentation.failureCategory, "stale-ref");
		assert.equal(presentation.batchFailure?.failedStep.index, 1);
		assert.equal(presentation.batchFailure.failedStep.commandText, "click @zzz");
		assert.equal(presentation.batchFailure.failedStep.resultCategory, "failure");
		assert.equal(presentation.batchFailure.failedStep.failureCategory, "stale-ref");
		assert.deepEqual(presentation.batchFailure.failedStep.lifecycle, {
			effectiveLaunch: { browserLaunched: true },
		});
		assert.deepEqual(presentation.batchFailure.failedStep.nextActions?.[0]?.params?.args, [
			"snapshot",
			"-i",
		]);
		assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
		assert.equal(presentation.batchFailure.failureCount, 1);
		assert.equal(presentation.batchFailure.successCount, 1);
		assert.equal(presentation.batchFailure.totalCount, 2);
		assert.match(presentation.summary, /Batch failed: 1\/2 succeeded/);
		assert.equal(presentation.pageChangeSummary?.changeType, "mutation");
		assert.equal(presentation.pageChangeSummary.command, "batch");
	},
);

nodeTest(
	"buildToolPresentation adds snapshot recovery for wait text assertion failures inside batch",
	async () => {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: process.cwd(),
			envelope: {
				data: [
					{
						command: ["open", "https://example.com"],
						result: { title: "Example Domain" },
						success: true,
					},
					{
						command: ["wait", "--text", "Expected Copy"],
						error: "Timed out waiting for text",
						success: false,
					},
				],
				success: false,
			},
			sessionName: "work",
		});

		assert.equal(presentation.resultCategory, "failure");
		assert.equal(presentation.batchFailure?.failedStep.commandText, "wait --text Expected Copy");
		assert.deepEqual(
			presentation.batchFailure.failedStep.nextActions?.map((action) => action.id),
			["inspect-after-text-assertion-failure"],
		);
		assert.deepEqual(presentation.nextActions?.[0], {
			id: "inspect-after-text-assertion-failure",
			params: { args: ["--session", "work", "snapshot", "-i"] },
			reason:
				"Inspect the current page after the text assertion failed before concluding the expected text is absent.",
			safety:
				"Read-only snapshot; use current refs or visible text from this page before retrying the assertion.",
			tool: "agent_browser",
		});
	},
);

nodeTest("buildToolPresentation keeps eval image-like string results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-image-"));
	const imagePath = join(tempDir, "secret.png");
	await writeFile(imagePath, png);

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "eval", subcommand: "--stdin" },
			cwd: tempDir,
			envelope: { success: true, data: "secret.png" },
		});

		const textContent = readDefined(presentation.content[0]);
		assert.equal(presentation.content.length, 1);
		assert.equal(textContent.type, "text");
		assert.equal(readString(readRecord(textContent).text), "secret.png");
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

nodeTest(
	"buildToolPresentation keeps non-artifact path-like scalar results text-only",
	async () => {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "eval", subcommand: "--stdin" },
			cwd: process.cwd(),
			envelope: { success: true, data: "/tmp/debug.har" },
		});

		const textContent = readDefined(presentation.content[0]);
		assert.equal(presentation.content.length, 1);
		assert.equal(textContent.type, "text");
		assert.equal(readString(readRecord(textContent).text), "/tmp/debug.har");
		assert.equal(presentation.artifacts, undefined);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	},
);

nodeTest("buildToolPresentation keeps get absolute image path results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-absolute-image-"));
	const imagePath = join(tempDir, "secret.jpg");
	await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "get", subcommand: "text" },
			cwd: process.cwd(),
			envelope: { success: true, data: imagePath },
		});

		const textContent = readDefined(presentation.content[0]);
		assert.equal(presentation.content.length, 1);
		assert.equal(textContent.type, "text");
		assert.equal(readString(readRecord(textContent).text), imagePath);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

nodeTest(
	"buildToolPresentation does not inline non-screenshot path records with image extensions",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-download-image-"));
		const imagePath = join(tempDir, "downloaded.png");
		await writeFile(imagePath, png);

		try {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "download", subcommand: "@e5" },
				cwd: tempDir,
				envelope: { success: true, data: { path: "downloaded.png" } },
			});

			const textContent = readDefined(presentation.content[0]);
			const artifact = readDefined(presentation.artifacts?.[0]);
			assert.equal(presentation.content.length, 1);
			assert.equal(textContent.type, "text");
			assert.match(
				readString(readRecord(textContent).text),
				/Downloaded file verified: downloaded\.png/,
			);
			assert.match(readString(readRecord(textContent).text), /image\/png/);
			assert.equal(presentation.summary, "Downloaded file verified: downloaded.png");
			assert.equal(presentation.artifacts?.[0]?.kind, "download");
			assert.equal(artifact.path, "downloaded.png");
			assert.equal(artifact.absolutePath, imagePath);
			assert.equal(artifact.mediaType, "image/png");
			assert.equal(artifact.exists, true);
			assert.equal(artifact.sizeBytes, png.length);
			assert.equal(presentation.imagePath, undefined);
			assert.equal(presentation.imagePaths, undefined);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation preserves wait --download saved-file metadata inside batch output",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-missing-batch-download-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const downloadPath = join(tempDir, "export.csv");
		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: [
					{ command: ["click", "#export"], result: { clicked: true }, success: true },
					{
						command: ["wait", "--download", downloadPath],
						result: { path: downloadPath, elapsedMs: 75 },
						success: true,
					},
				],
			},
		});

		const textContent = readDefined(presentation.content[0]);
		const secondStep = readDefined(presentation.batchSteps?.[1]);
		const text = readString(readRecord(textContent).text);
		assert.match(text, /Batch failed: 1\/2 succeeded/);
		assert.doesNotMatch(text, /Batch: 2\/2 succeeded/);
		assert.match(text, /Step 1 — click #export/);
		assert.ok(text.includes(`Step 2 — wait --download ${downloadPath}`));
		assert.ok(text.includes(`Download event reported; file not verified: ${downloadPath}`));
		assert.equal(presentation.batchSteps?.[1]?.artifacts?.[0]?.kind, "download");
		assert.equal(secondStep.savedFilePath, downloadPath);
		assert.deepEqual(secondStep.savedFile, {
			command: "wait",
			kind: "download",
			metadata: { elapsedMs: 75 },
			path: downloadPath,
			subcommand: "--download",
		});
		assert.equal(
			presentation.summary,
			`Artifact verification failed: requested download was not found at ${downloadPath}.`,
		);
		assert.equal(presentation.batchFailure?.successCount, 1);
		assert.equal(presentation.batchFailure.totalCount, 2);
		assert.equal(secondStep.artifactVerification?.missingCount, 1);
		assert.equal(presentation.artifactVerification?.missingCount, 1);
		assert.deepEqual(secondStep.nextActions?.[0]?.params?.args, [
			"wait",
			"--download",
			downloadPath,
		]);
		assert.equal(secondStep.pageChangeSummary?.changeType, "artifact");
		assert.equal(secondStep.pageChangeSummary.savedFilePath, downloadPath);
	},
);

nodeTest(
	"buildToolPresentation does not re-append old artifact retention noise for routine explicit batch files",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-explicit-noise-"));
		const downloadPath = join(tempDir, "export.csv");
		await writeFile(downloadPath, "a,b\n1,2\n");
		const baseManifest: SessionArtifactManifest = {
			entries: [
				{
					createdAtMs: 1_000,
					evictedAtMs: 2_000,
					kind: "spill",
					path: join(tempDir, "old-spill.json"),
					retentionState: "evicted",
					storageScope: "persistent-session",
				},
			],
			evictedCount: 1,
			liveCount: 0,
			maxEntries: 100,
			updatedAtMs: 2_000,
			version: 1,
		};
		try {
			const presentation = await buildToolPresentation({
				artifactManifest: baseManifest,
				commandInfo: { command: "batch" },
				cwd: tempDir,
				envelope: {
					success: true,
					data: [
						{
							command: ["download", "@e1", "export.csv"],
							result: { path: "export.csv" },
							success: true,
						},
					],
				},
			});
			const textContent = readDefined(presentation.content[0]);
			const text = readString(readRecord(textContent).text);
			assert.match(text, /Downloaded file verified: export\.csv/);
			assert.doesNotMatch(text, /Session artifacts:/);
			assert.match(presentation.artifactRetentionSummary ?? "", /1 live, 1 evicted/);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation reuses standalone inline screenshot rendering inside batch output",
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-image-"));
		const imagePath = join(tempDir, "batched.png");
		await writeFile(imagePath, png);

		try {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: tempDir,
				envelope: {
					success: true,
					data: [
						{
							command: ["open", "https://example.com"],
							result: { title: "Example Domain", url: "https://example.com/" },
							success: true,
						},
						{ command: ["screenshot"], result: { path: "batched.png" }, success: true },
					],
				},
			});

			const textContent = readDefined(presentation.content[0]);
			const imageContent = readDefined(presentation.content[1]);
			const artifact = readDefined(presentation.artifacts?.[0]);
			const firstStep = readDefined(presentation.batchSteps?.[0]);
			const secondStep = readDefined(presentation.batchSteps?.[1]);
			const text = readString(readRecord(textContent).text);
			assert.match(text, /Step 1 — open https:\/\/example.com/);
			assert.match(text, /Example Domain/);
			assert.match(text, /Step 2 — screenshot/);
			assert.equal(Array.isArray(presentation.data), true);
			assert.equal(presentation.batchSteps?.length, 2);
			assert.equal(firstStep.commandText, "open https://example.com");
			assert.match(presentation.summary, /Batch: 2\/2 succeeded/);
			assert.match(text, /Saved image: batched.png/);
			assert.match(text, /1 inline image attachment below/);
			assert.equal(imageContent.type, "image");
			assert.equal(presentation.imagePath, imagePath);
			assert.deepEqual(presentation.imagePaths, [imagePath]);
			assert.equal(presentation.artifacts?.[0]?.kind, "image");
			assert.equal(artifact.path, "batched.png");
			assert.equal(artifact.absolutePath, imagePath);
			assert.equal(artifact.mediaType, "image/png");
			assert.equal(artifact.exists, true);
			assert.equal(secondStep.imagePath, imagePath);
			assert.equal(secondStep.artifacts?.[0]?.kind, "image");
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"buildToolPresentation preserves non-screenshot file artifacts inside batch output",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-batch-artifacts-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));

		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: tempDir,
			envelope: {
				success: true,
				data: [
					{
						command: ["trace", "stop", "trace.zip"],
						result: { eventCount: 1, path: "trace.zip" },
						success: true,
					},
					{
						command: ["profiler", "stop", "profile.cpuprofile"],
						result: { eventCount: 2, path: "profile.cpuprofile" },
						success: true,
					},
					{
						command: ["record", "start", "recording.webm"],
						result: { path: "recording.webm" },
						success: true,
					},
					{
						command: ["record", "stop"],
						result: { frames: 3, path: "recording.webm" },
						success: true,
					},
					{
						command: ["network", "har", "stop", "network.har"],
						result: { path: "network.har", requestCount: 0 },
						success: true,
					},
				],
			},
		});

		const textContent = readDefined(presentation.content[0]);
		const text = readString(readRecord(textContent).text);
		assert.match(text, /Step 1 — trace stop trace\.zip/);
		assert.match(text, /Saved trace: trace\.zip/);
		assert.match(text, /Step 2 — profiler stop profile\.cpuprofile/);
		assert.match(text, /Saved profile: profile\.cpuprofile/);
		assert.match(text, /Step 3 — record start recording\.webm/);
		assert.match(text, /Recording started; output will be written on stop: recording\.webm/);
		assert.doesNotMatch(
			presentation.batchSteps?.[2]?.text ?? "",
			/Saved recording|not found on disk/,
		);
		assert.match(text, /Step 4 — record stop/);
		assert.match(text, /Recording reported; file not verified: recording\.webm/);
		assert.match(text, /Step 5 — network har stop network\.har/);
		assert.match(text, /Saved HAR: network\.har/);
		assert.deepEqual(
			presentation.artifacts?.map((artifact) => artifact.kind),
			["trace", "profile", "video", "har"],
		);
		assert.deepEqual(
			presentation.batchSteps?.map((step) => step.artifacts?.[0]?.kind),
			["trace", "profile", "video", "video", "har"],
		);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	},
);

nodeTest(
	"buildToolPresentation skips oversized inline image attachments",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-image-"));
		const imagePath = join(tempDir, "large.png");
		await writeFile(imagePath, Buffer.concat([png, Buffer.alloc(256 - png.length)]));

		try {
			await withPatchedEnv({ PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES: "128" }, async () => {
				const presentation = await buildToolPresentation({
					commandInfo: { command: "screenshot" },
					cwd: tempDir,
					envelope: { success: true, data: { path: "large.png" } },
				});

				const textContent = readDefined(presentation.content[0]);
				const artifact = readDefined(presentation.artifacts?.[0]);
				assert.equal(presentation.content.length, 1);
				assert.equal(textContent.type, "text");
				assert.match(readString(readRecord(textContent).text), /Saved image: large\.png/);
				assert.match(readString(readRecord(textContent).text), /Image attachment skipped:/);
				assert.equal(presentation.imagePath, imagePath);
				assert.equal(presentation.artifacts?.[0]?.kind, "image");
				assert.equal(artifact.path, "large.png");
				assert.equal(artifact.absolutePath, imagePath);
				assert.equal(artifact.sizeBytes, 256);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
