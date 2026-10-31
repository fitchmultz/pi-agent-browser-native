import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentBrowserCodeExecutor } from "../tool-surface.js";
import { type BrowserBranch, requirePublishedBrowserJournal } from "../browser-journal.js";
import { buildExecutionPlan } from "../runtime.js";
import { extractExplicitSessionName, getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import {
	getAgentBrowserProcessEnvironment,
	withAgentBrowserProcessEnvironment,
} from "../process-environment.js";
import { withNativeSessionDefaults } from "./native-session-defaults.js";
import { getBrowserCwdError, resolveExecutionCwd } from "../execution-cwd.js";
import type { AgentBrowserCodeParams } from "../input-modes/params.js";
import {
	AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
	bindBrowserCodeCall,
	runAgentBrowserScript,
	type AgentBrowserScriptBrowserParams,
	type AgentBrowserScriptRunResult,
} from "../input-modes/script.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import {
	buildValidationFailureResult,
	resolveAgentBrowserInput,
	type ResolvedAgentBrowserValidInput,
} from "./input-plan.js";
import { applyAgentBrowserOutputPath } from "./output-file.js";
import { createBrowserCodeOutput } from "./script-mode.js";
import {
	resolveBrowserExecutionIdentity,
	withBrowserExecutionLock,
} from "../managed-session-policy-lock.js";
import { loadAgentBrowserConfigSync } from "../config.js";
import { getArtifactPreflightValidationError } from "./extension-artifact-preflight.js";
import { browserExecutionFailure } from "./extension-result-state.js";
import { shouldSerializeBrowserCommand } from "./extension-managed-ownership.js";
import { shouldIncludeProjectConfig } from "./extension-prompt.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import { executeBrowserInvocation } from "./extension-command-admission.js";
import { createBrowserInvocation } from "./extension-invocation.js";

export interface BrowserCodeInvocation {
	readonly toolCallId: string;
	readonly params: Readonly<AgentBrowserCodeParams>;
	readonly signal: AbortSignal | undefined;
	readonly ctx: Parameters<AgentBrowserCodeExecutor>[4];
	readonly branch: Readonly<BrowserBranch>;
}

interface CodeBrowserIdentity {
	readonly usedImplicitSession: boolean;
	readonly sessionName: string;
	readonly namespace: string | undefined;
	readonly key: string;
	readonly owned: boolean;
}
function codePreflight(
	pi: ExtensionAPI,
	replayError: string | undefined,
	invocation: BrowserCodeInvocation,
): { readonly cwd: string } | { readonly failure: AgentBrowserToolResult } {
	if (replayError !== undefined && replayError !== "") {
		return {
			failure: browserExecutionFailure(
				new Error(replayError),
				invocation.signal,
				"validation-error",
			),
		};
	}
	try {
		requirePublishedBrowserJournal(invocation.ctx.sessionManager);
		return { cwd: resolveExecutionCwd(pi, invocation.ctx) };
	} catch (error) {
		return { failure: browserExecutionFailure(error, invocation.signal, "validation-error") };
	}
}
class BrowserCodeExecution {
	/** A performance.now() timestamp bounding the whole cell, unaffected by wall-clock steps. */
	readonly deadline: number;
	readonly output = createBrowserCodeOutput();
	readonly nativeEnvironment = getAgentBrowserProcessEnvironment();
	readonly controller = new AbortController();
	readonly abort = (): void => {
		this.controller.abort(this.invocation.signal?.reason);
	};
	commandIndex = 0;
	journalFailed = false;
	constructor(
		readonly runtime: BrowserRuntime,
		readonly invocation: BrowserCodeInvocation,
		readonly operationCwd: string,
	) {
		this.deadline =
			performance.now() + (invocation.params.timeoutMs ?? AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS);
	}
	start(): void {
		const { runtime, invocation } = this;
		invocation.signal?.addEventListener("abort", this.abort, { once: true });
		if (invocation.signal?.aborted === true) {
			this.abort();
		}
		runtime.code.controllers.add(this.controller);
	}

	prepare(): ReturnType<typeof resolveAgentBrowserInput> {
		const { params } = this.invocation;
		const args = [
			...(params.namespace !== undefined ? ["--namespace", params.namespace] : []),
			...(params.session !== undefined ? ["--session", params.session] : []),
			"get",
			"url",
		];
		const input = resolveAgentBrowserInput({
			params: { args },
			getBatchPreflightValidationError: () => {
				// The identity-selection get-url probe has no batch rows to preflight.
			},
		});
		return input;
	}

