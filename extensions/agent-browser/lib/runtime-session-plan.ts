import {
	canonicalizeAgentBrowserNamespace,
	extractExplicitNamespace,
	extractExplicitSessionName,
	getAgentBrowserSessionIdentityKey,
	resolveAgentBrowserNamespace,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { LAUNCH_SCOPED_FLAG_LABEL } from "./launch-scoped-flags.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import type { ExecutionPlanOptions, SessionRecoveryHint } from "./runtime-contracts.js";

export interface SessionSelection {
	readonly argsToAppend: readonly string[];
	readonly prefixArgs: readonly string[];
	readonly namespace?: string | undefined;
	readonly managedSessionName?: string;
	readonly sessionName?: string | undefined;
	readonly usedImplicitSession: boolean;
	readonly recoveryHint?: SessionRecoveryHint;
	readonly validationError?: string;
}

export interface SessionCommand {
	readonly command?: string | undefined;
	readonly needsManagedSession: boolean;
	readonly startupScopedFlags: readonly string[];
}

type SessionOptions = Pick<
	ExecutionPlanOptions,
	| "freshSessionName"
	| "managedSessionActive"
	| "managedSessionName"
	| "managedSessionNamespace"
	| "sessionMode"
>;

export function stripExplicitIdentityArgs(
	args: readonly string[],
	flag: "--session" | "--namespace",
): string[] {
	const indices = new Set<number>();
	for (const occurrence of scanUpstreamGlobalFlagOccurrences(args, flag)) {
		indices.add(occurrence.index);
		indices.add(occurrence.index + 1);
	}
	return args.filter((_, index) => !indices.has(index));
}

export function freshSessionRecoveryHint(
	args: readonly string[],
	reason: string,
): SessionRecoveryHint {
	return {
		exampleArgs: args,
		exampleParams: { args, sessionMode: "fresh" },
		reason,
		recommendedSessionMode: "fresh",
	};
}

export function launchFlagsRecoveryReason(): string {
	return `Launch-scoped flags (${LAUNCH_SCOPED_FLAG_LABEL}) need a fresh upstream launch once the extension-managed session is already active.`;
}

function hasExplicitNamespace(args: readonly string[]): boolean {
	return scanUpstreamGlobalFlagOccurrences(args, "--namespace").length > 0;
}

function requestedNamespace(args: readonly string[]): string | undefined {
	return hasExplicitNamespace(args) ? (extractExplicitNamespace(args) ?? "") : undefined;
}

function nativeNamespace(args: readonly string[]): string | undefined {
	return resolveAgentBrowserNamespace(
		args,
		getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE,
	);
}

function explicitSessionSelection(
	args: readonly string[],
	sessionName: string,
	options: SessionOptions,
): SessionSelection {
	const explicitNamespace = hasExplicitNamespace(args);
	const managedNamespace = canonicalizeAgentBrowserNamespace(options.managedSessionNamespace);
	const targetsCurrent =
		options.managedSessionActive &&
		getAgentBrowserSessionIdentityKey(sessionName, managedNamespace) ===
			getAgentBrowserSessionIdentityKey(options.managedSessionName, managedNamespace);
	const fallbackNamespace = targetsCurrent ? managedNamespace : nativeNamespace(args);
	const namespace = explicitNamespace ? requestedNamespace(args) : fallbackNamespace;
	return {
		argsToAppend: explicitNamespace ? stripExplicitIdentityArgs(args, "--namespace") : args,
		prefixArgs: explicitNamespace ? ["--namespace", namespace ?? ""] : [],
		namespace,
		sessionName,
		usedImplicitSession: false,
	};
}

function namedManagedSelection(
	args: readonly string[],
	identity: { readonly sessionName: string; readonly namespace?: string | undefined },
	implicit: boolean,
	command: string | undefined,
): SessionSelection {
	const { namespace, sessionName } = identity;
	return {
		argsToAppend: hasExplicitNamespace(args)
			? stripExplicitIdentityArgs(args, "--namespace")
			: args,
		prefixArgs: [
			...(namespace === undefined ? [] : ["--namespace", namespace]),
			"--session",
			sessionName,
		],
		// Empty names retain native namespace reporting without changing the launch prefix.
		namespace:
			sessionName.length === 0 && command !== undefined && !hasExplicitNamespace(args)
				? nativeNamespace(args)
				: namespace,
		sessionName,
		managedSessionName: sessionName,
		usedImplicitSession: implicit,
	};
}

function implicitSessionSelection(
	args: readonly string[],
	options: SessionOptions,
	command: SessionCommand,
): SessionSelection {
	if (options.managedSessionActive && command.startupScopedFlags.length > 0) {
		return {
			argsToAppend: args,
			prefixArgs: [],
			namespace: command.command === undefined ? requestedNamespace(args) : nativeNamespace(args),
			usedImplicitSession: false,
			sessionName: extractExplicitSessionName(args),
			recoveryHint: freshSessionRecoveryHint(args, launchFlagsRecoveryReason()),
			validationError: [
				`The current extension-managed agent-browser session is already running, so launch-scoped flags ${command.startupScopedFlags.join(", ")} would replace or be ignored by upstream agent-browser.`,
				'Retry this call with `sessionMode: "fresh"` to force a fresh upstream launch, or pass an explicit `--session ...` if you want to name the new session yourself.',
			].join(" "),
		};
	}
	const namespace = hasExplicitNamespace(args)
		? requestedNamespace(args)
		: canonicalizeAgentBrowserNamespace(options.managedSessionNamespace);
	return namedManagedSelection(
		args,
		{ sessionName: options.managedSessionName, namespace },
		true,
		command.command,
	);
}

function unmanagedSessionSelection(
	args: readonly string[],
	command: string | undefined,
): SessionSelection {
	const explicitNamespace = hasExplicitNamespace(args);
	const namespace =
		command !== undefined && !explicitNamespace ? nativeNamespace(args) : requestedNamespace(args);
	return {
		argsToAppend: args,
		prefixArgs: [],
		namespace,
		sessionName: extractExplicitSessionName(args),
		usedImplicitSession: false,
	};
}

export function selectExecutionSession(
	args: readonly string[],
	options: SessionOptions,
	command: SessionCommand,
): SessionSelection {
	const explicitSession = extractExplicitSessionName(args);
	if (explicitSession !== undefined && explicitSession.length > 0) {
		return explicitSessionSelection(args, explicitSession, options);
	}
	if (command.needsManagedSession) {
		if (options.sessionMode === "auto") {
			return implicitSessionSelection(args, options, command);
		}
		if (command.command !== undefined && !isCloseCommand(command.command)) {
			return namedManagedSelection(
				args,
				{ sessionName: options.freshSessionName, namespace: requestedNamespace(args) },
				false,
				command.command,
			);
		}
	}
	return unmanagedSessionSelection(args, command.command);
}
