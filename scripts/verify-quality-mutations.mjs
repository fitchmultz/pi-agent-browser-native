#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	cpSync,
	mkdtempDisposableSync,
	openSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

/** @typedef {{name: string, file: string, text?: string, stage: (label: string) => boolean, diagnostic: RegExp, evidencePath?: string}} QualityMutation */
/** @typedef {{status: number, output: string}} ChildResult */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".git", "node_modules", "dist", ".artifacts", ".crabbox", ".cueloop"]);
const retainedMutationTests = new Set([
	"test/code-quality.test.ts",
	"test/agent-browser.prompt-policy.serial.test.ts",
]);
/** @param {string} label */
const lintStage = (label) => label.endsWith("scripts/code-quality.mjs lint");
const testCommand =
	`${process.execPath} ${fileURLToPath(import.meta.resolve("tsx/cli"))} --test test/**/!(*.serial).test.ts`.replaceAll(
		"\\",
		"/",
	);
/** @param {string} label */
const contractStage = (label) => label === testCommand;
/** @type {readonly QualityMutation[]} */
const mutations = [
	{
		name: "syntax",
		file: "test/helpers/quality-mutation.ts",
		text: "export function compare(left: string, right: string): boolean {\n  return left == right;\n}\n",
		stage: lintStage,
		diagnostic: /eslint\(eqeqeq\)/u,
	},
	{
		name: "semantic",
		file: "test/helpers/quality-mutation.ts",
		text: "declare function operation(): Promise<number>;\noperation();\n",
		stage: lintStage,
		diagnostic: /typescript\(no-floating-promises\)/u,
	},
	{
		name: "compiler",
		file: "test/helpers/quality-mutation.ts",
		text: "export const value: number = 'wrong';\n",
		stage: (label) => /\/tsc(?:\.cmd)? --noEmit$/u.test(label),
		diagnostic: /quality-mutation\.ts\(1,14\): error TS2322:/u,
	},
	{
		name: "format",
		file: "quality-format-mutation.json",
		text: '{"format":"not formatted"}',
		stage: (label) => /\/oxfmt(?:\.cmd)? --check \.$/u.test(label),
		diagnostic: /quality-format-mutation\.json/u,
	},
	{
		name: "test",
		file: "test/quality-mutation.test.ts",
		text: "import assert from 'node:assert/strict';\nimport nodeTest from 'node:test';\nnodeTest('quality aggregate rejects a failed assertion', () => { assert.equal(1, 2); });\n",
		stage: contractStage,
		diagnostic: /ERR_ASSERTION/u,
	},
	{
		name: "allowance-isolation",
		file: ".oxlintrc.json",
		stage: contractStage,
		diagnostic:
			/(?:not ok \d+ - |✖ )QX-001 admits actual registrations but rejects wrong origins and floating body work/u,
		evidencePath: "test/code-quality.test.ts",
	},
];

/** @param {string} text */
function forLog(text) {
	return text.replace(
		/^.{2001,}$/gmu,
		(/** @type {string} */ line) =>
			`${line.slice(0, 2000)}… [${line.length - 2000} more characters]`,
	);
}

/** @param {string} file */
function includeInMutationCopy(file) {
	const rel = path.relative(root, file).replaceAll("\\", "/");
	if (rel === "") {
		return true;
	}
	const [top] = rel.split("/");
	if (top !== undefined && excluded.has(top)) {
		return false;
	}
	if (path.posix.matchesGlob(rel, "test/**/*.test.ts")) {
		return retainedMutationTests.has(rel);
	}
	return true;
}

/** @param {string} directory @param {readonly string[]} args @returns {Promise<ChildResult>} */
async function runNode(directory, args) {
	using logs = mkdtempDisposableSync(path.join(tmpdir(), "piab-quality-output-"));
	const log = path.join(logs.path, "output.txt");
	const fd = openSync(log, "w");
	/** @type {unknown[]} */
	let closed = [];
	/** @type {Error | undefined} */
	let spawnError;
	try {
		// One native descriptor preserves stage boundaries across stdout and stderr.
		const child = spawn(process.execPath, args, {
			cwd: directory,
			timeout: 1_200_000,
			stdio: ["ignore", fd, fd],
		});
		closed = await once(child, "close");
	} catch (error) {
		spawnError = error instanceof Error ? error : new Error(String(error));
	} finally {
		closeSync(fd);
	}
	const output = stripVTControlCharacters(readFileSync(log, "utf8"));
	if (spawnError !== undefined) {
		console.error(forLog(output));
		throw spawnError;
	}
	const [status, signal] = closed;
	if (signal !== null || typeof status !== "number") {
		console.error(forLog(output));
		throw new Error(`Quality child did not complete: ${String(signal)}`);
	}
	return { status, output };
}

