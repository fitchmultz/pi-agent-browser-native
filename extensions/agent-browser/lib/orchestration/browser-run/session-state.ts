import { getSessionPageStateKey } from "../../session-page-state.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { BrowserRunContext } from "./types.js";

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
	buildNativeBrowserRelaunchRecoveryHint,
	extractNativeBrowserRelaunch,
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
