import { appendFile, readFile, writeFile } from "node:fs/promises";
import { acquireManagedSessionPolicyLock, resolveBrowserExecutionIdentity, withBrowserExecutionLock, withBrowserExecutionLocks } from "../../extensions/agent-browser/lib/managed-session-policy-lock.js";

import { withAgentBrowserProcessEnvironment } from "../../extensions/agent-browser/lib/process-environment.js";

type Selection = { socketDir: string; namespace?: string; sessionName?: string };
const options = JSON.parse(process.argv[2]) as {
	socketDir: string; namespace?: string; sessionName?: string;
	mode: "hold" | "read-action" | "navigate" | "nested";
	statePath?: string; logPath?: string; ablate?: boolean; timeoutMs?: number;
	identities?: Selection[];
};
process.env.PI_AGENT_BROWSER_SOCKET_DIR = options.socketDir;
const controller = new AbortController();
let release!: () => void;
const released = new Promise<void>(resolve => { release = resolve; });
process.on("message", message => {
	if (message === "release") release();
	if (message === "abort") controller.abort();
});
const send = (event: string, data?: unknown) => process.send?.({ event, data });
const selections = options.identities ?? [options];
const identities = await Promise.all(selections.map(selection => resolveBrowserExecutionIdentity({ ...selection, env: { AGENT_BROWSER_SOCKET_DIR: selection.socketDir } })));
const deadline = Date.now() + (options.timeoutMs ?? 10_000);
const lockOptions = { identities, signal: controller.signal, deadline };
const run = async (signal: AbortSignal) => {
	send("acquired");
	signal.addEventListener("abort", () => send("cancelled"), { once: true });
	if (options.mode === "navigate") {
		await writeFile(options.statePath!, "B");
		send("navigated");
		return;
	}
	if (options.mode === "read-action") send("verified", await readFile(options.statePath!, "utf8"));
	if (options.mode === "nested") {
		for (const [index, identity] of identities.entries()) {
			const selection = selections[index]!;
			const nested = { identity, signal, deadline };
			await withBrowserExecutionLock(nested, async () => {
				await withBrowserExecutionLock(nested, async () => {
					const policy = await withAgentBrowserProcessEnvironment({ PI_AGENT_BROWSER_SOCKET_DIR: selection.socketDir }, () => acquireManagedSessionPolicyLock({ sessionName: selection.sessionName ?? "probe", namespace: selection.namespace }));
					if (!policy) throw new Error("nested managed policy did not borrow execution ownership");
					await policy.release();
				});
			});
		}
		send("nested");
	}
	await released;
	if (options.mode === "read-action") await appendFile(options.logPath!, `click:${await readFile(options.statePath!, "utf8")}\n`);
};
try {
	send("ready");
	if (options.ablate) await run(controller.signal);
	else await withBrowserExecutionLocks(lockOptions, run);
	send("done");
} catch (error) {
	send("failed", error instanceof Error ? { name: error.name, message: error.message } : String(error));
} finally {
	process.disconnect?.();
}
