import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	createAgentBrowserScriptCloseArgs,
	isAgentBrowserScriptSessionName,
	type AgentBrowserScriptRunResult,
} from "../input-modes/script.js";
import { isRecord } from "../parsing.js";
import { appendBrowserTransition, getBrowserRecord } from "../browser-transcript.js";
import { redactSensitiveText } from "../runtime.js";
import type {
	ProjectedAgentBrowserObservation,
	AgentBrowserFailureCategory,
	ImageObservation,
	ToolPresentation,
} from "../results/contracts.js";
import { attachInlineImage } from "../results/presentation/artifacts.js";
import { projectAgentBrowserObservation } from "../results/presentation/content.js";
import { redactPresentationData } from "../results/presentation/diagnostic-redaction.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import {
	collectCodeArtifactReceipts,
	collectCodeFileArtifacts,
	type CodeArtifactReceipt,
	type CodeFileArtifact,
} from "./code-artifact-observation.js";
import { parseCodeImageObservation } from "./code-image-observation.js";

interface BrowserCodeObservation extends ProjectedAgentBrowserObservation {
	readonly imageObservations?: readonly ImageObservation[] | undefined;
}

type ScriptSessionCleanupState = "active" | "closed" | "failed";

export interface ScriptSessionLease {
	ownerSessionId?: string | undefined;
	cleanup: ScriptSessionCleanupState;
	closeCommandArgs: string[];
	launchAttempted: true;
	sessionName: string;
}

// The offline converter retains outstanding isolated-session cleanup facts in canonical events.
export function getScriptSessionLeasesFromBranch(
	branch: readonly unknown[],
	ownerSessionId?: string,
): Map<string, ScriptSessionLease> {
	const leases = new Map<string, ScriptSessionLease>();
	for (const entry of branch) {
		const lease = parseScriptLease(
			getBrowserRecord(entry)?.event.state.scriptLease,
			ownerSessionId,
		);
		if (lease !== undefined) {
			leases.set(lease.sessionName, lease);
		}
	}
	return leases;
}

function parseScriptLease(
	value: unknown,
	ownerSessionId: string | undefined,
): ScriptSessionLease | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (ownerSessionId !== undefined && value.ownerSessionId !== ownerSessionId) {
		return undefined;
	}
	const { closeCommandArgs, launchAttempted, sessionName } = value;
	const cleanup = (["active", "closed", "failed"] as const).find(
		(state) => state === value.cleanup,
	);
	if (!isAgentBrowserScriptSessionName(sessionName)) {
		return undefined;
	}
	if (cleanup === undefined) {
		return undefined;
	}
	const expected = createAgentBrowserScriptCloseArgs(sessionName);
	if (launchAttempted !== true || !matchesCloseCommand(closeCommandArgs, expected)) {
		return undefined;
	}
	return {
		cleanup,
		closeCommandArgs: expected,
		launchAttempted: true,
		sessionName,
		ownerSessionId: typeof value.ownerSessionId === "string" ? value.ownerSessionId : undefined,
	};
}

function matchesCloseCommand(value: unknown, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((token, index) => token === expected[index])
	);
}

export function appendScriptSessionLease(
	pi: ExtensionAPI,
	sessionName: string,
	cleanup: ScriptSessionCleanupState,
	ownerSessionId: string,
): void {
	appendBrowserTransition(pi, {
		event: {
			version: 1,
			phase: "state",
			operationId: randomUUID(),
			toolCallId: "cleanup",
			commandIndex: 0,
			isError: cleanup !== "closed",
			state: {
				scriptLease: {
					cleanup,
					closeCommandArgs: createAgentBrowserScriptCloseArgs(sessionName),
					launchAttempted: true,
					sessionName,
					ownerSessionId,
				},
			},
		},
	});
}

class BrowserCodeOutput {
	private readonly images = new Map<
		string,
		{ observation: ImageObservation; size: number; mtime: number }
	>();
	private readonly selected = new Map<
		string,
		{ content: AgentBrowserToolResult["content"]; observation: ImageObservation }
	>();
	private readonly receipts = new Map<string, CodeArtifactReceipt>();
	private readonly fileArtifacts = new Map<string, CodeFileArtifact>();
	private selectedBytes = 0;

	readonly observe = async (result: AgentBrowserToolResult): Promise<BrowserCodeObservation> => {
		const details = isRecord(result.details) ? result.details : {};
		const observation = projectAgentBrowserObservation(details, result.isError !== true);
		for (const entry of collectCodeArtifactReceipts(observation.artifactVerification)) {
			this.receipts.set(entry.absolutePath ?? entry.path, entry);
		}
		for (const artifact of collectCodeFileArtifacts(observation.artifacts)) {
			this.fileArtifacts.set(artifact.absolutePath, artifact);
		}
		if (observation.imageObservations === undefined) {
			return { ...observation, imageObservations: undefined };
		}
		if (!Array.isArray(observation.imageObservations)) {
			throw new Error("Browser capture returned invalid image observations.");
		}
		const images = await Promise.all(
			observation.imageObservations.map(async (value: unknown) => {
				const image = parseCodeImageObservation(value);
				if (image === undefined) {
					throw new Error("Browser capture returned invalid image observation geometry.");
				}
				const file = await stat(image.path);
				const id = `image-${this.images.size + 1}`;
				this.images.set(id, { observation: image, size: file.size, mtime: file.mtimeMs });
				return { ...image, id };
			}),
		);
		return { ...observation, imageObservations: images };
	};

