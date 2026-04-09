/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage implicit session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest or the local `.pi/extensions/agent-browser.ts` development entrypoint.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { fileURLToPath } from "node:url";

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

function looksLikeDirectAgentBrowserBash(command: string): boolean {
	return /(^|[\s;&|])(npx\s+)?agent-browser(\s|$)/.test(command);
}

function isHarmlessAgentBrowserInspectionCommand(command: string): boolean {
	return /(command\s+-v|which)\s+agent-browser\b/.test(command) || /(^|\s)agent-browser\s+--(help|version)\b/.test(command);
}

function isLegacyAgentBrowserSkillPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return normalized.endsWith("/.agents/skills/agent-browser/SKILL.md");
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const bundledSkillPath = fileURLToPath(new URL("../../skills/agent-browser/SKILL.md", import.meta.url));
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	let allowLegacyAgentBrowserBash = false;
	let implicitSessionName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);

	pi.on("session_start", async (_event, ctx) => {
		implicitSessionName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
	});

	pi.on("before_agent_start", async (event) => {
		allowLegacyAgentBrowserBash = shouldAllowLegacyAgentBrowserBash(event.prompt);
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nProject rule: when browser automation is needed, prefer the native `agent_browser` tool. Ignore legacy bash-based `agent-browser` skills by default. Do not read `~/.agents/skills/agent-browser/SKILL.md` and do not run direct `agent-browser` bash commands unless the user explicitly asks to inspect or discuss that legacy skill or bash workflow.",
		};
	});

	pi.on("tool_call", async (event) => {
		if (isToolCallEventType("read", event) && isLegacyAgentBrowserSkillPath(event.input.path)) {
			event.input.path = bundledSkillPath;
			return;
		}

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
			"Run exact agent-browser CLI arguments without bash. The wrapper injects --json automatically, supports optional stdin, and can reuse an implicit browser session for the current pi session.",
		promptSnippet:
			"Run exact agent-browser CLI arguments without shell quoting, with optional stdin support and automatic JSON parsing.",
		promptGuidelines: [
			"Use this tool instead of bash when driving agent-browser.",
			"Pass exact agent-browser CLI arguments in args, excluding the binary name.",
			"Use stdin for commands like eval --stdin and batch instead of shell heredocs.",
			"Let the implicit session handle the common path unless you explicitly need upstream flags like --session, --profile, or --cdp.",
		],
		parameters: AGENT_BROWSER_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
			const envelopeSuccess = parsed.envelope?.success !== false;
			const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
			const parseSucceeded = parsed.parseError === undefined;
			const succeeded = processSucceeded && parseSucceeded && envelopeSuccess;

			const errorText = (() => {
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

			const presentation = await buildToolPresentation({
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
