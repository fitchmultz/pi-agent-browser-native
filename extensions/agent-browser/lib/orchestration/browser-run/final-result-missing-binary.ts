import {
	cleanupElectronLaunchResources,
	type ElectronCleanupResult,
} from "../../electron/cleanup.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { applyNamespaceToNextActions } from "../../results/next-actions.js";
import {
	buildManagedSessionFreshFailureNextActions,
	buildManagedSessionOutcome,
	formatManagedSessionOutcomeText,
} from "./session-state.js";
import type { AgentBrowserExecutionPlan, ManagedSessionOutcome } from "./types.js";
import type {
	PublicationInput as FinalResultInput,
	PublicationToolResult as AgentBrowserToolResult,
} from "./final-result-contracts.js";

export function buildMissingBinaryMessage(): string {
	return [
		"agent-browser is required but was not found on PATH.",
		"This project does not bundle agent-browser.",
		"Run `pi-agent-browser-doctor` for package/PATH diagnostics, then install agent-browser using the upstream docs:",
		"- https://agent-browser.dev/",
		"- https://github.com/vercel-labs/agent-browser",
	].join("\n");
}

export function isMissingAgentBrowserBinary(
	processResult: FinalResultInput["processResult"],
): processResult is FinalResultInput["processResult"] & { readonly spawnError: Error } {
	return processResult.spawnError?.message.includes("ENOENT") === true;
}

type MissingBinaryInput = Readonly<{
	compatibilityWorkaround?: FinalResultInput["compatibilityWorkaround"];
	electronLaunch?: FinalResultInput["electronLaunch"];
	executionPlan: AgentBrowserExecutionPlan;
	implicitSessionCloseTimeoutMs: number;
	managedSessionActive: boolean;
	managedSessionName: string;
	managedSessionNamespace?: string | undefined;
	processResult: FinalResultInput["processResult"];
	redactedArgs: readonly string[];
	redactedProcessArgs: readonly string[];
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: FinalResultInput["sessionTabCorrection"];
}>;

function missingBinaryOutcome(
	options: Pick<
		MissingBinaryInput,
		| "managedSessionActive"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "executionPlan"
		| "sessionMode"
	>,
): ManagedSessionOutcome | undefined {
	return buildManagedSessionOutcome({
		activeAfter: options.managedSessionActive,
		activeBefore: options.managedSessionActive,
		attemptedSessionName: options.executionPlan.managedSessionName,
		command: options.executionPlan.commandInfo.command,
		currentSessionName: options.managedSessionName,
		currentSessionNamespace: options.managedSessionNamespace,
		previousSessionName: options.managedSessionName,
		sessionMode: options.sessionMode,
		succeeded: false,
	});
}

function missingBinaryDetails(
	options: Pick<
		MissingBinaryInput,
		| "processResult"
		| "redactedArgs"
		| "compatibilityWorkaround"
		| "redactedProcessArgs"
		| "electronLaunch"
		| "executionPlan"
		| "sessionMode"
		| "sessionTabCorrection"
	> &
		Readonly<{ spawnError: string }>,
	managedSessionOutcome: ManagedSessionOutcome | undefined,
	cleanup: ElectronCleanupResult | undefined,
): Record<string, unknown> {
	const actions =
		applyNamespaceToNextActions(
			buildManagedSessionFreshFailureNextActions(managedSessionOutcome),
			options.executionPlan.namespace,
		) ?? [];
	const errorText = buildMissingBinaryMessage();
	return {
		agentBrowserStarted: options.processResult.agentBrowserStarted,
		args: options.redactedArgs,
		compatibilityWorkaround: options.compatibilityWorkaround,
		effectiveArgs: options.redactedProcessArgs,
		electron: cleanup?.record
			? {
					action: "launch",
					cleanup,
					launch: cleanup.record,
					status: "failed",
					targets: options.electronLaunch?.targets,
					version: options.electronLaunch?.version,
				}
			: undefined,
		managedSessionOutcome,
		namespace: options.executionPlan.namespace,
		nextActions: actions.length > 0 ? actions : undefined,
		sessionMode: options.sessionMode,
		sessionTabCorrection: options.sessionTabCorrection,
		...buildAgentBrowserResultCategoryDetails({
			args: options.redactedProcessArgs,
			command: options.executionPlan.commandInfo.command,
			errorText,
			failureCategory: "missing-binary",
			spawnError: options.spawnError,
			succeeded: false,
		}),
		spawnError: options.spawnError,
	};
}

export async function buildMissingBinaryFailureResult(
	options: MissingBinaryInput,
): Promise<AgentBrowserToolResult | undefined> {
	if (!isMissingAgentBrowserBinary(options.processResult)) {
		return undefined;
	}
	const spawnError = options.processResult.spawnError.message;
	const outcome = missingBinaryOutcome(options);
	const cleanup = options.electronLaunch
		? await cleanupElectronLaunchResources({
				child: options.electronLaunch.child,
				record: options.electronLaunch.record,
				timeoutMs: options.implicitSessionCloseTimeoutMs,
			})
		: undefined;
	const text = [
		buildMissingBinaryMessage(),
		formatManagedSessionOutcomeText(outcome),
		cleanup ? `Electron cleanup after failed attach: ${cleanup.summary}` : undefined,
	]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join("\n\n");
	return {
		content: [{ type: "text", text }],
		details: missingBinaryDetails({ ...options, spawnError }, outcome, cleanup),
		isError: true,
	};
}
