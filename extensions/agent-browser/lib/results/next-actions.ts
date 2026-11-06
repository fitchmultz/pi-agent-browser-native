import type { AgentBrowserNextAction } from "./action-contracts.js";

export type { AgentBrowserNextAction } from "./action-contracts.js";

export function withOptionalNamespaceArgs(
	namespace: string | undefined,
	args: readonly string[],
): readonly string[] {
	return namespace !== undefined && args[0] !== "--namespace"
		? ["--namespace", namespace, ...args]
		: args;
}

export function withOptionalSessionArgs(
	sessionName: string | undefined,
	args: readonly string[],
): readonly string[] {
	if (
		sessionName === undefined ||
		sessionName.length === 0 ||
		args[0] === "--session" ||
		(args[0] === "--namespace" && args[2] === "--session")
	) {
		return args;
	}
	const namespace = args[1];
	if (args[0] === "--namespace" && namespace !== undefined) {
		return [args[0], namespace, "--session", sessionName, ...args.slice(2)];
	}
	return ["--session", sessionName, ...args];
}

export function applyNamespaceToNextActions(
	actions: readonly AgentBrowserNextAction[] | undefined,
	namespace: string | undefined,
): readonly AgentBrowserNextAction[] | undefined {
	if (namespace === undefined || !actions) {
		return actions;
	}
	return actions.map((action) => {
		const args = action.params?.args;
		if (args) {
			return {
				...action,
				params: { ...action.params, args: withOptionalNamespaceArgs(namespace, args) },
			};
		}
		return action.tool === "agent_browser_network_source"
			? { ...action, params: { ...action.params, namespace } }
			: action;
	});
}

export function applySessionToNextActions(
	actions: readonly AgentBrowserNextAction[] | undefined,
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] | undefined {
	if (sessionName === undefined || sessionName.length === 0 || !actions) {
		return actions;
	}
	return actions.map((action) => {
		// Fresh-session actions deliberately target a new session; the planner ignores sessionMode when an
		// explicit --session is present, so prefixing one here would silently downgrade them to reuse.
		if (action.params?.sessionMode === "fresh") {
			return action;
		}
		const args = action.params?.args;
		return args
			? {
					...action,
					params: { ...action.params, args: withOptionalSessionArgs(sessionName, args) },
				}
			: action;
	});
}

export function buildNextToolAction(options: {
	readonly args: readonly string[];
	readonly id: string;
	readonly reason: string;
	readonly safety?: string;
	readonly sessionMode?: "auto" | "fresh";
	readonly stdin?: string;
}): AgentBrowserNextAction {
	return {
		id: options.id,
		params: {
			args: options.args,
			...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
			...(options.stdin !== undefined && options.stdin.length > 0 ? { stdin: options.stdin } : {}),
		},
		reason: options.reason,
		...(options.safety !== undefined && options.safety.length > 0
			? { safety: options.safety }
			: {}),
		tool: "agent_browser",
	};
}

export function buildInspectOverlayStateAction(sessionName?: string): AgentBrowserNextAction {
	return buildNextToolAction({
		args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]),
		id: "inspect-overlay-state",
		reason:
			"Refresh interactive refs and inspect whether an overlay, banner, modal, or dialog is blocking the intended click.",
		safety:
			"Read-only inspection; do not blindly retry the blocked click, and use current refs from this snapshot before interacting.",
	});
}

// This accumulator is caller-owned mutable state; append preserves its identity and side effects.
export type AgentBrowserNextActionAccumulator = AgentBrowserNextAction[];

export function appendUniqueAgentBrowserNextActions(
	target: AgentBrowserNextActionAccumulator,
	additions: readonly AgentBrowserNextAction[] | undefined,
): AgentBrowserNextAction[] {
	if (!additions || additions.length === 0) {
		return target;
	}
	const existingIds = new Set(target.map((action) => action.id));
	for (const action of additions) {
		if (existingIds.has(action.id)) {
			continue;
		}
		target.push(action);
		existingIds.add(action.id);
	}
	return target;
}

export function isStandaloneSnapshotNextAction(action: AgentBrowserNextAction): boolean {
	const args = action.params?.args;
	if (!args || (action.params.stdin !== undefined && action.params.stdin.length > 0)) {
		return false;
	}
	let commandIndex = args[0] === "--namespace" ? 2 : 0;
	if (args[commandIndex] === "--session") {
		commandIndex += 2;
	}
	return args[commandIndex] === "snapshot";
}

export function alignPageChangeSummaryNextActionIds<
	T extends { readonly nextActionIds?: readonly string[] | undefined },
>(
	summary: T | undefined,
	nextActions: readonly AgentBrowserNextAction[] | undefined,
): T | undefined {
	if (!summary?.nextActionIds || !nextActions) {
		return summary;
	}
	const nextActionIds = new Set(nextActions.map((action) => action.id));
	const alignedIds = summary.nextActionIds.filter((id) => nextActionIds.has(id));
	return alignedIds.length > 0
		? { ...summary, nextActionIds: alignedIds }
		: { ...summary, nextActionIds: undefined };
}
