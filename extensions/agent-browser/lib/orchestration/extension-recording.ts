import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extractUpstreamCommandTokens } from "../runtime.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import { isCloseCommand } from "../command-taxonomy.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import type { FileArtifactMetadata } from "../results/contracts.js";
import {
	applyNamespaceToNextActions,
	applySessionToNextActions,
	buildNextToolAction,
} from "../results/next-actions.js";
import {
	appendRecordingReservationTransition,
	applyRecordingArtifactsToReservations,
	retireRecordingReservation,
	type ActiveRecordingReservation,
	type RecordingReservationTransition,
	restoreRecordingReservationStateFromBranch,
} from "../recording-reservations.js";
import { isResultFileArtifact, getResultFileArtifacts } from "./extension-result-state.js";
import type { RecordingArtifactAccess } from "./extension-artifacts.js";

const recordingPersistenceWarning =
	"Recording persistence warning: recording protection could not be saved to the Pi journal. Restart protection is not yet durable; keep recording destinations untouched until exact stop or close. The next browser operation retries journal persistence; cleanup remains available.";

export interface RecordingPublicationAccess {
	readonly active: ReadonlyMap<string, ActiveRecordingReservation>;
	readonly dirty: boolean;
	readonly flush: () => void;
}
/** Owns the durable unbounded recording index separately from the bounded artifact manifest. */
export class BrowserRecordingRegistry {
	active = new Map<string, ActiveRecordingReservation>();
	private readonly terminal = new Map<string, ActiveRecordingReservation>();
	private persistenceDirty = false;
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly artifacts: RecordingArtifactAccess,
		private readonly getCwd: () => string,
	) {}
	get dirty(): boolean {
		return this.persistenceDirty;
	}
	flush(): void {
		if (!this.persistenceDirty) {
			return;
		}
		try {
			// A failed append may mask earlier reservations; republish the full current index.
			for (const reservation of this.terminal.values()) {
				appendRecordingReservationTransition(this.pi, { reservation, state: "closed" });
			}
			for (const reservation of this.active.values()) {
				appendRecordingReservationTransition(this.pi, { reservation, state: "active" });
			}
			this.persistenceDirty = false;
		} catch {
			// Keep the dirty index for the next operation's persistence retry.
		}
	}
	append(transitions: readonly RecordingReservationTransition[]): void {
		for (const transition of transitions) {
			const key = getAgentBrowserSessionIdentityKey(
				transition.reservation.sessionName,
				transition.reservation.namespace,
			);
			if (transition.state === "active") {
				this.terminal.delete(key);
			} else {
				this.terminal.set(key, transition.reservation);
			}
			if (this.persistenceDirty) {
				continue;
			}
			try {
				appendRecordingReservationTransition(this.pi, transition);
			} catch {
				this.persistenceDirty = true;
			}
		}
	}
	applyArtifacts(artifacts: readonly FileArtifactMetadata[]): void {
		this.append(applyRecordingArtifactsToReservations(this.active, artifacts));
	}
	retire(sessionName: string, namespace?: string, retireManifest = true): void {
		const reservation = retireRecordingReservation(this.active, sessionName, namespace);
		const changed = retireManifest && this.artifacts.retireRecording(sessionName, namespace);
		if (!reservation && !changed) {
			return;
		}
		const terminal = reservation ?? {
			absolutePath: "",
			cwd: this.getCwd(),
			namespace,
			path: "",
			sessionName,
		};
		this.append([{ reservation: terminal, state: "closed" }]);
	}
	restore(branch: readonly unknown[]): void {
		const restored = restoreRecordingReservationStateFromBranch([...branch]);
		for (const key of this.terminal.keys()) {
			if (!restored.terminal.has(key)) {
				this.persistenceDirty = true;
			}
		}
		for (const [key, reservation] of restored.terminal) {
			if (!this.active.has(key)) {
				this.terminal.set(key, reservation);
			}
		}
		for (const [key, reservation] of this.terminal) {
			restored.active.delete(key);
			this.artifacts.retireRecording(reservation.sessionName, reservation.namespace);
		}
		for (const [key, reservation] of this.active) {
			if (recordingReservationChanged(restored.active.get(key), reservation)) {
				this.persistenceDirty = true;
			}
			restored.active.set(key, reservation);
		}
		this.active = restored.active;
	}
	resetIfClean(): void {
		if (!this.persistenceDirty) {
			this.active = new Map();
			this.terminal.clear();
		}
	}
	syncResult(result: AgentToolResult<unknown>): Set<string> {
		const details = isRecord(result.details) ? result.details : undefined;
		const steps: readonly unknown[] | undefined = Array.isArray(details?.batchSteps)
			? details.batchSteps
			: undefined;
		if (!steps) {
			this.applyArtifacts(getResultFileArtifacts(result));
			return new Set();
		}
		const fold = new RecordingBatchFold(
			this,
			typeof details?.sessionName === "string" ? details.sessionName : undefined,
			typeof details?.namespace === "string" ? details.namespace : undefined,
		);
		for (const step of steps) {
			fold.apply(step);
		}
		return fold.finish();
	}
	retireManifest(sessionName: string, namespace?: string): void {
		this.artifacts.retireRecording(sessionName, namespace);
	}
}
function recordingReservationChanged(
	prior: ActiveRecordingReservation | undefined,
	current: ActiveRecordingReservation,
): boolean {
	return (
		prior?.absolutePath !== current.absolutePath ||
		prior.cwd !== current.cwd ||
		prior.recordingId !== current.recordingId ||
		prior.startedAtMs !== current.startedAtMs ||
		prior.contactSheetPath !== current.contactSheetPath
	);
}

