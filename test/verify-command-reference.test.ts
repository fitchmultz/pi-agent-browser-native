import { readArray, readRecord, readString } from "./helpers/assertions.js";
/**
 * Purpose: Validate command-reference drift verification behavior for the local agent-browser documentation guard.
 * Responsibilities: Ensure metadata-driven token drift detection reports actionable failures for doc omissions and upstream/version mismatches without spawning real binaries in tests.
 * Scope: Unit tests for scripts/verify-command-reference.mjs boundary behavior.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: Tests inject fake help/version/doc inputs and do not depend on local agent-browser runtime availability.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";
import {
	stripGeneratedCapabilityBaselineBlocks,
	verifyCommandReference,
} from "../scripts/verify-command-reference.mjs";

test("maintainer CLIs reject invalid options through encoded and symlink entrypoints", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "piab-cli-"));
	try {
		await Promise.all(
			[
				"agent-browser-capability-baseline.mjs",
				"agent-browser-target.mjs",
				"capability-core-commands.mjs",
				"capability-options.mjs",
				"capability-samples.mjs",
				"capability-section.mjs",
				"startup-measurement.mjs",
			].map((name) => copyFile(join("scripts", name), join(directory, name))),
		);
		await Promise.all(
			(
				[
					["verify-command-reference.mjs", 2, /Unknown option/],
					["check-command-reference-baseline.mjs", 1, /Invalid arguments/],
					["profile-startup.mjs", 2, /Unknown option/],
				] as const
			).map(async ([name, exitCode, diagnostic]) => {
				const script = join(directory, name);
				const encodedScript = join(directory, `encoded % ${name}`);
				const alias = join(directory, `alias-${name}`);
				await copyFile(join("scripts", name), script);
				await Promise.all([copyFile(script, encodedScript), symlink(script, alias)]);
				await Promise.all(
					(
						[
							["encoded path", encodedScript],
							["symlink", alias],
						] as const
					).map(([kind, entrypoint]) =>
						t.test(`${name}: ${kind}`, () => {
							const result = spawnSync(process.execPath, [entrypoint, "--invalid-option"], {
								encoding: "utf8",
								timeout: 10_000,
							});
							assert.ifError(result.error);
							assert.equal(
								result.status,
								exitCode,
								`stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
							);
							assert.equal(result.stdout, "");
							assert.match(result.stderr, diagnostic);
						}),
					),
				);
			}),
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

const baseline = readRecord(CAPABILITY_BASELINE);
const upstreamExpectations = readArray(baseline.upstreamExpectations).map(readRecord);
const docRequiredTokens = readArray(baseline.docRequiredTokens).map(readString);
const helpCommands = readArray(baseline.helpCommands).map(readRecord);
const targetVersion = readString(baseline.targetVersion);

function fakeHelpFor(label: string): string {
	return upstreamExpectations
		.filter((expectation) => expectation.help === label)
		.map((expectation) => readString(expectation.token))
		.join("\n");
}

function completeDoc(): string {
	return docRequiredTokens.join("\n");
}

function fakeRunWithVersion(version: string): (args: readonly string[]) => Promise<string> {
	const helpByCommand = new Map(
		helpCommands.map((command) => [
			readArray(command.args).map(readString).join(" "),
			fakeHelpFor(readString(command.label)),
		]),
	);

	return async (args: readonly string[]) => {
		const key = args.join(" ");
		if (key === "--version") {
			return `agent-browser ${version}`;
		}
		const output = helpByCommand.get(key);
		if (output !== undefined) {
			return output;
		}
		throw new Error(`Unexpected command in fake run: ${key}`);
	};
}

test("command reference clarifies get selector requirements", () => {
	const doc = readString(
		stripGeneratedCapabilityBaselineBlocks(readFileSync("docs/COMMAND_REFERENCE.md", "utf8")),
	);

	assert.match(readString(doc), /selector is not optional for DOM getters/);
	assert.match(readString(doc), /`get text\/html\/value\/count <selector>`/);
	assert.match(readString(doc), /`get attr <selector> <name>`/);
	assert.doesNotMatch(readString(doc), /`get <what> \[selector\]` \| `text`, `html`, `value`/);
});

test("verifyCommandReference passes for matching fake upstream and doc content", async () => {
	const failures = await verifyCommandReference({
		cwd: "/repo",
		run: fakeRunWithVersion(targetVersion),
		readDoc: async () => completeDoc(),
	});

	assert.deepEqual(failures, []);
});

test("verifyCommandReference reports version drift", async () => {
	const failures = await verifyCommandReference({
		cwd: "/repo",
		run: fakeRunWithVersion("0.25.0"),
		readDoc: async () => completeDoc(),
	});

	assert.ok(
		readArray(failures).some((entry) => readString(entry).includes("agent-browser version drift")),
	);
});

test("verifyCommandReference reports missing upstream token", async () => {
	const run = async (args: readonly string[]) => {
		const key = args.join(" ");
		if (key === "--version") {
			return `agent-browser ${targetVersion}`;
		}
		const command = helpCommands.find(
			(entry) => readArray(entry.args).map(readString).join(" ") === key,
		);
		if (command) {
			const text = fakeHelpFor(readString(command.label));
			return command.label === "root help" ? text.replace("skills get core --full", "") : text;
		}
		throw new Error(`Unexpected command in fake run: ${key}`);
	};

	const failures = await verifyCommandReference({
		cwd: "/repo",
		run,
		readDoc: async () => completeDoc(),
	});

	assert.ok(
		readArray(failures).some((entry) =>
			readString(entry).includes("Upstream root help no longer includes expected token"),
		),
	);
});

test("verifyCommandReference reports missing doc token", async () => {
	const docMissingToken = [
		completeDoc().replace("skills list", ""),
		"<!-- agent-browser-capability-baseline:start capability-token-baseline -->",
		"skills list",
		"<!-- agent-browser-capability-baseline:end capability-token-baseline -->",
	].join("\n");
	const failures = await verifyCommandReference({
		cwd: "/repo",
		run: fakeRunWithVersion(targetVersion),
		readDoc: async () => docMissingToken,
	});

	assert.deepEqual(failures, [
		"docs/COMMAND_REFERENCE.md is missing human-authored token: skills list",
	]);
	const emptyDocFailures = await verifyCommandReference({
		cwd: "/repo",
		run: fakeRunWithVersion(targetVersion),
		readDoc: async () => "",
	});
	assert.deepEqual(
		emptyDocFailures,
		docRequiredTokens.map(
			(token) => `docs/COMMAND_REFERENCE.md is missing human-authored token: ${token}`,
		),
	);
});
