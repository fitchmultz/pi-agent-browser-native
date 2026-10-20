import assert from "node:assert/strict";
import { readArray, readString } from "./helpers/assertions.js";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, dirname, join } from "node:path";
import test from "node:test";

// Runtime module edges only: `import`/`export` ... from statements and bare side-effect imports.
// `type`-only edges are erased at compile time and cannot create runtime cycles, so they are skipped.
const IMPORT_SPECIFIER_PATTERN =
	/\b(?:import|export)\s*(type\s+)?[^;'"()]*?["'](\.{1,2}\/[^"']+)["']/g;

async function collectTypeScriptFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	const collected = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(root, entry.name);
			if (entry.isDirectory()) {
				return collectTypeScriptFiles(path);
			}
			return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
		}),
	);
	files.push(...collected.flat());
	return files;
}

function resolveLocalTypeScriptImport(
	fromFile: string,
	specifier: string,
	knownFiles: ReadonlySet<string>,
): string | undefined {
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
	const texts = await Promise.all(
		files.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
	);
	for (const { file, text } of texts) {
		const imports = new Set<string>();
		for (const match of text.matchAll(IMPORT_SPECIFIER_PATTERN)) {
			const captures = readArray(match);
			if (typeof captures[1] === "string" && captures[1] !== "") {
				continue;
			}
			const resolved = resolveLocalTypeScriptImport(file, readString(captures[2]), knownFiles);
			if (resolved !== undefined) {
				imports.add(resolved);
			}
		}
		graph.set(file, imports);
	}
	return graph;
}

function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
	const cycles: string[][] = [];
	const active = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];

	function visit(file: string): void {
		if (active.has(file)) {
			cycles.push(stack.slice(stack.indexOf(file)).concat(file));
			return;
		}
		if (visited.has(file)) {
			return;
		}
		visited.add(file);
		active.add(file);
		stack.push(file);
		for (const imported of graph.get(file) ?? []) {
			visit(imported);
		}
		stack.pop();
		active.delete(file);
	}

	for (const file of graph.keys()) {
		visit(file);
	}
	return cycles;
}

test("browser-run orchestration modules stay acyclic", async (t) => {
	const fixture = await mkdtemp(join(tmpdir(), "piab-import-cycle-"));
	t.after(() => rm(fixture, { recursive: true, force: true }));
	await writeFile(join(fixture, "a.ts"), 'import "./b.js"; export const value = 1;');
	await writeFile(join(fixture, "b.ts"), 'export { value } from "./a.js";');
	assert.deepEqual(
		findCycles(await buildImportGraph(fixture)).map((cycle) =>
			cycle.map((path) => relative(fixture, path)),
		),
		[["a.ts", "b.ts", "a.ts"]],
		"runtime import and re-export cycles must be detected",
	);
	await writeFile(
		join(fixture, "a.ts"),
		'import type { Value } from "./b.js"; export type Value = string;',
	);
	await writeFile(join(fixture, "b.ts"), 'export type { Value } from "./a.js";');
	assert.deepEqual(
		findCycles(await buildImportGraph(fixture)),
		[],
		"erased type-only imports and re-exports cannot create runtime cycles",
	);
	const root = resolve("extensions/agent-browser/lib/orchestration/browser-run");
	const graph = await buildImportGraph(root);
	const cycles = findCycles(graph);
	assert.deepEqual(
		cycles.map((cycle) => cycle.map((file) => relative(process.cwd(), file))),
		[],
	);
});
