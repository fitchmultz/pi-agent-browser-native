import { stat } from "node:fs/promises";
import { setTimeout as sleepMs } from "node:timers/promises";
import { isAbsolute, resolve } from "node:path";

import { isCloseCommand } from "../../command-taxonomy.js";
import { executableExistsOnPath } from "../../executable-path.js";
import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import type {
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
} from "../../results/contracts.js";
import { formatSessionArtifactRetentionSummary } from "../../results/artifact-manifest.js";
import {
	buildVisibleRefFallbackDiagnosticFromSnapshot,
	getVisibleRefFallbackTarget,
	type VisibleRefFallbackDiagnostic,
} from "../../results/selector-recovery.js";
import {
	extractStringResultField,
	isAboutBlankUrl,
	normalizeComparableUrl,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { isRecord } from "../../parsing.js";
import { extractNavigationSummaryFromData, runSessionCommandData } from "./session-state.js";
import type {
	ArtifactCleanupGuidance,
	EvalStdinHint,
	EvalResultWarning,
	NavigationSummary,
	RecordingDependencyWarning,
} from "./types.js";

export { redactTimeoutPartialProgress } from "./timeout-progress.js";

export { sleepMs };

interface NavigationObservationOptions {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly priorTarget?: SessionTabTarget | undefined;
	readonly reusePriorTitle?: boolean;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}

function comparePriorNavigationUrl(priorUrl: string | undefined, url: string): boolean | undefined {
	return priorUrl !== undefined && priorUrl !== ""
		? normalizeComparableUrl(priorUrl) !== normalizeComparableUrl(url)
		: undefined;
}

function reusableNavigationTitle(
	options: Pick<NavigationObservationOptions, "priorTarget" | "reusePriorTitle">,
	url: string,
): string | undefined {
	const prior = options.priorTarget;
	return options.reusePriorTitle !== false &&
		prior !== undefined &&
		prior.title !== undefined &&
		prior.title !== "" &&
		normalizeComparableUrl(prior.url) === normalizeComparableUrl(url)
		? prior.title
		: undefined;
}

export async function collectNavigationSummary(
	options: NavigationObservationOptions,
): Promise<NavigationSummary | undefined> {
	const url = extractStringResultField(
		await runSessionCommandData({
			args: ["get", "url"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
		}),
		"url",
	);
	if (url === undefined || url === "" || !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		return undefined;
	}
	const urlChanged = comparePriorNavigationUrl(options.priorTarget?.url, url);
	if (isAboutBlankUrl(url)) {
		return { url, ...(urlChanged !== undefined ? { urlChanged } : {}) };
	}
	// Reuse the title already observed for this exact URL instead of spending a second probe. Titles can
	// change without a URL change on SPAs, but this summary is only a "last observed" page label; the URL
	// stays live-probed on every call.
	const priorTitle = reusableNavigationTitle(options, url);
	if (priorTitle !== undefined) {
		return { title: priorTitle, url, urlChanged: false };
	}
	const title = extractStringResultField(
		await runSessionCommandData({
			args: ["get", "title"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
		}),
		"title",
	);
	return { title, url, ...(urlChanged !== undefined ? { urlChanged } : {}) };
}

export {
	collectScrollPositionSnapshot,
	buildUnsupportedScrollIntoViewRecovery,
	buildScrollNoopDiagnostic,
	buildScrollNoopNextActions,
	formatScrollNoopDiagnosticText,
	collectComboboxFocusDiagnostic,
	buildComboboxFocusNextActions,
	formatComboboxFocusDiagnosticText,
} from "./interaction-diagnostics.js";

function getRecordStartLikeCommand(
	command: string | undefined,
	commandTokens: readonly string[],
): RecordingDependencyWarning["command"] | undefined {
	if (command !== "record") {
		return undefined;
	}
	const subcommand = commandTokens[1]?.toLowerCase();
	if (subcommand === "start") {
		return "record start";
	}
	if (subcommand === "restart") {
		return "record restart";
	}
	return undefined;
}

export async function collectRecordingDependencyWarning(options: {
	readonly command: string | undefined;
	readonly commandTokens: readonly string[];
	readonly succeeded: boolean;
}): Promise<RecordingDependencyWarning | undefined> {
	if (!options.succeeded) {
		return undefined;
	}
	const recordCommand = getRecordStartLikeCommand(options.command, options.commandTokens);
	if (recordCommand === undefined) {
		return undefined;
	}
	if (await executableExistsOnPath("ffmpeg")) {
		return undefined;
	}
	return {
		command: recordCommand,
		dependency: "ffmpeg",
		message: `${recordCommand} reported a pending recording, but ffmpeg is not on PATH. Its output is unverified; install ffmpeg before starting a new recording.`,
		reason: "ffmpeg-missing-for-recording",
		recommendations: [
			"Install ffmpeg before recording; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.",
			"Stop this recording, check the result, and start a new recording after ensuring Pi can find ffmpeg on PATH.",
		],
	};
}

export function formatRecordingDependencyWarningText(
	warning: RecordingDependencyWarning | undefined,
): string | undefined {
	if (!warning) {
		return undefined;
	}
	return [
		"Recording dependency warning: ffmpeg not found on PATH.",
		`Reason: ${warning.message}`,
		...warning.recommendations.map((recommendation) => `- ${recommendation}`),
	].join("\n");
}

export {
	formatOverlayBlockerText,
	buildOverlayBlockerNextActions,
	collectSnapshotOverlayBlockerDiagnostic,
	collectOverlayBlockerDiagnostic,
} from "./overlay-diagnostics.js";

export {
	collectSelectorTextVisibilityDiagnostics,
	formatSelectorTextVisibilityText,
	buildSelectorTextVisibilityNextActions,
} from "./text-visibility-diagnostics.js";
export {
	getSourceLookupElectronContext,
	buildSourceLookupElectronNextActions,
	collectElectronBroadGetTextScopeDiagnostics,
	formatElectronBroadGetTextScopeText,
	buildElectronBroadGetTextScopeNextActions,
} from "./electron-text-diagnostics.js";

function looksLikeFunctionEvalStdin(stdin: string | undefined): boolean {
	const trimmed = stdin?.trim();
	if (trimmed === undefined || trimmed === "") {
		return false;
	}
	return (
		/^(?:async\s+)?function\b/.test(trimmed) ||
		/^(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed) ||
		/^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(trimmed)
	);
}

function isPlainEmptyObject(value: unknown): boolean {
	if (!isRecord(value) || Array.isArray(value)) {
		return false;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

export function getEvalStdinHint(options: {
	readonly command?: string | undefined;
	readonly data: unknown;
	readonly stdin?: string | undefined;
}): EvalStdinHint | undefined {
	if (
		options.command !== "eval" ||
		!looksLikeFunctionEvalStdin(options.stdin) ||
		!isRecord(options.data)
	) {
		return;
	}
	const result = options.data.result;
	if (!isPlainEmptyObject(result)) {
		return;
	}
	return {
		reason:
			"eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
		suggestion:
			"Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
	};
}

export function formatEvalStdinHintText(
	hint: ReturnType<typeof getEvalStdinHint>,
): string | undefined {
	return hint ? `Eval stdin hint: ${hint.reason} ${hint.suggestion}` : undefined;
}

interface EvalResultWarningInput {
	readonly command?: string | undefined;
	readonly data: unknown;
	readonly navigationSummary?: { readonly url?: string | undefined } | undefined;
	readonly pageUrl?: string | undefined;
	readonly stdin?: string | undefined;
}

function localEvalPageUrl(
	options: Pick<EvalResultWarningInput, "pageUrl" | "navigationSummary" | "data">,
): string | undefined {
	const pageUrl =
		options.pageUrl?.trim() ??
		options.navigationSummary?.url?.trim() ??
		extractNavigationSummaryFromData(options.data)?.url;
	return pageUrl !== undefined && pageUrl !== "" && /^file:/i.test(pageUrl) ? pageUrl : undefined;
}

export function getEvalResultWarning(
	options: EvalResultWarningInput,
): EvalResultWarning | undefined {
	const trimmed = options.stdin?.trim();
	if (
		options.command !== "eval" ||
		trimmed === undefined ||
		trimmed === "" ||
		!isRecord(options.data) ||
		options.data.result !== null ||
		/^(?:null|undefined)$/i.test(trimmed) ||
		localEvalPageUrl(options) === undefined
	) {
		return;
	}
	return {
		reason:
			"eval --stdin returned null on a file:// page; upstream may not expose full DOM semantics for local fixtures.",
		suggestion:
			"Treat this as inconclusive verification. Use snapshot -i, get text on current @refs, screenshot evidence, or a reachable http(s) fixture before concluding DOM state.",
	};
}

export function formatEvalResultWarningText(
	warning: ReturnType<typeof getEvalResultWarning>,
): string | undefined {
	return warning ? `Eval result warning: ${warning.reason} ${warning.suggestion}` : undefined;
}

async function collectExistingExplicitArtifactPaths(
	entries: readonly SessionArtifactManifestEntry[],
	cwd: string,
): Promise<string[]> {
	const explicitArtifactPaths: string[] = [];
	const seenPaths = new Set<string>();
	for (const entry of entries) {
		if (explicitArtifactPaths.length >= 10) {
			break;
		}
		const displayPath = entry.path;
		if (seenPaths.has(displayPath)) {
			continue;
		}
		const absolutePath =
			entry.absolutePath ?? (isAbsolute(entry.path) ? entry.path : resolve(cwd, entry.path));
		try {
			// The first ten existing distinct display paths are selected in manifest order.
			await stat(absolutePath);
		} catch {
			continue;
		}
		seenPaths.add(displayPath);
		explicitArtifactPaths.push(displayPath);
	}
	return explicitArtifactPaths;
}

export async function getArtifactCleanupGuidance(options: {
	readonly command?: string | undefined;
	readonly cwd: string;
	readonly manifest?: SessionArtifactManifest | undefined;
	readonly succeeded: boolean;
}): Promise<ArtifactCleanupGuidance | undefined> {
	if (!options.succeeded || !isCloseCommand(options.command) || !options.manifest) {
		return undefined;
	}
	const explicitEntries = options.manifest.entries.filter(
		(entry) => entry.storageScope === "explicit-path",
	);
	if (explicitEntries.length === 0) {
		return undefined;
	}
	const explicitArtifactPaths = await collectExistingExplicitArtifactPaths(
		explicitEntries,
		options.cwd,
	);
	if (explicitArtifactPaths.length === 0) {
		return undefined;
	}
	return {
		explicitArtifactPaths,
		note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.",
		owner: "host-file-tools",
		summary: formatSessionArtifactRetentionSummary(options.manifest),
	};
}

export function formatArtifactCleanupGuidanceText(
	guidance: ArtifactCleanupGuidance | undefined,
): string | undefined {
	if (!guidance || guidance.explicitArtifactPaths.length === 0) {
		return undefined;
	}
	const explicitCount = guidance.explicitArtifactPaths.length;
	return `Artifact lifecycle: ${explicitCount} explicit artifact${explicitCount === 1 ? "" : "s"} remain${explicitCount === 1 ? "s" : ""}; expand or inspect details.artifactCleanup.explicitArtifactPaths for paths. Browser close does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; use host file tools for cleanup.`;
}

export {
	collectElectronManagedSessionTarget,
	collectQaAttachedTarget,
	formatQaAttachedTargetText,
	validateQaAttachedPrecondition,
	collectElectronHandoff,
} from "./electron-observation.js";

export {
	collectFillVerificationDiagnostic,
	buildFillVerificationNextActions,
	formatFillVerificationText,
} from "./fill-diagnostics.js";

export async function collectVisibleRefFallbackDiagnostic(options: {
	readonly commandTokens: readonly string[];
	readonly compiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<VisibleRefFallbackDiagnostic | undefined> {
	if (options.sessionName === undefined || options.sessionName === "") {
		return undefined;
	}
	const target = getVisibleRefFallbackTarget({
		commandTokens: options.commandTokens,
		compiledSemanticAction: options.compiledSemanticAction,
	});
	if (!target) {
		return undefined;
	}
	const snapshotData = await runSessionCommandData({
		args: ["snapshot", "-i"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	return buildVisibleRefFallbackDiagnosticFromSnapshot({ snapshotData, target });
}

export {
	collectTimeoutPartialProgress,
	formatTimeoutPartialProgressText,
} from "./timeout-diagnostics.js";
