import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgvDescriptor } from "./argv-descriptor.js";
import { needsManagedSession } from "./command-policy.js";
import { getScreenshotPathTokenIndex } from "./orchestration/browser-run/artifact-paths.js";
import { getUpstreamEffectiveBatchSteps, type BatchCommandStep, parseBatchCommandArgument, parseUserBatchStdin } from "./orchestration/batch-stdin.js";
import { isUnverifiedPageTransitionCommand } from "./command-taxonomy.js";
import {
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	VALUE_FLAGS,
	extractExplicitSessionName,
	isUpstreamEnvFlagEnabled,
	optionalGlobalValueFlagConsumesNext,
} from "./argv-grammar.js";
import { extractManagedSessionRestoreKeys, isWrapperManagedSessionName } from "./managed-session-capabilities.js";
import { agentBrowserExplicitConfigIsPresent } from "./managed-session-restore.js";
import { hasManagedSessionRestoreProjectIdentity } from "./managed-session-storage.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";

const BLOCKED_GLOBAL_STATE_MESSAGE = "This operation could read or modify wrapper-owned browser state outside the current checkout. Use a caller-owned state name or path instead.";
const BLOCKED_MANAGED_BROWSER_FILE_MESSAGE = "Browser access to local .agent-browser storage is blocked because state files can contain authenticated cookies and storage. Use guarded state commands instead.";
const BLOCKED_MANAGED_SESSION_MESSAGE = "This session name is reserved for a browser managed by this extension instance. Use the current managed session or a caller-owned session name instead.";
const FILE_ACCESS_FLAG_MESSAGE = "Browser file-access enablement is blocked because a local page could read and exfiltrate authenticated .agent-browser state.";
const UPSTREAM_CONFIG_MESSAGE = "Explicit upstream agent-browser config from --config or AGENT_BROWSER_CONFIG is blocked for browser-backed native calls because it can load protected state, profiles, extensions, or file-access settings. Remove that override and pass safe settings explicitly. Passive agent-browser.json files are ignored through the wrapper's protected empty config.";
const UNVERIFIED_PAGE_MESSAGE = "The active page became unverified after a tab, attachment, history, script, or state-load transition. Run get url or navigate explicitly to a safe URL before page-content inspection.";
const BATCH_UNVERIFIED_PAGE_MESSAGE = `${UNVERIFIED_PAGE_MESSAGE} In a batch, put get url after the transition before later content steps, or split the batch at that boundary.`;
const UNSAFE_BATCH_ARGUMENT_MESSAGE = "Batch command arguments could not be safely inspected. Use batch stdin JSON command arrays instead.";
const NESTED_BATCH_ARGUMENT_MESSAGE = "Nested batch commands are blocked by the wrapper's page-state safety policy. Flatten the batch steps instead.";
const NON_BAIL_BATCH_NAVIGATION_MESSAGE = "Batches that navigate before page-content access must use exact batch --bail so a failed navigation cannot expose the prior page.";
const MAX_NON_BAIL_BATCH_PAGE_STATES = 64;
const EXPLICIT_NAVIGATION_COMMANDS = new Set(["a11y", "goto", "navigate", "open", "pushstate", "visit", "vitals", "web-vitals"]);
const FILE_PATH_GLOBAL_FLAGS = ["--action-policy", "--ca-cert", "--config", "--download-path", "--executable-path", "--extension", "--init-script", "--profile", "--screenshot-dir", "--state"] as const;
const FILE_PATH_ENV_VARIABLES = [
	"AGENT_BROWSER_ACTION_POLICY",
	"AGENT_BROWSER_CA_CERT",
	"AGENT_BROWSER_CONFIG",
	"AGENT_BROWSER_DOWNLOAD_PATH",
	"AGENT_BROWSER_EXECUTABLE_PATH",
	"AGENT_BROWSER_PROFILE",
	"AGENT_BROWSER_SCREENSHOT_DIR",
	"AGENT_BROWSER_SKILLS_DIR",
	"AGENT_BROWSER_SOCKET_DIR",
	"AGENT_BROWSER_STATE",
] as const;
const FILE_PATH_LIST_ENV_VARIABLES = ["AGENT_BROWSER_EXTENSIONS", "AGENT_BROWSER_INIT_SCRIPTS"] as const;
const POSITIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, "--llms"]);

