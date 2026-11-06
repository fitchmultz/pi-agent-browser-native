import { isAbsolute } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import { isRecord } from "./parsing.js";
import { isPendingRecordingArtifact } from "./results/artifact-manifest.js";
import type { FileArtifactMetadata } from "./results/contracts.js";

export const RECORDING_RESERVATION_ENTRY_TYPE = "agent-browser-recording-reservation";

import type { ActiveRecordingReservation } from "./results/evidence-contracts.js";
export type { ActiveRecordingReservation } from "./results/evidence-contracts.js";

export interface RecordingReservationTransition {
	readonly reservation: ActiveRecordingReservation;
	readonly state: "active" | "closed";
}

function getReservationKey(
	reservation: Readonly<Pick<ActiveRecordingReservation, "namespace" | "sessionName">>,
): string {
	return getAgentBrowserSessionIdentityKey(reservation.sessionName, reservation.namespace);
}

function getArtifactReservation(
	artifact: FileArtifactMetadata,
): ActiveRecordingReservation | undefined {
	if (
		artifact.session === undefined ||
		artifact.session.length === 0 ||
		artifact.command !== "record" ||
		artifact.kind !== "video"
	) {
		return undefined;
	}
	return {
		absolutePath: artifact.absolutePath,
		cwd: artifact.cwd ?? process.cwd(),
		namespace: artifact.namespace,
		path: artifact.path,
		...(typeof artifact.recording?.recordingId === "string" &&
		artifact.recording.recordingId.length > 0
			? { recordingId: artifact.recording.recordingId }
			: {}),
		...(artifact.recordingStartedAtMs !== undefined
			? { startedAtMs: artifact.recordingStartedAtMs }
			: {}),
		sessionName: artifact.session,
	};
}

function artifactReservations(artifacts: readonly FileArtifactMetadata[]): {
	readonly pendingBySession: Map<string, ActiveRecordingReservation>;
	readonly terminalBySession: Map<string, ActiveRecordingReservation>;
} {
	const pendingBySession = new Map<string, ActiveRecordingReservation>();
	const terminalBySession = new Map<string, ActiveRecordingReservation>();
	for (const artifact of artifacts) {
		let reservation = getArtifactReservation(artifact);
		if (!reservation) {
			continue;
		}
		const sheet = artifacts.find(
			(candidate) =>
				candidate.command === "record" &&
				candidate.kind === "image" &&
				candidate.session === artifact.session &&
				candidate.namespace === artifact.namespace &&
				isPendingRecordingArtifact(candidate),
		);
		if (sheet) {
			reservation = { ...reservation, contactSheetPath: sheet.absolutePath };
		}
		const key = getReservationKey(reservation);
		if (isPendingRecordingArtifact(artifact)) {
			pendingBySession.set(key, reservation);
		} else {
			terminalBySession.set(key, reservation);
		}
	}
	return { pendingBySession, terminalBySession };
}
function reservationChanged(
	existing: ActiveRecordingReservation | undefined,
	pending: ActiveRecordingReservation,
): boolean {
	return (
		!existing ||
		existing.absolutePath !== pending.absolutePath ||
		existing.cwd !== pending.cwd ||
		existing.recordingId !== pending.recordingId ||
		existing.startedAtMs !== pending.startedAtMs ||
		existing.contactSheetPath !== pending.contactSheetPath
	);
}
export function applyRecordingArtifactsToReservations(
	// This mutator owns changes to the namespace/session reservation index, not to reservation values.
	reservations: Map<string, ActiveRecordingReservation>,
	artifacts: readonly FileArtifactMetadata[],
): RecordingReservationTransition[] {
	const { pendingBySession, terminalBySession } = artifactReservations(artifacts);
	const transitions: RecordingReservationTransition[] = [];
	for (const key of terminalBySession.keys()) {
		if (pendingBySession.has(key)) {
			continue;
		}
		const existing = reservations.get(key);
		if (!existing) {
			continue;
		}
		reservations.delete(key);
		transitions.push({ reservation: existing, state: "closed" });
	}
	for (const [key, pending] of pendingBySession) {
		const existing = reservations.get(key);
		reservations.set(key, pending);
		if (reservationChanged(existing, pending)) {
			transitions.push({ reservation: pending, state: "active" });
		}
	}
	return transitions;
}

export function retireRecordingReservation(
	// This mutator owns changes to the namespace/session reservation index, not to reservation values.
	reservations: Map<string, ActiveRecordingReservation>,
	sessionName: string,
	namespace?: string,
): ActiveRecordingReservation | undefined {
	const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
	const reservation = reservations.get(key);
	if (reservation) {
		reservations.delete(key);
	}
	return reservation;
}

