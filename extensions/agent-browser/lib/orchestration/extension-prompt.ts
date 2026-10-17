import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PROJECT_RULE_PROMPT,
	ADVANCED_TOOL_PROMPT_GUIDELINES,
	QUICK_START_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	WEB_SEARCH_TOOL_PROMPT_GUIDELINES,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
	buildBrowserDefaultProfileGuideline,
	buildBrowserExecutablePathGuideline,
	buildToolPromptGuidelines,
} from "../playbook.js";
import { isRecord } from "../parsing.js";
import { buildPromptPolicy, getLatestUserMessage, getMessageText } from "../prompt-policy.js";
import { AGENT_BROWSER_INSTRUCTION_GROUP, AGENT_BROWSER_TOOL_INVENTORY } from "../tool-surface.js";
import { canRegisterWebSearchTool, loadAgentBrowserConfigSync } from "../config.js";
import { createAgentBrowserWebSearchTool } from "../web-search.js";
import {
	isDirectAgentBrowserBashAllowed,
	isHarmlessAgentBrowserInspectionCommand,
	looksLikeDirectAgentBrowserBash,
} from "../bash-guard.js";

interface PromptState {
	sessionId: string;
	message: ReturnType<typeof getLatestUserMessage>;
	text?: string;
	policy?: ReturnType<typeof buildPromptPolicy>;
}

export const COMPACT_FALLBACK_ENV = "AGENT_BROWSER_COMPACT_FALLBACK";
export const PLAYBOOK_MODE_ENV = "AGENT_BROWSER_PLAYBOOK";

