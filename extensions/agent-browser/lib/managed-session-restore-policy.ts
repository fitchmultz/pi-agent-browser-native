import { extractUpstreamCommandTokens, parseCommandInfo } from "./argv-descriptor.js";
import {
	extractExplicitNamespace,
	extractExplicitSessionName,
	isUpstreamEnvFlagEnabled,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import {
	hasLaunchScopedFlagToken,
	MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_FLAGS,
} from "./launch-scoped-flags.js";
import {
	ensureManagedSessionRestoreStorageIsSecure,
	hasManagedSessionRestoreProjectIdentity,
	resolveManagedSessionRestoreHome,
} from "./managed-session-storage.js";
import { isNativeBatchOption, parseUserBatchStdin } from "./orchestration/batch-stdin.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import type { ManagedSessionRestoreState } from "./managed-session-restore-state.js";
import { ownedContextMatches } from "./owned-managed-session-context.js";
export const AGENT_BROWSER_CONFIG_ENV = "AGENT_BROWSER_CONFIG";
export const AGENT_BROWSER_RESTORE_ENV = "AGENT_BROWSER_RESTORE";
export const MANAGED_SESSION_RESTORE_ENV = "PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE";
export interface ManagedSessionRestorePolicyOptions {
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly parentEnv?: NodeJS.ProcessEnv;
	readonly stdin?: string;
	readonly wrapperInjectedUserAgent?: boolean;
}
export interface ManagedSessionRestoreEnvOptions extends ManagedSessionRestorePolicyOptions {
	readonly cwd: string;
	readonly ownedManagedSession?: boolean;
	readonly restoreState?: ManagedSessionRestoreState;
}
export function isDisabledEnvFlag(value: string | undefined): boolean {
	return value !== undefined && ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
export function hasUpstreamEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): boolean {
	return env?.[name] !== undefined;
}
function hasExplicitConfigArg(args: readonly string[]): boolean {
	return scanUpstreamGlobalFlagOccurrences(args, "--config").length > 0;
}
export function closesBrowserSession(args: readonly string[]): boolean {
	return ["close", "exit", "quit"].includes(parseCommandInfo(args).command ?? "");
}
export function agentBrowserExplicitConfigIsPresent(
	parentEnv: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment(),
	args: readonly string[] = [],
): boolean {
	return hasExplicitConfigArg(args) || hasUpstreamEnvValue(parentEnv, AGENT_BROWSER_CONFIG_ENV);
}
/** Caller-selected config disables automatic restore injection without blocking native config. */
export function agentBrowserConfigBlocksManagedRestore(
	parentEnv: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment(),
	args: readonly string[] = [],
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		(resolveManagedSessionRestoreHome(parentEnv, platform) ?? "").length === 0 ||
		agentBrowserExplicitConfigIsPresent(parentEnv, args)
	);
}
function omitWrapperInjectedUserAgent(
	args: readonly string[],
	enabled: boolean | undefined,
): string[] {
	if (enabled !== true) {
		return [...args];
	}
	const index = args.indexOf("--user-agent");
	return index < 0 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
}
function batchHasManagedSessionRestoreConflict(
	args: readonly string[],
	stdin: string | undefined,
): boolean {
	const [command, ...commandArgs] = extractUpstreamCommandTokens(args);
	if (command !== "batch") {
		return false;
	}
	if (commandArgs.some((token) => !isNativeBatchOption(token))) {
		return true;
	}
	const parsed = parseUserBatchStdin(stdin);
	if ((parsed.error !== undefined && parsed.error.length > 0) || !parsed.steps) {
		return false;
	}
	return parsed.steps.some((step) =>
		["connect", "batch"].includes(parseCommandInfo(step).command ?? ""),
	);
}
function hasLaunchConflict(options: ManagedSessionRestorePolicyOptions): boolean {
	const effectiveEnv = {
		...(options.parentEnv ?? getAgentBrowserProcessEnvironment()),
		...options.env,
	};
	const args = omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent);
	if (MANAGED_RESTORE_INCOMPATIBLE_ENVS.some((name) => hasUpstreamEnvValue(effectiveEnv, name))) {
		return true;
	}
	if (
		MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) =>
			isUpstreamEnvFlagEnabled(effectiveEnv[name]),
		)
	) {
		return true;
	}
	if (MANAGED_RESTORE_INCOMPATIBLE_FLAGS.some((flag) => hasLaunchScopedFlagToken(args, flag))) {
		return true;
	}
	if (
		parseCommandInfo(args).command === "connect" ||
		batchHasManagedSessionRestoreConflict(args, options.stdin)
	) {
		return true;
	}
	return agentBrowserExplicitConfigIsPresent(effectiveEnv, args);
}
export function managedSessionRestoreOptedOut(
	options: ManagedSessionRestorePolicyOptions,
): boolean {
	return isDisabledEnvFlag(
		{ ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env }[
			MANAGED_SESSION_RESTORE_ENV
		],
	);
}
function lacksProjectStorage(
	options: ManagedSessionRestorePolicyOptions,
	env: NodeJS.ProcessEnv,
): boolean {
	if (options.cwd === undefined || options.cwd.length === 0) {
		return false;
	}
	return (
		!hasManagedSessionRestoreProjectIdentity(options.cwd) ||
		agentBrowserConfigBlocksManagedRestore(
			env,
			omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent),
		)
	);
}
export function isManagedSessionRestoreIncompatible(
	options: ManagedSessionRestorePolicyOptions,
	namespace = extractExplicitNamespace(options.args),
): boolean {
	if (hasLaunchConflict(options)) {
		return true;
	}
	if (managedSessionRestoreOptedOut(options)) {
		return false;
	}
	const env = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	return (
		lacksProjectStorage(options, env) ||
		!ensureManagedSessionRestoreStorageIsSecure(env, process.platform, namespace)
	);
}
export function resolveManagedSessionRestorePolicy(
	options: ManagedSessionRestoreEnvOptions,
): Readonly<{
	namespace?: string;
	owned: boolean;
	ownedContext: ReturnType<typeof ownedContextMatches>;
	parentEnv: NodeJS.ProcessEnv;
	restoreState?: ManagedSessionRestoreState;
	sessionName?: string;
}> {
	const parentEnv = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	const sessionName = extractExplicitSessionName(options.args);
	const ownedContext = ownedContextMatches(sessionName, options.args);
	const namespace = ownedContext ? ownedContext.namespace : extractExplicitNamespace(options.args);
	const restoreState = ownedContext?.restoreState ?? options.restoreState;
	const owned =
		(options.ownedManagedSession === true || ownedContext !== undefined) &&
		restoreState !== undefined;
	return { namespace, owned, ownedContext, parentEnv, restoreState, sessionName };
}
export function resolveExplicitAutosaveInterval(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const defaultInterval = "30000";
	if (!/^\+?\d+$/.test(value)) {
		return defaultInterval;
	}
	try {
		const parsed = BigInt(value);
		return parsed <= 18_446_744_073_709_551_615n ? parsed.toString() : defaultInterval;
	} catch {
		return defaultInterval;
	}
}
