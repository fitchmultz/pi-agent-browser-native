import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import { isRecord } from "../../parsing.js";
import { buildAgentBrowserNextActions } from "../action-recommendations.js";
import { formatSessionArtifactRetentionSummary } from "../artifact-manifest.js";
import type {
	AgentBrowserBatchResult,
	SessionArtifactManifest,
	ToolPresentation,
} from "../contracts.js";
import { applyNetworkRouteRecords } from "../network-routes.js";
import {
	appendUniqueAgentBrowserNextActions,
	applyNamespaceToNextActions,
} from "../next-actions.js";
import {
	buildArtifactVerificationSummary,
	classifyPresentationSuccessCategory,
	manifestHasNewNoticeWorthyEntries,
} from "./artifacts.js";
import { getPresentationImages, getPresentationPaths, isStringArray } from "./content.js";
import { buildBatchStepPresentation } from "./batch-step.js";
import { coalesceTerminalBatchRecordingArtifacts } from "./batch-recording.js";
import {
	buildBatchPageChangeSummary,
	formatBatchStatusText,
	serializeBatchData,
	summarizeBatchStatus,
} from "./batch-summary.js";
import type { BatchPresentedStep, BuildBatchPresentationOptions } from "./batch-contracts.js";
import type { BatchPresentedStepObservation } from "./observation-contracts.js";

export type { BuildNestedToolPresentationOptions } from "./batch-contracts.js";
export { redactBatchStepErrorData } from "./batch-redaction.js";

export function isAgentBrowserBatchResultArray(
	value: unknown,
): value is readonly AgentBrowserBatchResult[] {
	return (
		Array.isArray(value) &&
		value.every(
			(row: unknown) =>
				isRecord(row) &&
				(row.command === undefined || isStringArray(row.command)) &&
				(row.index === undefined ||
					(typeof row.index === "number" && Number.isSafeInteger(row.index) && row.index >= 0)) &&
				(row.success === undefined || typeof row.success === "boolean"),
		)
	);
}

async function collectPresentedSteps(options: BuildBatchPresentationOptions): Promise<{
	readonly steps: readonly BatchPresentedStep[];
	readonly manifest?: SessionArtifactManifest;
}> {
	const steps: BatchPresentedStep[] = [];
	const protectedPaths: string[] = [];
	let manifest = options.artifactManifest;
	let routes = options.networkRoutes;
	for (const [index, item] of options.data.entries()) {
		// Each row updates artifact protection/manifest and route state required by the following row.
		// oxlint-disable-next-line no-await-in-loop
		const step = await buildBatchStepPresentation({
			modelVisible: options.modelVisible,
			artifactManifest: manifest,
			artifactMaxUpdatedAtMs: options.artifactMaxUpdatedAtMs,
			artifactMinUpdatedAtMs: options.artifactMinUpdatedAtMs,
			artifactRequest: options.artifactRequests?.[index],
			buildNestedToolPresentation: options.buildNestedToolPresentation,
			cwd: options.cwd,
			index,
			item,
			piCleanupOwnership: options.piCleanupOwnership,
			namespace: options.namespace,
			networkRoutes: routes,
			persistentArtifactStore: options.persistentArtifactStore
				? { ...options.persistentArtifactStore, protectedPaths }
				: undefined,
			sessionName: options.sessionName,
		});
		steps.push(step);
		manifest = step.presentation.artifactManifest ?? manifest;
		routes = applyNetworkRouteRecords(
			routes,
			isStringArray(item.command) ? extractUpstreamCommandTokens(item.command) : undefined,
			item.success !== false && step.details.success,
		);
		protectedPaths.push(
			...getPresentationPaths({
				primaryPath: step.presentation.fullOutputPath,
				secondaryPaths: step.presentation.fullOutputPaths,
			}),
		);
	}
	return { steps, manifest };
}

export async function buildBatchPresentation(
	options: BuildBatchPresentationOptions,
): Promise<ToolPresentation> {
	const { steps, manifest } = await collectPresentedSteps(options);
	const status = summarizeBatchStatus(steps, options.summary);
	const artifacts = await coalesceTerminalBatchRecordingArtifacts(
		steps,
		options.sessionName,
		options.namespace,
	);
	const artifactVerification = buildArtifactVerificationSummary(artifacts);
	const paths = collectBatchOutputPaths(steps);
	const text = formatBatchStatusText(steps, status, options.modelVisible);
	const artifactRetentionSummary = manifest
		? formatSessionArtifactRetentionSummary(manifest)
		: undefined;
	const contentText = addRetentionNotice(
		text,
		artifactRetentionSummary,
		options.artifactManifest,
		manifest,
	);
	const lifecycleActions = applyNamespaceToNextActions(
		buildAgentBrowserNextActions({
			artifacts,
			command: "batch",
			resultCategory: status.failure ? "failure" : "success",
			sessionName: options.sessionName,
		}),
		options.namespace,
	);
	const nextActions = status.failure
		? appendUniqueAgentBrowserNextActions(
				[...(status.failure.failedStep.nextActions ?? [])],
				lifecycleActions,
			)
		: lifecycleActions;
	return {
		artifactManifest: manifest,
		artifactRetentionSummary,
		artifactVerification,
		artifacts: artifacts.length > 0 ? artifacts : undefined,
		batchFailure: status.failure,
		batchSteps: steps.map((step) => step.details),
		content:
			options.modelVisible === false
				? []
				: [
						{ type: "text", text: contentText },
						...steps.flatMap((step) => getPresentationImages(step.presentation)),
					],
		failureCategory: status.failure?.failedStep.failureCategory,
		data: serializeBatchData(steps),
		...paths,
		imageObservations: steps.flatMap((step) => step.presentation.imageObservations ?? []),
		nextActions,
		pageChangeSummary: buildBatchPageChangeSummary(steps, artifacts, nextActions, status.summary),
		resultCategory: status.failure ? "failure" : "success",
		successCategory: status.failure
			? undefined
			: classifyPresentationSuccessCategory({ artifactVerification, artifacts }),
		summary: status.summary,
	};
}

function collectBatchOutputPaths(steps: readonly BatchPresentedStepObservation[]): {
	readonly fullOutputPath?: string;
	readonly fullOutputPaths?: readonly string[];
	readonly imagePath?: string;
	readonly imagePaths?: readonly string[];
} {
	const fullOutputPaths = steps.flatMap((step) =>
		getPresentationPaths({
			primaryPath: step.presentation.fullOutputPath,
			secondaryPaths: step.presentation.fullOutputPaths,
		}),
	);
	const imagePaths = steps.flatMap((step) =>
		getPresentationPaths({
			primaryPath: step.presentation.imagePath,
			secondaryPaths: step.presentation.imagePaths,
		}),
	);
	return {
		fullOutputPath: fullOutputPaths.at(0),
		fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
		imagePath: imagePaths.at(0),
		imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
	};
}

function addRetentionNotice(
	text: string,
	notice: string | undefined,
	original: SessionArtifactManifest | undefined,
	current: SessionArtifactManifest | undefined,
): string {
	return notice !== undefined &&
		notice.length > 0 &&
		manifestHasNewNoticeWorthyEntries(original, current)
		? `${text}\n\n${notice}`
		: text;
}
