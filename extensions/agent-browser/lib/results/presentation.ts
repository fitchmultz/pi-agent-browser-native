import type { ToolPresentation } from "./contracts.js";
import type { BuildToolPresentationOptions } from "./presentation/input-contracts.js";
import {
	completePresentationOutput,
	extractPresentationArtifacts,
} from "./presentation/output-completion.js";

export async function buildToolPresentation(
	options: BuildToolPresentationOptions,
): Promise<ToolPresentation> {
	const { buildPresentationSource, buildSourcePresentation, resolvePresentationCommands } =
		await import("./presentation/source.js");
	const { buildEarlyPresentation, sanitizeModelFacingPresentation } =
		await import("./presentation/early-result.js");
	const { applyPresentationNotices } = await import("./presentation/notices.js");
	const { applyPresentationOutcome } = await import("./presentation/outcomes.js");
	const commands = resolvePresentationCommands(options);
	const early = await buildEarlyPresentation(options, commands);
	if (early) {
		return early;
	}
	const source = buildPresentationSource(options, commands);
	const artifacts = await extractPresentationArtifacts(options, source);
	const draft = await buildSourcePresentation(options, source, artifacts, buildToolPresentation);
	applyPresentationNotices(draft, options, source);
	const completed = await completePresentationOutput(draft, options, source, artifacts);
	applyPresentationOutcome(completed, options, source);
	return sanitizeModelFacingPresentation(completed);
}
