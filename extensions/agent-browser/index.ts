/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage implicit session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest or the local `.pi/extensions/agent-browser.ts` development entrypoint.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { runAgentBrowserProcess } from "./lib/process.js";
import { buildToolPresentation, parseAgentBrowserEnvelope } from "./lib/results.js";
import {
	buildExecutionPlan,
	createEphemeralSessionSeed,
	createImplicitSessionName,
	validateToolArgs,
} from "./lib/runtime.js";

const IMPLICIT_SESSION_IDLE_TIMEOUT_MS = "900000";
const IMPLICIT_SESSION_CLOSE_TIMEOUT_MS = 5_000;

const AGENT_BROWSER_PARAMS = Type.Object({
	args: Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name." }), {
		description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators.",
		minItems: 1,
	}),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content for commands like eval --stdin or batch." })),
	useActiveSession: Type.Optional(
		Type.Boolean({
			description: "When true and no explicit --session is present, inject the implicit session for this pi session.",
			default: true,
		}),
	),
});

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

function shouldAllowLegacyAgentBrowserBash(prompt: string): boolean {
	const lowered = prompt.toLowerCase();
	return [
		"legacy skill",
		"agent-browser skill",
		"~/.agents/skills/agent-browser",
		"use bash",
		"via bash",
		"npx agent-browser",
		"agent-browser --help",
		"agent-browser --version",
	].some((needle) => lowered.includes(needle));
}

function shouldAllowAgentBrowserInspection(prompt: string): boolean {
	const lowered = prompt.toLowerCase();
	return [
		"agent_browser --help",
		"agent-browser --help",
		"agent_browser --version",
		"agent-browser --version",
		"tool guidance",
		"tool contract",
		"tool description",
		"documentation",
		"docs",
		"debug the browser integration",
		"debug agent_browser",
		"why isn't agent_browser",
		"why is agent_browser",
	].some((needle) => lowered.includes(needle));
}

function looksLikeDirectAgentBrowserBash(command: string): boolean {
	return /(^|[\s;&|])(npx\s+)?agent-browser(\s|$)/.test(command);
}

function isHarmlessAgentBrowserInspectionCommand(command: string): boolean {
	return /(command\s+-v|which)\s+agent-browser\b/.test(command) || /(^|\s)agent-browser\s+--(help|version)\b/.test(command);
}

function isPlainTextInspectionArgs(args: string[]): boolean {
	return args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-V");
}

