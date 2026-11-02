import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AGENT_BROWSER_PARAMS } from "../input-modes/params.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import { registerAgentBrowserToolSurface } from "../tool-surface.js";
import { AgentBrowserResultComponent, formatAgentBrowserRenderCall } from "../pi-tool-rendering.js";
import { browserExecutionFailure } from "./extension-result-state.js";
import { finalizeObservation } from "./extension-observation.js";
import { executeCode } from "./extension-code.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import { executeBrowserInvocation } from "./extension-command-admission.js";
import { createBrowserInvocation } from "./extension-invocation.js";

export function registerBrowserTools(runtime: BrowserRuntime): void {
	const renderResult: NonNullable<ToolDefinition["renderResult"]> = (
		result,
		options,
		theme,
		context,
	) => {
		const component =
			context.lastComponent instanceof AgentBrowserResultComponent
				? context.lastComponent
				: new AgentBrowserResultComponent();
		component.setResult(result, options, theme, context);
		return component;
	};
	const renderers = {
		renderCall: (args, theme, context) => {
			const text =
				context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
			return text;
		},
		renderResult,
	} satisfies Pick<ToolDefinition<typeof AGENT_BROWSER_PARAMS>, "renderCall" | "renderResult">;
	registerAgentBrowserToolSurface(runtime.pi, {
		async execute(id, params, signal, onUpdate, ctx) {
			const branch = runtime.branch.capture(ctx);
			let result: AgentBrowserToolResult;
			try {
				result = await executeBrowserInvocation(
					runtime,
					createBrowserInvocation({
						toolCallId: id,
						params,
						signal,
						onUpdate,
						ctx,
						selectedBranch: branch,
					}),
				);
			} catch (error) {
				result = browserExecutionFailure(error, signal);
			}
			return finalizeObservation(runtime.artifacts, result, params, { ctx, branch });
		},
		async executeCode(id, params, signal, _onUpdate, ctx) {
			const branch = runtime.branch.capture(ctx);
			const completion: PromiseWithResolvers<void> = Promise.withResolvers();
			const { promise: execution, resolve: finish } = completion;
			runtime.code.executions.add(execution);
			try {
				const result = await executeCode(runtime, { toolCallId: id, params, signal, ctx, branch });
				return await finalizeObservation(runtime.artifacts, result, params, { ctx, branch });
			} finally {
				runtime.code.executions.delete(execution);
				finish();
			}
		},
		executionMode: runtime.beforeExecute ? "sequential" : undefined,
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	});
}
