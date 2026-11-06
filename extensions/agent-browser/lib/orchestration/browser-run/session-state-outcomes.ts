import { isCloseCommand } from "../../command-taxonomy.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import {
	buildNextToolAction,
	withOptionalNamespaceArgs,
	withOptionalSessionArgs,
} from "../../results/next-actions.js";
import type { ManagedSessionOutcome } from "./types.js";

type OutcomeFacts = Readonly<{
	activeAfter: boolean;
	activeBefore: boolean;
	attemptedSessionName?: string | undefined;
	command?: string | undefined;
	currentSessionName: string;
	currentSessionNamespace?: string | undefined;
	previousSessionName: string;
	replacedSessionName?: string | undefined;
	replacedSessionNamespace?: string | undefined;
	sessionMode: "auto" | "fresh";
	succeeded: boolean;
}>;
type OutcomeDescription = Pick<ManagedSessionOutcome, "status" | "summary">;

function describeClose(
	facts: Pick<OutcomeFacts, "succeeded" | "activeBefore" | "previousSessionName">,
	attemptedSessionName: string,
): OutcomeDescription {
	if (facts.succeeded) {
		return { status: "closed", summary: `Managed session ${attemptedSessionName} was closed.` };
	}
	if (facts.activeBefore) {
		return {
			status: "preserved",
			summary: `Managed session close failed; previous managed session ${facts.previousSessionName} remains current.`,
		};
	}
	return {
		status: "abandoned",
		summary: "Managed session close failed; no managed session is active.",
	};
}

function describeSuccessfulLaunch(
	facts: Pick<
		OutcomeFacts,
		"replacedSessionName" | "currentSessionName" | "activeBefore" | "activeAfter"
	>,
): OutcomeDescription {
	if ((facts.replacedSessionName?.length ?? 0) > 0) {
		return {
			status: "replaced",
			summary: `Managed session ${facts.replacedSessionName ?? ""} was replaced by ${facts.currentSessionName}.`,
		};
	}
	if (!facts.activeBefore && facts.activeAfter) {
		return {
			status: "created",
			summary: `Managed session ${facts.currentSessionName} is now current.`,
		};
	}
	return {
		status: "unchanged",
		summary: `Managed session ${facts.currentSessionName} remains current.`,
	};
}

function describeFailedLaunch(
	facts: Pick<OutcomeFacts, "activeBefore" | "sessionMode" | "previousSessionName">,
	attemptedSessionName: string,
): OutcomeDescription {
	if (facts.activeBefore) {
		const summary =
			facts.sessionMode === "fresh" && attemptedSessionName !== facts.previousSessionName
				? `Fresh managed session ${attemptedSessionName} failed before becoming current; previous managed session ${facts.previousSessionName} was preserved.`
				: `Managed session call failed; previous managed session ${facts.previousSessionName} was preserved.`;
		return { status: "preserved", summary };
	}
	return {
		status: "abandoned",
		summary:
			facts.sessionMode === "fresh"
				? `Fresh managed session ${attemptedSessionName} failed before becoming current; no previous managed session was active, so no managed session is current.`
				: "Managed session call failed before any managed session became current.",
	};
}

export function buildManagedSessionOutcome(facts: OutcomeFacts): ManagedSessionOutcome | undefined {
	const attemptedSessionName = facts.attemptedSessionName;
	if (attemptedSessionName === undefined || attemptedSessionName.length === 0) {
		return;
	}
	let description: OutcomeDescription;
	if (isCloseCommand(facts.command)) {
		description = describeClose(facts, attemptedSessionName);
	} else if (facts.succeeded) {
		description = describeSuccessfulLaunch(facts);
	} else {
		description = describeFailedLaunch(facts, attemptedSessionName);
	}
	return {
		activeAfter: facts.activeAfter,
		activeBefore: facts.activeBefore,
		attemptedSessionName,
		currentSessionName: facts.currentSessionName,
		...((facts.currentSessionNamespace?.length ?? 0) > 0
			? { currentSessionNamespace: facts.currentSessionNamespace }
			: {}),
		previousSessionName: facts.previousSessionName,
		replacedSessionName: facts.replacedSessionName,
		replacedSessionNamespace: facts.replacedSessionNamespace,
		sessionMode: facts.sessionMode,
		succeeded: facts.succeeded,
		...description,
	};
}

function isFreshPostLaunchFailure(outcome: ManagedSessionOutcome): boolean {
	return (
		!outcome.succeeded &&
		outcome.sessionMode === "fresh" &&
		outcome.activeAfter &&
		outcome.currentSessionName.length > 0 &&
		["created", "replaced", "unchanged"].includes(outcome.status)
	);
}

function formatOutcomeHeadline(outcome: ManagedSessionOutcome): string {
	if (outcome.status === "preserved") {
		return "Managed session outcome: Fresh launch failed; your previous browser session is still active.";
	}
	if (outcome.status === "abandoned") {
		return "Managed session outcome: Fresh launch failed; no managed browser session is current.";
	}
	if (isFreshPostLaunchFailure(outcome)) {
		return "Managed session outcome: Fresh launch became current, but this tool call failed after launch.";
	}
	return `Managed session outcome: ${outcome.summary}`;
}

