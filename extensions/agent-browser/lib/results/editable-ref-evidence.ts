const EDITABLE_REF_EVIDENCE_KEYS = [
	"editable",
	"contentEditable",
	"contenteditable",
	"isContentEditable",
] as const;
const EDITABLE_FALSE_TEXT_PATTERN = /\b(?:contenteditable|editable)\s*=\s*["']?(?:false|0)["']?/i;
const EDITABLE_ASSIGNMENT_TEXT_PATTERN =
	/\b(contenteditable|editable)\s*=\s*("[^"]*"|'[^']*'|[^\s,\]]+)/gi;
const EDITABLE_BARE_TEXT_PATTERN = /\b(?:contenteditable|editable)\b(?!\s*=)/i;
const SNAPSHOT_HINT_TEXT_PATTERN = /\shint="(?:\\.|[^"\\])*"/g;

function parseEditableEvidenceValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (value === 1) {
			return true;
		}
		if (value === 0) {
			return false;
		}
		return undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value
		.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase();
	if (["false", "0", "no"].includes(normalized)) {
		return false;
	}
	if (["", "true", "1", "yes", "plaintext-only"].includes(normalized)) {
		return true;
	}
	return undefined;
}

function stripLeadingSnapshotAccessibleName(text: string): string {
	return text.replace(/^(\s*[-*]\s+\S+\s+)(?:"[^"]*"|'[^']*')/, "$1");
}

function stripSnapshotControlHintText(text: string): string {
	return text.replace(SNAPSHOT_HINT_TEXT_PATTERN, "");
}

function parseEditableAssignments(markerText: string): boolean | undefined {
	let hasPositiveAssignment = false;
	for (const match of markerText.matchAll(EDITABLE_ASSIGNMENT_TEXT_PATTERN)) {
		const key = match[1]?.toLowerCase();
		const evidence = parseEditableEvidenceValue(match[2]);
		if (evidence === false) {
			return false;
		}
		if (evidence === true && (key === "contenteditable" || key === "editable")) {
			hasPositiveAssignment = true;
		}
	}
	return hasPositiveAssignment ? true : undefined;
}

function parseEditableEvidenceText(text: string | undefined): boolean | undefined {
	if (text === undefined || text.length === 0) {
		return undefined;
	}
	const markerText = stripSnapshotControlHintText(stripLeadingSnapshotAccessibleName(text));
	if (EDITABLE_FALSE_TEXT_PATTERN.test(markerText)) {
		return false;
	}
	const assignment = parseEditableAssignments(markerText);
	if (assignment !== undefined) {
		return assignment;
	}
	return EDITABLE_BARE_TEXT_PATTERN.test(markerText) ? true : undefined;
}

function getStructuredEditableEvidence(
	ref: Readonly<Record<string, unknown>> | undefined,
): boolean | undefined {
	if (!ref) {
		return undefined;
	}
	let hasPositiveEvidence = false;
	for (const key of EDITABLE_REF_EVIDENCE_KEYS) {
		const evidence = parseEditableEvidenceValue(ref[key]);
		if (evidence === false) {
			return false;
		}
		if (evidence === true) {
			hasPositiveEvidence = true;
		}
	}
	return hasPositiveEvidence ? true : undefined;
}

export function getEditableRefEvidence(options: {
	readonly ref?: Readonly<Record<string, unknown>> | undefined;
	readonly text?: string | undefined;
}): boolean | undefined {
	const structuredEvidence = getStructuredEditableEvidence(options.ref);
	if (structuredEvidence === false) {
		return false;
	}
	let hasPositiveEvidence = structuredEvidence === true;
	const textEvidence = parseEditableEvidenceText(options.text);
	if (textEvidence === false) {
		return false;
	}
	if (textEvidence === true) {
		hasPositiveEvidence = true;
	}
	return hasPositiveEvidence ? true : undefined;
}