export function appendRecordingReservationTransition(
	pi: Pick<ExtensionAPI, "appendEntry">,
	transition: RecordingReservationTransition,
): void {
	const { reservation, state } = transition;
	pi.appendEntry(RECORDING_RESERVATION_ENTRY_TYPE, {
		absolutePath: state === "active" ? reservation.absolutePath : undefined,
		contactSheetPath: state === "active" ? reservation.contactSheetPath : undefined,
		cwd: state === "active" ? reservation.cwd : undefined,
		namespace: reservation.namespace,
		path: state === "active" ? reservation.path : undefined,
		recordingId: state === "active" ? reservation.recordingId : undefined,
		startedAtMs: state === "active" ? reservation.startedAtMs : undefined,
		sessionName: reservation.sessionName,
		state,
		version: 1,
	});
}

function optionalReservationMetadata(data: Readonly<Record<string, unknown>>): boolean {
	if (
		data.contactSheetPath !== undefined &&
		(typeof data.contactSheetPath !== "string" || !isAbsolute(data.contactSheetPath))
	) {
		return false;
	}
	if (
		data.recordingId !== undefined &&
		(typeof data.recordingId !== "string" || data.recordingId.length === 0)
	) {
		return false;
	}
	return (
		data.startedAtMs === undefined ||
		(typeof data.startedAtMs === "number" && Number.isFinite(data.startedAtMs))
	);
}
function parseActiveReservation(
	data: Readonly<Record<string, unknown>>,
	identity: { readonly sessionName: string; readonly namespace?: string | undefined },
): ActiveRecordingReservation | undefined {
	if (!optionalReservationMetadata(data)) {
		return undefined;
	}
	if (
		typeof data.absolutePath !== "string" ||
		!isAbsolute(data.absolutePath) ||
		typeof data.cwd !== "string" ||
		!isAbsolute(data.cwd) ||
		typeof data.path !== "string"
	) {
		return undefined;
	}
	return {
		...identity,
		absolutePath: data.absolutePath,
		cwd: data.cwd,
		path: data.path,
		...(typeof data.contactSheetPath === "string"
			? { contactSheetPath: data.contactSheetPath }
			: {}),
		...(typeof data.recordingId === "string" ? { recordingId: data.recordingId } : {}),
		...(typeof data.startedAtMs === "number" ? { startedAtMs: data.startedAtMs } : {}),
	};
}
function hasReservationIdentity(data: Readonly<Record<string, unknown>>): data is Readonly<
	Record<string, unknown>
> & {
	readonly sessionName: string;
	readonly namespace?: string;
} {
	return (
		typeof data.sessionName === "string" &&
		data.sessionName.length > 0 &&
		(data.namespace === undefined || typeof data.namespace === "string")
	);
}
function parseReservationTransition(data: unknown): RecordingReservationTransition | undefined {
	if (
		!isRecord(data) ||
		data.version !== 1 ||
		(data.state !== "active" && data.state !== "closed")
	) {
		return undefined;
	}
	if (!hasReservationIdentity(data)) {
		return undefined;
	}
	if (data.state === "closed") {
		return {
			reservation: {
				absolutePath: "",
				cwd: "",
				namespace: data.namespace,
				path: "",
				sessionName: data.sessionName,
			},
			state: "closed",
		};
	}
	const reservation = parseActiveReservation(data, {
		sessionName: data.sessionName,
		namespace: data.namespace,
	});
	return reservation ? { reservation, state: "active" } : undefined;
}

export interface RecordingReservationBranchState {
	active: Map<string, ActiveRecordingReservation>;
	terminal: Map<string, ActiveRecordingReservation>;
}

export function restoreRecordingReservationStateFromBranch(
	branch: readonly unknown[],
): RecordingReservationBranchState {
	const reservations = new Map<string, ActiveRecordingReservation>();
	const terminal = new Map<string, ActiveRecordingReservation>();
	for (const entry of branch) {
		if (
			!isRecord(entry) ||
			entry.type !== "custom" ||
			entry.customType !== RECORDING_RESERVATION_ENTRY_TYPE
		) {
			continue;
		}
		const transition = parseReservationTransition(entry.data);
		if (!transition) {
			continue;
		}
		const key = getReservationKey(transition.reservation);
		if (transition.state === "active") {
			reservations.set(key, transition.reservation);
			terminal.delete(key);
		} else {
			reservations.delete(key);
			terminal.set(key, transition.reservation);
		}
	}
	return { active: reservations, terminal };
}