function formatRecoveryGuidance(outcome: ManagedSessionOutcome): string {
	const lines = ["Recovery:"];
	if (outcome.status === "preserved") {
		lines.push(
			'- Continue with sessionMode "auto" on the current session, or retry the intended launch with sessionMode "fresh".',
			"- Run doctor to verify agent-browser install and environment when failures persist.",
		);
	} else if (outcome.status === "abandoned") {
		lines.push(
			'- Retry with sessionMode "fresh" (for example args: ["open", "<url>"]) after verifying agent-browser is on PATH.',
			"- Run doctor when install or environment issues are suspected.",
		);
	} else if (isFreshPostLaunchFailure(outcome)) {
		lines.push(
			'- Continue with sessionMode "auto" on the current session, or inspect failureCategory / qaPreset to fix the post-launch failure.',
			"- Run doctor only if later browser commands also fail.",
		);
	} else {
		lines.push(
			'- Retry with sessionMode "fresh" when launch-scoped flags must apply, or run doctor to verify the environment.',
		);
	}
	lines.push(
		"- Full session names and transition details remain in details.managedSessionOutcome.",
	);
	return lines.join("\n");
}

export function formatManagedSessionOutcomeText(
	outcome: ManagedSessionOutcome | undefined,
): string | undefined {
	if (!outcome) {
		return;
	}
	if (outcome.replacedSessionClosed === false) {
		const cleanupWarning =
			"Cleanup warning: Automatic close of the previous wrapper-managed session failed, so it remains wrapper-owned. Use details.managedSessionOutcome for its exact identity and close it explicitly when safe.";
		return outcome.succeeded
			? ["Managed session outcome: The fresh browser became current.", cleanupWarning].join("\n")
			: [formatOutcomeHeadline(outcome), formatRecoveryGuidance(outcome), cleanupWarning].join(
					"\n",
				);
	}
	if (outcome.status === "closed" && outcome.succeeded) {
		return [
			"Managed session outcome: The current wrapper-managed browser session was closed.",
			"Next sessionMode auto call will start or attach a managed session as needed. If upstream session list still shows rows, they are separate saved/upstream sessions; use close --all only when full cleanup is intended.",
			"Full session names and transition details remain in details.managedSessionOutcome.",
		].join("\n");
	}
	if (outcome.succeeded || outcome.sessionMode !== "fresh") {
		return;
	}
	return [formatOutcomeHeadline(outcome), formatRecoveryGuidance(outcome)].join("\n");
}

function currentSessionRecovery(outcome: ManagedSessionOutcome): AgentBrowserNextAction[] {
	const sessionLabel = isFreshPostLaunchFailure(outcome)
		? "current managed session"
		: "preserved managed session";
	const identityArgs = withOptionalNamespaceArgs(
		outcome.currentSessionNamespace,
		withOptionalSessionArgs(outcome.currentSessionName, []),
	);
	return [
		buildNextToolAction({
			args: [...identityArgs, "get", "url"],
			id: "verify-current-managed-session",
			reason: `Confirm the ${sessionLabel} before continuing with sessionMode auto.`,
			safety: `Read-only URL check on the ${sessionLabel}.`,
		}),
		buildNextToolAction({
			args: [...identityArgs, "snapshot", "-i"],
			id: "snapshot-current-managed-session",
			reason: `Refresh interactive refs on the ${sessionLabel} before retrying the workflow.`,
			safety: "Read-only snapshot; no navigation.",
		}),
	];
}

export function buildManagedSessionFreshFailureNextActions(
	outcome: ManagedSessionOutcome | undefined,
): AgentBrowserNextAction[] {
	if (!outcome || outcome.succeeded || outcome.sessionMode !== "fresh") {
		return [];
	}
	const actions: AgentBrowserNextAction[] = [];
	if (!isFreshPostLaunchFailure(outcome)) {
		actions.push(
			buildNextToolAction({
				args: ["doctor"],
				id: "run-agent-browser-doctor",
				reason: "Verify agent-browser install, PATH, and environment after a failed fresh launch.",
				safety: "Read-only local diagnostics; does not mutate browser state.",
			}),
		);
	}
	if (
		(outcome.status === "preserved" || isFreshPostLaunchFailure(outcome)) &&
		outcome.activeAfter &&
		outcome.currentSessionName.length > 0
	) {
		actions.push(...currentSessionRecovery(outcome));
	} else {
		actions.push(
			buildNextToolAction({
				args: ["open", "about:blank"],
				id: "retry-fresh-managed-session",
				reason: "Start a new managed browser session after the failed fresh launch.",
				safety: "Replace about:blank with the intended URL from your workflow.",
				sessionMode: "fresh",
			}),
		);
	}
	return actions;
}
