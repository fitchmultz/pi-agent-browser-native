import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { getAgentBrowserSessionIdentityKey, isAgentBrowserSessionIdentityKeyInNamespace } from "./argv-grammar.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "./batch-lifecycle.js";
import { isCloseAllCommand, isCloseCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { isPendingRecordingArtifact, isPendingRecordingCommand, isSessionArtifactManifest } from "./results/artifact-manifest.js";
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
		if (!isRecord(entry)) continue;
		if (entry.type === "custom" && entry.customType === RECORDING_RESERVATION_ENTRY_TYPE) {
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
			continue;
		}
		if (entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		const details = message?.toolName === "agent_browser" && isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		if (isSessionArtifactManifest(details.artifactManifest)) {
			const artifacts: FileArtifactMetadata[] = [...details.artifactManifest.entries]
				.sort((left, right) => left.createdAtMs - right.createdAtMs
					|| Number(isPendingRecordingCommand(left.command, left.subcommand, left.kind)) - Number(isPendingRecordingCommand(right.command, right.subcommand, right.kind))
					|| left.path.localeCompare(right.path))
				.filter((manifestEntry) => manifestEntry.command === "record" && manifestEntry.kind === "video" && manifestEntry.session)
				.map((manifestEntry) => ({
					absolutePath: manifestEntry.absolutePath ?? manifestEntry.path,
					command: manifestEntry.command,
					cwd: manifestEntry.cwd,
					kind: "video",
					namespace: manifestEntry.namespace,
					path: manifestEntry.path,
					session: manifestEntry.session,
					status: isPendingRecordingCommand(manifestEntry.command, manifestEntry.subcommand, "video") ? "pending" : "saved",
					subcommand: manifestEntry.subcommand,
				}));
			for (const artifact of artifacts) {
				const reservation = getArtifactReservation(artifact);
				if (!reservation) continue;
				const key = getReservationKey(reservation);
				applyRecordingArtifactsToReservations(reservations, [artifact]);
				if (isPendingRecordingArtifact(artifact)) terminal.delete(key);
				else terminal.set(key, reservation);
			}
		}
		const messageSucceeded = typeof message?.isError === "boolean"
			? !message.isError
			: typeof details.exitCode !== "number" || details.exitCode === 0;
		const args = Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string") ? details.args : [];
		const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
		const closeAllApplied = details.closeAllApplied === true
			|| (messageSucceeded && isCloseAllCommand(extractUpstreamCommandTokens(args)))
			|| batchHasSuccessfulCloseAll(details.batchSteps);
		if (closeAllApplied) {
			for (const [key, reservation] of reservations) {
				if (!isAgentBrowserSessionIdentityKeyInNamespace(key, namespace)) continue;
				terminal.set(key, reservation);
				reservations.delete(key);
			}
			continue;
		}
		const directCloseSucceeded = messageSucceeded && isCloseCommand(typeof details.command === "string" ? details.command : undefined);
		const batchRecordingClosed = getSuccessfulBatchCloseLifecycle(details.batchSteps)?.recordingClosedAfterBatch === true;
		if ((directCloseSucceeded || batchRecordingClosed) && typeof details.sessionName === "string") {
			const key = getAgentBrowserSessionIdentityKey(details.sessionName, namespace);
			const reservation = reservations.get(key);
			if (reservation) terminal.set(key, reservation);
			reservations.delete(key);
		}
	}
	return { active: reservations, terminal };
}