	private resolveImage(value: unknown): {
		id: string;
		image: { observation: ImageObservation; size: number; mtime: number };
	} {
		const id = isRecord(value) && typeof value.id === "string" ? value.id : undefined;
		const image = id !== undefined && id.length > 0 ? this.images.get(id) : undefined;
		if (id === undefined || id.length === 0 || !image) {
			throw new Error(
				"emitImage expects an imageObservations handle returned by browser() in this code call.",
			);
		}
		return { id, image };
	}

	readonly emitImage = async (value: unknown): Promise<void> => {
		const { id, image } = this.resolveImage(value);
		if (this.selected.has(id)) {
			return;
		}
		if (this.selected.size >= 8 || this.selectedBytes + image.size > 20 * 1_024 * 1_024) {
			throw new Error(
				"Selected images exceed the code output limit (8 images / 20 MiB). Emit fewer images.",
			);
		}
		const file = await stat(image.observation.path);
		if (!file.isFile() || file.size !== image.size || file.mtimeMs !== image.mtime) {
			throw new Error(
				"The selected image changed since capture. Capture it again before emitting it.",
			);
		}
		const presentation: ToolPresentation = { content: [], summary: "Selected browser image" };
		Object.assign(presentation, await attachInlineImage(presentation, image.observation.path));
		if (!presentation.content.some((item) => item.type === "image")) {
			const reason = presentation.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			throw new Error(reason.length > 0 ? reason : "The selected image could not be attached.");
		}
		this.selected.set(id, {
			content: presentation.content.filter((item) => item.type === "image"),
			observation: { ...image.observation, id },
		});
		this.selectedBytes += file.size;
	};

	private artifactVerification(): Readonly<Record<string, unknown>> | undefined {
		const artifacts = [...this.receipts.values()];
		if (artifacts.length === 0) {
			return undefined;
		}
		const count = (state: string) => artifacts.filter((entry) => entry.state === state).length;
		return {
			artifacts,
			missingCount: count("missing"),
			pendingCount: count("pending"),
			unverifiedCount: count("unverified"),
			verifiedCount: count("verified"),
			verified: artifacts.every((entry) => entry.state === "verified"),
		};
	}

	private failureCategory(
		run: AgentBrowserScriptRunResult,
		outputError: string | undefined,
	): AgentBrowserFailureCategory | undefined {
		if (outputError !== undefined) {
			return "validation-error";
		}
		return run.failureCategory ?? (run.rejectedCallCount > 0 ? "validation-error" : undefined);
	}

	private observation(
		run: AgentBrowserScriptRunResult,
		context: { readonly sessionName: string; readonly namespace?: string | undefined },
		output: { readonly data: unknown; readonly error?: string | undefined },
	): Record<string, unknown> {
		const failureCategory = this.failureCategory(run, output.error);
		const success = run.ok && failureCategory === undefined;
		return {
			success,
			resultCategory: success ? "success" : "failure",
			failureCategory,
			data: output.data,
			error:
				output.error ??
				(run.error !== undefined && run.error.length > 0
					? redactSensitiveText(run.error)
					: undefined),
			...context,
			codeRun: {
				callCount: run.callCount,
				emitCount: run.emitCount,
				failedCallCount: run.steps.filter((step) => !step.ok).length,
				rejectedCallCount: run.rejectedCallCount,
				aborted: run.aborted,
				timedOut: run.timedOut,
			},
			failures: run.failures !== undefined && run.failures.length > 0 ? run.failures : undefined,
			artifactVerification: this.artifactVerification(),
			artifacts: this.fileArtifacts.size > 0 ? [...this.fileArtifacts.values()] : undefined,
			imageObservations: [...this.selected.values()].map((image) => image.observation),
		};
	}

	readonly finish = async (
		run: AgentBrowserScriptRunResult,
		sessionName: string,
		namespace?: string,
	): Promise<AgentBrowserToolResult> => {
		let data: unknown;
		let error: string | undefined;
		try {
			data = redactPresentationData({ command: "code" }, run.data);
			if (
				data !== undefined &&
				Buffer.byteLength(JSON.stringify(data), "utf8") >
					AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES
			) {
				throw new Error("oversized");
			}
		} catch {
			data = undefined;
			error = "Code output could not be rendered as bounded JSON.";
		}
		const observation = this.observation(run, { sessionName, namespace }, { data, error });
		const success = observation.success === true;
		const summary = success
			? `Browser code completed (${run.callCount} calls).`
			: "Browser code failed.";
		return {
			content: [...this.selected.values()].flatMap((image) => image.content),
			details: { ...observation, codeSteps: run.steps, summary },
			isError: !success,
		};
	};
}

export function createBrowserCodeOutput(): BrowserCodeOutput {
	return new BrowserCodeOutput();
}
