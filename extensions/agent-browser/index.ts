/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { rm } from "node:fs/promises";

import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { runAgentBrowserProcess } from "./lib/process.js";
import { buildToolPresentation, getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "./lib/results.js";
import {
	buildExecutionPlan,
	buildPromptPolicy,
	createEphemeralSessionSeed,
	createFreshSessionName,
	createImplicitSessionName,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	getLatestUserPrompt,
	hasUsableBraveApiKey,
	redactInvocationArgs,
	redactSensitiveText,
	redactSensitiveValue,
	restoreManagedSessionStateFromBranch,
	resolveManagedSessionState,
	shouldAppendBrowserSystemPrompt,
	validateToolArgs,
} from "./lib/runtime.js";
import { cleanupSecureTempArtifacts, type PersistentSessionArtifactStore } from "./lib/temp.js";

const DEFAULT_SESSION_MODE = "auto" as const;

const AGENT_BROWSER_PARAMS = Type.Object({
	args: Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name." }), {
		description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators.",
		minItems: 1,
	}),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content for commands like eval --stdin or batch." })),
	sessionMode: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fresh")], {
			description:
				"Session handling mode. `auto` reuses the extension-managed pi-scoped session when possible. `fresh` switches that managed session to a fresh upstream launch so startup-scoped flags like --profile, --session-name, or --cdp apply and later auto calls follow the new browser.",
			default: DEFAULT_SESSION_MODE,
		}),
	),
});
const PROJECT_RULE_PROMPT =
	"Project rule: when browser automation is needed, prefer the native `agent_browser` tool. Do not run direct `agent-browser` bash commands unless the user explicitly asks for a bash-oriented workflow or browser-integration debugging.";
const QUICK_START_GUIDELINES = [
	"Quick start mental model: args are the exact agent-browser CLI args after the binary; stdin is only for batch and eval --stdin; sessionMode=fresh switches the extension-managed session to a fresh upstream launch when you need new --profile, --session-name, or --cdp state.",
	"Common first calls: { args: [\"open\", \"https://example.com\"] } then { args: [\"snapshot\", \"-i\"] }; after navigation, use { args: [\"click\", \"@e2\"] } then { args: [\"snapshot\", \"-i\"] }.",
	"Common advanced calls: { args: [\"batch\"], stdin: \"[[\\\"open\\\",\\\"https://example.com\\\"],[\\\"snapshot\\\",\\\"-i\\\"]]\" }, { args: [\"eval\", \"--stdin\"], stdin: \"document.title\" }, and { args: [\"--profile\", \"Default\", \"open\", \"https://example.com/account\"], sessionMode: \"fresh\" }.",
] as const;
const BRAVE_SEARCH_PROMPT_GUIDELINE =
	"When a non-empty BRAVE_API_KEY is available in the current environment, prefer the Brave Search API via bash/curl to discover specific destination URLs, then open the chosen URL with agent_browser instead of browsing a search engine results page just to find the target.";
const SHARED_BROWSER_PLAYBOOK_GUIDELINES = [
	"Standard workflow: open the page, snapshot -i, interact using refs, and re-snapshot after navigation or major DOM changes.",
	"For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.",
	"Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.",
	"When using --profile, --session-name, or --cdp, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.",
	"If you already used the implicit session and now need startup-scoped flags like --profile, --session-name, or --cdp, retry with sessionMode set to fresh or pass an explicit --session for the new launch. After a successful unnamed fresh launch, later auto calls follow that new session.",
	"If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <n> / snapshot -i to recover state before retrying different URLs or fallback strategies. Only use wait with an explicit argument like milliseconds, --load, --url, --fn, or --text.",
	"For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.",
	"For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.",
	"When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.",
	"When using eval --stdin for extraction, return the value you want instead of relying on console.log as the primary result channel.",
	"Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.",
] as const;
const TOOL_PROMPT_GUIDELINES_PREFIX = ["Use this tool whenever the task requires a real browser or live web content."] as const;
const TOOL_PROMPT_GUIDELINES_SUFFIX = [
	"Prefer this tool over bash for opening sites, reading docs on the web, clicking, filling, screenshots, eval, and batch workflows.",
	"Do not fall back to osascript, AppleScript, or generic browser-driving bash commands when this tool can do the job.",
	"Pass exact agent-browser CLI arguments in args, excluding the binary name.",
	"Use stdin for commands like eval --stdin and batch instead of shell heredocs.",
	"Let the extension-managed session handle the common path unless you explicitly need a fresh launch for upstream flags like --profile, --session-name, or --cdp.",
	"Use sessionMode=fresh when switching from an existing implicit session to a new profile/debug launch without inventing a fixed explicit session name; later auto calls will follow that new session.",
] as const;

