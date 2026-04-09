/**
 * Purpose: Execute the upstream agent-browser binary for the pi-agent-browser extension.
 * Responsibilities: Spawn the agent-browser subprocess without a shell, stream optional stdin, collect stdout/stderr, and honor abort signals.
 * Scope: Process execution only; argument planning, output formatting, and pi tool registration live elsewhere.
 * Usage: Called by the extension tool after argument validation and session planning are complete.
 * Invariants/Assumptions: The binary name is always `agent-browser`, the wrapper never shells out, and callers handle semantic success/error interpretation.
 */

import { spawn } from "node:child_process";
import { env as processEnv } from "node:process";

export interface ProcessRunResult {
	aborted: boolean;
	exitCode: number;
	spawnError?: Error;
	stderr: string;
	stdout: string;
}

export async function runAgentBrowserProcess(options: {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	stdin?: string;
}): Promise<ProcessRunResult> {
	const { args, cwd, env, signal, stdin } = options;

	return await new Promise<ProcessRunResult>((resolve) => {
		let aborted = false;
		let settled = false;
		let spawnError: Error | undefined;
		let stderr = "";
		let stdout = "";
		let killTimer: NodeJS.Timeout | undefined;

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (killTimer) {
				clearTimeout(killTimer);
			}
			resolve({ aborted, exitCode, spawnError, stderr, stdout });
		};

		const child = spawn("agent-browser", args, {
			cwd,
			env: { ...processEnv, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const abortChild = () => {
			aborted = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2_000);
		};

		child.once("error", (error) => {
			spawnError = error instanceof Error ? error : new Error(String(error));
			finish(127);
		});
		child.once("close", (code) => {
			finish(code ?? (spawnError ? 127 : 0));
		});
		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		if (signal) {
			if (signal.aborted) {
				abortChild();
			} else {
				signal.addEventListener("abort", abortChild, { once: true });
			}
		}

		if (stdin) {
			child.stdin.write(stdin);
		}
		child.stdin.end();
	});
}
