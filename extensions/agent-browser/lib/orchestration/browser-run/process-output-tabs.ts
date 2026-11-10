import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { PageOutputPhase } from "./process-output-page-phase-contracts.js";
import { inspectElectronLaunchStatus } from "../../electron/cleanup.js";
import {
	commandExplicitlyTargetsAboutBlank,
	isAboutBlankSessionTabTarget,
	normalizeSessionTabTarget,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import {
	applyOpenResultTabCorrection,
	buildAboutBlankRecoveryHint,
	buildNativeBrowserRelaunchRecoveryHint,
	buildElectronPostCommandHealthDiagnostic,
	buildElectronSessionMismatch,
	collectSessionTabSelection,
	extractNativeBrowserRelaunch,
	findElectronLaunchRecordForSession,
	shouldCorrectSessionTabAfterCommand,
	shouldInspectElectronPostCommandHealth,
} from "./session-state.js";
import { sleepMs } from "./diagnostics.js";

type UnexpectedBlankTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		| "currentSessionTabTarget"
		| "destinationTransition"
		| "dispatchedCommands"
		| "nestedBatchClose"
		| "observedSessionTabTarget"
		| "succeeded"
		| "tabTransition"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "priorSessionTabTarget">>;
	};
};
type InspectBlankElectronMismatchInput = {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
		readonly state: BrowserRunState;
	};
};
type RecoverUnexpectedBlankTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		| "currentSessionTabTarget"
		| "destinationTransition"
		| "dispatchedCommands"
		| "nestedBatchClose"
		| "observedSessionTabTarget"
		| "presentationEnvelope"
		| "succeeded"
		| "tabTransition"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "priorSessionTabTarget" | "sessionTabCorrection">
		>;
		readonly state: BrowserRunState;
	};
};
type NeedsPostCommandPinningInput = Readonly<
	Pick<PageOutputPhase, "aboutBlankSessionMismatch" | "sessionTabCorrection" | "succeeded">
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"commandTokens" | "executionPlan" | "priorSessionTabTarget" | "sessionTabPinningReason"
			>
		>;
	};
};
type PinPostCommandTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		"aboutBlankSessionMismatch" | "observedSessionTabTarget" | "succeeded" | "sessionTabCorrection"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"commandTokens" | "executionPlan" | "priorSessionTabTarget" | "sessionTabPinningReason"
			>
		>;
	};
};
type InspectElectronHealthInput = Readonly<
	Pick<
		PageOutputPhase,
		| "currentSessionTabTarget"
		| "observedSessionTabTarget"
		| "electronStatusAfterCommand"
		| "succeeded"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "electronPostCommandStatusSettleMs">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
		readonly state: BrowserRunState;
	};
};

function unexpectedBlankTarget(draft: UnexpectedBlankTargetInput): boolean {
	const explicitBlank = draft.dispatchedCommands.some((step) =>
		commandExplicitlyTargetsAboutBlank(extractUpstreamCommandTokens(step)),
	);
	return (
		draft.succeeded &&
		!draft.tabTransition &&
		!draft.destinationTransition &&
		!explicitBlank &&
		draft.nestedBatchClose === undefined &&
		draft.input.prepared.priorSessionTabTarget !== undefined &&
		!isAboutBlankSessionTabTarget(draft.input.prepared.priorSessionTabTarget) &&
		isAboutBlankSessionTabTarget(draft.observedSessionTabTarget ?? draft.currentSessionTabTarget)
	);
}

async function inspectBlankElectronMismatch(
	draft: InspectBlankElectronMismatchInput,
	observed: SessionTabTarget | undefined,
): Promise<
	Pick<PageOutputPhase, "electronStatusAfterCommand" | "electronSessionMismatch"> | undefined
> {
	const { prepared, state } = draft.input;
	const record = findElectronLaunchRecordForSession(
		prepared.executionPlan.sessionName,
		state.electronLaunchRecords,
		prepared.executionPlan.namespace,
	);
	const sessionName = prepared.executionPlan.sessionName;
	if (!record || sessionName === undefined || sessionName.length === 0) {
		return;
	}
	const electronStatusAfterCommand = await inspectElectronLaunchStatus(record);
	return {
		electronStatusAfterCommand,
		electronSessionMismatch: buildElectronSessionMismatch({
			managedSession: { sessionName, title: observed?.title, url: observed?.url ?? "about:blank" },
			record,
			statusTargets: electronStatusAfterCommand.targets,
		}),
	};
}

export async function recoverUnexpectedBlankTarget(
	draft: RecoverUnexpectedBlankTargetInput,
): Promise<
	Pick<PageOutputPhase, "sessionTabCorrection"> &
		Partial<
			Pick<
				PageOutputPhase,
				| "currentSessionTabTarget"
				| "aboutBlankSessionMismatch"
				| "electronStatusAfterCommand"
				| "electronSessionMismatch"
			>
		>
