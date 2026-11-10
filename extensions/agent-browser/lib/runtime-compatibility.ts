import type { CommandInfo } from "./argv-descriptor.js";
import {
	beforeEndOfOptions,
	getAutoConnectFlagValue,
	getBooleanFlagValue,
	isUpstreamEnvFlagEnabled,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import { isOpenNavigationCommand } from "./command-taxonomy.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import type { CompatibilityWorkaround } from "./runtime-contracts.js";

const OPENAI_HOSTS = new Set(["chat.com", "chat.openai.com", "chatgpt.com"]);
const DEFAULT_USER_AGENT_BY_PLATFORM: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
	darwin:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	linux:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	win32:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};
const FALLBACK_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export function getDefaultHeadlessCompatUserAgent(
	platform: NodeJS.Platform = process.platform,
): string {
	return DEFAULT_USER_AGENT_BY_PLATFORM[platform] ?? FALLBACK_USER_AGENT;
}

function hasLaunchOverride(args: readonly string[], env: Readonly<NodeJS.ProcessEnv>): boolean {
	const flags = ["--user-agent", "--args", "--cdp", "--provider", "-p"];
	const options = beforeEndOfOptions(args);
	return (
		flags.some((flag) => options.some((token) => token === flag || token.startsWith(`${flag}=`))) ||
		[
			env.AGENT_BROWSER_SESSION,
			env.AGENT_BROWSER_USER_AGENT,
			env.AGENT_BROWSER_ARGS,
			env.AGENT_BROWSER_CDP,
			env.AGENT_BROWSER_PROVIDER,
		].some((value) => value !== undefined)
	);
}

function hasInteractiveLaunchMode(
	args: readonly string[],
	env: Readonly<NodeJS.ProcessEnv>,
): boolean {
	return (
		(getBooleanFlagValue(args, "--headed") ?? isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_HEADED)) ||
		(getAutoConnectFlagValue(args) ?? isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_AUTO_CONNECT))
	);
}

export function canUseHeadlessCompatibilityUserAgent(
	args: readonly string[],
	env: Readonly<NodeJS.ProcessEnv> = getAgentBrowserProcessEnvironment(),
): boolean {
	if (hasLaunchOverride(args, env)) {
		return false;
	}
	if (hasInteractiveLaunchMode(args, env)) {
		return false;
	}
	const engine =
		scanUpstreamGlobalFlagOccurrences(args, "--engine").at(-1)?.value ?? env.AGENT_BROWSER_ENGINE;
	return (engine ?? "chrome") === "chrome" || engine === "";
}

function parseNavigationUrl(url: string | undefined): URL | undefined {
	if (url === undefined || url.length === 0) {
		return;
	}
	try {
		return new URL(url);
	} catch {
		try {
			return new URL(`https://${url}`);
		} catch {
			return;
		}
	}
}

export function getCompatibilityWorkaround(
	args: readonly string[],
	commandInfo: CommandInfo,
): CompatibilityWorkaround | undefined {
	if (
		!isOpenNavigationCommand(commandInfo.command) ||
		!canUseHeadlessCompatibilityUserAgent(args)
	) {
		return;
	}
	const target = parseNavigationUrl(commandInfo.subcommand);
	if (!target || !["http:", "https:"].includes(target.protocol)) {
		return;
	}
	const hostname = target.hostname.toLowerCase();
	if (hostname === "dash.cloudflare.com") {
		return {
			id: "cloudflare-headless-user-agent",
			reason:
				"Cloudflare Dashboard challenges the default headless Chrome user agent; inject a normal Chrome user agent so authenticated headless browsing reaches the dashboard instead of Turnstile.",
		};
	}
	if (!OPENAI_HOSTS.has(hostname)) {
		return;
	}
	return {
		id: "chatgpt-headless-user-agent",
		reason:
			"OpenAI web properties currently challenge the default headless Chrome user agent; inject a normal Chrome user agent to preserve the default headless workflow without requiring headed mode or auto-connect.",
	};
}
