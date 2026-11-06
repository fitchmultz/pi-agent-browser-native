import { isAbsolute, resolve } from "node:path";

import { isCloseCommand } from "../../command-taxonomy.js";
import { executableExistsOnPath } from "../../executable-path.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";
import type { PromptRequestedArtifact } from "../../prompt-policy.js";

export interface RequestedArtifactCloseViolation {
	readonly message: string;
	readonly missingArtifacts: readonly PromptRequestedArtifact[];
	readonly reason: "requested-artifacts-missing-before-close";
}

function resolveArtifactPath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function manifestContainsArtifact(
	manifest: SessionArtifactManifest | undefined,
	cwd: string,
	artifact: Readonly<PromptRequestedArtifact>,
): boolean {
	if (!manifest) {
		return false;
	}
	const requestedAbsolutePath = resolveArtifactPath(cwd, artifact.path);
	const expectedKind = artifact.kind === "screenshot" ? "image" : "video";
	return manifest.entries.some((entry) => {
		const entryAbsolutePath = entry.absolutePath ?? resolveArtifactPath(cwd, entry.path);
		return (
			entry.storageScope === "explicit-path" &&
			entry.kind === expectedKind &&
			entryAbsolutePath === requestedAbsolutePath &&
			entry.retentionState === "live" &&
			entry.exists === true
		);
	});
}

async function isArtifactRequired(artifact: Readonly<PromptRequestedArtifact>): Promise<boolean> {
	if (artifact.required) {
		return true;
	}
	return artifact.kind === "recording" && (await executableExistsOnPath("ffmpeg"));
}

export async function findRequestedArtifactCloseViolation(options: {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly command: string | undefined;
	readonly cwd: string;
	readonly promptPolicy: {
		readonly requestedArtifacts: readonly Readonly<PromptRequestedArtifact>[];
	};
}): Promise<RequestedArtifactCloseViolation | undefined> {
	if (!isCloseCommand(options.command)) {
		return undefined;
	}
	const requirements = await Promise.all(
		options.promptPolicy.requestedArtifacts.map(async (artifact) => ({
			artifact,
			required: await isArtifactRequired(artifact),
		})),
	);
	const missingArtifacts = requirements
		.filter(
			({ artifact, required }) =>
				required && !manifestContainsArtifact(options.artifactManifest, options.cwd, artifact),
		)
		.map(({ artifact }) => artifact);
	if (missingArtifacts.length === 0) {
		return undefined;
	}
	const missingList = missingArtifacts
		.map((artifact) => `${artifact.kind}: ${artifact.path}`)
		.join(", ");
	return {
		message: `Blocked browser close because requested artifact path${missingArtifacts.length === 1 ? " is" : "s are"} missing or unverified: ${missingList}. Save the requested artifact path first, or report why an optional artifact is unavailable before closing.`,
		missingArtifacts,
		reason: "requested-artifacts-missing-before-close",
	};
}
