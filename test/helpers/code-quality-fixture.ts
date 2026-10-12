import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { prepareQualityChecker } from "../../scripts/prepare-quality-checker.mjs";

export const root = path.resolve(import.meta.dirname, "../..");

// Lint spawns below have a 30 s budget; a cold checker build must finish before any of them.
await prepareQualityChecker();

export function fixture(t: TestContext): string {
	const directory = mkdtempSync(path.join(tmpdir(), "piab-quality-"));
	t.after(() => {
		rmSync(directory, { recursive: true, force: true });
	});
	symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
	cpSync(path.join(root, ".oxlintrc.json"), path.join(directory, ".oxlintrc.json"));
	mkdirSync(path.join(directory, "scripts"));
	for (const file of [
		"code-quality.mjs",
		"code-quality-policy.mjs",
		"code-quality-boundaries.mjs",
	]) {
		cpSync(path.join(root, "scripts", file), path.join(directory, "scripts", file));
	}
	writeFileSync(
		path.join(directory, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ESNext",
				module: "NodeNext",
				strict: true,
				noImplicitReturns: true,
				allowJs: true,
				skipLibCheck: true,
				noEmit: true,
				types: ["node"],
			},
			include: ["*.ts", "*.js", "test/**/*.ts"],
		}),
	);
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
