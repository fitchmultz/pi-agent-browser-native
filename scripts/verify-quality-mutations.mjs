#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".git", "node_modules", "dist", ".artifacts", ".crabbox", ".cueloop"]);
const lintStage = /scripts\/code-quality\.mjs lint$/u;
const contractStage = new RegExp(
	`^${RegExp.escape(`${process.execPath} ${fileURLToPath(import.meta.resolve("tsx/cli"))} --test test/**/!(*.serial).test.ts`.replaceAll("\\", "/"))}$`,
	"u",
);
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
		stage: lintStage,
		diagnostic: /typescript\(TS2322\)/u,
	},
	{
		name: "format",
		file: "quality-format-mutation.json",
		text: '{"format":"not formatted"}',
		stage: /\/oxfmt(?:\.cmd)? --check \.$/u,
		diagnostic: /quality-format-mutation\.json/u,
	},
	{
		name: "allowance-isolation",
		file: ".oxlintrc.json",
		stage: contractStage,
		diagnostic:
			/^(?:not ok \d+ - |✖ )qualified registration allowance cannot exempt shadows, other declarations or ordinary work(?: \([\d.]+ms\))?$/mu,
		evidencePath: "test/code-quality.test.ts",
	},
];

// GitHub Actions stops showing a step log after one very long line, such as the
// policy inventory JSON; shorten such lines wherever child output is printed.
function forLog(text) {
	return text.replace(
		/^.{2001,}$/gmu,
		(line) => `${line.slice(0, 2000)}… [${line.length - 2000} more characters]`,
	);
}

function runNode(directory, args) {
	const result = spawnSync(process.execPath, args, {
		cwd: directory,
		encoding: "utf8",
		timeout: 1_200_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error !== undefined || result.signal !== null || result.status === null) {
		console.error(
			forLog(stripVTControlCharacters(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)),
		);
		throw result.error ?? new Error(`Quality child did not complete: ${result.signal}`);
	}
	return {
		status: result.status,
		stdout: stripVTControlCharacters(result.stdout),
		output: stripVTControlCharacters(`${result.stdout}\n${result.stderr}`),
	};
}

function acceptance(directory) {
	return runNode(directory, ["scripts/project.mjs", "verify", "quality"]);
}

function applyMutation(directory, mutation) {
	const file = path.join(directory, mutation.file);
	if (mutation.name === "allowance-isolation") {
		const config = JSON.parse(readFileSync(file, "utf8"));
		config.rules["typescript/no-floating-promises"][1].allowForKnownSafePromises = [
			{ from: "lib", name: "Promise" },
		];
		writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`);
	} else {
		writeFileSync(file, mutation.text);
	}
	if (mutation.name !== "format") {
		const formatter = runNode(directory, [
			path.join(directory, "node_modules", "oxfmt", "bin", "oxfmt"),
			"--write",
			mutation.file,
		]);
		if (formatter.status !== 0) {
			throw new Error(`Mutation formatting failed:\n${forLog(formatter.output)}`);
		}
	}
}

function verifyRejection(result, mutation) {
	const stage = [...result.stdout.matchAll(/^> (.+)$/gmu)].at(-1);
	// Require the diagnostic to survive the shortening applied whenever child output is printed.
	const stageOutput = stage === undefined ? "" : forLog(result.output.slice(stage.index));
	if (
		result.status === 0 ||
		stage === undefined ||
		!mutation.stage.test(stage[1].replaceAll("\\", "/")) ||
		!mutation.diagnostic.test(stageOutput) ||
		!stageOutput.replaceAll("\\", "/").includes(mutation.evidencePath ?? mutation.file)
	) {
		throw new Error(
			`${mutation.name} did not fail at its expected stage/diagnostic:\n${forLog(result.output)}`,
		);
	}
}

function verifyMutation(mutation) {
	const directory = mkdtempSync(path.join(tmpdir(), "piab-quality-mutation-"));
	try {
		cpSync(root, directory, {
			recursive: true,
			filter: (file) => !excluded.has(path.relative(root, file).split(path.sep)[0]),
		});
		symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
		applyMutation(directory, mutation);
		const result = acceptance(directory);
		verifyRejection(result, mutation);
		console.log(`${mutation.name}: real acceptance rejected the mutation`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function main(args) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: node scripts/verify-quality-mutations.mjs

Copy the checkout into disposable directories and prove the real quality acceptance
fails for syntax, semantic, compiler, formatting and allowance-isolation mutations.
Requires a passing clean npm run quality baseline. Original files are never changed.
Exit codes: 0 all controls verified/help; 1 baseline or mutation failure.`);
		return;
	}
	if (args.length !== 0) {
		throw new Error("Unexpected mutation arguments; use --help");
	}
	const baseline = acceptance(root);
	if (baseline.status !== 0) {
		throw new Error(
			`Clean acceptance must pass before mutation proof:\n${forLog(baseline.output)}`,
		);
	}
	console.log(forLog(baseline.output));
	for (const mutation of mutations) {
		verifyMutation(mutation);
	}
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