function decodeUrlComponent(value: string): string {
	let decoded = value;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded;
}

function hasAgentBrowserPathComponent(value: string): boolean {
	return decodeUrlComponent(value).replaceAll("\\", "/").toLowerCase().split("/").some((component) => {
		const windowsCanonicalComponent = component.replace(/^[a-z]:/i, "").split(":", 1)[0]?.replace(/[. ]+$/g, "");
		return windowsCanonicalComponent === ".agent-browser";
	});
}

function getFileUrlPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmedValue = value.replaceAll(/[\t\n\r]/g, "").trim();
	const nestedFileUrl = /^(?:(?:blob|filesystem|view-source):)*(file:.*)$/i.exec(trimmedValue)?.[1];
	if (!nestedFileUrl) return undefined;
	try {
		return fileURLToPath(new URL(nestedFileUrl));
	} catch {
		try {
			return decodeUrlComponent(new URL(nestedFileUrl).pathname);
		} catch {
			return trimmedValue;
		}
	}
}

export function isFileUrl(value: string | undefined): boolean {
	return getFileUrlPath(value) !== undefined;
}

function resolveThroughExistingAncestor(path: string): string | undefined {
	const suffix: string[] = [];
	let current = path;
	for (;;) {
		try {
			return resolve(realpathSync(current), ...suffix.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			suffix.push(basename(current));
			current = parent;
		}
	}
}

export function isProtectedAgentBrowserFileTarget(value: string | undefined, cwd: string): boolean {
	if (!value) return false;
	const filePath = getFileUrlPath(value);
	const windowsDrivePath = /^[a-z]:/i.test(value);
	const windowsAbsolutePath = /^[a-z]:[\\/]/i.test(value);
	const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !windowsDrivePath;
	if (hasScheme && filePath === undefined) return false;
	const pathValue = filePath ?? (isAbsolute(value) || windowsAbsolutePath ? value : resolve(cwd, value));
	if (hasAgentBrowserPathComponent(pathValue)) return true;
	const resolvedPath = resolveThroughExistingAncestor(pathValue);
	return resolvedPath !== undefined && hasAgentBrowserPathComponent(resolvedPath);
}

export function getAgentBrowserStoragePathValidationError(value: string | undefined, cwd: string): string | undefined {
	return isProtectedAgentBrowserFileTarget(value, cwd) ? BLOCKED_MANAGED_BROWSER_FILE_MESSAGE : undefined;
}

export function getObservedBrowserPageValidationError(args: string[], observedUrl: string | undefined, cwd: string): string | undefined {
	if (!isFileUrl(observedUrl)) return undefined;
	if (isProtectedAgentBrowserFileTarget(observedUrl, cwd)) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command === "get" && descriptor.commandInfo.subcommand === "url") return undefined;
	const explicitTarget = getExplicitNavigationTarget(args);
	return explicitTarget !== undefined && isFileUrl(explicitTarget) && !isProtectedAgentBrowserFileTarget(explicitTarget, cwd)
		? undefined
		: BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
}

function getPositionalOperands(commandTokens: string[]): string[] {
	const values: string[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (!token) continue;
		if (token.includes("=") && token.startsWith("-")) continue;
		if (POSITIONAL_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token)) {
			if (["true", "false"].includes(commandTokens[index + 1] ?? "")) index += 1;
			continue;
		}
		if (!token.startsWith("-") || token.includes("/") || token.includes("\\")) values.push(token);
	}
	return values;
}

