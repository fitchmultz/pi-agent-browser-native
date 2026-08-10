import assert from "node:assert/strict";
import test from "node:test";

import {
	RECORDING_RESERVATION_ENTRY_TYPE,
	appendRecordingReservationTransition,
	applyRecordingArtifactsToReservations,
	restoreActiveRecordingReservationsFromBranch,
	restoreRecordingReservationStateFromBranch,
	retireRecordingReservation,
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

test("recording reservations distinguish namespace plus session identity", () => {
	const reservations = new Map<string, ActiveRecordingReservation>();
	applyRecordingArtifactsToReservations(reservations, [
		pendingArtifact("shared", "one", "one.webm"),
		pendingArtifact("shared", "two", "two.webm"),
	]);
	assert.equal(reservations.size, 2);
	assert.equal(retireRecordingReservation(reservations, "shared", "one")?.path, "one.webm");
	assert.equal(reservations.size, 1);
	assert.equal(reservations.get(getAgentBrowserSessionIdentityKey("shared", "two"))?.path, "two.webm");
});

test("recording reservation branch entries survive bounded manifest eviction and retire exactly", () => {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const appendEntry = (customType: string, data: unknown) => appended.push({ customType, data });
	const alpha = pendingArtifact("shared", "alpha", "alpha.webm");
	const beta = pendingArtifact("shared", "beta", "beta.webm");
	appendRecordingReservationTransition({ appendEntry } as never, {
		reservation: { absolutePath: alpha.absolutePath, cwd: alpha.cwd ?? "/tmp", namespace: alpha.namespace, path: alpha.path, sessionName: alpha.session ?? "" },
		state: "active",
	});
	appendRecordingReservationTransition({ appendEntry } as never, {
		reservation: { absolutePath: beta.absolutePath, cwd: beta.cwd ?? "/tmp", namespace: beta.namespace, path: beta.path, sessionName: beta.session ?? "" },
		state: "active",
	});
	appendRecordingReservationTransition({ appendEntry } as never, {
		reservation: { absolutePath: alpha.absolutePath, cwd: alpha.cwd ?? "/tmp", namespace: alpha.namespace, path: alpha.path, sessionName: alpha.session ?? "" },
		state: "closed",
	});
	const branch = [
		...appended.slice(0, 2).map((entry) => ({ type: "custom", ...entry })),
		{
			type: "message",
			message: {
				toolName: "agent_browser",
				details: {
					artifactManifest: {
						entries: [{ createdAtMs: 3, kind: "image", path: "newer.png", retentionState: "live", storageScope: "explicit-path" }],
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
	const restored = restoreActiveRecordingReservationsFromBranch(branch);
	assert.equal(restored.size, 1);
	assert.equal(restored.get(getAgentBrowserSessionIdentityKey("shared", "beta"))?.path, "beta.webm");
	assert.equal(restoredState.terminal.has(getAgentBrowserSessionIdentityKey("shared", "alpha")), true);
	assert.equal(appended.every((entry) => entry.customType === RECORDING_RESERVATION_ENTRY_TYPE), true);
});
