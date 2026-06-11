/**
 * Purpose: Lock lightweight source import boundaries that protect browser-run orchestration maintainability.
 * Responsibilities: Detect local TypeScript import cycles in the browser-run orchestration subtree.
 * Scope: Static source graph checks only; behavioral coverage lives in focused browser-run tests.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import test from "node:test";

const IMPORT_SPECIFIER_PATTERN = /import(?:[^"']|\n)*?["'](\.{1,2}\/[^"']+)["']/g;

async function collectTypeScriptFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTypeScriptFiles(path)));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

function resolveLocalTypeScriptImport(fromFile: string, specifier: string, knownFiles: Set<string>): string | undefined {
	const resolved = resolve(dirname(fromFile), specifier);
	const candidates = resolved.endsWith(".js")
		? [resolved.slice(0, -3) + ".ts"]
		: [resolved, `${resolved}.ts`, resolve(resolved, "index.ts")];
	return candidates.find((candidate) => knownFiles.has(candidate));
}

async function buildImportGraph(root: string): Promise<Map<string, Set<string>>> {
	const files = await collectTypeScriptFiles(root);
	const knownFiles = new Set(files);
	const graph = new Map<string, Set<string>>();
	for (const file of files) {
		const text = await readFile(file, "utf8");
		const imports = new Set<string>();
		for (const match of text.matchAll(IMPORT_SPECIFIER_PATTERN)) {
			const resolved = resolveLocalTypeScriptImport(file, match[1] ?? "", knownFiles);
			if (resolved) imports.add(resolved);
		}
		graph.set(file, imports);
	}
	return graph;
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
	const cycles: string[][] = [];
	const active = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];

	function visit(file: string): void {
		if (active.has(file)) {
			cycles.push(stack.slice(stack.indexOf(file)).concat(file));
			return;
		}
		if (visited.has(file)) return;
		visited.add(file);
		active.add(file);
		stack.push(file);
		for (const imported of graph.get(file) ?? []) visit(imported);
		stack.pop();
		active.delete(file);
	}

	for (const file of graph.keys()) visit(file);
	return cycles;
}

test("browser-run orchestration modules stay acyclic", async () => {
	const root = resolve("extensions/agent-browser/lib/orchestration/browser-run");
	const cycles = findCycles(await buildImportGraph(root));
	assert.deepEqual(
		cycles.map((cycle) => cycle.map((file) => relative(process.cwd(), file))),
		[],
	);
});
