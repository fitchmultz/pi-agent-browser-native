import { isRecord } from "../../parsing.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import {
	buildInspectOverlayStateAction,
	withOptionalSessionArgs,
} from "../../results/next-actions.js";
import {
	extractRefSnapshotFromData,
	normalizeComparableUrl,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { rawStringField } from "./diagnostic-values.js";
import { runSessionCommandData } from "./session-state.js";
import type {
	NavigationSummary,
	OverlayBlockerCandidate,
	OverlayBlockerDiagnostic,
} from "./observation-types.js";

const OVERLAY_CLOSE_NAME_PATTERN =
	/(?:\b(?:close|dismiss|no thanks|not now|maybe later|hide|skip|continue without|x)\b|^\s*×\s*$)/i;
const OVERLAY_CONTEXT_ROLES = new Set(["alertdialog", "dialog"]);
const OVERLAY_ACTION_ROLES = new Set(["button", "link", "menuitem"]);
const OVERLAY_BLOCKER_CANDIDATE_LIMIT = 3;

function overlayBlockerCandidate(ref: string, entry: unknown): OverlayBlockerCandidate | undefined {
	if (!/^e\d+$/.test(ref) || !isRecord(entry)) {
		return undefined;
	}
	const role = rawStringField(entry, "role");
	const name = rawStringField(entry, "name");
	if (
		role === undefined ||
		role === "" ||
		!OVERLAY_ACTION_ROLES.has(role.toLowerCase()) ||
		name === undefined ||
		name === "" ||
		!OVERLAY_CLOSE_NAME_PATTERN.test(name)
	) {
		return undefined;
	}
	return {
		args: ["click", `@${ref}`],
		name,
		reason: `Visible ${role} ${JSON.stringify(name)} appears in a snapshot that also contains overlay/banner/dialog context.`,
		ref: `@${ref}`,
		role,
	};
}

function getOverlayBlockerCandidates(snapshotData: unknown): OverlayBlockerCandidate[] {
	const refs =
		isRecord(snapshotData) && isRecord(snapshotData.refs) ? snapshotData.refs : undefined;
	if (
		!refs ||
		!Object.values(refs).some(
			(entry) =>
				isRecord(entry) &&
				OVERLAY_CONTEXT_ROLES.has((rawStringField(entry, "role") ?? "").toLowerCase()),
		)
	) {
		return [];
	}
	const candidates: OverlayBlockerCandidate[] = [];
	for (const [ref, entry] of Object.entries(refs)) {
		const candidate = overlayBlockerCandidate(ref, entry);
		if (candidate) {
			candidates.push(candidate);
		}
		if (candidates.length >= OVERLAY_BLOCKER_CANDIDATE_LIMIT) {
			break;
		}
	}
	return candidates;
}

export function formatOverlayBlockerText(diagnostic: OverlayBlockerDiagnostic): string {
	return [
		"Possible overlay blockers:",
		...diagnostic.candidates.map((candidate) => {
			const role =
				candidate.role !== undefined && candidate.role !== "" ? ` ${candidate.role}` : "";
			const name =
				candidate.name !== undefined && candidate.name !== ""
					? ` ${JSON.stringify(candidate.name)}`
					: "";
			return `- ${candidate.ref}${role}${name}: ${candidate.reason}`;
		}),
	].join("\n");
}

export function buildOverlayBlockerNextActions(options: {
	readonly diagnostic: OverlayBlockerDiagnostic;
	readonly sessionName?: string | undefined;
}): AgentBrowserNextAction[] {
	return [
		buildInspectOverlayStateAction(options.sessionName),
		...options.diagnostic.candidates.map((candidate, index): AgentBrowserNextAction => ({
			id: `try-overlay-blocker-candidate-${index + 1}`,
			params: { args: withOptionalSessionArgs(options.sessionName, candidate.args) },
			reason: candidate.reason,
			safety:
				"Only click this if the candidate is clearly a close/dismiss control for an overlay that blocks the intended workflow.",
			tool: "agent_browser",
		})),
	];
}

export function collectSnapshotOverlayBlockerDiagnostic(
	data: unknown,
): OverlayBlockerDiagnostic | undefined {
	const candidates = getOverlayBlockerCandidates(data);
	const snapshot = extractRefSnapshotFromData(data);
	return candidates.length === 0 || !snapshot
		? undefined
		: {
				candidates,
				snapshot,
				summary:
					"Snapshot contains dialog/modal context plus likely close or dismiss controls; treat covered controls as potentially obstructed until the overlay state is resolved.",
			};
}

interface OverlayDiagnosticOptions {
	readonly command?: string | undefined;
	readonly cwd: string;
	readonly data: unknown;
	readonly namespace?: string | undefined;
	readonly navigationSummary?: NavigationSummary | undefined;
	readonly priorTarget?: SessionTabTarget | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}

function isSnapshotRefClick(data: unknown): boolean {
	return (
		isRecord(data) &&
		typeof data.clicked === "string" &&
		(data.clicked.startsWith("@") || data.clicked.startsWith("ref="))
	);
}

function stationaryRefClickUrl(options: OverlayDiagnosticOptions): string | undefined {
	if (options.command !== "click" || !isSnapshotRefClick(options.data)) {
		return undefined;
	}
	const priorUrl = normalizeComparableUrl(options.priorTarget?.url);
	const currentUrl = normalizeComparableUrl(options.navigationSummary?.url);
	return currentUrl !== undefined && currentUrl !== "" && currentUrl === priorUrl
		? currentUrl
		: undefined;
}

export async function collectOverlayBlockerDiagnostic(
	options: OverlayDiagnosticOptions,
): Promise<OverlayBlockerDiagnostic | undefined> {
	const currentUrl = stationaryRefClickUrl(options);
	if (currentUrl === undefined) {
		return undefined;
	}
	const snapshotData = await runSessionCommandData({
		args: ["snapshot", "-i"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	const diagnostic = collectSnapshotOverlayBlockerDiagnostic(snapshotData);
	return diagnostic
		? {
				...diagnostic,
				summary: `Click completed but the page stayed on ${currentUrl}; a fresh snapshot contains likely overlay close/dismiss controls.`,
			}
		: undefined;
}
