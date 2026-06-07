/**
 * Purpose: Define the Pi tool input schema for the native agent_browser wrapper.
 * Responsibilities: Keep TypeBox schema construction separate from runtime execution and input-mode compilers.
 * Scope: Schema-only; behavioral validation lives in the mode compilers.
 */

import { JsonSchema, type JsonSchemaBuilder } from "../json-schema.js";
import { StringEnum as localStringEnum, type StringEnumBuilder } from "../string-enum-schema.js";

import {
	ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS,
	ELECTRON_DISCOVERY_MAX_RESULTS,
} from "../electron/discovery.js";
import {
	AGENT_BROWSER_ELECTRON_HANDOFFS,
	AGENT_BROWSER_ELECTRON_TARGET_TYPES,
	AGENT_BROWSER_JOB_STEP_ACTIONS,
	AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS,
	AGENT_BROWSER_QA_LOAD_STATES,
	AGENT_BROWSER_SEMANTIC_ACTIONS,
	AGENT_BROWSER_SEMANTIC_LOCATORS,
	DEFAULT_SESSION_MODE,
	SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
} from "./types.js";

export function createAgentBrowserParamsSchema(
	Type: JsonSchemaBuilder = JsonSchema,
	StringEnum: StringEnumBuilder = localStringEnum,
) {
	return Type.Object({

	args: Type.Optional(
		Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name. Do not pass --json; the wrapper injects it. First-call recipe: open → snapshot -i → click/fill @eN → snapshot -i." }), {
			description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators. Required unless semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron is provided. Do not include --json (wrapper injects it). Typical first calls: open, snapshot -i, click/fill current @refs, then snapshot -i again after navigation or DOM changes.",
			minItems: 1,
		}),
	),
	semanticAction: Type.Optional(
		Type.Object({
			action: StringEnum(AGENT_BROWSER_SEMANTIC_ACTIONS, {
				description: "Intent action to compile to an existing agent-browser find command, direct selector/ref command, or upstream select when action=select.",
			}),
			locator: Type.Optional(StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, {
				description: "Upstream find locator family to use for check/click/fill actions.",
			})),
			value: Type.Optional(Type.String({ description: "Locator value for find actions, or a single option value for select actions. For locator=role, role may be supplied instead." })),
			values: Type.Optional(Type.Array(Type.String({ description: "Option value for select actions." }), { description: "One or more option values for select actions.", minItems: 1 })),
			selector: Type.Optional(Type.String({ description: "Selector or @ref for direct click/check/fill actions, or for select actions compiled to select <selector> <value...>." })),
			text: Type.Optional(Type.String({ description: "Text/value argument for fill actions." })),
			role: Type.Optional(Type.String({ description: "Role locator value for locator=role. May be used instead of value; when both are set they must match." })),
			name: Type.Optional(Type.String({ description: "Accessible name filter for locator=role; compiles to --name <name>." })),
			session: Type.Optional(Type.String({ description: "Optional upstream session name; prepends --session <name> before the compiled command." })),
		}, { additionalProperties: false }),
	),
	qa: Type.Optional(
		Type.Union([
			Type.Object({
				attached: Type.Literal(true, { description: "Run the QA preset against the currently attached session instead of opening qa.url." }),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must appear on the page." })),
				expectedSelector: Type.Optional(Type.String({ description: "Selector or @ref that must appear on the page." })),
				screenshotPath: Type.Optional(Type.String({ description: "Optional evidence screenshot path captured at the end of the QA preset." })),
				checkConsole: Type.Optional(Type.Boolean({ description: "Whether to inspect console messages and fail on console errors. Defaults to false for qa.attached because upstream buffers may predate the check." })),
				checkErrors: Type.Optional(Type.Boolean({ description: "Whether to inspect page errors and fail when errors are present. Defaults to false for qa.attached because upstream buffers may predate the check." })),
				checkNetwork: Type.Optional(Type.Boolean({ description: "Whether to inspect network requests and fail on actionable request failures; benign icon misses warn. Defaults to false for qa.attached because upstream buffers may predate the check." })),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES, { description: "Page readiness state for the QA preset before assertions and diagnostics. Defaults to domcontentloaded; use networkidle only for pages without long-lived background requests." })),
			}, { additionalProperties: false }),
			Type.Object({
				url: Type.String({ description: "URL to open for a lightweight QA preset." }),
				attached: Type.Optional(Type.Literal(false, { description: "When omitted or false, qa.url is required and opened before checks." })),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must appear on the page." })),
				expectedSelector: Type.Optional(Type.String({ description: "Selector or @ref that must appear on the page." })),
				screenshotPath: Type.Optional(Type.String({ description: "Optional evidence screenshot path captured at the end of the QA preset." })),
				checkConsole: Type.Optional(Type.Boolean({ description: "Whether to fail on console error messages. Defaults to true." })),
				checkErrors: Type.Optional(Type.Boolean({ description: "Whether to fail on page errors. Defaults to true." })),
				checkNetwork: Type.Optional(Type.Boolean({ description: "Whether to inspect network requests and fail on actionable request failures; benign icon misses warn. Defaults to true." })),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES, { description: "Page readiness state for the QA preset before assertions and diagnostics. Defaults to domcontentloaded; use networkidle only for pages without long-lived background requests." })),
			}, { additionalProperties: false }),
		], { description: "Lightweight QA preset. Use qa.url to open a URL, or qa.attached=true to check the current attached session without opening a URL." }),
	),
	sourceLookup: Type.Optional(
		Type.Object({
			selector: Type.Optional(Type.String({ description: "Visible selector or @ref whose DOM metadata should be inspected for source hints." })),
			reactFiberId: Type.Optional(Type.String({ description: "React fiber id to inspect with upstream react inspect. Requires a session opened with --enable react-devtools." })),
			componentName: Type.Optional(Type.String({ description: "Component name to correlate with react tree output and bounded local workspace search." })),
			includeDomHints: Type.Optional(Type.Boolean({ description: "Whether selector lookups should inspect DOM HTML attributes for source-like metadata. Defaults to true." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Maximum local source files to scan when componentName is provided. Defaults to 2000 and cannot exceed 5000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}, { additionalProperties: false, description: "EXPERIMENTAL: local UI-to-source candidates only (confidence/evidence, not guaranteed mappings). Compiles to batch; mutually exclusive with other input modes." }),
	),
	networkSourceLookup: Type.Optional(
		Type.Object({
			filter: Type.Optional(Type.String({ description: "Optional upstream network requests filter pattern." })),
			requestId: Type.Optional(Type.String({ description: "Optional network request id to inspect with network request <id>." })),
			session: Type.Optional(Type.String({ description: "Optional upstream session name; prepends --session <name> before the generated batch." })),
			url: Type.Optional(Type.String({ description: "Optional failed request URL or URL fragment to correlate with local source." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Maximum local source files to scan for URL literals. Defaults to 2000 and cannot exceed 5000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}, { additionalProperties: false, description: "EXPERIMENTAL: failed-request-to-source candidates only (initiator metadata and bounded workspace URL literals; not definitive blame). Compiles to batch; mutually exclusive with other input modes." }),
	),
	electron: Type.Optional(
		Type.Union([
			Type.Object({
				action: StringEnum(["list"] as const, { description: "List discovered Electron apps." }),
				query: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter for electron.list across app name, bundle id, desktop id, and paths.", minLength: 1 })),
				maxResults: Type.Optional(Type.Integer({ description: `Maximum electron.list apps to return. Defaults to ${ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS}; values above ${ELECTRON_DISCOVERY_MAX_RESULTS} are clamped.`, minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				appPath: Type.String({ description: "Electron launch target: macOS .app bundle path. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				appName: Type.String({ description: "Electron launch target: app display name discovered by electron.list. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				bundleId: Type.String({ description: "Electron launch target: macOS bundle identifier discovered by electron.list. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				executablePath: Type.String({ description: "Electron launch target: executable path. Discovery is not required when this is provided. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const, { description: "Inspect or cleanup one wrapper-tracked Electron launch by launchId." }),
				launchId: Type.String({ description: "Wrapper launch id for electron.status and electron.cleanup.", minLength: 1 }),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded status/cleanup timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const, { description: "Inspect or cleanup all wrapper-tracked Electron launches." }),
				all: Type.Literal(true, { description: "Apply electron.status or electron.cleanup to all wrapper-owned launches." }),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded status/cleanup timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const, { description: "Inspect or cleanup the only active wrapper-tracked Electron launch." }),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded status/cleanup timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["probe"] as const, { description: "Probe the current attached Electron managed session; launchId is accepted for launch-scoped follow-up actions." }),
				launchId: Type.Optional(Type.String({ description: "Wrapper launch id for electron.probe follow-up targeting.", minLength: 1 })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded probe timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
		], { description: "Electron wrapper action. Fields are action-specific and unsupported fields are rejected." }),
	),
	job: Type.Optional(
		Type.Object({
			failFast: Type.Optional(Type.Boolean({ description: "Stop the compiled batch on the first failed job step. Defaults to true so later mutating steps do not run after setup/assertion failures." })),
			steps: Type.Array(
				Type.Object({
					action: StringEnum(AGENT_BROWSER_JOB_STEP_ACTIONS, {
						description: "Constrained one-call job step compiled to existing upstream batch commands.",
					}),
					url: Type.Optional(Type.String({ description: "URL for open steps, or URL pattern for assertUrl steps." })),
					loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES, { description: "Optional readiness wait to insert immediately after an open step; use domcontentloaded/load/networkidle when the next job step needs page hydration evidence before clicking or reading." })),
					selector: Type.Optional(Type.String({ description: "Selector or @ref for click/fill/type/select-like steps; omit when using semantic locator fields on click/fill steps." })),
					locator: Type.Optional(StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, { description: "Semantic locator for click/fill steps when selector is omitted." })),
					role: Type.Optional(Type.String({ description: "Role locator value for click/fill steps when locator is role." })),
					name: Type.Optional(Type.String({ description: "Accessible name filter for role locator click/fill steps." })),
					text: Type.Optional(Type.String({ description: "Text for fill steps or visible text for assertText steps." })),
					value: Type.Optional(Type.String({ description: "Single option value for select steps, or locator value for semantic click/fill steps." })),
					values: Type.Optional(Type.Array(Type.String({ description: "Option value for select steps." }), { description: "One or more option values for select steps.", minItems: 1 })),
					path: Type.Optional(Type.String({ description: "Artifact/download path for waitForDownload or screenshot steps." })),
					delayMs: Type.Optional(Type.Integer({ description: `Optional per-character delay for type steps; when set, the job compiles to focus/keyboard type/wait steps instead of instant fill-like typing, capped at ${AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS} characters.`, minimum: 1 })),
					press: Type.Optional(Type.String({ description: "Optional key to press after a type step, for example Enter." })),
					milliseconds: Type.Optional(Type.Number({ description: "Milliseconds for wait steps." })),
				}, { additionalProperties: false }),
				{ minItems: 1 },
			),
		}, { additionalProperties: false }),
	),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content; only supported for batch, eval --stdin, auth save --password-stdin, and is generated internally by job, qa, sourceLookup, or networkSourceLookup mode. Do not use with electron mode." })),
	outputPath: Type.Optional(Type.String({ description: "Optional workspace-relative or absolute file path that receives the model-facing command data/result after the browser command completes. Useful for eval/get/snapshot captures that should become durable local artifacts.", minLength: 1 })),
	timeoutMs: Type.Optional(Type.Integer({ description: "Optional per-call wrapper subprocess watchdog in milliseconds for browser CLI args/job/qa/source lookup calls. Use for long opens or large output captures; fixed wait steps still must stay below the upstream IPC wait budget. Electron actions use electron.timeoutMs instead.", minimum: 1 })),
	sessionMode: Type.Optional(
		StringEnum(["auto", "fresh"] as const, {
			description:
				"Session handling mode. `auto` reuses the extension-managed pi-scoped session when possible. `fresh` switches that managed session to a fresh upstream launch so launch-scoped flags like --profile, --executable-path, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device apply and later auto calls follow the new browser.",
			default: DEFAULT_SESSION_MODE,
		}),
	),
	}, { additionalProperties: false });
}

export const AGENT_BROWSER_PARAMS = createAgentBrowserParamsSchema();
