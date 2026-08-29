import assert from "node:assert/strict";
import test from "node:test";

import {
	RECORDING_RESERVATION_ENTRY_TYPE,
	appendRecordingReservationTransition,
	applyRecordingArtifactsToReservations,
	restoreRecordingReservationStateFromBranch,
	retireRecordingReservation,
	type ActiveRecordingReservation,
} from "../extensions/agent-browser/lib/recording-reservations.js";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { isPendingRecordingCommand, mergeSessionArtifactManifest } from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import type { FileArtifactMetadata, SessionArtifactManifestEntry } from "../extensions/agent-browser/lib/results/contracts.js";

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

function pendingManifestEntry(session: string, namespace: string, path: string, createdAtMs: number): SessionArtifactManifestEntry {
	return {
		absolutePath: `/tmp/${path}`,
		command: "record",
		createdAtMs,
		cwd: "/tmp",
		kind: "video",
		namespace,
		path,
		retentionState: "live",
		session,
		storageScope: "explicit-path",
		subcommand: "start",
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
	assert.equal(restoredState.active.size, 1);
	assert.equal(restoredState.active.get(getAgentBrowserSessionIdentityKey("shared", "beta"))?.path, "beta.webm");
	assert.equal(restoredState.terminal.has(getAgentBrowserSessionIdentityKey("shared", "alpha")), true);
	assert.equal(appended.every((entry) => entry.customType === RECORDING_RESERVATION_ENTRY_TYPE), true);
});

test("recording reservation transition replay keeps the newest pending path authoritative", () => {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const appendEntry = (customType: string, data: unknown) => appended.push({ customType, data });
	const older = pendingArtifact("shared", "scope", "older.webm");
	const newer = pendingArtifact("shared", "scope", "newer.webm");
	appendRecordingReservationTransition({ appendEntry } as never, {
		reservation: { absolutePath: older.absolutePath, cwd: older.cwd ?? "/tmp", namespace: older.namespace, path: older.path, sessionName: older.session ?? "" },
		state: "closed",
	});
	appendRecordingReservationTransition({ appendEntry } as never, {
		reservation: { absolutePath: newer.absolutePath, cwd: newer.cwd ?? "/tmp", namespace: newer.namespace, path: newer.path, sessionName: newer.session ?? "" },
		state: "active",
	});
	const newestFirstEntries = [
		pendingManifestEntry("shared", "scope", "newer.webm", 2),
		pendingManifestEntry("shared", "scope", "older.webm", 1),
	];
	const branch = [
		...appended.map((entry) => ({ type: "custom", ...entry })),
		{
			type: "message",
			message: {
				toolName: "agent_browser",
				details: {
					artifactManifest: { entries: newestFirstEntries, evictedCount: 0, liveCount: 2, maxEntries: 20, updatedAtMs: 2, version: 1 },
				},
			},
		},
	];
	const restored = restoreRecordingReservationStateFromBranch(branch);
	assert.equal(restored.active.get(getAgentBrowserSessionIdentityKey("shared", "scope"))?.path, "newer.webm");
	assert.equal(restored.terminal.size, 0);

	const firstManifest = mergeSessionArtifactManifest({ entries: [newestFirstEntries[1]] });
	const mergedManifest = mergeSessionArtifactManifest({ base: firstManifest, entries: [newestFirstEntries[0]] });
	assert.deepEqual(
		mergedManifest?.entries.filter((entry) => entry.command === "record" && entry.subcommand === "start").map((entry) => entry.path),
		["newer.webm"],
	);
	const mergedNewestFirst = mergeSessionArtifactManifest({ entries: newestFirstEntries });
	assert.deepEqual(
		mergedNewestFirst?.entries.filter((entry) => entry.command === "record" && entry.subcommand === "start").map((entry) => entry.path),
		["newer.webm"],
	);

	const sameTimestampManifest = mergeSessionArtifactManifest({ entries: [
		pendingManifestEntry("shared", "scope", "same-ms-older.webm", 3),
		pendingManifestEntry("shared", "scope", "same-ms-newer.webm", 3),
	] });
	assert.deepEqual(
		sameTimestampManifest?.entries.filter((entry) => isPendingRecordingCommand(entry.command, entry.subcommand, entry.kind)).map((entry) => entry.path),
		["same-ms-newer.webm"],
	);

	const pendingThenStopped = pendingManifestEntry("shared", "scope", "same-ms-finished.webm", 4);
	const stoppedAtSameTimestamp = { ...pendingThenStopped, subcommand: "stop" };
	const stoppedManifest = mergeSessionArtifactManifest({ entries: [pendingThenStopped, stoppedAtSameTimestamp] });
	assert.deepEqual(stoppedManifest?.entries.map((entry) => entry.subcommand), ["stop"]);
	const manifestOnlyReplay = restoreRecordingReservationStateFromBranch([{
		type: "message",
		message: { toolName: "agent_browser", details: { artifactManifest: stoppedManifest } },
	}]);
	assert.equal(manifestOnlyReplay.active.size, 0);
	assert.equal(manifestOnlyReplay.terminal.size, 0);
});
