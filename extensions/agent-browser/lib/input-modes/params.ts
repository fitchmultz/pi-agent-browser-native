import { JsonSchema, type JsonSchemaBuilder } from "../json-schema.js";
import { StringEnum as localStringEnum, type StringEnumBuilder } from "../string-enum-schema.js";

import { AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES } from "./script.js";
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

// Keep descriptions terse: Pi sends this schema every turn; workflows belong in prompt guidance and docs.

export function createAgentBrowserParamsSchema(
	Type: JsonSchemaBuilder = JsonSchema,
	StringEnum: StringEnumBuilder = localStringEnum,
) {
	return Type.Object({
		script: Type.Optional(Type.String({
			description: "One-shot JavaScript orchestration with async browser({ args, stdin?, timeoutMs? }) and emit(value); isolated session and no host access.",
			maxLength: AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES,
		})),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Raw agent-browser argv only: no binary, shell operators, or --json. Start with open → snapshot -i → act on current @refs; re-snapshot after page changes.",
			minItems: 1,
		}),
	),
	semanticAction: Type.Optional(
		Type.Object({
			action: StringEnum(AGENT_BROWSER_SEMANTIC_ACTIONS),
			locator: Type.Optional(StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, { description: "Locator for check/click/fill; select supports role or label." })),
			value: Type.Optional(Type.String({ description: "Locator value or one select option; for select by label, this is the label text." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "Select options; required for select by label.", minItems: 1 })),
			selector: Type.Optional(Type.String({ description: "Direct selector or @ref." })),
			text: Type.Optional(Type.String({ description: "Fill text." })),
			role: Type.Optional(Type.String({ description: "Role locator; alternative to value." })),
			name: Type.Optional(Type.String({ description: "Accessible name." })),
			session: Type.Optional(Type.String({ description: "Upstream session name." })),
		}, { additionalProperties: false, description: "Stable locator or direct-selector action." }),
	),
	qa: Type.Optional(
		Type.Union([
			Type.Object({
				attached: Type.Literal(true),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
				expectedSelector: Type.Optional(Type.String()),
				screenshotPath: Type.Optional(Type.String()),
				checkConsole: Type.Optional(Type.Boolean()),
				checkErrors: Type.Optional(Type.Boolean()),
				checkNetwork: Type.Optional(Type.Boolean()),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES)),
			}, { additionalProperties: false }),
			Type.Object({
				url: Type.String(),
				attached: Type.Optional(Type.Literal(false)),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
				expectedSelector: Type.Optional(Type.String()),
				screenshotPath: Type.Optional(Type.String()),
				checkConsole: Type.Optional(Type.Boolean()),
				checkErrors: Type.Optional(Type.Boolean()),
				checkNetwork: Type.Optional(Type.Boolean()),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES)),
			}, { additionalProperties: false }),
		], { description: "QA a URL or current session (attached=true). Default readiness: domcontentloaded; use networkidle only without long-lived requests. URL diagnostics default on, attached diagnostics off." }),
	),
	sourceLookup: Type.Optional(
		Type.Object({
			selector: Type.Optional(Type.String({ description: "Visible selector or @ref." })),
			reactFiberId: Type.Optional(Type.String({ description: "React fiber id; requires --enable react-devtools." })),
			componentName: Type.Optional(Type.String({ description: "Component for local source search." })),
			includeDomHints: Type.Optional(Type.Boolean({ description: "Inspect DOM source hints; default true." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Source scan cap; default 2000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}, { additionalProperties: false, description: "EXPERIMENTAL UI-to-source candidates; not guaranteed mappings." }),
	),
	networkSourceLookup: Type.Optional(
		Type.Object({
			filter: Type.Optional(Type.String({ description: "Network request filter." })),
			namespace: Type.Optional(Type.String()),
			requestId: Type.Optional(Type.String({ description: "Request id to inspect." })),
			session: Type.Optional(Type.String()),
			url: Type.Optional(Type.String({ description: "Failed URL or fragment." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Source scan cap; default 2000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}, { additionalProperties: false, description: "EXPERIMENTAL failed-request-to-source candidates; not proof." }),
	),
	electron: Type.Optional(
		Type.Union([
			Type.Object({
				action: StringEnum(["list"] as const),
				query: Type.Optional(Type.String({ description: "Case-insensitive app filter.", minLength: 1 })),
				maxResults: Type.Optional(Type.Integer({ description: `Result cap; default ${ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS}, values over ${ELECTRON_DISCOVERY_MAX_RESULTS} are clamped.`, minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const),
				appPath: Type.Optional(Type.String({ description: "macOS .app path.", minLength: 1 })),
				appName: Type.Optional(Type.String({ description: "Name from electron.list.", minLength: 1 })),
				bundleId: Type.Optional(Type.String({ description: "Bundle id from electron.list.", minLength: 1 })),
				executablePath: Type.Optional(Type.String({ description: "Executable path.", minLength: 1 })),
				appArgs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS)),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES)),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
				deny: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const),
				launchId: Type.String({ description: "Tracked launch id.", minLength: 1 }),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const),
				all: Type.Literal(true),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["probe"] as const),
				launchId: Type.Optional(Type.String({ description: "Tracked launch id.", minLength: 1 })),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
			}, { additionalProperties: false }),
		], { description: "Electron discovery, isolated-profile launch, status, probe, or cleanup. Launch defaults: handoff=snapshot, targetType=page; deny wins over allow; lifecycle/debug appArgs rejected." }),
	),
	job: Type.Optional(
		Type.Object({
			failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure; default true." })),
			steps: Type.Array(
				Type.Object({
					action: StringEnum(AGENT_BROWSER_JOB_STEP_ACTIONS),
					url: Type.Optional(Type.String({ description: "Open URL, or assertUrl exact URL/glob that distinguishes the expected state from the starting page." })),
					loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES, { description: "Readiness wait after open." })),
					selector: Type.Optional(Type.String({ description: "Selector or @ref." })),
					locator: Type.Optional(StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, { description: "Locator when selector is omitted." })),
					role: Type.Optional(Type.String({ description: "Role locator." })),
					name: Type.Optional(Type.String({ description: "Accessible name." })),
					text: Type.Optional(Type.String({ description: "Fill text or assertText target." })),
					value: Type.Optional(Type.String({ description: "Select option or locator value." })),
					values: Type.Optional(Type.Array(Type.String(), { description: "Select options.", minItems: 1 })),
					path: Type.Optional(Type.String({ description: "Download or screenshot path." })),
					delayMs: Type.Optional(Type.Integer({ description: `Per-character type delay; text is capped at ${AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS} characters.`, minimum: 1 })),
					press: Type.Optional(Type.String({ description: "Key to press after typing." })),
					milliseconds: Type.Optional(Type.Number({ description: "Wait duration in milliseconds." })),
				}, { additionalProperties: false }),
				{ minItems: 1 },
			),
		}, { additionalProperties: false, description: "Constrained multi-step batch." }),
	),
	stdin: Type.Optional(Type.String({ description: "Raw stdin for batch, eval --stdin, or auth save --password-stdin; unavailable with structured modes and electron." })),
	outputPath: Type.Optional(Type.String({ description: "Workspace-relative or absolute result-data path; keep it distinct from screenshot, download, recording, and other browser artifact destinations.", minLength: 1 })),
	timeoutMs: Type.Optional(Type.Integer({ description: "Wrapper timeout in ms; exceed explicit waits. Electron uses electron.timeoutMs.", minimum: 1 })),
	sessionMode: Type.Optional(
		StringEnum(["auto", "fresh"] as const, {
			description: "auto reuses the managed session; fresh starts one for launch-only flags, then makes it the managed session.",
			default: DEFAULT_SESSION_MODE,
		}),
	),
	}, {
		additionalProperties: false,
		description: "Choose one input mode: script, args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron.",
	});
}

export const AGENT_BROWSER_PARAMS = createAgentBrowserParamsSchema();
