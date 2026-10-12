import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
	RECORDING_RESERVATION_ENTRY_TYPE,
	appendRecordingReservationTransition,
	applyRecordingArtifactsToReservations,
	restoreRecordingReservationStateFromBranch,
	type ActiveRecordingReservation,
} from "../extensions/agent-browser/lib/recording-reservations.js";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import type { FileArtifactMetadata } from "../extensions/agent-browser/lib/results/contracts.js";

function pendingArtifact(session: string, namespace: string, path: string): FileArtifactMetadata {
	return {
		absolutePath: `/tmp/${path}`,
		command: "record",
		cwd: "/tmp",
		kind: "video",
		namespace,
		path,
		recordingState: "openRecording",
		session,
		status: "pending",
		subcommand: "start",
		willExistOnStop: true,
	};
}

test("recording replay rejects relative storage paths without changing display paths or valid rows", () => {
	const valid = {
		absolutePath: resolve("video.webm"),
		cwd: process.cwd(),
		namespace: "scope",
		path: "display/video.webm",
		sessionName: "valid",
		state: "active",
		version: 1,
	};
	const branch = [
		valid,
		...[{ absolutePath: "video.webm" }, { absolutePath: "" }, { cwd: "." }, { cwd: "" }].map(
			(invalid, index) => Object.assign({}, valid, invalid, { sessionName: `invalid-${index}` }),
		),
		{ version: 1, state: "closed", sessionName: "closed" },
	].map((data) => ({ type: "custom", customType: RECORDING_RESERVATION_ENTRY_TYPE, data }));
	const restored = restoreRecordingReservationStateFromBranch(branch);
	assert.deepEqual(
		[...restored.active.values()],
		[
			{
				absolutePath: valid.absolutePath,
				cwd: valid.cwd,
				namespace: valid.namespace,
				path: valid.path,
				sessionName: valid.sessionName,
			},
		],
	);
	assert.equal(restored.terminal.size, 1);
});

test("contact-sheet reservations survive replay and retire with their video", () => {
	const reservations = new Map<string, ActiveRecordingReservation>();
	const video = {
		...pendingArtifact("shared", "scope", "capture.webm"),
		absolutePath: resolve("capture.webm"),
		cwd: process.cwd(),
	};
	const sheet = {
		...video,
		kind: "image" as const,
		absolutePath: resolve("capture.contact-sheet.png"),
		path: "capture.contact-sheet.png",
	};
	const transitions = applyRecordingArtifactsToReservations(reservations, [video, sheet]);
	assert.equal(transitions[0].reservation.contactSheetPath, sheet.absolutePath);
	const branch: unknown[] = [];
	for (const transition of transitions) {
		appendRecordingReservationTransition(
			{
				appendEntry: (customType: string, data: unknown) => {
					branch.push({ type: "custom", customType, data });
				},
			},
			transition,
		);
	}
	const restored = restoreRecordingReservationStateFromBranch(branch).active;
	assert.equal(
		restored.get(getAgentBrowserSessionIdentityKey("shared", "scope"))?.contactSheetPath,
		sheet.absolutePath,
	);
	applyRecordingArtifactsToReservations(restored, [
		{ ...video, subcommand: "stop", status: "saved", recordingState: undefined },
	]);
	assert.equal(restored.size, 0);
});

test("recording reservation journal ignores unrelated bounded manifests and retires exact identities", () => {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const appendEntry = (customType: string, data: unknown) => {
		appended.push({ customType, data });
	};
	const alpha = pendingArtifact("shared", "alpha", "alpha.webm");
	const beta = pendingArtifact("shared", "beta", "beta.webm");
	appendRecordingReservationTransition(
		{ appendEntry },
		{
			reservation: {
				absolutePath: alpha.absolutePath,
				cwd: alpha.cwd ?? "/tmp",
				namespace: alpha.namespace,
				path: alpha.path,
				sessionName: alpha.session ?? "",
			},
			state: "active",
		},
	);
	appendRecordingReservationTransition(
		{ appendEntry },
		{
			reservation: {
				absolutePath: beta.absolutePath,
				cwd: beta.cwd ?? "/tmp",
				namespace: beta.namespace,
				path: beta.path,
				sessionName: beta.session ?? "",
			},
			state: "active",
		},
	);
	appendRecordingReservationTransition(
		{ appendEntry },
		{
			reservation: {
				absolutePath: alpha.absolutePath,
				cwd: alpha.cwd ?? "/tmp",
				namespace: alpha.namespace,
				path: alpha.path,
				sessionName: alpha.session ?? "",
			},
			state: "closed",
		},
	);
	const branch = [
		...appended.slice(0, 2).map((entry) => Object.assign({ type: "custom" }, entry)),
		{
			type: "message",
			message: {
				toolName: "agent_browser",
				details: {
					artifactManifest: {
						entries: [
							{
								createdAtMs: 3,
								kind: "image",
								path: "newer.png",
								retentionState: "live",
								storageScope: "explicit-path",
							},
						],
						evictedCount: 0,
						liveCount: 1,
						maxEntries: 1,
						updatedAtMs: 3,
						version: 1,
					},
				},
			},
		},
		{ type: "custom", ...appended[2] },
	];
	const restoredState = restoreRecordingReservationStateFromBranch(branch);
	assert.equal(restoredState.active.size, 1);
	assert.equal(
		restoredState.active.get(getAgentBrowserSessionIdentityKey("shared", "beta"))?.path,
		"beta.webm",
	);
	assert.equal(
		restoredState.terminal.has(getAgentBrowserSessionIdentityKey("shared", "alpha")),
		true,
	);
	assert.equal(
		appended.every((entry) => entry.customType === RECORDING_RESERVATION_ENTRY_TYPE),
		true,
	);
	appendRecordingReservationTransition(
		{ appendEntry },
		{
			reservation: {
				absolutePath: "/tmp/newest-alpha.webm",
				cwd: "/tmp",
				namespace: "alpha",
				path: "newest-alpha.webm",
				sessionName: "shared",
			},
			state: "active",
		},
	);
	const ignoredManifest = {
		entries: [alpha, beta].map((artifact) =>
			Object.assign({}, artifact, {
				createdAtMs: 4,
				retentionState: "live",
				storageScope: "explicit-path",
			}),
		),
		evictedCount: 0,
		liveCount: 2,
		maxEntries: 20,
		updatedAtMs: 4,
		version: 1,
	};
	const reopened = restoreRecordingReservationStateFromBranch([
		...branch,
		{ type: "custom", ...appended[3] },
		{
			type: "message",
			message: {
				toolName: "agent_browser",
				details: { artifactManifest: ignoredManifest },
			},
		},
	]);
	assert.equal(reopened.active.size, 2);
	assert.equal(
		reopened.active.get(getAgentBrowserSessionIdentityKey("shared", "alpha"))?.path,
		"newest-alpha.webm",
	);
	assert.equal(reopened.terminal.size, 0);
	const messageOnly = restoreRecordingReservationStateFromBranch([
		{
			type: "message",
			message: {
				toolName: "agent_browser",
				details: { artifactManifest: ignoredManifest },
			},
		},
	]);
	assert.equal(messageOnly.active.size, 0);
	assert.equal(messageOnly.terminal.size, 0);
});
