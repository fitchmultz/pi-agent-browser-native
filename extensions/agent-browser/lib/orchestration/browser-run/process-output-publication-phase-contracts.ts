import type {
	AboutBlankSessionMismatch,
	ParseFailureOutput,
	ProcessBrowserOutputInput,
	ScreenshotArtifactRequest,
	NavigationSummary,
	OwnStepPageCheck,
	ElectronPostCommandHealthDiagnostic,
	ElectronSessionMismatch,
	ManagedSessionOutcome,
	ElectronHandoffSummary,
	EvalResultWarning,
	EvalStdinHint,
	QaAttachedTarget,
	ArtifactCleanupGuidance,
	PreparedBrowserRun,
	BrowserRunState,
} from "./types.js";
import type {
	AgentBrowserEnvelope,
	NetworkRouteRecord,
	ToolPresentation,
	SessionArtifactManifest,
} from "../../results/contracts.js";
import type {
	SessionRefSnapshot,
	SessionRefSnapshotInvalidation,
	BatchRefSnapshotState,
	SessionTabTarget,
	SessionPageStateView,
} from "../../session-page-state.js";
import type { ReadConfirmation } from "../../read-confirmation.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { RecordingStopRecoveryResult } from "./recording-recovery.js";
import type { OpenResultTabCorrection } from "../../runtime-contracts.js";
import type {
	AgentBrowserQaPresetAnalysis,
	AgentBrowserSourceLookupAnalysis,
	AgentBrowserNetworkSourceLookupAnalysis,
} from "../../input-modes/types.js";
import type { PublicationContent } from "./final-result-contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
export type PublicationOutputEvidence = Readonly<
	Pick<
		PublicationOutputPhase,
		| "artifactCleanup"
		| "artifactManifest"
		| "currentRefSnapshot"
		| "currentRefSnapshotInvalidation"
		| "currentSessionTabTarget"
		| "currentSessionTabTargetUnknown"
		| "evalResultWarning"
		| "evalStdinHint"
		| "managedSessionOutcome"
		| "networkRoutesBySession"
		| "networkSourceLookup"
		| "presentationEnvelope"
		| "qaAttachedTarget"
		| "qaPreset"
		| "readConfirmationEvent"
		| "redactedContent"
		| "resultArtifactManifest"
		| "sourceLookup"
		| "succeeded"
	>
> & { readonly presentation: ToolPresentationObservation };
import type { PageDiagnostics } from "./process-output-diagnostics.js";
// Each publication call owns this render/reclassification state. Borrowed inputs stay readonly;
// helpers receive only their operation's writable outputs and native ownership handles.
export interface PublicationOutputPhase {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			| "artifactRunStartedAtMs"
			| "cwd"
			| "electronProfileIsolationDetails"
			| "operationCwd"
			| "preserveAttachedBrowserSession"
			| "processResult"
			| "sessionPageStateUpdate"
			| "signal"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "compatibilityWorkaround"
				| "compiledNetworkSourceLookup"
				| "compiledQaPreset"
				| "compiledSemanticAction"
				| "compiledSourceLookup"
				| "electronLaunch"
				| "exactSensitiveValues"
				| "executionPlan"
				| "headedLaunch"
				| "ownedManagedSessionContext"
				| "priorRefSnapshotState"
				| "priorSessionTabTarget"
				| "processStdin"
				| "processTimeoutMs"
				| "providerLaunch"
				| "readConfirmation"
				| "redactedArgs"
				| "redactedCompiledElectron"
				| "redactedCompiledJob"
				| "redactedCompiledNetworkSourceLookup"
				| "redactedCompiledQaPreset"
				| "redactedCompiledSemanticAction"
				| "redactedCompiledSourceLookup"
				| "redactedProcessArgs"
				| "redactedRecoveryHint"
				| "runtimeToolArgs"
				| "runtimeToolStdin"
				| "sessionMode"
				| "userRequestedJson"
			>
		>;
	} & { readonly state: BrowserRunState };
	readonly aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
	readonly activeNetworkRoutes: readonly NetworkRouteRecord[] | undefined;
	artifactCleanup: ArtifactCleanupGuidance | undefined;
	artifactManifest: SessionArtifactManifest | undefined;
	authoritativePageState: SessionPageStateView | undefined;
	readonly batchRefSnapshotState: BatchRefSnapshotState | undefined;
	readonly batchScreenshotArtifactRequests:
		| readonly (ScreenshotArtifactRequest | undefined)[]
		| undefined;
	readonly commandClosesSession: boolean;
	readonly confirmationFromHelper: boolean;
	readonly confirmedEffects: readonly {
		readonly command: string;
		readonly data: unknown;
		readonly index: number;
		readonly succeeded: boolean;
	}[];
	currentRefSnapshot: SessionRefSnapshot | undefined;
	currentRefSnapshotInvalidation: SessionRefSnapshotInvalidation | undefined;
	currentSessionTabTarget: SessionTabTarget | undefined;
	currentSessionTabTargetUnknown: true | undefined;
	readonly electronHandoff: ElectronHandoffSummary | undefined;
	readonly electronPostCommandHealth: ElectronPostCommandHealthDiagnostic | undefined;
	readonly electronSessionMismatch: ElectronSessionMismatch | undefined;
	readonly errorText: string | undefined;
	evalResultWarning: EvalResultWarning | undefined;
	evalStdinHint: EvalStdinHint | undefined;
	readonly inspectionText: string | undefined;
	managedSessionOutcome: ManagedSessionOutcome | undefined;
	readonly navigationSummary: NavigationSummary | undefined;
	readonly ownStepPageCheck: OwnStepPageCheck | undefined;
	readonly diagnostics: PageDiagnostics;
	networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	networkSourceLookup: AgentBrowserNetworkSourceLookupAnalysis | undefined;
	readonly operationCwd: string;
	readonly parseError: string | undefined;
	readonly parseFailureOutput: ParseFailureOutput;
	readonly parseSucceeded: boolean;
	readonly persistentArtifactStore: PersistentSessionArtifactStore | undefined;
	readonly plainTextInspection: boolean;
	readonly plainTextUpgrade: boolean;
	presentation: ToolPresentation;
	presentationEnvelope: AgentBrowserEnvelope | undefined;
	readonly processSucceeded: boolean;
	qaAttachedTarget: QaAttachedTarget | undefined;
	qaPreset: AgentBrowserQaPresetAnalysis | undefined;
	readConfirmationEvent: ReadConfirmation | undefined;
	readonly recordingStopRecovery: RecordingStopRecoveryResult | undefined;
	redactedContent: PublicationContent;
	resultArtifactManifest: SessionArtifactManifest | undefined;
	readonly screenshotArtifactRequest: ScreenshotArtifactRequest | undefined;
	readonly sessionStateKey: string | undefined;
	readonly sessionTabCorrection: OpenResultTabCorrection | undefined;
	sourceLookup: AgentBrowserSourceLookupAnalysis | undefined;
	succeeded: boolean;
	readonly textOutput: boolean;
	readonly unobservedMutation: boolean;
}
