import type { OpenResultTabCorrection } from "./runtime-contracts.js";
import { normalizeComparableUrl } from "./session-page-observation.js";

interface Tab {
	readonly active?: boolean;
	readonly index?: number;
	readonly label?: string | undefined;
	readonly tabId?: string | undefined;
	readonly title?: string | undefined;
	readonly url?: string | undefined;
}

function normalizeTabSelectionValue(value: string | undefined): string | undefined {
	const normalizedValue = value?.trim();
	return normalizedValue !== undefined && normalizedValue.length > 0 ? normalizedValue : undefined;
}

function extractTabSelection(
	tab: Tab,
): Pick<OpenResultTabCorrection, "selectedTab" | "selectionKind"> | undefined {
	const tabId = normalizeTabSelectionValue(tab.tabId);
	if (tabId !== undefined) {
		return { selectedTab: tabId, selectionKind: "tabId" };
	}
	const label = normalizeTabSelectionValue(tab.label);
	if (label !== undefined) {
		return { selectedTab: label, selectionKind: "label" };
	}
	if (typeof tab.index === "number" && Number.isInteger(tab.index) && tab.index >= 0) {
		return { selectedTab: String(tab.index), selectionKind: "index" };
	}
	return;
}

function selectMatchingTab(
	tabs: readonly Tab[],
	targetTitle: string | undefined,
):
	| {
			readonly selection?:
				| Pick<OpenResultTabCorrection, "selectedTab" | "selectionKind">
				| undefined;
			readonly targetTitle?: string | undefined;
	  }
	| undefined {
	const first = tabs[0];
	if (first === undefined) {
		return undefined;
	}
	const title = typeof targetTitle === "string" ? targetTitle.trim() : "";
	const titledMatch =
		title.length === 0
			? undefined
			: tabs.find((tab) => typeof tab.title === "string" && tab.title.trim() === title);
	return {
		selection: extractTabSelection(titledMatch ?? first),
		targetTitle: title.length > 0 ? title : undefined,
	};
}

export function chooseOpenResultTabCorrection(options: {
	readonly activeTabIndex?: number;
	readonly tabs: readonly Tab[];
	readonly targetTitle?: string | undefined;
	readonly targetUrl?: string | undefined;
}): OpenResultTabCorrection | undefined {
	const normalizedTargetUrl =
		typeof options.targetUrl === "string" ? normalizeComparableUrl(options.targetUrl) : undefined;
	if (normalizedTargetUrl === undefined) {
		return;
	}
	const tabsWithIndices = options.tabs.map((tab, index) => ({
		...tab,
		index: typeof tab.index === "number" ? tab.index : index,
		label: normalizeTabSelectionValue(tab.label),
		tabId: normalizeTabSelectionValue(tab.tabId),
	}));
	const activeTab =
		tabsWithIndices.find((tab) => tab.active === true) ??
		tabsWithIndices.find((tab) => tab.index === options.activeTabIndex);
	if (activeTab && normalizeComparableUrl(activeTab.url ?? "") === normalizedTargetUrl) {
		return;
	}
	const matchingTabs = tabsWithIndices.filter(
		(tab) => normalizeComparableUrl(tab.url ?? "") === normalizedTargetUrl,
	);
	const match = selectMatchingTab(matchingTabs, options.targetTitle);
	return match?.selection
		? { ...match.selection, targetTitle: match.targetTitle, targetUrl: normalizedTargetUrl }
		: undefined;
}
