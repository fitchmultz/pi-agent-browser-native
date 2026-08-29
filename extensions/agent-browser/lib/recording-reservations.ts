import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import { isRecord } from "./parsing.js";
import { isPendingRecordingArtifact } from "./results/artifact-manifest.js";
import type { FileArtifactMetadata } from "./results/contracts.js";

export const RECORDING_RESERVATION_ENTRY_TYPE = "agent-browser-recording-reservation";

export interface ActiveRecordingReservation {
	absolutePath: string;
	cwd: string;
	namespace?: string;
	path: string;
	sessionName: string;
}

export interface RecordingReservationTransition {
	reservation: ActiveRecordingReservation;
	state: "active" | "closed";
}

function getReservationKey(reservation: Pick<ActiveRecordingReservation, "namespace" | "sessionName">): string {
	return getAgentBrowserSessionIdentityKey(reservation.sessionName, reservation.namespace);
}

function getArtifactReservation(artifact: FileArtifactMetadata): ActiveRecordingReservation | undefined {
	if (!artifact.session || artifact.command !== "record" || artifact.kind !== "video") return undefined;
	return {
		absolutePath: artifact.absolutePath,
		cwd: artifact.cwd ?? process.cwd(),
		namespace: artifact.namespace,
		path: artifact.path,
		sessionName: artifact.session,
	};
}

export function applyRecordingArtifactsToReservations(
	reservations: Map<string, ActiveRecordingReservation>,
	artifacts: readonly FileArtifactMetadata[],
): RecordingReservationTransition[] {
	const pendingBySession = new Map<string, ActiveRecordingReservation>();
	const terminalBySession = new Map<string, ActiveRecordingReservation>();
	for (const artifact of artifacts) {
		const reservation = getArtifactReservation(artifact);
		if (!reservation) continue;
		const key = getReservationKey(reservation);
		if (isPendingRecordingArtifact(artifact)) pendingBySession.set(key, reservation);
		else terminalBySession.set(key, reservation);
	}
	const transitions: RecordingReservationTransition[] = [];
	for (const key of terminalBySession.keys()) {
		if (pendingBySession.has(key)) continue;
		const existing = reservations.get(key);
		if (!existing) continue;
		reservations.delete(key);
		transitions.push({ reservation: existing, state: "closed" });
	}
	for (const [key, pending] of pendingBySession) {
		const existing = reservations.get(key);
		reservations.set(key, pending);
		if (!existing || existing.absolutePath !== pending.absolutePath || existing.cwd !== pending.cwd) {
			transitions.push({ reservation: pending, state: "active" });
		}
	}
	return transitions;
}

export function retireRecordingReservation(
	reservations: Map<string, ActiveRecordingReservation>,
	sessionName: string,
	namespace?: string,
): ActiveRecordingReservation | undefined {
	const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
	const reservation = reservations.get(key);
	if (reservation) reservations.delete(key);
	return reservation;
}

export function appendRecordingReservationTransition(pi: ExtensionAPI, transition: RecordingReservationTransition): void {
	const { reservation, state } = transition;
	pi.appendEntry(RECORDING_RESERVATION_ENTRY_TYPE, {
		absolutePath: state === "active" ? reservation.absolutePath : undefined,
		cwd: state === "active" ? reservation.cwd : undefined,
		namespace: reservation.namespace,
		path: state === "active" ? reservation.path : undefined,
		sessionName: reservation.sessionName,
		state,
		version: 1,
	});
}

function parseReservationTransition(data: unknown): RecordingReservationTransition | undefined {
	if (!isRecord(data) || data.version !== 1 || (data.state !== "active" && data.state !== "closed")) return undefined;
	if (typeof data.sessionName !== "string" || data.sessionName.length === 0) return undefined;
	if (data.namespace !== undefined && typeof data.namespace !== "string") return undefined;
	if (data.state === "closed") {
		return {
			reservation: { absolutePath: "", cwd: "", namespace: data.namespace, path: "", sessionName: data.sessionName },
			state: "closed",
		};
	}
	if (typeof data.absolutePath !== "string" || typeof data.cwd !== "string" || typeof data.path !== "string") return undefined;
	return {
		reservation: {
			absolutePath: data.absolutePath,
			cwd: data.cwd,
			namespace: data.namespace,
			path: data.path,
			sessionName: data.sessionName,
		},
		state: "active",
	};
}

export interface RecordingReservationBranchState {
	active: Map<string, ActiveRecordingReservation>;
	terminal: Map<string, ActiveRecordingReservation>;
}

export function restoreRecordingReservationStateFromBranch(branch: unknown[]): RecordingReservationBranchState {
	const reservations = new Map<string, ActiveRecordingReservation>();
	const terminal = new Map<string, ActiveRecordingReservation>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== RECORDING_RESERVATION_ENTRY_TYPE) continue;
		const transition = parseReservationTransition(entry.data);
		if (!transition) continue;
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
