import type {
	AboutBlankSessionMismatch,
	ClickDispatchDiagnostic,
	ComboboxFocusDiagnostic,
	ElectronBroadGetTextScopeDiagnostic,
	ElectronRefFreshnessDiagnostic,
	FillVerificationDiagnostic,
	NavigationSummary,
	OverlayBlockerDiagnostic,
	PreparedBrowserRun,
	ProcessBrowserOutputInput,
	RecordingDependencyWarning,
	ScrollNoopDiagnostic,
	SelectorTextVisibilityDiagnostic,
} from "./types.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type {
	AgentBrowserEnvelope,
	NetworkRouteDiagnostic,
	NetworkRouteRecord,
} from "../../results/contracts.js";
import type { SessionTabTarget } from "../../session-page-state.js";
import type { OpenResultTabCorrection } from "../../runtime-contracts.js";
import {
	applyNetworkRouteRecords,
	buildNetworkRouteDiagnostics,
} from "../../results/network-routes.js";
import { buildElectronRefFreshnessDiagnostic } from "./session-state.js";
import {
	buildScrollNoopDiagnostic,
	collectComboboxFocusDiagnostic,
	collectElectronBroadGetTextScopeDiagnostics,
	collectFillVerificationDiagnostic,
	collectOverlayBlockerDiagnostic,
	collectSnapshotOverlayBlockerDiagnostic,
	collectRecordingDependencyWarning,
	collectScrollPositionSnapshot,
	collectSelectorTextVisibilityDiagnostics,
} from "./diagnostics.js";

export interface PageDiagnostics {
	readonly comboboxFocusDiagnostic?: ComboboxFocusDiagnostic | undefined;
	readonly electronBroadGetTextScopeDiagnostics: readonly ElectronBroadGetTextScopeDiagnostic[];
	readonly electronRefFreshnessDiagnostic?: ElectronRefFreshnessDiagnostic | undefined;
	readonly fillVerificationDiagnostic?: FillVerificationDiagnostic | undefined;
	readonly networkRouteDiagnostics?: readonly NetworkRouteDiagnostic[] | undefined;
	readonly overlayBlockerDiagnostic?: OverlayBlockerDiagnostic | undefined;
	readonly recordingDependencyWarning?: RecordingDependencyWarning | undefined;
	readonly scrollNoopDiagnostic?: ScrollNoopDiagnostic | undefined;
	readonly selectorTextVisibilityDiagnostics: readonly SelectorTextVisibilityDiagnostic[];
}

interface DiagnosticInputs {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "compiledSemanticAction"
				| "executionPlan"
				| "priorRefSnapshotState"
				| "priorSessionTabTarget"
				| "resolvedSemanticActionRefSnapshot"
				| "runtimeToolStdin"
				| "scrollPositionBefore"
				| "shouldProbeScrollNoop"
			>
		>;
		// Native helpers may replace the live launch ledger during earlier awaits.
		readonly state: { readonly electronLaunchRecords: ReadonlyMap<string, ElectronLaunchRecord> };
	};
	readonly aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
	readonly clickDispatchDiagnostic: ClickDispatchDiagnostic | undefined;
	readonly currentSessionTabTarget: SessionTabTarget | undefined;
	readonly electronRecordForCommand: ElectronLaunchRecord | undefined;
	readonly navigationSummary: NavigationSummary | undefined;
	readonly networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	readonly presentationEnvelope: AgentBrowserEnvelope | undefined;
	readonly sessionClosedByCommand: boolean;
	readonly sessionStateKey: string | undefined;
	readonly sessionTabCorrection: OpenResultTabCorrection | undefined;
	readonly succeeded: boolean;
}

export async function collectPageDiagnostics(options: DiagnosticInputs): Promise<{
	readonly diagnostics: PageDiagnostics;
	readonly activeNetworkRoutes: readonly NetworkRouteRecord[] | undefined;
	readonly networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
}> {
	const fillVerificationDiagnostic = await verifyFilledInput(options);
	const electronRefFreshnessDiagnostic = observeElectronRefFreshness(options);
	const overlayBlockerDiagnostic = await observeOverlayBlockers(options);
	const textScope = await observeExtractedTextScope(options);
	const network = observeNetworkRouteEvidence(options);
	const comboboxFocusDiagnostic = await observeComboboxFocus(options);
	const recordingDependencyWarning = await collectRecordingDependencyWarning({
		command: options.input.prepared.executionPlan.commandInfo.command,
		commandTokens: options.input.prepared.commandTokens,
		succeeded: options.succeeded,
	});
	const scrollNoopDiagnostic = await observeScrollMovement(options);
	return {
		diagnostics: {
			fillVerificationDiagnostic,
			electronRefFreshnessDiagnostic,
			overlayBlockerDiagnostic,
			...textScope,
			networkRouteDiagnostics: network.networkRouteDiagnostics,
			comboboxFocusDiagnostic,
			recordingDependencyWarning,
			scrollNoopDiagnostic,
		},
		activeNetworkRoutes: network.activeNetworkRoutes,
		networkRoutesBySession: network.networkRoutesBySession,
	};
}

