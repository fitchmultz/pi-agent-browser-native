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

type ParseNativeOutputInput = Readonly<Pick<NativeOutputPhase, "artifactManifest">> &
	Pick<
		NativeOutputPhase,
		| "parseError"
		| "parsed"
		| "persistentArtifactStore"
		| "plainTextUpgrade"
		| "presentationEnvelope"
		| "recordingStopRecovery"
		| "textOutput"
	> & {
		readonly input: Readonly<
			Pick<
				ProcessBrowserOutputInput,
				"artifactRunStartedAtMs" | "ctx" | "cwd" | "modelVisible" | "processResult" | "signal"
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
type RepairOutputScreenshotsInput = Pick<
	NativeOutputPhase,
	"batchScreenshotArtifactRequests" | "presentationEnvelope" | "screenshotArtifactRequest"
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "preparedArgs">>;
	};
};
type ResolveDispatchedCommandsInput = Readonly<Pick<NativeOutputPhase, "presentationEnvelope">> &
	Pick<NativeOutputPhase, "batchCommandSteps" | "dispatchedCommands"> & {
		readonly input: {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "commandTokens" | "executionPlan" | "runtimeToolStdin">
			>;
		};
	};

export async function parseNativeOutput(draft: ParseNativeOutputInput): Promise<void> {
	draft.persistentArtifactStore = getPersistentSessionArtifactStore(draft.input.ctx);
	draft.plainTextUpgrade =
		!draft.input.prepared.executionPlan.plainTextInspection &&
		draft.input.prepared.executionPlan.commandInfo.command === "upgrade" &&
		!needsManagedSession(parseArgvDescriptor(draft.input.prepared.runtimeToolArgs));
	draft.textOutput = getBooleanFlagValue(draft.input.prepared.processArgs, "--json") === false;
	draft.parsed = await parseAgentBrowserEnvelope({
		stdout: draft.input.processResult.stdout,
		stdoutPath: draft.input.processResult.stdoutSpillPath,
		plainText: draft.plainTextUpgrade,
		textOutput: draft.textOutput,
	});
	draft.parsed = {
		...draft.parsed,
		envelope: resolveIndexedBatchCommands(
			draft.parsed.envelope,
			draft.input.prepared.commandTokens,
			draft.input.prepared.runtimeToolStdin,
		),
	};
	observeNativeWebMcp(draft.parsed.envelope?.data);
	draft.parseError = draft.parsed.parseError;
	draft.recordingStopRecovery = await recoverRecordingStop({
		modelVisible: draft.input.modelVisible,
		artifactManifest: draft.artifactManifest,
		artifactRunStartedAtMs: draft.input.artifactRunStartedAtMs,
		commandTokens: draft.input.prepared.commandTokens,
		cwd: draft.input.cwd,
		envelope: draft.parsed.envelope,
		namespace: draft.input.prepared.executionPlan.namespace,
		parseError: draft.parseError,
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
	draft.presentationEnvelope = draft.recordingStopRecovery?.envelope ?? draft.parsed.envelope;
}

export async function repairOutputScreenshots(draft: RepairOutputScreenshotsInput): Promise<void> {
	const repairedScreenshot: {
		envelope?: AgentBrowserEnvelope | undefined;
		request?: ScreenshotArtifactRequest | undefined;
	} = await repairScreenshotArtifact({
		cwd: draft.input.cwd,
		envelope: draft.presentationEnvelope,
		request: draft.input.prepared.preparedArgs.screenshotPathRequest,
	});
	draft.presentationEnvelope = repairedScreenshot.envelope;
	const repairedBatchScreenshots: {
		envelope?: AgentBrowserEnvelope | undefined;
		requests?: readonly (ScreenshotArtifactRequest | undefined)[] | undefined;
	} = await repairBatchScreenshotArtifacts({
		cwd: draft.input.cwd,
		envelope: draft.presentationEnvelope,
		requests: draft.input.prepared.preparedArgs.batchScreenshotPathRequests,
	});
	draft.presentationEnvelope = repairedBatchScreenshots.envelope;
	draft.screenshotArtifactRequest = repairedScreenshot.request;
	draft.batchScreenshotArtifactRequests = repairedBatchScreenshots.requests;
}

export function resolveDispatchedCommands(draft: ResolveDispatchedCommandsInput): void {
	draft.batchCommandSteps =
		draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? getUpstreamEffectiveBatchSteps(
					draft.input.prepared.commandTokens,
					draft.input.prepared.runtimeToolStdin,
				)
			: [];
	if (draft.input.prepared.executionPlan.commandInfo.command !== "batch") {
		draft.dispatchedCommands = [draft.input.prepared.commandTokens];
		return;
	}
	const data: unknown = draft.presentationEnvelope?.data;
	if (!Array.isArray(data)) {
		draft.dispatchedCommands = draft.batchCommandSteps;
		return;
	}
	draft.dispatchedCommands = data.flatMap((row: unknown, index) => {
		if (!isRecord(row)) {
			return [];
		}
		const command = isStringArray(row.command)
			? row.command
			: (draft.batchCommandSteps[index] ?? []);
		return [command];
	});
}

async function repairScreenshotArtifact(options: {
	readonly cwd: string;
	readonly envelope?: Readonly<AgentBrowserEnvelope>;
	readonly request?: ScreenshotPathRequest;
}): Promise<{ envelope?: AgentBrowserEnvelope; request?: ScreenshotArtifactRequest }> {
	const { cwd, envelope, request } = options;
	if (!request || !envelope || !isRecord(envelope.data)) {
		return { envelope, request };
	}
	const repaired = await repairScreenshotData({ cwd, data: envelope.data, request });
	return { envelope: { ...envelope, data: repaired.data }, request: repaired.request };
}

async function repairBatchScreenshotArtifacts(options: {
	readonly cwd: string;
	readonly envelope?: Readonly<AgentBrowserEnvelope>;
	readonly requests?: readonly (ScreenshotPathRequest | undefined)[];
}): Promise<{
	envelope?: AgentBrowserEnvelope;
	readonly requests?: readonly (ScreenshotArtifactRequest | undefined)[];
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
