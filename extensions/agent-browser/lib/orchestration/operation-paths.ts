import { isAbsolute, resolve } from "node:path";
import {
	projectUpstreamGlobalFlags,
	scanUpstreamGlobalFlagOccurrences,
	type IndexedArgvToken,
} from "../argv-grammar.js";
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
	readonly stdin?: string | undefined;
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
	private readonly projection: readonly IndexedArgvToken[];

	constructor(
		private readonly args: readonly string[],
		private readonly cwd: string,
		batchStep: boolean,
	) {
		this.projection = batchStep
			? args.map((token, index) => ({ token, index }))
			: projectUpstreamGlobalFlags(args);
		this.tokens = this.projection.map(({ token }) => token);
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
		const command = this.projection[0];
		for (const flag of FILE_GLOBAL_FLAGS) {
			for (const occurrence of scanUpstreamGlobalFlagOccurrences(this.args, flag)) {
				if (flag === "--state" && command?.token === "wait" && occurrence.index > command.index) {
					continue;
				}
				this.setPath(occurrence.index + 1);
			}
		}
		this.bindProfilePath();
	}

	private bindProfilePath(): void {
		for (const occurrence of scanUpstreamGlobalFlagOccurrences(this.args, "--profile")) {
			const value = occurrence.value;
			// Chrome profile names are identities, not workspace file paths.
			if (value !== undefined && /[\\/]/.test(value) && !value.startsWith("~")) {
				this.setPath(occurrence.index + 1);
			}
		}
	}

	bindRawBatchRows(): void {
		for (const { index, token } of this.projection.slice(1)) {
			if (isNativeBatchOption(token)) {
				continue;
			}
			const row = parseBatchCommandArgument(token).step;
			if (row === undefined) {
				continue;
			}
			const bound = resolveOperationPaths(row, undefined, this.cwd, true).args;
			if (bound !== row) {
				this.replace(index, bound.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" "));
			}
		}
	}

	private setOperandPath(index: number | undefined): void {
		if (index !== undefined) {
			this.setPath(this.projection[index]?.index);
		}
	}

	bindFileOperands(): void {
		this.setOperandPath(getExplicitArtifactDestinationIndex(this.tokens));
		if (this.tokens[0] === "upload") {
			for (const { index } of this.projection.slice(2)) {
				this.setPath(index);
			}
		}
		if (this.tokens[0] === "state" && this.tokens[1] === "load") {
			this.setOperandPath(2);
		}
		this.setOperandPath(getDiffFilePathIndices(this.tokens).baseline);
		if (this.tokens[0] === "cookies" && this.tokens[1] === "set") {
			const index = this.tokens.indexOf("--curl");
			if (index >= 0) {
				this.setOperandPath(index + 1);
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
		const operands = this.projection.slice(3).values();
		for (const { token } of operands) {
			if (!["--params", "--frame", "--timeout"].includes(token)) {
				continue;
			}
			const value = operands.next().value;
			if (token === "--params" && value?.token.startsWith("@") === true) {
				this.setPath(value.index, "@");
			}
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
