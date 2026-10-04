import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { getBooleanFlagValue } from "./argv-grammar.js";
import { writeSecureTempFile } from "./temp.js";

const isolatedAgentBrowserEnvironment = new AsyncLocalStorage<string>();
const agentBrowserProcessEnvironment = new AsyncLocalStorage<{ env: NodeJS.ProcessEnv; booleanArgs: Array<[string, string]> }>();
const PROXY_ENV_NAMES = new Set(["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]);

export function getAgentBrowserProcessEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const isolatedConfig = isolatedAgentBrowserEnvironment.getStore();
	if (isolatedConfig === undefined) return { ...baseEnv, ...agentBrowserProcessEnvironment.getStore()?.env };
	return {
		...Object.fromEntries(Object.entries(baseEnv).filter(([name]) => {
			const normalizedName = name.toUpperCase();
			return !normalizedName.startsWith("AGENT_BROWSER_") && !PROXY_ENV_NAMES.has(normalizedName);
		})),
		AGENT_BROWSER_CONFIG: isolatedConfig,
	};
}

export function getAgentBrowserProcessArgs(args: string[]): string[] {
	if (isolatedAgentBrowserEnvironment.getStore() !== undefined) return args;
	const overrides = agentBrowserProcessEnvironment.getStore()?.booleanArgs ?? [];
	const missing = overrides.flatMap(([flag, value]) => getBooleanFlagValue(args, flag) === undefined ? [flag, value] : []);
	return missing.length ? [...missing, ...args] : args;
}

export function withAgentBrowserProcessEnvironment<T>(env: NodeJS.ProcessEnv, run: () => T, booleanArgs?: Array<[string, string]>): T {
	const parent = agentBrowserProcessEnvironment.getStore();
	return agentBrowserProcessEnvironment.run({ env: { ...parent?.env, ...env }, booleanArgs: booleanArgs ?? parent?.booleanArgs ?? [] }, run);
}

export async function withIsolatedAgentBrowserEnvironment<T>(run: () => T): Promise<Awaited<T>> {
	if (isolatedAgentBrowserEnvironment.getStore() !== undefined) return await run();
	const path = await writeSecureTempFile({ content: "{}", prefix: "script-config", suffix: ".json" });
	try { return await isolatedAgentBrowserEnvironment.run(path, run); }
	finally { await rm(path, { force: true }); }
}
