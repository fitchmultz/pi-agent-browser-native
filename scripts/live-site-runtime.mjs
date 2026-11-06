/** Owns the isolated Pi process, observed session, and browser cleanup for real-site checks. */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	agentBrowserResults,
	readEntries,
	record,
	resultText,
	sessionHeaderId,
	waitFor,
	waitForAgentBrowserResult,
} from "./lifecycle-transcript.mjs";
import { capturePane, killTmuxSession, launchPiInTmux, sendLine } from "./lifecycle-tmux.mjs";

/** @import {LifecycleToolResult} from "./lifecycle-transcript.mjs" */
/** @typedef {{description: string, tool: string, input: Readonly<Record<string, unknown>>, predicate: (result: LifecycleToolResult) => boolean, suffix?: string}} LivePrompt */

const execFile = promisify(execFileCallback);

/** @param {{sessionFile: string, toolCallId: string, timeoutMs: number}} options */
async function awaitFinal({ sessionFile, toolCallId, timeoutMs }) {
	return waitFor({
		describe: `final response after ${toolCallId}`,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			const index = entries.findIndex((entry) => {
				const row = record(entry);
				return row?.type === "message" && record(row.message)?.toolCallId === toolCallId;
			});
			if (index < 0) {
				return;
			}
			const final = entries
				.slice(index + 1)
				.map(record)
				.find((entry) => {
					const message = record(entry?.message);
					return (
						entry?.type === "message" &&
						message?.role === "assistant" &&
						message.stopReason === "stop"
					);
				});
			return final === undefined ? undefined : { entries, text: resultText(final.message) };
		},
	});
}

export class LiveSiteRun {
	/** @type {string | undefined} */
	#sessionFile;
	#closed = false;

	/** @param {{outputDir: string, socketDir: string, model: string, timeoutMs: number}} options */
	constructor({ outputDir, socketDir, model, timeoutMs }) {
		this.outputDir = outputDir;
		this.socketDir = socketDir;
		this.model = model;
		this.timeoutMs = timeoutMs;
		this.sessionId = `piab-live-${process.pid}`;
		this.tmuxSession = this.sessionId;
		this.agentDir = join(outputDir, "agent");
		this.sessionDir = join(outputDir, "sessions");
	}

	get sessionFile() {
		return this.#sessionFile;
	}

	/** @param {LivePrompt} options @returns {Promise<import("./lifecycle-transcript.mjs").LifecycleResultReport & {result: LifecycleToolResult & {toolCallId: string}, finalText: string}>} */
	async prompt({ description, tool, input, predicate, suffix = "Briefly report the result." }) {
		const before = this.#sessionFile === undefined ? [] : await readEntries(this.#sessionFile);
		const count = agentBrowserResults(before).length;
		console.log(`→ ${description}`);
		await sendLine(
			this.tmuxSession,
			`Use exactly one ${tool} tool call with input ${JSON.stringify(input)}. Do not use bash. ${suffix}`,
		);
		const observed = await waitForAgentBrowserResult({
			describe: description,
			...(this.#sessionFile === undefined ? {} : { sessionFile: this.#sessionFile }),
			sessionDir: this.sessionDir,
			timeoutMs: this.timeoutMs,
			sinceCount: count,
			predicate: (result) => result.toolName === tool && predicate(result),
		});
		this.#sessionFile = observed.sessionFile;
		assert.equal(sessionHeaderId(observed.entries), this.sessionId, "Unexpected Pi session");
		const { toolCallId } = observed.result;
		assert.ok(typeof toolCallId === "string", "Missing browser tool call identity");
		const final = await awaitFinal({
			sessionFile: observed.sessionFile,
			toolCallId,
			timeoutMs: this.timeoutMs,
		});
		assert.equal(
			agentBrowserResults(final.entries).length,
			count + 1,
			"Prompt made unexpected browser calls",
		);
		return {
			...observed,
			result: { ...observed.result, toolCallId },
			entries: final.entries,
			finalText: final.text,
		};
	}

	/** @param {string} sessionName */
	async close(sessionName) {
		const closed = await this.prompt({
			description: "close the owned browser",
			tool: "agent_browser",
			input: { args: ["close"] },
			predicate: (result) =>
				result.isError === false &&
				result.details?.resultCategory === "success" &&
				result.details.command === "close",
		});
		assert.equal(
			closed.result.details?.sessionName,
			sessionName,
			"Browser session changed during the smoke",
		);
		assert.equal(record(closed.result.details.managedSessionOutcome)?.status, "closed");
		this.#closed = true;
	}

	/** @param {string} extensionPath */
	async launch(extensionPath) {
		const configuredPi = process.env.PIAB_LIVE_PI;
		await launchPiInTmux({
			agentDir: this.agentDir,
			tmuxSession: this.tmuxSession,
			sessionId: this.sessionId,
			cwd: process.cwd(),
			model: this.model,
			piCommand: configuredPi === undefined || configuredPi === "" ? "pi" : configuredPi,
			paneLogPath: join(this.outputDir, "pane-stream.txt"),
			launchArgs: [
				"--approve",
				"--no-extensions",
				"--no-skills",
				"-e",
				extensionPath,
				"--tools",
				"agent_browser,agent_browser_code",
				"--model",
				this.model,
				"--session-id",
				this.sessionId,
			],
		});
	}

	async cleanup() {
		await capturePane(this.tmuxSession, join(this.outputDir, "final-pane.txt"));
		await killTmuxSession(this.tmuxSession);
		if (!this.#closed) {
			// This run creates its socket directory exclusively; cleanup cannot reach another browser.
			await execFile("agent-browser", ["--json", "close", "--all"], {
				env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: this.socketDir },
			});
		}
		await rm(this.socketDir, { recursive: true, force: true });
	}
}

/** @param {{model: string, timeoutMs: number}} options */
export async function createLiveSiteRun(options) {
	const configuredOutput = process.env.PIAB_LIVE_OUTPUT;
	const outputDir = resolve(
		configuredOutput === undefined || configuredOutput === ""
			? await mkdtemp("/tmp/piab-live-evidence-")
			: configuredOutput,
	);
	const socketDir = await mkdtemp("/tmp/pb-");
	const runtime = new LiveSiteRun({ ...options, outputDir, socketDir });
	await mkdir(runtime.agentDir, { recursive: true });
	await mkdir(runtime.sessionDir, { recursive: true });
	await writeFile(
		join(runtime.agentDir, "settings.json"),
		JSON.stringify(
			{
				sessionDir: runtime.sessionDir,
				packages: [],
				extensions: [],
				skills: [],
				prompts: [],
				themes: [],
			},
			null,
			2,
		),
	);
	process.env.PI_AGENT_BROWSER_SOCKET_DIR = socketDir;
	return runtime;
}
