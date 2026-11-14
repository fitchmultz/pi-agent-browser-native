import { parseArgvDescriptor } from "./argv-descriptor.js";
import {
	END_OF_OPTIONS,
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE,
	INSPECTION_FLAGS,
	PREVALIDATED_VALUE_FLAGS,
	beforeEndOfOptions,
	stripUpstreamGlobalFlags,
} from "./argv-grammar.js";
import { isOpenNavigationCommand } from "./command-taxonomy.js";
import type { InvalidValueFlagDetails } from "./runtime-contracts.js";
import { TARGET_AGENT_BROWSER_VERSION } from "./upstream-version.js";

const SHELL_OPERATOR_TOKENS = new Set(["&&", "||", "|", ";", ">", ">>", "<"]);

/** Upstream reads help and version requests only before its end-of-options marker. */
export function isPlainTextInspectionArgs(args: readonly string[]): boolean {
	return beforeEndOfOptions(args).some((token) => INSPECTION_FLAGS.has(token));
}

function getSingleKeyCommandValidationError(args: readonly string[]): string | undefined {
	const { commandInfo, upstreamCommandTokens: tokens } = parseArgvDescriptor(args);
	const command = commandInfo.command;
	if (!["press", "key", "keydown", "keyup"].includes(command ?? "") || tokens.length === 2) {
		return;
	}
	const label = command === "key" ? "key/press" : command;
	return `agent-browser ${label ?? ""} accepts exactly one key argument. Do not pass a selector or ref to ${label ?? ""}; focus or click the target first, then run ${command ?? ""} <key> (for example: focus @e1, then press Enter).`;
}

function getBareMcpValidationError(args: readonly string[]): string | undefined {
	const { commandInfo, upstreamCommandTokens: tokens } = parseArgvDescriptor(args);
	if (commandInfo.command !== "mcp" || tokens.includes("--help") || tokens.includes("-h")) {
		return;
	}
	if (commandInfo.subcommand === "call") {
		return "agent-browser mcp call invokes a nested MCP tool wrapper without this extension's session coordination, redaction, or image attachment pipeline. Use the native agent_browser tool modes directly, or configure external MCP clients to launch `agent-browser mcp`. Use `mcp --help` for help.";
	}
	return "agent-browser mcp starts a stdio MCP server for external MCP clients, not a one-shot native agent_browser tool workflow. Use the native agent_browser tool modes directly, or configure an MCP client to launch `agent-browser mcp`. Use `mcp --help` for help.";
}

function getUnsupportedInlineWaitDownloadError(args: readonly string[]): string | undefined {
	const descriptor = parseArgvDescriptor(args);
	if (
		descriptor.commandInfo.command !== "wait" ||
		!descriptor.upstreamCommandTokens.some((token) => token.startsWith("--download="))
	) {
		return;
	}
	return `agent-browser ${TARGET_AGENT_BROWSER_VERSION} does not support \`wait --download=<path>\`. Pass the optional path as a separate argument: \`wait --download <path>\` (or \`wait -d <path>\`).`;
}

function getBareNoSandboxValidationError(
	args: readonly string[],
	batchStep: boolean,
): string | undefined {
	// Native batch rows skip global parsing; --args is effective only on the outer CLI call.
	const tokens = batchStep ? args : stripUpstreamGlobalFlags(args);
	const command = tokens[0];
	const leading = command === "--no-sandbox";
	if (
		!leading &&
		(!isOpenNavigationCommand(command) || !tokens.slice(1).includes("--no-sandbox"))
	) {
		return;
	}
	const explanation = leading
		? "`--no-sandbox` is not an agent-browser command."
		: `\`--no-sandbox\` is ignored as an option by \`${String(command)}\`.`;
	return `${explanation} It is a Chromium launch argument. Put it in top-level \`--args\` and start a fresh session: { args: ["--args", "--no-sandbox", "open", "https://example.com"], sessionMode: "fresh" }. For batch, put --args before batch, not inside a step.`;
}

