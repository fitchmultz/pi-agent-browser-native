// Separate OS process: register the selected checkout's real extension, without a model or browser mock.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { createExtensionHarness as HarnessFactory } from "./agent-browser-harness.js";

const root = process.env.PIAB_ORDER_ROOT!;
const sourceRoot = process.env.PI_AGENT_BROWSER_EXECUTION_TEST_ROOT!;
const actor = process.env.PIAB_ORDER_ACTOR!;
const { createExtensionHarness, executeRegisteredTool, runExtensionEvent } = await import(pathToFileURL(join(sourceRoot, "test/helpers/agent-browser-harness.ts")).href) as typeof import("./agent-browser-harness.js");
const harness: ReturnType<typeof HarnessFactory> = createExtensionHarness({
	cwd: root,
	sessionId: `execution-order-${actor}`,
	sessionFile: join(root, `session-${actor}.jsonl`),
	prompt: "Use only the loopback execution-order fixture and its harmless counters.",
	onAppendEntry(customType, data) {
		appendFileSync(join(root, `session-${actor}.jsonl`), `${JSON.stringify({ type: "custom", customType, data })}\n`);
	},
});
await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
const { resolveBrowserExecutionIdentity, getBrowserExecutionLockPath } = await import(pathToFileURL(join(sourceRoot, "extensions/agent-browser/lib/managed-session-policy-lock.ts")).href) as typeof import("../../extensions/agent-browser/lib/managed-session-policy-lock.js");
const identity = await resolveBrowserExecutionIdentity({ namespace: process.env.PIAB_ORDER_NAMESPACE, sessionName: "shared" });
const controllers = new Map<number, AbortController>();
const running = new Set<Promise<void>>();
process.on("message", (message: { kind: string; id: number; tool: string; params: unknown }) => {
	if (message.kind === "abort") { controllers.get(message.id)?.abort(); return; }
	if (message.kind === "stop") {
		void (async () => {
			for (const controller of controllers.values()) controller.abort();
			await Promise.allSettled(running);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			process.disconnect!();
		})();
		return;
	}
	const controller = new AbortController();
	controllers.set(message.id, controller);
	const execute = async () => {
		process.send!({ kind: "started", id: message.id });
		try {
			const tool = harness.getTool(message.tool);
			assert.ok(tool, `selected extension did not register ${message.tool}`);
			const result = await executeRegisteredTool(tool, harness.ctx, message.params, controller.signal);
			const row = { kind: "result", id: message.id, result };
			appendFileSync(join(root, `worker-${actor}.jsonl`), `${JSON.stringify(row)}\n`);
			process.send!(row);
		} catch (error) { process.send!({ kind: "error", id: message.id, error: String(error) }); }
		finally { controllers.delete(message.id); }
	};
	const promise = execute();
	running.add(promise);
	void promise.finally(() => running.delete(promise));
});
process.send!({ kind: "ready", pid: process.pid, tools: [...harness.tools.keys()], lockPath: getBrowserExecutionLockPath(identity) });