	browserCwd(): string {
		const { runtime, invocation } = this;
		if (this.nativeEnvironment.AGENT_BROWSER_CONFIG !== undefined) {
			return this.operationCwd;
		}
		const session = invocation.params.session;
		if (session !== undefined && session !== "") {
			const key = getAgentBrowserSessionIdentityKey(
				session,
				invocation.params.namespace ?? this.nativeEnvironment.AGENT_BROWSER_NAMESPACE,
			);
			return runtime.managed.owned.get(key)?.cwd ?? invocation.ctx.cwd;
		}
		return runtime.managed.active ? runtime.managed.cwd : invocation.ctx.cwd;
	}

	nativeRoot(): NonNullable<Parameters<typeof withNativeSessionDefaults>[1]["root"]> {
		const { invocation } = this;
		const config = loadAgentBrowserConfigSync({
			cwd: invocation.ctx.cwd,
			includeProjectConfig: shouldIncludeProjectConfig(invocation.ctx),
		});
		const profile = config.trustedBrowserDefaultProfile;
		return {
			sessionId: invocation.ctx.sessionManager.getSessionId(),
			profile:
				profile?.policy === "always" && !/[\\/~]/.test(profile.name) ? profile.name : undefined,
			executablePath: config.trustedBrowserExecutablePath,
		};
	}

	async runAdmitted(
		root: Parameters<typeof withNativeSessionDefaults>[1]["root"],
		input: ResolvedAgentBrowserValidInput,
	): Promise<AgentBrowserToolResult> {
		const cwd = this.browserCwd();
		const error = getBrowserCwdError(cwd);
		if (error !== undefined && error !== "") {
			return browserExecutionFailure(new Error(error), this.controller.signal, "validation-error");
		}
		const selectedRoot =
			this.runtime.managed.active || this.runtime.managed.freshOrdinal > 0 ? undefined : root;
		return withNativeSessionDefaults(
			input,
			{ cwd, signal: this.controller.signal, root: selectedRoot },
			(nativeInput) => this.runNative(nativeInput),
		);
	}

	async runNative(input: ResolvedAgentBrowserValidInput): Promise<AgentBrowserToolResult> {
		const { runtime } = this;
		const plan = buildExecutionPlan(input.toolArgs, {
			freshSessionName: runtime.managed.name,
			managedSessionActive: runtime.managed.active,
			managedSessionName: runtime.managed.name,
			managedSessionNamespace: runtime.managed.namespace,
			sessionMode: "auto",
		});
		const sessionName = plan.sessionName ?? "default";
		const namespace = plan.namespace === "" ? undefined : plan.namespace;
		const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
		const identity = {
			usedImplicitSession: plan.usedImplicitSession,
			sessionName,
			namespace,
			key,
			owned: plan.managedSessionName !== undefined || runtime.managed.owned.has(key),
		};
		const run = () => this.runLocked(identity);
		return shouldSerializeBrowserCommand(runtime.managed.owned, runtime.electron.ownedRecords, {
			namespace,
			explicitSessionName: sessionName,
			managedSessionName: runtime.managed.name,
		})
			? runtime.managedSessionExecutionQueue.run(run, this.controller.signal)
			: runtime.callerOwnedSessionExecutionQueues.run(key, namespace, run, this.controller.signal);
	}

	async runLocked(identity: CodeBrowserIdentity): Promise<AgentBrowserToolResult> {
		const socketDir = this.runtime.managed.owned.get(identity.key)?.socketDir;
		const env =
			socketDir !== undefined && socketDir !== "" ? { PI_AGENT_BROWSER_SOCKET_DIR: socketDir } : {};
		return withAgentBrowserProcessEnvironment(env, async () => {
			const lease = await resolveBrowserExecutionIdentity({
				sessionName: identity.sessionName,
				namespace: identity.namespace,
				ownedManagedSession: identity.owned,
			});
			return withBrowserExecutionLock(
				{ identity: lease, deadline: this.deadline, signal: this.controller.signal },
				(signal) => this.runCell(signal, identity),
			);
		});
	}

	async dispatch(
		inner: AgentBrowserScriptBrowserParams,
		innerSignal: AbortSignal,
		identity: CodeBrowserIdentity,
	): Promise<Awaited<ReturnType<ReturnType<typeof createBrowserCodeOutput>["observe"]>>> {
		if (this.journalFailed) {
			throw new Error(
				"Browser-state persistence failed. Inspect the current page before continuing in another tool call.",
			);
		}
		const bound = bindBrowserCodeCall(inner, {
			sessionName: identity.sessionName,
			namespace: identity.namespace,
		});
		const args = [...bound.args];
		if (
			identity.usedImplicitSession &&
			!this.runtime.managed.active &&
			this.runtime.managed.name === identity.sessionName &&
			extractExplicitSessionName(inner.args) === undefined
		) {
			args.splice(args.indexOf("--session"), 2);
		}
		const { toolCallId, ctx, branch } = this.invocation;
		const result = await withAgentBrowserProcessEnvironment(
			{ AGENT_BROWSER_SESSION: this.nativeEnvironment.AGENT_BROWSER_SESSION },
			() =>
				executeBrowserInvocation(
					this.runtime,
					createBrowserInvocation({
						toolCallId,
						params: {
							args,
							stdin: inner.stdin,
							timeoutMs: Math.min(
								inner.timeoutMs ?? this.remainingMs(),
								Math.max(1, this.remainingMs()),
							),
						},
						signal: innerSignal,
						ctx,
						nativeToolCallId: toolCallId,
						capturedCwd: this.operationCwd,
						modelVisible: false,
						commandIndex: this.commandIndex++,
						selectedBranch: branch,
					}),
				),
		);
		if (isRecord(result.details) && result.details.browserStatePersistence !== undefined) {
			this.journalFailed = true;
			throw new Error(
				"The browser effect may already have happened and its finish could not be persisted. Inspect before continuing; dependent commands were stopped.",
			);
		}
		return this.output.observe(result);
	}