async function verifyFilledInput(
	options: Pick<DiagnosticInputs, "input" | "electronRecordForCommand" | "succeeded">,
): Promise<FillVerificationDiagnostic | undefined> {
	if (!options.succeeded) {
		return;
	}
	const refSnapshot =
		options.input.prepared.resolvedSemanticActionRefSnapshot ??
		options.input.prepared.priorRefSnapshotState;
	return collectFillVerificationDiagnostic({
		commandTokens: options.input.prepared.commandTokens,
		cwd: options.input.cwd,
		forceValueVerification: options.electronRecordForCommand !== undefined,
		namespace: options.input.prepared.executionPlan.namespace,
		refSnapshot,
		sessionName: options.input.prepared.executionPlan.sessionName,
		signal: options.input.signal,
	});
}

function observeElectronRefFreshness(
	options: Pick<DiagnosticInputs, "input" | "electronRecordForCommand" | "succeeded">,
): ElectronRefFreshnessDiagnostic | undefined {
	if (!options.succeeded || !options.electronRecordForCommand) {
		return;
	}
	return buildElectronRefFreshnessDiagnostic({
		command: options.input.prepared.executionPlan.commandInfo.command,
		commandTokens: options.input.prepared.commandTokens,
		record: options.electronRecordForCommand,
		sessionName: options.input.prepared.executionPlan.sessionName,
		stdin: options.input.prepared.runtimeToolStdin,
	});
}

function overlayProbeHasNoCompetingRecovery(
	options: Pick<
		DiagnosticInputs,
		| "sessionTabCorrection"
		| "aboutBlankSessionMismatch"
		| "electronRecordForCommand"
		| "clickDispatchDiagnostic"
	>,
): boolean {
	return (
		!options.sessionTabCorrection &&
		!options.aboutBlankSessionMismatch &&
		!options.electronRecordForCommand &&
		!options.clickDispatchDiagnostic
	);
}

async function observeOverlayBlockers(
	options: Pick<
		DiagnosticInputs,
		| "input"
		| "succeeded"
		| "presentationEnvelope"
		| "navigationSummary"
		| "sessionTabCorrection"
		| "aboutBlankSessionMismatch"
		| "electronRecordForCommand"
		| "clickDispatchDiagnostic"
	>,
): Promise<OverlayBlockerDiagnostic | undefined> {
	if (!options.succeeded) {
		return;
	}
	const snapshotDiagnostic =
		options.input.prepared.executionPlan.commandInfo.command === "snapshot"
			? collectSnapshotOverlayBlockerDiagnostic(options.presentationEnvelope?.data)
			: undefined;
	if (snapshotDiagnostic || !overlayProbeHasNoCompetingRecovery(options)) {
		return snapshotDiagnostic;
	}
	return collectOverlayBlockerDiagnostic({
		command: options.input.prepared.executionPlan.commandInfo.command,
		cwd: options.input.cwd,
		data: options.presentationEnvelope?.data,
		namespace: options.input.prepared.executionPlan.namespace,
		navigationSummary: options.navigationSummary,
		priorTarget: options.input.prepared.priorSessionTabTarget,
		sessionName: options.input.prepared.executionPlan.sessionName,
		signal: options.input.signal,
	});
}

async function observeExtractedTextScope(
	options: Pick<
		DiagnosticInputs,
		| "input"
		| "succeeded"
		| "presentationEnvelope"
		| "sessionClosedByCommand"
		| "currentSessionTabTarget"
		| "electronRecordForCommand"
	>,
): Promise<
	Pick<
		PageDiagnostics,
		"selectorTextVisibilityDiagnostics" | "electronBroadGetTextScopeDiagnostics"
	>
> {
	if (!options.succeeded) {
		return { selectorTextVisibilityDiagnostics: [], electronBroadGetTextScopeDiagnostics: [] };
	}
	const selectorTextVisibilityDiagnostics = await collectSelectorTextVisibilityDiagnostics({
		commandInfo: options.input.prepared.executionPlan.commandInfo,
		commandTokens: options.input.prepared.commandTokens,
		cwd: options.input.cwd,
		data: options.presentationEnvelope?.data,
		namespace: options.input.prepared.executionPlan.namespace,
		sessionClosedByCommand: options.sessionClosedByCommand,
		sessionName: options.input.prepared.executionPlan.sessionName,
		signal: options.input.signal,
	});
	const electronBroadGetTextScopeDiagnostics = options.electronRecordForCommand
		? collectElectronBroadGetTextScopeDiagnostics({
				commandInfo: options.input.prepared.executionPlan.commandInfo,
				commandTokens: options.input.prepared.commandTokens,
				currentTarget: options.currentSessionTabTarget,
				data: options.presentationEnvelope?.data,
				electronLaunchRecords: options.input.state.electronLaunchRecords,
				namespace: options.input.prepared.executionPlan.namespace,
				priorTarget: options.input.prepared.priorSessionTabTarget,
				sessionName: options.input.prepared.executionPlan.sessionName,
			})
		: [];
	return { selectorTextVisibilityDiagnostics, electronBroadGetTextScopeDiagnostics };
}

