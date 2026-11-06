import { randomUUID } from "node:crypto";
import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	appendBrowserTransition,
	artifactChanges,
	type BrowserRecord,
} from "../browser-transcript.js";
import {
	appendBrowserRecord,
	hasPublishedBrowserJournal,
	type BrowserBranch,
} from "../browser-journal.js";
import { isPlainTextInspectionArgs } from "../runtime.js";
import { isBooleanFlagEnabled } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import { mergeBrowserRunArtifactManifest } from "./browser-run/artifact-merge.js";
import type { AgentBrowserCodeParams } from "../input-modes/params.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import { getPersistentSessionArtifactStore } from "./browser-run/session-state.js";
import type { AgentBrowserExecuteParams } from "./input-plan.js";
import { isSessionArtifactManifest } from "../results/artifact-manifest.js";
import { renderAgentBrowserObservation } from "../results/presentation/large-output.js";
import type { SessionArtifactManifest } from "../results/contracts.js";
import { invocationArtifactManifest } from "./extension-result-state.js";
import type { ObservationResources } from "./extension-artifacts.js";

type ObservationParams = AgentBrowserExecuteParams | Readonly<AgentBrowserCodeParams>;
interface Observation {
	readonly result: AgentToolResult<unknown>;
	readonly details: Readonly<Record<string, unknown>>;
	readonly priorManifest: SessionArtifactManifest | undefined;
	readonly renderedManifest: SessionArtifactManifest | undefined;
}
interface ObservationContext {
	readonly ctx: ExtensionContext;
	readonly branch: Readonly<BrowserBranch>;
}
function observationDetails(result: AgentToolResult<unknown>): Record<string, unknown> {
	const details = isRecord(result.details) ? result.details : {};
	if (result.isError === true && details.error === undefined) {
		details.error =
			details.validationError ??
			details.summary ??
			result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
	}
	return details;
}
function observedResult(
	observation: Observation,
	manifest?: { readonly value: SessionArtifactManifest | undefined },
): AgentBrowserToolResult {
	return {
		...observation.result,
		details: {
			...observation.details,
			browserEventVersion: 1,
			...(manifest ? { artifactManifest: manifest.value } : {}),
		},
	};
}
class ObservationPublication {
	constructor(
		readonly resources: ObservationResources,
		readonly context: ObservationContext,
	) {}
	async render(result: AgentToolResult<unknown>, params: ObservationParams): Promise<Observation> {
		const details = observationDetails(result);
		const priorManifest = isSessionArtifactManifest(details.artifactManifest)
			? details.artifactManifest
			: undefined;
		const renderOptions = {
			content: result.content,
			details,
			json: "code" in params || isBooleanFlagEnabled([...(params.args ?? [])], "--json"),
			succeeded: result.isError !== true,
			persistentArtifactStore: this.context.branch.isCurrent()
				? getPersistentSessionArtifactStore(this.context.ctx)
				: undefined,
			withArtifactWrite: <T>(write: () => Promise<T>) =>
				this.resources.queue.run(() => {
					if (!this.context.branch.isCurrent()) {
						renderOptions.persistentArtifactStore = undefined;
					}
					return write();
				}),
		};
		const rendered = await renderAgentBrowserObservation(renderOptions);
		return {
			result: {
				...result,
				content: rendered.content,
				structuredContent: rendered.structuredContent,
			},
			details,
			priorManifest,
			renderedManifest: rendered.artifactManifest,
		};
	}
	async persistChanges(
		observation: Observation,
		changes: ReturnType<typeof artifactChanges>,
	): Promise<boolean> {
		const { ctx, branch } = this.context;
		if (!changes || !hasPublishedBrowserJournal(ctx.sessionManager)) {
			return true;
		}
		const record: BrowserRecord = {
			event: {
				version: 1,
				phase: "state",
				operationId: randomUUID(),
				toolCallId: "observation",
				commandIndex: 0,
				isError: observation.result.isError === true,
				state: {},
				artifacts: changes,
			},
		};
		return (
			(await appendBrowserRecord(
				ctx.sessionManager,
				() => appendBrowserTransition(this.resources.pi, record),
				record,
				branch,
			)) && branch.isCurrent()
		);
	}
	async publish(observation: Observation): Promise<AgentBrowserToolResult> {
		if (!this.context.branch.isCurrent()) {
			return observedResult(observation, { value: observation.renderedManifest });
		}
		const before = this.resources.manifest;
		const merged = mergeBrowserRunArtifactManifest(
			before,
			observation.priorManifest,
			observation.renderedManifest,
		);
		if (!(await this.persistChanges(observation, artifactChanges(before, merged)))) {
			return observedResult(observation, { value: observation.renderedManifest });
		}
		this.resources.commit(observation.priorManifest, observation.renderedManifest);
		return observedResult(observation, {
			value: invocationArtifactManifest(
				this.resources.manifest,
				before,
				observation.details,
				observation.priorManifest,
			),
		});
	}
	async run(
		result: AgentToolResult<unknown>,
		params: ObservationParams,
	): Promise<AgentBrowserToolResult> {
		if ("args" in params && isPlainTextInspectionArgs([...params.args])) {
			return result;
		}
		const observation = await this.render(result, params);
		if (!observation.priorManifest && !observation.renderedManifest) {
			return observedResult(observation);
		}
		return this.resources.queue.run(() => this.publish(observation));
	}
}
export function finalizeObservation(
	resources: ObservationResources,
	result: AgentToolResult<unknown>,
	params: ObservationParams,
	context: ObservationContext,
): Promise<AgentBrowserToolResult> {
	return new ObservationPublication(resources, context).run(result, params);
}
