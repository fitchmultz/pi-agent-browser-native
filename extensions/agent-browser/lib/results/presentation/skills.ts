/**
 * Purpose: Render upstream agent-browser skills output as native pi tool guidance.
 * Responsibilities: Format skills list/path/get results and translate agent-browser shell snippets to agent_browser tool calls.
 * Scope: Skills command presentation only.
 */

import { isRecord } from "../../parsing.js";
import type { CommandInfo } from "../../runtime.js";
import { getStringField, redactModelFacingText, stringifyModelFacing } from "./common.js";

function formatSkillsListText(skills: unknown[]): string {
	if (skills.length === 0) return "No agent-browser skills found.";
	return skills
		.map((item, index) => {
			if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
			const name = redactModelFacingText(getStringField(item, "name") ?? `(skill ${index + 1})`);
			const description = getStringField(item, "description");
			return description ? `${index + 1}. ${name} — ${redactModelFacingText(description)}` : `${index + 1}. ${name}`;
		})
		.join("\n");
}

function getSkillContent(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (isRecord(data) && typeof data.content === "string") return data.content;
	if (!Array.isArray(data)) return undefined;
	const content = data.flatMap((item) => (isRecord(item) && typeof item.content === "string" ? [item.content] : []));
	return content.length > 0 ? content.join("\n\n") : undefined;
}

function splitShellWords(input: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: 'single' | 'double' | undefined;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quote === "single") {
			if (char === "'") quote = undefined;
			else current += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = undefined;
			else if (char === "\\" && index + 1 < input.length) {
				index += 1;
				current += input[index];
			} else current += char;
			continue;
		}
		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (char === "\\" && index + 1 < input.length) {
			index += 1;
			current += input[index];
			continue;
		}
		if (char === "#" && current.length === 0) {
			break;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) return undefined;
	if (current.length > 0) words.push(current);
	return words;
}

function formatNativeAgentBrowserCall(args: string[], stdin?: string): string {
	return stdin === undefined
		? `agent_browser { "args": ${JSON.stringify(args)} }`
		: `agent_browser { "args": ${JSON.stringify(args)}, "stdin": ${JSON.stringify(stdin)} }`;
}

function formatNativeSkillContent(content: string): string {
	const lines = content.replace(/^allowed-tools:.*agent-browser.*\n?/gim, "").replace(/^```bash\s*$/gim, "```text").split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const commandMatch = /^(\s*)agent-browser\s+(.+?)\s*$/.exec(line);
		if (!commandMatch) {
			output.push(line);
			continue;
		}
		const indent = commandMatch[1];
		const rawArgsText = commandMatch[2];
		const heredocMatch = /^(.*?)\s+(<<-?)['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/.exec(rawArgsText);
		const argsText = heredocMatch?.[1] ?? rawArgsText;
		const args = splitShellWords(argsText);
		if (!args || args.length === 0) {
			output.push(line);
			continue;
		}
		if (!heredocMatch) {
			output.push(`${indent}${formatNativeAgentBrowserCall(args)}`);
			continue;
		}
		const stripsLeadingTabs = heredocMatch[2] === "<<-";
		const delimiter = heredocMatch[3];
		const stdinLines: string[] = [];
		let cursor = index + 1;
		while (cursor < lines.length) {
			const candidate = stripsLeadingTabs ? lines[cursor].replace(/^\t+/, "") : lines[cursor];
			if (candidate === delimiter) break;
			stdinLines.push(candidate);
			cursor += 1;
		}
		if (cursor >= lines.length) {
			output.push(line);
			continue;
		}
		output.push(`${indent}${formatNativeAgentBrowserCall(args, stdinLines.join("\n"))}`);
		index = cursor;
	}
	return output.join("\n");
}

export function formatSkillsText(commandInfo: CommandInfo, data: unknown): string | undefined {
	if (commandInfo.command !== "skills") return undefined;
	if (commandInfo.subcommand === "path") return typeof data === "string" ? redactModelFacingText(data) : undefined;
	if (commandInfo.subcommand === "list" && Array.isArray(data)) return formatSkillsListText(data);
	const content = getSkillContent(data);
	if (content) {
		const note = [
			"Pi native-tool note: upstream skill text was adapted for this native tool.",
			"Use args for CLI tokens and stdin only for batch, eval --stdin, or auth save --password-stdin; do not pipe heredocs through bash unless the user explicitly asks for a bash workflow.",
		].join("\n");
		return `${note}\n\n${redactModelFacingText(formatNativeSkillContent(content))}`;
	}
	if (typeof data === "string") return redactModelFacingText(formatNativeSkillContent(data));
	return undefined;
}