function observeNetworkRouteEvidence(
	options: Pick<
		DiagnosticInputs,
		"input" | "succeeded" | "presentationEnvelope" | "sessionStateKey" | "networkRoutesBySession"
	>,
): {
	readonly activeNetworkRoutes: readonly NetworkRouteRecord[] | undefined;
	readonly networkRouteDiagnostics: readonly NetworkRouteDiagnostic[] | undefined;
	readonly networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
} {
	const activeNetworkRoutes =
		options.sessionStateKey !== undefined && options.sessionStateKey.length > 0
			? options.networkRoutesBySession.get(options.sessionStateKey)
			: undefined;
	const plan = options.input.prepared.executionPlan;
	const networkRouteDiagnostics =
		options.succeeded &&
		plan.commandInfo.command === "network" &&
		plan.commandInfo.subcommand === "requests" &&
		plan.sessionName !== undefined &&
		plan.sessionName.length > 0
			? buildNetworkRouteDiagnostics(options.presentationEnvelope?.data, activeNetworkRoutes)
			: undefined;
	const networkRoutesBySession = applyNetworkRouteState({
		commandTokens: options.input.prepared.commandTokens,
		routesBySession: options.networkRoutesBySession,
		sessionName: options.sessionStateKey,
		succeeded: options.succeeded,
	});
	return { activeNetworkRoutes, networkRouteDiagnostics, networkRoutesBySession };
}

async function observeComboboxFocus(
	options: Pick<DiagnosticInputs, "input" | "succeeded">,
): Promise<ComboboxFocusDiagnostic | undefined> {
	if (!options.succeeded) {
		return;
	}
	return collectComboboxFocusDiagnostic({
		command: options.input.prepared.executionPlan.commandInfo.command,
		commandTokens: options.input.prepared.commandTokens,
		cwd: options.input.cwd,
		namespace: options.input.prepared.executionPlan.namespace,
		semanticAction: options.input.prepared.compiledSemanticAction,
		sessionName: options.input.prepared.executionPlan.sessionName,
		signal: options.input.signal,
	});
}

async function observeScrollMovement(
	options: Pick<DiagnosticInputs, "input" | "succeeded">,
): Promise<ScrollNoopDiagnostic | undefined> {
	if (!options.succeeded || !options.input.prepared.shouldProbeScrollNoop) {
		return;
	}
	return buildScrollNoopDiagnostic(
		options.input.prepared.scrollPositionBefore,
		await collectScrollPositionSnapshot({
			cwd: options.input.cwd,
			namespace: options.input.prepared.executionPlan.namespace,
			sessionName: options.input.prepared.executionPlan.sessionName,
			signal: options.input.signal,
		}),
	);
}

export interface NetworkRouteStateInput {
	readonly routes?: readonly NetworkRouteRecord[] | undefined;
	readonly routesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	readonly sessionName: string | undefined;
}
export function setNetworkRouteState(
	options: NetworkRouteStateInput,
): ReadonlyMap<string, readonly NetworkRouteRecord[]> {
	const sessionName = options.sessionName;
	if (sessionName === undefined || sessionName.length === 0) {
		return options.routesBySession;
	}
	if (options.routes === options.routesBySession.get(sessionName)) {
		return options.routesBySession;
	}
	const next = new Map(options.routesBySession);
	if (options.routes && options.routes.length > 0) {
		next.set(sessionName, options.routes);
	} else {
		next.delete(sessionName);
	}
	return next;
}
function applyNetworkRouteState(options: {
	readonly commandTokens: readonly string[];
	readonly routesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	readonly sessionName: string | undefined;
	readonly succeeded: boolean;
}): ReadonlyMap<string, readonly NetworkRouteRecord[]> {
	const sessionName = options.sessionName;
	const routes =
		sessionName !== undefined && sessionName.length > 0
			? applyNetworkRouteRecords(
					options.routesBySession.get(sessionName),
					options.commandTokens,
					options.succeeded,
				)
			: undefined;
	return setNetworkRouteState({ routes, routesBySession: options.routesBySession, sessionName });
}
