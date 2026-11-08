import type {
	ProcessBrowserOutputInput,
	PreparedBrowserRun,
	BrowserRunState,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
} from "./types.js";
import type { NativeOutputPhase } from "./process-output-native-phase-contracts.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import { observeNativeWebMcp } from "../../webmcp-observation.js";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { needsManagedSession } from "../../command-policy.js";
import { getAgentBrowserSessionIdentityKey, getBooleanFlagValue } from "../../argv-grammar.js";
import { parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { isRecord } from "../../parsing.js";
import { getUpstreamEffectiveBatchSteps, resolveIndexedBatchCommands } from "../batch-stdin.js";
import { getPersistentSessionArtifactStore } from "./session-state.js";
import { repairScreenshotData } from "./prepare.js";
import { recoverRecordingStop } from "./recording-recovery.js";
import { isStringArray } from "../../results/presentation/content.js";

type ParseNativeOutputInput = Readonly<Pick<NativeOutputPhase, "artifactManifest">> & {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			"artifactRunStartedAtMs" | "ctx" | "cwd" | "processResult" | "signal"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"commandTokens" | "executionPlan" | "processArgs" | "runtimeToolArgs" | "runtimeToolStdin"
			>
		>;
		readonly state: BrowserRunState;
	};
};
type RepairOutputScreenshotsInput = Readonly<Pick<NativeOutputPhase, "presentationEnvelope">> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "preparedArgs">>;
	};
};
type ResolveDispatchedCommandsInput = Readonly<Pick<NativeOutputPhase, "presentationEnvelope">> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "commandTokens" | "executionPlan" | "runtimeToolStdin">
		>;
	};
};

export async function parseNativeOutput(
	draft: ParseNativeOutputInput,
): Promise<
	Pick<
		NativeOutputPhase,
		| "persistentArtifactStore"
		| "plainTextUpgrade"
		| "textOutput"
		| "parsed"
		| "parseError"
		| "recordingStopRecovery"
		| "presentationEnvelope"
	>
> {
	const persistentArtifactStore = getPersistentSessionArtifactStore(draft.input.ctx);
	const plainTextUpgrade =
		!draft.input.prepared.executionPlan.plainTextInspection &&
		draft.input.prepared.executionPlan.commandInfo.command === "upgrade" &&
		!needsManagedSession(parseArgvDescriptor(draft.input.prepared.runtimeToolArgs));
	const textOutput = getBooleanFlagValue(draft.input.prepared.processArgs, "--json") === false;
	const raw = await parseAgentBrowserEnvelope({
		stdout: draft.input.processResult.stdout,
		stdoutPath: draft.input.processResult.stdoutSpillPath,
		plainText: plainTextUpgrade,
		textOutput,
	});
	const parsed = {
		...raw,
		envelope: resolveIndexedBatchCommands(
			raw.envelope,
			draft.input.prepared.commandTokens,
			draft.input.prepared.runtimeToolStdin,
		),
	};
	observeNativeWebMcp(parsed.envelope?.data);
	const recordingStopRecovery = await recoverRecordingStop({
		artifactManifest: draft.artifactManifest,
		artifactRunStartedAtMs: draft.input.artifactRunStartedAtMs,
		commandTokens: draft.input.prepared.commandTokens,
		cwd: draft.input.cwd,
		envelope: parsed.envelope,
		namespace: draft.input.prepared.executionPlan.namespace,
		parseError: parsed.parseError,
		processResult: draft.input.processResult,
		reservation:
			draft.input.prepared.executionPlan.sessionName !== undefined &&
			draft.input.prepared.executionPlan.sessionName.length > 0
				? draft.input.state.activeRecordingReservations?.get(
						getAgentBrowserSessionIdentityKey(
							draft.input.prepared.executionPlan.sessionName,
							draft.input.prepared.executionPlan.namespace,
						),
					)
				: undefined,
		sessionName: draft.input.prepared.executionPlan.sessionName,
		signal: draft.input.signal,
		stdin: draft.input.prepared.runtimeToolStdin,
	});
	return {
		persistentArtifactStore,
		plainTextUpgrade,
		textOutput,
		parsed,
		parseError: parsed.parseError,
		recordingStopRecovery,
		presentationEnvelope: recordingStopRecovery?.envelope ?? parsed.envelope,
	};
}

