/** Lock Code quality CI gating so ordinary PRs run 1x quality while config/script/workflow PRs and releases run mutation controls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { readString } from "./helpers/assertions.js";

const SELECTOR_SCRIPT = fileURLToPath(new URL("../scripts/ci-code-quality.mjs", import.meta.url));

const codeQualityWorkflow = readFileSync(".github/workflows/code-quality.yml", "utf8").replace(
	/\r\n/g,
	"\n",
);
const npmReleaseWorkflow = readFileSync(".github/workflows/npm-release.yml", "utf8").replace(
	/\r\n/g,
	"\n",
);

function git(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function writeRepoFile(cwd: string, relativePath: string, content: string): void {
	const fullPath = join(cwd, relativePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content, "utf8");
}

function initGitRepo(t: TestContext): { readonly cwd: string; readonly baseSha: string } {
	const cwd = mkdtempSync(join(tmpdir(), "piab-ci-quality-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, ["init", "--quiet", "--initial-branch=main"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	git(cwd, ["config", "user.name", "Test"]);
	for (const [file, text] of [
		[".oxlintrc.json", "{}\n"],
		[".oxfmtrc.json", "{}\n"],
		["tsconfig.json", "{}\n"],
		["package.json", '{"version":"0.9.19"}\n'],
		["package-lock.json", '{"version":"0.9.19"}\n'],
		["scripts/project.mjs", "export const ok = true;\n"],
		["scripts/old-helper.mjs", "export const legacy = true;\n"],
		[".github/workflows/code-quality.yml", "name: Code quality\n"],
		["extensions/agent-browser/index.ts", "export const ext = 1;\n"],
		["README.md", "# Readme\n"],
		["CHANGELOG.md", "# Changelog\n"],
	] as const) {
		writeRepoFile(cwd, file, text);
	}
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "--quiet", "-m", "initial"]);
	return { cwd, baseSha: git(cwd, ["rev-parse", "HEAD"]) };
}

function runSelector(
	cwd: string,
	envOverrides: Readonly<Record<string, string | undefined>>,
	args: readonly string[] = [],
): {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly outputScript: string | null;
} {
	const outDir = mkdtempSync(join(tmpdir(), "piab-ci-quality-out-"));
	const outputFile = join(outDir, "github-output.txt");
	writeFileSync(outputFile, "", "utf8");
	try {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GITHUB_OUTPUT: outputFile,
			QUALITY_EVENT_NAME: undefined,
			QUALITY_SOURCE_REF: undefined,
			QUALITY_MUTATIONS: undefined,
			QUALITY_PR_HEAD_SHA: undefined,
			...envOverrides,
		};
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) {
				delete env[key];
			}
		}
		const result = spawnSync(process.execPath, [SELECTOR_SCRIPT, ...args], {
			cwd,
			env,
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.ifError(result.error);
		assert.equal(result.signal, null);
		const rawOutput = readFileSync(outputFile, "utf8").trim();
		const match = /^script=(.+)$/mu.exec(rawOutput);
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			outputScript: match?.[1] ?? null,
		};
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

function createPullMergeCheckout(
	cwd: string,
	branchName: string,
	mutateBranch: () => void,
): string {
	git(cwd, ["checkout", "--quiet", "-b", branchName, "main"]);
	mutateBranch();
	const prHeadSha = git(cwd, ["rev-parse", "HEAD"]);
	git(cwd, ["checkout", "--quiet", "--detach", "main"]);
	git(cwd, ["merge", "--quiet", "--no-ff", prHeadSha, "-m", `Merge ${prHeadSha} into main`]);
	return prHeadSha;
}

nodeTest(
	"code-quality workflow preserves required quality check identity and partitions quality vs quality:mutations",
	() => {
		assert.match(codeQualityWorkflow, /^name: Code quality\n/u);
		assert.match(codeQualityWorkflow, /pull_request:\n    branches: \[main\]/u);
		assert.match(
			codeQualityWorkflow,
			/workflow_dispatch:\n    inputs:\n      mutations:\n[\s\S]*?type: boolean\n        default: true/u,
		);
		assert.match(
			codeQualityWorkflow,
			/workflow_call:\n    inputs:\n      source-ref:[\s\S]*?mutations:\n[\s\S]*?type: boolean\n        default: true/u,
		);
		const qualityJob = readString(codeQualityWorkflow.split("\n  quality:\n")[1]);
		assert.notEqual(qualityJob.length, 0);
		assert.doesNotMatch(qualityJob, /\n    name:/u);
		assert.doesNotMatch(qualityJob, /continue-on-error:/u);
		assert.match(
			qualityJob,
			/ref: \$\{\{ inputs\.source-ref \|\| github\.sha \}\}\n          fetch-depth: 2/u,
		);
		assert.match(
			qualityJob,
			/- name: Select quality gate\n        id: gate\n        env:\n          QUALITY_EVENT_NAME: \$\{\{ github\.event_name \}\}\n          QUALITY_SOURCE_REF: \$\{\{ inputs\.source-ref \}\}\n          QUALITY_MUTATIONS: \$\{\{ inputs\.mutations \}\}\n          QUALITY_PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n        run: node \.\/scripts\/ci-code-quality\.mjs/u,
		);
		assert.match(
			qualityJob,
			/- name: Strict quality acceptance\n        if: steps\.gate\.outputs\.script == 'quality'\n        timeout-minutes: 15\n        run: npm run quality\n      - name: Strict quality acceptance and real failure controls\n        if: steps\.gate\.outputs\.script != 'quality'\n        run: npm run quality:mutations/u,
		);
		assert.ok(
			qualityJob.indexOf("Select quality gate") <
				qualityJob.indexOf("Install older Node for the diagnostic-only smoke"),
		);
		assert.ok(
			qualityJob.indexOf("npm run quality:mutations") < qualityJob.indexOf("git diff --exit-code"),
		);
		const releaseQualityJob = readString(
			readString(npmReleaseWorkflow.split("\n  quality:\n")[1]).split("\n  prepare:\n")[0],
		);
		assert.match(releaseQualityJob, /uses: \.\/\.github\/workflows\/code-quality\.yml/u);
		assert.doesNotMatch(releaseQualityJob, /mutations:\s*false/u);
	},
);

nodeTest(
	"ordinary source, doc, test, and main-synced PRs select single-pass npm run quality",
	(t) => {
		const { cwd } = initGitRepo(t);
		const prHeadSha = createPullMergeCheckout(cwd, "feat/ordinary", () => {
			writeRepoFile(cwd, "extensions/agent-browser/index.ts", "export const ext = 2;\n");
			writeRepoFile(cwd, "docs/COMMAND_REFERENCE.md", "# Commands\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "--quiet", "-m", "commit 1"]);
			writeRepoFile(cwd, "test/agent-browser.runtime.test.ts", "export const ok = 1;\n");
			writeRepoFile(cwd, "README.md", "# Updated\n");
			writeRepoFile(cwd, "AGENTS.md", "# Agents\n");
			writeRepoFile(cwd, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n- entry\n");
			writeRepoFile(cwd, ".github/readme/browser-flow.svg", "<svg/>\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "--quiet", "-m", "commit 2"]);
		});
		const ordinary = runSelector(cwd, {
			QUALITY_EVENT_NAME: "pull_request",
			QUALITY_PR_HEAD_SHA: prHeadSha,
		});
		assert.equal(ordinary.status, 0, ordinary.stderr);
		assert.equal(ordinary.outputScript, "quality");
		assert.match(ordinary.stdout, /npm run quality \(pull_request changed 7 file\(s\)/u);

		// Advance main with a simulated npm-version commit touching package.json, lockfile, and scripts,
		// then merge main into the PR branch (strict up-to-date branch sync) and re-create GitHub's PR merge ref.
		git(cwd, ["checkout", "--quiet", "main"]);
		writeRepoFile(cwd, "package.json", '{"version":"0.9.20"}\n');
		writeRepoFile(cwd, "package-lock.json", '{"version":"0.9.20"}\n');
		writeRepoFile(cwd, "scripts/project.mjs", "export const ok = 'main-updated';\n");
		git(cwd, ["add", "."]);
		git(cwd, ["commit", "--quiet", "-m", "chore(release): 0.9.20"]);

		git(cwd, ["checkout", "--quiet", "feat/ordinary"]);
		git(cwd, ["merge", "--quiet", "--no-ff", "main", "-m", "Merge branch 'main'"]);
		const syncedHeadSha = git(cwd, ["rev-parse", "HEAD"]);
		git(cwd, ["checkout", "--quiet", "--detach", "main"]);
		git(cwd, ["merge", "--quiet", "--no-ff", syncedHeadSha, "-m", "Merge synced PR"]);

		const synced = runSelector(cwd, {
			QUALITY_EVENT_NAME: "pull_request",
			QUALITY_PR_HEAD_SHA: syncedHeadSha,
		});
		assert.equal(synced.status, 0, synced.stderr);
		assert.equal(synced.outputScript, "quality");
	},
);

nodeTest(
	"PRs touching lint/format/compiler configs, manifests, scripts, workflows, or quality probes select quality:mutations",
	(t) => {
		const { cwd } = initGitRepo(t);
		const cases: readonly { readonly name: string; readonly mutate: () => void }[] = [
			{
				name: "oxlintrc",
				mutate: () => writeRepoFile(cwd, ".oxlintrc.json", '{"rules":{}}\n'),
			},
			{
				name: "oxfmtrc-delete",
				mutate: () => unlinkSync(join(cwd, ".oxfmtrc.json")),
			},
			{
				name: "tsconfig",
				mutate: () => writeRepoFile(cwd, "tsconfig.declarations.json", "{}\n"),
			},
			{
				name: "package-json",
				mutate: () => writeRepoFile(cwd, "package.json", '{"version":"0.9.20"}\n'),
			},
			{
				name: "package-lock",
				mutate: () => writeRepoFile(cwd, "package-lock.json", '{"version":"0.9.20"}\n'),
			},
			{
				name: "nested-script",
				mutate: () => writeRepoFile(cwd, "scripts/platform-smoke/doctor.mjs", "export {};\n"),
			},
			{
				name: "script-renamed-out",
				mutate: () => {
					mkdirSync(join(cwd, "docs"), { recursive: true });
					git(cwd, ["mv", "scripts/old-helper.mjs", "docs/old-helper.md"]);
				},
			},
			{
				name: "workflow",
				mutate: () =>
					writeRepoFile(cwd, ".github/workflows/pi-compatibility.yml", "name: Pi compat\n"),
			},
			{
				name: "quality-probe-test",
				mutate: () => writeRepoFile(cwd, "test/code-quality.test.ts", "export {};\n"),
			},
			{
				name: "quality-fixture-helper",
				mutate: () => writeRepoFile(cwd, "test/helpers/code-quality-fixture.ts", "export {};\n"),
			},
		];

		const outcomes = cases.map(({ name, mutate }) => {
			const headSha = createPullMergeCheckout(cwd, `case/${name}`, () => {
				mutate();
				git(cwd, ["add", "-A"]);
				git(cwd, ["commit", "--quiet", "-m", name]);
			});
			const result = runSelector(cwd, {
				QUALITY_EVENT_NAME: "pull_request",
				QUALITY_PR_HEAD_SHA: headSha,
			});
			return { name, status: result.status, script: result.outputScript };
		});

		assert.deepEqual(
			outcomes,
			cases.map(({ name }) => ({ name, status: 0, script: "quality:mutations" })),
		);
	},
);

nodeTest(
	"release qualification, manual dispatch, and unverified PR ancestry handle mutations safely",
	(t) => {
		const { cwd, baseSha } = initGitRepo(t);
		git(cwd, ["checkout", "--quiet", "--detach", baseSha]);

		const releaseQualification = runSelector(cwd, {
			QUALITY_EVENT_NAME: "push",
			QUALITY_SOURCE_REF: baseSha,
			QUALITY_MUTATIONS: "true",
		});
		assert.equal(releaseQualification.status, 0, releaseQualification.stderr);
		assert.equal(releaseQualification.outputScript, "quality:mutations");

		const dispatchFast = runSelector(cwd, {
			QUALITY_EVENT_NAME: "workflow_dispatch",
			QUALITY_MUTATIONS: "false",
		});
		assert.equal(dispatchFast.status, 0, dispatchFast.stderr);
		assert.equal(dispatchFast.outputScript, "quality");

		const nonPrFallback = runSelector(cwd, {
			QUALITY_EVENT_NAME: "schedule",
		});
		assert.equal(nonPrFallback.status, 0, nonPrFallback.stderr);
		assert.equal(nonPrFallback.outputScript, "quality:mutations");

		// Detached 1-parent commit on a pull_request event fails closed to quality:mutations.
		const nonMergePr = runSelector(cwd, {
			QUALITY_EVENT_NAME: "pull_request",
			QUALITY_PR_HEAD_SHA: baseSha,
		});
		assert.equal(nonMergePr.status, 0, nonMergePr.stderr);
		assert.equal(nonMergePr.outputScript, "quality:mutations");
		assert.match(nonMergePr.stdout, /two-parent pull_request merge commit/u);

		// Merge commit whose HEAD^2 does not match QUALITY_PR_HEAD_SHA fails closed to quality:mutations.
		createPullMergeCheckout(cwd, "feat/mismatch", () => {
			writeRepoFile(cwd, "README.md", "# Mismatch\n");
			git(cwd, ["add", "README.md"]);
			git(cwd, ["commit", "--quiet", "-m", "docs"]);
		});
		const mismatchedSha = runSelector(cwd, {
			QUALITY_EVENT_NAME: "pull_request",
			QUALITY_PR_HEAD_SHA: baseSha,
		});
		assert.equal(mismatchedSha.status, 0, mismatchedSha.stderr);
		assert.equal(mismatchedSha.outputScript, "quality:mutations");
		assert.match(mismatchedSha.stdout, /HEAD\^2 does not match/u);

		const help = runSelector(cwd, {}, ["--help"]);
		assert.equal(help.status, 0);
		assert.equal(help.outputScript, null);
		assert.match(help.stdout, /Usage: node scripts\/ci-code-quality\.mjs/u);

		const invalidMutations = runSelector(cwd, { QUALITY_MUTATIONS: "sometimes" });
		assert.equal(invalidMutations.status, 1);
		assert.match(invalidMutations.stderr, /Invalid QUALITY_MUTATIONS/u);

		const invalidArg = runSelector(cwd, {}, ["--unknown"]);
		assert.equal(invalidArg.status, 1);
		assert.match(invalidArg.stderr, /Unexpected ci-code-quality arguments/u);
	},
);
