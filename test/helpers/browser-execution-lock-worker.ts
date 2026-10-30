import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	acquireManagedSessionPolicyLock,
	resolveBrowserExecutionIdentity,
	withBrowserExecutionLock,
	withBrowserExecutionLocks,
} from "../../extensions/agent-browser/lib/managed-session-policy-lock.js";

import { withAgentBrowserProcessEnvironment } from "../../extensions/agent-browser/lib/process-environment.js";

const SELECTION = Type.Object({
	socketDir: Type.String(),
	namespace: Type.Optional(Type.String()),
	sessionName: Type.Optional(Type.String()),
});
const OPTIONS = Type.Object({
	...SELECTION.properties,
	mode: Type.Union(["hold", "read-action", "navigate", "nested"].map((mode) => Type.Literal(mode))),
	statePath: Type.Optional(Type.String()),
	logPath: Type.Optional(Type.String()),
	ablate: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Number()),
	identities: Type.Optional(Type.Array(SELECTION)),
});
const rawOptions: unknown = JSON.parse(process.argv[2]);
assert.ok(Check(OPTIONS, rawOptions), "invalid lock worker options");
const options = rawOptions;
process.env.PI_AGENT_BROWSER_SOCKET_DIR = options.socketDir;
const controller = new AbortController();
let release = (): void => {
	throw new Error("release used before promise initialization");
};
const released = new Promise<void>((resolve) => {
	release = resolve;
});
process.on("message", (message) => {
	if (message === "release") {
		release();
	}
	if (message === "abort") {
		controller.abort();
	}
});
const send = (event: string, data?: unknown): void => {
	process.send?.({ event, data });
};
const selections = options.identities ?? [options];
const identities = await Promise.all(
	selections.map((selection) =>
		resolveBrowserExecutionIdentity({
			...selection,
			env: { AGENT_BROWSER_SOCKET_DIR: selection.socketDir },
		}),
	),
);
const deadline = performance.now() + (options.timeoutMs ?? 10_000);
const lockOptions = { identities, signal: controller.signal, deadline };
const run = async (signal: AbortSignal) => {
	send("acquired");
	signal.addEventListener(
		"abort",
		() => {
			send("cancelled");
		},
		{ once: true },
	);
	if (options.mode === "navigate") {
		assert.ok(options.statePath !== undefined && options.statePath.length > 0);
		await writeFile(options.statePath, "B");
		send("navigated");
		return;
	}
	if (options.mode === "read-action") {
		assert.ok(options.statePath !== undefined && options.statePath.length > 0);
		send("verified", await readFile(options.statePath, "utf8"));
	}
	if (options.mode === "nested") {
		for (const [index, identity] of identities.entries()) {
			const selection = selections[index];
			assert.notEqual(selection, undefined);
			const nested = { identity, signal, deadline };
			// Exercise each lock's reentrant ownership serially before releasing the outer set.
			// oxlint-disable-next-line no-await-in-loop
			await withBrowserExecutionLock(nested, async () => {
				await withBrowserExecutionLock(nested, async () => {
					const policy = await withAgentBrowserProcessEnvironment(
						{ PI_AGENT_BROWSER_SOCKET_DIR: selection.socketDir },
						() =>
							acquireManagedSessionPolicyLock({
								sessionName: selection.sessionName ?? "probe",
								namespace: selection.namespace,
							}),
					);
					if (!policy) {
						throw new Error("nested managed policy did not borrow execution ownership");
					}
					await policy.release();
				});
			});
		}
		send("nested");
	}
	await released;
	if (options.mode === "read-action") {
		assert.ok(options.logPath !== undefined && options.logPath.length > 0);
		assert.ok(options.statePath !== undefined && options.statePath.length > 0);
		await appendFile(options.logPath, `click:${await readFile(options.statePath, "utf8")}\n`);
	}
};
try {
	send("ready");
	if (options.ablate === true) {
		await run(controller.signal);
	} else {
		await withBrowserExecutionLocks(lockOptions, run);
	}
	send("done");
} catch (error) {
	send(
		"failed",
		error instanceof Error ? { name: error.name, message: error.message } : JSON.stringify(error),
	);
} finally {
	process.disconnect();
}
