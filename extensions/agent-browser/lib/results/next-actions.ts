export interface AgentBrowserNextAction {
	artifactPath?: string;
	id: string;
	params?: {
		args?: string[];
		electron?: {
			action: "cleanup" | "list" | "launch" | "probe" | "status";
			all?: boolean;
			handoff?: "connect" | "snapshot" | "tabs";
			launchId?: string;
		};
		networkSourceLookup?: {
			filter?: string;
			namespace?: string;
			requestId?: string;
			session?: string;
			url?: string;
		};
		sessionMode?: "auto" | "fresh";
		stdin?: string;
	};
	reason: string;
	safety?: string;
	tool: "agent_browser";
}

export function withOptionalNamespaceArgs(namespace: string | undefined, args: string[]): string[] {
	return namespace !== undefined && args[0] !== "--namespace" ? ["--namespace", namespace, ...args] : args;
}

export function withOptionalSessionArgs(sessionName: string | undefined, args: string[]): string[] {
	if (!sessionName || args[0] === "--session" || (args[0] === "--namespace" && args[2] === "--session")) return args;
	if (args[0] === "--namespace" && args.length >= 2) return [args[0], args[1], "--session", sessionName, ...args.slice(2)];
	return ["--session", sessionName, ...args];
}

export function applyNamespaceToNextActions(actions: AgentBrowserNextAction[] | undefined, namespace: string | undefined): AgentBrowserNextAction[] | undefined {
	if (namespace === undefined || !actions) return actions;
	return actions.map((action) => {
		const args = action.params?.args;
		if (args) return { ...action, params: { ...action.params, args: withOptionalNamespaceArgs(namespace, args) } };
		const networkSourceLookup = action.params?.networkSourceLookup;
		return networkSourceLookup ? { ...action, params: { ...action.params, networkSourceLookup: { ...networkSourceLookup, namespace } } } : action;
	});
}

export function applySessionToNextActions(actions: AgentBrowserNextAction[] | undefined, sessionName: string | undefined): AgentBrowserNextAction[] | undefined {
	if (!sessionName || !actions) return actions;
	return actions.map((action) => {
		// Fresh-session actions deliberately target a new session; the planner ignores sessionMode when an
		// explicit --session is present, so prefixing one here would silently downgrade them to reuse.
		if (action.params?.sessionMode === "fresh") return action;
		const args = action.params?.args;
		return args ? { ...action, params: { ...action.params, args: withOptionalSessionArgs(sessionName, args) } } : action;
	});
}

export function buildNextToolAction(options: {
	args: string[];
	id: string;
	reason: string;
	safety?: string;
	sessionMode?: "auto" | "fresh";
	stdin?: string;
}): AgentBrowserNextAction {
	return {
		id: options.id,
		params: {
			args: options.args,
			...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
			...(options.stdin ? { stdin: options.stdin } : {}),
		},
		reason: options.reason,
		...(options.safety ? { safety: options.safety } : {}),
		tool: "agent_browser",
	};
}

export function appendUniqueAgentBrowserNextActions(
	target: AgentBrowserNextAction[],
	additions: AgentBrowserNextAction[] | undefined,
): AgentBrowserNextAction[] {
	if (!additions || additions.length === 0) return target;
	const existingIds = new Set(target.map((action) => action.id));
	for (const action of additions) {
		if (existingIds.has(action.id)) continue;
		target.push(action);
		existingIds.add(action.id);
	}
	return target;
}

export function isStandaloneSnapshotNextAction(action: AgentBrowserNextAction): boolean {
	const args = action.params?.args;
	if (!args || action.params?.stdin) return false;
	let commandIndex = args[0] === "--namespace" ? 2 : 0;
	if (args[commandIndex] === "--session") commandIndex += 2;
	return args[commandIndex] === "snapshot";
}

export function alignPageChangeSummaryNextActionIds<T extends { nextActionIds?: string[] }>(
	summary: T | undefined,
	nextActions: AgentBrowserNextAction[] | undefined,
): T | undefined {
	if (!summary?.nextActionIds || !nextActions) return summary;
	const nextActionIds = new Set(nextActions.map((action) => action.id));
	const alignedIds = summary.nextActionIds.filter((id) => nextActionIds.has(id));
	return alignedIds.length > 0 ? { ...summary, nextActionIds: alignedIds } : { ...summary, nextActionIds: undefined };
}
