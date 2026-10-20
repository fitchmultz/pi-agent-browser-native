/**
 * Purpose: Verify validation contracts that intentionally acquire the real default-namespace barrier.
 * Responsibilities: Preserve complete close-all contention and recording-reservation assertions.
 * Scope: Existing serial test stage; Windows shares this coordination domain across socket roots.
 */

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readRecord, readString } from "./helpers/assertions.js";
import { executeRegisteredTool } from "./helpers/agent-browser-harness.js";
import {
	assertReleasedPdf,
	runCloseAllNamespaceScenarios,
	withRecordingReservationHarness,
} from "./helpers/extension-validation-coordination-fixtures.js";

test(
	"agentBrowserExtension makes close --all exclusive within the default namespace",
	{ concurrency: false },
	async (t) => {
		assert.deepEqual(await runCloseAllNamespaceScenarios(t, "default"), [
			"caller-default",
			"explicit-default",
			"current-default-ambient",
		]);
	},
);

test(
	"agentBrowserExtension keeps browser ownership when the first managed batch call fails after close",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"first-call",
			"Test failed post-close launch ownership.",
			async (firstCallHarness) => {
				const failedFirstCall = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{
						sessionMode: "fresh",
						args: ["batch"],
						stdin: JSON.stringify([["close"], ["click", "#missing-after-close"]]),
					},
				);
				assert.equal(failedFirstCall.isError, true, failedFirstCall.content.at(0)?.text);
				assert.equal(
					readRecord(readRecord(failedFirstCall.details).managedSessionOutcome).activeAfter,
					true,
				);
				assert.equal(typeof readRecord(failedFirstCall.details).sessionName, "string");
				const recoveredFirstCall = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{ args: ["get", "url"] },
				);
				assert.equal(recoveredFirstCall.isError, false, recoveredFirstCall.content.at(0)?.text);
				assert.equal(
					readRecord(recoveredFirstCall.details).sessionName,
					readRecord(failedFirstCall.details).sessionName,
				);
				const closeAllFirstCall = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{ args: ["--session", "caller-owned", "close", "--all"] },
				);
				assert.equal(readRecord(closeAllFirstCall.details).closeAllApplied, true);
				assert.equal(
					readRecord(readRecord(closeAllFirstCall.details).managedSessionOutcome).activeAfter,
					false,
				);
				const rotatedAfterCloseAll = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{ args: ["get", "url"] },
				);
				assert.notEqual(
					readRecord(rotatedAfterCloseAll.details).sessionName,
					readRecord(failedFirstCall.details).sessionName,
				);
				await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, {
					args: ["close"],
				});
			},
		);
	},
);

test(
	"agentBrowserExtension releases recording reservations by namespace on close --all",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"namespace-close",
			"Record a browser workflow.",
			async (harness, { tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				const globalOne = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "global-one", "record", "start", "global-one.webm"],
				});
				assert.equal(globalOne.isError, false, globalOne.content.at(0)?.text);
				const globalTwo = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "global-two", "record", "start", "global-two.webm"],
				});
				assert.equal(globalTwo.isError, false, globalTwo.content.at(0)?.text);
				const otherNamespaceRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"--namespace",
						"other",
						"--session",
						"global-three",
						"record",
						"start",
						"global-three.webm",
					],
				});
				assert.equal(
					otherNamespaceRecording.isError,
					false,
					otherNamespaceRecording.content.at(0)?.text,
				);
				assert.equal(readRecord(otherNamespaceRecording.details).namespace, "other");
				const globalClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["close", "--all"],
				});
				assert.equal(readRecord(globalClose.details).closeAllApplied, true);
				assert.equal(readRecord(globalClose.details).namespace, undefined);
				const releasedGlobalOne = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "global-one.webm"],
				});
				const releasedGlobalTwo = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "global-two.webm"],
				});
				assertReleasedPdf(releasedGlobalOne);
				assertReleasedPdf(releasedGlobalTwo);
				const retainedOtherNamespace = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "global-three.webm"],
				});
				assert.match(
					readString(readRecord(retainedOtherNamespace.content.at(0)).text),
					/reserved by an active recording/,
				);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "close", "--all"],
				});
			},
		);
	},
);
