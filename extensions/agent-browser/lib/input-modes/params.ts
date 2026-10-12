import { JsonSchema as Type, type TSchema, type TUnsafe } from "../json-schema.js";
import { StringEnum } from "../string-enum-schema.js";
import {
	ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS,
	ELECTRON_DISCOVERY_MAX_RESULTS,
} from "../electron/discovery-types.js";
import {
	AGENT_BROWSER_CODE_MAX_TIMEOUT_MS,
	AGENT_BROWSER_ELECTRON_HANDOFFS,
	AGENT_BROWSER_ELECTRON_TARGET_TYPES,
	AGENT_BROWSER_QA_LOAD_STATES,
	AGENT_BROWSER_SEMANTIC_ACTIONS,
	AGENT_BROWSER_SEMANTIC_LOCATORS,
	DEFAULT_SESSION_MODE,
	SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
	type AgentBrowserQaLoadState,
	type AgentBrowserSemanticActionName,
	type AgentBrowserSemanticLocator,
	type CompiledAgentBrowserElectron,
} from "./types.js";

export interface AgentBrowserOutputParams {
	outputPath?: string;
	timeoutMs?: number;
}

export interface AgentBrowserParams extends AgentBrowserOutputParams {
	args: string[];
	stdin?: string;
	sessionMode?: "auto" | "fresh";
}

export interface AgentBrowserCodeParams extends AgentBrowserOutputParams {
	code: string;
	session?: string;
	namespace?: string;
}

export interface AgentBrowserActionParams extends AgentBrowserOutputParams {
	action: AgentBrowserSemanticActionName;
	locator?: AgentBrowserSemanticLocator;
	value?: string;
	values?: string[];
	selector?: string;
	text?: string;
	role?: string;
	name?: string;
	session?: string;
}

export type AgentBrowserQaParams = AgentBrowserOutputParams & {
	expectedText?: string | string[];
	expectedSelector?: string;
	screenshotPath?: string;
	checkConsole?: boolean;
	checkErrors?: boolean;
	checkNetwork?: boolean;
	loadState?: AgentBrowserQaLoadState;
} & (
		| { attached: true; sessionMode?: "auto" }
		| { url: string; attached?: false; sessionMode?: "auto" | "fresh" }
	);

type ElectronLaunch = Extract<CompiledAgentBrowserElectron, { action: "launch" }>;
export type AgentBrowserElectronParams = { outputPath?: string } & (
	| Exclude<CompiledAgentBrowserElectron, ElectronLaunch>
	| (Omit<ElectronLaunch, "handoff" | "targetType"> &
			Partial<Pick<ElectronLaunch, "handoff" | "targetType">>)
);

export interface AgentBrowserSourceParams extends AgentBrowserOutputParams {
	selector?: string;
	reactFiberId?: string;
	componentName?: string;
	includeDomHints?: boolean;
	maxWorkspaceFiles?: number;
	sessionMode?: "auto" | "fresh";
}

export interface AgentBrowserNetworkSourceParams extends AgentBrowserOutputParams {
	filter?: string;
	namespace?: string;
	requestId?: string;
	session?: string;
	url?: string;
	maxWorkspaceFiles?: number;
	sessionMode?: "auto" | "fresh";
}

const AGENT_BROWSER_ADVANCED_TOOLS = ["action", "qa", "electron", "source", "network"] as const;
export type AgentBrowserAdvancedTool = (typeof AGENT_BROWSER_ADVANCED_TOOLS)[number];
export interface AgentBrowserToolsParams {
	enable?: AgentBrowserAdvancedTool[];
}

