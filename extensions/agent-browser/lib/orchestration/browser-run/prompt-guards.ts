import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { isCloseCommand } from "../../command-taxonomy.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";
import type { PromptPolicy, PromptRequestedArtifact } from "../../runtime.js";
import type { SessionRefSnapshot } from "../../session-page-state.js";
import type { BatchCommandStep } from "./types.js";

const FINAL_ACTION_PATTERN = /\b(?:finish|place\s+(?:the\s+)?order|submit\s+(?:the\s+)?order|complete\s+(?:the\s+)?order|confirm\s+(?:the\s+)?order|purchase|buy\s+now|pay\s+now|finali[sz]e|submit\s+payment|checkout\s+complete)\b/i;

export interface StopBoundaryViolation {
	command: string[];
	message: string;
	reason: "explicit-user-stop-boundary";
	stepIndex?: number;
	target?: string;
}

export interface RequestedArtifactCloseViolation {
	message: string;
	missingArtifacts: PromptRequestedArtifact[];
	reason: "requested-artifacts-missing-before-close";
}

function normalizeTargetText(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/[\[\]{}()#.'\"=:/]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function matchesFinalActionTarget(value: string | undefined): boolean {
	return value !== undefined && FINAL_ACTION_PATTERN.test(normalizeTargetText(value));
}

function parseRefId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed.startsWith("ref=") ? trimmed.slice(4) : trimmed;
	return /^e\d+$/.test(candidate) ? candidate : undefined;
}

function getRefTargetText(refSnapshot: SessionRefSnapshot | undefined, refId: string | undefined): string | undefined {
	if (!refId) return undefined;
	const ref = refSnapshot?.refs?.[refId];
	return ref ? [ref.role, ref.name].filter(Boolean).join(" ") : undefined;
}

function getFlagValue(tokens: string[], flag: string): string | undefined {
	for (const [index, token] of tokens.entries()) {
		if (token === flag) return tokens[index + 1];
		if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
	}
	return undefined;
}

function getDirectClickTargetText(command: string[], refSnapshot: SessionRefSnapshot | undefined): string | undefined {
	const target = command[1];
	return getRefTargetText(refSnapshot, parseRefId(target)) ?? target;
}

function getFindClickTargetText(command: string[]): string | undefined {
	if (command[0] !== "find") return undefined;
	const actionIndex = command.findIndex((token, index) => index >= 3 && ["click", "dblclick", "tap"].includes(token));
	if (actionIndex === -1) return undefined;
	return getFlagValue(command, "--name") ?? command[2];
}

function getBlockedFinalActionTarget(command: string[], refSnapshot: SessionRefSnapshot | undefined): string | undefined {
	const directClickCommands = new Set(["click", "dblclick", "tap"]);
	const target = directClickCommands.has(command[0])
		? getDirectClickTargetText(command, refSnapshot)
		: getFindClickTargetText(command);
	return matchesFinalActionTarget(target) ? target : undefined;
}

function parseBatchSteps(stdin: string | undefined): BatchCommandStep[] {
	if (stdin === undefined) return [];
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((step): step is BatchCommandStep => Array.isArray(step) && step.length > 0 && step.every((token) => typeof token === "string"));
	} catch {
		return [];
	}
}

export function findStopBoundaryViolation(options: { commandTokens: string[]; promptPolicy: PromptPolicy; refSnapshot?: SessionRefSnapshot; stdin?: string }): StopBoundaryViolation | undefined {
	if (!options.promptPolicy.stopBoundary) return undefined;
	const target = getBlockedFinalActionTarget(options.commandTokens, options.refSnapshot);
	if (target) {
		return {
			command: options.commandTokens,
			message: `Blocked likely final submit/order action (${target}) because the latest user prompt set an explicit stop boundary. Gather evidence on the current page instead of clicking the final action.`,
			reason: "explicit-user-stop-boundary",
			target,
		};
	}
	if (options.commandTokens[0] !== "batch") return undefined;
	for (const [index, step] of parseBatchSteps(options.stdin).entries()) {
		const stepTarget = getBlockedFinalActionTarget(step, options.refSnapshot);
		if (!stepTarget) continue;
		return {
			command: step,
			message: `Blocked likely final submit/order action in batch step ${index + 1} (${stepTarget}) because the latest user prompt set an explicit stop boundary. Gather evidence on the current page instead of clicking the final action.`,
			reason: "explicit-user-stop-boundary",
			stepIndex: index,
			target: stepTarget,
		};
	}
	return undefined;
}

function resolveArtifactPath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function manifestContainsArtifact(manifest: SessionArtifactManifest | undefined, cwd: string, artifact: PromptRequestedArtifact): boolean {
	if (!manifest) return false;
	const requestedAbsolutePath = resolveArtifactPath(cwd, artifact.path);
	const expectedKind = artifact.kind === "screenshot" ? "image" : "video";
	return manifest.entries.some((entry) => {
		const entryAbsolutePath = entry.absolutePath ?? resolveArtifactPath(cwd, entry.path);
		return entry.storageScope === "explicit-path" && entry.kind === expectedKind && entryAbsolutePath === requestedAbsolutePath && entry.retentionState === "live" && entry.exists === true;
	});
}

async function executableExistsOnPath(command: string): Promise<boolean> {
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			try {
				const candidate = join(directory, `${command}${extension}`);
				await access(candidate, fsConstants.X_OK);
				if ((await stat(candidate)).isFile()) return true;
			} catch {
				// Try the next PATH candidate.
			}
		}
	}
	return false;
}

async function isArtifactRequired(artifact: PromptRequestedArtifact): Promise<boolean> {
	if (artifact.required) return true;
	return artifact.kind === "recording" && await executableExistsOnPath("ffmpeg");
}

export async function findRequestedArtifactCloseViolation(options: { artifactManifest?: SessionArtifactManifest; command: string | undefined; cwd: string; promptPolicy: PromptPolicy }): Promise<RequestedArtifactCloseViolation | undefined> {
	if (!isCloseCommand(options.command)) return undefined;
	const missingArtifacts: PromptRequestedArtifact[] = [];
	for (const artifact of options.promptPolicy.requestedArtifacts) {
		if (!await isArtifactRequired(artifact)) continue;
		if (!manifestContainsArtifact(options.artifactManifest, options.cwd, artifact)) missingArtifacts.push(artifact);
	}
	if (missingArtifacts.length === 0) return undefined;
	const missingList = missingArtifacts.map((artifact) => `${artifact.kind}: ${artifact.path}`).join(", ");
	return {
		message: `Blocked browser close because requested artifact path${missingArtifacts.length === 1 ? " is" : "s are"} missing or unverified: ${missingList}. Save the requested artifact path first, or report why an optional artifact is unavailable before closing.`,
		missingArtifacts,
		reason: "requested-artifacts-missing-before-close",
	};
}
