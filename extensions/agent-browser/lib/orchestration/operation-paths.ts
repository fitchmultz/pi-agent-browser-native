import { isAbsolute, resolve } from "node:path";
import { projectUpstreamGlobalFlags, scanUpstreamGlobalFlagOccurrences } from "../argv-grammar.js";
import { getDiffFilePathIndices, getExplicitArtifactDestinationIndex } from "./browser-run/artifact-paths.js";
import { parseBatchCommandArgument, parseUserBatchStdin } from "./batch-stdin.js";

/** Bind caller file operands without moving the native process/config or interpreting literal form data. */
export function resolveOperationPaths(args: string[], stdin: string | undefined, cwd: string, batchStep = false): { args: string[]; stdin?: string } {
	let resolved = args;
	const setPath = (index: number | undefined, prefix = "") => {
		const path = index === undefined ? undefined : args[index]?.slice(prefix.length);
		if (index === undefined || !path || isAbsolute(path)) return;
		if (resolved === args) resolved = [...args];
		resolved[index] = prefix + resolve(cwd, path);
	};
	const { tokens, indices } = batchStep ? { tokens: args, indices: args.map((_, index) => index) } : projectUpstreamGlobalFlags(args);
	if (!batchStep) {
		for (const flag of ["--config", "--ca-cert", "--executable-path", "--extension", "--init-script", "--download-path", "--screenshot-dir", "--action-policy", "--state"]) {
			for (const occurrence of scanUpstreamGlobalFlagOccurrences(args, flag)) {
				if (flag === "--state" && tokens[0] === "wait" && occurrence.index > indices[0]) continue;
				setPath(occurrence.index + 1);
			}
		}
		for (const occurrence of scanUpstreamGlobalFlagOccurrences(args, "--profile")) {
			// Native Chrome profile names are identities, not workspace file paths.
			if (occurrence.value && /[\\/]/.test(occurrence.value) && !occurrence.value.startsWith("~")) setPath(occurrence.index + 1);
		}
	}
	if (tokens[0] === "batch") {
		if (tokens.slice(1).some(token => token !== "--bail")) {
			for (let index = 1; index < tokens.length; index++) {
				if (tokens[index] === "--bail") continue;
				const row = parseBatchCommandArgument(tokens[index]).step;
				if (!row) continue;
				const bound = resolveOperationPaths(row, undefined, cwd, true).args;
				if (bound === row) continue;
				if (resolved === args) resolved = [...args];
				resolved[indices[index]] = bound.map(token => `'${token.replaceAll("'", "'\\''")}'`).join(" ");
			}
			return { args: resolved, stdin }; // Native ignores stdin when raw rows exist.
		}
		const rows = parseUserBatchStdin(stdin).steps;
		if (!rows?.length) return { args: resolved, stdin };
		const bound = rows.map(row => resolveOperationPaths(row, undefined, cwd, true).args);
		return { args: resolved, stdin: bound.some((row, index) => row !== rows[index]) ? JSON.stringify(bound) : stdin };
	}
	setPath(indices[getExplicitArtifactDestinationIndex(tokens) ?? -1]);
	if (tokens[0] === "upload") for (let index = 2; index < tokens.length; index++) setPath(indices[index]);
	if (tokens[0] === "state" && tokens[1] === "load") setPath(indices[2]);
	setPath(indices[getDiffFilePathIndices(tokens).baseline ?? -1]);
	if (tokens[0] === "cookies" && tokens[1] === "set") {
		const index = tokens.indexOf("--curl");
		if (index >= 0) setPath(indices[index + 1]);
	}
	if (tokens[0] === "webmcp" && tokens[1] === "invoke") {
		for (let index = 3; index < tokens.length; index++) {
			if (!["--params", "--frame", "--timeout"].includes(tokens[index])) continue;
			if (tokens[index] === "--params" && tokens[index + 1]?.startsWith("@")) setPath(indices[index + 1], "@");
			index++;
		}
	}
	return { args: resolved, stdin };
}
