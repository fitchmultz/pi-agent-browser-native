import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatAgentBrowserRenderCall } from "./pi-tool-rendering.js";
import type { TUnsafe } from "./json-schema.js";
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
import { ADVANCED_TOOL_PROMPT_GUIDELINES, buildToolPromptGuidelines } from "./playbook.js";

export type AgentBrowserExecutor = ToolDefinition<TUnsafe<AgentBrowserExecuteParams>>["execute"];
export type AgentBrowserCodeExecutor = ToolDefinition<TUnsafe<AgentBrowserCodeParams>>["execute"];

export interface AgentBrowserToolSurfaceOptions {
	execute: AgentBrowserExecutor;
	executeCode: AgentBrowserCodeExecutor;
	promptGuidelines?: string[];
	executionMode?: ToolDefinition["executionMode"];
	renderCall?: ToolDefinition<typeof AGENT_BROWSER_PARAMS>["renderCall"];
	renderResult?: ToolDefinition<TUnsafe<unknown>>["renderResult"];
}

export const AGENT_BROWSER_TOOL_INVENTORY = {
	action: { name: "agent_browser_action", description: "Click, check, fill, or select a unique accessible target using stable locators or current refs." },
	qa: { name: "agent_browser_qa", description: "Check a URL or attached page with visible assertions and a diagnostic pass/fail verdict." },
	electron: { name: "agent_browser_electron", description: "Discover, launch, probe, and clean up owned Electron desktop applications." },
	source: { name: "agent_browser_source", description: "Find experimental DOM/React/local-source candidates with a bounded workspace scan." },
	network: { name: "agent_browser_network_source", description: "Correlate failed requests with initiator and local-source candidates." },
} as const satisfies Record<AgentBrowserAdvancedTool, { name: string; description: string }>;

const advancedNames = new Set<string>(Object.values(AGENT_BROWSER_TOOL_INVENTORY).map(({ name }) => name));

