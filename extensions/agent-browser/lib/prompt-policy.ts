/**
 * Purpose: Derive operator prompt constraints for browser-run preflight guards and legacy bash policy.
 * Responsibilities: Parse the latest user message into requested artifact paths and legacy bash allowance.
 * Scope: Pure prompt-text policy; enforcement lives in orchestration prompt-guards and the extension entrypoint.
 */

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

const PROMPT_ARTIFACT_PATH_PATTERN = /(?:^|[\s"'`(:])((?:\/[^\s"'`),;]+|[A-Za-z]:[\\/][^\s"'`),;]+|\.{1,2}[\\/][^\s"'`),;]+|[^\s"'`),;:\\/]+(?:[\\/][^\s"'`),;]+)+|[^\s"'`),;:\\/]+)\.(?:png|jpe?g|webp|gif|webm|mp4|har|pdf|trace|json))(?:[\s"'`),;.]|$)/gi;

function extractPromptRequestedArtifacts(prompt: string): PromptRequestedArtifact[] {
	const artifacts: PromptRequestedArtifact[] = [];
	const seen = new Set<string>();
	for (const line of prompt.split(/\r?\n/)) {
		const lowerLine = line.toLowerCase();
		const kind = lowerLine.includes("screenshot")
			? "screenshot"
			: /\b(?:screen\s+recording|recording|webm|video)\b/.test(lowerLine)
				? "recording"
				: undefined;
		if (!kind) continue;
		PROMPT_ARTIFACT_PATH_PATTERN.lastIndex = 0;
		for (const match of line.matchAll(PROMPT_ARTIFACT_PATH_PATTERN)) {
			const path = match[1]?.trim();
			if (!path) continue;
			const key = `${kind}:${path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			artifacts.push({
				kind,
				path,
				required: kind === "screenshot" || !/\b(?:if|when)\s+(?:recording\s+)?(?:is\s+)?available\b/i.test(line),
			});
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