function isCompactFallbackEnabled(): boolean {
	const compactEnv = process.env[COMPACT_FALLBACK_ENV]?.trim().toLowerCase();
	if (compactEnv === "1" || compactEnv === "true" || compactEnv === "yes") {
		return true;
	}
	const playbookEnv = process.env[PLAYBOOK_MODE_ENV]?.trim().toLowerCase();
	return (
		playbookEnv === "compact" ||
		playbookEnv === "minimal" ||
		playbookEnv === "0" ||
		playbookEnv === "false"
	);
}
export function isBashToolCallEvent(
	event: unknown,
): event is { readonly input: { readonly command: string }; readonly toolName: "bash" } {
	return (
		isRecord(event) &&
		event.toolName === "bash" &&
		isRecord(event.input) &&
		typeof event.input.command === "string"
	);
}
export function findPackageRoot(startDir: string): string {
	let currentDir = startDir;
	while (true) {
		const packageJsonPath = join(currentDir, "package.json");
		if (existsSync(packageJsonPath)) {
			const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
			if (isRecord(packageJson) && packageJson.name === "pi-agent-browser-native") {
				return currentDir;
			}
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return startDir;
		}
		currentDir = parentDir;
	}
}
export function getInstalledDocsPaths(): {
	readmePath: string;
	commandReferencePath: string;
	toolContractPath: string;
} {
	const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
	return {
		readmePath: join(root, "README.md"),
		commandReferencePath: join(root, "docs", "COMMAND_REFERENCE.md"),
		toolContractPath: join(root, "docs", "TOOL_CONTRACT.md"),
	};
}
export function hasArgvFlag(argv: readonly string[], longFlag: string, shortFlag: string): boolean {
	return argv.includes(longFlag) || argv.includes(shortFlag);
}
export function shouldIncludeProjectConfig(
	ctx: Readonly<Pick<ExtensionContext, "isProjectTrusted">>,
	argv: readonly string[] = process.argv,
): boolean {
	return !hasArgvFlag(argv, "--no-approve", "-na") && ctx.isProjectTrusted();
}
/** Owns prompt caching and companion registration, never browser or artifact state. */
export class BrowserPrompt {
	private state: PromptState | undefined;
	private webSearchToolRegistered = false;
	constructor(private readonly pi: ExtensionAPI) {}
	restore(ctx: ExtensionContext): PromptState {
		this.state = {
			sessionId: ctx.sessionManager.getSessionId(),
			message: getLatestUserMessage(ctx.sessionManager),
		};
		return this.state;
	}
	policy(ctx: ExtensionContext): ReturnType<typeof buildPromptPolicy> {
		const state =
			this.state?.sessionId === ctx.sessionManager.getSessionId() ? this.state : this.restore(ctx);
		// Keep the native message reference: later transforms must be reflected in policy.
		const text = getMessageText(state.message?.content);
		if (!state.policy || state.text !== text) {
			state.text = text;
			state.policy = buildPromptPolicy(text);
		}
		return state.policy;
	}
	registerWebSearch(config: ReturnType<typeof loadAgentBrowserConfigSync>): void {
		if (this.webSearchToolRegistered || !canRegisterWebSearchTool(config)) {
			return;
		}
		this.pi.registerTool({
			...createAgentBrowserWebSearchTool(config, {
				loadConfigState(ctx) {
					return loadAgentBrowserConfigSync({
						cwd: ctx.cwd,
						includeProjectConfig: shouldIncludeProjectConfig(ctx),
					});
				},
			}),
		});
		this.webSearchToolRegistered = true;
	}
	instructions(ctx: ExtensionContext, options?: Readonly<{ forceFull?: boolean }>): string {
		const config = loadAgentBrowserConfigSync({
			cwd: ctx.cwd,
			includeProjectConfig: shouldIncludeProjectConfig(ctx),
		});
		const guidance = [
			config.browserExecutablePathScope === "project"
				? buildBrowserExecutablePathGuideline(config.browserExecutablePath)
				: undefined,
			config.browserDefaultProfileScope === "project"
				? buildBrowserDefaultProfileGuideline(config.browserDefaultProfile)
				: undefined,
		].filter((line): line is string => typeof line === "string" && line.length > 0);
		const configPrompt =
			guidance.length > 0
				? `\n\nProject agent_browser config guidance:\n${guidance.map((line) => `- ${line}`).join("\n")}`
				: "";
		const compact = !(options?.forceFull ?? false) && isCompactFallbackEnabled();
		const guidelines = [
			...buildToolPromptGuidelines({
				browserDefaultProfile: config.trustedBrowserDefaultProfile,
				browserExecutablePath: config.trustedBrowserExecutablePath,
				includeWebSearch: this.webSearchToolRegistered,
				docs: getInstalledDocsPaths(),
			}),
			...(compact
				? []
				: [
						...QUICK_START_GUIDELINES,
						...SHARED_BROWSER_PLAYBOOK_GUIDELINES,
						...WRAPPER_TAB_RECOVERY_BEHAVIOR,
						...Object.values(ADVANCED_TOOL_PROMPT_GUIDELINES).flat(),
						...(this.webSearchToolRegistered ? WEB_SEARCH_TOOL_PROMPT_GUIDELINES : []),
					]),
		];
		return `${PROJECT_RULE_PROMPT}\n\n${[...new Set(guidelines)].map((line) => `- ${line}`).join("\n")}${configPrompt}`;
	}
	private registerCollector(data: unknown, setManaged: (managed: () => boolean) => void): void {
		if (
			!isRecord(data) ||
			typeof data.register !== "function" ||
			typeof data.isManaged !== "function"
		) {
			throw new Error("Invalid Pi instruction-group collector.");
		}
		const register = data.register;
		const isManaged = data.isManaged;
		Reflect.apply(register, data, [
			{
				...AGENT_BROWSER_INSTRUCTION_GROUP,
				tools: [
					"agent_browser",
					"agent_browser_code",
					"agent_browser_tools",
					"agent_browser_web_search",
					...Object.values(AGENT_BROWSER_TOOL_INVENTORY).map(({ name }) => name),
				],
				instructions: (ctx: ExtensionContext) => this.instructions(ctx, { forceFull: true }),
			},
		]);
		setManaged(() => {
			const managed: unknown = Reflect.apply(isManaged, undefined, []);
			if (typeof managed !== "boolean") {
				throw new Error("Pi instruction-group ownership must be boolean.");
			}
			return managed;
		});
	}
	register(): void {
		let isInstructionsManaged = () => false;
		this.pi.on("message_end", (event, ctx) => {
			if (event.message.role === "user") {
				this.state = { sessionId: ctx.sessionManager.getSessionId(), message: event.message };
			}
		});
		this.pi.events.on("pi:instruction-groups", (data) =>
			this.registerCollector(data, (managed) => {
				isInstructionsManaged = managed;
			}),
		);
		this.pi.on("before_agent_start", async (event, ctx) => {
			if (!isInstructionsManaged()) {
				event.systemPromptOptions.sections.agent_browser = this.instructions(ctx);
			}
		});
		this.pi.on("tool_call", async (event, ctx) => {
			if (
				!isBashToolCallEvent(event) ||
				!looksLikeDirectAgentBrowserBash(event.input.command) ||
				isHarmlessAgentBrowserInspectionCommand(event.input.command)
			) {
				return;
			}
			if (
				!this.policy(ctx).allowLegacyAgentBrowserBash &&
				!(await isDirectAgentBrowserBashAllowed(ctx.cwd))
			) {
				return {
					block: true,
					reason:
						"Use the native agent_browser tool instead of bash for agent-browser in this environment.",
				};
			}
			return;
		});
	}
}
