import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	extractExplicitSessionName,
	getBooleanFlagValue,
	isUpstreamEnvFlagEnabled,
	scanUpstreamGlobalFlagOccurrences,
} from "../argv-grammar.js";
import { parseArgvDescriptor } from "../argv-descriptor.js";
import { needsManagedSession } from "../command-policy.js";
import { getUpstreamEffectiveBatchSteps } from "./batch-stdin.js";
import { hasLaunchScopedFlagToken } from "../launch-scoped-flags.js";
import {
	getAgentBrowserProcessEnvironment,
	withAgentBrowserProcessEnvironment,
} from "../process-environment.js";
import { isPlainTextInspectionArgs } from "../runtime.js";
import type { ResolvedAgentBrowserValidInput } from "./input-plan-types.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import {
	hasLocalLaunchDefaults,
	loadNativeIdentity,
	LOCAL_LAUNCH_DEFAULT_FLAGS,
	type NativeDefaults,
} from "./native-config.js";
import { withRootBrowserLaunch, type RootBrowserLaunchPolicy } from "./native-root-launch.js";
import type { PreparationDaemonObservation } from "./browser-run/managed-session-daemon-inspection.js";

export interface NativeSessionCallContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly root?: {
		readonly id: string;
		readonly profile?: string;
		readonly executablePath?: string;
	};
}

type BrowserRunner = (
	observation?: PreparationDaemonObservation,
) => Promise<AgentBrowserToolResult>;
type LaunchDefaultsRunner = (
	browserRun: BrowserRunner,
	signal?: AbortSignal,
	includeGeneration?: boolean,
) => Promise<AgentBrowserToolResult>;
type InputRunner = (
	input: ResolvedAgentBrowserValidInput,
	withLaunchDefaults?: LaunchDefaultsRunner,
) => Promise<AgentBrowserToolResult>;

function cliValue(args: readonly string[], flag: string): string | undefined {
	return scanUpstreamGlobalFlagOccurrences([...args], flag).at(-1)?.value;
}

function requestsConnection(tokens: readonly string[], stdin?: string): boolean {
	return (
		tokens[0] === "connect" ||
		getUpstreamEffectiveBatchSteps(tokens, stdin).some((step) => requestsConnection(step))
	);
}

function rootBrowserSessionName(rootSessionId: string): string {
	return `pi-root-${createHash("sha256").update(rootSessionId).digest("hex").slice(0, 24)}`;
}

function nativeBooleanOverrides(args: readonly string[]): Array<[string, string]> {
	const overrides: Array<[string, string]> = [];
	for (const flag of ["--debug", "--no-auto-dialog"]) {
		const value = getBooleanFlagValue([...args], flag);
		if (value !== undefined) {
			overrides.push([flag, String(value)]);
		}
	}
	return overrides;
}

/** Owns one native config resolution and pure adaptation, never browser/auth authority. */
class NativeSessionCall {
	private readonly env = getAgentBrowserProcessEnvironment();
	private readonly configPath: string | undefined;
	private readonly configPaths: readonly string[];
	private readonly rootName: string | undefined;
	private readonly browserCommand: boolean;
	private readonly rootFallback: boolean;
	private identity: NativeDefaults = {};

	constructor(
		private readonly input: ResolvedAgentBrowserValidInput,
		private readonly context: NativeSessionCallContext,
		private readonly runner: InputRunner,
	) {
		const configArg = scanUpstreamGlobalFlagOccurrences([...input.toolArgs], "--config").at(0);
		this.configPath = configArg?.value ?? this.env.AGENT_BROWSER_CONFIG;
		this.configPaths =
			this.configPath !== undefined
				? [resolve(context.cwd, this.configPath)]
				: [
						join(homedir(), ".agent-browser", "config.json"),
						join(context.cwd, "agent-browser.json"),
					];
		this.rootName =
			context.root === undefined ? undefined : rootBrowserSessionName(context.root.id);
		this.browserCommand =
			input.kind !== "electron" &&
			needsManagedSession(parseArgvDescriptor([...input.toolArgs]), input.toolStdin);
		const session = extractExplicitSessionName([...input.toolArgs]);
		this.rootFallback =
			context.root !== undefined &&
			this.env.AGENT_BROWSER_SESSION === undefined &&
			(session === undefined || session === this.rootName) &&
			this.browserCommand;
	}