function getExplicitNavigationTarget(args: string[]): string | undefined {
	const descriptor = parseArgvDescriptor(args);
	const positionals = getPositionalOperands(descriptor.upstreamCommandTokens);
	if (EXPLICIT_NAVIGATION_COMMANDS.has(descriptor.commandInfo.command ?? "")) return positionals[0];
	if (descriptor.commandInfo.command === "tab" && descriptor.commandInfo.subcommand === "new") return positionals[1];
	return undefined;
}

function getResultingExplicitNavigationTarget(args: string[], currentPageUrl?: string): string | undefined {
	const target = getExplicitNavigationTarget(args);
	if (target === undefined) return undefined;
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command !== "pushstate") return target;
	try {
		return new URL(target).href;
	} catch {
		if (!currentPageUrl) return undefined;
		try {
			return new URL(target, currentPageUrl).href;
		} catch {
			return undefined;
		}
	}
}

function getBrowserContentUrlOperands(args: string[]): string[] {
	const descriptor = parseArgvDescriptor(args);
	const command = descriptor.commandInfo.command;
	const positionals = getPositionalOperands(descriptor.upstreamCommandTokens);
	if (["a11y", "read", "vitals", "web-vitals"].includes(command ?? "")) return positionals.slice(0, 1);
	if (command === "auth" && descriptor.commandInfo.subcommand === "login") return getFlagValues(descriptor.upstreamCommandTokens, "--url", true);
	if (command === "diff" && descriptor.commandInfo.subcommand === "url") return positionals.slice(1, 3);
	if (command === "record" && ["start", "restart"].includes(descriptor.commandInfo.subcommand ?? "")) return positionals.slice(2, 3);
	return [];
}

function trimUnicodeWhitespace(value: string): string {
	return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

function getRawBrowserArgsValues(args: string[], env: NodeJS.ProcessEnv): Array<string | undefined> {
	const values = [env.AGENT_BROWSER_ARGS];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith("--args=")) values.push(token.slice("--args=".length));
		else if (token === "--args") values.push(args[++index]);
	}
	return values;
}

function getRawBrowserFileOperands(args: string[], env: NodeJS.ProcessEnv): string[] {
	return getRawBrowserArgsValues(args, env).flatMap((value) => value?.split(/[,\r\n]/).flatMap((rawToken) => {
		const token = trimUnicodeWhitespace(rawToken);
		const equalsIndex = token.indexOf("=");
		return equalsIndex < 0 ? [token] : [token, token.slice(equalsIndex + 1)];
	}) ?? []);
}

function getBrowserFileEnvOperands(env: NodeJS.ProcessEnv): Array<string | undefined> {
	return [
		...FILE_PATH_ENV_VARIABLES.map((name) => env[name] === undefined ? undefined : trimUnicodeWhitespace(env[name])),
		...FILE_PATH_LIST_ENV_VARIABLES.flatMap((name) => env[name]?.split(/[,\r\n]/).map(trimUnicodeWhitespace) ?? []),
	];
}

