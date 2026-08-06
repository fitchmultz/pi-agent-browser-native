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
const PROMPT_ARTIFACT_NEGATED_INTENT_PATTERN = /\b(?:do\s+not|don't|never|no\s+need\s+to|need\s+not)\s+(?:(?:actually|also|ever)\s+)*(?:(?:need|try)\s+to\s+)?(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\b/i;
const PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN = /^[\s"'`()\[\]{},;:.*\/&+>-]*(?:(?:and|or)[\s"'`()\[\]{},;:.*\/&+>-]*)?$/i;
const PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN = /\b(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available\b/i;

function getPromptArtifactKind(path: string): PromptRequestedArtifact["kind"] | undefined {
	const lowerPath = path.toLowerCase();
	if (/\.(?:webm|mp4)$/.test(lowerPath)) return "recording";
	if (/\.(?:png|jpe?g|webp|gif)$/.test(lowerPath)) return "screenshot";
	return undefined;
}

function hasPromptArtifactOutputIntent(context: string): boolean {
	const clause = context.split(/(?:[;.!?](?:\s|$)|\b(?:but|instead)\b)/i).at(-1) ?? context;
	return (PROMPT_ARTIFACT_OUTPUT_INTENT_PATTERN.test(clause) || PROMPT_ARTIFACT_COLON_OUTPUT_INTENT_PATTERN.test(clause))
		&& !PROMPT_ARTIFACT_NEGATED_INTENT_PATTERN.test(clause);
}

function extractPromptRequestedArtifacts(prompt: string): PromptRequestedArtifact[] {
	const artifacts: PromptRequestedArtifact[] = [];
	const seen = new Set<string>();
	const lines = prompt.split(/\r?\n/);
	let listContinuation: { kind: PromptRequestedArtifact["kind"]; required: boolean } | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		let previousKind: PromptRequestedArtifact["kind"] | undefined;
		let previousRequired: boolean | undefined;
		let previousPathEnd = 0;
		let lastListArtifact: typeof listContinuation;
		PROMPT_ARTIFACT_PATH_PATTERN.lastIndex = 0;
		const pathMatches: Array<{ path: string; start: number }> = [];
		for (const match of line.matchAll(PROMPT_ARTIFACT_PATH_PATTERN)) {
			const path = match[1]?.trim();
			if (path) pathMatches.push({ path, start: (match.index ?? 0) + match[0].indexOf(path) });
		}
		const pathlessLine = line.replace(PROMPT_ARTIFACT_PATH_PATTERN, "");
		const remainder = pathlessLine.replace(/[\s"'`()\[\],;:.*>-]+/g, "").toLowerCase();
		const isPathList = pathMatches.length > 0 && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(pathlessLine);
		for (const { path, start: pathStart } of pathMatches) {
			const localContext = line.slice(previousPathEnd, pathStart);
			const intentContext = isPathList || !remainder || ["file", "output", "path"].includes(remainder)
				? `${lines[index - 1] ?? ""}\n${localContext}`
				: localContext;
			const kind = getPromptArtifactKind(path);
			const directIntent = hasPromptArtifactOutputIntent(intentContext);
			const sameLineContinuation = kind === previousKind && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(localContext);
			const priorLineContinuation = isPathList && kind === listContinuation?.kind && PROMPT_ARTIFACT_LIST_CONNECTOR_PATTERN.test(localContext);
			const hasIntent = directIntent || sameLineContinuation || priorLineContinuation;
			previousPathEnd = pathStart + path.length;
			if (!kind || !hasIntent) {
				previousKind = undefined;
				previousRequired = undefined;
				continue;
			}
			const required = kind === "screenshot" || (directIntent
				? !PROMPT_ARTIFACT_OPTIONAL_RECORDING_PATTERN.test(intentContext)
				: sameLineContinuation
					? previousRequired !== false
					: listContinuation?.required !== false);
			previousKind = kind;
			previousRequired = required;
			lastListArtifact = { kind, required };
			const key = `${kind}:${path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			artifacts.push({ kind, path, required });
		}
		listContinuation = isPathList ? lastListArtifact : undefined;
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
