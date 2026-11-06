import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export const root = path.resolve(import.meta.dirname, "../..");

export function fixture(t: TestContext): string {
	const directory = mkdtempSync(path.join(tmpdir(), "piab-quality-"));
	t.after(() => {
		rmSync(directory, { recursive: true, force: true });
	});
	symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
	for (const file of [
		".oxlintrc.json",
		".oxfmtrc.json",
		".gitignore",
		"package.json",
		"tsconfig.json",
	]) {
		cpSync(path.join(root, file), path.join(directory, file));
	}
	mkdirSync(path.join(directory, "docs"));
	cpSync(
		path.join(root, "docs/Strict-Oxlint-Oxfmt-Engineering-Guide.md"),
		path.join(directory, "docs/Strict-Oxlint-Oxfmt-Engineering-Guide.md"),
	);
	mkdirSync(path.join(directory, "scripts"));
	for (const file of [
		"code-quality.mjs",
		"code-quality-policy.mjs",
		"quality-exceptions.mjs",
		"oxlint.mjs",
	]) {
		cpSync(path.join(root, "scripts", file), path.join(directory, "scripts", file));
	}
	writeFileSync(path.join(directory, "tsconfig.build.json"), '{"extends":"./tsconfig.json"}\n');
	writeFileSync(
		path.join(directory, "tsconfig.declarations.json"),
		JSON.stringify({
			extends: "./tsconfig.json",
			compilerOptions: { skipLibCheck: false },
			include: ["**/*.d.ts"],
		}),
	);
	writeFileSync(path.join(directory, "contract.d.ts"), "export declare const marker: string;\n");
	const initialized = spawnSync("git", ["init", "--quiet"], { cwd: directory, encoding: "utf8" });
	assert.equal(initialized.error, undefined);
	assert.equal(initialized.status, 0, initialized.stderr);
	return directory;
}

export function run(
	directory: string,
	command: string,
	args: readonly string[],
	env: Readonly<NodeJS.ProcessEnv> = {},
): SpawnSyncReturns<string> {
	const result = spawnSync(process.execPath, [command, ...args], {
		cwd: directory,
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, ...env },
	});
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	return result;
}

export function lint(
	directory: string,
	expectedCodes: readonly string[] = [],
	env: Readonly<NodeJS.ProcessEnv> = {},
): SpawnSyncReturns<string> & {
	readonly diagnosticCount: number;
	readonly diagnosticLocations: readonly {
		readonly code: string;
		readonly filename: string;
		readonly line: number;
	}[];
} {
	const result = run(directory, path.join(root, "scripts/oxlint.mjs"), ["--format=json", "."], env);
	assert.match(result.stdout, /^\{/u, result.stderr);
	const output: unknown = JSON.parse(result.stdout);
	assert.ok(output !== null && typeof output === "object" && "diagnostics" in output);
	assert.ok(Array.isArray(output.diagnostics));
	const codes = new Set<string>();
	const locations = [];
	for (const item of output.diagnostics) {
		const location = diagnosticLocation(item);
		codes.add(location.code);
		locations.push(location);
	}
	assert.deepEqual([...codes].sort(), [...expectedCodes].sort(), result.stdout);
	locations.sort((a, b) => {
		const fileOrder = a.filename.localeCompare(b.filename);
		if (fileOrder !== 0) {
			return fileOrder;
		}
		if (a.line !== b.line) {
			return a.line - b.line;
		}
		return a.code.localeCompare(b.code);
	});
	return { ...result, diagnosticCount: output.diagnostics.length, diagnosticLocations: locations };
}

function diagnosticLocation(value: unknown) {
	assert.ok(value !== null && typeof value === "object");
	assert.ok("code" in value && typeof value.code === "string");
	assert.ok("filename" in value && typeof value.filename === "string");
	assert.ok("labels" in value && Array.isArray(value.labels));
	const label: unknown = value.labels[0];
	assert.ok(label !== null && typeof label === "object" && "span" in label);
	const span: unknown = label.span;
	assert.ok(span !== null && typeof span === "object" && "line" in span);
	assert.ok(typeof span.line === "number" && span.line > 0);
	return { code: value.code, filename: value.filename, line: span.line };
}
