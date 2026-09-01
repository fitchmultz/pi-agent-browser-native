import { findCommandStartIndex } from "./argv-descriptor.js";
import { isBooleanFlagEnabled } from "./argv-grammar.js";

export interface LaunchScopedFlagDefinition {
	flag: string;
	reason: string;
}

export const LAUNCH_SCOPED_FLAG_DEFINITIONS = [
	{
		flag: "--auto-connect",
		reason: "attaches to an already-running browser at launch time instead of reusing an existing named session",
	},
	{
		flag: "--allowed-domains",
		reason: "installs upstream network and WebRTC containment on a fresh controllable browser context",
	},
	{
		flag: "--namespace",
		reason: "selects the upstream daemon/socket and restore-state namespace before session lookup",
	},
	{
		flag: "--cdp",
		reason: "selects the browser/CDP endpoint used when an upstream session is launched",
	},
	{
		flag: "--ca-cert",
		reason: "selects isolated Chromium CA trust and may relaunch the browser",
	},
	{
		flag: "--no-ca-cert",
		reason: "clears retained isolated Chromium CA trust and may relaunch the browser",
	},
	{
		flag: "--enable",
		reason: "selects built-in page init scripts before the upstream browser session is launched",
	},
	{
		flag: "--executable-path",
		reason: "selects the browser executable used for the upstream launch",
	},
	{
		flag: "--webgpu",
		reason: "selects the platform-specific WebGPU browser launch preset",
	},
	{
		flag: "--no-webmcp",
		reason: "selects whether locally launched Chrome enables experimental WebMCP support",
	},
	{
		flag: "--init-script",
		reason: "registers page init scripts before the upstream browser session is launched",
	},
	{
		flag: "--idle-timeout",
		reason: "configures background browser lifecycle for the launched session",
	},
	{
		flag: "--args",
		reason: "selects raw Chrome arguments for the browser launch",
	},
	{
		flag: "--user-agent",
		reason: "selects the browser user agent at launch time",
	},
	{
		flag: "--headed",
		reason: "selects whether the launched browser has a visible window",
	},
	{
		flag: "--device",
		reason: "selects the provider device for the upstream launch",
	},
	{
		flag: "--profile",
		reason: "selects Chrome profile state for the upstream launch",
	},
	{
		flag: "--provider",
		reason: "selects the upstream browser provider for the launch",
	},
	{
		flag: "-p",
		reason: "selects the upstream browser provider for the launch",
	},
	{
		flag: "--session-name",
		reason: "selects upstream saved auth/session state for the launch",
	},
	{
		flag: "--restore",
		reason: "selects upstream saved auth/session restore state for the launch",
	},
	{
		flag: "--restore-save",
		reason: "configures upstream restore auto-save policy for the launched session",
	},
	{
		flag: "--restore-check-url",
		reason: "configures restore validation before the launched session can auto-save",
	},
	{
		flag: "--restore-check-text",
		reason: "configures restore validation before the launched session can auto-save",
	},
	{
		flag: "--restore-check-fn",
		reason: "configures restore validation before the launched session can auto-save",
	},
	{
		flag: "--state",
		reason: "loads persisted upstream browser/auth state at launch time",
	},
] as const satisfies readonly LaunchScopedFlagDefinition[];

export const LAUNCH_SCOPED_FLAGS = LAUNCH_SCOPED_FLAG_DEFINITIONS.map((definition) => definition.flag);
export const LAUNCH_SCOPED_FLAG_LABEL = LAUNCH_SCOPED_FLAGS.join(", ");

export const OPEN_RESULT_TAB_CORRECTION_FLAGS = new Set<string>(["--profile", "--restore", "--session-name", "--state"]);

/** Launch modes that must never be combined with wrapper-managed restore state. */
export const MANAGED_RESTORE_INCOMPATIBLE_FLAGS = [
	"--restore",
	"--restore-save",
	"--restore-check-url",
	"--restore-check-text",
	"--restore-check-fn",
	"--allowed-domains",
	"--profile",
	"--state",
	"--cdp",
	"--auto-connect",
	"--session-name",
	"--provider",
	"-p",
	"--executable-path",
	"--extension",
	"--init-script",
	"--enable",
	"--args",
	"--user-agent",
	"--proxy",
	"--proxy-bypass",
	"--ca-cert",
	"--ignore-https-errors",
	"--allow-file-access",
	"--webgpu",
	"--device",
	"--engine",
] as const;

/** Nonempty upstream env defaults that can replace or mutate the browser receiving restored state. */
export const MANAGED_RESTORE_INCOMPATIBLE_ENVS = [
	"AGENT_BROWSER_RESTORE",
	"AGENT_BROWSER_RESTORE_SAVE",
	"AGENT_BROWSER_RESTORE_CHECK_URL",
	"AGENT_BROWSER_RESTORE_CHECK_TEXT",
	"AGENT_BROWSER_RESTORE_CHECK_FN",
	"AGENT_BROWSER_ALLOWED_DOMAINS",
	"AGENT_BROWSER_PROFILE",
	"AGENT_BROWSER_STATE",
	"AGENT_BROWSER_CDP",
	"AGENT_BROWSER_NAMESPACE",
	"AGENT_BROWSER_SESSION_NAME",
	"AGENT_BROWSER_PROVIDER",
	"AGENT_BROWSER_EXECUTABLE_PATH",
	"AGENT_BROWSER_EXTENSIONS",
	"AGENT_BROWSER_INIT_SCRIPTS",
	"AGENT_BROWSER_ENABLE",
	"AGENT_BROWSER_ARGS",
	"AGENT_BROWSER_USER_AGENT",
	"AGENT_BROWSER_PROXY",
	"AGENT_BROWSER_PROXY_BYPASS",
	"AGENT_BROWSER_CA_CERT",
	"AGENT_BROWSER_PLUGINS",
	"AGENT_BROWSER_IOS_DEVICE",
	"AGENT_BROWSER_IOS_UDID",
	"AGENT_BROWSER_ENGINE",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

/** Boolean launch mutators block restore only when enabled. */
export const MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS = [
	"AGENT_BROWSER_AUTO_CONNECT",
	"AGENT_BROWSER_IGNORE_HTTPS_ERRORS",
	"AGENT_BROWSER_ALLOW_FILE_ACCESS",
	"AGENT_BROWSER_WEBGPU",
] as const;

export function hasLaunchScopedFlagToken(args: string[], flag: string): boolean {
	const commandStartIndex = findCommandStartIndex(args);
	const command = commandStartIndex === undefined ? undefined : args[commandStartIndex];
	return args.some((token, index) => {
		if (token.startsWith(`${flag}=`)) return flag === "--restore";
		if (token !== flag) return false;
		if (flag === "--auto-connect") return isBooleanFlagEnabled(args, flag);
		if (flag === "--state" && command === "wait" && commandStartIndex !== undefined && index > commandStartIndex) return false;
		return true;
	});
}
