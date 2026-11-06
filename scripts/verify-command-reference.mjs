/**
 * Purpose: Verify that docs/COMMAND_REFERENCE.md tracks the installed agent-browser help surface targeted by this package.
 * Responsibilities: Execute upstream help commands, compare canonical command/option tokens against the local reference, and report actionable drift failures.
 * Scope: Documentation drift detection only; it does not validate browser runtime behavior or package contents.
 * Usage: Run with `node scripts/verify-command-reference.mjs`, `npm run verify -- command-reference`, or as part of `npm run verify`.
 * Invariants/Assumptions: This check targets the current recommended agent-browser help surface declared in scripts/agent-browser-capability-baseline.mjs; runtime compatibility accepts stable versions at or above the configured floor without shims.
 * Related: `docs/SUPPORT_MATRIX.md` records how this live help and human-token check fits into the default and command-reference verification gates.
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
	CAPABILITY_BASELINE,
	CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX,
	CAPABILITY_BASELINE_SOURCE,
	COMMAND_REFERENCE_DOC_PATH,
} from "./agent-browser-capability-baseline.mjs";

const execFile = promisify(execFileCallback);
const GENERATED_BLOCK_PATTERN = new RegExp(
	`<!-- ${CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX}:start [^>]+ -->[\\s\\S]*?<!-- ${CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX}:end [^>]+ -->`,
	"g",
);

export const EXPECTED_VERSION = CAPABILITY_BASELINE.targetVersion;
export const HELP_COMMANDS = CAPABILITY_BASELINE.helpCommands;
export const DOC_REQUIRED_TOKENS = CAPABILITY_BASELINE.docRequiredTokens;
export const UPSTREAM_EXPECTATIONS = CAPABILITY_BASELINE.upstreamExpectations;

/** @param {string} text
 * @param {readonly string[]} tokens
 */
export function collectMissingTokens(text, tokens) {
	return tokens.filter((token) => !text.includes(token));
}

/** @param {string} content */
export function stripGeneratedCapabilityBaselineBlocks(content) {
	return content.replace(GENERATED_BLOCK_PATTERN, "");
}

function printHelp() {
	console.log(`verify-command-reference.mjs

Usage:
  node scripts/verify-command-reference.mjs

Checks:
  1. agent-browser is installed on PATH.
  2. agent-browser --version is ${EXPECTED_VERSION}.
  3. Expected ${EXPECTED_VERSION} help tokens from ${CAPABILITY_BASELINE_SOURCE} are present upstream.
  4. ${COMMAND_REFERENCE_DOC_PATH} includes the maintained human-authored local reference tokens.

Related runtime contract check:
  npm run verify -- real-upstream

Examples:
  npm run verify -- command-reference
  npm run verify

Exit codes:
  0  Verification passed.
  1  Verification failed.
  2  Usage error.
`);
}

/** @param {readonly string[]} args */
async function runAgentBrowser(args) {
	try {
		const { stdout, stderr } = await execFile("agent-browser", args, {
			maxBuffer: 10 * 1024 * 1024,
		});
		return `${stdout}${stderr}`;
	} catch (error) {
		throw new Error(
			`Failed to run agent-browser ${args.join(" ")}. Install or update agent-browser before verifying the command reference.\n${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

/** @param {{ readonly cwd?: string; readonly run?: (args: readonly string[]) => Promise<string>; readonly readDoc?: (path: string) => Promise<string> }} [options] */
export async function verifyCommandReference({
	cwd = process.cwd(),
	run = runAgentBrowser,
	readDoc = (path) => readFile(path, "utf8"),
} = {}) {
	const failures = [];

	const versionOutput = await run(["--version"]);
	const version = versionOutput.trim().replace(/^agent-browser\s+/, "");
	if (version !== EXPECTED_VERSION) {
		failures.push(
			`agent-browser version drift: expected ${EXPECTED_VERSION}, found ${version.length > 0 ? version : "<empty>"}. Update ${CAPABILITY_BASELINE_SOURCE}, run \`npm run docs -- command-reference write\`, and refresh ${COMMAND_REFERENCE_DOC_PATH}.`,
		);
	}

	/** @type {Map<string, string>} */
	const helpByLabel = new Map();
	for (const command of HELP_COMMANDS) {
		// Sample one upstream process at a time; skills commands can load shared native state.
		helpByLabel.set(command.label, await run(command.args));
	}

	return [
		...failures,
		...collectHelpFailures(helpByLabel),
		...collectMissingTokens(
			stripGeneratedCapabilityBaselineBlocks(await readDoc(join(cwd, COMMAND_REFERENCE_DOC_PATH))),
			DOC_REQUIRED_TOKENS,
		).map((token) => `${COMMAND_REFERENCE_DOC_PATH} is missing human-authored token: ${token}`),
	];
}

/** @param {ReadonlyMap<string, string>} helpByLabel */
function collectHelpFailures(helpByLabel) {
	const failures = [];
	for (const expectation of UPSTREAM_EXPECTATIONS) {
		const helpText = helpByLabel.get(expectation.help) ?? "";
		if (!helpText.includes(expectation.token)) {
			failures.push(
				`Upstream ${expectation.help} no longer includes expected token from ${CAPABILITY_BASELINE_SOURCE}: ${expectation.token}`,
			);
		}
	}

	return failures;
}

export async function main(argv = process.argv.slice(2)) {
	if (argv.includes("-h") || argv.includes("--help")) {
		printHelp();
		return 0;
	}

	if (argv.length > 0) {
		console.error(`Unknown option(s): ${argv.join(", ")}`);
		console.error("Run with --help for usage.");
		return 2;
	}

	try {
		const failures = await verifyCommandReference();
		if (failures.length > 0) {
			console.error("Command reference verification failed:");
			for (const failure of failures) {
				console.error(`- ${failure}`);
			}
			return 1;
		}
		console.log("Command reference verification passed.");
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((/** @type {unknown} */ error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
