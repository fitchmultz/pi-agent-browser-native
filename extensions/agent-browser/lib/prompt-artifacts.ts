export interface PromptRequestedArtifact {
	readonly kind: "recording" | "screenshot";
	readonly path: string;
	readonly required: boolean;
}

type ArtifactKind = PromptRequestedArtifact["kind"];
interface ListContinuation {
	readonly kind: ArtifactKind;
	readonly required: boolean;
}
interface PathMatch {
	readonly end: number;
	readonly path: string;
	readonly start: number;
}
interface Candidate extends Pick<PathMatch, "path" | "end"> {
	readonly continuedFromPriorLine: boolean;
	readonly group: number;
	readonly kind: ArtifactKind;
	readonly matchIndex: number;
}
interface RequiredCandidate extends Candidate {
	readonly required: boolean;
}
interface CandidateAnalysis {
	readonly candidates: readonly RequiredCandidate[];
	readonly isPathList: boolean;
}

const PATH_PATTERN =
	/(?:^|[\s"'`(:])((?:\/[^\s"'`),;]+|[A-Za-z]:[\\/][^\s"'`),;]+|\.{1,2}[\\/][^\s"'`),;]+|[^\s"'`()[\],;:\\/]+(?:[\\/][^\s"'`()[\],;\\/]+)+|[^\s"'`()[\],;:\\/]+)\.(?:png|jpe?g|webp|gif|webm|mp4|har|pdf|trace|json))(?=[\s"'`),;.!?]|$)/gi;
