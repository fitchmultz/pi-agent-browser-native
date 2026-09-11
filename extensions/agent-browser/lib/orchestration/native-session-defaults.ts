import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { extractExplicitSessionName, scanUpstreamGlobalFlagOccurrences } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import { getAgentBrowserProcessEnvironment, withAgentBrowserProcessEnvironment } from "../process-environment.js";
import { runAgentBrowserProcess } from "../process.js";
import { parseAgentBrowserEnvelope } from "../results/envelope.js";
import { isPlainTextInspectionArgs } from "../runtime.js";
import type { ResolvedAgentBrowserValidInput } from "./input-plan.js";

// Native `session` reports the resolved name, but not whether it was configured.
// Read only identity presence/namespace; native validates the rest of its schema.
async function readNativeIdentity(path: string, cwd: string, signal?: AbortSignal): Promise<{ session?: string; namespace?: string }> {
	let config: unknown;
	try { config = JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
	if (!isRecord(config) || (typeof config.session !== "string" && typeof config.namespace !== "string")) return {};
	const result = await runAgentBrowserProcess({ args: ["--config", path, "--json", "session"], cwd, signal, timeoutMs: 5_000 });
	try {
		if (result.aborted || result.timedOut || result.spawnError) throw new Error("Could not resolve native agent-browser session configuration; the browser command was not run.");
		if (result.exitCode !== 0) return {}; // Native ignores invalid discovered files; explicit files fail again in the actual command.
		const parsed = await parseAgentBrowserEnvelope({ stdout: result.stdout, stdoutPath: result.stdoutSpillPath });
		const data = parsed.envelope?.data;
		if (!isRecord(data) || typeof data.session !== "string") throw new Error("Native agent-browser session inspection returned no session name; the browser command was not run.");
		return {
			...(typeof config.session === "string" ? { session: data.session } : {}),
			...(typeof config.namespace === "string" ? { namespace: config.namespace } : {}),
		};
	} finally {
		if (result.stdoutSpillPath) await rm(result.stdoutSpillPath, { force: true });
	}
}

export async function withNativeSessionDefaults<T>(input: ResolvedAgentBrowserValidInput, cwd: string, signal: AbortSignal | undefined, run: (input: ResolvedAgentBrowserValidInput) => Promise<T>): Promise<T> {
	if (input.kind === "electron" && input.compiledElectron.action === "launch") return withAgentBrowserProcessEnvironment({ AGENT_BROWSER_SESSION: undefined }, () => run(input));
	if (input.kind === "script" || input.kind === "electron" || isPlainTextInspectionArgs(input.toolArgs)) return run(input);
	const env = getAgentBrowserProcessEnvironment();
	const configArg = scanUpstreamGlobalFlagOccurrences(input.toolArgs, "--config")[0];
	const configPath = configArg?.value ?? env.AGENT_BROWSER_CONFIG;
	const paths = configPath !== undefined
		? [resolve(cwd, configPath)]
		: [join(homedir(), ".agent-browser", "config.json"), join(cwd, "agent-browser.json")];
	let identity: { session?: string; namespace?: string } = {};
	for (const path of paths) identity = { ...identity, ...await readNativeIdentity(path, cwd, signal) };
	const session = env.AGENT_BROWSER_SESSION ?? identity.session;
	const namespace = env.AGENT_BROWSER_NAMESPACE ?? identity.namespace;
	let args = input.toolArgs;
	if (session !== undefined && extractExplicitSessionName(args) === undefined) args = ["--session", session, ...args];
	const idleTimeout = scanUpstreamGlobalFlagOccurrences(args, "--idle-timeout").at(-1)?.value;
	return withAgentBrowserProcessEnvironment({
		...(idleTimeout !== undefined ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: idleTimeout } : {}),
		...(configPath !== undefined ? { AGENT_BROWSER_CONFIG: resolve(cwd, configPath) } : {}),
		...(session !== undefined ? { AGENT_BROWSER_SESSION: session } : {}),
		...(namespace !== undefined ? { AGENT_BROWSER_NAMESPACE: namespace } : {}),
	}, () => run({ ...input, toolArgs: args }));
}
