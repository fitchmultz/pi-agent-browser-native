import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUnsafe } from "./json-schema.js";
import {
	AGENT_BROWSER_NAMESPACE,
	AGENT_BROWSER_OUTPUT_SCHEMA,
	finalizeAgentBrowserNativeResult,
} from "./native-output.js";
import {
	AGENT_BROWSER_PARAMS,
	AGENT_BROWSER_ACTION_PARAMS,
	AGENT_BROWSER_QA_PARAMS,
	AGENT_BROWSER_ELECTRON_PARAMS,
	AGENT_BROWSER_SOURCE_PARAMS,
	AGENT_BROWSER_NETWORK_SOURCE_PARAMS,
	type AgentBrowserAdvancedTool,
} from "./input-modes/params.js";
import type { AgentBrowserExecuteParams } from "./orchestration/input-plan.js";

export type AgentBrowserExecutor = ToolDefinition<TUnsafe<AgentBrowserExecuteParams>>["execute"];

export interface AgentBrowserToolSurfaceOptions {
	readonly execute: AgentBrowserExecutor;
	readonly executionMode?: ToolDefinition["executionMode"];
	readonly renderCall?: ToolDefinition<typeof AGENT_BROWSER_PARAMS>["renderCall"];
	readonly renderResult?: ToolDefinition<TUnsafe>["renderResult"];
}

export const AGENT_BROWSER_TOOL_INVENTORY = {
	action: {
		name: "agent_browser_action",
		description:
			"Click, check, fill, or select a unique accessible target using stable locators or current refs.",
	},
	qa: {
		name: "agent_browser_qa",
		description:
			"Check a URL or attached page with visible assertions and a diagnostic pass/fail verdict.",
	},
	electron: {
		name: "agent_browser_electron",
		description: "Discover, launch, probe, and clean up owned Electron desktop applications.",
	},
	source: {
		name: "agent_browser_source",
		description:
			"Find experimental DOM/React/local-source candidates with a bounded workspace scan.",
	},
	network: {
		name: "agent_browser_network_source",
		description: "Correlate failed requests with initiator and local-source candidates.",
	},
} as const satisfies Record<AgentBrowserAdvancedTool, { name: string; description: string }>;

function nativeToolOptions(
	options: AgentBrowserToolSurfaceOptions,
): Pick<ToolDefinition<TUnsafe>, "namespace" | "outputSchema" | "executionMode" | "renderResult"> {
	return {
		namespace: AGENT_BROWSER_NAMESPACE,
		outputSchema: AGENT_BROWSER_OUTPUT_SCHEMA,
		...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
		...(options.renderResult === undefined ? {} : { renderResult: options.renderResult }),
	};
}

function registerBrowserTool(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		name: "agent_browser",
		...nativeToolOptions(options),
		label: "Agent Browser",
		description:
			"Browse and interact through native agent-browser commands. One command in args; fixed sequences use batch --bail and JSON-array stdin; loops and branches belong in codemode scripts.",
		promptSnippet: "Browse pages, inspect current refs, interact, and run native command batches.",
		parameters: AGENT_BROWSER_PARAMS,
		...(options.renderCall === undefined ? {} : { renderCall: options.renderCall }),
		execute,
	});
}

function registerActionTool(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.action,
		...nativeToolOptions(options),
		exposure: "deferred",
		label: "Browser Action",
		parameters: AGENT_BROWSER_ACTION_PARAMS,
		// oxlint-disable-next-line max-params -- QX-002: Pi passes context in execute position five.
		execute(id, { outputPath, timeoutMs, ...semanticAction }, signal, onUpdate, ctx) {
			return execute(id, { semanticAction, outputPath, timeoutMs }, signal, onUpdate, ctx);
		},
	});
}

function registerQaTool(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.qa,
		...nativeToolOptions(options),
		exposure: "deferred",
		label: "Browser QA",
		parameters: AGENT_BROWSER_QA_PARAMS,
		// oxlint-disable-next-line max-params -- QX-002: Pi passes context in execute position five.
		execute(id, { outputPath, timeoutMs, sessionMode, ...qa }, signal, onUpdate, ctx) {
			return execute(id, { qa, outputPath, timeoutMs, sessionMode }, signal, onUpdate, ctx);
		},
	});
}

function registerElectronTool(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.electron,
		...nativeToolOptions(options),
		exposure: "deferred",
		label: "Browser Electron",
		parameters: AGENT_BROWSER_ELECTRON_PARAMS,
		// oxlint-disable-next-line max-params -- QX-002: Pi passes context in execute position five.
		execute(id, { outputPath, ...electron }, signal, onUpdate, ctx) {
			return execute(id, { electron, outputPath }, signal, onUpdate, ctx);
		},
	});
}

