export interface PromptRequestedArtifact {
	kind: "recording" | "screenshot";
	path: string;
	required: boolean;
}

export interface PromptPolicy {
	allowLegacyAgentBrowserBash: boolean;
	requestedArtifacts: PromptRequestedArtifact[];
}

const BROWSER_PROMPT_PATTERNS = [
	/\b(?:agent[_ -]?browser|browser automation|eval\s+--stdin|screenshot|snapshot|tab\s+list)\b/i,
	/\b(?:react\s+(?:tree|inspect|renders|suspense)|web\s+vitals|core\s+web\s+vitals|pushstate)\b/i,
	/\b(?:live\s+docs?|online\s+research|research\s+(?:online|the\s+web)|search\s+(?:online|the\s+web)|web\s+research)\b/i,
	/\bbrowser\b.*\b(?:automation|click|fill|navigate|open|page|screenshot|site|snapshot|tab|url|visit|web(?:site| page)?)\b/i,
	/\b(?:browse|click|fill|login|navigate|open|visit)\b.*\b(?:https?:\/\/\S+|page|site|tab|url|web(?:site| page)?)\b/i,
];

const LEGACY_BASH_ALLOW_PATTERNS = [
	/\b(?:bash-oriented workflow|bash workflow)\b/i,
	/\b(?:use|via|through|with)\s+bash\b/i,
	/\bnpx\s+agent-browser\b/i,
	/\bagent-browser\s+--(?:help|version)\b/i,
	/\bdebug(?:ging)?\b.*\b(?:agent[_ -]?browser|agent_browser|browser integration)\b/i,
];