export async function repairOutputScreenshots(
	draft: RepairOutputScreenshotsInput,
): Promise<
	Pick<
		NativeOutputPhase,
		"presentationEnvelope" | "screenshotArtifactRequest" | "batchScreenshotArtifactRequests"
	>
> {
	const repairedScreenshot = await repairScreenshotArtifact({
		cwd: draft.input.cwd,
		envelope: draft.presentationEnvelope,
		request: draft.input.prepared.preparedArgs.screenshotPathRequest,
	});
	const repairedBatchScreenshots = await repairBatchScreenshotArtifacts({
		cwd: draft.input.cwd,
		envelope: repairedScreenshot.envelope,
		requests: draft.input.prepared.preparedArgs.batchScreenshotPathRequests,
	});
	return {
		presentationEnvelope: repairedBatchScreenshots.envelope,
		screenshotArtifactRequest: repairedScreenshot.request,
		batchScreenshotArtifactRequests: repairedBatchScreenshots.requests,
	};
}

export function resolveDispatchedCommands(
	draft: ResolveDispatchedCommandsInput,
): Pick<NativeOutputPhase, "batchCommandSteps" | "dispatchedCommands"> {
	const batchCommandSteps =
		draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? getUpstreamEffectiveBatchSteps(
					draft.input.prepared.commandTokens,
					draft.input.prepared.runtimeToolStdin,
				)
			: [];
	if (draft.input.prepared.executionPlan.commandInfo.command !== "batch") {
		return { batchCommandSteps, dispatchedCommands: [draft.input.prepared.commandTokens] };
	}
	const data: unknown = draft.presentationEnvelope?.data;
	if (!Array.isArray(data)) {
		return { batchCommandSteps, dispatchedCommands: batchCommandSteps };
	}
	const dispatchedCommands = data.flatMap((row: unknown, index) => {
		if (!isRecord(row)) {
			return [];
		}
		const command = isStringArray(row.command) ? row.command : (batchCommandSteps[index] ?? []);
		return [command];
	});
	return { batchCommandSteps, dispatchedCommands };
}

async function repairScreenshotArtifact(options: {
	readonly cwd: string;
	readonly envelope?: Readonly<AgentBrowserEnvelope> | undefined;
	readonly request?: ScreenshotPathRequest | undefined;
}): Promise<{
	envelope?: AgentBrowserEnvelope | undefined;
	request?: ScreenshotArtifactRequest | undefined;
}> {
	const { cwd, envelope, request } = options;
	if (!request || !envelope || !isRecord(envelope.data)) {
		return { envelope, request };
	}
	const repaired = await repairScreenshotData({ cwd, data: envelope.data, request });
	return { envelope: { ...envelope, data: repaired.data }, request: repaired.request };
}

async function repairBatchScreenshotArtifacts(options: {
	readonly cwd: string;
	readonly envelope?: Readonly<AgentBrowserEnvelope> | undefined;
	readonly requests?: readonly (ScreenshotPathRequest | undefined)[] | undefined;
}): Promise<{
	envelope?: AgentBrowserEnvelope | undefined;
	readonly requests?: readonly (ScreenshotArtifactRequest | undefined)[] | undefined;
}> {
	const { cwd, envelope, requests } = options;
	if (
		!envelope ||
		!Array.isArray(envelope.data) ||
		!(requests?.some((request) => request !== undefined) === true)
	) {
		return { envelope, requests };
	}
	const repairedRequests: Array<ScreenshotArtifactRequest | undefined> = [];
	const repairedData = await Promise.all(
		envelope.data.map(async (item: unknown, index) => {
			const request = requests[index];
			if (!request || !isRecord(item) || !isRecord(item.result)) {
				return item;
			}
			const repaired = await repairScreenshotData({ cwd, data: item.result, request });
			repairedRequests[index] = repaired.request;
			return { ...item, result: repaired.data };
		}),
	);
	return { envelope: { ...envelope, data: repairedData }, requests: repairedRequests };
}