/** @param {string} directory */
function acceptance(directory) {
	return runNode(directory, ["scripts/project.mjs", "verify", "quality"]);
}

/** @param {string} directory @param {QualityMutation} mutation */
async function applyMutation(directory, mutation) {
	const file = path.join(directory, mutation.file);
	if (mutation.text !== undefined) {
		writeFileSync(file, mutation.text);
	} else {
		const source = readFileSync(file, "utf8");
		const anchor = '"allowForKnownSafePromises": []';
		assert.ok(source.includes(anchor), "Missing native Promise allowance option");
		writeFileSync(
			file,
			source.replaceAll(anchor, '"allowForKnownSafePromises": [{"from":"lib","name":"Promise"}]'),
		);
	}
	if (mutation.name !== "format") {
		const formatter = await runNode(directory, [
			path.join(directory, "node_modules", "oxfmt", "bin", "oxfmt"),
			"--write",
			mutation.file,
		]);
		if (formatter.status !== 0) {
			throw new Error(`Mutation formatting failed:\n${forLog(formatter.output)}`);
		}
	}
}

/** @param {ChildResult} result @param {QualityMutation} mutation */
function verifyRejection(result, mutation) {
	const stages = [...result.output.matchAll(/^> (.+)$/gmu)];
	const stageIndex = stages.findIndex((stage) =>
		mutation.stage((stage[1] ?? "").replaceAll("\\", "/")),
	);
	const stage = stages[stageIndex];
	const nextStage = stages[stageIndex + 1];
	const output =
		stage === undefined ? "" : forLog(result.output.slice(stage.index, nextStage?.index));
	if (
		result.status === 0 ||
		stage === undefined ||
		!mutation.diagnostic.test(output) ||
		!output.replaceAll("\\", "/").includes(mutation.evidencePath ?? mutation.file)
	) {
		throw new Error(
			`${mutation.name} did not fail at its expected stage/diagnostic:\n${forLog(result.output)}`,
		);
	}
}

/** @param {QualityMutation} mutation */
async function verifyMutation(mutation) {
	using directory = mkdtempDisposableSync(path.join(tmpdir(), "piab-quality-mutation-"));
	cpSync(root, directory.path, {
		recursive: true,
		filter: includeInMutationCopy,
	});
	symlinkSync(
		path.join(root, "node_modules"),
		path.join(directory.path, "node_modules"),
		"junction",
	);
	const initialized = spawnSync("git", ["init", "--quiet"], {
		cwd: directory.path,
		encoding: "utf8",
	});
	assert.equal(initialized.error, undefined);
	assert.equal(initialized.status, 0, initialized.stderr);
	await applyMutation(directory.path, mutation);
	const result = await acceptance(directory.path);
	verifyRejection(result, mutation);
	if (mutation.name === "allowance-isolation") {
		verifyRejection(result, {
			name: "policy",
			file: mutation.file,
			stage: lintStage,
			diagnostic: /Oxlint policy differs from guide and repository mappings/u,
			evidencePath: "scripts/code-quality.mjs",
		});
	}
	console.log(`${mutation.name}: real acceptance rejected the mutation`);
}

async function verifyAllMutations() {
	const concurrency = Math.min(
		mutations.length,
		Math.max(2, Math.floor(availableParallelism() / 2)),
	);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < mutations.length) {
			const current = mutations[nextIndex];
			nextIndex += 1;
			if (current !== undefined) {
				await verifyMutation(current);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** @param {readonly string[]} args */
async function main(args) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: node scripts/verify-quality-mutations.mjs

Copy the checkout into disposable directories and prove real quality acceptance
rejects syntax, semantic, compiler, formatting, test, policy and allowance-isolation
mutations. Requires a passing npm run quality baseline. Original files are unchanged.
Exit codes: 0 all controls verified/help; 1 baseline or mutation failure.`);
		return;
	}
	if (args.length !== 0) {
		throw new Error("Unexpected mutation arguments; use --help");
	}
	const baseline = await acceptance(root);
	if (baseline.status !== 0) {
		throw new Error(
			`Clean acceptance must pass before mutation proof:\n${forLog(baseline.output)}`,
		);
	}
	console.log(forLog(baseline.output));
	await verifyAllMutations();
}

main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
	console.error(error);
	process.exitCode = 1;
});
