import { cleanupElectronLaunchResources } from "../../electron/cleanup.js";
import { launchElectronApp, type ElectronLaunchSuccess } from "../../electron/launch.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import {
	buildElectronHostFailureResult,
	getElectronLaunchFailureCategory,
} from "./final-result.js";
import { buildManagedSessionOutcome } from "./session-state.js";
import { prepareAgentBrowserArgs } from "./prepare-artifacts.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";
import type { ManagedSessionPolicyLock } from "../../managed-session-policy-lock.js";
import { preparationFailure } from "./prepare-failure.js";
import type {
	BrowserRunState,
	BrowserRunInputFields,
	PreparedAgentBrowserArgs,
	PrepareBrowserRunResult,
} from "./types.js";

export async function prepareElectronLaunch(
	facts: {
		readonly signal?: AbortSignal | undefined;
		readonly getOwnerSessionId: () => string | undefined;
		readonly managedSessionActive: boolean;
		readonly managedSessionName: string;
	},
	input: BrowserRunInputFields,
	freshSessionName: string,
): Promise<
	| { readonly electronLaunch?: ElectronLaunchSuccess }
	| { readonly earlyResult: PrepareBrowserRunResult }
> {
	const compiled = input.compiledElectron;
	if (compiled?.action !== "launch") {
		return {};
	}
	const launched = await launchElectronApp({ ...compiled, signal: facts.signal });
	if (!launched.ok) {
		const managedSessionOutcome = buildManagedSessionOutcome({
			activeAfter: facts.managedSessionActive,
			activeBefore: facts.managedSessionActive,
			attemptedSessionName: freshSessionName,
			command: "connect",
			currentSessionName: facts.managedSessionName,
			previousSessionName: facts.managedSessionName,
			sessionMode: "fresh",
			succeeded: false,
		});
		return {
			earlyResult: {
				kind: "early-result",
				result: buildElectronHostFailureResult({
					compiledElectron: input.redactedCompiledElectron ?? compiled,
					errorText: launched.failure.error,
					failureCategory: getElectronLaunchFailureCategory(launched.failure),
					launchFailure: launched.failure,
					managedSessionOutcome,
					status: launched.failure.reason,
				}),
			},
		};
	}
	return {
		electronLaunch: {
			...launched.value,
			record: { ...launched.value.record, ownerSessionId: facts.getOwnerSessionId() },
		},
	};
}

async function cleanupPreparationElectron(
	state: BrowserRunState,
	launch: ElectronLaunchSuccess,
	timeoutMs: number,
): Promise<void> {
	try {
		const cleanup = await cleanupElectronLaunchResources({
			child: launch.child,
			record: launch.record,
			timeoutMs,
		});
		if (cleanup.partial) {
			state.electronLaunchRecords.set(cleanup.launchId, cleanup.record);
			state.electronChildProcesses.set(cleanup.launchId, launch.child);
		}
	} catch {
		state.electronLaunchRecords.set(launch.record.launchId, launch.record);
		state.electronChildProcesses.set(launch.record.launchId, launch.child);
	}
}

export async function cleanupPreparationResources(
	state: BrowserRunState,
	resources: {
		readonly lock?: ManagedSessionPolicyLock | undefined;
		readonly electronLaunch?: ElectronLaunchSuccess | undefined;
		readonly timeoutMs: number;
	},
): Promise<void> {
	// Release native execution ownership before tearing down the task-owned Electron process.
	await resources.lock?.release();
	if (resources.electronLaunch) {
		await cleanupPreparationElectron(state, resources.electronLaunch, resources.timeoutMs);
	}
}

function artifactDirectoryFailure(
	error: Readonly<Error>,
	path: string,
	redactedArgs: readonly string[],
): PrepareBrowserRunResult {
	const guidance =
		"Choose a writable artifact path whose parent components are directories. Use absolute paths in raw batch artifact rows.";
	const validationError = redactSensitiveText(
		`Could not prepare artifact directory ${path}: ${error.message}. ${guidance}`,
	);
	return preparationFailure({
		message: validationError,
		details: {
			agentBrowserStarted: false,
			args: redactedArgs,
			nextActions: [
				{
					artifactPath: redactSensitiveText(path),
					id: "verify-artifact-path",
					reason: guidance,
					safety:
						"The requested browser command did not run; inspect the directory with host file tools before retrying.",
					tool: "agent_browser",
				},
			],
			...buildAgentBrowserResultCategoryDetails({
				args: redactedArgs,
				succeeded: false,
				validationError,
			}),
			validationError,
		},
	});
}

export async function prepareArtifactArguments(
	process: PreparationProcessFacts,
	request: {
		readonly args: readonly string[];
		readonly stdin?: string | undefined;
		readonly redactedArgs: readonly string[];
	},
): Promise<
	| { readonly preparedArgs: PreparedAgentBrowserArgs }
	| { readonly earlyResult: PrepareBrowserRunResult }
> {
	try {
		return {
			preparedArgs: await prepareAgentBrowserArgs(request.args, request.stdin, process.cwd),
		};
	} catch (error) {
		process.signal?.throwIfAborted();
		if (
			!(error instanceof Error) ||
			!("syscall" in error) ||
			error.syscall !== "mkdir" ||
			!("path" in error) ||
			typeof error.path !== "string"
		) {
			throw error;
		}
		return { earlyResult: artifactDirectoryFailure(error, error.path, request.redactedArgs) };
	}
}
