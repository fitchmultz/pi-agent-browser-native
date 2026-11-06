import { isCloseCommand } from "../../command-taxonomy.js";
import { getSessionPageStateKey } from "../../session-page-state.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { BrowserRunContext, TraceOwner } from "./types.js";

export {
	buildManagedSessionOutcome,
	formatManagedSessionOutcomeText,
	buildManagedSessionFreshFailureNextActions,
} from "./session-state-outcomes.js";
export {
	extractNavigationSummaryFromData,
	shouldCaptureNavigationSummary,
	mergeNavigationSummaryIntoData,
	buildAboutBlankRecoveryHint,
	buildAboutBlankWarning,
} from "./session-state-observations.js";
export {
	getStaleRefArgs,
	getGuardedRefUsage,
	buildStaleRefPreflight,
} from "./session-state-refs.js";
export {
	withSessionCommandObservation,
	nativePolicyDefinitelyUnestablished,
	runSessionCommandData,
} from "./session-state-commands.js";
export type { SessionCommandOptions } from "./session-state-commands.js";
export {
	commandChoosesSessionTabTarget,
	shouldPinSessionTabForCommand,
	shouldCorrectSessionTabAfterCommand,
	collectOpenResultTabCorrection,
	collectSessionTabTarget,
	collectSessionTabSelection,
	ensureSessionTabTarget,
	applyOpenResultTabCorrection,
} from "./session-state-tabs.js";
export {
	isLiveElectronRendererTarget,
	getLiveElectronRendererTargets,
	electronTargetLabel,
	getActiveElectronRecords,
	findElectronLaunchRecordForSession,
	buildElectronMismatchNextActions,
	buildElectronSessionMismatch,
	formatElectronSessionMismatchText,
	shouldInspectElectronPostCommandHealth,
	buildElectronLifecycleNextActions,
	buildElectronPostCommandHealthDiagnostic,
	formatElectronPostCommandHealthText,
	buildElectronIdentifiers,
	buildElectronRefFreshnessNextActions,
	buildElectronRefFreshnessDiagnostic,
	formatElectronRefFreshnessText,
} from "./session-state-electron.js";

export const getSessionContextKey = getSessionPageStateKey;

export function buildSessionDetailFields(
	sessionName: string | undefined,
	usedImplicitSession: boolean,
	namespace?: string,
	managedSessionRestoreDisabled = false,
): Record<string, unknown> {
	return {
		...(namespace !== undefined ? { namespace } : {}),
		...((sessionName?.length ?? 0) > 0
			? {
					sessionName,
					usedImplicitSession,
					...(managedSessionRestoreDisabled ? { managedSessionRestoreDisabled: true } : {}),
				}
			: {}),
	};
}

interface TraceOwnerReader {
	readonly get: (sessionName: string) => TraceOwner | undefined;
}
interface TraceOwnerStore extends TraceOwnerReader {
	readonly set: (sessionName: string, owner: TraceOwner) => unknown;
	readonly delete: (sessionName: string) => boolean;
}
interface TraceCommand {
	readonly command: string | undefined;
	readonly sessionName: string | undefined;
	readonly subcommand: string | undefined;
}

function getTraceOwner(command: string | undefined): TraceOwner | undefined {
	return command === "trace" || command === "profiler" ? command : undefined;
}

export function getTraceOwnerGuardMessage(
	options: TraceCommand & { readonly traceOwners: ReadonlyMap<string, TraceOwner> },
): string | undefined {
	const owner = getTraceOwner(options.command);
	const sessionName = options.sessionName;
	if (
		owner === undefined ||
		sessionName === undefined ||
		sessionName.length === 0 ||
		(options.subcommand !== "start" && options.subcommand !== "stop")
	) {
		return;
	}
	const activeOwner = options.traceOwners.get(sessionName);
	if (activeOwner === undefined || activeOwner === owner) {
		return;
	}
	return options.subcommand === "start"
		? `Wrapper believes ${activeOwner} tracing is active for session ${sessionName}; stop ${activeOwner} before starting ${owner}.`
		: `Wrapper believes tracing for session ${sessionName} is owned by ${activeOwner}; run ${activeOwner} stop instead of ${owner} stop.`;
}

export function updateTraceOwnerState(
	options: TraceCommand & { readonly succeeded: boolean; readonly traceOwners: TraceOwnerStore },
): void {
	const sessionName = options.sessionName;
	if (sessionName === undefined || sessionName.length === 0 || !options.succeeded) {
		return;
	}
	if (isCloseCommand(options.command)) {
		options.traceOwners.delete(sessionName);
		return;
	}
	const owner = getTraceOwner(options.command);
	if (owner === undefined) {
		return;
	}
	if (options.subcommand === "start") {
		options.traceOwners.set(sessionName, owner);
	}
	if (options.subcommand === "stop" && options.traceOwners.get(sessionName) === owner) {
		options.traceOwners.delete(sessionName);
	}
}

export function getPersistentSessionArtifactStore(
	ctx: BrowserRunContext,
): PersistentSessionArtifactStore | undefined {
	const sessionDir =
		typeof ctx.sessionManager.getSessionDir === "function"
			? ctx.sessionManager.getSessionDir()
			: undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	return sessionDir !== undefined &&
		sessionDir.length > 0 &&
		sessionId !== undefined &&
		sessionId.length > 0
		? { sessionDir, sessionId }
		: undefined;
}