function warningJson(text: string): Record<string, unknown> | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isRecord(json) && typeof json.success === "boolean" ? json : undefined;
}

export function warnRecordingPersistence(
	dirty: boolean,
	result: AgentToolResult<unknown>,
): AgentBrowserToolResult {
	if (!dirty) {
		return result;
	}
	const content = [...result.content];
	const first = content.at(0);
	const json = first?.type === "text" ? warningJson(first.text) : undefined;
	if (json) {
		const warnings: readonly unknown[] = Array.isArray(json.warnings) ? json.warnings : [];
		content[0] = {
			type: "text",
			text: JSON.stringify(
				{ ...json, warnings: [...warnings, recordingPersistenceWarning] },
				null,
				2,
			),
		};
	} else if (first?.type === "text") {
		content[0] = { ...first, text: `${first.text}\n\n${recordingPersistenceWarning}` };
	} else {
		content.push({ type: "text", text: recordingPersistenceWarning });
	}
	const details = isRecord(result.details) ? result.details : {};
	const warnings: readonly unknown[] = Array.isArray(details.warnings) ? details.warnings : [];
	return {
		...result,
		content,
		details: {
			...details,
			warnings: [...warnings, recordingPersistenceWarning],
			recordingPersistenceWarning,
		},
	};
}

export function notifyRecordingPersistence(
	dirty: boolean,
	ctx: ExtensionContext | undefined,
): void {
	if (!dirty) {
		return;
	}
	if (ctx?.hasUI === true) {
		ctx.ui.notify(recordingPersistenceWarning, "warning");
	} else {
		console.warn(recordingPersistenceWarning);
	}
}

function recordingCleanupActions(
	reservation: Readonly<ActiveRecordingReservation>,
	cleanupOnly: boolean,
): ReturnType<typeof applyNamespaceToNextActions> {
	const action = buildNextToolAction({
		args: cleanupOnly ? ["close"] : ["record", "stop"],
		id: cleanupOnly ? "close-pending-recording" : "stop-pending-recording",
		reason: cleanupOnly
			? "Close this exact session to abandon the recording; its live daemon lacks current-instance provenance."
			: "Stop the active recording so the requested video can be finalized and verified on disk.",
		safety: cleanupOnly
			? "Close does not verify the WebM. The recording is abandoned/unverified, even if close leaves a file on disk."
			: "The file remains pending until record stop succeeds; verify details.artifactVerification afterward.",
	});
	return applyNamespaceToNextActions(
		applySessionToNextActions([action], reservation.sessionName),
		cleanupOnly ? (reservation.namespace ?? "") : reservation.namespace,
	);
}