function buildInspectionDeflectionMessage(): string {
	return [
		"Do not inspect agent_browser help for a normal browser task.",
		"Use the workflow directly:",
		"1. open the target URL",
		"2. snapshot -i",
		"3. interact using refs and re-snapshot after navigation or major DOM changes",
		"For authenticated or user-specific content like feeds, inboxes, dashboards, or accounts, start with an authenticated strategy such as --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable.",
	].join("\n");
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	let allowLegacyAgentBrowserBash = false;
	let allowAgentBrowserInspection = false;
	let implicitSessionName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let implicitSessionCwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		implicitSessionName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		implicitSessionCwd = ctx.cwd;
	});

	pi.on("session_shutdown", async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), IMPLICIT_SESSION_CLOSE_TIMEOUT_MS);
		try {
			await runAgentBrowserProcess({
				args: ["--session", implicitSessionName, "close"],
				cwd: implicitSessionCwd,
				signal: controller.signal,
			});
		} catch {
			// Best-effort cleanup only.
		} finally {
			clearTimeout(timer);
		}
	});

	pi.on("before_agent_start", async (event) => {
		allowLegacyAgentBrowserBash = shouldAllowLegacyAgentBrowserBash(event.prompt);
		allowAgentBrowserInspection = shouldAllowAgentBrowserInspection(event.prompt);
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nProject rule: when browser automation is needed, prefer the native `agent_browser` tool. Ignore legacy bash-based `agent-browser` skills by default. Do not read `~/.agents/skills/agent-browser/SKILL.md` and do not run direct `agent-browser` bash commands unless the user explicitly asks to inspect or discuss that legacy skill or bash workflow.\n\nBrowser operating playbook:\n- Standard workflow: open the page, then snapshot -i, then interact via refs, then re-snapshot after navigation or major DOM changes.\n- For user-specific or authenticated content like feeds, inboxes, dashboards, and accounts, start with an authenticated browser strategy instead of public browsing. Prefer `--profile Default` on the first browser call and let the current implicit session carry continuity. Use `--auto-connect` only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.\n- Do not invent fixed explicit session names like `twitter-feed` for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.\n- When using startup-scoped flags like `--profile`, `--session-name`, or `--cdp`, put them on the first command for that session. If you intentionally use an explicit `--session`, keep using that same explicit session for follow-ups.\n- If a profile-backed session lands on the wrong page or tab, use `tab list`, `tab <n>`, and `snapshot -i`. Only use `wait` with an explicit argument like milliseconds, `--load`, `--url`, `--fn`, or `--text`.\n- If an authenticated `open` returns a blocked-navigation or blank-title result, inspect the current tabs before changing strategies.\n- For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.\n- If the user only wants the first item from a feed or timeline, prefer reading it directly from the current snapshot. Do not click into media or a detail route unless the snapshot lacks the needed text.\n- Do not use `agent_browser --help` for normal browsing tasks.",
		};
	});

	pi.on("tool_call", async (event) => {
		if (
			isToolCallEventType("bash", event) &&
			!allowLegacyAgentBrowserBash &&
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
		promptGuidelines: [
			"Use this tool whenever the task requires a real browser or live web content.",
			"Standard workflow: open the page, snapshot -i, interact using refs, and re-snapshot after navigation or major DOM changes.",
			"For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.",
			"Do not invent fixed explicit session names like twitter-feed for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.",
			"When using --profile, --session-name, or --cdp, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.",
			"If a profile-backed session lands on the wrong page or tab, use tab list / tab <n> / snapshot -i. Only use wait with an explicit argument like milliseconds, --load, --url, --fn, or --text.",
			"If an authenticated open returns a blocked-navigation or blank-title result, inspect the current tabs before changing strategies.",
			"For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.",
			"If the user only wants the first item from a feed or timeline, prefer reading it directly from the current snapshot. Do not click into media or a detail route unless the snapshot lacks the needed text.",
			"Prefer this tool over bash for opening sites, reading docs on the web, clicking, filling, screenshots, eval, and batch workflows.",
			"Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.",
			"Do not fall back to osascript, AppleScript, or generic browser-driving bash commands when this tool can do the job.",
			"Pass exact agent-browser CLI arguments in args, excluding the binary name.",
			"Use stdin for commands like eval --stdin and batch instead of shell heredocs.",
			"Let the implicit session handle the common path unless you explicitly need upstream flags like --session, --profile, or --cdp.",
		],
		parameters: AGENT_BROWSER_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!allowAgentBrowserInspection && isPlainTextInspectionArgs(params.args)) {
				const errorText = buildInspectionDeflectionMessage();
				return {
					content: [{ type: "text", text: errorText }],
					details: { args: params.args, inspectionBlocked: true },
					isError: true,
				};
			}

			const validationError = validateToolArgs(params.args);
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: { args: params.args, validationError },
					isError: true,
				};
			}

			const executionPlan = buildExecutionPlan(params.args, {
				implicitSessionName,
				useActiveSession: params.useActiveSession ?? true,
			});

			onUpdate?.({
				content: [{ type: "text", text: `Running agent-browser ${buildInvocationPreview(executionPlan.effectiveArgs)}` }],
				details: {
					effectiveArgs: executionPlan.effectiveArgs,
					sessionName: executionPlan.sessionName,
					usedImplicitSession: executionPlan.usedImplicitSession,
				},
			});

			const processResult = await runAgentBrowserProcess({
				args: executionPlan.effectiveArgs,
				cwd: ctx.cwd,
				env: executionPlan.usedImplicitSession
					? { AGENT_BROWSER_IDLE_TIMEOUT_MS: IMPLICIT_SESSION_IDLE_TIMEOUT_MS }
					: undefined,
				signal,
				stdin: params.stdin,
			});

			if (processResult.spawnError?.message.includes("ENOENT")) {
				const errorText = buildMissingBinaryMessage();
				return {
					content: [{ type: "text", text: errorText }],
					details: {
						args: params.args,
						effectiveArgs: executionPlan.effectiveArgs,
						spawnError: processResult.spawnError.message,
					},
					isError: true,
				};
			}

			const parsed = parseAgentBrowserEnvelope(processResult.stdout);
			const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
			const plainTextInspection = isPlainTextInspectionArgs(params.args) && processSucceeded && parsed.parseError !== undefined;
			const envelopeSuccess = plainTextInspection ? true : parsed.envelope?.success !== false;
			const parseSucceeded = plainTextInspection || parsed.parseError === undefined;
			const succeeded = processSucceeded && parseSucceeded && envelopeSuccess;

			const errorText = (() => {
				if (plainTextInspection) return undefined;
				if (parsed.parseError) return parsed.parseError;
				if (processResult.aborted) return "agent-browser was aborted.";
				if (processResult.spawnError) return processResult.spawnError.message;
				if (processResult.exitCode !== 0) {
					return processResult.stderr.trim() || `agent-browser exited with code ${processResult.exitCode}.`;
				}
				if (parsed.envelope?.success === false) {
					return typeof parsed.envelope.error === "string"
						? parsed.envelope.error
						: JSON.stringify(parsed.envelope.error, null, 2);
				}
				return undefined;
			})();

			const presentation = plainTextInspection
				? {
					content: [{ type: "text" as const, text: processResult.stdout.trim() }],
					imagePath: undefined,
					summary: `${params.args.join(" ")} completed`,
				  }
				: await buildToolPresentation({
						commandInfo: executionPlan.commandInfo,
						cwd: ctx.cwd,
						envelope: parsed.envelope,
						errorText,
				  });

			return {
				content: presentation.content,
				details: {
					args: params.args,
					command: executionPlan.commandInfo.command,
					subcommand: executionPlan.commandInfo.subcommand,
					data: parsed.envelope?.data,
					error: parsed.envelope?.error,
					effectiveArgs: executionPlan.effectiveArgs,
					exitCode: processResult.exitCode,
					imagePath: presentation.imagePath,
					parseError: parsed.parseError,
					sessionName: executionPlan.sessionName,
					stderr: processResult.stderr || undefined,
					stdout: parseSucceeded ? undefined : processResult.stdout,
					summary: presentation.summary,
					usedImplicitSession: executionPlan.usedImplicitSession,
				},
				isError: !succeeded,
			};
		},
	});
}