function registerSourceTools(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.source,
		...nativeToolOptions(options),
		exposure: "deferred",
		label: "Browser Source",
		parameters: AGENT_BROWSER_SOURCE_PARAMS,
		// oxlint-disable-next-line max-params -- QX-002: Pi passes context in execute position five.
		execute(id, { outputPath, timeoutMs, sessionMode, ...sourceLookup }, signal, onUpdate, ctx) {
			return execute(
				id,
				{ sourceLookup, outputPath, timeoutMs, sessionMode },
				signal,
				onUpdate,
				ctx,
			);
		},
	});
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.network,
		...nativeToolOptions(options),
		exposure: "deferred",
		label: "Browser Network Source",
		parameters: AGENT_BROWSER_NETWORK_SOURCE_PARAMS,
		// oxlint-disable-next-line max-params -- QX-002: Pi passes context in execute position five.
		execute(
			id,
			{ outputPath, timeoutMs, sessionMode, ...networkSourceLookup },
			signal,
			onUpdate,
			ctx,
		) {
			return execute(
				id,
				{ networkSourceLookup, outputPath, timeoutMs, sessionMode },
				signal,
				onUpdate,
				ctx,
			);
		},
	});
}

/** Replays the branch's recorded tool loadout (Pi docs/session-format.md) for one tool. */
function removedOnBranch(ctx: ExtensionContext, name: string): boolean {
	let removed = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "system") {
			continue;
		}
		if (entry.message.toolsRemoved?.some((tool) => tool.name === name) === true) {
			removed = true;
		}
		if (entry.message.toolsAdded?.some((tool) => tool.name === name) === true) {
			removed = false;
		}
	}
	return removed;
}

/**
 * Pi's own MCP extension activates tool_search when it registers deferred tools, since only
 * tool_search declares them. Only a registered tool_search that reaches other tools qualifies.
 * Pi restores each branch's recorded loadout before session_start and session_tree; a branch
 * that recorded removing tool_search keeps it off, as Pi keeps any recorded removal.
 */
function activateToolSearch(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	if (
		!active.includes("tool_search") &&
		pi
			.getAllTools()
			.some((tool) => tool.name === "tool_search" && tool.reachesTools !== undefined) &&
		!removedOnBranch(ctx, "tool_search")
	) {
		pi.setActiveTools([...active, "tool_search"]);
	}
}

const DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set(
	Object.values(AGENT_BROWSER_TOOL_INVENTORY).map(({ name }) => name),
);

/** Whether the agent can call every registered deferred tool: each is active, or an active tool_search or codemode reaches them. */
function deferredToolsReachable(pi: ExtensionAPI): boolean {
	const registered = pi.getAllTools();
	const active = pi.getActiveTools();
	return (
		registered.every((tool) => !DEFERRED_TOOL_NAMES.has(tool.name) || active.includes(tool.name)) ||
		registered.some(
			(tool) =>
				(tool.name === "tool_search" || tool.name === "codemode") &&
				tool.reachesTools !== undefined &&
				active.includes(tool.name),
		)
	);
}

/** Register once; advanced tools are deferred, so tool_search and codemode scripts reach them natively. */
export function registerAgentBrowserToolSurface(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
): void {
	// Like Pi's own MCP extension, warn once instead of leaving deferred tools silently unreachable.
	// Check as a run starts: extensions that load later, such as Pi's MCP extension, can still
	// activate tool_search or codemode in their own session_start handlers.
	let warnedUnreachable = false;
	pi.on("session_start", (_event, ctx) => activateToolSearch(pi, ctx));
	pi.on("session_tree", (_event, ctx) => activateToolSearch(pi, ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		if (warnedUnreachable || deferredToolsReachable(pi)) {
			return;
		}
		warnedUnreachable = true;
		ctx.ui.notify(
			"Browser tools that are not selected directly are only reachable from the tool_search or codemode tool, but neither is active; they cannot be called.",
			"warning",
		);
	});
	// oxlint-disable-next-line max-params -- QX-002: Pi passes context in execute position five.
	const execute: AgentBrowserExecutor = async (id, params, signal, onUpdate, ctx) =>
		finalizeAgentBrowserNativeResult(
			await options.execute(id, params, signal, onUpdate, ctx),
			params,
		);
	registerBrowserTool(pi, options, execute);
	registerActionTool(pi, options, execute);
	registerQaTool(pi, options, execute);
	registerElectronTool(pi, options, execute);
	registerSourceTools(pi, options, execute);
}