function getBrowserFileOperands(args: string[], env: NodeJS.ProcessEnv): string[] {
	const descriptor = parseArgvDescriptor(args);
	const command = descriptor.commandInfo.command;
	const subcommand = descriptor.commandInfo.subcommand;
	const positionals = getPositionalOperands(descriptor.upstreamCommandTokens);
	const values = [
		getExplicitNavigationTarget(args),
		...getBrowserContentUrlOperands(args),
		...FILE_PATH_GLOBAL_FLAGS.flatMap((flag) => getFlagValues(args, flag, true)),
		...getBrowserFileEnvOperands(env),
		...getRawBrowserFileOperands(args, env),
	];
	if (command === "read") values.push(positionals[0]);
	if (command === "upload") values.push(...positionals.slice(1));
	if (command === "download") values.push(...positionals.slice(1));
	if (command === "pdf") values.push(positionals[0]);
	if (command === "screenshot") {
		const pathIndex = getScreenshotPathTokenIndex(descriptor.upstreamCommandTokens);
		values.push(pathIndex === undefined ? undefined : descriptor.upstreamCommandTokens[pathIndex]);
	}
	if (["profiler", "trace"].includes(command ?? "") && subcommand === "stop") values.push(...positionals.slice(1));
	if (command === "network" && subcommand === "har") values.push(...positionals.slice(2));
	if (command === "wait") values.push(...getFlagValues(descriptor.upstreamCommandTokens, "--download", true), ...getFlagValues(descriptor.upstreamCommandTokens, "-d", true));
	if (command === "cookies" && subcommand === "set") values.push(...getFlagValues(descriptor.upstreamCommandTokens, "--curl", true));
	if (command === "state" && ["load", "rename", "save", "show"].includes(subcommand ?? "")) values.push(...positionals.slice(1));
	if (command === "diff" && subcommand === "url") values.push(...positionals.slice(1));
	if (command === "diff") values.push(...getFlagValues(descriptor.upstreamCommandTokens, "--baseline", true), ...getFlagValues(descriptor.upstreamCommandTokens, "--output", true), ...getFlagValues(descriptor.upstreamCommandTokens, "-o", true));
	if (command === "record" && ["start", "restart"].includes(subcommand ?? "")) values.push(...positionals.slice(1));
	return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function rawBrowserArgsEnableFileAccess(args: string[], env: NodeJS.ProcessEnv): boolean {
	return getRawBrowserArgsValues(args, env).some((value) => typeof value === "string" && /(?:^|[,\p{White_Space}])--(?:allow-file-access(?:-from-files)?|disable-web-security)(?=$|[=,\p{White_Space}])/iu.test(value));
}

function fileAccessFlagIsEnabled(args: string[], env: NodeJS.ProcessEnv): boolean {
	let enabled = isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_ALLOW_FILE_ACCESS);
	for (let index = 0; index < args.length; index += 1) {
		if (args[index]?.startsWith("--allow-file-access=") && !args[index]?.endsWith("=false")) {
			enabled = true;
			continue;
		}
		if (args[index] !== "--allow-file-access") continue;
		const value = args[index + 1];
		enabled = value !== "false";
		if (value === "true" || value === "false") index += 1;
	}
	return enabled;
}

function getManagedBrowserFileAccessValidationError(options: {
	allowUnverifiedPageTransitions?: boolean;
	args: string[];
	currentPageUrl?: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	pageUrlUnknown?: boolean;
	stdin?: string;
	trustedBatchTabSelection?: boolean;
}): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	const command = descriptor.commandInfo.command;
	const subcommand = descriptor.commandInfo.subcommand;
	const explicitTarget = getResultingExplicitNavigationTarget(options.args, options.currentPageUrl);
	const closesPage = ["close", "exit", "quit"].includes(command ?? "") || (command === "tab" && subcommand === "close");
	const safelyInspectsPageTarget = (command === "tab" && subcommand === "list") || (command === "get" && subcommand === "url");
	const safelySelectsUnverifiedTab = command === "tab" && subcommand !== undefined && !["close", "list", "new"].includes(subcommand);
	const safelyTransitionsUnverifiedPage = options.allowUnverifiedPageTransitions === true
		&& command !== "eval"
		&& isUnverifiedPageTransitionCommand(command, subcommand);
	const safelyLeavesPage = explicitTarget !== undefined && !isFileUrl(explicitTarget) && !isProtectedAgentBrowserFileTarget(explicitTarget, options.cwd);
	if (fileAccessFlagIsEnabled(options.args, options.env) || rawBrowserArgsEnableFileAccess(options.args, options.env)) return FILE_ACCESS_FLAG_MESSAGE;
	if (getBrowserContentUrlOperands(options.args).some(isFileUrl)) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	if (getBrowserFileOperands(options.args, options.env).some((value) => isProtectedAgentBrowserFileTarget(value, options.cwd))) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	if (command === "eval" && options.stdin !== undefined && /(?:\.agent-browser|%2eagent-browser)/i.test(options.stdin)) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	if (options.pageUrlUnknown && !closesPage && !safelyInspectsPageTarget && !safelySelectsUnverifiedTab && !safelyTransitionsUnverifiedPage && !safelyLeavesPage && !(options.trustedBatchTabSelection && command === "tab")) return UNVERIFIED_PAGE_MESSAGE;
	if (isProtectedAgentBrowserFileTarget(options.currentPageUrl, options.cwd) && !closesPage && !safelyInspectsPageTarget && !safelyLeavesPage) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	if (isFileUrl(options.currentPageUrl) && !closesPage && !safelyInspectsPageTarget && !safelyLeavesPage) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	return undefined;
}

