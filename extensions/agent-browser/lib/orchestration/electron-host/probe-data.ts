import { boundElectronProbeString } from "../../electron/cdp.js";
import { isRecord } from "../../parsing.js";
import { extractRefSnapshotFromData, type SessionRefSnapshot } from "../../session-page-state.js";
import type {
	ElectronProbeFocusedElement,
	ElectronProbeTab,
	ElectronProbeResult,
	ElectronProbeSnapshotSummary,
} from "./contracts.js";

export const ELECTRON_FOCUSED_ELEMENT_EVAL = `(() => {
	const clean = (value, max = 80) => {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > max ? normalized.slice(0, max - 3) + "..." : normalized;
	};
	const describeElement = (element) => {
	if (!element || !(element instanceof Element)) return undefined;
	const tagName = element.tagName.toLowerCase();
	const inputLike = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
	const contentEditable = element instanceof HTMLElement && element.isContentEditable;
	const containerLike = tagName === "body" || tagName === "html";
	const rawText = element.textContent || "";
	const exposeText = !inputLike && !contentEditable && !containerLike;
	const text = exposeText ? clean(rawText) : undefined;
	return {
		tagName: clean(tagName, 40),
		role: clean(element.getAttribute("role") || "", 60),
		name: clean(element.getAttribute("aria-label") || element.getAttribute("title") || text || "", 80),
		id: clean(element.id || "", 80),
		type: clean(element.getAttribute("type") || "", 40),
		placeholder: clean(element.getAttribute("placeholder") || "", 80),
		ariaLabel: clean(element.getAttribute("aria-label") || "", 80),
		title: clean(element.getAttribute("title") || "", 80),
		textLength: !exposeText && rawText ? rawText.length : undefined,
		textPreview: text,
		valueLength: inputLike && typeof element.value === "string" ? element.value.length : undefined,
		isContentEditable: contentEditable || undefined,
	};
	};
	return { focusedElement: describeElement(document.activeElement) };
})()`;
const ELECTRON_PROBE_MAX_TABS = 6;
const ELECTRON_PROBE_MAX_REF_IDS = 20;
const ELECTRON_PROBE_MAX_SNAPSHOT_LINES = 12;
const ELECTRON_PROBE_MAX_SNAPSHOT_CHARS = 1_600;
function getTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" ? boundElectronProbeString(value) : undefined;
}
function getOptionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
function getOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function focusedElementPayload(data: unknown): Readonly<Record<string, unknown>> | undefined {
	const payload = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(payload)) {
		return;
	}
	return isRecord(payload.focusedElement) ? payload.focusedElement : payload;
}
export function extractElectronFocusedElement(
	data: unknown,
): ElectronProbeFocusedElement | undefined {
	const raw = focusedElementPayload(data);
	if (!raw) {
		return;
	}
	const focusedElement: ElectronProbeFocusedElement = {
		ariaLabel: getTrimmedString(raw.ariaLabel),
		id: getTrimmedString(raw.id),
		isContentEditable: getOptionalBoolean(raw.isContentEditable),
		name: getTrimmedString(raw.name),
		placeholder: getTrimmedString(raw.placeholder),
		role: getTrimmedString(raw.role),
		tagName: getTrimmedString(raw.tagName),
		textLength: getOptionalNumber(raw.textLength),
		textPreview: getTrimmedString(raw.textPreview),
		title: getTrimmedString(raw.title),
		type: getTrimmedString(raw.type),
		valueLength: getOptionalNumber(raw.valueLength),
	};
	return Object.values(focusedElement).some((value) => value !== undefined)
		? focusedElement
		: undefined;
}
function rawProbeTabs(data: unknown): readonly unknown[] {
	if (isRecord(data) && Array.isArray(data.tabs)) {
		return data.tabs;
	}
	return Array.isArray(data) ? data : [];
}
export function extractElectronProbeTabs(data: unknown): {
	readonly activeTab?: ElectronProbeTab;
	readonly tabs?: ElectronProbeResult["tabs"];
} {
	const allTabs = rawProbeTabs(data)
		.filter(isRecord)
		.map((tab, index): ElectronProbeTab => ({
			active: getOptionalBoolean(tab.active),
			index: typeof tab.index === "number" && Number.isInteger(tab.index) ? tab.index : index,
			tabId: getTrimmedString(tab.tabId) ?? getTrimmedString(tab.id),
			title: getTrimmedString(tab.title) ?? getTrimmedString(tab.label),
			type: getTrimmedString(tab.type),
			url: typeof tab.url === "string" ? tab.url : undefined,
		}));
	if (allTabs.length === 0) {
		return {};
	}
	const shown = allTabs.slice(0, ELECTRON_PROBE_MAX_TABS);
	return {
		activeTab: allTabs.find((tab) => tab.active === true) ?? allTabs[0],
		tabs: {
			omittedCount: allTabs.length > shown.length ? allTabs.length - shown.length : undefined,
			shown,
			total: allTabs.length,
		},
	};
}
function truncateElectronProbeSnapshotText(snapshotText: string | undefined): {
	readonly lineCount: number;
	readonly omittedLineCount?: number;
	readonly text?: string;
} {
	if (snapshotText === undefined || snapshotText.length === 0) {
		return { lineCount: 0 };
	}
	const lines = snapshotText.split(/\r?\n/);
	const shownLines: string[] = [];
	let usedChars = 0;
	for (const line of lines) {
		if (shownLines.length >= ELECTRON_PROBE_MAX_SNAPSHOT_LINES) {
			break;
		}
		const nextLength = usedChars + line.length + (shownLines.length > 0 ? 1 : 0);
		if (nextLength > ELECTRON_PROBE_MAX_SNAPSHOT_CHARS) {
			if (shownLines.length === 0) {
				shownLines.push(`${line.slice(0, ELECTRON_PROBE_MAX_SNAPSHOT_CHARS - 3)}...`);
			}
			break;
		}
		shownLines.push(line);
		usedChars = nextLength;
	}
	return {
		lineCount: lines.length,
		omittedLineCount:
			lines.length > shownLines.length ? lines.length - shownLines.length : undefined,
		text: shownLines.length > 0 ? shownLines.join("\n") : undefined,
	};
}
export function summarizeElectronProbeSnapshot(data: unknown): {
	readonly refSnapshot?: SessionRefSnapshot;
	readonly snapshot?: ElectronProbeSnapshotSummary;
} {
	const refSnapshot = extractRefSnapshotFromData(data);
	const rawSnapshotText = isRecord(data) ? getTrimmedString(data.snapshot) : undefined;
	const truncated = truncateElectronProbeSnapshotText(rawSnapshotText);
	const refIds = refSnapshot?.refIds ?? [];
	const shownRefIds = refIds.slice(0, ELECTRON_PROBE_MAX_REF_IDS);
	const hasSnapshot =
		refSnapshot !== undefined || (truncated.text !== undefined && truncated.text.length > 0);
	const snapshot = hasSnapshot
		? {
				lineCount: truncated.lineCount,
				omittedLineCount: truncated.omittedLineCount,
				omittedRefCount:
					refIds.length > shownRefIds.length ? refIds.length - shownRefIds.length : undefined,
				refCount: refIds.length,
				refIds: shownRefIds,
				text: truncated.text,
			}
		: undefined;
	return { refSnapshot, snapshot };
}
export function getElectronProbeSummary(probe: Omit<ElectronProbeResult, "summary">): string {
	const parts = [
		probe.title !== undefined && probe.title.length > 0 ? `title "${probe.title}"` : undefined,
		probe.url !== undefined && probe.url.length > 0
			? `url ${boundElectronProbeString(probe.url, 300) ?? ""}`
			: undefined,
		probe.focusedElement ? "focused element" : undefined,
		probe.tabs ? `${probe.tabs.total} tab(s)` : undefined,
		probe.snapshot ? `${probe.snapshot.refCount} ref(s)` : undefined,
	].filter((item): item is string => item !== undefined);
	return parts.length > 0
		? `Electron probe collected ${parts.join(", ")}.`
		: "Electron probe did not return current session state.";
}
