import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatAgentBrowserRenderCall } from "./pi-tool-rendering.js";
import { JsonSchema, type TUnsafe } from "./json-schema.js";
import {
	AGENT_BROWSER_NAMESPACE,
	AGENT_BROWSER_OUTPUT_SCHEMA,
	finalizeAgentBrowserNativeResult,
} from "./native-output.js";
import {
	AGENT_BROWSER_PARAMS,
	AGENT_BROWSER_CODE_PARAMS,
	AGENT_BROWSER_ACTION_PARAMS,
	AGENT_BROWSER_QA_PARAMS,
	AGENT_BROWSER_ELECTRON_PARAMS,
	AGENT_BROWSER_SOURCE_PARAMS,
	AGENT_BROWSER_NETWORK_SOURCE_PARAMS,
	AGENT_BROWSER_TOOLS_PARAMS,
	type AgentBrowserCodeParams,
	type AgentBrowserAdvancedTool,
} from "./input-modes/params.js";
import type { AgentBrowserExecuteParams } from "./orchestration/input-plan.js";

export type AgentBrowserExecutor = ToolDefinition<TUnsafe<AgentBrowserExecuteParams>>["execute"];
export type AgentBrowserCodeExecutor = ToolDefinition<TUnsafe<AgentBrowserCodeParams>>["execute"];

export interface AgentBrowserToolSurfaceOptions {
	readonly execute: AgentBrowserExecutor;
	readonly executeCode: AgentBrowserCodeExecutor;
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

export const AGENT_BROWSER_INSTRUCTION_GROUP = {
	name: "browser",
	description:
		"Search the web, browse and interact with pages, verify browser UI, and inspect Electron apps.",
} as const;

const advancedNames = new Set<string>(
	Object.values(AGENT_BROWSER_TOOL_INVENTORY).map(({ name }) => name),
);

const nativeOutput = {
	namespace: AGENT_BROWSER_NAMESPACE,
	outputSchema: AGENT_BROWSER_OUTPUT_SCHEMA,
};

function registerCoreTools(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		name: "agent_browser",
		...nativeOutput,
		label: "Agent Browser",
		description:
			"Browse and interact through native agent-browser commands. One command in args; fixed sequences use batch --bail and JSON-array stdin. Use agent_browser_code for loops/branches and agent_browser_tools for advanced capabilities.",
		promptSnippet: "Browse pages, inspect current refs, interact, and run native command batches.",
		parameters: AGENT_BROWSER_PARAMS,
		renderCall: options.renderCall,
		renderResult: options.renderResult,
		execute,
		executionMode: options.executionMode,
	});
	pi.registerTool({
		name: "agent_browser_code",
		...nativeOutput,
		label: "Agent Browser Code",
		description:
			"Run fresh JavaScript against a persistent browser. await browser({args,stdin?,timeoutMs?}) returns success/data/error/nextActions and imageObservations; emit(selected JSON) and emitImage(image handle) explicitly choose output. No host APIs or imports. Use native batch for fixed sequences.",
		promptSnippet:
			"Branch, loop, and aggregate browser observations with explicit JSON/image output.",
		parameters: AGENT_BROWSER_CODE_PARAMS,
		execute: async (id, params, signal, onUpdate, ctx) =>
			finalizeAgentBrowserNativeResult(
				await options.executeCode(id, params, signal, onUpdate, ctx),
				params,
			),
		executionMode: options.executionMode,
		renderCall(args, theme, context) {
			const text =
				context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
			return text;
		},
		renderResult: options.renderResult,
	});
}