	private attachment(): boolean {
		const autoConnect =
			getBooleanFlagValue([...this.input.toolArgs], "--auto-connect") ??
			(isUpstreamEnvFlagEnabled(this.env.AGENT_BROWSER_AUTO_CONNECT) ||
				this.identity.autoConnect === true);
		return (
			hasLaunchScopedFlagToken([...this.input.toolArgs], "--cdp") ||
			this.env.AGENT_BROWSER_CDP !== undefined ||
			this.identity.cdp !== undefined ||
			autoConnect ||
			parseArgvDescriptor([...this.input.toolArgs]).upstreamCommandTokens[0] === "connect"
		);
	}

	private restoreEligible(): boolean {
		return (
			![
				"--restore",
				"--session-name",
				"--state",
				"--allowed-domains",
				"--provider",
				"-p",
				"--device",
			].some((flag) => hasLaunchScopedFlagToken([...this.input.toolArgs], flag)) &&
			!["restore", "sessionName", "state", "allowedDomains", "provider"].some(
				(key) => this.identity[key] !== undefined,
			) &&
			![
				"AGENT_BROWSER_RESTORE",
				"AGENT_BROWSER_SESSION_NAME",
				"AGENT_BROWSER_STATE",
				"AGENT_BROWSER_ALLOWED_DOMAINS",
				"AGENT_BROWSER_PROVIDER",
			].some((key) => this.env[key] !== undefined)
		);
	}

	private chromeLaunch(): {
		readonly chromeEngine: boolean;
		readonly chromeStartupArgs?: string;
		readonly configuredChromeLaunch: boolean;
	} {
		const args = this.input.toolArgs;
		const engine =
			cliValue(args, "--engine") ?? this.env.AGENT_BROWSER_ENGINE ?? this.identity.engine;
		const chromeEngine = engine === undefined || engine === "chrome";
		const nativeLaunchDefaults = hasLocalLaunchDefaults(this.identity, this.env);
		// Native config/env can submit launch options on local commands too. Leave their args
		// unchanged so browser calls and sessionless helpers do not reconfigure the same daemon.
		const chromeStartupArgs = nativeLaunchDefaults
			? undefined
			: this.chromeStartupArgs(chromeEngine);
		const configuredChromeLaunch =
			nativeLaunchDefaults ||
			LOCAL_LAUNCH_DEFAULT_FLAGS.some(
				(flag) => scanUpstreamGlobalFlagOccurrences([...args], flag).length > 0,
			);
		return { chromeEngine, chromeStartupArgs, configuredChromeLaunch };
	}

	private chromeStartupArgs(chromeEngine: boolean): string | undefined {
		if (!this.localChrome(chromeEngine)) {
			return undefined;
		}
		const launchArgs =
			cliValue(this.input.toolArgs, "--args") ?? this.env.AGENT_BROWSER_ARGS ?? this.identity.args;
		return ["--no-startup-window", ...(typeof launchArgs === "string" ? [launchArgs] : [])].join(
			",",
		);
	}

	private localChrome(chromeEngine: boolean): boolean {
		const args = this.input.toolArgs;
		const provider =
			cliValue(args, "--provider") ??
			cliValue(args, "-p") ??
			this.env.AGENT_BROWSER_PROVIDER ??
			this.identity.provider;
		const batchAttaches = requestsConnection(
			parseArgvDescriptor([...args]).upstreamCommandTokens,
			this.input.toolStdin,
		);
		return (
			this.browserCommand &&
			!this.attachment() &&
			!batchAttaches &&
			provider === undefined &&
			chromeEngine
		);
	}

	private confirmationActions(args: readonly string[]): string | undefined {
		return (
			cliValue(args, "--confirm-actions") ??
			this.env.AGENT_BROWSER_CONFIRM_ACTIONS ??
			(typeof this.identity.confirmActions === "string" ? this.identity.confirmActions : undefined)
		);
	}

	private configEnvironment(): NodeJS.ProcessEnv {
		return this.configPath === undefined
			? {}
			: { AGENT_BROWSER_CONFIG: resolve(this.context.cwd, this.configPath) };
	}