// Deliberately unions raw argv steps AND parseable stdin steps even though
// upstream executes argv steps exclusively when any exist: this pre-spawn
// validator must stay a superset of anything upstream could run, so it fails
// closed on unsafe content in either source. Stdin parse failures are fatal
// only when upstream would actually read stdin (no argv steps); ignored
// unparseable stdin cannot execute and must not reject a valid raw-argv call.
// The upstream-exact selection lives in getUpstreamEffectiveBatchSteps
// (batch-stdin.ts) for guard/folding paths.
function getBatchCommandSteps(args: string[], stdin?: string): { error?: string; steps: BatchCommandStep[] } {
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command !== "batch") return { steps: [] };
	const steps: BatchCommandStep[] = [];
	for (const command of descriptor.upstreamCommandTokens.slice(1)) {
		if (command === "--bail") continue;
		if (decodeUrlComponent(command).toLowerCase().includes(".agent-browser")) return { error: BLOCKED_MANAGED_BROWSER_FILE_MESSAGE, steps: [] };
		const parsed = parseBatchCommandArgument(command);
		if (parsed.error || parsed.step === undefined) return { error: parsed.error ?? UNSAFE_BATCH_ARGUMENT_MESSAGE, steps: [] };
		if (parseArgvDescriptor(parsed.step).commandInfo.command === "batch") return { error: NESTED_BATCH_ARGUMENT_MESSAGE, steps: [] };
		steps.push(parsed.step);
	}
	const parsedStdin = parseUserBatchStdin(stdin);
	if (parsedStdin.error && steps.length === 0) return { error: parsedStdin.error, steps: [] };
	for (const step of parsedStdin.steps ?? []) {
		if (parseArgvDescriptor(step).commandInfo.command === "batch") return { error: NESTED_BATCH_ARGUMENT_MESSAGE, steps: [] };
		steps.push(step);
	}
	return { steps };
}

export function invocationMayNavigateToLocalFile(args: string[], stdin?: string): boolean {
	if (isFileUrl(getResultingExplicitNavigationTarget(args))) return true;
	const descriptor = parseArgvDescriptor(args);
	return getUpstreamEffectiveBatchSteps(descriptor.upstreamCommandTokens, stdin)
		.some((step) => isFileUrl(getResultingExplicitNavigationTarget(step)));
}

function batchBailsOnFirstError(args: string[]): boolean {
	const descriptor = parseArgvDescriptor(args);
	return descriptor.commandInfo.command === "batch" && descriptor.upstreamCommandTokens.slice(1).includes("--bail");
}

interface PossibleBatchPageState {
	currentPageUrl?: string;
	pageUrlUnknown: boolean;
	retainedAfterFailedNavigation: boolean;
}

function commandMayChangePageTarget(args: string[], trustedBatchTabSelection: boolean): boolean {
	const descriptor = parseArgvDescriptor(args);
	return getExplicitNavigationTarget(args) !== undefined
		|| (isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand)
			&& !(trustedBatchTabSelection && descriptor.commandInfo.command === "tab"));
}

function deduplicatePossibleBatchPageStates(states: PossibleBatchPageState[]): PossibleBatchPageState[] {
	const deduplicated = new Map<string, PossibleBatchPageState>();
	for (const state of states) {
		const key = `${state.pageUrlUnknown ? "unknown" : "known"}\0${state.currentPageUrl ?? ""}`;
		const existing = deduplicated.get(key);
		if (!existing) deduplicated.set(key, state);
		else existing.retainedAfterFailedNavigation ||= state.retainedAfterFailedNavigation;
	}
	return [...deduplicated.values()];
}