function outputProperties(): { outputPath: TSchema; timeoutMs: TSchema } {
	return {
		outputPath: Type.Optional(
			Type.String({
				description: "Result-data path, separate from browser artifact paths.",
				minLength: 1,
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({ description: "Timeout in ms; exceed explicit waits.", minimum: 1 }),
		),
	};
}

function sessionModeProperty(): TSchema {
	return Type.Optional(
		StringEnum(["auto", "fresh"] as const, {
			description:
				"Native configured sessions win; auto reuses the browser, fresh intentionally launches a separate managed browser.",
			default: DEFAULT_SESSION_MODE,
		}),
	);
}

// Keep the always-on schemas small; specialized guidance belongs to each advanced tool.
export function createAgentBrowserParamsSchema(): TUnsafe<AgentBrowserParams> {
	return Type.Unsafe<AgentBrowserParams>(
		Type.Object(
			{
				args: Type.Array(Type.String(), {
					description:
						"Native agent-browser argv without the binary or shell syntax. Fixed sequences: batch --bail with JSON-array stdin.",
					minItems: 1,
				}),
				stdin: Type.Optional(
					Type.String({
						description:
							"Native batch JSON, eval --stdin source, or auth save --password-stdin text.",
					}),
				),
				...outputProperties(),
				sessionMode: sessionModeProperty(),
			},
			{ additionalProperties: false },
		),
	);
}

export function createAgentBrowserCodeParamsSchema(): TUnsafe<AgentBrowserCodeParams> {
	return Type.Unsafe<AgentBrowserCodeParams>(
		Type.Object(
			{
				code: Type.String({
					description:
						"JavaScript with await browser({args, stdin?, timeoutMs?}), emit(JSON), and emitImage(image handle). Fresh JS context; persistent browser.",
					minLength: 1,
					maxLength: 65_536,
				}),
				session: Type.Optional(
					Type.String({
						description: "Explicit native session; omitted uses the ordinary default browser.",
						minLength: 1,
					}),
				),
				namespace: Type.Optional(
					Type.String({
						description: "Native namespace; empty string selects the default namespace.",
					}),
				),
				...outputProperties(),
				timeoutMs: Type.Optional(
					Type.Integer({ minimum: 1, maximum: AGENT_BROWSER_CODE_MAX_TIMEOUT_MS }),
				),
			},
			{ additionalProperties: false },
		),
	);
}

export function createAgentBrowserActionParamsSchema(): TUnsafe<AgentBrowserActionParams> {
	return Type.Unsafe<AgentBrowserActionParams>(
		Type.Object(
			{
				action: StringEnum(AGENT_BROWSER_SEMANTIC_ACTIONS),
				locator: Type.Optional(
					StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, {
						description: "Select supports role or label.",
					}),
				),
				value: Type.Optional(
					Type.String({
						description: "Locator value or select option; label text for select by label.",
					}),
				),
				values: Type.Optional(
					Type.Array(Type.String(), {
						description: "Select options; required for select by label.",
						minItems: 1,
					}),
				),
				selector: Type.Optional(Type.String({ description: "Direct selector or current @ref." })),
				text: Type.Optional(Type.String({ description: "Fill text." })),
				role: Type.Optional(
					Type.String({ description: "Role locator; select needs combobox or listbox." }),
				),
				name: Type.Optional(Type.String({ description: "Accessible name." })),
				session: Type.Optional(Type.String({ description: "Upstream session name." })),
				...outputProperties(),
			},
			{
				additionalProperties: false,
				// Top-level properties let Pi normalize optional nulls before validating branches.
				anyOf: [
					Type.Object(
						{
							action: StringEnum(["select"] as const),
							locator: Type.Optional(StringEnum(["role", "label"] as const)),
						},
						{ not: { required: ["text"] } },
					),
					Type.Object(
						{ action: StringEnum(["check", "click", "fill"] as const) },
						{ not: { required: ["values"] } },
					),
				],
			},
		),
	);
}

export function createAgentBrowserQaParamsSchema(): TUnsafe<AgentBrowserQaParams> {
	return Type.Unsafe<AgentBrowserQaParams>(
		Type.Object(
			{
				url: Type.Optional(Type.String()),
				attached: Type.Optional(Type.Boolean()),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
				expectedSelector: Type.Optional(Type.String()),
				screenshotPath: Type.Optional(Type.String()),
				checkConsole: Type.Optional(Type.Boolean()),
				checkErrors: Type.Optional(Type.Boolean()),
				checkNetwork: Type.Optional(Type.Boolean()),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES)),
				...outputProperties(),
				sessionMode: sessionModeProperty(),
			},
			{
				additionalProperties: false,
				anyOf: [
					Type.Object(
						{
							attached: Type.Literal(true),
							sessionMode: Type.Optional(StringEnum(["auto"] as const)),
						},
						{ not: { required: ["url"] } },
					),
					Type.Object({ url: Type.String(), attached: Type.Optional(Type.Literal(false)) }),
				],
			},
		),
	);
}

