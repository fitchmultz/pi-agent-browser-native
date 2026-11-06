import { isRecord } from "../../parsing.js";
import type { ImageObservation, ScreenshotSample } from "../../results/contracts.js";
import { LIGHTPANDA_IMAGE_REASON } from "../../results/presentation/common.js";
import { getScreenshotCapture } from "./screenshot-capture.js";
export { getScreenshotCapture } from "./screenshot-capture.js";
import { runSessionCommandData } from "./session-state.js";

function finiteRecord<K extends string>(
	value: unknown,
	keys: readonly K[],
): value is Readonly<Record<K, number>> {
	return (
		isRecord(value) &&
		keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
	);
}

function parseSampleIdentity(
	sample: Readonly<Record<string, unknown>>,
): Pick<ScreenshotSample, "rendering" | "url" | "frame"> | undefined {
	if (
		(sample.rendering !== undefined && sample.rendering !== "text") ||
		typeof sample.url !== "string" ||
		(sample.frame !== "main" && sample.frame !== "child")
	) {
		return undefined;
	}
	return {
		url: sample.url,
		frame: sample.frame,
		...(sample.rendering === "text" ? { rendering: "text" } : {}),
	};
}

function parseSampleScale(
	sample: Readonly<Record<string, unknown>>,
): Pick<ScreenshotSample, "dpr" | "childFrameCount"> | undefined {
	if (
		typeof sample.childFrameCount !== "number" ||
		!Number.isInteger(sample.childFrameCount) ||
		sample.childFrameCount < 0 ||
		typeof sample.dpr !== "number" ||
		!Number.isFinite(sample.dpr) ||
		sample.dpr <= 0
	) {
		return undefined;
	}
	return { dpr: sample.dpr, childFrameCount: sample.childFrameCount };
}

function parseSampleMeasurements(
	value: Readonly<Record<string, unknown>>,
):
	| Pick<ScreenshotSample, "viewport" | "document" | "scroll" | "visualViewport" | "element">
	| undefined {
	if (
		!finiteRecord(value.viewport, ["width", "height"]) ||
		!finiteRecord(value.document, ["width", "height"]) ||
		!finiteRecord(value.scroll, ["x", "y"]) ||
		!finiteRecord(value.visualViewport, ["x", "y", "scale"])
	) {
		return undefined;
	}
	if (value.element !== undefined && !finiteRecord(value.element, ["x", "y", "width", "height"])) {
		return undefined;
	}
	return {
		viewport: value.viewport,
		document: value.document,
		scroll: value.scroll,
		visualViewport: value.visualViewport,
		...(value.element !== undefined ? { element: value.element } : {}),
	};
}

function parseScreenshotSample(value: unknown): ScreenshotSample | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const identity = parseSampleIdentity(value);
	const scale = parseSampleScale(value);
	const measurements = parseSampleMeasurements(value);
	return identity && scale && measurements
		? { ...value, ...identity, ...scale, ...measurements }
		: undefined;
}

