import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { isRecord, parsePositiveInteger } from "../../parsing.js";
import type { ImageObservation, ToolPresentation } from "../contracts.js";
import { LIGHTPANDA_IMAGE_REASON } from "./common.js";
import {
	type ArtifactCommand,
	getImageMimeType,
	isNonFileArtifactPathCandidate,
	readImageHeader,
} from "./artifact-files.js";
import { formatByteCount } from "./artifact-format.js";

const DEFAULT_INLINE_IMAGE_MAX_BYTES = 5 * 1_024 * 1_024;

function getInlineImageMaxBytes(env: Readonly<NodeJS.ProcessEnv> = process.env): number {
	return (
		parsePositiveInteger(env.PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES) ??
		DEFAULT_INLINE_IMAGE_MAX_BYTES
	);
}

export function appendPresentationNotice(presentation: ToolPresentation, message: string): void {
	const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
	presentation.content[0] = {
		type: "text",
		text: existingText.length > 0 ? `${existingText}\n\n${message}` : message,
	};
}

export function getScreenshotSummary(data: Readonly<Record<string, unknown>>): string | undefined {
	if (data.changed === false) {
		return "Screenshot unchanged; no image saved.";
	}
	return typeof data.path === "string" ? `Saved image: ${data.path}` : undefined;
}

export function extractImagePath(
	commandInfo: ArtifactCommand,
	cwd: string,
	data: unknown,
): string | undefined {
	if (commandInfo.command !== "screenshot") {
		return undefined;
	}
	let path: string | undefined;
	if (typeof data === "string") {
		path = data;
	} else if (isRecord(data) && typeof data.path === "string") {
		path = data.path;
	}
	return path !== undefined && path.trim().length > 0 && !isNonFileArtifactPathCandidate(path)
		? resolve(cwd, path)
		: undefined;
}

function isTextRendered(data: unknown): boolean {
	if (!isRecord(data) || !isRecord(data.lifecycle)) {
		return false;
	}
	return (
		isRecord(data.lifecycle.effectiveLaunch) &&
		data.lifecycle.effectiveLaunch.engine === "lightpanda"
	);
}

function buildImageObservation(
	imagePath: string,
	header: Buffer,
	mimeType: string,
	textRendered: boolean,
): ImageObservation {
	const dimensions = getImageDimensions(header.toString("base64"), mimeType);
	let reason = "Image dimensions could not be read from the bounded header.";
	if (dimensions) {
		reason = "Capture geometry was not observed.";
	}
	if (textRendered) {
		reason = LIGHTPANDA_IMAGE_REASON;
	}
	return {
		path: imagePath,
		mimeType,
		...(textRendered ? { rendering: "text" as const } : {}),
		pixels: dimensions ? { width: dimensions.widthPx, height: dimensions.heightPx } : undefined,
		capture: "unknown",
		geometry: { status: "unknown", reason },
	};
}

async function attachVisibleImage(
	presentation: ToolPresentation,
	options: {
		readonly imagePath: string;
		readonly size: number;
		readonly mimeType: string;
		readonly textRendered: boolean;
	},
): Promise<void> {
	if (options.textRendered) {
		appendPresentationNotice(presentation, LIGHTPANDA_IMAGE_REASON);
	}
	const limit = getInlineImageMaxBytes();
	if (options.size > limit) {
		appendPresentationNotice(
			presentation,
			`Image attachment skipped: ${formatByteCount(options.size)} exceeds the inline limit of ${formatByteCount(limit)}.`,
		);
		return;
	}
	const file = await readFile(options.imagePath);
	presentation.content.push({
		type: "image",
		data: file.toString("base64"),
		mimeType: options.mimeType,
	});
}

export async function attachInlineImage(
	presentation: ToolPresentation,
	imagePath: string,
	modelVisible = true,
): Promise<ToolPresentation> {
	try {
		const [fileStats, header] = await Promise.all([
			stat(imagePath),
			// Pi's dimension API accepts base64. Encode only a bounded header, never the whole code-mode image.
			readImageHeader(imagePath, 64 * 1024),
		]);
		const mimeType = getImageMimeType(header);
		if (mimeType === undefined) {
			return presentation;
		}
		const textRendered = isTextRendered(presentation.data);
		presentation.imagePath = imagePath;
		presentation.imageObservations = [
			buildImageObservation(imagePath, header, mimeType, textRendered),
		];
		if (modelVisible) {
			await attachVisibleImage(presentation, {
				imagePath,
				size: fileStats.size,
				mimeType,
				textRendered,
			});
		}
		return presentation;
	} catch (error) {
		const message = error instanceof Error ? error.message : inspect(error);
		appendPresentationNotice(presentation, `Image attachment failed: ${message}`);
		presentation.imagePath = imagePath;
		return presentation;
	}
}