const COLON_OUTPUT_INTENT_PATTERN =
	/\b(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\s+(?:(?:a|an|another|the)\s+)?(?:short\s+)?(?:(?:full[- ]page|page|screen)\s+)?(?:image|page|recordings?|screenshots?|screen|video)\s*:\s*$/i;
const OUTPUT_INTENT_PATTERN =
	/\b(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\s+(?:(?:a|an|another|the|this)\s+)?(?:short\s+)?(?:(?:full[- ]page|page|screen)\s+)?(?:image|page|recordings?|screenshots?|screen|video)\s+(?:directly\s+)?(?:\b(?:at|as|to)\b\s*[:=-]?|\bhere\b(?:\s+(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available)?\s*[:=-]?)\s*$|\b(?:export|output|save|write)\s+(?:it\s+)?(?:at|as|to)\s*[:=-]?\s*$/i;
const UNSAFE_OUTPUT_PREFIX_PATTERN =
	/n['’]t\b|\b(?:cannot|disallowed|forbidden|maybe|needed|never|no|not|optional(?:ly)?|perhaps|prohibited|rather|refrain|unable|without)\b|\b(?:he|i|it|she|they|we|you)\s+(?:can|could|may|might)\b/i;
const AFFIRMATIVE_PREFIX_PATTERN =
	/^(?:(?:and(?:\s+then)?|then)(?:\s+please)?|please|you|(?:be|make)\s+sure\s+to|(?:can|could|will|would)\s+you(?:\s+please)?|(?:i|we)\s+(?:need|want)\s+you\s+to|you\s+(?:must|should))$/i;
const AFFIRMATIVE_LEAD_IN_PATTERN =
	/^(?:please\s+)?(?:capture|create|export|generate|output|record|render|save|screenshot|start|take|write)\b.*(?:[,\-:–—]|\b(?:and|then))\s*$/i;
const LIST_CONNECTOR_PATTERN =
	/^[\s"'`()[\]{},;:.*!?/&+>-]*(?:(?:and|or)[\s"'`()[\]{},;:.*!?/&+>-]*)?$/i;
const LIST_PREFIX_PATTERN = /^\s*(?:(?:[-*+]|\d+[.)])\s*)/;
const OPTIONAL_RECORDING_PATTERN =
	/\b(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available\b/i;
const STANDALONE_OPTIONAL_RECORDING_PATTERN =
	/^\s*(?:if|when)\s+(?:recordings?\s+)?(?:(?:are|is)\s+)?available[.:;]?\s*$/i;
const EXPLICIT_OPTIONAL_PATTERN =
	/\b(?:optionally|if\s+(?:convenient|desired|needed|possible|you\s+can|you\s+want\s+to)|when\s+(?:convenient|desired|needed|possible)|only\s+if\s+you\s+(?:can|want\s+to))\b/i;
const REFERENCE_INTENT_PATTERN =
	/\btake\s+the\s+(?:image|recording|screenshot|video)\s+(?:at|from)\b/i;
const CLAUSE_BOUNDARY_PATTERN = /(?:[;.!?](?:\s|$)|\b(?:but|instead)\b)/i;

function artifactKind(path: string): ArtifactKind | undefined {
	if (/\.(?:webm|mp4)$/i.test(path)) {
		return "recording";
	}
	if (/\.(?:png|jpe?g|webp|gif)$/i.test(path)) {
		return "screenshot";
	}
	return undefined;
}

function intentClause(context: string): string {
	return context.split(CLAUSE_BOUNDARY_PATTERN).at(-1) ?? context;
}

function trailingClause(context: string): string {
	return context.split(CLAUSE_BOUNDARY_PATTERN)[0] ?? context;
}

function hasOutputIntent(context: string): boolean {
	const clause = intentClause(context)
		.replace(/\[[^\]\r\n]*\]\(\s*$/, "")
		.replace(/[([{"'`]+\s*$/, "");
	const match = clause.match(OUTPUT_INTENT_PATTERN) ?? clause.match(COLON_OUTPUT_INTENT_PATTERN);
	if (!match) {
		return false;
	}
	const prefix = clause.slice(0, match.index ?? 0);
	const governingPrefix = prefix.split(/\b(?:before|unless|until)\b/i).at(-1) ?? prefix;
	if (UNSAFE_OUTPUT_PREFIX_PATTERN.test(governingPrefix)) {
		return false;
	}
	return (
		governingPrefix.trim().length === 0 ||
		AFFIRMATIVE_PREFIX_PATTERN.test(governingPrefix.trim()) ||
		AFFIRMATIVE_LEAD_IN_PATTERN.test(governingPrefix)
	);
}

function stripListPrefix(context: string): string {
	return context.replace(LIST_PREFIX_PATTERN, "");
}

function pathMatches(line: string): PathMatch[] {
	PATH_PATTERN.lastIndex = 0;
	const matches: PathMatch[] = [];
	for (const match of line.matchAll(PATH_PATTERN)) {
		const rawPath = match.at(1)?.trim();
		if (rawPath === undefined || rawPath.length === 0) {
			continue;
		}
		const path = rawPath.replace(/^[([{]+/, "");
		if (path.length === 0) {
			continue;
		}
		const start = match.index + match[0].indexOf(rawPath) + rawPath.indexOf(path);
		matches.push({ end: start + path.length, path, start });
	}
	return matches;
}

interface ArtifactLine {
	readonly line: string;
	readonly previousLine: string;
	readonly matches: readonly PathMatch[];
	readonly continuation: ListContinuation | undefined;
	readonly recordingOptional: boolean;
}

/** Groups output candidates and optionality on one line; it owns no cross-line state. */
class ArtifactCandidateLine {
	private readonly candidates: Candidate[] = [];
	readonly isPathList: boolean;
	private readonly groupOptional = new Map<number, boolean>();
	private readonly remainder: string;
	private nextGroup = 0;
	private previousGroup: number | undefined;
	private previousKind: ArtifactKind | undefined;
	private previousPathEnd = 0;

	constructor(private readonly input: ArtifactLine) {
		const pathless = stripListPrefix(input.line.replace(PATH_PATTERN, ""));
		this.remainder = pathless.replace(/[\s"'`()[\],;:.*!?>-]+/g, "").toLowerCase();
		const syntax = pathless
			.replace(OPTIONAL_RECORDING_PATTERN, "")
			.replace(EXPLICIT_OPTIONAL_PATTERN, "");
		this.isPathList = input.matches.length > 0 && LIST_CONNECTOR_PATTERN.test(syntax);
		for (const [index, match] of input.matches.entries()) {
			this.collectCandidate(index, match);
		}
		this.applyTrailingOptionality();
	}

	private candidateContext(index: number, localContext: string): string {
		if (
			index === 0 &&
			(this.isPathList ||
				this.remainder.length === 0 ||
				["file", "output", "path"].includes(this.remainder))
		) {
			return `${this.input.previousLine}\n${localContext}`;
		}
		return localContext;
	}

	private selectGroup(direct: boolean, priorLine: boolean, context: string): number | undefined {
		if (direct) {
			const group = this.nextGroup++;
			this.groupOptional.set(
				group,
				this.input.recordingOptional || OPTIONAL_RECORDING_PATTERN.test(intentClause(context)),
			);
			return group;
		}
		if (priorLine) {
			const group = this.nextGroup++;
			this.groupOptional.set(group, this.input.continuation?.required === false);
			return group;
		}
		return undefined;
	}

	private excludesCandidate(
		path: string,
		context: string,
		trailing: string,
		direct: boolean,
	): boolean {
		if (/(?:^|[\\/])pi-(?:attachment|clipboard|paste|upload)-/i.test(path)) {
			return true;
		}
		return (
			direct &&
			(REFERENCE_INTENT_PATTERN.test(intentClause(context)) ||
				EXPLICIT_OPTIONAL_PATTERN.test(intentClause(context)) ||
				EXPLICIT_OPTIONAL_PATTERN.test(trailing))
		);
	}

	private continuesPriorLine(
		index: number,
		kind: ArtifactKind | undefined,
		context: string,
	): boolean {
		return (
			index === 0 &&
			this.isPathList &&
			kind === this.input.continuation?.kind &&
			LIST_CONNECTOR_PATTERN.test(context)
		);
	}

	private continuesSameLine(kind: ArtifactKind | undefined, context: string): boolean {
		return (
			kind === this.previousKind &&
			this.previousGroup !== undefined &&
			LIST_CONNECTOR_PATTERN.test(context)
		);
	}

	private collectCandidate(index: number, match: PathMatch): void {
		const { end, path, start } = match;
		const localContext = stripListPrefix(this.input.line.slice(this.previousPathEnd, start));
		const context = this.candidateContext(index, localContext);
		const kind = artifactKind(path);
		const direct = hasOutputIntent(context);
		const sameLine = this.continuesSameLine(kind, localContext);
		const priorLine = this.continuesPriorLine(index, kind, localContext);
		const group =
			!direct && sameLine ? this.previousGroup : this.selectGroup(direct, priorLine, context);
		const trailing = trailingClause(
			this.input.line.slice(end, this.input.matches[index + 1]?.start ?? this.input.line.length),
		);
		this.previousPathEnd = end;
		if (
			kind === undefined ||
			group === undefined ||
			this.excludesCandidate(path, context, trailing, direct)
		) {
			this.previousGroup = undefined;
			this.previousKind = undefined;
			return;
		}
		this.candidates.push({
			end,
			continuedFromPriorLine: priorLine && !direct,
			group,
			kind,
			matchIndex: index,
			path,
		});
		this.previousGroup = group;
		this.previousKind = kind;
	}

	private applyTrailingOptionality(): void {
		for (const candidate of this.candidates) {
			const nextStart =
				this.input.matches[candidate.matchIndex + 1]?.start ?? this.input.line.length;
			if (
				OPTIONAL_RECORDING_PATTERN.test(
					trailingClause(this.input.line.slice(candidate.end, nextStart)),
				)
			) {
				this.groupOptional.set(candidate.group, true);
			}
		}
	}

	result(): CandidateAnalysis {
		const candidates: RequiredCandidate[] = [];
		for (const candidate of this.candidates) {
			candidates.push({
				...candidate,
				required:
					candidate.kind === "screenshot" || this.groupOptional.get(candidate.group) !== true,
			});
		}
		return { candidates, isPathList: this.isPathList };
	}
}

type CollectedArtifact = Omit<PromptRequestedArtifact, "required"> & { required: boolean };

/** Owns deduplication and list/fence state for one prompt; no parser state survives the call. */
class PromptArtifactCollector {
	private readonly artifacts = new Map<string, CollectedArtifact>();
	private inCodeFence = false;
	private listArtifacts: CollectedArtifact[] = [];
	private continuation: ListContinuation | undefined;
	private pendingRecordingAvailability = false;

	private resetList(): void {
		this.listArtifacts = [];
		this.continuation = undefined;
	}

	private applyRecordingAvailability(): void {
		if (this.continuation?.kind !== "recording") {
			this.pendingRecordingAvailability = true;
			return;
		}
		for (const artifact of this.listArtifacts) {
			if (artifact.kind === "recording") {
				artifact.required = false;
			}
		}
		this.continuation = { ...this.continuation, required: false };
	}

	private skipLine(line: string, matches: readonly PathMatch[]): boolean {
		if (matches.length > 0) {
			return false;
		}
		if (STANDALONE_OPTIONAL_RECORDING_PATTERN.test(line)) {
			this.applyRecordingAvailability();
			return true;
		}
		return (
			this.pendingRecordingAvailability && /\brecordings?\b/i.test(line) && hasOutputIntent(line)
		);
	}

	private storeCandidates(analysis: CandidateAnalysis): CollectedArtifact[] {
		const stored: CollectedArtifact[] = [];
		for (const candidate of analysis.candidates) {
			const required = candidate.required;
			const key = `${candidate.kind}:${candidate.path}`;
			let artifact = this.artifacts.get(key);
			if (artifact === undefined) {
				artifact = { kind: candidate.kind, path: candidate.path, required };
				this.artifacts.set(key, artifact);
			} else if (required) {
				artifact.required = true;
			}
			stored.push(artifact);
		}
		return stored;
	}

	private updateContinuation(
		analysis: CandidateAnalysis,
		artifacts: readonly CollectedArtifact[],
		matchCount: number,
	): void {
		const lastCandidate = analysis.candidates.at(-1);
		const lastArtifact = artifacts.at(-1);
		if (
			!analysis.isPathList ||
			lastCandidate?.matchIndex !== matchCount - 1 ||
			lastArtifact === undefined
		) {
			this.resetList();
			return;
		}
		this.continuation = { kind: lastArtifact.kind, required: lastArtifact.required };
		if (analysis.candidates[0]?.continuedFromPriorLine === true) {
			this.listArtifacts.push(...artifacts);
		} else {
			this.listArtifacts = [...artifacts];
		}
	}

	private collectLine(line: string, previousLine: string): void {
		if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
			this.inCodeFence = !this.inCodeFence;
			this.resetList();
			this.pendingRecordingAvailability = false;
			return;
		}
		if (this.inCodeFence) {
			return;
		}
		const matches = pathMatches(line);
		if (this.skipLine(line, matches)) {
			return;
		}
		const recordingOptional = matches.length > 0 && this.pendingRecordingAvailability;
		this.pendingRecordingAvailability = false;
		const analysis = new ArtifactCandidateLine({
			line,
			previousLine,
			matches,
			continuation: this.continuation,
			recordingOptional,
		}).result();
		const artifacts = this.storeCandidates(analysis);
		this.updateContinuation(analysis, artifacts, matches.length);
	}

	collect(prompt: string): PromptRequestedArtifact[] {
		const lines = prompt.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			this.collectLine(lines[index] ?? "", lines[index - 1] ?? "");
		}
		return [...this.artifacts.values()];
	}
}

export function extractPromptRequestedArtifacts(prompt: string): PromptRequestedArtifact[] {
	return new PromptArtifactCollector().collect(prompt);
}
