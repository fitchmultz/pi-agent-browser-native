/** Native tmux transport and lifecycle prompt submission. */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import { sleep } from "./lifecycle-transcript.mjs";

const execFile = promisify(execFileCallback);
const PROMPT_SUBMIT_PAUSE_MS = 250;

export function createLifecycleSessionId(pid = process.pid) {
	return `piab-lifecycle-${pid}`;
}

export function buildPiLaunchArgs({ model, sessionId }) {
	return ["--approve", "--model", model, "--session-id", sessionId];
}

export function tmuxActiveTarget(tmuxSession) {
	return `${tmuxSession}:`;
}

async function run(command, args, options = {}) {
	return execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options });
}

// A task-owned server starts from this process, so Pi inherits its environment, including provider
// credentials; a server that is already running would supply its own global environment instead.
function tmux(tmuxSession, args) {
	return run("tmux", ["-L", tmuxSession, ...args]);
}

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

export function paneLooksReady(pane) {
	return /\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kKmMgG]/.test(pane) && !/Working[.…]*/i.test(pane);
}

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

export async function killTmuxSession(tmuxSession) {
	await tmux(tmuxSession, ["kill-server"]).catch(() => {
		// The task-owned server may already have exited; cleanup is idempotent.
	});
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export async function launchPiInTmux(options) {
	const { agentDir, cwd, fakeBinDir, fakeStateDir, model, paneLogPath, sessionId, tmuxSession } =
		options;
	await killTmuxSession(tmuxSession);
	await tmux(tmuxSession, [
		"new-session",
		"-d",
		"-s",
		tmuxSession,
		"-c",
		cwd,
		"env",
		`PI_CODING_AGENT_DIR=${agentDir}`,
		`AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR=${fakeStateDir}`,
		`PATH=${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
		"pi",
		...buildPiLaunchArgs({ model, sessionId }),
	]);
	if (paneLogPath) {
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

export async function sendLine(tmuxSession, text) {
	const target = tmuxActiveTarget(tmuxSession);
	await tmux(tmuxSession, ["send-keys", "-t", target, "-l", text]);
	await sleep(PROMPT_SUBMIT_PAUSE_MS);
	await tmux(tmuxSession, ["send-keys", "-t", target, "Enter"]);
}