/** Register once; advanced calls adapt only their input shape and reuse the ordinary executor. */
export function registerAgentBrowserToolSurface(pi: ExtensionAPI, options: AgentBrowserToolSurfaceOptions): void {
	pi.registerTool({
		name: "agent_browser",
		label: "Agent Browser",
		description: "Browse and interact through native agent-browser commands. One command in args; fixed sequences use batch --bail and JSON-array stdin. Use agent_browser_code for loops/branches and agent_browser_tools for advanced capabilities.",
		promptSnippet: "Browse pages, inspect current refs, interact, and run native command batches.",
		promptGuidelines: options.promptGuidelines ?? buildToolPromptGuidelines({ includeWebSearch: false }),
		parameters: AGENT_BROWSER_PARAMS,
		renderCall: options.renderCall,
		renderResult: options.renderResult,
		execute: options.execute,
		executionMode: options.executionMode,
	});
	pi.registerTool({
		name: "agent_browser_code",
		label: "Agent Browser Code",
		description: "Run fresh JavaScript against a persistent browser. await browser({args,stdin?,timeoutMs?}) returns success/data/error/nextActions and imageObservations; emit(selected JSON) and emitImage(image handle) explicitly choose output. No host APIs or imports. Use native batch for fixed sequences.",
		promptSnippet: "Branch, loop, and aggregate browser observations with explicit JSON/image output.",
		parameters: AGENT_BROWSER_CODE_PARAMS,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute: options.executeCode,
		executionMode: options.executionMode,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
			return text;
		},
		renderResult: options.renderResult,
	});

	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.action,
		label: "Browser Action",
		promptGuidelines: [...ADVANCED_TOOL_PROMPT_GUIDELINES.action],
		parameters: AGENT_BROWSER_ACTION_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
		execute(id, { outputPath, timeoutMs, ...semanticAction }, signal, onUpdate, ctx) {
			return options.execute(id, { semanticAction, outputPath, timeoutMs }, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.qa,
		label: "Browser QA",
		promptGuidelines: [...ADVANCED_TOOL_PROMPT_GUIDELINES.qa],
		parameters: AGENT_BROWSER_QA_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
		execute(id, { outputPath, timeoutMs, sessionMode, ...qa }, signal, onUpdate, ctx) {
			return options.execute(id, { qa, outputPath, timeoutMs, sessionMode }, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.electron,
		label: "Browser Electron",
		promptGuidelines: [...ADVANCED_TOOL_PROMPT_GUIDELINES.electron],
		parameters: AGENT_BROWSER_ELECTRON_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
		execute(id, { outputPath, ...electron }, signal, onUpdate, ctx) {
			return options.execute(id, { electron, outputPath }, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.source,
		label: "Browser Source",
		promptGuidelines: [...ADVANCED_TOOL_PROMPT_GUIDELINES.source],
		parameters: AGENT_BROWSER_SOURCE_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
		execute(id, { outputPath, timeoutMs, sessionMode, ...sourceLookup }, signal, onUpdate, ctx) {
			return options.execute(id, { sourceLookup, outputPath, timeoutMs, sessionMode }, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...AGENT_BROWSER_TOOL_INVENTORY.network,
		label: "Browser Network Source",
		promptGuidelines: [...ADVANCED_TOOL_PROMPT_GUIDELINES.network],
		parameters: AGENT_BROWSER_NETWORK_SOURCE_PARAMS,
		renderResult: options.renderResult,
		executionMode: options.executionMode,
		execute(id, { outputPath, timeoutMs, sessionMode, ...networkSourceLookup }, signal, onUpdate, ctx) {
			return options.execute(id, { networkSourceLookup, outputPath, timeoutMs, sessionMode }, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		name: "agent_browser_tools",
		label: "Browser Tools",
		description: "List or enable advanced browser tools: action → agent_browser_action; qa → agent_browser_qa; electron → agent_browser_electron; source → agent_browser_source; network → agent_browser_network_source. Omit enable for inventory. Activation only adds tools; it preserves other active tools.",
		promptSnippet: "Discover and enable specialized browser actions, QA, Electron, and source tools.",
		parameters: AGENT_BROWSER_TOOLS_PARAMS,
		async execute(_id, params) {
			const available = new Set(pi.getAllTools().map(({ name }) => name));
			const active = new Set(pi.getActiveTools());
			const added = (params.enable ?? []).map((key) => AGENT_BROWSER_TOOL_INVENTORY[key].name)
				.filter((name) => available.has(name) && !active.has(name));
			if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);
			const current = new Set(pi.getActiveTools());
			const inventory = Object.entries(AGENT_BROWSER_TOOL_INVENTORY).map(([key, tool]) => ({
				key, ...tool, available: available.has(tool.name), active: current.has(tool.name),
			}));
			return {
				content: [{ type: "text", text: inventory.map((tool) => `${tool.key}: ${tool.name} (${!tool.available ? "unavailable in this Pi tool selection" : tool.active ? "active" : "inactive"}) — ${tool.description}`).join("\n") }],
				details: { inventory, added: [...new Set(added)] },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Pi owns selected tools and their durable system-message history; keep no parallel registry.
		const argv = process.argv.slice(2);
		const delimiter = argv.indexOf("--");
		if ((delimiter < 0 ? argv : argv.slice(0, delimiter)).some((arg) => arg === "--tools" || arg === "-t")) return;
		// A host-filtered catalog is an explicit selection, not our default surface.
		const available = new Set(pi.getAllTools().map(({ name }) => name));
		if (!["agent_browser", "agent_browser_code", "agent_browser_tools", ...advancedNames].every(name => available.has(name))) return;
		// Keep Pi's replay helper behind the awaited restoration boundary, not factory registration.
		const { getCurrentSystemMessage } = await import("@earendil-works/pi-ai");
		const current = getCurrentSystemMessage(ctx.sessionManager.buildSessionProjection().messages);
		const restored = new Set(current?.toolsAdded?.map(({ name }) => name));
		const active = pi.getActiveTools().filter((name) => !advancedNames.has(name) || restored.has(name));
		pi.setActiveTools([...new Set([...active, ...[...restored].filter((name) => advancedNames.has(name) && available.has(name))])]);
	});
}
