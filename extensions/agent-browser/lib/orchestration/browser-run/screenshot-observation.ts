import { isRecord } from "../../parsing.js";
import type { ImageObservation, ScreenshotSample } from "../../results/contracts.js";
import { getScreenshotPathTokenIndex, getScreenshotPositionalIndices } from "./artifact-paths.js";
import { runSessionCommandData } from "./session-state.js";

export function getScreenshotCapture(command: string[]): { kind: ImageObservation["capture"]; selector?: string } {
	if (command[0] !== "screenshot") return { kind: "unknown" };
	if (command.includes("--full") || command.includes("-f")) return { kind: "full-page" };
	const positional = getScreenshotPositionalIndices(command);
	const selectorIndex = positional.find(index => index !== getScreenshotPathTokenIndex(command));
	return selectorIndex === undefined ? { kind: "viewport" } : { kind: "element", selector: command[selectorIndex] };
}

function finiteRecord(value: unknown, keys: string[]): boolean {
	return isRecord(value) && keys.every(key => typeof value[key] === "number" && Number.isFinite(value[key]));
}

export async function collectScreenshotSample(options: {
	command: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	namespace?: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<ScreenshotSample | undefined> {
	if (options.command[0] !== "screenshot" || options.signal?.aborted) return undefined;
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
		return { url: location.href, frame: window === window.top ? "main" : "child", childFrameCount: window.frames.length,
			viewport: { width: innerWidth, height: innerHeight },
			document: { width: Math.max(root.scrollWidth, body?.scrollWidth || 0, innerWidth), height: Math.max(root.scrollHeight, body?.scrollHeight || 0, innerHeight) },
			scroll: { x: scrollX, y: scrollY }, dpr: devicePixelRatio,
			visualViewport: { x: v?.offsetLeft ?? 0, y: v?.offsetTop ?? 0, scale: v?.scale ?? 1 }, element };
	})()`;
	try {
		const data = await runSessionCommandData({ ...options, args: ["eval", "--stdin"], stdin: script, timeoutMs: 2_000 });
		const sample = isRecord(data) ? data.result : undefined;
		if (!isRecord(sample) || typeof sample.url !== "string" || !["main", "child"].includes(String(sample.frame))
			|| !finiteRecord(sample.viewport, ["width", "height"]) || !finiteRecord(sample.document, ["width", "height"])
			|| !finiteRecord(sample.scroll, ["x", "y"]) || !finiteRecord(sample.visualViewport, ["x", "y", "scale"])
			|| typeof sample.childFrameCount !== "number" || !Number.isInteger(sample.childFrameCount) || sample.childFrameCount < 0
			|| typeof sample.dpr !== "number" || !Number.isFinite(sample.dpr) || sample.dpr <= 0
			|| (sample.element !== undefined && !finiteRecord(sample.element, ["x", "y", "width", "height"]))) return undefined;
		return sample as unknown as ScreenshotSample;
	} catch { return undefined; }
}

export function buildScreenshotGeometry(options: {
	capture: ImageObservation["capture"];
	pixels: ImageObservation["pixels"];
	before?: ScreenshotSample;
	after?: ScreenshotSample;
}): ImageObservation["geometry"] {
	const { before, after, capture, pixels } = options;
	const unknown = (reason: string): ImageObservation["geometry"] => ({ status: "unknown", reason, before, after });
	if (!before || !after) return unknown("Capture was not bracketed by browser geometry samples; coordinates are unknown.");
	if (JSON.stringify(before) !== JSON.stringify(after)) return unknown("Browser geometry changed across capture; no coordinate mapping is asserted.");
	if (before.frame !== "main") return unknown("Probe observed a child frame; its relation to the captured page is unknown.");
	if (before.visualViewport.scale !== 1 || before.visualViewport.x !== 0 || before.visualViewport.y !== 0) return unknown("Visual viewport is zoomed or offset; capture origin is unknown.");
	let crop: NonNullable<ImageObservation["geometry"]["crop"]>;
	if (capture === "viewport") crop = { ...before.scroll, ...before.viewport };
	else if (capture === "full-page") crop = { x: 0, y: 0, ...before.document };
	else if (capture === "element" && before.element && before.childFrameCount === 0 && before.scroll.x === 0 && before.scroll.y === 0) crop = before.element;
	else return unknown("Element crop/frame provenance is unverified (scrolled page, child frames, non-CSS selector, or ambiguous target).");
	if (!pixels || crop.width <= 0 || crop.height <= 0 || crop.x < 0 || crop.y < 0
		|| !Object.values(crop).every(Number.isInteger)
		|| pixels.width !== crop.width * before.dpr || pixels.height !== crop.height * before.dpr) return unknown("Image dimensions do not establish the sampled CSS crop at this DPR.");
	return { status: "measured", before, after, crop, pixelsPerCssPixel: { x: pixels.width / crop.width, y: pixels.height / crop.height },
		reason: "Matching pre/post samples, not an atomic capture guarantee. Pixels map to CSS document coordinates within crop; native mouse uses current viewport CSS coordinates. Recheck scroll/frame before input." };
}