export async function collectScreenshotSample(options: {
	readonly command: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
	readonly namespace?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<ScreenshotSample | undefined> {
	if (options.command[0] !== "screenshot" || options.signal?.aborted === true) {
		return undefined;
	}
	const { selector } = getScreenshotCapture(options.command);
	const script = `(() => {
		const root = document.documentElement, body = document.body, v = window.visualViewport;
		let element;
		try {
			const selector = ${JSON.stringify(selector ?? null)};
			const matches = selector ? document.querySelectorAll(selector) : [];
			if (matches.length === 1) {
				const rect = matches[0].getBoundingClientRect();
				element = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			}
		} catch {}
		const textRendered = navigator.userAgentData?.brands?.some(b => b.brand === "Lightpanda") || /\\bLightpanda\\//i.test(navigator.userAgent);
		return { ...(textRendered ? { rendering: "text" } : {}), url: location.href, frame: window === window.top ? "main" : "child", childFrameCount: window.frames.length,
			viewport: { width: innerWidth, height: innerHeight },
			document: { width: Math.max(root.scrollWidth, body?.scrollWidth || 0, innerWidth), height: Math.max(root.scrollHeight, body?.scrollHeight || 0, innerHeight) },
			scroll: { x: scrollX, y: scrollY }, dpr: devicePixelRatio,
			visualViewport: { x: v?.offsetLeft ?? 0, y: v?.offsetTop ?? 0, scale: v?.scale ?? 1 }, element };
	})()`;
	try {
		const data = await runSessionCommandData({
			...options,
			args: ["eval", "--stdin"],
			stdin: script,
			timeoutMs: 2_000,
		});
		return parseScreenshotSample(isRecord(data) ? data.result : undefined);
	} catch {
		return undefined;
	}
}

type ScreenshotCrop = NonNullable<ImageObservation["geometry"]["crop"]>;

function getMeasuredCrop(
	capture: ImageObservation["capture"],
	before: ScreenshotSample,
): ScreenshotCrop | undefined {
	if (capture === "viewport") {
		return { ...before.scroll, ...before.viewport };
	}
	if (capture === "full-page") {
		return { x: 0, y: 0, ...before.document };
	}
	if (
		capture === "element" &&
		before.element &&
		before.childFrameCount === 0 &&
		before.scroll.x === 0 &&
		before.scroll.y === 0
	) {
		return before.element;
	}
	return undefined;
}

function pixelsMatchCrop(
	crop: ScreenshotCrop,
	pixels: NonNullable<ImageObservation["pixels"]>,
	dpr: number,
): boolean {
	return (
		crop.width > 0 &&
		crop.height > 0 &&
		crop.x >= 0 &&
		crop.y >= 0 &&
		Object.values(crop).every(Number.isInteger) &&
		pixels.width === crop.width * dpr &&
		pixels.height === crop.height * dpr
	);
}

interface ScreenshotGeometryOptions {
	readonly rendering?: ImageObservation["rendering"];
	readonly capture: ImageObservation["capture"];
	readonly pixels: ImageObservation["pixels"];
	readonly before?: ScreenshotSample | undefined;
	readonly after?: ScreenshotSample | undefined;
}

function sampleFrameFailure(before: ScreenshotSample): string | undefined {
	if (before.frame !== "main") {
		return "Probe observed a child frame; its relation to the captured page is unknown.";
	}
	if (
		before.visualViewport.scale !== 1 ||
		before.visualViewport.x !== 0 ||
		before.visualViewport.y !== 0
	) {
		return "Visual viewport is zoomed or offset; capture origin is unknown.";
	}
	return undefined;
}

function geometrySampleFailure(options: ScreenshotGeometryOptions): string | undefined {
	const { before, after } = options;
	if (options.rendering === "text" || before?.rendering === "text" || after?.rendering === "text") {
		return LIGHTPANDA_IMAGE_REASON;
	}
	if (!before || !after) {
		return "Capture was not bracketed by browser geometry samples; coordinates are unknown.";
	}
	if (JSON.stringify(before) !== JSON.stringify(after)) {
		return "Browser geometry changed across capture; no coordinate mapping is asserted.";
	}
	return sampleFrameFailure(before);
}

export function buildScreenshotGeometry(
	options: ScreenshotGeometryOptions,
): ImageObservation["geometry"] {
	const { before, after, capture, pixels } = options;
	const unknown = (reason: string): ImageObservation["geometry"] => ({
		status: "unknown",
		reason,
		before,
		after,
	});
	const sampleFailure = geometrySampleFailure(options);
	if (sampleFailure !== undefined || !before || !after) {
		return unknown(
			sampleFailure ??
				"Capture was not bracketed by browser geometry samples; coordinates are unknown.",
		);
	}
	const crop = getMeasuredCrop(capture, before);
	if (!crop) {
		return unknown(
			"Element crop/frame provenance is unverified (scrolled page, child frames, non-CSS selector, or ambiguous target).",
		);
	}
	if (!pixels || !pixelsMatchCrop(crop, pixels, before.dpr)) {
		return unknown("Image dimensions do not establish the sampled CSS crop at this DPR.");
	}
	return {
		status: "measured",
		before,
		after,
		crop,
		pixelsPerCssPixel: { x: pixels.width / crop.width, y: pixels.height / crop.height },
		reason:
			"Matching pre/post samples, not an atomic capture guarantee. Pixels map to CSS document coordinates within crop; native mouse uses current viewport CSS coordinates. Recheck scroll/frame before input.",
	};
}

function observationCapture(value: unknown): ImageObservation["capture"] {
	switch (value) {
		case "viewport":
		case "full-page":
		case "element":
			return value;
		default:
			return "unknown";
	}
}

export function annotateScreenshotImageObservations(
	observations: readonly unknown[],
	samples: {
		readonly before?: ScreenshotSample | undefined;
		readonly after?: ScreenshotSample | undefined;
	},
): unknown[] {
	const images: unknown[] = [];
	for (const image of observations) {
		if (!isRecord(image)) {
			images.push(image);
			continue;
		}
		const rendering = image.rendering ?? samples.before?.rendering ?? samples.after?.rendering;
		images.push({
			...image,
			...(rendering !== undefined ? { rendering } : {}),
			geometry: buildScreenshotGeometry({
				rendering: rendering === "text" ? rendering : undefined,
				capture: observationCapture(image.capture),
				pixels: finiteRecord(image.pixels, ["width", "height"]) ? image.pixels : undefined,
				...samples,
			}),
		});
	}
	return images;
}