	/** Whole milliseconds left in the cell: inner calls and the script child take integer timeouts. */
	remainingMs(): number {
		return Math.ceil(this.deadline - performance.now());
	}

	async runCell(
		signal: AbortSignal,
		identity: CodeBrowserIdentity,
	): Promise<AgentBrowserToolResult> {
		const run = await runAgentBrowserScript({
			code: this.invocation.params.code,
			signal,
			timeoutMs: Math.max(1, this.remainingMs()),
			emitImage: (image) => this.output.emitImage(image),
			dispatch: (inner, innerSignal) => this.dispatch(inner, innerSignal, identity),
		});
		const result = await this.finish(run, identity);
		const path = this.invocation.params.outputPath;
		if (path === undefined || path === "") {
			return result;
		}
		return this.runtime.artifacts.queue.run(() => this.writeOutput(result, path));
	}

	async finish(
		run: AgentBrowserScriptRunResult,
		identity: CodeBrowserIdentity,
	): Promise<AgentBrowserToolResult> {
		const result = await this.output.finish(run, identity.sessionName, identity.namespace);
		if (this.journalFailed && isRecord(result.details)) {
			result.isError = true;
			result.details.resultCategory = "failure";
			result.details.failureCategory = "upstream-error";
			result.details.error =
				"Browser-state persistence failed. Dependent calls were stopped; inspect before continuing because already-dispatched effects may have happened.";
		}
		if (isRecord(result.details)) {
			result.details.browserEventVersion = 1;
		}
		return result;
	}

	async writeOutput(
		result: AgentToolResult<unknown>,
		outputPath: string,
	): Promise<AgentBrowserToolResult> {
		const error = getArtifactPreflightValidationError({
			args: [],
			cwd: this.operationCwd,
			outputPath,
			activeRecordingReservations: [...this.runtime.recordings.active.values()],
		});
		if (error !== undefined && error !== "") {
			const failure = browserExecutionFailure(new Error(error), undefined, "validation-error");
			return {
				...result,
				isError: true,
				content: [...failure.content, ...result.content],
				details: {
					...(isRecord(result.details) ? result.details : {}),
					...(isRecord(failure.details) ? failure.details : {}),
				},
			};
		}
		return applyAgentBrowserOutputPath({
			cwd: this.operationCwd,
			outputPath,
			preserveTextContent: true,
			result,
		});
	}

	async run(): Promise<AgentBrowserToolResult> {
		this.start();
		const timer = setTimeout(
			() =>
				this.controller.abort(new DOMException("Browser code deadline exceeded.", "TimeoutError")),
			Math.max(0, this.remainingMs()),
		);
		try {
			const input = this.prepare();
			if (input.status === "invalid") {
				return buildValidationFailureResult(input);
			}
			const root = this.nativeRoot();
			const session = this.invocation.params.session;
			const implicit =
				(session === undefined || session === "") &&
				this.nativeEnvironment.AGENT_BROWSER_CONFIG === undefined;
			return await (implicit
				? this.runtime.managedSessionExecutionQueue.run(
						() => this.runAdmitted(root, input),
						this.controller.signal,
					)
				: this.runAdmitted(root, input));
		} catch (error) {
			return browserExecutionFailure(error, this.controller.signal);
		} finally {
			clearTimeout(timer);
			this.runtime.code.controllers.delete(this.controller);
			this.invocation.signal?.removeEventListener("abort", this.abort);
		}
	}
}

export function executeCode(
	runtime: BrowserRuntime,
	invocation: BrowserCodeInvocation,
): Promise<AgentBrowserToolResult> {
	const prepared = codePreflight(runtime.pi, runtime.branch.replayError, invocation);
	if ("failure" in prepared) {
		return Promise.resolve(prepared.failure);
	}
	return new BrowserCodeExecution(runtime, invocation, prepared.cwd).run();
}