function getForbiddenToolTokenError(args: readonly string[]): string | undefined {
	const shellOperator = args.find((token) => SHELL_OPERATOR_TOKENS.has(token));
	if (shellOperator !== undefined) {
		return `Do not pass shell operators like \`${shellOperator}\`. Pass exact agent-browser CLI arguments only.`;
	}
	if (args.some((token) => token === "--session-mode" || token.startsWith("--session-mode="))) {
		return 'Do not pass `--session-mode` in args. Use the top-level agent_browser `sessionMode` field instead, for example { args: ["--profile", "Default", "open", "https://example.com"], sessionMode: "fresh" }.';
	}
	return;
}

export function validateToolArgs(
	args: readonly string[],
	options: { readonly batchStep?: boolean } = {},
): string | undefined {
	if (args.length === 0) {
		return "`args` must contain at least one agent-browser command token.";
	}
	const forbidden = getForbiddenToolTokenError(args);
	if (forbidden !== undefined) {
		return forbidden;
	}
	return getNativeCommandShapeError(args, options.batchStep === true);
}

function getNativeCommandShapeError(
	args: readonly string[],
	batchStep: boolean,
): string | undefined {
	const inspection = !batchStep && isPlainTextInspectionArgs(args);
	const invalidValueFlag = inspection ? undefined : getInvalidValueFlagDetails(args, !batchStep);
	if (invalidValueFlag?.reason === "unsupported-assignment") {
		return formatInvalidValueFlagError(invalidValueFlag, batchStep);
	}
	return (
		(inspection ? undefined : getBareNoSandboxValidationError(args, batchStep)) ??
		getBareMcpValidationError(args) ??
		getSingleKeyCommandValidationError(args) ??
		getUnsupportedInlineWaitDownloadError(args)
	);
}

function unsupportedAssignment(
	token: string,
	flag: string,
	allowRestoreAssignment: boolean,
): boolean {
	return (
		token.includes("=") &&
		(PREVALIDATED_VALUE_FLAGS.has(flag) ||
			GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(flag) ||
			(!allowRestoreAssignment && flag === "--restore"))
	);
}

function valueFlagProblem(
	flag: string,
	receivedToken: string | undefined,
): InvalidValueFlagDetails["reason"] | undefined {
	if (receivedToken === undefined || (flag === "--args" && receivedToken.length === 0)) {
		return "missing-value";
	}
	if (receivedToken.startsWith("-") && !GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE.has(flag)) {
		return "unexpected-flag";
	}
	return;
}

export function getInvalidValueFlagDetails(
	args: readonly string[],
	allowRestoreAssignment = true,
): InvalidValueFlagDetails | undefined {
	const entries = args.entries();
	for (const [index, token] of entries) {
		if (token === END_OF_OPTIONS) {
			break;
		}
		if (!token.startsWith("-")) {
			continue;
		}
		const flag = token.split("=", 1)[0] ?? token;
		if (unsupportedAssignment(token, flag, allowRestoreAssignment)) {
			return { flag, index, reason: "unsupported-assignment" };
		}
		if (!PREVALIDATED_VALUE_FLAGS.has(flag)) {
			continue;
		}
		const receivedToken = args.at(index + 1);
		const reason = valueFlagProblem(flag, receivedToken);
		if (reason !== undefined) {
			return reason === "unexpected-flag"
				? { flag, index, reason, receivedToken }
				: { flag, index, reason };
		}
		entries.next();
	}
	return;
}

export function formatInvalidValueFlagError(
	details: InvalidValueFlagDetails,
	batchStep = false,
): string {
	if (details.reason === "unsupported-assignment") {
		if (batchStep) {
			return details.flag === "--restore"
				? "Global `--restore=<key>` belongs before `batch` in top-level args, not inside a batch step."
				: `Global \`${details.flag}=<value>\` is not supported inside a batch step. Move \`${details.flag}\` and its value before \`batch\` as separate top-level args.`;
		}
		return `agent-browser ${TARGET_AGENT_BROWSER_VERSION} does not support \`${details.flag}=<value>\`. Pass \`${details.flag}\` and its value as separate arguments.`;
	}
	if (
		details.reason === "unexpected-flag" &&
		details.receivedToken !== undefined &&
		details.receivedToken.length > 0
	) {
		return `Flag \`${details.flag}\` requires a value, but received \`${details.receivedToken}\` instead. Pass a non-flag value immediately after \`${details.flag}\`.`;
	}
	return `Flag \`${details.flag}\` requires a value immediately after it. Pass a non-flag token like \`${details.flag} demo\`.`;
}
