import { setTimeout as sleepMs } from "node:timers/promises";

import { boundElectronProbeString } from "../../electron/cdp.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { buildNextToolAction, withOptionalSessionArgs } from "../../results/next-actions.js";
import { extractRefSnapshotFromData, type SessionTabTarget } from "../../session-page-state.js";
import { extractStringResultField, runSessionCommandData } from "./session-state.js";
import { diagnosticErrorText } from "./diagnostic-values.js";
import { presentElectronManagedSessionTarget } from "./final-result-electron.js";
import type {
	ElectronHandoffSummary,
	ElectronManagedSessionTarget,
	QaAttachedPreconditionFailure,
	QaAttachedTarget,
} from "./observation-types.js";

interface SessionObservationOptions {
	readonly cwd: string;
	readonly namespace?: string;
	readonly sessionName: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

function sessionResult(data: unknown, field: "title" | "url"): string | undefined {
	return extractStringResultField(data, "result") ?? extractStringResultField(data, field);
}

async function collectManagedSessionCommandData(
	options: SessionObservationOptions & {
		readonly args: readonly string[];
	},
): Promise<{ readonly data?: unknown; readonly error?: string }> {
	try {
		return { data: await runSessionCommandData({ ...options, pinNamespace: true }) };
	} catch (error) {
		return { error: diagnosticErrorText(error) };
	}
}

async function collectElectronManagedSessionUrl(options: SessionObservationOptions): Promise<{
	readonly error?: string;
	readonly url?: string;
}> {
	const urlResult = await collectManagedSessionCommandData({ ...options, args: ["get", "url"] });
	const url = sessionResult(urlResult.data, "url");
	return urlResult.error !== undefined && urlResult.error !== ""
		? { error: urlResult.error }
		: { url };
}

export async function collectElectronManagedSessionTarget(options: {
	readonly cwd: string;
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}): Promise<ElectronManagedSessionTarget | undefined> {
	if (options.sessionName === undefined || options.sessionName === "") {
		return undefined;
	}
	const request = { ...options, sessionName: options.sessionName };
	const urlResult = await collectManagedSessionCommandData({ ...request, args: ["get", "url"] });
	const url = sessionResult(urlResult.data, "url");
	if ((urlResult.error ?? "") !== "" || url === undefined || url.trim() === "") {
		return {
			error: urlResult.error ?? "get url returned no active page URL.",
			sessionName: options.sessionName,
		};
	}
	const titleResult = await collectManagedSessionCommandData({
		...request,
		args: ["get", "title"],
	});
	const title = boundElectronProbeString(sessionResult(titleResult.data, "title"), 160);
	return {
		sessionName: options.sessionName,
		title,
		url,
		...(titleResult.error !== undefined && titleResult.error !== ""
			? { error: titleResult.error }
			: {}),
	};
}

export async function collectQaAttachedTarget(options: {
	readonly currentTarget?: SessionTabTarget;
	readonly cwd: string;
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly signal?: AbortSignal;
}): Promise<QaAttachedTarget | undefined> {
	if (options.sessionName === undefined || options.sessionName === "") {
		return undefined;
	}
	const target = options.currentTarget;
	if (target && ((target.title ?? "") !== "" || target.url !== "")) {
		return {
			sessionName: options.sessionName,
			title: target.title,
			url: target.url,
		};
	}
	const observed = await collectElectronManagedSessionTarget({
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	return observed ? presentElectronManagedSessionTarget(observed) : undefined;
}

export function formatQaAttachedTargetText(
	target: QaAttachedTarget | undefined,
): string | undefined {
	return target
		? ["QA attached target:", target.sessionName, target.title, target.url]
				.filter((part) => typeof part === "string" && part.length > 0)
				.join(" — ")
		: undefined;
}

function buildQaAttachedRecoveryNextActions(
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	return [
		buildNextToolAction({
			args: withOptionalSessionArgs(sessionName, ["tab", "list"]),
			id: "list-tabs-before-qa-attached",
			reason: "Inspect the connected session tabs before retrying qa.attached.",
			safety: "Read-only tab listing for the attached session.",
		}),
		buildNextToolAction({
			args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]),
			id: "snapshot-before-qa-attached",
			reason: "Capture interactive refs on the active page before retrying qa.attached.",
			safety: "Read-only snapshot; confirms a renderable page is selected.",
		}),
	];
}

export async function validateQaAttachedPrecondition(options: {
	readonly cwd: string;
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly signal?: AbortSignal;
}): Promise<QaAttachedPreconditionFailure | undefined> {
	if (options.sessionName === undefined || options.sessionName === "") {
		return {
			error: "qa.attached requires an active attached session with a resolvable session name.",
			nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
		};
	}
	const urlProbe = await collectElectronManagedSessionUrl({
		...options,
		sessionName: options.sessionName,
	});
	if (urlProbe.error !== undefined && urlProbe.error !== "") {
		return {
			error: `qa.attached could not read the attached session URL: ${urlProbe.error}. Run tab list or snapshot -i before retrying qa.attached.`,
			nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
		};
	}
	const url = urlProbe.url?.trim();
	return url === undefined || url === ""
		? {
				error:
					"qa.attached requires an attached session with a readable page URL. Run tab list, select a stable tab, then snapshot -i before retrying.",
				nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
			}
		: undefined;
}

interface ElectronHandoffOptions {
	readonly cwd: string;
	readonly handoff: "connect" | "snapshot" | "tabs";
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly signal?: AbortSignal;
}

async function verifyHandoffUrl(options: ElectronHandoffOptions): Promise<void> {
	const urlData = await runSessionCommandData({
		args: ["get", "url"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		throwOnFailure: true,
	});
	if (options.signal?.aborted ?? false) {
		throw new Error("Electron handoff was aborted.");
	}
	const url =
		extractStringResultField(urlData, "result") ?? extractStringResultField(urlData, "url");
	if (url === undefined || url === "") {
		throw new Error("Electron handoff get url returned no active page URL.");
	}
}

async function collectHandoffTabs(options: ElectronHandoffOptions): Promise<unknown> {
	const tabs = await runSessionCommandData({
		args: ["tab", "list"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		throwOnFailure: true,
	});
	if (options.signal?.aborted ?? false) {
		throw new Error("Electron handoff was aborted.");
	}
	return tabs;
}

async function collectHandoffSnapshot(
	options: ElectronHandoffOptions,
): Promise<Pick<ElectronHandoffSummary, "refSnapshot" | "snapshot" | "snapshotRetryCount">> {
	let snapshot = await runSessionCommandData({
		args: ["snapshot", "-i"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		throwOnFailure: true,
	});
	let refSnapshot = extractRefSnapshotFromData(snapshot);
	let snapshotRetryCount = 0;
	while (needsSnapshotRetry(refSnapshot) && snapshotRetryCount < 2) {
		if (options.signal?.aborted ?? false) {
			throw new Error("Electron handoff was aborted.");
		}
		snapshotRetryCount += 1;
		// Renderer startup must settle before retrying the native snapshot.
		// oxlint-disable-next-line no-await-in-loop
		await sleepMs(250);
		if (options.signal?.aborted ?? false) {
			throw new Error("Electron handoff was aborted.");
		}
		// Each retry uses the prior snapshot result and the same session identity.
		// oxlint-disable-next-line no-await-in-loop
		snapshot = await runSessionCommandData({
			args: ["snapshot", "-i"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
			throwOnFailure: true,
		});
		refSnapshot = extractRefSnapshotFromData(snapshot);
	}
	return { refSnapshot, snapshot, ...(snapshotRetryCount > 0 ? { snapshotRetryCount } : {}) };
}

function needsSnapshotRetry(snapshot: ReturnType<typeof extractRefSnapshotFromData>): boolean {
	return snapshot === undefined || snapshot.refIds.length === 0;
}

export async function collectElectronHandoff(
	options: ElectronHandoffOptions,
): Promise<ElectronHandoffSummary> {
	if (options.handoff === "connect") {
		return { handoff: "connect" };
	}
	if (options.signal?.aborted ?? false) {
		throw new Error("Electron handoff was aborted.");
	}
	await verifyHandoffUrl(options);
	const tabs = await collectHandoffTabs(options);
	return options.handoff === "tabs"
		? { handoff: "tabs", tabs }
		: { handoff: "snapshot", ...(await collectHandoffSnapshot(options)), tabs };
}
