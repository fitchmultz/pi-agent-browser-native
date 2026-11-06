/** Native tmux transport and lifecycle prompt submission. */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import { sleep } from "./lifecycle-transcript.mjs";

const execFile = promisify(execFileCallback);
const PROMPT_SUBMIT_PAUSE_MS = 250;
// tmux keeps a server's socket file after the server stops, both after kill-server and when the server
// exits on its own because Pi exited or crashed. Each launch records the socket path its server reports.
/** @type {Map<string, string>} */
const launchedSocketPaths = new Map();

export function createLifecycleSessionId(pid = process.pid) {
	return `piab-lifecycle-${pid}`;
}

/** @param {{model: string, sessionId: string}} options */
export function buildPiLaunchArgs({ model, sessionId }) {
	return ["--approve", "--model", model, "--session-id", sessionId];
}

/** @param {string} tmuxSession */
export function tmuxActiveTarget(tmuxSession) {
	return `${tmuxSession}:`;
}

/** @param {string} command @param {readonly string[]} args */
async function run(command, args) {
	return execFile(command, args, { maxBuffer: 20 * 1024 * 1024 });
}

// A task-owned server starts from this process, so Pi inherits its environment, including provider
// credentials; a server that is already running would supply its own global environment instead.
/** @param {string} tmuxSession @param {readonly string[]} args */
function tmux(tmuxSession, args) {
	return run("tmux", ["-L", tmuxSession, ...args]);
}

/** @param {string} tmuxSession */
export async function capturePaneText(tmuxSession) {
	const { stdout } = await tmux(tmuxSession, [
		"capture-pane",
		"-p",
		"-S",
		"-2000",
		"-t",
		tmuxActiveTarget(tmuxSession),
	]);
	return stdout;
}

/** @param {string} pane */
export function paneLooksReady(pane) {
	return /\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kKmMgG]/.test(pane) && !/Working[.…]*/i.test(pane);
}

/** @param {string} tmuxSession @param {string} artifactPath */
export async function capturePane(tmuxSession, artifactPath) {
	try {
		const stdout = await capturePaneText(tmuxSession);
		await mkdir(dirname(artifactPath), { recursive: true });
		await writeFile(artifactPath, stdout, "utf8");
		return stdout;
	} catch (error) {
		await writeFile(
			artifactPath,
			`Could not capture pane: ${error instanceof Error ? error.message : String(error)}\n`,
			"utf8",
		).catch(() => {
			// Preserve the initial capture failure if the evidence directory is unavailable too.
		});
		return "";
	}
}

/** @param {string} tmuxSession */
export async function killTmuxSession(tmuxSession) {
	await tmux(tmuxSession, ["kill-server"]).catch(() => {
		// The task-owned server may already have exited; cleanup is idempotent.
	});
	const socketPath = launchedSocketPaths.get(tmuxSession);
	if (socketPath === undefined || basename(socketPath) !== tmuxSession) {
		return;
	}
	// Remove only this run's recorded private socket, and only once no server answers on it.
	const serverStopped = await run("tmux", ["-S", socketPath, "list-sessions"]).then(
		() => false,
		() => true,
	);
	if (serverStopped) {
		launchedSocketPaths.delete(tmuxSession);
		await rm(socketPath, { force: true });
	}
}

/** @param {string} value */
function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** @param {{agentDir: string, cwd: string, model: string, sessionId: string, tmuxSession: string, fakeBinDir?: string, fakeStateDir?: string, paneLogPath?: string, piCommand?: string, launchArgs?: readonly string[]}} options */
export async function launchPiInTmux(options) {
	const {
		agentDir,
		cwd,
		fakeBinDir,
		fakeStateDir,
		model,
		paneLogPath,
		sessionId,
		tmuxSession,
		piCommand = "pi",
		launchArgs = buildPiLaunchArgs({ model, sessionId }),
	} = options;
	const environment = [`PI_CODING_AGENT_DIR=${agentDir}`];
	if (fakeStateDir !== undefined && fakeStateDir !== "") {
		environment.push(`AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR=${fakeStateDir}`);
		// The harness outlives both Pi launches, as the simulated daemon does.
		environment.push(`AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_DAEMON_PID=${process.pid}`);
	}
	if (fakeBinDir !== undefined && fakeBinDir !== "") {
		environment.push(`PATH=${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`);
	}
	await killTmuxSession(tmuxSession);
	const { stdout } = await tmux(tmuxSession, [
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{socket_path}",
		"-s",
		tmuxSession,
		"-c",
		cwd,
		"env",
		...environment,
		piCommand,
		...launchArgs,
	]);
	launchedSocketPaths.set(tmuxSession, stdout.trim());
	if (paneLogPath !== undefined && paneLogPath !== "") {
		await mkdir(dirname(paneLogPath), { recursive: true });
		await tmux(tmuxSession, [
			"pipe-pane",
			"-o",
			"-t",
			tmuxActiveTarget(tmuxSession),
			`cat >> ${shellQuote(paneLogPath)}`,
		]);
	}
}

/** @param {string} tmuxSession @param {string} text */
export async function sendLine(tmuxSession, text) {
	const target = tmuxActiveTarget(tmuxSession);
	await tmux(tmuxSession, ["send-keys", "-t", target, "-l", text]);
	await sleep(PROMPT_SUBMIT_PAUSE_MS);
	await tmux(tmuxSession, ["send-keys", "-t", target, "Enter"]);
}
