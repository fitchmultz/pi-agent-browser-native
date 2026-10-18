import { boundElectronProbeString } from "../../electron/cdp.js";
import { normalizeProcessError } from "../../process-errors.js";
import { extractStringResultField, runSessionCommandData } from "../browser-run/session-state.js";
import type { ElectronManagedSessionInspection, ElectronProbeResult } from "./contracts.js";
import {
	ELECTRON_FOCUSED_ELEMENT_EVAL,
	extractElectronFocusedElement,
	extractElectronProbeTabs,
	summarizeElectronProbeSnapshot,
	getElectronProbeSummary,
} from "./probe-data.js";

interface ProbeCommandResult {
	readonly data?: unknown;
	readonly error?: string;
}
async function runElectronProbeCommandData(
	options: ElectronManagedSessionInspection & {
		readonly args: readonly string[];
		readonly stdin?: string;
	},
): Promise<ProbeCommandResult> {
	try {
		return {
			data: await runSessionCommandData({ ...options, pinNamespace: true, throwOnFailure: true }),
		};
	} catch (error) {
		return { error: normalizeProcessError(error).message };
	}
}
function probeCommandError(result: ProbeCommandResult, label: string): string | undefined {
	return result.error !== undefined && result.error.length > 0
		? `${label}: ${result.error}`
		: undefined;
}
export async function collectElectronProbe(
	options: ElectronManagedSessionInspection,
): Promise<ElectronProbeResult> {
	// Each read completes before the next: native session commands share a pending
	// slot, and the final snapshot owns the refs published by this probe.
	const urlResult = await runElectronProbeCommandData({ ...options, args: ["get", "url"] });
	const urlError = probeCommandError(urlResult, "get url");
	if (urlError !== undefined) {
		throw new Error(urlError);
	}
	const url =
		extractStringResultField(urlResult.data, "result") ??
		extractStringResultField(urlResult.data, "url");
	if (url === undefined || url.trim().length === 0) {
		throw new Error("get url returned no active page URL.");
	}
	const titleResult = await runElectronProbeCommandData({ ...options, args: ["get", "title"] });
	const focusedResult = await runElectronProbeCommandData({
		...options,
		args: ["eval", "--stdin"],
		stdin: ELECTRON_FOCUSED_ELEMENT_EVAL,
	});
	const tabsResult = await runElectronProbeCommandData({ ...options, args: ["tab", "list"] });
	const snapshotResult = await runElectronProbeCommandData({
		...options,
		args: ["snapshot", "-i"],
	});
	const errors = [
		probeCommandError(titleResult, "get title"),
		probeCommandError(focusedResult, "focused element"),
		probeCommandError(tabsResult, "tab list"),
		probeCommandError(snapshotResult, "snapshot"),
	]
		.filter((item): item is string => item !== undefined)
		.map((error) => boundElectronProbeString(error, 240) ?? "probe command failed");
	const { activeTab, tabs } = extractElectronProbeTabs(tabsResult.data);
	const { refSnapshot, snapshot } = summarizeElectronProbeSnapshot(snapshotResult.data);
	const probe: Omit<ElectronProbeResult, "summary"> = {
		activeTab,
		focusedElement: extractElectronFocusedElement(focusedResult.data),
		errors: errors.length > 0 ? errors : undefined,
		refSnapshot,
		sessionName: options.sessionName,
		snapshot,
		status: errors.length === 0 ? "succeeded" : "partial",
		tabs,
		title: boundElectronProbeString(
			extractStringResultField(titleResult.data, "result") ??
				extractStringResultField(titleResult.data, "title"),
			160,
		),
		url,
	};
	return { ...probe, summary: getElectronProbeSummary(probe) };
}