const PROMPT_ARTIFACT_PATH_PATTERN = /(?:^|[\s"'`(:])((?:\/[^\s"'`),;]+|[A-Za-z]:[\\/][^\s"'`),;]+|\.{1,2}[\\/][^\s"'`),;]+|[^\s"'`()[\],;:\\/]+(?:[\\/][^\s"'`()[\],;\\/]+)+|[^\s"'`()[\],;:\\/]+)\.(?:png|jpe?g|webp|gif|webm|mp4|har|pdf|trace|json))(?=[\s"'`),;.!?]|$)/gi;
const PROMPT_ARTIFACT_COLON_OUTPUT_INTENT_PATTERN = /\b(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\s+(?:(?:a|an|another|the)\s+)?(?:short\s+)?(?:(?:full[- ]page|page|screen)\s+)?(?:image|page|recordings?|screenshots?|screen|video)\s*:\s*$/i;
const PROMPT_ARTIFACT_OUTPUT_INTENT_PATTERN = /\b(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\s+(?:(?:a|an|another|the|this)\s+)?(?:short\s+)?(?:(?:full[- ]page|page|screen)\s+)?(?:image|page|recordings?|screenshots?|screen|video)\s+(?:directly\s+)?(?:\b(?:at|as|to)\b\s*[:=-]?|\bhere\b(?:\s+(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available)?\s*[:=-]?)\s*$|\b(?:export|output|save|write)\s+(?:it\s+)?(?:at|as|to)\s*[:=-]?\s*$/i;
const PROMPT_ARTIFACT_UNSAFE_OUTPUT_PREFIX_PATTERN = /n['’]t\b|\b(?:cannot|disallowed|forbidden|maybe|needed|never|no|not|optional(?:ly)?|perhaps|prohibited|rather|refrain|unable|without)\b|\b(?:he|i|it|she|they|we|you)\s+(?:can|could|may|might)\b/i;
const PROMPT_ARTIFACT_AFFIRMATIVE_PREFIX_PATTERN = /^(?:(?:and(?:\s+then)?|then)(?:\s+please)?|please|you|(?:be|make)\s+sure\s+to|(?:can|could|will|would)\s+you(?:\s+please)?|(?:i|we)\s+(?:need|want)\s+you\s+to|you\s+(?:must|should))$/i;
const PROMPT_ARTIFACT_AFFIRMATIVE_LEAD_IN_PATTERN = /^(?:please\s+)?(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\b.*(?:[,\-:–—]|\b(?:and|then))\s*$/i;
const PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN = /^[\s"'`()\[\]{},;:.*!?\/&+>-]*(?:(?:and|or)[\s"'`()\[\]{},;:.*!?\/&+>-]*)?$/i;
const PROMPT_ARTIFACT_LIST_PREFIX_PATTERN = /^\s*(?:(?:[-*+]|\d+[.)])\s*)/;
const PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN = /\b(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available\b/i;
const PROMPT_ARTIFACT_STANDALONE_OPTIONAL_RECORDING_PATTERN = /^\s*(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available[.:;]?\s*$/i;
const PROMPT_ARTIFACT_EXPLICIT_OPTIONAL_PATTERN = /\b(?:optionally|if\s+(?:convenient|desired|needed|possible|you\s+can|you\s+want\s+to)|when\s+(?:convenient|desired|needed|possible)|only\s+if\s+you\s+(?:can|want\s+to))\b/i;
const PROMPT_ARTIFACT_REFERENCE_INTENT_PATTERN = /\btake\s+the\s+(?:image|recording|screenshot|video)\s+(?:at|from)\b/i;
const PROMPT_ARTIFACT_CLAUSE_BOUNDARY_PATTERN = /(?:[;.!?](?:\s|$)|\b(?:but|instead)\b)/i;

function getPromptArtifactKind(path: string): PromptRequestedArtifact["kind"] | undefined {
	const lowerPath = path.toLowerCase();
	if (/\.(?:webm|mp4)$/.test(lowerPath)) return "recording";
	if (/\.(?:png|jpe?g|webp|gif)$/.test(lowerPath)) return "screenshot";
	return undefined;
}

function getPromptArtifactIntentClause(context: string): string {
	return context.split(PROMPT_ARTIFACT_CLAUSE_BOUNDARY_PATTERN).at(-1) ?? context;
}

function getPromptArtifactTrailingClause(context: string): string {
	return context.split(PROMPT_ARTIFACT_CLAUSE_BOUNDARY_PATTERN)[0] ?? context;
}

function hasPromptArtifactOutputIntent(context: string): boolean {
	const clause = getPromptArtifactIntentClause(context)
		.replace(/\[[^\]\r\n]*\]\(\s*$/, "")
		.replace(/[([{\"'`]+\s*$/, "");
	const intentMatch = clause.match(PROMPT_ARTIFACT_OUTPUT_INTENT_PATTERN) ?? clause.match(PROMPT_ARTIFACT_COLON_OUTPUT_INTENT_PATTERN);
	if (!intentMatch) return false;
	const prefix = clause.slice(0, intentMatch.index ?? 0);
	const governingPrefix = prefix.split(/\b(?:before|unless|until)\b/i).at(-1) ?? prefix;
	if (PROMPT_ARTIFACT_UNSAFE_OUTPUT_PREFIX_PATTERN.test(governingPrefix)) return false;
	const normalizedPrefix = governingPrefix.trim();
	return normalizedPrefix.length === 0
		|| PROMPT_ARTIFACT_AFFIRMATIVE_PREFIX_PATTERN.test(normalizedPrefix)
		|| PROMPT_ARTIFACT_AFFIRMATIVE_LEAD_IN_PATTERN.test(governingPrefix);
}

function stripPromptArtifactListPrefix(context: string): string {
	return context.replace(PROMPT_ARTIFACT_LIST_PREFIX_PATTERN, "");
}

function normalizePromptArtifactPath(path: string): string {
	return path.replace(/^[([{]+/, "");
}

function isLikelyInboundPromptArtifact(path: string): boolean {
	return /(?:^|[\\/])pi-(?:attachment|clipboard|paste|upload)-/i.test(path);
}

function extractPromptRequestedArtifacts(prompt: string): PromptRequestedArtifact[] {
	const artifacts: PromptRequestedArtifact[] = [];
	const seen = new Map<string, number>();
	const lines = prompt.split(/\r?\n/);
	let inCodeFence = false;
	let listArtifactIndexes: number[] = [];
	let listContinuation: { kind: PromptRequestedArtifact["kind"]; required: boolean } | undefined;
	let pendingRecordingAvailability = false;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
			inCodeFence = !inCodeFence;
			listArtifactIndexes = [];
			listContinuation = undefined;
			pendingRecordingAvailability = false;
			continue;
		}
		if (inCodeFence) continue;
		PROMPT_ARTIFACT_PATH_PATTERN.lastIndex = 0;
		const pathMatches: Array<{ end: number; path: string; start: number }> = [];
		for (const match of line.matchAll(PROMPT_ARTIFACT_PATH_PATTERN)) {
			const rawPath = match[1]?.trim();
			const path = rawPath ? normalizePromptArtifactPath(rawPath) : undefined;
			if (!path || !rawPath) continue;
			const start = (match.index ?? 0) + match[0].indexOf(rawPath) + rawPath.indexOf(path);
			pathMatches.push({ end: start + path.length, path, start });
		}
		if (pathMatches.length === 0 && PROMPT_ARTIFACT_STANDALONE_OPTIONAL_RECORDING_PATTERN.test(line)) {
			if (listContinuation?.kind === "recording") {
				for (const artifactIndex of listArtifactIndexes) {
					if (artifacts[artifactIndex]?.kind === "recording") artifacts[artifactIndex]!.required = false;
				}
				listContinuation = { ...listContinuation, required: false };
			} else {
				pendingRecordingAvailability = true;
			}
			continue;
		}
		if (pathMatches.length === 0 && pendingRecordingAvailability && /\brecordings?\b/i.test(line) && hasPromptArtifactOutputIntent(line)) continue;
		const pendingRecordingAvailabilityForLine = pathMatches.length > 0 && pendingRecordingAvailability;
		pendingRecordingAvailability = false;
		const pathlessLine = stripPromptArtifactListPrefix(line.replace(PROMPT_ARTIFACT_PATH_PATTERN, ""));
		const remainder = pathlessLine.replace(/[\s"'`()\[\],;:.*!?>-]+/g, "").toLowerCase();
		const listSyntax = pathlessLine
			.replace(PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN, "")
			.replace(PROMPT_ARTIFACT_EXPLICIT_OPTIONAL_PATTERN, "");
		const isPathList = pathMatches.length > 0 && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(listSyntax);
		const groupOptional = new Map<number, boolean>();
		const candidates: Array<{ continuedFromPriorLine: boolean; group: number; kind: PromptRequestedArtifact["kind"]; matchIndex: number; path: string }> = [];
		let nextGroup = 0;
		let previousGroup: number | undefined;
		let previousKind: PromptRequestedArtifact["kind"] | undefined;
		let previousPathEnd = 0;
		for (let matchIndex = 0; matchIndex < pathMatches.length; matchIndex += 1) {
			const { end, path, start } = pathMatches[matchIndex]!;
			const localContext = stripPromptArtifactListPrefix(line.slice(previousPathEnd, start));
			const intentContext = matchIndex === 0 && (isPathList || !remainder || ["file", "output", "path"].includes(remainder))
				? `${lines[lineIndex - 1] ?? ""}\n${localContext}`
				: localContext;
			const kind = getPromptArtifactKind(path);
			const directIntent = hasPromptArtifactOutputIntent(intentContext);
			const sameLineContinuation = kind === previousKind && previousGroup !== undefined && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(localContext);
			const priorLineContinuation = matchIndex === 0 && isPathList && kind === listContinuation?.kind && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(localContext);
			let group: number | undefined;
			if (directIntent) {
				group = nextGroup++;
				groupOptional.set(group, pendingRecordingAvailabilityForLine || PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN.test(getPromptArtifactIntentClause(intentContext)));
			} else if (sameLineContinuation) {
				group = previousGroup;
			} else if (priorLineContinuation) {
				group = nextGroup++;
				groupOptional.set(group, listContinuation?.required === false);
			}
			const referenceReading = directIntent && PROMPT_ARTIFACT_REFERENCE_INTENT_PATTERN.test(getPromptArtifactIntentClause(intentContext));
			const trailingContext = getPromptArtifactTrailingClause(line.slice(end, pathMatches[matchIndex + 1]?.start ?? line.length));
			const explicitlyOptional = directIntent && (
				PROMPT_ARTIFACT_EXPLICIT_OPTIONAL_PATTERN.test(getPromptArtifactIntentClause(intentContext))
				|| PROMPT_ARTIFACT_EXPLICIT_OPTIONAL_PATTERN.test(trailingContext)
			);
			if (!kind || group === undefined || referenceReading || explicitlyOptional || isLikelyInboundPromptArtifact(path)) {
				previousGroup = undefined;
				previousKind = undefined;
				previousPathEnd = end;
				continue;
			}
			candidates.push({ continuedFromPriorLine: priorLineContinuation && !directIntent, group, kind, matchIndex, path });
			previousGroup = group;
			previousKind = kind;
			previousPathEnd = end;
		}
		for (const candidate of candidates) {
			const match = pathMatches[candidate.matchIndex]!;
			const nextStart = pathMatches[candidate.matchIndex + 1]?.start ?? line.length;
			if (PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN.test(getPromptArtifactTrailingClause(line.slice(match.end, nextStart)))) {
				groupOptional.set(candidate.group, true);
			}
		}
		const lineArtifactIndexes: number[] = [];
		for (const candidate of candidates) {
			const required = candidate.kind === "screenshot" || groupOptional.get(candidate.group) !== true;
			const key = `${candidate.kind}:${candidate.path}`;
			let artifactIndex = seen.get(key);
			if (artifactIndex === undefined) {
				artifactIndex = artifacts.length;
				seen.set(key, artifactIndex);
				artifacts.push({ kind: candidate.kind, path: candidate.path, required });
			} else if (required) {
				artifacts[artifactIndex]!.required = true;
			}
			lineArtifactIndexes.push(artifactIndex);
		}
		const lastCandidate = candidates.at(-1);
		if (isPathList && lastCandidate?.matchIndex === pathMatches.length - 1) {
			const lastArtifact = artifacts[lineArtifactIndexes.at(-1)!]!;
			listContinuation = { kind: lastArtifact.kind, required: lastArtifact.required };
			if (candidates[0]?.continuedFromPriorLine) {
				for (const artifactIndex of lineArtifactIndexes) listArtifactIndexes.push(artifactIndex);
			} else {
				listArtifactIndexes = lineArtifactIndexes;
			}
		} else {
			listArtifactIndexes = [];
			listContinuation = undefined;
		}
	}
	return artifacts;
}

export function buildPromptPolicy(prompt: string): PromptPolicy {
	return {
		allowLegacyAgentBrowserBash: LEGACY_BASH_ALLOW_PATTERNS.some((pattern) => pattern.test(prompt)),
		requestedArtifacts: extractPromptRequestedArtifacts(prompt),
	};
}

function getMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

export function shouldAppendBrowserSystemPrompt(prompt: string): boolean {
	const normalizedPrompt = prompt.trim();
	if (normalizedPrompt.length === 0) {
		return false;
	}
	return BROWSER_PROMPT_PATTERNS.some((pattern) => pattern.test(normalizedPrompt));
}

export function getLatestUserPrompt(branch: unknown[]): string {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") {
			continue;
		}
		const message = "message" in entry ? entry.message : undefined;
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") {
			continue;
		}
		return getMessageText("content" in message ? message.content : undefined);
	}
	return "";
}
