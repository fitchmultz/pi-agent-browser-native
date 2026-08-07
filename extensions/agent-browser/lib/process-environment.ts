import { AsyncLocalStorage } from "node:async_hooks";

const isolatedAgentBrowserEnvironment = new AsyncLocalStorage<boolean>();
const PROXY_ENV_NAMES = new Set(["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "all_proxy", "https_proxy", "http_proxy", "no_proxy"]);

export function getAgentBrowserProcessEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (isolatedAgentBrowserEnvironment.getStore() !== true) return baseEnv;
	return Object.fromEntries(Object.entries(baseEnv).filter(([name]) =>
		!name.startsWith("AGENT_BROWSER_") && !PROXY_ENV_NAMES.has(name)
	));
}

export function withIsolatedAgentBrowserEnvironment<T>(run: () => T): T {
	return isolatedAgentBrowserEnvironment.run(true, run);
}
