import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import {
	buildBrowserDefaultProfileGuideline,
	buildBrowserExecutablePathGuideline,
	buildToolPromptGuidelines,
} from "../playbook.js";
import { isRecord } from "../parsing.js";
import { buildPromptPolicy, getLatestUserMessage, getMessageText } from "../prompt-policy.js";
import { canRegisterWebSearchTool, loadAgentBrowserConfigSync } from "../config.js";
import { createAgentBrowserWebSearchTool } from "../web-search.js";

interface PromptState {
	sessionId: string;
	message: ReturnType<typeof getLatestUserMessage>;
	text?: string;
	policy?: ReturnType<typeof buildPromptPolicy>;
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
	const root = findPackageRoot(import.meta.dirname);
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
export function isToolDeclared(
	options: Readonly<Pick<NormalizedBuildSystemPromptOptions, "selectedTools" | "hiddenTools">>,
	name: string,
): boolean {
	return options.selectedTools.includes(name) && !options.hiddenTools.includes(name);
}
/** Owns prompt caching and companion registration, never browser or artifact state. */
export class BrowserPrompt {
	private docsPaths: ReturnType<typeof getInstalledDocsPaths> | undefined;
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
	private resolveGuidance(ctx: ExtensionContext): {
		readonly guidelines: readonly string[];
		readonly projectGuidance: readonly string[];
	} {
		const config = loadAgentBrowserConfigSync({
			cwd: ctx.cwd,
			includeProjectConfig: shouldIncludeProjectConfig(ctx),
		});
		const projectGuidance = [
			config.browserExecutablePathScope === "project"
				? buildBrowserExecutablePathGuideline(config.browserExecutablePath)
				: undefined,
			config.browserDefaultProfileScope === "project"
				? buildBrowserDefaultProfileGuideline(config.browserDefaultProfile)
				: undefined,
		].filter((line): line is string => typeof line === "string" && line.length > 0);
		const guidelines = buildToolPromptGuidelines({
			browserDefaultProfile: config.trustedBrowserDefaultProfile,
			browserExecutablePath: config.trustedBrowserExecutablePath,
			docs: (this.docsPaths ??= getInstalledDocsPaths()),
		});
		return { guidelines, projectGuidance };
	}
	guidelineLines(ctx: ExtensionContext): string[] {
		const { guidelines, projectGuidance } = this.resolveGuidance(ctx);
		return [...new Set([...guidelines, ...projectGuidance])];
	}
	instructions(ctx: ExtensionContext): string {
		const { guidelines, projectGuidance } = this.resolveGuidance(ctx);
		const configPrompt =
			projectGuidance.length > 0
				? `\n\nProject agent_browser config guidance:\n${projectGuidance.map((line) => `- ${line}`).join("\n")}`
				: "";
		return `${guidelines.map((line) => `- ${line}`).join("\n")}${configPrompt}`;
	}
	register(): void {
		this.pi.on("message_end", (event, ctx) => {
			if (event.message.role === "user") {
				this.state = { sessionId: ctx.sessionManager.getSessionId(), message: event.message };
			}
		});
		this.pi.on("before_agent_start", (event, ctx) => {
			if (isToolDeclared(event.systemPromptOptions, "agent_browser")) {
				// oxlint-disable-next-line no-param-reassign -- QX-003: Pi composes additive prompt sections through this mutable event.
				event.systemPromptOptions.sections.agent_browser = this.instructions(ctx);
				// oxlint-disable-next-line no-param-reassign -- QX-003: Pi composes per-tool guidelines through this mutable event.
				event.systemPromptOptions.toolGuidelines.agent_browser = [];
				return;
			}
			if (isToolDeclared(event.systemPromptOptions, "tool_search")) {
				// oxlint-disable-next-line no-param-reassign -- QX-003: Pi composes per-tool guidelines through this mutable event.
				event.systemPromptOptions.toolGuidelines.agent_browser = this.guidelineLines(ctx);
			}
		});
	}
}
