import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { isCloseCommand } from "../../command-taxonomy.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";
import type { PromptPolicy, PromptRequestedArtifact } from "../../prompt-policy.js";
import type { SessionRefSnapshot } from "../../session-page-state.js";
import { findBlockedFinalizingAction, STOP_BOUNDARY_GUARD_SCOPE, type BrowserFinalizingAction } from "./browser-action-model.js";

export interface StopBoundaryViolation {
	action: BrowserFinalizingAction;
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

function formatStopBoundaryActionPhrase(action: BrowserFinalizingAction): string {
	if (action.kind === "keyboard-submit") return "keyboard submit (Enter/Return)";
	return "click-like action";
}

export function findStopBoundaryViolation(options: { commandTokens: string[]; promptPolicy: PromptPolicy; refSnapshot?: SessionRefSnapshot; stdin?: string }): StopBoundaryViolation | undefined {
	if (!options.promptPolicy.stopBoundary) return undefined;
	const blocked = findBlockedFinalizingAction({
		commandTokens: options.commandTokens,
		refSnapshot: options.refSnapshot,
		stdin: options.stdin,
	});
	if (!blocked) return undefined;
	const target = blocked.targetLabel;
	const actionPhrase = formatStopBoundaryActionPhrase(blocked);
	const scopeNote = `Best-effort guard scope covers ${STOP_BOUNDARY_GUARD_SCOPE.covered.join(", ")}; it does not block ${STOP_BOUNDARY_GUARD_SCOPE.excluded.join(", ")}.`;
	if (blocked.stepIndex === undefined) {
		return {
			action: blocked,
			command: blocked.command,
			message: `Blocked likely final submit/order ${actionPhrase} (${target}) because the latest user prompt set an explicit stop boundary. Gather evidence on the current page instead of activating the final action. ${scopeNote}`,
			reason: "explicit-user-stop-boundary",
			target,
		};
	}
	return {
		action: blocked,
		command: blocked.command,
		message: `Blocked likely final submit/order ${actionPhrase} in batch step ${blocked.stepIndex + 1} (${target}) because the latest user prompt set an explicit stop boundary. Gather evidence on the current page instead of activating the final action. ${scopeNote}`,
		reason: "explicit-user-stop-boundary",
		stepIndex: blocked.stepIndex,
		target,
	};
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
