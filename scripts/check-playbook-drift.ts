#!/usr/bin/env tsx
/**
 * Purpose: Prevent drift between the canonical agent_browser playbook and checked-in README/docs fragments.
 * Responsibilities: Render marked Markdown blocks from canonical playbook constants, update them in write mode, and fail verification when checked-in docs are stale.
 * Scope: Documentation synchronization only; it does not inspect upstream agent-browser help or execute browser commands.
 * Usage: Run `npm run docs -- playbook check` in local verification or `npm run docs -- playbook write` after editing the canonical playbook.
 * Invariants/Assumptions: Generated blocks are bounded by stable HTML comments and all source text comes from extensions/agent-browser/lib/playbook.ts.
 */

import { readFile, writeFile } from "node:fs/promises";

import {
	INSPECTION_TOOL_CALL_EXAMPLES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";

type Mode = "check" | "write";
type BlockId = "inspection" | "shared-guidelines" | "wrapper-tab-recovery";

type Target = {
	path: string;
	blocks: BlockId[];
};

const TARGETS: Target[] = [
	{ path: "README.md", blocks: ["inspection", "wrapper-tab-recovery"] },
	{ path: "docs/COMMAND_REFERENCE.md", blocks: ["inspection", "wrapper-tab-recovery"] },
	{ path: "docs/TOOL_CONTRACT.md", blocks: ["shared-guidelines", "wrapper-tab-recovery", "inspection"] },
];

const GENERATED_NOTICE = "<!-- Generated from extensions/agent-browser/lib/playbook.ts. Run `npm run docs -- playbook write` to update. -->";

function printHelp(): void {
	console.log(`Usage: tsx ./scripts/check-playbook-drift.ts [--check|--write]

Checks or rewrites generated Markdown blocks sourced from the canonical agent_browser playbook.

Options:
  --check     Verify checked-in generated blocks match the canonical playbook (default)
  --write     Rewrite generated blocks in-place
  -h, --help  Show this help

Examples:
  npm run docs -- playbook check
  npm run docs -- playbook write

Exit codes:
  0  generated blocks match, write completed, or help was shown
  1  drift found, invalid arguments, missing markers, or file update failed`);
}

function parseMode(argv: string[]): Mode | "help" {
	if (argv.length === 0) return "check";
	if (argv.length === 1 && argv[0] === "--check") return "check";
	if (argv.length === 1 && argv[0] === "--write") return "write";
	if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) return "help";
	throw new Error(`Invalid arguments: ${argv.join(" ")}`);
}

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

function renderBlock(id: BlockId): string {
	switch (id) {
		case "inspection":
			return [
				"Native inspection calls use the `agent_browser` tool shape, not shell-like direct-binary commands:",
				"",
				bullets(INSPECTION_TOOL_CALL_EXAMPLES),
				"",
				"These calls return plain text and stay stateless: the extension does not inject its implicit session and does not let inspection consume the managed-session slot needed for later profile, session, CDP, state, or auto-connect launches.",
			].join("\n");
		case "shared-guidelines":
			return bullets(SHARED_BROWSER_PLAYBOOK_GUIDELINES);
		case "wrapper-tab-recovery":
			return bullets(WRAPPER_TAB_RECOVERY_BEHAVIOR);
	}
}

function markedBlock(id: BlockId): string {
	return [`<!-- agent-browser-playbook:start ${id} -->`, GENERATED_NOTICE, renderBlock(id), `<!-- agent-browser-playbook:end ${id} -->`].join("\n");
}

function replaceBlock(content: string, id: BlockId, path: string): { next: string; drifted: boolean } {
	const start = `<!-- agent-browser-playbook:start ${id} -->`;
	const end = `<!-- agent-browser-playbook:end ${id} -->`;
	const startIndex = content.indexOf(start);
	const endIndex = content.indexOf(end);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		throw new Error(`${path} is missing generated block markers for ${id}`);
	}
	const afterEndIndex = endIndex + end.length;
	const current = content.slice(startIndex, afterEndIndex);
	const expected = markedBlock(id);
	return {
		next: `${content.slice(0, startIndex)}${expected}${content.slice(afterEndIndex)}`,
		drifted: current !== expected,
	};
}

async function processTarget(target: Target, mode: Mode): Promise<string[]> {
	let content = await readFile(target.path, "utf8");
	const staleBlocks: string[] = [];
	for (const block of target.blocks) {
		const result = replaceBlock(content, block, target.path);
		content = result.next;
		if (result.drifted) staleBlocks.push(`${target.path}#${block}`);
	}
	if (mode === "write" && staleBlocks.length > 0) {
		await writeFile(target.path, content, "utf8");
	}
	return staleBlocks;
}

async function main(): Promise<void> {
	const mode = parseMode(process.argv.slice(2));
	if (mode === "help") {
		printHelp();
		return;
	}
	const staleBlocks = (await Promise.all(TARGETS.map((target) => processTarget(target, mode)))).flat();
	if (staleBlocks.length === 0) {
		console.log(`agent_browser playbook docs are ${mode === "check" ? "in sync" : "up to date"}.`);
		return;
	}
	if (mode === "write") {
		console.log(`Updated generated playbook blocks:\n${staleBlocks.map((block) => `- ${block}`).join("\n")}`);
		return;
	}
	throw new Error(`Generated playbook blocks are stale. Run \`npm run docs -- playbook write\`.\n${staleBlocks.map((block) => `- ${block}`).join("\n")}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