> {
	const { prepared, cwd, signal } = draft.input;
	const prior = prepared.priorSessionTabTarget;
	if (!unexpectedBlankTarget(draft) || !prior) {
		return { sessionTabCorrection: prepared.sessionTabCorrection };
	}
	const observed = draft.observedSessionTabTarget ?? draft.currentSessionTabTarget;
	const blankTarget = observed ?? normalizeSessionTabTarget({ url: "about:blank" });
	const nativeBrowserRelaunch = extractNativeBrowserRelaunch(draft.presentationEnvelope?.data);
	if (nativeBrowserRelaunch) {
		// The relaunched browser has no prior tab to re-select, so this is not tab drift.
		return {
			sessionTabCorrection: prepared.sessionTabCorrection,
			currentSessionTabTarget: blankTarget,
			aboutBlankSessionMismatch: {
				activeUrl: "about:blank",
				nativeBrowserRelaunch,
				recoveryApplied: false,
				recoveryHint: buildNativeBrowserRelaunchRecoveryHint(nativeBrowserRelaunch),
				targetTitle: prior.title,
				targetUrl: prior.url,
			},
		};
	}
	const correction = await collectSessionTabSelection({
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
		signal,
		target: prior,
	});
	const applied = correction
		? await applyOpenResultTabCorrection({
				correction,
				cwd,
				namespace: prepared.executionPlan.namespace,
				sessionName: prepared.executionPlan.sessionName,
				signal,
			})
		: undefined;
	const currentSessionTabTarget = applied ? prior : blankTarget;
	return {
		sessionTabCorrection: applied ?? prepared.sessionTabCorrection,
		currentSessionTabTarget,
		aboutBlankSessionMismatch: {
			activeUrl: "about:blank",
			recoveryApplied: applied !== undefined,
			recoveryHint: buildAboutBlankRecoveryHint(),
			targetTitle: prior.title,
			targetUrl: prior.url,
		},
		...(await inspectBlankElectronMismatch(draft, observed)),
	};
}

function needsPostCommandPinning(draft: NeedsPostCommandPinningInput): boolean {
	const { prepared } = draft.input;
	return (
		draft.succeeded &&
		prepared.priorSessionTabTarget !== undefined &&
		!draft.sessionTabCorrection &&
		!draft.aboutBlankSessionMismatch &&
		!commandExplicitlyTargetsAboutBlank(prepared.commandTokens) &&
		shouldCorrectSessionTabAfterCommand({
			command: prepared.executionPlan.commandInfo.command,
			pinningRequired: prepared.sessionTabPinningReason !== undefined,
			sessionName: prepared.executionPlan.sessionName,
		})
	);
}

export async function pinPostCommandTarget(
	draft: PinPostCommandTargetInput,
): Promise<PageOutputPhase["sessionTabCorrection"]> {
	const target = draft.observedSessionTabTarget;
	if (!needsPostCommandPinning(draft) || !target) {
		return draft.sessionTabCorrection;
	}
	const { prepared, cwd, signal } = draft.input;
	const correction = await collectSessionTabSelection({
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
		signal,
		target,
	});
	if (!correction) {
		return draft.sessionTabCorrection;
	}
	const applied = await applyOpenResultTabCorrection({
		correction,
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
		signal,
	});
	return applied ?? draft.sessionTabCorrection;
}

export async function inspectElectronHealth(
	draft: InspectElectronHealthInput,
): Promise<
	Pick<PageOutputPhase, "electronRecordForCommand"> &
		Partial<
			Pick<
				PageOutputPhase,
				"electronStatusAfterCommand" | "electronPostCommandHealth" | "succeeded"
			>
		>
> {
	const { prepared, state } = draft.input;
	const record = findElectronLaunchRecordForSession(
		prepared.executionPlan.sessionName,
		state.electronLaunchRecords,
		prepared.executionPlan.namespace,
	);
	if (
		!draft.succeeded ||
		!record ||
		!shouldInspectElectronPostCommandHealth(prepared.executionPlan.commandInfo.command)
	) {
		return { electronRecordForCommand: record };
	}
	let electronStatusAfterCommand =
		draft.electronStatusAfterCommand ?? (await inspectElectronLaunchStatus(record));
	let electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({
		command: prepared.executionPlan.commandInfo.command,
		record,
		status: electronStatusAfterCommand,
		target: draft.observedSessionTabTarget ?? draft.currentSessionTabTarget,
	});
	if (electronPostCommandHealth && electronPostCommandHealth.reason !== "process-dead") {
		await sleepMs(draft.input.electronPostCommandStatusSettleMs);
		electronStatusAfterCommand = await inspectElectronLaunchStatus(record);
		electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({
			command: prepared.executionPlan.commandInfo.command,
			record,
			status: electronStatusAfterCommand,
			target: draft.observedSessionTabTarget ?? draft.currentSessionTabTarget,
		});
	}
	return {
		electronRecordForCommand: record,
		electronStatusAfterCommand,
		electronPostCommandHealth,
		succeeded: electronPostCommandHealth ? false : draft.succeeded,
	};
}
