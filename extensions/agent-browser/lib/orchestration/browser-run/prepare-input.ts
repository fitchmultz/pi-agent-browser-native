import type { BrowserRunOptions, BrowserRunInputFields } from "./types.js";

export function normalizeRunInput(input: BrowserRunOptions["input"]): BrowserRunInputFields {
	const base = {
		redactedArgs: input.redactedArgs,
		toolArgs: input.toolArgs,
		toolStdin: input.toolStdin,
	};
	switch (input.kind) {
		case "electron":
			return {
				...base,
				compiledElectron: input.compiledElectron,
				redactedCompiledElectron: input.redactedCompiledElectron,
			};
		case "networkSourceLookup":
			return {
				...base,
				compiledNetworkSourceLookup: input.compiledNetworkSourceLookup,
				redactedCompiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup,
			};
		case "qa":
			return {
				...base,
				compiledJob: input.compiledJob,
				compiledQaPreset: input.compiledQaPreset,
				redactedCompiledJob: input.redactedCompiledJob,
				redactedCompiledQaPreset: input.redactedCompiledQaPreset,
			};
		case "semanticAction":
			return {
				...base,
				compiledSemanticAction: input.compiledSemanticAction,
				redactedCompiledSemanticAction: input.redactedCompiledSemanticAction,
			};
		case "sourceLookup":
			return {
				...base,
				compiledSourceLookup: input.compiledSourceLookup,
				redactedCompiledSourceLookup: input.redactedCompiledSourceLookup,
			};
		case "args":
			return base;
	}
}

export function buildInvocationPreview(effectiveArgs: readonly string[]): string {
	const preview = effectiveArgs.join(" ");
	return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

interface StdinContract {
	readonly command?: string | undefined;
	readonly commandTokens: readonly string[];
	readonly stdin?: string | undefined;
}

function isPasswordStdinAuthSave(options: StdinContract): boolean {
	return (
		options.command === "auth" &&
		options.commandTokens[1] === "save" &&
		options.commandTokens.includes("--password-stdin")
	);
}

export function getExactSensitiveStdinValues(options: StdinContract): string[] {
	if (options.stdin === undefined || !isPasswordStdinAuthSave(options)) {
		return [];
	}
	return [
		...new Set(
			[options.stdin, options.stdin.trimEnd(), options.stdin.trim()].filter(
				(value) => value.length > 0,
			),
		),
	];
}

export function validateStdinCommandContract(options: StdinContract): string | undefined {
	if (options.stdin === undefined || options.command === "batch") {
		return undefined;
	}
	if (options.command === "eval" && options.commandTokens.includes("--stdin")) {
		return undefined;
	}
	if (isPasswordStdinAuthSave(options)) {
		return undefined;
	}
	const commandLabel =
		options.command !== undefined && options.command !== ""
			? `\`${options.command}\``
			: "the requested command";
	return `agent_browser stdin is only supported for \`batch\`, \`eval --stdin\`, and \`auth save --password-stdin\`; remove stdin from ${commandLabel} or use one of those command forms.`;
}