function registerActionTool(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
	execute: AgentBrowserExecutor,
): void {
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.action,
		...nativeOutput,
		defaultActive: false,
		label: "Browser Action",
		parameters: AGENT_BROWSER_ACTION_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
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
		...nativeOutput,
		defaultActive: false,
		label: "Browser QA",
		parameters: AGENT_BROWSER_QA_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
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
		...nativeOutput,
		defaultActive: false,
		label: "Browser Electron",
		parameters: AGENT_BROWSER_ELECTRON_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
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
		...nativeOutput,
		defaultActive: false,
		label: "Browser Source",
		parameters: AGENT_BROWSER_SOURCE_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
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
		...nativeOutput,
		defaultActive: false,
		label: "Browser Network Source",
		parameters: AGENT_BROWSER_NETWORK_SOURCE_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
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

function toolStatus(available: boolean, active: boolean): string {
	if (!available) {
		return "unavailable in this Pi tool selection";
	}
	return active ? "active" : "inactive";
}

function registerToolLoader(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agent_browser_tools",
		namespace: AGENT_BROWSER_NAMESPACE,
		outputSchema: JsonSchema.Object({
			inventory: JsonSchema.Array(
				JsonSchema.Object({
					key: JsonSchema.String(),
					name: JsonSchema.String(),
					description: JsonSchema.String(),
					available: JsonSchema.Boolean(),
					active: JsonSchema.Boolean(),
				}),
			),
			added: JsonSchema.Array(JsonSchema.String()),
		}),
		label: "Browser Tools",
		description:
			"List or enable advanced browser tools: action → agent_browser_action; qa → agent_browser_qa; electron → agent_browser_electron; source → agent_browser_source; network → agent_browser_network_source. Omit enable for inventory. Activation only adds tools; it preserves other active tools.",
		promptSnippet:
			"Discover and enable specialized browser actions, QA, Electron, and source tools.",
		parameters: AGENT_BROWSER_TOOLS_PARAMS,
		async execute(_id, params) {
			const available = new Set(pi.getAllTools().map(({ name }) => name));
			const active = new Set(pi.getActiveTools());
			const added = (params.enable ?? [])
				.map((key) => AGENT_BROWSER_TOOL_INVENTORY[key].name)
				.filter((name) => available.has(name) && !active.has(name));
			if (added.length > 0) {
				pi.setActiveTools([...new Set([...active, ...added])]);
			}
			const current = new Set(pi.getActiveTools());
			const inventory = Object.entries(AGENT_BROWSER_TOOL_INVENTORY).map(([key, tool]) => ({
				key,
				name: tool.name,
				description: tool.description,
				available: available.has(tool.name),
				active: current.has(tool.name),
			}));
			return {
				content: [
					{
						type: "text",
						text: inventory
							.map(
								(tool) =>
									`${tool.key}: ${tool.name} (${toolStatus(tool.available, tool.active)}) — ${tool.description}`,
							)
							.join("\n"),
					},
				],
				details: { inventory, added: [...new Set(added)] },
				structuredContent: { inventory, added: [...new Set(added)] },
			};
		},
	});
}

function hasExplicitToolSelection(): boolean {
	const argv = process.argv.slice(2);
	const delimiter = argv.indexOf("--");
	return (delimiter < 0 ? argv : argv.slice(0, delimiter)).some(
		(arg) => arg === "--tools" || arg === "-t",
	);
}

function registerAdvancedToolReplay(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// ponytail: Pi restores a transcript's tool loadout natively only in default-tool sessions;
		// `--no-builtin-tools` (SDK `noTools: "builtin"`) skips it. Remove once Pi restores that mode too.
		if (hasExplicitToolSelection()) {
			return;
		}
		// A host-filtered catalog is an explicit selection, not our default surface.
		const available = new Set(pi.getAllTools().map(({ name }) => name));
		if (
			!["agent_browser", "agent_browser_code", "agent_browser_tools", ...advancedNames].every(
				(name) => available.has(name),
			)
		) {
			return;
		}
		// Native dynamic imports bypass Pi's host-package aliases in consumer installs.
		// Only tool names are needed; replay native deltas without requiring the optional pi-ai peer.
		const restored = new Set<string>();
		for (const message of ctx.sessionManager.buildSessionProjection().messages) {
			if (message.role !== "system") {
				continue;
			}
			for (const removed of message.toolsRemoved ?? []) {
				restored.delete(removed.name);
			}
			for (const added of message.toolsAdded ?? []) {
				restored.add(added.name);
			}
		}
		const active = new Set(pi.getActiveTools());
		const added = [...restored].filter(
			(name) => advancedNames.has(name) && available.has(name) && !active.has(name),
		);
		if (added.length > 0) {
			pi.setActiveTools([...active, ...added]);
		}
	});
}

/** Register once; adapters retain native execution, output, activation, and replay contracts. */
export function registerAgentBrowserToolSurface(
	pi: ExtensionAPI,
	options: AgentBrowserToolSurfaceOptions,
): void {
	const execute: AgentBrowserExecutor = async (id, params, signal, onUpdate, ctx) =>
		finalizeAgentBrowserNativeResult(
			await options.execute(id, params, signal, onUpdate, ctx),
			params,
		);
	registerCoreTools(pi, options, execute);
	registerActionTool(pi, options, execute);
	registerQaTool(pi, options, execute);
	registerElectronTool(pi, options, execute);
	registerSourceTools(pi, options, execute);
	registerToolLoader(pi);
	registerAdvancedToolReplay(pi);
}
