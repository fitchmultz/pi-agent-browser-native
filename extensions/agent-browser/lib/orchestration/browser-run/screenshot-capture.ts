import type { ImageObservation } from "../../results/contracts.js";
import { getScreenshotPathOperand, getScreenshotOperands } from "./artifact-paths.js";

export function getScreenshotCapture(command: readonly string[]): {
	readonly kind: ImageObservation["capture"];
	readonly selector?: string | undefined;
} {
	if (command[0] !== "screenshot") {
		return { kind: "unknown" };
	}
	if (command.includes("--full") || command.includes("-f")) {
		return { kind: "full-page" };
	}
	const positional = getScreenshotOperands(command);
	const pathIndex = getScreenshotPathOperand(command)?.index;
	const selector = positional.find(({ index }) => index !== pathIndex);
	return selector === undefined
		? { kind: "viewport" }
		: { kind: "element", selector: selector.token };
}
