/**
 * Purpose: Derive operator prompt constraints for browser-run preflight guards and legacy bash policy.
 * Responsibilities: Parse the latest user message into stop boundaries, requested artifact paths, and legacy bash allowance.
 * Scope: Pure prompt-text policy; enforcement lives in orchestration prompt-guards and the extension entrypoint.
 */

export interface PromptRequestedArtifact {
	kind: "recording" | "screenshot";
	path: string;
	required: boolean;
}

export interface PromptStopBoundary {
	reason: "avoid-final-submit-action";
}

export interface PromptPolicy {
	allowLegacyAgentBrowserBash: boolean;
	requestedArtifacts: PromptRequestedArtifact[];
	stopBoundary?: PromptStopBoundary;
}

const LEGACY_BASH_ALLOW_PATTERNS = [
	/\b(?:bash-oriented workflow|bash workflow)\b/i,
	/\b(?:use|via|through|with)\s+bash\b/i,
	/\bnpx\s+agent-browser\b/i,
	/\bagent-browser\s+--(?:help|version)\b/i,
	/\bdebug(?:ging)?\b.*\b(?:agent[_ -]?browser|agent_browser|browser integration)\b/i,
];

const STOP_BOUNDARY_PATTERNS = [
	/\b(?:do\s+not|don't|dont|never)\s+(?:place|submit|complete|finish|finali[sz]e|confirm)\s+(?:the\s+)?(?:order|purchase|checkout|payment)\b/i,
	/\b(?:do\s+not|don't|dont|never)\s+click\s+(?:the\s+)?(?:finish|submit|place\s+order|complete\s+order|confirm\s+order|buy\s+now|pay\s+now)\b/i,
	/\bstop\s+(?:on|at|before)\b[^.\n]*(?:checkout\s+overview|finish|place\s+(?:the\s+)?order|submit\s+(?:the\s+)?order|complete\s+(?:the\s+)?order|purchase|payment)\b/i,
	/\bwithout\s+(?:placing|submitting|completing|finishing|confirming)\s+(?:the\s+)?(?:order|purchase|payment)\b/i,
];

const PROMPT_ARTIFACT_PATH_PATTERN = /(?:^|[\s"'`(:])((?:\/[^\s"'`),;]+|[A-Za-z]:[\\/][^\s"'`),;]+|\.{1,2}[\\/][^\s"'`),;]+|[^\s"'`),;:\\/]+(?:[\\/][^\s"'`),;]+)+|[^\s"'`),;:\\/]+)\.(?:png|jpe?g|webp|gif|webm|mp4|har|pdf|trace|json))(?:[\s"'`),;.]|$)/gi;

function buildPromptStopBoundary(prompt: string): PromptStopBoundary | undefined {
	return STOP_BOUNDARY_PATTERNS.some((pattern) => pattern.test(prompt)) ? { reason: "avoid-final-submit-action" } : undefined;
}

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
		stopBoundary: buildPromptStopBoundary(prompt),
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