export function managedSessionCommandRequiresLivePageVerification(args: string[], stdin?: string): boolean {
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command === "eval") return true;
	if (descriptor.commandInfo.command !== "batch") return false;
	const batch = getBatchCommandSteps(args, stdin);
	return batch.error === undefined && batch.steps.some((step) => managedSessionCommandRequiresLivePageVerification(step));
}

function getResultingPageState(options: {
	args: string[];
	currentPageUrl?: string;
	pageUrlUnknown: boolean;
	trustedBatchTabSelection: boolean;
}): { currentPageUrl?: string; pageUrlUnknown: boolean } {
	const descriptor = parseArgvDescriptor(options.args);
	const rawExplicitTarget = getExplicitNavigationTarget(options.args);
	const explicitTarget = getResultingExplicitNavigationTarget(options.args, options.currentPageUrl);
	if (explicitTarget !== undefined) return { currentPageUrl: explicitTarget, pageUrlUnknown: false };
	if (rawExplicitTarget !== undefined) return { pageUrlUnknown: true };
	if (isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand)) {
		return options.trustedBatchTabSelection && descriptor.commandInfo.command === "tab"
			? { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown }
			: { pageUrlUnknown: true };
	}
	return { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown };
}

export function getManagedSessionResultingPageState(options: {
	args: string[];
	currentPageUrl?: string;
	pageUrlUnknown?: boolean;
	stdin?: string;
	trustedFirstBatchTabSelection?: boolean;
}): { currentPageUrl?: string; pageTargetMayHaveChanged: boolean; pageUrlUnknown: boolean } {
	const descriptor = parseArgvDescriptor(options.args);
	let state: { currentPageUrl?: string; pageUrlUnknown: boolean } = { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown ?? false };
	let pageTargetMayHaveChanged = false;
	if (descriptor.commandInfo.command !== "batch") {
		pageTargetMayHaveChanged = getExplicitNavigationTarget(options.args) !== undefined
			|| isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand);
		return { ...getResultingPageState({ ...state, args: options.args, trustedBatchTabSelection: false }), pageTargetMayHaveChanged };
	}
	const batch = getBatchCommandSteps(options.args, options.stdin);
	if (batch.error) return { pageTargetMayHaveChanged: true, pageUrlUnknown: true };
	for (let index = 0; index < batch.steps.length; index += 1) {
		const step = batch.steps[index];
		const trustedBatchTabSelection = options.trustedFirstBatchTabSelection === true && index === 0;
		const stepDescriptor = parseArgvDescriptor(step);
		pageTargetMayHaveChanged ||= getExplicitNavigationTarget(step) !== undefined
			|| (isUnverifiedPageTransitionCommand(stepDescriptor.commandInfo.command, stepDescriptor.commandInfo.subcommand)
				&& !(trustedBatchTabSelection && stepDescriptor.commandInfo.command === "tab"));
		state = getResultingPageState({ ...state, args: step, trustedBatchTabSelection });
	}
	return { ...state, pageTargetMayHaveChanged };
}

export function getCallerOwnedSessionLivePageVerificationRequirement(options: {
	args: string[];
	cwd: string;
	stdin?: string;
	trustedFirstBatchTabSelection?: boolean;
}): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	if (!needsManagedSession(descriptor)) return undefined;
	if (descriptor.commandInfo.command !== "eval" && isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand)) return undefined;
	const validationError = getManagedSessionStateAccessValidationError({
		args: options.args,
		cwd: options.cwd,
		env: {},
		pageUrlUnknown: true,
		parentEnv: {},
		stdin: options.stdin,
		allowUnverifiedPageTransitions: true,
		trustedFirstBatchTabSelection: options.trustedFirstBatchTabSelection,
		trustedPinnedEmptyConfig: true,
	});
	return validationError === UNVERIFIED_PAGE_MESSAGE || validationError === BATCH_UNVERIFIED_PAGE_MESSAGE || validationError === NON_BAIL_BATCH_NAVIGATION_MESSAGE
		? UNVERIFIED_PAGE_MESSAGE
		: undefined;
}

