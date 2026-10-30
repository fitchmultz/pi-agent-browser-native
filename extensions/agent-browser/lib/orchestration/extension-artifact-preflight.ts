import { extractUpstreamCommandTokens, validateToolArgs } from "../runtime.js";
import { isCloseAllCommand, isCloseCommand } from "../command-taxonomy.js";
import {
	canonicalizeExplicitArtifactDestination,
	getExplicitArtifactDestination,
	getRecordContactSheetDestination,
} from "./browser-run/artifact-paths.js";
import {
	isNativeBatchOption,
	parseBatchCommandArgument,
	parseUserBatchStdin,
} from "./batch-stdin.js";
import { normalizeRequestedOutputPath } from "./output-file.js";
import type { ActiveRecordingReservation } from "../recording-reservations.js";

interface ArtifactCommandSteps {
	readonly batch: boolean;
	readonly error?: string;
	readonly steps: string[][];
}

function parseRawArtifactSteps(commands: readonly string[]): ArtifactCommandSteps {
	const steps: string[][] = [];
	for (const command of commands) {
		if (isNativeBatchOption(command)) {
			continue;
		}
		const parsed = parseBatchCommandArgument(command);
		if ((parsed.error !== undefined && parsed.error !== "") || !parsed.step) {
			return {
				batch: true,
				error: `Unsupported batch step ${steps.length + 1}: ${parsed.error ?? "command could not be parsed safely"}`,
				steps,
			};
		}
		steps.push(parsed.step);
	}
	return { batch: true, steps };
}

export function getArtifactCommandSteps(
	args: readonly string[],
	stdin: string | undefined,
): ArtifactCommandSteps {
	const tokens = extractUpstreamCommandTokens([...args]);
	if (tokens[0] !== "batch") {
		return { batch: false, steps: tokens.length > 0 ? [tokens] : [] };
	}
	const parsed = parseRawArtifactSteps(tokens.slice(1));
	if (parsed.error !== undefined && parsed.error !== "") {
		return parsed;
	}
	// Raw native rows exclusively win over stdin, including artifact and lifecycle preflight.
	if (parsed.steps.length > 0) {
		return parsed;
	}
	const input = parseUserBatchStdin(stdin);
	return input.error !== undefined && input.error !== ""
		? { batch: true, error: input.error, steps: [] }
		: { batch: true, steps: input.steps ?? [] };
}

interface ArtifactPreflightOptions {
	readonly activeRecordingReservations?: readonly Readonly<ActiveRecordingReservation>[];
	readonly args: readonly string[];
	readonly cwd: string;
	readonly outputPath?: string;
	readonly stdin?: string;
}

class ArtifactPreflight {
	readonly active = new Set<string>();
	readonly destinations = new Map<string, number>();
	readonly plan: ArtifactCommandSteps;
	canonicalOutputPath: string | undefined;
	sawClose = false;
	constructor(readonly options: ArtifactPreflightOptions) {
		this.plan = getArtifactCommandSteps(options.args, options.stdin);
	}

	cleanupOnly(): boolean {
		return (
			this.plan.steps.length > 0 &&
			this.plan.steps.every(
				([command, subcommand]) =>
					isCloseCommand(command) || (command === "record" && subcommand === "stop"),
			)
		);
	}

	reserveActiveDestinations(): string | undefined {
		for (const reservation of this.options.activeRecordingReservations ?? []) {
			try {
				this.active.add(
					canonicalizeExplicitArtifactDestination(reservation.cwd, reservation.absolutePath),
				);
				if (reservation.contactSheetPath !== undefined && reservation.contactSheetPath !== "") {
					this.active.add(
						canonicalizeExplicitArtifactDestination(reservation.cwd, reservation.contactSheetPath),
					);
				}
			} catch (error) {
				if (!this.cleanupOnly()) {
					return error instanceof Error
						? error.message
						: "An active recording destination could not be resolved safely.";
				}
			}
		}
		return undefined;
	}

	validateOutputPath(): string | undefined {
		const path = this.options.outputPath;
		if (path === undefined || path === "") {
			return undefined;
		}
		try {
			this.canonicalOutputPath = canonicalizeExplicitArtifactDestination(
				this.options.cwd,
				normalizeRequestedOutputPath(path),
			);
			if (this.active.has(this.canonicalOutputPath)) {
				return `Unsupported outputPath: ${path} is reserved by an active recording. Stop that recording first or use a distinct path.`;
			}
		} catch (error) {
			return error instanceof Error
				? error.message
				: `outputPath ${path} could not be resolved safely.`;
		}
		return undefined;
	}

