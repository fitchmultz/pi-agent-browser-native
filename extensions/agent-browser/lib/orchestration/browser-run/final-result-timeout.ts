import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { withOptionalSessionArgs } from "../../results/next-actions.js";
import type { PublicationInput as FinalResultInput } from "./final-result-contracts.js";

type TimeoutRecoveryInput = Pick<
	FinalResultInput,
	"executionPlan" | "timeoutPartialProgress" | "sessionMode" | "currentSessionTabTargetUnknown"
>;

function verifyTimeoutTarget(
	sessionName: string,
	stepIndex: number | undefined,
): AgentBrowserNextAction {
	return {
		id: "verify-page-target-after-timeout",
		params: {
			args: withOptionalSessionArgs(sessionName, ["batch", "--bail"]),
			stdin: JSON.stringify([
				["get", "url"],
				["snapshot", "-i"],
			]),
		},
		reason: `Verify the current URL, then inspect the page after timeout${stepIndex === undefined ? "" : ` before considering a retry of step ${stepIndex}`}.`,
		safety:
			"Fail-fast read-only recovery: snapshot runs only after get url succeeds, satisfying the wrapper page-target guard without trusting the planned URL.",
		tool: "agent_browser",
	};
}

function retryTimeoutStep(
	options: Pick<TimeoutRecoveryInput, "executionPlan" | "timeoutPartialProgress">,
	freshSessionAbandoned: boolean,
): AgentBrowserNextAction[] {
	const retry = options.timeoutPartialProgress?.retryStep?.retry;
	if (!retry) {
		return [];
	}
	const stepIndex = options.timeoutPartialProgress.retryStep.index;
	return [
		{
			id: "retry-timeout-step",
			params: freshSessionAbandoned
				? { ...retry, sessionMode: "fresh" }
				: {
						...retry,
						args: withOptionalSessionArgs(options.executionPlan.sessionName, [...retry.args]),
					},
			reason: freshSessionAbandoned
				? `Consider retrying the single timed-out step ${stepIndex} in a fresh browser session because the timed-out fresh session was not proven live.`
				: `Consider retrying the single timed-out step ${stepIndex} against the current browser session.`,
			safety:
				"Only read-only or idempotent timeout steps get executable retry args; inspect current page/artifact state before using the action.",
			tool: "agent_browser",
		},
	];
}

function verifyUnknownTimeoutTarget(
	options: Pick<
		TimeoutRecoveryInput,
		"executionPlan" | "timeoutPartialProgress" | "currentSessionTabTargetUnknown"
	>,
	freshSessionAbandoned: boolean,
): AgentBrowserNextAction[] {
	const sessionName = options.executionPlan.sessionName;
	if (
		options.currentSessionTabTargetUnknown === true &&
		!freshSessionAbandoned &&
		sessionName !== undefined &&
		sessionName.length > 0
	) {
		return [verifyTimeoutTarget(sessionName, options.timeoutPartialProgress?.retryStep?.index)];
	}
	return [];
}

function inspectTimeoutPage(
	options: Pick<TimeoutRecoveryInput, "executionPlan" | "timeoutPartialProgress">,
	freshSessionAbandoned: boolean,
): AgentBrowserNextAction[] {
	const sessionName = options.executionPlan.sessionName;
	if (
		!options.timeoutPartialProgress ||
		freshSessionAbandoned ||
		sessionName === undefined ||
		sessionName.length === 0
	) {
		return [];
	}
	const stepIndex = options.timeoutPartialProgress.retryStep?.index;
	return [
		{
			id: "inspect-current-page-after-timeout",
			params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
			reason: `Inspect the current page after timeout before deciding how to resume${stepIndex === undefined ? "" : ` with step ${stepIndex}`}.`,
			safety:
				"Read details.timeoutPartialProgress first. Do not blindly retry mutating steps such as clicks, fills, key presses, selects, or checks; split the remaining flow into shorter batches around the next navigation or DOM mutation boundary.",
			tool: "agent_browser",
		},
	];
}

export function buildTimeoutPartialProgressNextActions(
	options: TimeoutRecoveryInput,
): AgentBrowserNextAction[] {
	if (
		options.executionPlan.commandInfo.command === "session" &&
		options.executionPlan.commandInfo.subcommand === "info"
	) {
		return [];
	}
	const freshSessionAbandoned =
		options.sessionMode === "fresh" && options.timeoutPartialProgress?.liveUrlRecovered !== true;
	const verification = verifyUnknownTimeoutTarget(options, freshSessionAbandoned);
	if (verification.length > 0) {
		return verification;
	}
	const retry = retryTimeoutStep(options, freshSessionAbandoned);
	return retry.length > 0 ? retry : inspectTimeoutPage(options, freshSessionAbandoned);
}

export function buildDialogTimeoutNextActions(
	options: Readonly<{ command?: string | undefined; sessionName?: string | undefined }>,
): AgentBrowserNextAction[] {
	if (
		options.command === undefined ||
		!["dialog", "click", "tap", "find", "eval"].includes(options.command)
	) {
		return [];
	}
	return [
		{
			id: "inspect-dialog-after-timeout",
			params: { args: withOptionalSessionArgs(options.sessionName, ["dialog", "status"]) },
			reason:
				"Check whether a blocking JavaScript dialog is pending after the timed-out interaction.",
			safety:
				"Read-only dialog status; this wrapper bounds dialog commands so recovery attempts do not wait for the full default watchdog.",
			tool: "agent_browser",
		},
		{
			id: "dismiss-dialog-after-timeout",
			params: { args: withOptionalSessionArgs(options.sessionName, ["dialog", "dismiss"]) },
			reason:
				"Dismiss a pending alert/confirm/prompt when the workflow can safely abandon the dialog.",
			safety: "Only run when dismissing/canceling the dialog is acceptable for the user flow.",
			tool: "agent_browser",
		},
		{
			id: "recover-fresh-session-after-dialog-timeout",
			params: { args: ["open", "about:blank"], sessionMode: "fresh" },
			reason:
				"Start a clean browser session if the current session remains blocked behind a JavaScript dialog.",
			safety:
				"Replace about:blank with the intended recovery URL; this abandons the blocked managed session.",
			tool: "agent_browser",
		},
	];
}