export function getManagedSessionTargetAccessValidationError(args: string[], ownedManagedSession: boolean, env: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment()): string | undefined {
	const sessionName = extractExplicitSessionName(args) ?? env.AGENT_BROWSER_SESSION;
	return sessionName && isWrapperManagedSessionName(sessionName) && !ownedManagedSession
		? BLOCKED_MANAGED_SESSION_MESSAGE
		: undefined;
}

function getFlagValues(args: string[], flag: string, consumeDashValue = false): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith(`${flag}=`)) {
			values.push(token.slice(flag.length + 1));
			continue;
		}
		if (token !== flag) continue;
		const value = args[index + 1];
		if (flag === "--restore" && !optionalGlobalValueFlagConsumesNext(flag, value)) continue;
		if (value !== undefined && (consumeDashValue || !value.startsWith("-"))) values.push(value);
	}
	return values;
}

function resolveExistingPath(cwd: string, value: string): string | undefined {
	try {
		return realpathSync(resolve(cwd, value));
	} catch {
		return undefined;
	}
}

function getReferencedValues(args: string[], cwd: string, env: NodeJS.ProcessEnv): string[] {
	const descriptor = parseArgvDescriptor(args);
	const values = [
		...args,
		...getFlagValues(args, "--restore"),
		...getFlagValues(args, "--state", true),
		env.AGENT_BROWSER_RESTORE,
		env.AGENT_BROWSER_STATE,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (descriptor.commandInfo.command === "state" && ["clear", "load", "rename", "save", "show"].includes(descriptor.commandInfo.subcommand ?? "")) {
		values.push(...descriptor.upstreamCommandTokens.slice(2));
	}
	for (const value of [...values]) {
		const realPath = resolveExistingPath(cwd, value);
		if (realPath) values.push(realPath);
	}
	return values;
}

export function getManagedSessionStateAccessValidationError(options: {
	allowUnverifiedPageTransitions?: boolean;
	args: string[];
	currentPageUrl?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	managedSessionRestoreKey?: string;
	pageUrlUnknown?: boolean;
	parentEnv?: NodeJS.ProcessEnv;
	stdin?: string;
	trustedPinnedEmptyConfig?: boolean;
	trustedFirstBatchTabSelection?: boolean;
}): string | undefined {
	const effectiveEnv = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	const descriptor = parseArgvDescriptor(options.args);
	const command = descriptor.commandInfo.command;
	const subcommand = descriptor.commandInfo.subcommand;
	if (["close", "exit", "quit"].includes(command ?? "")) return undefined;
	if (!options.trustedPinnedEmptyConfig && needsManagedSession(descriptor) && agentBrowserExplicitConfigIsPresent(effectiveEnv, options.args)) return UPSTREAM_CONFIG_MESSAGE;
	if (command === "batch") {
		const batch = getBatchCommandSteps(options.args, options.stdin);
		if (batch.error) {
			if (batch.error === BLOCKED_MANAGED_BROWSER_FILE_MESSAGE || batch.error === NESTED_BATCH_ARGUMENT_MESSAGE || batch.error.startsWith("agent_browser batch stdin")) return batch.error;
			return UNSAFE_BATCH_ARGUMENT_MESSAGE;
		}
		const bailOnFirstError = batchBailsOnFirstError(options.args);
		let possibleStates: PossibleBatchPageState[] = [{
			currentPageUrl: options.currentPageUrl,
			pageUrlUnknown: options.pageUrlUnknown ?? false,
			retainedAfterFailedNavigation: false,
		}];
		for (let index = 0; index < batch.steps.length; index += 1) {
			const step = batch.steps[index];
			const trustedBatchTabSelection = options.trustedFirstBatchTabSelection === true && index === 0;
			let directError: string | undefined;
			let failedNavigationHazard = false;
			for (const state of possibleStates) {
				const error = getManagedSessionStateAccessValidationError({
					...options,
					args: step,
					currentPageUrl: state.currentPageUrl,
					pageUrlUnknown: state.pageUrlUnknown,
					stdin: undefined,
					trustedFirstBatchTabSelection: trustedBatchTabSelection,
				});
				if (!error) continue;
				if (state.retainedAfterFailedNavigation && [BLOCKED_MANAGED_BROWSER_FILE_MESSAGE, UNVERIFIED_PAGE_MESSAGE].includes(error)) {
					failedNavigationHazard = true;
				} else {
					directError ??= error;
				}
			}
			if (directError) return directError === UNVERIFIED_PAGE_MESSAGE ? BATCH_UNVERIFIED_PAGE_MESSAGE : directError;
			if (failedNavigationHazard) return NON_BAIL_BATCH_NAVIGATION_MESSAGE;
			const mayChangePageTarget = commandMayChangePageTarget(step, trustedBatchTabSelection);
			const nextStates: PossibleBatchPageState[] = [];
			for (const state of possibleStates) {
				const successState = getResultingPageState({
					args: step,
					currentPageUrl: state.currentPageUrl,
					pageUrlUnknown: state.pageUrlUnknown,
					trustedBatchTabSelection,
				});
				if (nextStates.length >= MAX_NON_BAIL_BATCH_PAGE_STATES) return NON_BAIL_BATCH_NAVIGATION_MESSAGE;
				nextStates.push({
					...successState,
					retainedAfterFailedNavigation: mayChangePageTarget ? false : state.retainedAfterFailedNavigation,
				});
				if (!bailOnFirstError && mayChangePageTarget) {
					if (nextStates.length >= MAX_NON_BAIL_BATCH_PAGE_STATES) return NON_BAIL_BATCH_NAVIGATION_MESSAGE;
					nextStates.push({ ...state, retainedAfterFailedNavigation: true });
				}
			}
			possibleStates = deduplicatePossibleBatchPageStates(nextStates);
		}
	}
	const browserFileError = getManagedBrowserFileAccessValidationError({
		allowUnverifiedPageTransitions: options.allowUnverifiedPageTransitions,
		args: options.args,
		currentPageUrl: command === "batch" ? undefined : options.currentPageUrl,
		cwd: options.cwd,
		env: effectiveEnv,
		pageUrlUnknown: command === "batch" ? false : options.pageUrlUnknown,
		stdin: options.stdin,
		trustedBatchTabSelection: options.trustedFirstBatchTabSelection,
	});
	if (browserFileError) return browserFileError;
	if (command === "state" && subcommand === "clean") return BLOCKED_GLOBAL_STATE_MESSAGE;
	if (command === "state" && subcommand === "clear") {
		const target = descriptor.upstreamCommandTokens.slice(2).find((token) => !token.startsWith("-"));
		if (!target || descriptor.upstreamCommandTokens.includes("--all") || descriptor.upstreamCommandTokens.includes("-a") || isWrapperManagedSessionName(target)) {
			return BLOCKED_GLOBAL_STATE_MESSAGE;
		}
	}

	const referencedValues = [
		...getReferencedValues(options.args, options.cwd, effectiveEnv),
		...(options.stdin ? [options.stdin] : []),
	];
	const referencedKeys = [...new Set(referencedValues.flatMap(extractManagedSessionRestoreKeys))];
	if (referencedKeys.length === 0) return undefined;
	if (command === "state" && ["rename", "save"].includes(subcommand ?? "")) return BLOCKED_GLOBAL_STATE_MESSAGE;
	if (!hasManagedSessionRestoreProjectIdentity(options.cwd) || !options.managedSessionRestoreKey) return BLOCKED_GLOBAL_STATE_MESSAGE;
	const currentKey = options.managedSessionRestoreKey.toLowerCase();
	return referencedKeys.every((key) => key === currentKey) ? undefined : BLOCKED_GLOBAL_STATE_MESSAGE;
}
