import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const EXTENSION_ROOT = "extensions/agent-browser";
const HEAVY_RUNTIME_IMPORT_PATTERN = /^\s*import\s+(?!type\b)[^;]*from\s+["'](@earendil-works\/pi-(?:ai|coding-agent)|typebox)["'];/gm;

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(entries.map(async (entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectTypeScriptFiles(path);
		return entry.isFile() && path.endsWith(".ts") ? [path] : [];
	}));
	return files.flat();
}

test("agent_browser startup avoids heavy schema and pi runtime imports", async () => {
	const offenders: string[] = [];
	for (const path of await collectTypeScriptFiles(EXTENSION_ROOT)) {
		const source = await readFile(path, "utf8");
		for (const match of source.matchAll(HEAVY_RUNTIME_IMPORT_PATTERN)) {
			offenders.push(`${path}: runtime import from ${match[1]}`);
		}
	}

	assert.deepEqual(offenders, [], "use type-only imports or local lightweight helpers for TypeBox/pi runtime startup paths");
});
