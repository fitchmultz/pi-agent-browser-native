import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SourceInfo } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./parsing.js";
import { getBrowserResultMessage } from "./browser-transcript.js";
import { getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";

function isDirectoryOwner(source: SourceInfo): boolean {
	if (/^(?:npm:pi-change-working-dir|git:github\.com\/fitchmultz\/pi-change-working-dir(?:\.git)?)(?:@.+)?$/.test(source.source)) return true;
	const directories = [source.baseDir, isAbsolute(source.path) ? dirname(source.path) : undefined];
	return directories.some(directory => {
		if (!directory || !isAbsolute(directory)) return false;
		try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "pi-change-working-dir"; }
		catch { return false; }
	});
}

/** The synchronous owner reply is captured before any browser policy, queue, or child await. */
export function resolveExecutionCwd(pi: Pick<ExtensionAPI, "events" | "getAllTools" | "getCommands">, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	const request: { sessionManager: ExtensionContext["sessionManager"]; result?: unknown } = { sessionManager: ctx.sessionManager };
	pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
	const result = request.result;
	if (result !== undefined) {
		const invalid = "pi-change-working-dir returned an invalid execution directory. Update the extension and restart Pi.";
		if (!isRecord(result) || Array.isArray(result)) throw new Error(invalid);
		if (result.error !== undefined) throw new Error(typeof result.error === "string" && result.error.length > 0 ? result.error : invalid);
		if (typeof result.cwd !== "string" || !isAbsolute(result.cwd) || result.cwd.includes("\0")) throw new Error(invalid);
		return result.cwd;
	}
	if (pi.getAllTools().some(tool => tool.name === "change_dir" && isDirectoryOwner(tool.sourceInfo))
		|| pi.getCommands().some(command => /^cwd(?::\d+)?$/.test(command.name) && isDirectoryOwner(command.sourceInfo))) {
		throw new Error("Update pi-change-working-dir and restart Pi to use agent_browser with the selected working directory.");
	}
	return ctx.cwd;
}

export function getBrowserCwdError(cwd: string): string | undefined {
	try { if (statSync(cwd).isDirectory()) return undefined; }
	catch (error) {
		if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	return `Browser launch directory is unavailable: ${cwd}. Restore that directory, or explicitly use sessionMode: "fresh" without --session, or --config from the selected execution directory. The existing browser was left untouched.`;
}

export function restoreManagedSessionCwd(branch: unknown[], sessionName: string, namespace: string | undefined, fallback: string): string {
	const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
	for (const entry of [...branch].reverse()) {
		const message = getBrowserResultMessage(entry);
		if (!message) continue;
		const details = message.details;
		if (!isRecord(details) || typeof details.sessionName !== "string" || typeof details.managedSessionCwd !== "string" || !isAbsolute(details.managedSessionCwd)) continue;
		if (getAgentBrowserSessionIdentityKey(details.sessionName, typeof details.namespace === "string" ? details.namespace : undefined) === key) return details.managedSessionCwd;
	}
	return fallback;
}
