import type {
	ElectronCdpTarget,
	ElectronLaunchFailure,
	ElectronLaunchFailureDiagnostics,
	ElectronLaunchRecord,
} from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes/types.js";
import { boundElectronProbeString } from "../../electron/cdp.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { redactToolDetails } from "./final-result-redaction.js";
import type { ElectronManagedSessionTarget, ManagedSessionOutcome } from "./types.js";
import type {
	PublicationInput as FinalResultInput,
	PublicationToolResult as AgentBrowserToolResult,
} from "./final-result-contracts.js";

export function presentElectronManagedSessionTarget(
	target: ElectronManagedSessionTarget,
): ElectronManagedSessionTarget {
	return {
		...target,
		title: boundElectronProbeString(target.title, 160),
		url: boundElectronProbeString(target.url, 300),
	};
}

export function getElectronLaunchFailureCategory(
	failure: Pick<ElectronLaunchFailure, "reason">,
): "aborted" | "policy-blocked" | "timeout" | "upstream-error" | "validation-error" {
	switch (failure.reason) {
		case "aborted":
			return "aborted";
		case "policy-blocked":
			return "policy-blocked";
		case "timeout":
			return "timeout";
		case "non-electron-target":
			return "validation-error";
		case "port-not-found":
		case "single-instance-conflict":
		case "spawn-error":
			return "upstream-error";
	}
}

function pidState(pidAlive: boolean | undefined): string {
	if (pidAlive === undefined) {
		return "state unknown";
	}
	return pidAlive ? "alive before cleanup" : "not alive before cleanup";
}

function formatProcessDiagnostics(
	diagnostics: Readonly<
		Pick<ElectronLaunchFailureDiagnostics, "pid" | "pidAlive" | "exitCode" | "exitSignal">
	>,
): string[] {
	const lines: string[] = [];
	if (diagnostics.pid !== undefined) {
		lines.push(`- PID: ${diagnostics.pid} (${pidState(diagnostics.pidAlive)}).`);
	}
	if (diagnostics.exitCode !== undefined || diagnostics.exitSignal !== undefined) {
		const exitParts = [
			diagnostics.exitCode !== undefined ? `code ${String(diagnostics.exitCode)}` : undefined,
			diagnostics.exitSignal !== undefined &&
			diagnostics.exitSignal !== null &&
			diagnostics.exitSignal.length > 0
				? `signal ${diagnostics.exitSignal}`
				: undefined,
		]
			.filter(Boolean)
			.join(", ");
		lines.push(
			`- Process exit: ${exitParts.length > 0 ? exitParts : "not observed before cleanup"}.`,
		);
	}
	return lines;
}

function formatActivePort(
	activePort: Readonly<NonNullable<ElectronLaunchFailureDiagnostics["devToolsActivePort"]>>,
): string {
	const error =
		activePort.error !== undefined && activePort.error.length > 0 ? ` (${activePort.error})` : "";
	let state: string;
	if (activePort.port !== undefined && activePort.port !== 0) {
		state = `found port ${activePort.port}`;
	} else {
		state = activePort.found ? `found but invalid${error}` : `missing${error}`;
	}
	return `- DevToolsActivePort: ${state} at ${activePort.path}.`;
}

function formatConnectionDiagnostics(
	diagnostics: Readonly<
		Pick<
			ElectronLaunchFailureDiagnostics,
			| "userDataDir"
			| "devToolsActivePort"
			| "cdpVersionReached"
			| "timeoutMs"
			| "elapsedMs"
			| "outputCaptured"
		>
	>,
): string[] {
	const lines: string[] = [];
	if (diagnostics.userDataDir !== undefined && diagnostics.userDataDir.length > 0) {
		lines.push(`- Wrapper profile: ${diagnostics.userDataDir}`);
	}
	if (diagnostics.devToolsActivePort) {
		lines.push(formatActivePort(diagnostics.devToolsActivePort));
	}
	if (diagnostics.cdpVersionReached === false) {
		lines.push("- CDP /json/version: did not return a valid payload before timeout.");
	}
	if (diagnostics.timeoutMs !== undefined || diagnostics.elapsedMs !== undefined) {
		lines.push(
			`- Timing: ${diagnostics.elapsedMs ?? "unknown"}ms elapsed${diagnostics.timeoutMs !== undefined ? ` of ${diagnostics.timeoutMs}ms timeout` : ""}.`,
		);
	}
	if (!diagnostics.outputCaptured) {
		lines.push("- App stdout/stderr: not captured by this wrapper launch path.");
	}
	return lines;
}

function formatElectronLaunchFailureDiagnostics(
	failure: Readonly<ElectronLaunchFailure> | undefined,
): string | undefined {
	const diagnostics = failure?.diagnostics;
	if (!diagnostics) {
		return undefined;
	}
	const lines = [
		"Electron launch diagnostics:",
		...formatProcessDiagnostics(diagnostics),
		...formatConnectionDiagnostics(diagnostics),
	];
	if (failure.reason !== "aborted") {
		lines.push(
			"Retry guidance: increase electron.timeoutMs, try targetType:'any', pass an explicit appPath/executablePath, quit any already-running singleton instance, then retry launch.",
		);
	}
	return lines.join("\n");
}

