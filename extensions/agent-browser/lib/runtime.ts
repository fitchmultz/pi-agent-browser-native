import { parseArgvDescriptor, type CommandInfo } from "./argv-descriptor.js";
import {
	canonicalizeAgentBrowserNamespace,
	extractExplicitNamespace,
	extractExplicitSessionName,
	getAgentBrowserSessionIdentityKey,
	getBooleanFlagValue,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import { needsManagedSession } from "./command-policy.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { hasLaunchScopedFlagToken, LAUNCH_SCOPED_FLAG_DEFINITIONS } from "./launch-scoped-flags.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import {
	formatInvalidValueFlagError,
	getInvalidValueFlagDetails,
	isPlainTextInspectionArgs,
} from "./runtime-args-validation.js";
import {
	canUseHeadlessCompatibilityUserAgent,
	getCompatibilityWorkaround,
	getDefaultHeadlessCompatUserAgent,
} from "./runtime-compatibility.js";
import type {
	CompatibilityWorkaround,
	ExecutionPlan,
	ExecutionPlanOptions,
	SessionRecoveryHint,
} from "./runtime-contracts.js";
import {
	freshSessionRecoveryHint,
	launchFlagsRecoveryReason,
	selectExecutionSession,
	stripExplicitIdentityArgs,
	type SessionSelection,
} from "./runtime-session-plan.js";

export type { CommandInfo } from "./argv-descriptor.js";
export {
	extractCommandTokens,
	extractUpstreamCommandTokens,
	findCommandStartIndex,
	parseArgvDescriptor,
	parseCommandInfo,
	parseWaitCommandTokens,
} from "./argv-descriptor.js";
export type {
	SessionMode,
	SessionRecoveryHint,
	InvalidValueFlagDetails,
	CompatibilityWorkaround,
	OpenResultTabCorrection,
	ExecutionPlan,
	ManagedSessionState,
	RestoredManagedSessionState,
	ExecutionPlanOptions,
} from "./runtime-contracts.js";
export {
	redactSensitiveText,
	redactSensitiveValue,
	redactInvocationArgs,
} from "./runtime-redaction.js";
export {
	getImplicitSessionIdleTimeoutMs,
	getImplicitSessionCloseTimeoutMs,
} from "./runtime-timeouts.js";
export { isPlainTextInspectionArgs, validateToolArgs } from "./runtime-args-validation.js";
export {
	canUseHeadlessCompatibilityUserAgent,
	getDefaultHeadlessCompatUserAgent,
} from "./runtime-compatibility.js";
export {
	createEphemeralSessionSeed,
	createImplicitSessionName,
	createFreshSessionName,
	isRestorableManagedSessionName,
	resolveManagedSessionState,
} from "./runtime-session-identity.js";
export { restoreManagedSessionStateFromBranch } from "./runtime-session-replay.js";
export { chooseOpenResultTabCorrection } from "./runtime-tab-correction.js";

export function getStartupScopedFlags(args: readonly string[]): string[] {
	return LAUNCH_SCOPED_FLAG_DEFINITIONS.map((definition) => definition.flag).filter((flag) =>
		hasLaunchScopedFlagToken(args, flag),
	);
}

function withNativeSession(args: readonly string[]): readonly string[] {
	const nativeSession = getAgentBrowserProcessEnvironment().AGENT_BROWSER_SESSION;
	if (
		nativeSession !== undefined &&
		!isPlainTextInspectionArgs(args) &&
		extractExplicitSessionName(args) === undefined
	) {
		return ["--session", nativeSession, ...args];
	}
	return args;
}

function jsonPrefix(args: readonly string[]): string[] {
	return getBooleanFlagValue(args, "--json") === undefined ? ["--json"] : [];
}

function planningFailure(args: readonly string[]): ExecutionPlan | undefined {
	const invalidValueFlag = getInvalidValueFlagDetails(args);
	const repeatedFlag = ["--session", "--namespace"].find(
		(flag) => scanUpstreamGlobalFlagOccurrences(args, flag).length > 1,
	);
	if (!invalidValueFlag && repeatedFlag === undefined) {
		return;
	}
	const validationError = invalidValueFlag
		? formatInvalidValueFlagError(invalidValueFlag)
		: `Multiple ${repeatedFlag ?? ""} flags are not supported. Pass a single ${repeatedFlag ?? ""} value; upstream uses the last occurrence while this wrapper would otherwise mis-attribute managed-session ownership.`;
	const plan = {
		commandInfo: {},
		effectiveArgs: jsonPrefix(args),
		plainTextInspection: false,
		startupScopedFlags: [],
		usedImplicitSession: false,
		validationError,
	};
	return invalidValueFlag ? { ...plan, invalidValueFlag } : plan;
}

function effectiveStartupFlags(
	args: readonly string[],
	managedNamespace: string | undefined,
): string[] {
	const explicitNamespacePresent =
		scanUpstreamGlobalFlagOccurrences(args, "--namespace").length > 0;
	const explicitNamespace = extractExplicitNamespace(args);
	return getStartupScopedFlags(args).filter(
		(flag) =>
			!(
				flag === "--namespace" &&
				explicitNamespacePresent &&
				explicitNamespace === canonicalizeAgentBrowserNamespace(managedNamespace)
			),
	);
}

function targetsActiveManagedSession(
	selection: SessionSelection,
	options: ExecutionPlanOptions,
	needsSession: boolean,
): boolean {
	const { sessionName } = selection;
	return (
		options.managedSessionActive &&
		needsSession &&
		sessionName !== undefined &&
		sessionName.length > 0 &&
		getAgentBrowserSessionIdentityKey(sessionName, selection.namespace) ===
			getAgentBrowserSessionIdentityKey(options.managedSessionName, options.managedSessionNamespace)
	);
}

interface LaunchRecovery {
	readonly recoveryHint?: SessionRecoveryHint;
	readonly validationError?: string;
}

function activeLaunchRecovery(
	args: readonly string[],
	flags: readonly string[],
	command: string | undefined,
	prior: LaunchRecovery,
): LaunchRecovery {
	if (
		flags.length === 0 ||
		isCloseCommand(command) ||
		(prior.validationError !== undefined && prior.validationError.length > 0)
	) {
		return prior;
	}
	const explicitSession = extractExplicitSessionName(args);
	const explicit = explicitSession !== undefined && explicitSession.length > 0;
	const recoveryArgs = explicit ? stripExplicitIdentityArgs(args, "--session") : args;
	return {
		recoveryHint: freshSessionRecoveryHint(recoveryArgs, launchFlagsRecoveryReason()),
		validationError: [
			`The current extension-managed agent-browser session is already running, so launch-scoped flags ${flags.join(", ")} would replace or be ignored by upstream agent-browser.`,
			explicit
				? 'Remove the explicit `--session` and retry with `sessionMode: "fresh"` to force a fresh upstream launch.'
				: 'Retry this call with `sessionMode: "fresh"` to force a fresh upstream launch.',
		].join(" "),
	};
}

interface CompatibilityPlan extends LaunchRecovery {
	readonly compatibilityWorkaround?: CompatibilityWorkaround | undefined;
}

function activeCompatibilityPlan(
	args: readonly string[],
	requested: CompatibilityWorkaround | undefined,
	existing: CompatibilityWorkaround | undefined,
	prior: LaunchRecovery,
): CompatibilityPlan {
	if (!canUseHeadlessCompatibilityUserAgent(args)) {
		return { ...prior, compatibilityWorkaround: requested };
	}
	if (
		requested &&
		!existing &&
		(prior.validationError === undefined || prior.validationError.length === 0)
	) {
		const sessionName = extractExplicitSessionName(args);
		const explicit = sessionName !== undefined && sessionName.length > 0;
		const recoveryArgs = explicit ? stripExplicitIdentityArgs(args, "--session") : args;
		return {
			compatibilityWorkaround: undefined,
			recoveryHint: freshSessionRecoveryHint(
				recoveryArgs,
				"The requested site compatibility user agent is launch-scoped and needs a fresh browser session.",
			),
			validationError: explicit
				? 'The current extension-managed agent-browser session is already running without the user agent required by this site. Remove the explicit `--session` and retry with `sessionMode: "fresh"` so the compatibility user agent is applied at launch.'
				: 'The current extension-managed agent-browser session is already running without the user agent required by this site. Retry this call with `sessionMode: "fresh"` so the compatibility user agent is applied at launch.',
		};
	}
	return { ...prior, compatibilityWorkaround: requested ?? existing };
}

function inspectionPlan(
	args: readonly string[],
	commandInfo: CommandInfo,
	startupScopedFlags: readonly string[],
): ExecutionPlan {
	const explicitNamespacePresent =
		scanUpstreamGlobalFlagOccurrences(args, "--namespace").length > 0;
	return {
		commandInfo,
		effectiveArgs: [...args],
		namespace: explicitNamespacePresent ? (extractExplicitNamespace(args) ?? "") : undefined,
		plainTextInspection: true,
		startupScopedFlags,
		usedImplicitSession: false,
	};
}

export function buildExecutionPlan(
	inputArgs: readonly string[],
	options: ExecutionPlanOptions,
): ExecutionPlan {
	const args = withNativeSession(inputArgs);
	const startupScopedFlags = effectiveStartupFlags(args, options.managedSessionNamespace);
	const descriptor = parseArgvDescriptor(args);
	const commandInfo = descriptor.commandInfo;
	if (isPlainTextInspectionArgs(args)) {
		return inspectionPlan(args, commandInfo, startupScopedFlags);
	}
	const failure = planningFailure(args);
	if (failure) {
		return failure;
	}
	const needsSession =
		options.browserIndependentReadConfirmation !== true &&
		needsManagedSession(descriptor, options.stdin);
	const selection = selectExecutionSession(args, options, {
		command: commandInfo.command,
		needsManagedSession: needsSession,
		startupScopedFlags,
	});
	const activeTarget = targetsActiveManagedSession(selection, options, needsSession);
	const requested = getCompatibilityWorkaround(args, commandInfo);
	const recovery = activeTarget
		? activeLaunchRecovery(args, startupScopedFlags, commandInfo.command, selection)
		: selection;
	const compatibility = activeTarget
		? activeCompatibilityPlan(
				args,
				requested,
				options.managedSessionCompatibilityWorkaround,
				recovery,
			)
		: { ...recovery, compatibilityWorkaround: requested };
	const effectiveArgs = [...jsonPrefix(args), ...selection.prefixArgs];
	if (compatibility.compatibilityWorkaround && !activeTarget) {
		effectiveArgs.push("--user-agent", getDefaultHeadlessCompatUserAgent());
	}
	effectiveArgs.push(...selection.argsToAppend);
	return {
		commandInfo,
		compatibilityWorkaround: compatibility.compatibilityWorkaround,
		effectiveArgs,
		managedSessionName: selection.managedSessionName,
		namespace: selection.namespace,
		plainTextInspection: false,
		recoveryHint: compatibility.recoveryHint,
		sessionName: selection.sessionName,
		startupScopedFlags,
		usedImplicitSession: selection.usedImplicitSession,
		validationError: compatibility.validationError,
	};
}
