import {
	getAgentBrowserSessionIdentityKey,
	scanUpstreamGlobalFlagOccurrences,
} from "../argv-grammar.js";
import { withAgentBrowserProcessEnvironment } from "../process-environment.js";
import { withChromeStartupArgs } from "../process.js";
import { buildValidationFailureResult } from "./input-plan.js";
import type { ResolvedAgentBrowserValidInput } from "./input-plan-types.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import { inspectManagedSessionDaemon } from "./browser-run/managed-session-daemon-policy.js";
import { buildMissingBinaryMessage } from "./browser-run/final-result-missing-binary.js";
import type { NativeDefaults } from "./native-config.js";
import type {
	ManagedSessionDaemonInspection,
	PreparationDaemonObservation,
} from "./browser-run/managed-session-daemon-inspection.js";

export interface RootBrowserLaunchPolicy {
	readonly cwd: string;
	readonly rootName: string;
	readonly namespace?: string;
	readonly input: ResolvedAgentBrowserValidInput;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly identity: NativeDefaults;
	readonly restoreEligible: boolean;
	readonly chromeEngine: boolean;
	readonly chromeStartupArgs?: string;
	readonly configuredChromeLaunch: boolean;
	readonly defaultProfile?: string;
	readonly defaultExecutable?: string;
}

function cliValue(args: readonly string[], flag: string): string | undefined {
	return scanUpstreamGlobalFlagOccurrences([...args], flag).at(-1)?.value;
}

function bootstrapProfile(policy: RootBrowserLaunchPolicy, bootstrap: boolean): string | undefined {
	const allowed =
		bootstrap &&
		policy.chromeEngine &&
		policy.restoreEligible &&
		policy.identity.profile === undefined &&
		policy.env.AGENT_BROWSER_PROFILE === undefined;
	return (
		cliValue(policy.input.toolArgs, "--profile") ?? (allowed ? policy.defaultProfile : undefined)
	);
}

function bootstrapExecutable(
	policy: RootBrowserLaunchPolicy,
	bootstrap: boolean,
): string | undefined {
	const allowed =
		bootstrap &&
		policy.chromeEngine &&
		policy.identity.executablePath === undefined &&
		policy.env.AGENT_BROWSER_EXECUTABLE_PATH === undefined;
	return (
		cliValue(policy.input.toolArgs, "--executable-path") ??
		(allowed ? policy.defaultExecutable : undefined)
	);
}

function rootRestoreKey(
	policy: RootBrowserLaunchPolicy,
	status: string,
	restoreKey: string | null | undefined,
): string | undefined {
	if (!policy.restoreEligible) {
		return undefined;
	}
	if (status === "active") {
		return restoreKey ?? undefined;
	}
	return status === "inactive" ? policy.rootName : undefined;
}

function rootLaunchEnvironment(
	policy: RootBrowserLaunchPolicy,
	daemon: ManagedSessionDaemonInspection,
): NodeJS.ProcessEnv {
	const bootstrap = daemon.status === "inactive";
	const restore = rootRestoreKey(
		policy,
		daemon.status,
		daemon.status === "active" ? daemon.restoreKey : undefined,
	);
	const profile = bootstrapProfile(policy, bootstrap);
	const executablePath = bootstrapExecutable(policy, bootstrap);
	return {
		...(restore !== undefined ? { AGENT_BROWSER_RESTORE: restore } : {}),
		...(profile !== undefined ? { AGENT_BROWSER_PROFILE: profile } : {}),
		...(executablePath !== undefined ? { AGENT_BROWSER_EXECUTABLE_PATH: executablePath } : {}),
	};
}

export async function withRootBrowserLaunch(
	policy: RootBrowserLaunchPolicy,
	browserRun: (observation?: PreparationDaemonObservation) => Promise<AgentBrowserToolResult>,
	signal?: AbortSignal,
	includeGeneration = false,
): Promise<AgentBrowserToolResult> {
	const namespace = cliValue(policy.input.toolArgs, "--namespace") ?? policy.namespace;
	const daemon = await inspectManagedSessionDaemon({
		cwd: policy.cwd,
		signal,
		sessionName: policy.rootName,
		namespace,
		includeGeneration,
		timeoutMs: 5_000,
	});
	if (daemon.status === "missing-binary") {
		return {
			content: [{ type: "text", text: buildMissingBinaryMessage() }],
			details: {
				agentBrowserStarted: false,
				args: policy.input.redactedArgs,
				sessionName: policy.rootName,
				resultCategory: "failure",
				failureCategory: "missing-binary",
			},
			isError: true,
		};
	}
	if (
		policy.input.kind === "qa" &&
		policy.input.compiledQaPreset.checks.attached &&
		daemon.status !== "active"
	) {
		return buildValidationFailureResult({
			...policy.input,
			attemptedKind: "qa",
			kind: "invalid",
			status: "invalid",
			validationError:
				"qa.attached requires an active attached session. Open the root browser first, or select an existing native session.",
		});
	}
	// Active native daemons own their launch choices; defaults may only bootstrap or preserve explicit local options.
	return withAgentBrowserProcessEnvironment(rootLaunchEnvironment(policy, daemon), () =>
		withChromeStartupArgs(
			daemon.status === "inactive" || policy.configuredChromeLaunch
				? policy.chromeStartupArgs
				: undefined,
			() =>
				browserRun({
					identity: getAgentBrowserSessionIdentityKey(policy.rootName, namespace),
					daemon,
					generationInspected: includeGeneration,
				}),
		),
	);
}