export function buildElectronHostFailureResult(
	options: Readonly<{
		compiledElectron: CompiledAgentBrowserElectron;
		errorText: string;
		failureCategory?:
			| "aborted"
			| "cleanup-failed"
			| "policy-blocked"
			| "timeout"
			| "upstream-error"
			| "validation-error";
		launchFailure?: ElectronLaunchFailure;
		managedSessionOutcome?: ManagedSessionOutcome;
		status?: string;
	}>,
): AgentBrowserToolResult {
	const text = [
		options.errorText,
		formatElectronLaunchFailureDiagnostics(options.launchFailure),
		options.launchFailure?.cleanupError !== undefined &&
		options.launchFailure.cleanupError.length > 0
			? `Electron launch cleanup warning: ${options.launchFailure.cleanupError}`
			: undefined,
	]
		.filter((item): item is string => item !== undefined && item.length > 0)
		.join("\n");
	const details = {
		args: [],
		compiledElectron: options.compiledElectron,
		electron: {
			action: options.compiledElectron.action,
			error: options.errorText,
			failure: options.launchFailure,
			status: options.status ?? "failed",
		},
		managedSessionOutcome: options.managedSessionOutcome,
		...buildAgentBrowserResultCategoryDetails({
			args: [],
			errorText: options.errorText,
			failureCategory: options.failureCategory,
			succeeded: false,
			timedOut: options.failureCategory === "timeout",
		}),
		summary: options.errorText,
	};
	return {
		content: [{ type: "text", text: redactSensitiveText(text) }],
		details: redactToolDetails(details, []),
		isError: true,
	};
}

export function formatElectronTargetLines(
	targets: readonly Readonly<ElectronCdpTarget>[],
	limit = 8,
): string[] {
	const shownTargets = targets.slice(0, limit);
	const lines = shownTargets.map((target) => {
		const typeTitle = [target.type, target.title].filter(Boolean).join(" ");
		const fallback = target.id === undefined || target.id.length === 0 ? "target" : target.id;
		const label = typeTitle.length > 0 ? typeTitle : fallback;
		return `- ${label}${target.url !== undefined && target.url.length > 0 ? ` — ${target.url}` : ""}`;
	});
	if (targets.length > shownTargets.length) {
		lines.push(`- ... ${targets.length - shownTargets.length} more target(s) omitted`);
	}
	return lines;
}

function formatSnapshotHandoff(handoff: NonNullable<FinalResultInput["electronHandoff"]>): string {
	if (handoff.refSnapshot && handoff.refSnapshot.refIds.length > 0) {
		const retries = handoff.snapshotRetryCount;
		return `Snapshot handoff: ${handoff.refSnapshot.refIds.length} interactive ref(s)${retries !== undefined && retries !== 0 ? ` after ${retries} retry attempt(s)` : ""}.`;
	}
	return "Snapshot handoff: no interactive refs returned after a short readiness retry; run snapshot -i once more before assuming the Electron UI is unusable.";
}

function formatHandoffText(handoff: FinalResultInput["electronHandoff"]): string | undefined {
	switch (handoff?.handoff) {
		case "snapshot":
			return formatSnapshotHandoff(handoff);
		case "tabs":
			return "Tabs handoff completed: safer diagnostic starting point; no interactive refs were captured.";
		case "connect":
			return "Connect handoff completed: run snapshot -i before using interactive refs.";
		case undefined:
			return undefined;
	}
}

export function formatElectronLaunchText(
	options: Readonly<{
		handoff?: FinalResultInput["electronHandoff"];
		record: Readonly<ElectronLaunchRecord>;
		targets: readonly Readonly<ElectronCdpTarget>[];
		upstreamText: string;
	}>,
): string {
	const lines = [
		`Electron launch: ${options.record.appName} attached as ${options.record.sessionName ?? "managed session"} (launchId ${options.record.launchId}, port ${options.record.port}).`,
		`Identifiers: launchId ${options.record.launchId} for electron.status/electron.cleanup/electron.probe; sessionName ${options.record.sessionName ?? "not attached"} for browser snapshot/tab commands.`,
		"Profile note: electron.launch starts an isolated temporary profile; it does not reuse the app's normal signed-in profile or attach to an already-running authenticated app.",
		"For already-authenticated desktop app content, do not stop here: if host tools are allowed and the app is not running, launch the normal app with --remote-debugging-port=<port>, verify the port, then run agent_browser connect <port>; if it is already running without a debug port, ask before relaunching it.",
		...formatElectronTargetLines(options.targets),
	];
	const handoffText = formatHandoffText(options.handoff);
	if (handoffText !== undefined) {
		lines.push(handoffText);
	}
	lines.push(
		`Cleanup: use details.nextActions cleanup-electron-launch or call electron.cleanup with launchId ${options.record.launchId} when finished.`,
	);
	if (options.handoff?.error !== undefined && options.handoff.error.length > 0) {
		lines.push(`Handoff warning: ${options.handoff.error}`);
	}
	if (options.upstreamText.trim().length > 0) {
		lines.push("", options.upstreamText.trim());
	}
	return lines.join("\n");
}