function buildMissingBinaryMessage(): string {
	return [
		"agent-browser is required but was not found on PATH.",
		"This project does not bundle agent-browser.",
		"Install it using the upstream docs:",
		"- https://agent-browser.dev/",
		"- https://github.com/vercel-labs/agent-browser",
	].join("\n");
}

function buildInvocationPreview(effectiveArgs: string[]): string {
	const preview = effectiveArgs.join(" ");
	return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

const AGENT_BROWSER_BASH_PREFIX = String.raw`(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+)*\s+)?(?:(?:npx|bunx)(?:\s+-[^\s;&|]+|\s+--[^\s;&|]+(?:=[^\s;&|]+)?)*\s+|(?:pnpm|yarn)\s+dlx(?:\s+-[^\s;&|]+|\s+--[^\s;&|]+(?:=[^\s;&|]+)?)*\s+)?`;
const AGENT_BROWSER_BASH_EXECUTABLE = String.raw`(?:[.~]|\.\.?|\/)?(?:[^\s;&|]+\/)?agent-browser`;
const SHELL_COMMAND_SEGMENT_START_PATTERN = String.raw`(?:^\s*|(?:&&|\|\||[;&|])\s*)`;
const DIRECT_AGENT_BROWSER_BASH_PATTERN = new RegExp(
	String.raw`${SHELL_COMMAND_SEGMENT_START_PATTERN}${AGENT_BROWSER_BASH_PREFIX}${AGENT_BROWSER_BASH_EXECUTABLE}(?=\s|$)`,
);
const HARMLESS_AGENT_BROWSER_INSPECTION_PATTERN = /(command\s+-v|which|type\s+-P)\s+agent-browser\b/;

function looksLikeDirectAgentBrowserBash(command: string): boolean {
	return DIRECT_AGENT_BROWSER_BASH_PATTERN.test(command);
}

function isHarmlessAgentBrowserInspectionCommand(command: string): boolean {
	return HARMLESS_AGENT_BROWSER_INSPECTION_PATTERN.test(command);
}

const NAVIGATION_SUMMARY_COMMANDS = new Set(["back", "click", "dblclick", "forward", "reload"]);

interface NavigationSummary {
	title?: string;
	url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function shouldCaptureNavigationSummary(command: string | undefined, data: unknown): boolean {
	return (
		command !== undefined &&
		NAVIGATION_SUMMARY_COMMANDS.has(command) &&
		(!isRecord(data) || (typeof data.title !== "string" && typeof data.url !== "string"))
	);
}

function extractStringResultField(data: unknown, fieldName: "title" | "url"): string | undefined {
	if (typeof data === "string") {
		const text = data.trim();
		return text.length > 0 ? text : undefined;
	}
	if (!isRecord(data) || typeof data[fieldName] !== "string") {
		return undefined;
	}
	const text = data[fieldName].trim();
	return text.length > 0 ? text : undefined;
}

async function collectNavigationSummary(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<NavigationSummary | undefined> {
	const { cwd, sessionName, signal } = options;
	if (!sessionName) return undefined;

	const readField = async (fieldName: "title" | "url"): Promise<string | undefined> => {
		const processResult = await runAgentBrowserProcess({
			args: ["--json", "--session", sessionName, "get", fieldName],
			cwd,
			signal,
		});
		if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0) {
			return undefined;
		}
		const parsed = await parseAgentBrowserEnvelope({
			stdout: processResult.stdout,
			stdoutPath: processResult.stdoutSpillPath,
		});
		try {
			if (parsed.parseError || parsed.envelope?.success === false) {
				return undefined;
			}
			return extractStringResultField(parsed.envelope?.data, fieldName);
		} finally {
			if (processResult.stdoutSpillPath) {
				await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
			}
		}
	};

	const title = await readField("title");
	const url = await readField("url");
	if (!title && !url) return undefined;
	return { title, url };
}

function mergeNavigationSummaryIntoData(data: unknown, navigationSummary: NavigationSummary): unknown {
	if (isRecord(data)) {
		return { ...data, navigationSummary };
	}
	return { navigationSummary, result: data };
}

function buildSharedBrowserPlaybookGuidelines(hasBraveApiKey: boolean): string[] {
	return [
		SHARED_BROWSER_PLAYBOOK_GUIDELINES[0],
		...(hasBraveApiKey ? [BRAVE_SEARCH_PROMPT_GUIDELINE] : []),
		...SHARED_BROWSER_PLAYBOOK_GUIDELINES.slice(1),
	];
}

function buildToolPromptGuidelines(hasBraveApiKey: boolean): string[] {
	return [
		...TOOL_PROMPT_GUIDELINES_PREFIX,
		...QUICK_START_GUIDELINES,
		...buildSharedBrowserPlaybookGuidelines(hasBraveApiKey),
		...TOOL_PROMPT_GUIDELINES_SUFFIX,
	];
}

function buildSessionDetailFields(sessionName: string | undefined, usedImplicitSession: boolean): Record<string, unknown> {
	return sessionName ? { sessionName, usedImplicitSession } : {};
}

function getPersistentSessionArtifactStore(ctx: {
	sessionManager: {
		getSessionDir?: () => string;
		getSessionFile?: () => string | undefined;
		getSessionId: () => string | undefined;
	};
}): PersistentSessionArtifactStore | undefined {
	const sessionFile = typeof ctx.sessionManager.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
	const sessionDir = typeof ctx.sessionManager.getSessionDir === "function" ? ctx.sessionManager.getSessionDir() : undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionFile || !sessionDir || !sessionId) {
		return undefined;
	}
	return { sessionDir, sessionId };
}

function redactRecoveryHint(recoveryHint: {
	exampleArgs: string[];
	exampleParams: { args: string[]; sessionMode: "fresh" };
	reason: string;
	recommendedSessionMode: "fresh";
} | undefined): typeof recoveryHint {
	if (!recoveryHint) {
		return undefined;
	}
	const exampleArgs = redactInvocationArgs(recoveryHint.exampleArgs);
	return {
		...recoveryHint,
		exampleArgs,
		exampleParams: {
			...recoveryHint.exampleParams,
			args: exampleArgs,
		},
	};
}

async function closeManagedSession(options: { cwd: string; sessionName: string; timeoutMs: number }): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		await runAgentBrowserProcess({
			args: ["--session", options.sessionName, "close"],
			cwd: options.cwd,
			signal: controller.signal,
		});
	} catch {
		// Best-effort cleanup only.
	} finally {
		clearTimeout(timer);
	}
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	const hasBraveApiKey = hasUsableBraveApiKey();
	const toolPromptGuidelines = buildToolPromptGuidelines(hasBraveApiKey);
	const implicitSessionIdleTimeoutMs = getImplicitSessionIdleTimeoutMs();
	const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let freshSessionOrdinal = 0;

	pi.on("session_start", async (_event, ctx) => {
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const restoredState = restoreManagedSessionStateFromBranch(ctx.sessionManager.getBranch(), managedSessionBaseName);
		managedSessionActive = restoredState.active;
		managedSessionName = restoredState.sessionName;
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = restoredState.freshSessionOrdinal;
	});

	pi.on("session_shutdown", async () => {
		managedSessionActive = false;
		await cleanupSecureTempArtifacts();
	});

	pi.on("before_agent_start", async (event) => {
		if (!shouldAppendBrowserSystemPrompt(event.prompt)) {
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PROJECT_RULE_PROMPT}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
		if (
			isToolCallEventType("bash", event) &&
			!promptPolicy.allowLegacyAgentBrowserBash &&
			looksLikeDirectAgentBrowserBash(event.input.command) &&
			!isHarmlessAgentBrowserInspectionCommand(event.input.command)
		) {
			return {
				block: true,
				reason: "Use the native agent_browser tool instead of bash for agent-browser in this environment.",
			};
		}
	});

	pi.registerTool({
		name: "agent_browser",
		label: "Agent Browser",
		description:
			"Browse and interact with websites using agent-browser. Use this for web research, reading live docs, opening pages, taking snapshots or screenshots, clicking links, filling forms, extracting page content, and authenticated/profile-based browser work.",
		promptSnippet:
			"Browse websites, read live docs, click and fill pages, extract browser content, take screenshots, and automate real web workflows.",
		promptGuidelines: toolPromptGuidelines,
		parameters: AGENT_BROWSER_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const redactedArgs = redactInvocationArgs(params.args);
			const validationError = validateToolArgs(params.args);
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: { args: redactedArgs, validationError },
					isError: true,
				};
			}

			const sessionMode = params.sessionMode ?? DEFAULT_SESSION_MODE;
			const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
			const executionPlan = buildExecutionPlan(params.args, {
				freshSessionName,
				managedSessionActive,
				managedSessionName,
				sessionMode,
			});
			const redactedEffectiveArgs = redactInvocationArgs(executionPlan.effectiveArgs);
			const redactedRecoveryHint = redactRecoveryHint(executionPlan.recoveryHint);
			if (executionPlan.managedSessionName === freshSessionName) {
				freshSessionOrdinal += 1;
			}

			if (executionPlan.validationError) {
				return {
					content: [{ type: "text", text: executionPlan.validationError }],
					details: {
						args: redactedArgs,
						invalidValueFlag: executionPlan.invalidValueFlag,
						sessionMode,
						sessionRecoveryHint: redactedRecoveryHint,
						startupScopedFlags: executionPlan.startupScopedFlags,
						validationError: executionPlan.validationError,
					},
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Running agent-browser ${buildInvocationPreview(redactedEffectiveArgs)}` }],
				details: {
					effectiveArgs: redactedEffectiveArgs,
					sessionMode,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
				},
			});

			const processResult = await runAgentBrowserProcess({
				args: executionPlan.effectiveArgs,
				cwd: ctx.cwd,
				env: executionPlan.managedSessionName ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: implicitSessionIdleTimeoutMs } : undefined,
				signal,
				stdin: params.stdin,
			});

			if (processResult.spawnError?.message.includes("ENOENT")) {
				const errorText = buildMissingBinaryMessage();
				return {
					content: [{ type: "text", text: errorText }],
					details: {
						args: redactedArgs,
						effectiveArgs: redactedEffectiveArgs,
						sessionMode,
						spawnError: processResult.spawnError.message,
					},
					isError: true,
				};
			}

			try {
				const parsed = await parseAgentBrowserEnvelope({
					stdout: processResult.stdout,
					stdoutPath: processResult.stdoutSpillPath,
				});
				let presentationEnvelope = parsed.envelope;
				const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
				const plainTextInspection = executionPlan.plainTextInspection && processSucceeded;
				const parseSucceeded = plainTextInspection || parsed.parseError === undefined;
				const envelopeSuccess = plainTextInspection ? true : parsed.envelope?.success !== false;
				const succeeded = processSucceeded && parseSucceeded && envelopeSuccess;
				const inspectionText = plainTextInspection ? processResult.stdout.trim() : undefined;

				let navigationSummary: NavigationSummary | undefined;
				if (succeeded && shouldCaptureNavigationSummary(executionPlan.commandInfo.command, parsed.envelope?.data)) {
					navigationSummary = await collectNavigationSummary({
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						signal,
					});
					if (navigationSummary && presentationEnvelope) {
						presentationEnvelope = {
							...presentationEnvelope,
							data: mergeNavigationSummaryIntoData(presentationEnvelope.data, navigationSummary),
						};
					}
				}

				const priorManagedSessionCwd = managedSessionCwd;
				const managedSessionState = resolveManagedSessionState({
					command: executionPlan.commandInfo.command,
					managedSessionName: executionPlan.managedSessionName,
					priorActive: managedSessionActive,
					priorSessionName: managedSessionName,
					succeeded,
				});
				const replacedManagedSessionName = managedSessionState.replacedSessionName;
				managedSessionActive = managedSessionState.active;
				managedSessionName = managedSessionState.sessionName;
				if (executionPlan.managedSessionName && succeeded) {
					managedSessionCwd = ctx.cwd;
				}
				if (replacedManagedSessionName) {
					await closeManagedSession({
						cwd: priorManagedSessionCwd,
						sessionName: replacedManagedSessionName,
						timeoutMs: implicitSessionCloseTimeoutMs,
					});
				}

				const errorText = getAgentBrowserErrorText({
					aborted: processResult.aborted,
					envelope: parsed.envelope,
					exitCode: processResult.exitCode,
					parseError: parsed.parseError,
					plainTextInspection,
					spawnError: processResult.spawnError,
					stderr: processResult.stderr,
				});

				const presentation = plainTextInspection
					? {
						batchFailure: undefined,
						batchSteps: undefined,
						content: [{ type: "text" as const, text: inspectionText ?? "" }],
						data: undefined,
						fullOutputPath: undefined,
						fullOutputPaths: undefined,
						imagePath: undefined,
						imagePaths: undefined,
						summary: `${redactedArgs.join(" ")} completed`,
					  }
					: await buildToolPresentation({
							commandInfo: executionPlan.commandInfo,
							cwd: ctx.cwd,
							envelope: presentationEnvelope,
							errorText,
							persistentArtifactStore: getPersistentSessionArtifactStore(ctx),
					  });
				const redactedContent = presentation.content.map((item) =>
					item.type === "text" ? { ...item, text: redactSensitiveText(item.text) } : item,
				);

				return {
					content: redactedContent,
					details: {
						args: redactedArgs,
						batchFailure: redactSensitiveValue(presentation.batchFailure),
						batchSteps: redactSensitiveValue(presentation.batchSteps),
						command: executionPlan.commandInfo.command,
						subcommand: executionPlan.commandInfo.subcommand,
						data: redactSensitiveValue(presentation.data),
						error: plainTextInspection ? undefined : redactSensitiveValue(parsed.envelope?.error),
						inspection: plainTextInspection || undefined,
						navigationSummary: redactSensitiveValue(navigationSummary),
						effectiveArgs: redactedEffectiveArgs,
						exitCode: processResult.exitCode,
						fullOutputPath: presentation.fullOutputPath,
						fullOutputPaths: presentation.fullOutputPaths,
						imagePath: presentation.imagePath,
						imagePaths: presentation.imagePaths,
						parseError: plainTextInspection ? undefined : parsed.parseError,
						sessionMode,
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						sessionRecoveryHint: redactedRecoveryHint,
						startupScopedFlags: executionPlan.startupScopedFlags,
						stderr: processResult.stderr ? redactSensitiveText(processResult.stderr) : undefined,
						stdout: plainTextInspection
							? redactSensitiveText(inspectionText ?? "")
							: parseSucceeded
								? undefined
								: redactSensitiveText(processResult.stdout),
						summary: redactSensitiveText(presentation.summary),
					},
					isError: !succeeded,
				};
			} finally {
				if (processResult.stdoutSpillPath) {
					await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
				}
			}
		},
	});
}
