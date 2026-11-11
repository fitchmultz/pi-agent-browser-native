import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionPageState } from "../session-page-state.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { captureBrowserBranch, type BrowserBranch } from "../browser-journal.js";
import {
	createEphemeralSessionSeed,
	createImplicitSessionName,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	type CompatibilityWorkaround,
} from "../runtime.js";
import { ManagedSessionRestoreState } from "../managed-session-restore.js";
import { TraceOwnership } from "../trace-ownership.js";
import { AsyncExecutionQueue, KeyedAsyncExecutionQueue } from "./execution-queue.js";
import { BrowserPrompt } from "./extension-prompt.js";
import { BrowserArtifacts } from "./extension-artifacts.js";
import { BrowserElectronResources } from "./extension-electron-ownership.js";
import type { NetworkRouteRecord } from "../results/contracts.js";
import { BrowserRecordingRegistry } from "./extension-recording.js";

import type {
	OwnedManagedSessionStore,
	ValidatedUpstreamPaths,
} from "./extension-resource-contracts.js";

/** Launch and cleanup ownership for the extension's managed browser identities. */
export class BrowserManagedSessions {
	active = false;
	baseName: string;
	compatibilityWorkaround: CompatibilityWorkaround | undefined;
	headedAutosaveDisabled = false;
	headedAutosaveInterval: string | undefined;
	name: string;
	cwd = process.cwd();
	namespace: string | undefined;
	freshOrdinal = 0;
	readonly restore = new ManagedSessionRestoreState();
	readonly owned: OwnedManagedSessionStore = new Map();
	constructor(seed: string) {
		this.baseName = createImplicitSessionName(undefined, process.cwd(), seed);
		this.name = this.baseName;
	}
	initializeBase(sessionId: string, cwd: string, seed: string): void {
		this.baseName = createImplicitSessionName(sessionId, cwd, seed);
	}
	reset(): void {
		this.active = false;
		this.compatibilityWorkaround = undefined;
		this.headedAutosaveDisabled = false;
		this.headedAutosaveInterval = undefined;
		this.namespace = undefined;
		this.owned.clear();
	}
}
/** Live page-scoped state; clear and reset preserve the existing replacement semantics. */
export class BrowserSessionResources {
	pages = new SessionPageState();
	traces = new TraceOwnership();
	attached = new Set<string>();
	routes: ReadonlyMap<string, readonly NetworkRouteRecord[]> = new Map();
	getConfirmActions(key: string): string | undefined {
		return this.pages.get(key).confirmActions;
	}
	hasAttachment(key: string): boolean {
		return this.attached.has(key);
	}
	clear(sessionName: string, namespace?: string): void {
		const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
		this.attached.delete(key);
		const routes = new Map(this.routes);
		routes.delete(key);
		this.routes = routes;
		this.traces.clearSession(key);
		this.pages.clearSession(key);
	}
	reset(): void {
		this.pages.reset();
		this.traces.reset();
		this.attached = new Set();
		this.routes = new Map();
	}
}
/** Branch-current generation and shared empty-root admission, independent of browser resources. */
export class BrowserBranchState {
	private empty: BrowserBranch | undefined;
	ownerSessionId = "";
	replayError: string | undefined;
	private restoreGeneration = 0;
	private stateRevision = 0;
	get stateGeneration(): number {
		return this.stateRevision;
	}
	invalidateRestore(): void {
		this.restoreGeneration += 1;
	}
	advanceState(): void {
		this.stateRevision += 1;
	}
	invalidate(): void {
		this.invalidateRestore();
		this.advanceState();
	}
	beginRestore(ownerSessionId: string): void {
		this.invalidate();
		this.ownerSessionId = ownerSessionId;
	}
	setReplayError(error: string | undefined): void {
		this.replayError = error;
	}
	capture(ctx: ExtensionContext): BrowserBranch {
		const generation = this.restoreGeneration;
		const empty = ctx.sessionManager.getLeafId() === null;
		if (
			empty &&
			this.empty?.anchorId === null &&
			this.empty.sessionId === ctx.sessionManager.getSessionId() &&
			this.empty.isCurrent()
		) {
			return this.empty;
		}
		const branch = captureBrowserBranch(
			ctx.sessionManager,
			() => generation === this.restoreGeneration,
		);
		this.empty = empty ? branch : undefined;
		return branch;
	}
}
/** Readonly root composition. Mutable resources have focused lifetime owners. */
export class BrowserRuntime {
	readonly prompt: BrowserPrompt;
	readonly artifacts: BrowserArtifacts;
	readonly recordings: BrowserRecordingRegistry;
	readonly electron = new BrowserElectronResources();
	readonly managed: BrowserManagedSessions;
	readonly sessions = new BrowserSessionResources();
	readonly branch = new BrowserBranchState();
	readonly pi: ExtensionAPI;
	readonly beforeExecute:
		| ((toolCallId: string, ctx: ExtensionContext) => Promise<void>)
		| undefined;
	readonly ephemeralSessionSeed = createEphemeralSessionSeed();
	readonly implicitSessionIdleTimeoutMs = String(getImplicitSessionIdleTimeoutMs());
	readonly implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	readonly managedSessionExecutionQueue = new AsyncExecutionQueue();
	readonly callerOwnedSessionExecutionQueues = new KeyedAsyncExecutionQueue();
	readonly validatedUpstreamPathKeys: ValidatedUpstreamPaths = new Set();
	constructor(
		pi: ExtensionAPI,
		beforeExecute?: (toolCallId: string, ctx: ExtensionContext) => Promise<void>,
	) {
		this.pi = pi;
		this.managed = new BrowserManagedSessions(this.ephemeralSessionSeed);
		this.prompt = new BrowserPrompt(pi);
		this.artifacts = new BrowserArtifacts(pi);
		this.recordings = new BrowserRecordingRegistry(pi, this.artifacts, () => this.managed.cwd);
		this.beforeExecute = beforeExecute;
	}
}
