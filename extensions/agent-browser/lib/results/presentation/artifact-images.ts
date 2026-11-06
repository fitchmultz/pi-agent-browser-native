import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { isRecord, parsePositiveInteger } from "../../parsing.js";
import type { ImageObservation, ToolPresentation } from "../contracts.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";
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

export function appendPresentationNotice(
	content: ToolPresentationObservation["content"],
	message: string,
): ToolPresentation["content"] {
	const first = content.at(0);
	const existingText = first?.type === "text" ? first.text : "";
	return [
		{
			type: "text",
			text: existingText.length > 0 ? `${existingText}\n\n${message}` : message,
		},
		...content.slice(1),
	];
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

async function readInlineImage(options: {
	readonly imagePath: string;
	readonly size: number;
	readonly mimeType: string;
}): Promise<ToolPresentation["content"][number]> {
	const limit = getInlineImageMaxBytes();
	if (options.size > limit) {
		return {
			type: "text",
			text: `Image attachment skipped: ${formatByteCount(options.size)} exceeds the inline limit of ${formatByteCount(limit)}.`,
		};
	}
	const file = await readFile(options.imagePath);
	return { type: "image", data: file.toString("base64"), mimeType: options.mimeType };
}

export async function attachInlineImage(
	presentation: ToolPresentationObservation,
	imagePath: string,
	modelVisible = true,
): Promise<Partial<Pick<ToolPresentation, "content" | "imagePath" | "imageObservations">>> {
	const update: Partial<Pick<ToolPresentation, "content" | "imagePath" | "imageObservations">> = {};
	try {
		const [fileStats, header] = await Promise.all([
			stat(imagePath),
			// Pi's dimension API accepts base64. Encode only a bounded header, never the whole code-mode image.
			readImageHeader(imagePath, 64 * 1024),
		]);
		const mimeType = getImageMimeType(header);
		if (mimeType === undefined) {
			return update;
		}
		const textRendered = isTextRendered(presentation.data);
		update.imagePath = imagePath;
		update.imageObservations = [buildImageObservation(imagePath, header, mimeType, textRendered)];
		if (modelVisible) {
			if (textRendered) {
				update.content = appendPresentationNotice(presentation.content, LIGHTPANDA_IMAGE_REASON);
			}
			const inline = await readInlineImage({ imagePath, size: fileStats.size, mimeType });
			const content = update.content ?? presentation.content;
			update.content =
				inline.type === "text"
					? appendPresentationNotice(content, inline.text)
					: [...content, inline];
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : inspect(error);
		update.content = appendPresentationNotice(
			update.content ?? presentation.content,
			`Image attachment failed: ${message}`,
		);
		update.imagePath = imagePath;
	}
	return update;
}
