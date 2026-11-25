import {
	buildOwnedManagedSessionRestoreContext,
	withOwnedManagedSessionContext,
} from "../../managed-session-restore.js";
import { withAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { normalizeProcessError } from "../../process-errors.js";
import { collectElectronManagedSessionTarget } from "../browser-run/diagnostics.js";
import {
	acquireOwnedManagedSessionDaemonPolicy,
	getRunningHeadedAutosavePolicyChangeError,
} from "../browser-run/managed-session-daemon-policy.js";
import type { ElectronManagedSessionTarget } from "../browser-run/types.js";
import type { ElectronManagedSessionPolicy } from "./contracts.js";

export class ElectronManagedSessionPolicyError extends Error {}
async function acquireElectronPolicy(
	options: ElectronManagedSessionPolicy,
	context: NonNullable<ReturnType<typeof buildOwnedManagedSessionRestoreContext>>,
): Promise<Awaited<ReturnType<typeof acquireOwnedManagedSessionDaemonPolicy>>> {
	try {
		return await acquireOwnedManagedSessionDaemonPolicy({
			context,
			electronLaunchRecord: options.electronLaunchRecord,
			electronVerificationTimeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	} catch (error) {
		throw new ElectronManagedSessionPolicyError(normalizeProcessError(error).message, {
			cause: error,
		});
	}
}
function requirePolicyLock(
	policy: Awaited<ReturnType<typeof acquireOwnedManagedSessionDaemonPolicy>>,
	signal: AbortSignal | undefined,
): NonNullable<typeof policy.lock> {
	if (policy.error !== undefined && policy.error.length > 0) {
		throw new ElectronManagedSessionPolicyError(policy.error);
	}
	if (!policy.lock) {
		throw new ElectronManagedSessionPolicyError(
			signal?.aborted === true
				? "Electron helper was aborted."
				: "Electron helper could not acquire managed-session policy coordination.",
		);
	}
	return policy.lock;
}
export async function withOwnedElectronManagedSessionPolicy<T>(
	options: ElectronManagedSessionPolicy & { readonly args: readonly string[] },
	run: () => Promise<T>,
): Promise<T> {
	return withAgentBrowserProcessEnvironment(
		{ AGENT_BROWSER_CONFIRM_ACTIONS: options.confirmActions },
		async () => {
			const autosavePolicyChangeError = getRunningHeadedAutosavePolicyChangeError(
				options.headedManagedAutosaveInterval,
			);
			if (autosavePolicyChangeError !== undefined && autosavePolicyChangeError.length > 0) {
				throw new ElectronManagedSessionPolicyError(autosavePolicyChangeError);
			}
			const context = buildOwnedManagedSessionRestoreContext({
				args: [
					"--namespace",
					options.namespace ?? "",
					"--session",
					options.sessionName,
					...options.args,
				],
				cwd: options.cwd,
				headedManagedAutosaveInterval: options.headedManagedAutosaveInterval,
				managedSessionName: options.sessionName,
				namespace: options.namespace,
				restoreState: options.restoreState,
			});
			if (!context) {
				throw new ElectronManagedSessionPolicyError(
					"Electron helper could not establish wrapper ownership for its managed session.",
				);
			}
			const policy = await acquireElectronPolicy(options, context);
			try {
				requirePolicyLock(policy, options.signal);
				return await withOwnedManagedSessionContext(context, run);
			} finally {
				await policy.lock?.release();
			}
		},
	);
}
export async function collectOwnedElectronManagedSessionTarget(
	options: ElectronManagedSessionPolicy,
): Promise<ElectronManagedSessionTarget> {
	try {
		const target = (await withOwnedElectronManagedSessionPolicy(
			{ ...options, args: ["get", "url"] },
			() =>
				collectElectronManagedSessionTarget({
					cwd: options.cwd,
					namespace: options.namespace,
					sessionName: options.sessionName,
					signal: options.signal,
					timeoutMs: options.timeoutMs,
				}),
		)) ?? { sessionName: options.sessionName };
		return { ...target, namespace: options.namespace };
	} catch (error) {
		return {
			error: normalizeProcessError(error).message,
			namespace: options.namespace,
			sessionName: options.sessionName,
		};
	}
}