export function createAgentBrowserElectronParamsSchema(): TUnsafe<AgentBrowserElectronParams> {
	const common = { outputPath: outputProperties().outputPath };
	const timeoutMs = Type.Optional(Type.Integer({ minimum: 1 }));
	const list = {
		query: Type.Optional(
			Type.String({ description: "Case-insensitive app filter.", minLength: 1 }),
		),
		maxResults: Type.Optional(
			Type.Integer({
				description: `Result cap; default ${ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS}, clamped to ${ELECTRON_DISCOVERY_MAX_RESULTS}.`,
				minimum: 1,
			}),
		),
	};
	const launch = {
		appPath: Type.Optional(Type.String({ description: "macOS .app path.", minLength: 1 })),
		appName: Type.Optional(
			Type.String({ description: "Name from agent_browser_electron list.", minLength: 1 }),
		),
		bundleId: Type.Optional(Type.String({ minLength: 1 })),
		executablePath: Type.Optional(Type.String({ minLength: 1 })),
		appArgs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS)),
		targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES)),
		timeoutMs,
		allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		deny: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	};
	const probe = { launchId: Type.Optional(Type.String({ minLength: 1 })), timeoutMs };
	const lifecycle = { ...probe, all: Type.Optional(Type.Literal(true)) };
	// Strict providers need an object root; Pi needs root properties to normalize optional nulls.
	// Each branch retains its original action-specific field boundary.
	return Type.Unsafe<AgentBrowserElectronParams>(
		Type.Object(
			{
				action: StringEnum(["list", "launch", "status", "cleanup", "probe"] as const),
				...list,
				...launch,
				...lifecycle,
				...common,
			},
			{
				additionalProperties: false,
				anyOf: [
					Type.Object(
						{ action: StringEnum(["list"] as const), ...list, ...common },
						{ additionalProperties: false },
					),
					Type.Object(
						{ action: StringEnum(["launch"] as const), ...launch, ...common },
						{ additionalProperties: false },
					),
					Type.Object(
						{ action: StringEnum(["status", "cleanup"] as const), ...lifecycle, ...common },
						{ additionalProperties: false, not: { required: ["launchId", "all"] } },
					),
					Type.Object(
						{ action: StringEnum(["probe"] as const), ...probe, ...common },
						{ additionalProperties: false },
					),
				],
			},
		),
	);
}

export function createAgentBrowserSourceParamsSchema(): TUnsafe<AgentBrowserSourceParams> {
	return Type.Unsafe<AgentBrowserSourceParams>(
		Type.Object(
			{
				selector: Type.Optional(Type.String({ description: "Visible selector or @ref." })),
				reactFiberId: Type.Optional(
					Type.String({ description: "React fiber id; requires --enable react-devtools." }),
				),
				componentName: Type.Optional(
					Type.String({ description: "Component for local source search." }),
				),
				includeDomHints: Type.Optional(
					Type.Boolean({ description: "Inspect DOM hints; default true." }),
				),
				maxWorkspaceFiles: Type.Optional(
					Type.Integer({
						description: "Source scan cap; default 2000.",
						minimum: 1,
						maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
					}),
				),
				...outputProperties(),
				sessionMode: sessionModeProperty(),
			},
			{ additionalProperties: false },
		),
	);
}

export function createAgentBrowserNetworkSourceParamsSchema(): TUnsafe<AgentBrowserNetworkSourceParams> {
	return Type.Unsafe<AgentBrowserNetworkSourceParams>(
		Type.Object(
			{
				filter: Type.Optional(Type.String({ description: "Network request filter." })),
				namespace: Type.Optional(Type.String()),
				requestId: Type.Optional(Type.String({ description: "Request id to inspect." })),
				session: Type.Optional(Type.String()),
				url: Type.Optional(Type.String({ description: "Failed URL or fragment." })),
				maxWorkspaceFiles: Type.Optional(
					Type.Integer({
						description: "Source scan cap; default 2000.",
						minimum: 1,
						maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
					}),
				),
				...outputProperties(),
				sessionMode: sessionModeProperty(),
			},
			{ additionalProperties: false },
		),
	);
}

export function createAgentBrowserToolsParamsSchema(): TUnsafe<AgentBrowserToolsParams> {
	return Type.Unsafe<AgentBrowserToolsParams>(
		Type.Object(
			{
				enable: Type.Optional(
					Type.Array(StringEnum(AGENT_BROWSER_ADVANCED_TOOLS), {
						description: "Add capabilities to active tools; omit to list inventory.",
					}),
				),
			},
			{ additionalProperties: false },
		),
	);
}

export const AGENT_BROWSER_PARAMS = createAgentBrowserParamsSchema();
export const AGENT_BROWSER_CODE_PARAMS = createAgentBrowserCodeParamsSchema();
export const AGENT_BROWSER_ACTION_PARAMS = createAgentBrowserActionParamsSchema();
export const AGENT_BROWSER_QA_PARAMS = createAgentBrowserQaParamsSchema();
export const AGENT_BROWSER_ELECTRON_PARAMS = createAgentBrowserElectronParamsSchema();
export const AGENT_BROWSER_SOURCE_PARAMS = createAgentBrowserSourceParamsSchema();
export const AGENT_BROWSER_NETWORK_SOURCE_PARAMS = createAgentBrowserNetworkSourceParamsSchema();
export const AGENT_BROWSER_TOOLS_PARAMS = createAgentBrowserToolsParamsSchema();