	private executionEnvironment(
		args: readonly string[],
		session: string | undefined,
		namespace: string | undefined,
	): NodeJS.ProcessEnv {
		const idle = cliValue(args, "--idle-timeout");
		const actionPolicy = cliValue(args, "--action-policy");
		const confirm = cliValue(args, "--confirm-actions");
		return {
			...(idle !== undefined ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: idle } : {}),
			...(actionPolicy !== undefined ? { AGENT_BROWSER_ACTION_POLICY: actionPolicy } : {}),
			...(confirm !== undefined ? { AGENT_BROWSER_CONFIRM_ACTIONS: confirm } : {}),
			...this.booleanEnvironment(args),
			...this.configEnvironment(),
			...(session !== undefined ? { AGENT_BROWSER_SESSION: session } : {}),
			...(namespace !== undefined ? { AGENT_BROWSER_NAMESPACE: namespace } : {}),
		};
	}

	private booleanEnvironment(args: readonly string[]): NodeJS.ProcessEnv {
		const debug = getBooleanFlagValue([...args], "--debug");
		const noAutoDialog = getBooleanFlagValue([...args], "--no-auto-dialog");
		return {
			...(debug !== undefined ? { AGENT_BROWSER_DEBUG: debug ? "1" : undefined } : {}),
			...(noAutoDialog !== undefined
				? { AGENT_BROWSER_NO_AUTO_DIALOG: noAutoDialog ? "1" : "0" }
				: {}),
		};
	}

	private runElectron(): Promise<AgentBrowserToolResult> {
		const nativeConfirmActions =
			this.env.AGENT_BROWSER_CONFIRM_ACTIONS ??
			(typeof this.identity.confirmActions === "string" ? this.identity.confirmActions : undefined);
		const launch =
			this.input.kind === "electron" && this.input.compiledElectron.action === "launch";
		return withAgentBrowserProcessEnvironment(
			{ ...(launch ? { AGENT_BROWSER_SESSION: undefined } : {}), ...this.configEnvironment() },
			() => this.runner({ ...this.input, nativeConfirmActions }),
		);
	}

	private rootDefaultSession(configuredSession: string | undefined): string | undefined {
		return this.rootName !== undefined &&
			configuredSession === undefined &&
			this.rootFallback &&
			!this.attachment()
			? this.rootName
			: undefined;
	}

	private runBrowser(): Promise<AgentBrowserToolResult> {
		const configuredSession = this.env.AGENT_BROWSER_SESSION ?? this.identity.session;
		const rootDefault = this.rootDefaultSession(configuredSession);
		const session = configuredSession ?? rootDefault;
		const namespace = this.env.AGENT_BROWSER_NAMESPACE ?? this.identity.namespace;
		const args =
			session !== undefined && extractExplicitSessionName([...this.input.toolArgs]) === undefined
				? ["--session", session, ...this.input.toolArgs]
				: this.input.toolArgs;
		const launch = this.chromeLaunch();
		const input: ResolvedAgentBrowserValidInput = {
			...this.input,
			toolArgs: args,
			nativeConfirmActions: this.confirmationActions(args),
			chromeStartupArgs: launch.chromeStartupArgs,
			configuredChromeLaunch: launch.configuredChromeLaunch,
		};
		const defaults =
			rootDefault === undefined
				? undefined
				: this.rootLaunchRunner({
						...launch,
						cwd: this.context.cwd,
						rootName: rootDefault,
						namespace,
						input,
						env: this.env,
						identity: this.identity,
						restoreEligible: this.restoreEligible(),
						defaultProfile: this.context.root?.profile,
						defaultExecutable: this.context.root?.executablePath,
					});
		return withAgentBrowserProcessEnvironment(
			this.executionEnvironment(args, session, namespace),
			() => this.runner(input, defaults),
			nativeBooleanOverrides(args),
		);
	}

	private rootLaunchRunner(policy: RootBrowserLaunchPolicy): LaunchDefaultsRunner {
		return (browserRun, signal = this.context.signal, includeGeneration) =>
			withRootBrowserLaunch(policy, browserRun, signal, includeGeneration);
	}

	async run(): Promise<AgentBrowserToolResult> {
		this.identity = await loadNativeIdentity(this.configPaths, {
			cwd: this.context.cwd,
			signal: this.context.signal,
			rootFallback: this.rootFallback,
			browserCommand: this.browserCommand,
		});
		return this.input.kind === "electron" ? this.runElectron() : this.runBrowser();
	}
}

export async function withNativeSessionDefaults(
	input: ResolvedAgentBrowserValidInput,
	context: NativeSessionCallContext,
	run: InputRunner,
): Promise<AgentBrowserToolResult> {
	if (isPlainTextInspectionArgs([...input.toolArgs])) {
		return run(input);
	}
	return new NativeSessionCall(input, context, run).run();
}
