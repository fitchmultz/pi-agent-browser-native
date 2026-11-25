import type { CommandInfo } from "../../argv-descriptor.js";
import { isOpenNavigationCommand } from "../../command-taxonomy.js";

function getFindCssSyntaxHint(
	commandTail: readonly string[],
	errorText: string,
): string | undefined {
	const [locator] = commandTail;
	if (locator !== "first" && locator !== "last" && locator !== "nth") {
		return undefined;
	}
	const selector = commandTail[locator === "nth" ? 2 : 1] ?? "";
	return /:(?:text-is|has-text)\(/i.test(selector) &&
		/\b(?:selector|querySelectorAll|element not found|could not locate element)\b/i.test(errorText)
		? "Agent-browser syntax hint: Native `find` CSS selectors use standard CSS (`querySelectorAll`), without Playwright text pseudo-selectors. Use `find role` or `find text` to match by name or text."
		: undefined;
}

export function getCommandSyntaxHint(
	commandInfo: CommandInfo,
	commandTail: readonly string[],
	errorText: string,
): string | undefined {
	switch (commandInfo.command) {
		case "wait":
			return commandInfo.subcommand?.startsWith("text=") === true &&
				/\b(?:selector|locator|timed out|timeout)\b/i.test(errorText)
				? "Agent-browser syntax hint: Use `wait --text <text>` to wait for page text. Native `wait` treats `text=...` as a selector."
				: undefined;
		case "set":
			return commandInfo.subcommand === "user-agent" &&
				/\b(?:unknown|invalid|unrecognized)\s+(?:subcommand|command)\b/i.test(errorText)
				? 'Agent-browser syntax hint: Pass `--user-agent <ua>` as a launch flag on `open`. If a managed session is already active, use `sessionMode: "fresh"`.'
				: undefined;
		case "find":
			return getFindCssSyntaxHint(commandTail, errorText);
		case undefined:
		default:
			return undefined;
	}
}

export function getLocalhostNavigationHint(
	commandInfo: CommandInfo,
	errorText: string,
): string | undefined {
	if (
		!isOpenNavigationCommand(commandInfo.command) ||
		commandInfo.subcommand === undefined ||
		commandInfo.subcommand.length === 0
	) {
		return undefined;
	}
	const refused = /\bERR_CONNECTION_REFUSED\b/i.test(errorText);
	if (
		!refused &&
		!/\bnet::ERR_(?:EMPTY_RESPONSE|ADDRESS_UNREACHABLE|TIMED_OUT|CONNECTION_RESET)\b/i.test(
			errorText,
		)
	) {
		return undefined;
	}

	let targetUrl: URL;
	try {
		targetUrl = new URL(commandInfo.subcommand);
	} catch {
		return undefined;
	}

	if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(targetUrl.hostname.toLowerCase())) {
		return undefined;
	}

	return [
		refused
			? "Agent-browser local fixture hint: Verify the local server is running and listening on the URL's address and port. If it is, check whether the browser host or network namespace can reach it."
			: "Agent-browser local fixture hint: the browser process could not read a loopback URL from its own network namespace or browser host. Verify the server is still running and bound to an address the browser host can reach;",
		`${refused ? "If" : "if"} curl works from the shell but browser navigation fails, try the other loopback alias, add a proxy bypass for localhost/127.0.0.1 if a proxy is configured, or use a browser-host-reachable URL.`,
		"Use file:// only for static fallback fixtures and clean up any temporary server process outside agent_browser when the check is done.",
	].join(" ");
}
