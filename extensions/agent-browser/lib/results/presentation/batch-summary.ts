import type { AgentBrowserNextAction } from "../action-contracts.js";
import type { FileArtifactMetadata } from "../artifact-contracts.js";
import type { AgentBrowserBatchResult, AgentBrowserPageChangeSummary } from "../contracts.js";
import type {
	BatchFailurePresentationObservation,
	BatchPresentedStepObservation,
} from "./observation-contracts.js";
import { formatBatchStepsText } from "./batch-rendering.js";
import { buildPageChangeSummary } from "./navigation.js";

export interface BatchStatus {
	readonly failure?: BatchFailurePresentationObservation;
	readonly summary: string;
	readonly header?: string;
	readonly mutationEvidenceText?: string;
}

function getBatchFailure(
	steps: readonly BatchPresentedStepObservation[],
): BatchFailurePresentationObservation | undefined {
	const failed = steps.filter((step) => !step.details.success);
	const first = failed.at(0);
	return first
		? {
				failedStep: first.details,
				failureCount: failed.length,
				successCount: steps.length - failed.length,
				totalCount: steps.length,
			}
		: undefined;
}

function countUnverifiedMutations(steps: readonly BatchPresentedStepObservation[]): number {
	return steps.filter(
		(step) =>
			step.details.pageChangeSummary?.changeType === "mutation" &&
			!step.details.pageChangeSummary.observed,
	).length;
}

export function summarizeBatchStatus(
	steps: readonly BatchPresentedStepObservation[],
	requestedSummary: string,
): BatchStatus {
	const failure = getBatchFailure(steps);
	const summary = failure
		? `Batch failed: ${failure.successCount}/${failure.totalCount} succeeded`
		: requestedSummary;
	const mutations = countUnverifiedMutations(steps);
	return {
		failure,
		summary,
		header: failure
			? [
					summary,
					`First failing step: ${failure.failedStep.index + 1} — ${failure.failedStep.commandText}`,
					failure.failureCount > 1
						? `${failure.failureCount} steps failed. See the per-step results below.`
						: "See the per-step results below.",
				].join("\n")
			: undefined,
		mutationEvidenceText:
			mutations > 0
				? `Mutation evidence: ${mutations} action result${mutations === 1 ? " proves" : "s prove"} dispatch only, not application state change. Use explicit later assertions or external receipts as postconditions; fixed waits are not postconditions.`
				: undefined,
	};
}

export function formatBatchStatusText(
	steps: readonly BatchPresentedStepObservation[],
	status: BatchStatus,
	modelVisible: boolean | undefined,
): string {
	return [
		status.header,
		status.mutationEvidenceText,
		modelVisible === false ? "" : formatBatchStepsText(steps),
	]
		.filter((line) => line !== undefined)
		.join("\n\n");
}

export function serializeBatchData(
	steps: readonly BatchPresentedStepObservation[],
): AgentBrowserBatchResult[] {
	return steps.map(({ details, nativeIndex }) =>
		details.success
			? {
					...batchResultIdentity(details.command, nativeIndex),
					result: details.data,
					success: true,
				}
			: {
					...batchResultIdentity(details.command, nativeIndex),
					error: details.text,
					...(details.command?.[0] === "record" ? { result: details.data } : {}),
					success: false,
				},
	);
}

function batchResultIdentity(
	command: readonly string[] | undefined,
	index: number | undefined,
): Pick<AgentBrowserBatchResult, "command" | "index"> {
	return index === undefined ? { command } : { index };
}

function formatBatchChangeText(observed: number, unverified: number): string {
	if (observed === 0) {
		return `batch → ${unverified} action${unverified === 1 ? "" : "s"} dispatched → application change unverified`;
	}
	return `batch → ${observed} observed change${observed === 1 ? "" : "s"}${unverified > 0 ? `; ${unverified} dispatched action${unverified === 1 ? "" : "s"} unverified` : ""}`;
}

export function buildBatchPageChangeSummary(
	steps: readonly BatchPresentedStepObservation[],
	artifacts: readonly FileArtifactMetadata[],
	nextActions: readonly AgentBrowserNextAction[] | undefined,
	summary: string,
): AgentBrowserPageChangeSummary | undefined {
	if (artifacts.length > 0) {
		return buildPageChangeSummary({
			artifacts,
			commandInfo: { command: "batch" },
			data: serializeBatchData(steps),
			nextActions,
			summary,
		});
	}
	const changed = steps
		.map((step) => step.details)
		.filter((details) => details.pageChangeSummary !== undefined);
	if (changed.length === 0) {
		return undefined;
	}
	const observed = changed.filter((details) => details.pageChangeSummary?.observed === true).length;
	return {
		changeType: "mutation",
		command: "batch",
		nextActionIds: nextActions?.map((action) => action.id),
		observed: observed > 0,
		summary: formatBatchChangeText(observed, countUnverifiedMutations(steps)),
	};
}
