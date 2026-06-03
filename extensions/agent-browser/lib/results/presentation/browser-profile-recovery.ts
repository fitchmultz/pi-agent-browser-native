/**
 * Purpose: Build browser profile/config recovery hints for launch/setup failures.
 * Responsibilities: Recognize local Chrome/profile setup errors, avoid self-loop diagnostics, and emit canonical next actions.
 * Scope: Error presentation only; upstream profile discovery and doctor execution remain normal agent_browser commands.
 */

import { isOpenNavigationCommand } from "../../command-taxonomy.js";
import { getStartupScopedFlags, type CommandInfo } from "../../runtime.js";
import type { AgentBrowserNextAction } from "../contracts.js";
import { buildNextToolAction } from "../next-actions.js";

const BROWSER_PROFILE_CONFIG_HINT = [
	"Agent-browser profile/config hint: this looks like a local browser profile or Chrome user-data-dir setup problem, not a page-specific failure.",
	"Do not keep retrying the same open/profile call. Run `profiles` and/or `doctor` through agent_browser, then tell the user whether Chrome/Chromium is installed, which Chrome profile directory names are available, or whether they need to configure a full profile/user-data directory path, a non-default Chromium-compatible `--executable-path`, or remove the profile requirement for public-page browsing.",
	"Use the top-level `sessionMode: \"fresh\"` field for launch-scoped profile/debug/provider flags; do not pass `--session-mode` inside args.",
].join(" ");

function looksLikeBrowserProfileConfigError(errorText: string): boolean {
	return /\b(?:No Chrome user data directory found|Cannot resolve profile name|Chrome user data directory|Chrome profile\s+.+?\s+not found|Available profiles|If you meant a directory path)\b/i.test(errorText);
}

function isLaunchOrSetupContext(args: string[] | undefined, commandInfo: CommandInfo): boolean {
	const command = commandInfo.command;
	if (command === "profiles" || command === "doctor") return true;
	if (command && isOpenNavigationCommand(command)) return true;
	return (args ? getStartupScopedFlags(args) : []).length > 0;
}

function buildBrowserProfileConfigActions(commandInfo: CommandInfo): AgentBrowserNextAction[] {
	const actions: AgentBrowserNextAction[] = [];
	if (commandInfo.command !== "profiles") {
		actions.push(buildNextToolAction({
			args: ["profiles"],
			id: "inspect-browser-profiles",
			reason: "List browser profiles/user-data-dir candidates before retrying profile-based launch.",
			safety: "Read-only local setup inspection; does not open a page or mutate browser state.",
		}));
	}
	if (commandInfo.command !== "doctor") {
		actions.push(buildNextToolAction({
			args: ["doctor"],
			id: "run-agent-browser-doctor",
			reason: "Inspect local agent-browser browser installation/configuration before retrying.",
			safety: "Read-only local diagnostics; report findings to the user before changing setup.",
		}));
	}
	return actions;
}

export interface BrowserProfileConfigRecovery {
	actions?: AgentBrowserNextAction[];
	hint: string;
}

export function buildBrowserProfileConfigRecovery(options: {
	args?: string[];
	commandInfo: CommandInfo;
	errorText: string;
}): BrowserProfileConfigRecovery | undefined {
	if (!looksLikeBrowserProfileConfigError(options.errorText)) return undefined;
	if (!isLaunchOrSetupContext(options.args, options.commandInfo)) return undefined;
	const actions = buildBrowserProfileConfigActions(options.commandInfo);
	return {
		actions: actions.length > 0 ? actions : undefined,
		hint: BROWSER_PROFILE_CONFIG_HINT,
	};
}
