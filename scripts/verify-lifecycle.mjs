/**
 * Purpose: Exercise the configured-source pi-agent-browser lifecycle path through a real tmux-driven Pi process.
 * Responsibilities: Dispatch the isolated reload/relaunch harness, preserve its exit code, and print retained transcript evidence.
 * Scope: Maintainer verification through `npm run verify -- lifecycle` and the release gate; fixture, transcript, transport, and ordered runtime responsibilities live in adjacent lifecycle modules.
 * Usage: `node scripts/verify-lifecycle.mjs [--model <id>] [--timeout-ms <ms>] [--keep-artifacts] [--verbose]`.
 * Invariants/Assumptions: Pi and tmux are on PATH. The harness preserves transcripts and uses exactly one temporary configured package source with an exact Pi session id.
 */
import { pathToFileURL } from "node:url";
import { DEFAULT_LIFECYCLE_MODEL, DEFAULT_TIMEOUT_MS } from "./lifecycle-defaults.mjs";
import { verifyLifecycle } from "./lifecycle-run.mjs";
export { buildSettingsPayload, injectLifecycleSentinelSource } from "./lifecycle-fixture.mjs";
export { fakeAgentBrowserScript } from "./lifecycle-fake-browser.mjs";
export {
	agentBrowserResults,
	collectFullOutputPaths,
	matchesSuccessfulPageResult,
	parseJsonl,
	sentinelTokens,
	sessionHeaderId,
	waitForAgentBrowserResult,
} from "./lifecycle-transcript.mjs";
export {
	buildPiLaunchArgs,
	createLifecycleSessionId,
	paneLooksReady,
	tmuxActiveTarget,
} from "./lifecycle-tmux.mjs";

class UsageError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function printHelp() {
	console.log(`verify-lifecycle.mjs

Usage:
  node scripts/verify-lifecycle.mjs [options]

Options:
  --keep-artifacts    Keep the temporary Pi config, fake browser state, session files, and transcripts.
  --model <id>        Pi model for tmux-driven prompts. Default: ${DEFAULT_LIFECYCLE_MODEL}.
  --timeout-ms <ms>   Override per-step wait timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --verbose           Print progress while driving tmux.
  -h, --help          Show this help text.

Examples:
  npm run verify -- lifecycle
  npm run verify -- lifecycle --model openai-codex/gpt-5.5:minimal
  npm run verify -- lifecycle --keep-artifacts
  node scripts/verify-lifecycle.mjs --keep-artifacts --verbose

Exit codes:
  0  Lifecycle verification passed.
  1  Lifecycle verification failed.
  2  Usage error.
`);
}

/** @param {string | undefined} value */
function parseModel(value) {
	if (value === undefined || value === "" || value.startsWith("-")) {
		throw new UsageError("--model requires a provider/model id value.");
	}
	return value;
}

/** @param {string | undefined} value */
function parseTimeout(value) {
	if (value === undefined || value === "") {
		throw new UsageError("--timeout-ms requires a positive integer value.");
	}
	const timeoutMs = Number(value);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new UsageError(
			`--timeout-ms must be a positive integer; received ${JSON.stringify(value)}.`,
		);
	}
	return timeoutMs;
}

/** @param {readonly string[]} argv */
export function parseCliArgs(argv = process.argv.slice(2)) {
	const options = {
		keepArtifacts: false,
		model: DEFAULT_LIFECYCLE_MODEL,
		showHelp: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		verbose: false,
	};
	const args = argv.values();
	for (const arg of args) {
		if (["-h", "--help"].includes(arg)) {
			return { ...options, showHelp: true };
		}
		if (arg === "--keep-artifacts" || arg === "--verbose") {
			options[arg === "--verbose" ? "verbose" : "keepArtifacts"] = true;
			continue;
		}
		if (arg === "--model" || arg === "--timeout-ms") {
			const value = args.next().value;
			if (arg === "--model") {
				options.model = parseModel(value);
			} else {
				options.timeoutMs = parseTimeout(value);
			}
			continue;
		}
		throw new UsageError(`Unknown option: ${arg}`);
	}
	return options;
}

export async function main(argv = process.argv.slice(2)) {
	try {
		const options = parseCliArgs(argv);
		if (options.showHelp) {
			printHelp();
			return 0;
		}
		const report = await verifyLifecycle(options);
		console.log("Lifecycle verification passed.");
		console.log(`Session: ${report.sessionFile}`);
		console.log(`Session id: ${report.sessionId}`);
		console.log(`Managed browser session: ${report.sessionName}`);
		console.log(`Persisted full output verified before cleanup: ${report.fullOutputPath}`);
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			console.error("Run with --help for usage.");
			return 2;
		}
		console.error("Lifecycle verification failed:");
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		return 1;
	}
}

/** @param {string} metaUrl @param {readonly string[]} argv */
export function isDirectRun(metaUrl, argv = process.argv) {
	const entry = argv[1];
	return entry !== undefined && entry !== "" && metaUrl === pathToFileURL(entry).href;
}

if (isDirectRun(import.meta.url)) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((/** @type {unknown} */ error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
