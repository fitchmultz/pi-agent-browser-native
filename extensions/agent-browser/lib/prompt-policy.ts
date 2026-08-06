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

const PROMPT_ARTIFACT_PATH_PATTERN = /(?:^|[\s"'`(:])((?:\/[^\s"'`),;]+|[A-Za-z]:[\\/][^\s"'`),;]+|\.{1,2}[\\/][^\s"'`),;]+|[^\s"'`),;:\\/]+(?:[\\/][^\s"'`),;]+)+|[^\s"'`),;:\\/]+)\.(?:png|jpe?g|webp|gif|webm|mp4|har|pdf|trace|json))(?=[\s"'`),;.]|$)/gi;
const PROMPT_ARTIFACT_COLON_OUTPUT_INTENT_PATTERN = /\b(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\s+(?:(?:a|an|another|the)\s+)?(?:short\s+)?(?:(?:full[- ]page|page|screen)\s+)?(?:image|page|recordings?|screenshots?|screen|video)\s*:\s*$/i;
const PROMPT_ARTIFACT_OUTPUT_INTENT_PATTERN = /\b(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\s+(?:(?:a|an|another|the|this)\s+)?(?:short\s+)?(?:(?:full[- ]page|page|screen)\s+)?(?:image|page|recordings?|screenshots?|screen|video)\s+(?:directly\s+)?(?:\b(?:at|as|to)\b\s*[:=-]?|\bhere\b(?:\s+(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available)?\s*[:=-]?)\s*$|\b(?:export|output|save|write)\s+(?:it\s+)?(?:at|as|to)\s*[:=-]?\s*$/i;
const PROMPT_ARTIFACT_NEGATED_INTENT_PATTERN = /\b(?:do\s+not|don['’]t|never|no\s+need\s+to|need\s+not|(?:should|must)\s+(?:(?:[a-z]+ly|also|ever)\s+)*not|(?:shouldn|mustn)['’]t)\s+(?:(?:[a-z]+ly|also|ever)\s+)*(?:(?:need|try)\s+to\s+)?(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\b/i;
const PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN = /^[\s"'`()\[\]{},;:.*\/&+>-]*(?:(?:and|or)[\s"'`()\[\]{},;:.*\/&+>-]*)?$/i;
const PROMPT_ARTIFACT_LIST_PREFIX_PATTERN = /^\s*(?:(?:[-*+]|\d+[.)])\s*)/;
const PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN = /\b(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available\b/i;
const PROMPT_ARTIFACT_REFERENCE_INTENT_PATTERN = /\btake\s+the\s+(?:image|recording|screenshot|video)\s+(?:at|from)\b/i;
const PROMPT_ARTIFACT_REFERENCE_TRAILING_PATTERN = /^\s*(?:and\s+)?(?:analy[sz]e|compare|inspect|review|use\s+as\s+(?:a\s+)?reference)\b/i;
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
	const clause = getPromptArtifactIntentClause(context).replace(/[([{\"'`]+\s*$/, "");
	return (PROMPT_ARTIFACT_OUTPUT_INTENT_PATTERN.test(clause) || PROMPT_ARTIFACT_COLON_OUTPUT_INTENT_PATTERN.test(clause))
		&& !PROMPT_ARTIFACT_NEGATED_INTENT_PATTERN.test(clause);
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
	const seen = new Set<string>();
	const lines = prompt.split(/\r?\n/);
	let listContinuation: { kind: PromptRequestedArtifact["kind"]; required: boolean } | undefined;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		PROMPT_ARTIFACT_PATH_PATTERN.lastIndex = 0;
		const pathMatches: Array<{ end: number; path: string; start: number }> = [];
		for (const match of line.matchAll(PROMPT_ARTIFACT_PATH_PATTERN)) {
			const rawPath = match[1]?.trim();
			const path = rawPath ? normalizePromptArtifactPath(rawPath) : undefined;
			if (!path || !rawPath) continue;
			const start = (match.index ?? 0) + match[0].indexOf(rawPath) + rawPath.indexOf(path);
			pathMatches.push({ end: start + path.length, path, start });
		}
		const pathlessLine = stripPromptArtifactListPrefix(line.replace(PROMPT_ARTIFACT_PATH_PATTERN, ""));
		const remainder = pathlessLine.replace(/[\s"'`()\[\],;:.*>-]+/g, "").toLowerCase();
		const isPathList = pathMatches.length > 0 && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(pathlessLine);
		const groupOptional = new Map<number, boolean>();
		const candidates: Array<{ group: number; kind: PromptRequestedArtifact["kind"]; matchIndex: number; path: string }> = [];
		let nextGroup = 0;
		let previousGroup: number | undefined;
		let previousKind: PromptRequestedArtifact["kind"] | undefined;
		let previousPathEnd = 0;
		for (let matchIndex = 0; matchIndex < pathMatches.length; matchIndex += 1) {
			const { end, path, start } = pathMatches[matchIndex]!;
			const localContext = stripPromptArtifactListPrefix(line.slice(previousPathEnd, start));
			const intentContext = isPathList || !remainder || ["file", "output", "path"].includes(remainder)
				? `${lines[lineIndex - 1] ?? ""}\n${localContext}`
				: localContext;
			const kind = getPromptArtifactKind(path);
			const directIntent = hasPromptArtifactOutputIntent(intentContext);
			const sameLineContinuation = kind === previousKind && previousGroup !== undefined && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(localContext);
			const priorLineContinuation = matchIndex === 0 && isPathList && kind === listContinuation?.kind && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(localContext);
			let group: number | undefined;
			if (directIntent) {
				group = nextGroup++;
				groupOptional.set(group, PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN.test(getPromptArtifactIntentClause(intentContext)));
			} else if (sameLineContinuation) {
				group = previousGroup;
			} else if (priorLineContinuation) {
				group = nextGroup++;
				groupOptional.set(group, listContinuation?.required === false);
			}
			const referenceReading = directIntent
				&& PROMPT_ARTIFACT_REFERENCE_INTENT_PATTERN.test(getPromptArtifactIntentClause(intentContext))
				&& PROMPT_ARTIFACT_REFERENCE_TRAILING_PATTERN.test(getPromptArtifactTrailingClause(line.slice(end)));
			if (!kind || group === undefined || referenceReading || (!directIntent && isLikelyInboundPromptArtifact(path))) {
				previousGroup = undefined;
				previousKind = undefined;
				previousPathEnd = end;
				continue;
			}
			candidates.push({ group, kind, matchIndex, path });
			previousGroup = group;
			previousKind = kind;
			previousPathEnd = end;
		}
		const candidateByMatchIndex = new Map(candidates.map((candidate) => [candidate.matchIndex, candidate]));
		for (const candidate of candidates) {
			const match = pathMatches[candidate.matchIndex]!;
			const nextCandidate = candidateByMatchIndex.get(candidate.matchIndex + 1);
			if (nextCandidate?.group === candidate.group || candidate.matchIndex === pathMatches.length - 1) {
				const nextStart = pathMatches[candidate.matchIndex + 1]?.start ?? line.length;
				if (PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN.test(getPromptArtifactTrailingClause(line.slice(match.end, nextStart)))) {
					groupOptional.set(candidate.group, true);
				}
			}
		}
		for (const candidate of candidates) {
			const required = candidate.kind === "screenshot" || groupOptional.get(candidate.group) !== true;
			const key = `${candidate.kind}:${candidate.path}`;
			if (!seen.has(key)) {
				seen.add(key);
				artifacts.push({ kind: candidate.kind, path: candidate.path, required });
			}
			if (candidate.matchIndex === pathMatches.length - 1) listContinuation = { kind: candidate.kind, required };
		}
		if (!isPathList || candidates.at(-1)?.matchIndex !== pathMatches.length - 1) listContinuation = undefined;
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
