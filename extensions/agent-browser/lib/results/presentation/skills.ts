import { isRecord } from "../../parsing.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import { getStringField, redactModelFacingText, stringifyModelFacing } from "./common.js";

function formatSkillsListText(skills: readonly unknown[]): string {
	if (skills.length === 0) {
		return "No agent-browser skills found.";
	}
	return skills
		.map((item, index) => {
			if (!isRecord(item)) {
				return `${index + 1}. ${stringifyModelFacing(item)}`;
			}
			const name = redactModelFacingText(getStringField(item, "name") ?? `(skill ${index + 1})`);
			const description = getStringField(item, "description");
			return description !== undefined
				? `${index + 1}. ${name} — ${redactModelFacingText(description)}`
				: `${index + 1}. ${name}`;
		})
		.join("\n");
}

function getSkillContent(data: unknown): string | undefined {
	if (typeof data === "string") {
		return data;
	}
	if (isRecord(data) && typeof data.content === "string") {
		return data.content;
	}
	if (!Array.isArray(data)) {
		return undefined;
	}
	const content = data.flatMap((item) =>
		isRecord(item) && typeof item.content === "string" ? [item.content] : [],
	);
	return content.length > 0 ? content.join("\n\n") : undefined;
}

class SkillShellWords {
	private readonly words: string[] = [];
	private current = "";
	private wordStarted = false;
	private quote: "single" | "double" | undefined;
	private index = 0;
	private readonly input: string;

	constructor(input: string) {
		this.input = input;
	}

	private flush(): void {
		if (this.wordStarted) {
			this.words.push(this.current);
			this.current = "";
			this.wordStarted = false;
		}
	}

	private appendEscape(): void {
		if (this.index + 1 < this.input.length) {
			this.index += 1;
			this.current += this.input[this.index];
		} else {
			this.current += "\\";
		}
	}

	private consumeQuoted(char: string): void {
		const closing = this.quote === "single" ? "'" : '"';
		if (char === closing) {
			this.quote = undefined;
		} else if (this.quote === "double" && char === "\\") {
			this.appendEscape();
		} else {
			this.current += char;
		}
	}

	private consumeUnquoted(char: string): boolean {
		if (char === "'" || char === '"') {
			this.wordStarted = true;
			this.quote = char === "'" ? "single" : "double";
		} else if (char === "\\") {
			this.wordStarted = true;
			this.appendEscape();
		} else if (char === "#" && !this.wordStarted) {
			return false;
		} else if (/\s/.test(char)) {
			this.flush();
		} else {
			this.wordStarted = true;
			this.current += char;
		}
		return true;
	}

	parse(): string[] | undefined {
		for (; this.index < this.input.length; this.index += 1) {
			const char = this.input[this.index];
			if (this.quote !== undefined) {
				this.consumeQuoted(char);
			} else if (!this.consumeUnquoted(char)) {
				break;
			}
		}
		if (this.quote !== undefined) {
			return undefined;
		}
		this.flush();
		return this.words;
	}
}

function formatNativeAgentBrowserCall(args: readonly string[], stdin?: string): string {
	return stdin === undefined
		? `agent_browser { "args": ${JSON.stringify(args)} }`
		: `agent_browser { "args": ${JSON.stringify(args)}, "stdin": ${JSON.stringify(stdin)} }`;
}

function readSkillHeredoc(
	lines: readonly string[],
	startIndex: number,
	delimiter: string,
	stripsLeadingTabs: boolean,
): { readonly stdin: string; readonly endIndex: number } | undefined {
	const stdinLines: string[] = [];
	for (let cursor = startIndex; cursor < lines.length; cursor += 1) {
		const candidate = stripsLeadingTabs ? lines[cursor].replace(/^\t+/, "") : lines[cursor];
		if (candidate === delimiter) {
			return { stdin: stdinLines.join("\n"), endIndex: cursor };
		}
		stdinLines.push(candidate);
	}
	return undefined;
}

function formatNativeSkillContent(content: string): string {
	const lines = content
		.replace(/^allowed-tools:.*agent-browser.*\n?/gim, "")
		.replace(/^```bash\s*$/gim, "```text")
		.split("\n");
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
		const args = new SkillShellWords(argsText).parse();
		if (!args || args.length === 0) {
			output.push(line);
			continue;
		}
		if (!heredocMatch) {
			output.push(`${indent}${formatNativeAgentBrowserCall(args)}`);
			continue;
		}
		const heredoc = readSkillHeredoc(lines, index + 1, heredocMatch[3], heredocMatch[2] === "<<-");
		if (!heredoc) {
			output.push(line);
			continue;
		}
		output.push(`${indent}${formatNativeAgentBrowserCall(args, heredoc.stdin)}`);
		index = heredoc.endIndex;
	}
	return output.join("\n");
}

export function formatSkillsText(commandInfo: CommandInfo, data: unknown): string | undefined {
	if (commandInfo.command !== "skills") {
		return undefined;
	}
	if (commandInfo.subcommand === "path") {
		return typeof data === "string" ? redactModelFacingText(data) : undefined;
	}
	if (commandInfo.subcommand === "list" && Array.isArray(data)) {
		return formatSkillsListText(data);
	}
	const content = getSkillContent(data);
	if (content !== undefined && content.length > 0) {
		const note = [
			"Pi native-tool note: upstream skill text was adapted for this native tool.",
			"Use args for CLI tokens and stdin only for batch, eval --stdin, or auth save --password-stdin; do not pipe heredocs through bash unless the user explicitly asks for a bash workflow.",
		].join("\n");
		return `${note}\n\n${redactModelFacingText(formatNativeSkillContent(content))}`;
	}
	if (typeof data === "string") {
		return redactModelFacingText(formatNativeSkillContent(data));
	}
	return undefined;
}
