import assert from "node:assert/strict";
import nodeTest from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { BrowserRecordingRegistry } from "../extensions/agent-browser/lib/orchestration/extension-recording.js";
import { isRecord } from "../extensions/agent-browser/lib/parsing.js";
import { RECORDING_RESERVATION_ENTRY_TYPE } from "../extensions/agent-browser/lib/recording-reservations.js";
import type { FileArtifactMetadata } from "../extensions/agent-browser/lib/results/contracts.js";

interface AppendedEntry {
	readonly customType: string;
	readonly data: Readonly<Record<string, unknown>>;
}

interface RegistryFixture {
	readonly active: () => BrowserRecordingRegistry["active"];
	readonly entries: readonly AppendedEntry[];
	readonly failNextAppend: () => void;
	readonly registry: BrowserRecordingRegistry;
	readonly retired: readonly string[];
}

function createRegistry(
	options: { readonly manifestRetired?: boolean; readonly cwd?: string } = {},
): RegistryFixture {
	const entries: AppendedEntry[] = [];
	const retired: string[] = [];
	let failAppend = false;
	const appendEntry: Pick<ExtensionAPI, "appendEntry">["appendEntry"] = (customType, data) => {
		if (failAppend) {
			failAppend = false;
			throw new Error("journal append failed");
		}
		if (!isRecord(data)) {
			throw new Error(`expected record entry data, received ${typeof data}`);
		}
		entries.push({ customType, data });
	};
	const registry = new BrowserRecordingRegistry(
		{ appendEntry },
		{
			retireRecording: (sessionName) => {
				retired.push(sessionName);
				return options.manifestRetired ?? true;
			},
		},
		() => options.cwd ?? "/cwd",
	);
	return {
		active: () => registry.active,
		entries,
		failNextAppend: () => {
			failAppend = true;
		},
		registry,
		retired,
	};
}

function pendingVideo(session: string, path: string): FileArtifactMetadata {
	return {
		absolutePath: `/tmp/${path}`,
		command: "record",
		cwd: "/tmp",
		kind: "video",
		path,
		recordingState: "openRecording",
		session,
		status: "pending",
		subcommand: "start",
		willExistOnStop: true,
	};
}

function savedVideo(session: string, path: string): FileArtifactMetadata {
	return {
		absolutePath: `/tmp/${path}`,
		command: "record",
		cwd: "/tmp",
		kind: "video",
		path,
		session,
		status: "saved",
		subcommand: "stop",
		willExistOnStop: true,
	};
}

function reservationEntry(
	sessionName: string,
	state: "active" | "closed",
	path = `${sessionName}.webm`,
): Readonly<Record<string, unknown>> {
	return {
		customType: RECORDING_RESERVATION_ENTRY_TYPE,
		data: {
			...(state === "active" ? { absolutePath: `/tmp/${path}`, cwd: "/tmp", path } : {}),
			sessionName,
			state,
			version: 1,
		},
		type: "custom",
	};
}

nodeTest("recording registry republishes the whole index after a failed append", () => {
	const fixture = createRegistry();
	fixture.registry.applyArtifacts([pendingVideo("first", "first.webm")]);
	assert.equal(fixture.registry.dirty, false);
	assert.equal(fixture.entries.length, 1);

	fixture.failNextAppend();
	fixture.registry.applyArtifacts([pendingVideo("second", "second.webm")]);
	assert.equal(fixture.registry.dirty, true);
	assert.equal(fixture.entries.length, 1, "the failed append must not count as persisted");

	fixture.registry.flush();
	assert.equal(fixture.registry.dirty, false);
	assert.deepEqual(
		fixture.entries.map((entry) => [entry.data.sessionName, entry.data.state]),
		[
			["first", "active"],
			["first", "active"],
			["second", "active"],
		],
	);
});

nodeTest("recording registry moves a live reservation to its tombstone", () => {
	const fixture = createRegistry();
	fixture.registry.applyArtifacts([pendingVideo("session-one", "one.webm")]);
	fixture.registry.applyArtifacts([savedVideo("session-one", "one.webm")]);

	assert.equal(fixture.registry.active.size, 0);
	assert.deepEqual(
		fixture.entries.map((entry) => entry.data.state),
		["active", "closed"],
	);
});

nodeTest("recording registry keeps live reservations authoritative when replaying a branch", () => {
	const fixture = createRegistry();
	fixture.registry.applyArtifacts([pendingVideo("live", "live.webm")]);

	fixture.registry.restore([
		reservationEntry("live", "active", "branch.webm"),
		reservationEntry("closed", "closed"),
	]);

	assert.equal(fixture.registry.dirty, true, "the branch disagreed about the live row");
	assert.equal(
		fixture.registry.active.get(getAgentBrowserSessionIdentityKey("live"))?.path,
		"live.webm",
	);
	assert.deepEqual(fixture.retired, ["closed"]);
	assert.equal(fixture.registry.active.size, 1);
});

nodeTest("recording registry records a closed fallback when only the manifest changed", () => {
	const fixture = createRegistry({ cwd: "/work" });
	fixture.registry.retire("session-one");

	assert.equal(fixture.entries.length, 1);
	// A closed transition persists identity only; the row it tombstones is gone with the manifest.
	assert.deepEqual(fixture.entries[0]?.data, {
		absolutePath: undefined,
		contactSheetPath: undefined,
		cwd: undefined,
		namespace: undefined,
		path: undefined,
		recordingId: undefined,
		startedAtMs: undefined,
		sessionName: "session-one",
		state: "closed",
		version: 1,
	});
});

nodeTest("recording registry appends nothing when a retire changes nothing", () => {
	const fixture = createRegistry({ manifestRetired: false });
	fixture.registry.retire("session-one");

	assert.equal(fixture.entries.length, 0);
	assert.equal(fixture.registry.dirty, false);
});
