import { isAbsolute, resolve } from "node:path";
import { projectUpstreamGlobalFlags, scanUpstreamGlobalFlagOccurrences } from "../argv-grammar.js";
import {
	getDiffFilePathIndices,
	getExplicitArtifactDestinationIndex,
} from "./browser-run/artifact-paths.js";
import {
	isNativeBatchOption,
	parseBatchCommandArgument,
	parseUserBatchStdin,
} from "./batch-stdin.js";

interface BoundOperationPaths {
	readonly args: readonly string[];
	readonly stdin?: string;
}

const FILE_GLOBAL_FLAGS = [
	"--config",
	"--ca-cert",
	"--executable-path",
	"--extension",
	"--init-script",
	"--download-path",
	"--screenshot-dir",
	"--action-policy",
	"--state",
];

/** Owns copy-on-write argv; unchanged rows retain identity for batch stdin preservation. */
class OperationPathBinding {
	private changedArgs: string[] | undefined;
	readonly tokens: readonly string[];
	private readonly indices: readonly number[];

	constructor(
		private readonly args: readonly string[],
		private readonly cwd: string,
		batchStep: boolean,
	) {
		const projection = batchStep
			? { tokens: args, indices: args.map((_, index) => index) }
			: projectUpstreamGlobalFlags(args);
		this.tokens = projection.tokens;
		this.indices = projection.indices;
	}

	get result(): readonly string[] {
		return this.changedArgs ?? this.args;
	}

	private replace(index: number, value: string): void {
		this.changedArgs ??= [...this.args];
		this.changedArgs[index] = value;
	}

	private setPath(index: number | undefined, prefix = ""): void {
		if (index === undefined) {
			return;
		}
		const path = this.args.at(index)?.slice(prefix.length);
		if (path === undefined || path.length === 0 || isAbsolute(path)) {
			return;
		}
		this.replace(index, prefix + resolve(this.cwd, path));
	}

	bindGlobals(): void {
		for (const flag of FILE_GLOBAL_FLAGS) {
			for (const occurrence of scanUpstreamGlobalFlagOccurrences([...this.args], flag)) {
				if (flag === "--state" && this.tokens[0] === "wait" && occurrence.index > this.indices[0]) {
					continue;
				}
				this.setPath(occurrence.index + 1);
			}
		}
		for (const occurrence of scanUpstreamGlobalFlagOccurrences([...this.args], "--profile")) {
			const value = occurrence.value;
			// Chrome profile names are identities, not workspace file paths.
			if (value !== undefined && /[\\/]/.test(value) && !value.startsWith("~")) {
				this.setPath(occurrence.index + 1);
			}
		}
	}

	bindRawBatchRows(): void {
		for (let index = 1; index < this.tokens.length; index++) {
			if (isNativeBatchOption(this.tokens[index])) {
				continue;
			}
			const row = parseBatchCommandArgument(this.tokens[index]).step;
			if (row === undefined) {
				continue;
			}
			const bound = resolveOperationPaths(row, undefined, this.cwd, true).args;
			if (bound !== row) {
				this.replace(
					this.indices[index],
					bound.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(" "),
				);
			}
		}
	}

	bindFileOperands(): void {
		this.setPath(this.indices[getExplicitArtifactDestinationIndex([...this.tokens]) ?? -1]);
		if (this.tokens[0] === "upload") {
			for (let index = 2; index < this.tokens.length; index++) {
				this.setPath(this.indices[index]);
			}
		}
		if (this.tokens[0] === "state" && this.tokens[1] === "load") {
			this.setPath(this.indices[2]);
		}
		this.setPath(this.indices[getDiffFilePathIndices([...this.tokens]).baseline ?? -1]);
		if (this.tokens[0] === "cookies" && this.tokens[1] === "set") {
			const index = this.tokens.indexOf("--curl");
			if (index >= 0) {
				this.setPath(this.indices[index + 1]);
			}
		}
		this.bindWebMcpParams();
	}

	bindBatch(stdin: string | undefined): BoundOperationPaths {
		if (this.tokens.slice(1).some((token) => !isNativeBatchOption(token))) {
			this.bindRawBatchRows();
			return { args: this.result, stdin }; // Native ignores stdin when raw rows exist.
		}
		const rows = parseUserBatchStdin(stdin).steps;
		if (rows === undefined || rows.length === 0) {
			return { args: this.result, stdin };
		}
		const bound = rows.map((row) => resolveOperationPaths(row, undefined, this.cwd, true).args);
		return {
			args: this.result,
			stdin: bound.some((row, index) => row !== rows[index]) ? JSON.stringify(bound) : stdin,
		};
	}

	private bindWebMcpParams(): void {
		if (this.tokens[0] !== "webmcp" || this.tokens[1] !== "invoke") {
			return;
		}
		for (let index = 3; index < this.tokens.length; index++) {
			if (!["--params", "--frame", "--timeout"].includes(this.tokens[index])) {
				continue;
			}
			if (
				this.tokens[index] === "--params" &&
				this.tokens.at(index + 1)?.startsWith("@") === true
			) {
				this.setPath(this.indices[index + 1], "@");
			}
			index++;
		}
	}
}

/** Bind file operands without moving native process/config or interpreting literal form data. */
export function resolveOperationPaths(
	args: readonly string[],
	stdin: string | undefined,
	cwd: string,
	batchStep = false,
): BoundOperationPaths {
	const binding = new OperationPathBinding(args, cwd, batchStep);
	if (!batchStep) {
		binding.bindGlobals();
	}
	if (binding.tokens[0] === "batch") {
		return binding.bindBatch(stdin);
	}
	binding.bindFileOperands();
	return { args: binding.result, stdin };
}
