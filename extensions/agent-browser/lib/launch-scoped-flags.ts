/**
 * Purpose: Canonical launch-scoped agent-browser flag metadata shared by runtime planning and agent-facing guidance.
 * Responsibilities: Define which upstream flags require a fresh launch, explain why, and expose stable guidance labels.
 * Scope: Metadata only; argv parsing and execution planning live in runtime.ts.
 */

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
		flag: "--namespace",
		reason: "selects the upstream daemon/socket and restore-state namespace before session lookup",
	},
	{
		flag: "--cdp",
		reason: "selects the browser/CDP endpoint used when an upstream session is launched",
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
		flag: "--init-script",
		reason: "registers page init scripts before the upstream browser session is launched",
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