	validateBatchStep(step: readonly string[], index: number): string | undefined {
		if (!this.plan.batch) {
			return undefined;
		}
		const error = validateToolArgs([...step], { batchStep: true });
		if (error !== undefined && error !== "") {
			return `Unsupported batch step ${index + 1}: ${error}`;
		}
		if (this.sawClose && step[0] === "record" && (step[1] === "start" || step[1] === "restart")) {
			return `Unsupported batch step ${index + 1}: record ${step[1]} cannot follow close, quit, or exit in one upstream batch because upstream can report success without starting a recording. Split the close and recording into separate agent_browser calls.`;
		}
		if (isCloseCommand(step[0])) {
			this.sawClose = true;
		}
		return undefined;
	}

	validateDestination(destination: string, index: number): string | undefined {
		let canonical: string;
		try {
			canonical = canonicalizeExplicitArtifactDestination(this.options.cwd, destination);
		} catch (error) {
			return error instanceof Error
				? error.message
				: `Artifact destination ${destination} could not be resolved safely.`;
		}
		if (this.canonicalOutputPath === canonical) {
			return `Unsupported outputPath: ${this.options.outputPath ?? ""} resolves to the same destination as artifact path ${destination}. Use distinct paths so the tool-result JSON cannot overwrite the browser artifact.`;
		}
		if (this.active.has(canonical)) {
			const prefix = this.plan.batch
				? `Unsupported batch artifact destination in step ${index + 1}`
				: "Unsupported artifact destination";
			return `${prefix}: ${destination} is reserved by an active recording. Stop that recording first or use a distinct path.`;
		}
		const prior = this.destinations.get(canonical);
		if (prior !== undefined) {
			return `Unsupported batch artifact destination in step ${index + 1}: ${destination} is already written by step ${prior + 1}. Use distinct paths or split the batch so each artifact can be verified independently.`;
		}
		this.destinations.set(canonical, index);
		return undefined;
	}

	validateStepDestinations(step: readonly string[], index: number): string | undefined {
		for (const destination of [
			getExplicitArtifactDestination([...step]),
			getRecordContactSheetDestination([...step]),
		]) {
			if (destination === undefined || destination === "") {
				continue;
			}
			const failure = this.validateDestination(destination, index);
			if (failure !== undefined && failure !== "") {
				return failure;
			}
		}
		return undefined;
	}
	validateStep(step: readonly string[], index: number): string | undefined {
		if (step.length === 0) {
			return undefined;
		}
		const error = this.validateBatchStep(step, index);
		if (error !== undefined && error !== "") {
			return error;
		}
		const destinationFailure = this.validateStepDestinations(step, index);
		if (destinationFailure !== undefined && destinationFailure !== "") {
			return destinationFailure;
		}
		if (this.plan.batch && step[0] === "screenshot" && step.includes("--annotate")) {
			return [
				`Unsupported batch screenshot annotation in step ${index + 1}: put --annotate in top-level args, not inside the batch step.`,
				`Use: { "args": ["--annotate", "batch"], "stdin": "[[\\"screenshot\\",\\"/path/to/image.png\\"]]" }`,
			].join("\n");
		}
		return undefined;
	}

	run(): string | undefined {
		const error = this.plan.error;
		if (error !== undefined && error !== "") {
			return error;
		}
		const activeError = this.reserveActiveDestinations();
		if (activeError !== undefined && activeError !== "") {
			return activeError;
		}
		const outputError = this.validateOutputPath();
		if (outputError !== undefined && outputError !== "") {
			return outputError;
		}
		for (const [index, step] of this.plan.steps.entries()) {
			const failure = this.validateStep(step, index);
			if (failure !== undefined && failure !== "") {
				return failure;
			}
		}
		return undefined;
	}
}

export function getArtifactPreflightValidationError(
	options: ArtifactPreflightOptions,
): string | undefined {
	return new ArtifactPreflight(options).run();
}
export function commandClosesAllSessions(
	args: readonly string[],
	stdin: string | undefined,
): boolean {
	const parsed = getArtifactCommandSteps(args, stdin);
	return (
		(parsed.error === undefined || parsed.error === "") && parsed.steps.some(isCloseAllCommand)
	);
}
export function commandTouchesArtifactLifecycle(
	args: readonly string[],
	stdin: string | undefined,
	outputPath?: string,
): boolean {
	if (outputPath !== undefined && outputPath !== "") {
		return true;
	}
	const parsed = getArtifactCommandSteps(args, stdin);
	if (parsed.error !== undefined && parsed.error !== "") {
		return true;
	}
	return parsed.steps.some(
		(step) =>
			getExplicitArtifactDestination(step) !== undefined ||
			step[0] === "record" ||
			step[0] === "screenshot" ||
			isCloseCommand(step[0]),
	);
}
