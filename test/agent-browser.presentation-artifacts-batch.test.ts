/**
 * Purpose: Verify artifact, manifest, image, and batch presentation for agent-browser results.
 * Responsibilities: Assert saved-file summaries, artifact verification/manifests, large generic compaction, inline image handling, and batch rendering.
 * Scope: Unit-style Node test-runner coverage for `buildToolPresentation`; extension lifecycle presentation integration lives in focused extension suites.
 * Usage: Run with `npx tsx --test test/agent-browser.presentation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests isolate temp artifacts and preserve existing cleanup for secure temp roots.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildToolPresentation
} from "../extensions/agent-browser/lib/results.js";
import type {
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
} from "../extensions/agent-browser/lib/results/contracts.js";
import {
	DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES,
	getSessionArtifactManifestMaxEntries,
	mergeSessionArtifactManifest,
} from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import {
	withPatchedEnv
} from "./helpers/agent-browser-harness.js";

test("buildToolPresentation formats download results as saved-file summaries", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "download", subcommand: "@e5" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				path: "/tmp/report.pdf",
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Download reported; file not verified: \/tmp\/report\.pdf/);
	assert.match((presentation.content[0] as { text: string }).text, /application\/pdf/);
	assert.match((presentation.content[0] as { text: string }).text, /not found on disk/);
	assert.equal(presentation.summary, "Artifact verification failed: requested download was not found at /tmp/report.pdf.");
	assert.equal(presentation.resultCategory, "failure");
	assert.equal(presentation.failureCategory, "artifact-missing");
	assert.equal(presentation.artifacts?.[0]?.kind, "download");
	assert.equal(presentation.artifacts?.[0]?.path, "/tmp/report.pdf");
	assert.equal(presentation.artifacts?.[0]?.absolutePath, "/tmp/report.pdf");
	assert.equal(presentation.artifacts?.[0]?.mediaType, "application/pdf");
	assert.equal(presentation.artifacts?.[0]?.exists, false);
	assert.equal(presentation.savedFilePath, "/tmp/report.pdf");
	assert.deepEqual(presentation.savedFile, {
		command: "download",
		kind: "download",
		path: "/tmp/report.pdf",
		subcommand: "@e5",
	});
});

test("buildToolPresentation adds dense-page guidance for annotated screenshots", async () => {
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

		assert.match((presentation.content[0] as { text: string }).text, /Annotated screenshot note: dense pages can produce overlapping labels/);
		assert.match((presentation.content[0] as { text: string }).text, /snapshot -i high-value refs/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation does not treat data-url download payloads as verified files", async () => {
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

	assert.equal(presentation.artifacts, undefined);
	assert.equal(presentation.artifactVerification, undefined);
	assert.equal(presentation.savedFile, undefined);
	assert.equal(presentation.savedFilePath, undefined);
	assert.equal(presentation.resultCategory, "success");
	assert.doesNotMatch((presentation.content[0] as { text: string }).text, /Download completed|Downloaded file|not found on disk/);
});

test("buildToolPresentation renders metadata-first summaries for file artifact commands", async () => {
	const cases = [
		{
			commandInfo: { command: "pdf" },
			data: { path: "page.pdf" },
			expectedKind: "pdf",
			expectedMediaType: "application/pdf",
			expectedText: "Saved PDF: page.pdf",
		},
		{
			commandInfo: { command: "wait", subcommand: "--download" },
			data: { path: "download.txt" },
			expectedKind: "download",
			expectedMediaType: "text/plain",
			expectedText: "Download event reported; file not verified: download.txt",
		},
		{
			commandInfo: { command: "trace", subcommand: "stop" },
			data: { eventCount: 382, path: "trace.zip" },
			expectedKind: "trace",
			expectedMediaType: "application/zip",
			expectedText: "Saved trace: trace.zip",
		},
		{
			commandInfo: { command: "profiler", subcommand: "stop" },
			data: { eventCount: 350, path: "profile.cpuprofile" },
			expectedKind: "profile",
			expectedMediaType: "application/json",
			expectedText: "Saved profile: profile.cpuprofile",
		},
		{
			commandInfo: { command: "record", subcommand: "stop" },
			data: { frames: 6, path: "recording.webm" },
			expectedKind: "video",
			expectedMediaType: "video/webm",
			expectedText: "Saved recording: recording.webm",
		},
		{
			commandInfo: { command: "network", subcommand: "har" },
			data: { path: "network.har", requestCount: 0 },
			expectedKind: "har",
			expectedMediaType: "application/json",
			expectedText: "Saved HAR: network.har",
		},
		{
			commandInfo: { command: "state", subcommand: "save" },
			data: { path: "auth-state.json" },
			expectedKind: "file",
			expectedMediaType: "application/json",
			expectedText: "State file: auth-state.json",
		},
	] as const;

	for (const item of cases) {
		const presentation = await buildToolPresentation({
			commandInfo: item.commandInfo,
			cwd: "/tmp/pi-agent-browser-artifact-tests",
			envelope: { success: true, data: item.data },
		});

		assert.equal(presentation.content[0]?.type, "text");
		assert.match((presentation.content[0] as { text: string }).text, new RegExp(item.expectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(presentation.summary, `Artifact verification failed: requested ${item.expectedKind} was not found at ${join("/tmp/pi-agent-browser-artifact-tests", item.data.path)}.`);
		assert.equal(presentation.resultCategory, "failure");
		assert.equal(presentation.failureCategory, "artifact-missing");
		assert.equal(presentation.artifacts?.length, 1);
		assert.equal(presentation.artifacts?.[0]?.kind, item.expectedKind);
		assert.equal(presentation.artifacts?.[0]?.path, item.data.path);
		assert.equal(presentation.artifacts?.[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", item.data.path));
		assert.equal(presentation.artifacts?.[0]?.mediaType, item.expectedMediaType);
		assert.equal(presentation.artifacts?.[0]?.exists, false);
		assert.equal(presentation.artifactVerification?.missingCount, 1);
		assert.equal(presentation.artifactVerification?.verified, false);
		assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "missing");
		assert.equal(presentation.artifactVerification?.artifacts[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", item.data.path));
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
		if (item.commandInfo.command === "pdf") {
			assert.equal(presentation.savedFilePath, "page.pdf");
			assert.equal(presentation.savedFile?.kind, "pdf");
		}
		if (item.commandInfo.command === "wait") {
			assert.equal(presentation.savedFilePath, "download.txt");
			assert.deepEqual(presentation.savedFile, {
				command: "wait",
				kind: "download",
				path: "download.txt",
				subcommand: "--download",
			});
		}
	}
});

test("buildToolPresentation does not classify state load paths as saved artifacts", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "state", subcommand: "load" },
		cwd: "/tmp/pi-agent-browser-artifact-tests",
		envelope: { success: true, data: { path: "auth-state.json" } },
	});

	assert.equal(presentation.artifacts, undefined);
	assert.equal(presentation.artifactManifest, undefined);
	assert.equal(presentation.artifactVerification, undefined);
	assert.equal(presentation.summary, "state completed");
	assert.match((presentation.content[0] as { text: string }).text, /auth-state\.json/);
});

test("buildToolPresentation records path-bearing diff screenshots without inlining them as trusted screenshots", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "diff", subcommand: "screenshot" },
		cwd: "/tmp/pi-agent-browser-artifact-tests",
		envelope: { success: true, data: { baselinePath: "baseline.png", diffPath: "diff.png", mismatchPixels: 12 } },
	});

	assert.equal(presentation.summary, "Artifact verification failed: requested image was not found at /tmp/pi-agent-browser-artifact-tests/diff.png.");
	assert.equal(presentation.resultCategory, "failure");
	assert.equal(presentation.failureCategory, "artifact-missing");
	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Diff image reported; file not verified: diff\.png/);
	assert.doesNotMatch(text, /Saved diff image/);
	assert.match(text, /Artifact type: image/);
	assert.doesNotMatch(text, /baseline\.png/);
	assert.equal(presentation.artifacts?.length, 1);
	assert.equal(presentation.artifacts?.[0]?.kind, "image");
	assert.equal(presentation.artifacts?.[0]?.path, "diff.png");
	assert.equal(presentation.artifacts?.[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", "diff.png"));
	assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "missing");
	assert.equal(presentation.artifactVerification?.artifacts[0]?.path, "diff.png");
	assert.equal(presentation.imagePath, undefined);
	assert.equal(presentation.imagePaths, undefined);
});

test("buildToolPresentation renders record start as a lifecycle state without missing-file copy", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "record", subcommand: "start" },
		cwd: "/tmp/pi-agent-browser-artifact-tests",
		envelope: { success: true, data: { path: "recording.webm" } },
	});

	assert.equal(presentation.summary, "Recording started; output will be written on stop: recording.webm");
	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Recording started; output will be written on stop: recording\.webm/);
	assert.doesNotMatch(text, /Saved recording/);
	assert.doesNotMatch(text, /not found on disk/);
	assert.doesNotMatch(text, /Session artifacts:/);
	assert.equal(presentation.artifacts?.length, 1);
	assert.equal(presentation.artifacts?.[0]?.kind, "video");
	assert.equal(presentation.artifacts?.[0]?.path, "recording.webm");
	assert.equal(presentation.artifacts?.[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", "recording.webm"));
	assert.equal(presentation.artifacts?.[0]?.mediaType, "video/webm");
	assert.equal(presentation.artifacts?.[0]?.exists, false);
	assert.equal(presentation.artifactManifest, undefined);
	assert.equal(presentation.artifactRetentionSummary, undefined);
	assert.equal(presentation.artifactVerification?.pendingCount, 1);
	assert.equal(presentation.artifactVerification?.verified, false);
	assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "pending");
	assert.equal(presentation.nextActions, undefined);
});

test("buildToolPresentation records explicit saved files in the bounded session artifact manifest", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-manifest-"));
	const downloadPath = join(tempDir, "download.txt");
	await writeFile(downloadPath, "manifest download");
	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "download" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "download.txt" } },
		});

		assert.equal(presentation.artifactManifest?.version, 1);
		assert.equal(presentation.artifactManifest?.liveCount, 1);
		assert.equal(presentation.artifactManifest?.evictedCount, 0);
		assert.equal(presentation.artifactManifest?.entries[0]?.path, "download.txt");
		assert.equal(presentation.artifactManifest?.entries[0]?.absolutePath, downloadPath);
		assert.equal(presentation.artifactManifest?.entries[0]?.kind, "download");
		assert.equal(presentation.artifactManifest?.entries[0]?.storageScope, "explicit-path");
		assert.equal(presentation.artifactManifest?.entries[0]?.retentionState, "live");
		assert.match(presentation.artifactRetentionSummary ?? "", /1 live, 0 evicted/);
		assert.doesNotMatch((presentation.content[0] as { text: string }).text, /Session artifacts: 1 live, 0 evicted/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation scopes artifact verification to current-result artifacts and spills", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-verification-scope-"));
	const downloadPath = join(tempDir, "download.txt");
	await writeFile(downloadPath, "verified artifact");
	try {
		const artifactManifest: SessionArtifactManifest = {
			entries: [{ createdAtMs: Date.now() - 1, kind: "spill", path: "/tmp/old-spill.txt", retentionState: "evicted", storageScope: "persistent-session" }],
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

		assert.equal(presentation.artifactVerification?.verified, true);
		assert.equal(presentation.artifactVerification?.verifiedCount, 1);
		assert.equal(presentation.artifactVerification?.missingCount, 0);
		assert.equal(presentation.artifactVerification?.artifacts.length, 1);
		assert.equal(presentation.artifactVerification?.artifacts[0]?.path, "download.txt");
		assert.equal(presentation.successCategory, "artifact-saved");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("artifact manifest defaults to a QA-friendly recent window", () => {
	assert.equal(getSessionArtifactManifestMaxEntries({}), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	assert.equal(DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES, 100);
});

test("artifact manifest recent window is configurable and ignores invalid values", async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), 3);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "0" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "-1" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3.5" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "not-a-number" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
});

test("artifact manifest evicts oldest metadata entries at the configured recent window", async () => {
	const entries: SessionArtifactManifestEntry[] = Array.from({ length: 5 }, (_, index) => ({
		createdAtMs: 1_000 + index,
		kind: "image",
		path: `screenshot-${index + 1}.png`,
		retentionState: "live",
		storageScope: "explicit-path",
	}));

	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" }, async () => {
		const manifest = mergeSessionArtifactManifest({ entries, nowMs: 2_000 });
		assert.equal(manifest?.maxEntries, 3);
		assert.deepEqual(
			manifest?.entries.map((entry) => entry.path),
			["screenshot-5.png", "screenshot-4.png", "screenshot-3.png"],
		);
		assert.equal(manifest?.liveCount, 3);
		assert.equal(manifest?.evictedCount, 0);
	});
});

test("buildToolPresentation reports the configured artifact manifest recent window", async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" }, async () => {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "screenshot" },
			cwd: process.cwd(),
			envelope: { success: true, data: { path: "dogfood-shot.png" } },
		});

		assert.equal(presentation.artifactManifest?.maxEntries, 3);
		assert.match(presentation.artifactRetentionSummary ?? "", /\(1\/3 recent\)/);
		assert.doesNotMatch((presentation.content[0] as { text: string }).text, /Session artifacts: .*\(1\/3 recent\)/);
	});
});

test("buildToolPresentation compacts oversized generic outputs and prints the actual spill path", async () => {
	const largeText = Array.from({ length: 220 }, (_, index) => `Large eval row ${index + 1}: ${"x".repeat(80)}`).join("\n");
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

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Large eval output compacted/);
	assert.match(text, /Full output path: /);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);
	assert.equal(presentation.successCategory, "artifact-unverified");
	assert.equal(presentation.artifactVerification?.unverifiedCount, 1);
	assert.equal(presentation.artifactVerification?.artifacts[0]?.kind, "spill");

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(await readFile(String(spillPath), "utf8"), /Large eval row 220/);
	await rm(String(spillPath), { force: true });
});

test("buildToolPresentation formats batch output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
				{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Step 1 — open https:\/\/developer.mozilla.org/);
	assert.match((presentation.content[0] as { text: string }).text, /MDN Web Docs/);
	assert.equal(Array.isArray(presentation.data), true);
	assert.equal(presentation.batchSteps?.length, 2);
	assert.equal(presentation.batchSteps?.[0]?.commandText, "open https://developer.mozilla.org");
	assert.match(presentation.summary, /Batch: 2\/2 succeeded/);
});

test("buildToolPresentation preserves partial batch results when a later step fails", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: [
				{ command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
				{ command: ["click", "@zzz"], success: false, error: "Unknown ref: zzz" },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Batch failed: 1\/2 succeeded/);
	assert.match((presentation.content[0] as { text: string }).text, /First failing step: 2 — click @zzz/);
	assert.match((presentation.content[0] as { text: string }).text, /Step 1 — open https:\/\/example.com \(succeeded\)/);
	assert.match((presentation.content[0] as { text: string }).text, /Example Domain/);
	assert.match((presentation.content[0] as { text: string }).text, /Step 2 — click @zzz \(failed\)/);
	assert.match((presentation.content[0] as { text: string }).text, /Error: Unknown ref: zzz/);
	assert.match((presentation.content[0] as { text: string }).text, /snapshot -i/);
	assert.match((presentation.content[0] as { text: string }).text, /find role\|text\|label/);
	assert.match((presentation.content[0] as { text: string }).text, /scrollintoview/);
	assert.equal(presentation.resultCategory, "failure");
	assert.equal(presentation.failureCategory, "stale-ref");
	assert.equal(presentation.batchFailure?.failedStep.index, 1);
	assert.equal(presentation.batchFailure?.failedStep.commandText, "click @zzz");
	assert.equal(presentation.batchFailure?.failedStep.resultCategory, "failure");
	assert.equal(presentation.batchFailure?.failedStep.failureCategory, "stale-ref");
	assert.deepEqual(presentation.batchFailure?.failedStep.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.equal(presentation.batchFailure?.failureCount, 1);
	assert.equal(presentation.batchFailure?.successCount, 1);
	assert.equal(presentation.batchFailure?.totalCount, 2);
	assert.match(presentation.summary, /Batch failed: 1\/2 succeeded/);
	assert.equal(presentation.pageChangeSummary?.changeType, "mutation");
	assert.equal(presentation.pageChangeSummary?.command, "batch");
});

test("buildToolPresentation adds snapshot recovery for wait text assertion failures inside batch", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			data: [
				{ command: ["open", "https://example.com"], result: { title: "Example Domain" }, success: true },
				{ command: ["wait", "--text", "Expected Copy"], error: "Timed out waiting for text", success: false },
			],
			success: false,
		},
		sessionName: "work",
	});

	assert.equal(presentation.resultCategory, "failure");
	assert.equal(presentation.batchFailure?.failedStep.commandText, "wait --text Expected Copy");
	assert.deepEqual(presentation.batchFailure?.failedStep.nextActions?.map((action) => action.id), ["inspect-after-text-assertion-failure"]);
	assert.deepEqual(presentation.nextActions?.[0], {
		id: "inspect-after-text-assertion-failure",
		params: { args: ["--session", "work", "snapshot", "-i"] },
		reason: "Inspect the current page after the text assertion failed before concluding the expected text is absent.",
		safety: "Read-only snapshot; use current refs or visible text from this page before retrying the assertion.",
		tool: "agent_browser",
	});
});


test("buildToolPresentation keeps eval image-like string results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-image-"));
	const imagePath = join(tempDir, "secret.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "eval", subcommand: "--stdin" },
			cwd: tempDir,
			envelope: { success: true, data: "secret.png" },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, "secret.png");
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation keeps non-artifact path-like scalar results text-only", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: { success: true, data: "/tmp/debug.har" },
	});

	assert.equal(presentation.content.length, 1);
	assert.equal(presentation.content[0]?.type, "text");
	assert.equal((presentation.content[0] as { text: string }).text, "/tmp/debug.har");
	assert.equal(presentation.artifacts, undefined);
	assert.equal(presentation.imagePath, undefined);
	assert.equal(presentation.imagePaths, undefined);
});

test("buildToolPresentation keeps get absolute image path results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-absolute-image-"));
	const imagePath = join(tempDir, "secret.jpg");
	await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "get", subcommand: "text" },
			cwd: process.cwd(),
			envelope: { success: true, data: imagePath },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, imagePath);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation does not inline non-screenshot path records with image extensions", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-download-image-"));
	const imagePath = join(tempDir, "downloaded.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "download", subcommand: "@e5" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "downloaded.png" } },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.match((presentation.content[0] as { text: string }).text, /Downloaded file verified: downloaded\.png/);
		assert.match((presentation.content[0] as { text: string }).text, /image\/png/);
		assert.equal(presentation.summary, "Downloaded file verified: downloaded.png");
		assert.equal(presentation.artifacts?.[0]?.kind, "download");
		assert.equal(presentation.artifacts?.[0]?.path, "downloaded.png");
		assert.equal(presentation.artifacts?.[0]?.absolutePath, imagePath);
		assert.equal(presentation.artifacts?.[0]?.mediaType, "image/png");
		assert.equal(presentation.artifacts?.[0]?.exists, true);
		assert.equal(presentation.artifacts?.[0]?.sizeBytes, 4);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation preserves wait --download saved-file metadata inside batch output", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{ command: ["click", "#export"], result: { clicked: true }, success: true },
				{ command: ["wait", "--download", "/tmp/export.csv"], result: { path: "/tmp/export.csv", elapsedMs: 75 }, success: true },
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Batch failed: 1\/2 succeeded/);
	assert.doesNotMatch(text, /Batch: 2\/2 succeeded/);
	assert.match(text, /Step 1 — click #export/);
	assert.match(text, /Step 2 — wait --download \/tmp\/export\.csv/);
	assert.match(text, /Download event reported; file not verified: \/tmp\/export\.csv/);
	assert.equal(presentation.batchSteps?.[1]?.artifacts?.[0]?.kind, "download");
	assert.equal(presentation.batchSteps?.[1]?.savedFilePath, "/tmp/export.csv");
	assert.deepEqual(presentation.batchSteps?.[1]?.savedFile, {
		command: "wait",
		kind: "download",
		metadata: { elapsedMs: 75 },
		path: "/tmp/export.csv",
		subcommand: "--download",
	});
	assert.equal(presentation.summary, "Artifact verification failed: requested download was not found at /tmp/export.csv.");
	assert.equal(presentation.batchFailure?.successCount, 1);
	assert.equal(presentation.batchFailure?.totalCount, 2);
	assert.equal(presentation.batchSteps?.[1]?.artifactVerification?.missingCount, 1);
	assert.equal(presentation.artifactVerification?.missingCount, 1);
	assert.deepEqual(presentation.batchSteps?.[1]?.nextActions?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.equal(presentation.batchSteps?.[1]?.pageChangeSummary?.changeType, "artifact");
	assert.equal(presentation.batchSteps?.[1]?.pageChangeSummary?.savedFilePath, "/tmp/export.csv");
});

test("buildToolPresentation does not re-append old artifact retention noise for routine explicit batch files", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-explicit-noise-"));
	const downloadPath = join(tempDir, "export.csv");
	await writeFile(downloadPath, "a,b\n1,2\n");
	const baseManifest: SessionArtifactManifest = {
		entries: [
			{
				createdAtMs: 1_000,
				evictedAtMs: 2_000,
				kind: "spill",
				path: "/tmp/old-spill.json",
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
				data: [{ command: ["download", "@e1", "export.csv"], result: { path: "export.csv" }, success: true }],
			},
		});
		const text = (presentation.content[0] as { text: string }).text;
		assert.match(text, /Downloaded file verified: export\.csv/);
		assert.doesNotMatch(text, /Session artifacts:/);
		assert.match(presentation.artifactRetentionSummary ?? "", /1 live, 1 evicted/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation reuses standalone inline screenshot rendering inside batch output", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-image-"));
	const imagePath = join(tempDir, "batched.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

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

		const text = (presentation.content[0] as { text: string }).text;
		assert.match(text, /Step 1 — open https:\/\/example.com/);
		assert.match(text, /Example Domain/);
		assert.match(text, /Step 2 — screenshot/);
		assert.match(text, /Saved image: batched.png/);
		assert.match(text, /1 inline image attachment below/);
		assert.equal(presentation.content[1]?.type, "image");
		assert.equal(presentation.imagePath, imagePath);
		assert.deepEqual(presentation.imagePaths, [imagePath]);
		assert.equal(presentation.artifacts?.[0]?.kind, "image");
		assert.equal(presentation.artifacts?.[0]?.path, "batched.png");
		assert.equal(presentation.artifacts?.[0]?.absolutePath, imagePath);
		assert.equal(presentation.artifacts?.[0]?.mediaType, "image/png");
		assert.equal(presentation.artifacts?.[0]?.exists, true);
		assert.equal(presentation.batchSteps?.[1]?.imagePath, imagePath);
		assert.equal(presentation.batchSteps?.[1]?.artifacts?.[0]?.kind, "image");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation preserves non-screenshot file artifacts inside batch output", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: "/tmp/pi-agent-browser-batch-artifacts",
		envelope: {
			success: true,
			data: [
				{ command: ["trace", "stop", "trace.zip"], result: { eventCount: 1, path: "trace.zip" }, success: true },
				{ command: ["profiler", "stop", "profile.cpuprofile"], result: { eventCount: 2, path: "profile.cpuprofile" }, success: true },
				{ command: ["record", "start", "recording.webm"], result: { path: "recording.webm" }, success: true },
				{ command: ["record", "stop"], result: { frames: 3, path: "recording.webm" }, success: true },
				{ command: ["network", "har", "stop", "network.har"], result: { path: "network.har", requestCount: 0 }, success: true },
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Step 1 — trace stop trace\.zip/);
	assert.match(text, /Saved trace: trace\.zip/);
	assert.match(text, /Step 2 — profiler stop profile\.cpuprofile/);
	assert.match(text, /Saved profile: profile\.cpuprofile/);
	assert.match(text, /Step 3 — record start recording\.webm/);
	assert.match(text, /Recording started; output will be written on stop: recording\.webm/);
	assert.doesNotMatch(presentation.batchSteps?.[2]?.text ?? "", /Saved recording|not found on disk/);
	assert.match(text, /Step 4 — record stop/);
	assert.match(text, /Saved recording: recording\.webm/);
	assert.match(text, /Step 5 — network har stop network\.har/);
	assert.match(text, /Saved HAR: network\.har/);
	assert.deepEqual(presentation.artifacts?.map((artifact) => artifact.kind), ["trace", "profile", "video", "video", "har"]);
	assert.deepEqual(presentation.batchSteps?.map((step) => step.artifacts?.[0]?.kind), ["trace", "profile", "video", "video", "har"]);
	assert.equal(presentation.imagePath, undefined);
	assert.equal(presentation.imagePaths, undefined);
});

test("buildToolPresentation skips oversized inline image attachments", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-image-"));
	const imagePath = join(tempDir, "large.png");
	await writeFile(imagePath, Buffer.alloc(256, 1));

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES: "128" }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "screenshot" },
				cwd: tempDir,
				envelope: { success: true, data: { path: "large.png" } },
			});

			assert.equal(presentation.content.length, 1);
			assert.equal(presentation.content[0]?.type, "text");
			assert.match((presentation.content[0] as { text: string }).text, /Saved image: large\.png/);
			assert.match((presentation.content[0] as { text: string }).text, /Image attachment skipped:/);
			assert.equal(presentation.imagePath, imagePath);
			assert.equal(presentation.artifacts?.[0]?.kind, "image");
			assert.equal(presentation.artifacts?.[0]?.path, "large.png");
			assert.equal(presentation.artifacts?.[0]?.absolutePath, imagePath);
			assert.equal(presentation.artifacts?.[0]?.sizeBytes, 256);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