export function appendActiveRecordingCleanupAction(
	result: AgentToolResult<unknown>,
	reservation: Readonly<ActiveRecordingReservation>,
): AgentBrowserToolResult {
	if (result.isError !== true) {
		return result;
	}
	const details: Record<string, unknown> = isRecord(result.details) ? result.details : {};
	const recordingRecovered = Boolean(details.recordingRecovery);
	if (recordingRecovered) {
		return result;
	}
	const cleanupOnly =
		details.managedSessionCleanupOnlyReason === "restore-disabled-daemon-without-provenance";
	const existing: readonly unknown[] = Array.isArray(details.nextActions)
		? details.nextActions
		: [];
	const nextActions = existing.filter(
		(action) => !cleanupOnly || !isRecord(action) || action.id !== "stop-pending-recording",
	);
	const actionId = cleanupOnly ? "close-pending-recording" : "stop-pending-recording";
	if (nextActions.some((action) => isRecord(action) && action.id === actionId)) {
		return result;
	}
	nextActions.push(...(recordingCleanupActions(reservation, cleanupOnly) ?? []));
	const notice = cleanupOnly
		? "This recording cannot be stopped through the unproven daemon. Use the exact close-pending-recording payload in details.nextActions; any WebM left by close is abandoned/unverified."
		: "An active recording remains open. Use the exact stop-pending-recording payload in details.nextActions before leaving this session.";
	const firstText = result.content.findIndex((item) => item.type === "text");
	const content = result.content.map((item, index) =>
		index === firstText && item.type === "text"
			? { ...item, text: `${item.text}\n\n${notice}` }
			: item,
	);
	if (firstText < 0) {
		content.push({ type: "text", text: notice });
	}
	return { ...result, content, details: { ...details, nextActions } };
}

function recordingStepCommand(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const tokens: unknown[] = value;
	return tokens.every((token): token is string => typeof token === "string") ? tokens : undefined;
}
interface RecordingBatchAccess {
	readonly active: ReadonlyMap<string, ActiveRecordingReservation>;
	readonly retire: (sessionName: string, namespace?: string, retireManifest?: boolean) => void;
	readonly retireManifest: (sessionName: string, namespace?: string) => void;
	readonly applyArtifacts: (artifacts: readonly FileArtifactMetadata[]) => void;
}
class RecordingBatchFold {
	readonly handled = new Set<string>();
	sessionClosed = false;
	constructor(
		readonly registry: RecordingBatchAccess,
		readonly sessionName: string | undefined,
		readonly namespace: string | undefined,
	) {}

	closeRow(step: Readonly<Record<string, unknown>>, command: string | undefined): boolean {
		if (
			step.success !== true ||
			command === undefined ||
			command === "" ||
			!isCloseCommand(command) ||
			this.sessionName === undefined ||
			this.sessionName === ""
		) {
			return false;
		}
		this.registry.retire(this.sessionName, this.namespace, false);
		this.handled.add(getAgentBrowserSessionIdentityKey(this.sessionName, this.namespace));
		this.sessionClosed = true;
		return true;
	}

	apply(step: unknown): void {
		if (!isRecord(step)) {
			return;
		}
		const command = recordingStepCommand(step.command);
		const name = command ? extractUpstreamCommandTokens(command)[0] : undefined;
		if (this.closeRow(step, name)) {
			return;
		}
		if (this.sessionClosed && name === "record") {
			return;
		}
		if (step.success === true && this.sessionClosed) {
			this.sessionClosed = false;
		}
		const artifacts = Array.isArray(step.artifacts)
			? step.artifacts.filter(isResultFileArtifact)
			: [];
		this.registry.applyArtifacts(artifacts);
	}

	finish(): Set<string> {
		for (const key of this.handled) {
			if (
				!this.registry.active.has(key) &&
				this.sessionName !== undefined &&
				this.sessionName !== ""
			) {
				this.registry.retireManifest(this.sessionName, this.namespace);
			}
		}
		return this.handled;
	}
}
