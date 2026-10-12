// Separate OS process: register the selected checkout's real extension, without a model or browser mock.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFunction, readNumber, readRecord, readString } from "./assertions.js";

const root = readString(process.env.PIAB_ORDER_ROOT);
const sourceRoot = readString(process.env.PI_AGENT_BROWSER_EXECUTION_TEST_ROOT);
const actor = readString(process.env.PIAB_ORDER_ACTOR);
const module = readRecord(
	await import(pathToFileURL(join(sourceRoot, "test/helpers/agent-browser-harness.ts")).href),
);
const createExtensionHarness = readFunction(module.createExtensionHarness);
const executeRegisteredTool = readFunction(module.executeRegisteredTool);
const runExtensionEvent = readFunction(module.runExtensionEvent);
const harness = readRecord(
	createExtensionHarness({
		cwd: root,
		sessionId: `execution-order-${actor}`,
		sessionFile: join(root, `session-${actor}.jsonl`),
		prompt: "Use only the loopback execution-order fixture and its harmless counters.",
	}),
);
const { handlers, ctx, tools } = harness;
const getTool = readFunction(harness.getTool);
assert.ok(tools instanceof Map);
await runExtensionEvent(handlers, "session_start", { reason: "new" }, ctx);
const lockModule = readRecord(
	await import(
		pathToFileURL(join(sourceRoot, "extensions/agent-browser/lib/managed-session-policy-lock.ts"))
			.href
	),
);
const resolveBrowserExecutionIdentity = readFunction(lockModule.resolveBrowserExecutionIdentity);
const getBrowserExecutionLockPath = readFunction(lockModule.getBrowserExecutionLockPath);
const identity: unknown = await resolveBrowserExecutionIdentity({
	namespace: process.env.PIAB_ORDER_NAMESPACE,
	sessionName: "shared",
});
const controllers = new Map<number, AbortController>();
const running = new Set<Promise<void>>();
function send(message: object): void {
	if (process.send === undefined) {
		throw new Error("execution-order worker requires IPC");
	}
	process.send(message);
}
function fail(error: unknown): void {
	console.error(error);
	process.exitCode = 1;
	process.disconnect();
}
async function stop(): Promise<void> {
	for (const controller of controllers.values()) {
		controller.abort();
	}
	await Promise.allSettled(running);
	await runExtensionEvent(handlers, "session_shutdown", { reason: "quit" }, ctx);
	process.disconnect();
}
async function execute(
	message: Readonly<Record<string, unknown>>,
	id: number,
	controller: AbortController,
): Promise<void> {
	send({ kind: "started", id });
	try {
		const toolName = readString(message.tool);
		const tool: unknown = getTool(toolName);
		assert.ok(
			tool !== undefined && tool !== null,
			`selected extension did not register ${toolName}`,
		);
		const result: unknown = await executeRegisteredTool(
			tool,
			ctx,
			message.params,
			controller.signal,
		);
		const row = { kind: "result", id, result };
		appendFileSync(join(root, `worker-${actor}.jsonl`), `${JSON.stringify(row)}\n`);
		send(row);
	} catch (error) {
		send({
			kind: "error",
			id,
			error: error instanceof Error ? error.message : JSON.stringify(error),
		});
	} finally {
		controllers.delete(id);
	}
}
process.on("message", (value: unknown) => {
	const message = readRecord(value);
	if (message.kind === "stop") {
		stop().catch(fail);
		return;
	}
	const id = readNumber(message.id);
	if (message.kind === "abort") {
		controllers.get(id)?.abort();
		return;
	}
	const controller = new AbortController();
	controllers.set(id, controller);
	const promise = execute(message, id, controller);
	running.add(promise);
	promise
		.finally(() => {
			running.delete(promise);
		})
		.catch(fail);
});
const toolMap: ReadonlyMap<unknown, unknown> = tools;
const toolNames = [...toolMap.keys()].map(readString);
const lockPath: unknown = getBrowserExecutionLockPath(identity);
send({ kind: "ready", pid: process.pid, tools: toolNames, lockPath });
