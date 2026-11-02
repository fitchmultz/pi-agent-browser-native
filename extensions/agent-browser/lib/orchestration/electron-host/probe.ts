import { inspectElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes/types.js";
import { getPageTargetValidationError } from "../../page-target-validation.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { normalizeProcessError } from "../../process-errors.js";
import {
	getSessionPageStateKey,
	normalizeSessionTabTarget,
	type SessionPageState,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { buildElectronHostFailureResult } from "../browser-run/final-result.js";
import {
	buildElectronSessionMismatch,
	findElectronLaunchRecordForSession,
} from "../browser-run/session-state.js";
import type { AgentBrowserToolResult, ElectronManagedSessionTarget } from "../browser-run/types.js";
import type {
	ElectronHostObservationInput,
	ElectronManagedSessionPolicy,
	ElectronProbeContext,
	ElectronProbeResult,
} from "./contracts.js";
import {
	ElectronManagedSessionPolicyError,
	withOwnedElectronManagedSessionPolicy,
} from "./policy.js";
import { collectElectronProbe } from "./probe-collection.js";
import { buildElectronProbeResult } from "./probe-presentation.js";

type ProbeInput = Pick<
	ElectronHostObservationInput,
	| "cwd"
	| "electronLaunchRecords"
	| "managedSessionName"
	| "managedSessionNamespace"
	| "managedSessionActive"
	| "sessionPageState"
	| "ownedManagedSessions"
	| "managedSessionRestoreState"
	| "signal"
>;
type CompiledProbe = Extract<CompiledAgentBrowserElectron, { action: "probe" }>;
interface ProbeIdentity {
	readonly record?: ElectronLaunchRecord;
	readonly namespace?: string;
	readonly sessionName: string;
}
function resolveLaunchProbe(
	record: ElectronLaunchRecord | undefined,
	launchId: string,
): ProbeIdentity | { readonly error: string } {
	if (!record) {
		return { error: `No wrapper-tracked Electron launch found for launchId ${launchId}.` };
	}
	if (record.sessionName === undefined || record.sessionName.length === 0) {
		return {
			error: `electron.probe launchId ${launchId} has no attached managed sessionName; reattach with connect or run electron.launch again.`,
		};
	}
	return { record, namespace: record.namespace, sessionName: record.sessionName };
}
function resolveProbeIdentity(
	options: Pick<
		ProbeInput,
		| "electronLaunchRecords"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "managedSessionActive"
	>,
	input: CompiledProbe,
): ProbeIdentity | { readonly error: string } {
	if (input.launchId !== undefined && input.launchId.length > 0) {
		return resolveLaunchProbe(options.electronLaunchRecords.get(input.launchId), input.launchId);
	}
	const record = findElectronLaunchRecordForSession(
		options.managedSessionName,
		options.electronLaunchRecords,
		options.managedSessionNamespace,
	);
	if (!options.managedSessionActive) {
		return {
			error:
				"electron.probe requires an active attached session. Run electron.launch or connect to an Electron debug port first.",
		};
	}
	if (options.managedSessionName.length === 0) {
		return { error: "electron.probe could not resolve a managed session to inspect." };
	}
	return {
		record,
		namespace: options.managedSessionNamespace,
		sessionName: options.managedSessionName,
	};
}
function probeContext(
	identity: ProbeIdentity,
	input: CompiledProbe,
	probe: ElectronProbeResult,
): ElectronProbeContext {
	const explicit = input.launchId !== undefined && input.launchId.length > 0;
	let note: string | undefined;
	if (!identity.record) {
		note = "No wrapper-tracked Electron launch matched this current managed session.";
	} else if (
		!explicit &&
		identity.record.sessionName !== undefined &&
		identity.record.sessionName.length > 0 &&
		identity.record.sessionName !== probe.sessionName
	) {
		note = `single active Electron launch ${identity.record.launchId} uses wrapper session ${identity.record.sessionName}; pass electron.probe.launchId to inspect that launch session directly.`;
	}
	return {
		launchId: identity.record?.launchId,
		mode: explicit ? "launchId" : "current-managed-session",
		note,
		sessionName: probe.sessionName,
	};
}
function probePageTarget(
	probe: Pick<ElectronProbeResult, "title" | "url" | "activeTab" | "refSnapshot">,
): SessionTabTarget | undefined {
	const { title, url, activeTab, refSnapshot } = probe;
	const snapshotTarget = refSnapshot?.target;
	return normalizeSessionTabTarget({
		title: title ?? activeTab?.title ?? snapshotTarget?.title,
		url: url ?? activeTab?.url ?? snapshotTarget?.url,
	});
}
function publishProbePageState(
	state: SessionPageState,
	probe: ElectronProbeResult,
	namespace: string | undefined,
): SessionTabTarget | undefined {
	const target = probePageTarget(probe);
	const update = state.beginUpdate();
	const key = getSessionPageStateKey(probe.sessionName, namespace) ?? probe.sessionName;
	if (target) {
		state.applyTabTarget({ sessionName: key, target, update });
	}
	if (probe.refSnapshot) {
		state.applyRefSnapshot({
			fallbackTarget: target,
			sessionName: key,
			snapshot: probe.refSnapshot,
			update,
		});
	}
	return target;
}
function resolveProbePolicy(
	options: Pick<
		ProbeInput,
		"cwd" | "sessionPageState" | "ownedManagedSessions" | "managedSessionRestoreState" | "signal"
	>,
	identity: ProbeIdentity,
	timeoutMs: number | undefined,
): ElectronManagedSessionPolicy {
	const key =
		getSessionPageStateKey(identity.sessionName, identity.namespace) ?? identity.sessionName;
	const pageState = options.sessionPageState.get(key);
	const targetError = getPageTargetValidationError({
		args: ["snapshot", "-i"],
		currentPageUrl: pageState.tabTarget?.url,
		pageUrlUnknown: pageState.tabTargetUnknown === true,
	});
	if (targetError !== undefined && targetError.length > 0) {
		throw new ElectronManagedSessionPolicyError(targetError);
	}
	const owner = options.ownedManagedSessions.get(key);
	return {
		cwd: options.cwd,
		namespace: identity.namespace,
		sessionName: identity.sessionName,
		signal: options.signal,
		timeoutMs,
		confirmActions:
			pageState.confirmActions ?? getAgentBrowserProcessEnvironment().AGENT_BROWSER_CONFIRM_ACTIONS,
		electronLaunchRecord: identity.record,
		headedManagedAutosaveDisabled: owner?.headedManagedAutosaveDisabled === true,
		headedManagedAutosaveInterval: owner?.headedManagedAutosaveInterval,
		restoreState: options.managedSessionRestoreState,
	};
}
async function inspectProbeIdentity(
	options: Pick<
		ProbeInput,
		"cwd" | "sessionPageState" | "ownedManagedSessions" | "managedSessionRestoreState" | "signal"
	>,
	identity: ProbeIdentity,
	input: CompiledProbe,
	visibleInput: CompiledAgentBrowserElectron,
): Promise<AgentBrowserToolResult> {
	const policy = resolveProbePolicy(options, identity, input.timeoutMs);
	const [status, probe] = await Promise.all([
		identity.record ? inspectElectronLaunchStatus(identity.record) : undefined,
		withOwnedElectronManagedSessionPolicy({ ...policy, args: ["snapshot", "-i"] }, () =>
			collectElectronProbe(policy),
		),
	]);
	const managedSession: ElectronManagedSessionTarget = {
		sessionName: probe.sessionName,
		title: probe.title ?? probe.activeTab?.title,
		url: probe.url ?? probe.activeTab?.url,
	};
	const mismatch =
		identity.record && status
			? buildElectronSessionMismatch({
					managedSession,
					record: identity.record,
					statusTargets: status.targets,
				})
			: undefined;
	const context = probeContext(identity, input, probe);
	const target = publishProbePageState(options.sessionPageState, probe, identity.namespace);
	return buildElectronProbeResult({
		compiledElectron: visibleInput,
		headedManagedAutosaveDisabled: policy.headedManagedAutosaveDisabled,
		headedManagedAutosaveInterval: policy.headedManagedAutosaveInterval,
		mismatch,
		namespace: identity.namespace,
		probe,
		probeContext: context,
		record: identity.record,
		sessionTabTarget: target,
		status,
	});
}
export async function probeElectronHost(
	options: ProbeInput,
	compiledElectron: CompiledProbe,
	visibleInput: CompiledAgentBrowserElectron,
): Promise<AgentBrowserToolResult> {
	const identity = resolveProbeIdentity(options, compiledElectron);
	if ("error" in identity) {
		return buildElectronHostFailureResult({
			compiledElectron: visibleInput,
			errorText: identity.error,
			failureCategory: "validation-error",
		});
	}
	try {
		return await inspectProbeIdentity(options, identity, compiledElectron, visibleInput);
	} catch (error) {
		const errorText = normalizeProcessError(error).message;
		return buildElectronHostFailureResult({
			compiledElectron: visibleInput,
			errorText: `Electron probe failed: ${errorText}`,
			failureCategory:
				error instanceof ElectronManagedSessionPolicyError ? "validation-error" : "upstream-error",
		});
	}
}
