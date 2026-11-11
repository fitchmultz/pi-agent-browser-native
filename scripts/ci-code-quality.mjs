#!/usr/bin/env node
/**
 * Purpose: Select the CI quality gate (`quality` vs `quality:mutations`) for `.github/workflows/code-quality.yml`.
 * Responsibilities: Run fast single-pass `npm run quality` on ordinary source/doc/test pull requests while preserving full `npm run quality:mutations` when lint/format/compiler configs, package manifests, `scripts/`, `.github/workflows/`, or quality-probe tests change, on release qualification, and whenever pull-request merge ancestry cannot be verified.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

/** @typedef {"quality" | "quality:mutations"} QualityScript */
/** @typedef {{ readonly script: QualityScript; readonly reason: string }} GateSelection */

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;

const MUTATION_TRIGGER_PATTERNS = [
	/(?:^|\/)\.oxlintrc[^/]*$/u,
	/(?:^|\/)oxlint\.config\.[^/]+$/u,
	/(?:^|\/)\.oxfmtrc[^/]*$/u,
	/(?:^|\/)oxfmt\.config\.[^/]+$/u,
	/(?:^|\/)tsconfig[^/]*$/u,
	/(?:^|\/)package(?:-lock)?\.json$/u,
	/^scripts\//u,
	/^\.github\/workflows\//u,
	/^test\/code-quality/u,
	/^test\/helpers\/code-quality-fixture\.ts$/u,
];

/** @param {string} file
 * @returns {boolean} */
function requiresQualityMutations(file) {
	return MUTATION_TRIGGER_PATTERNS.some((pattern) => pattern.test(file));
}

/** @param {string} cwd
 * @param {string} rev
 * @returns {string | null} */
function resolveCommitSha(cwd, rev) {
	const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
		cwd,
		encoding: "utf8",
	});
	if (result.error !== undefined || result.signal !== null || result.status !== 0) {
		return null;
	}
	const sha = result.stdout.trim().toLowerCase();
	return COMMIT_SHA_PATTERN.test(sha) ? sha : null;
}

/** @param {string} cwd
 * @param {string} prHeadSha
 * @returns {{ readonly ok: true; readonly baseParent: string } | { readonly ok: false; readonly reason: string }} */
function resolvePullMergeBaseParent(cwd, prHeadSha) {
	const expectedHead = prHeadSha.trim().toLowerCase();
	if (!COMMIT_SHA_PATTERN.test(expectedHead)) {
		return { ok: false, reason: "missing or invalid pull_request head SHA" };
	}
	const baseParent = resolveCommitSha(cwd, "HEAD^1");
	const headParent = resolveCommitSha(cwd, "HEAD^2");
	const extraParent = resolveCommitSha(cwd, "HEAD^3");
	if (baseParent === null || headParent === null || extraParent !== null) {
		return { ok: false, reason: "HEAD is not a two-parent pull_request merge commit" };
	}
	if (headParent !== expectedHead) {
		return { ok: false, reason: "HEAD^2 does not match pull_request head SHA" };
	}
	return { ok: true, baseParent };
}

/** @param {string} cwd
 * @param {string} baseParent
 * @returns {readonly string[]} */
function diffPullRequestFiles(cwd, baseParent) {
	const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", baseParent, "HEAD"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (diff.error !== undefined || diff.status !== 0) {
		throw (
			diff.error ??
			new Error(`git diff failed (${String(diff.status ?? diff.signal)}): ${diff.stderr.trim()}`)
		);
	}
	return diff.stdout
		.split("\0")
		.filter((entry) => entry.length > 0)
		.map((entry) => entry.replaceAll("\\", "/"));
}

/** @param {readonly string[]} matched
 * @returns {string} */
function formatMatchedPaths(matched) {
	const preview = matched.slice(0, 5).join(", ");
	const remaining = matched.length - 5;
	return remaining > 0 ? `${preview} (+${remaining} more)` : preview;
}

/** @param {NodeJS.ProcessEnv} env
 * @returns {GateSelection | null} */
function selectNonPullRequestGate(env) {
	const explicitMutations = (env.QUALITY_MUTATIONS ?? "").trim();
	if (explicitMutations === "true") {
		return { script: "quality:mutations", reason: "explicit mutations=true" };
	}
	if (explicitMutations === "false") {
		return { script: "quality", reason: "explicit mutations=false" };
	}
	if (explicitMutations.length > 0) {
		throw new Error(`Invalid QUALITY_MUTATIONS value: ${explicitMutations}`);
	}
	if ((env.QUALITY_SOURCE_REF ?? "").trim().length > 0) {
		return {
			script: "quality:mutations",
			reason: "explicit source-ref requires mutation controls",
		};
	}
	const eventName = (env.QUALITY_EVENT_NAME ?? "").trim();
	if (eventName !== "pull_request") {
		const label = eventName.length > 0 ? eventName : "non-PR";
		return { script: "quality:mutations", reason: `${label} run requires mutation controls` };
	}
	return null;
}

/** @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {GateSelection} */
function selectQualityGate(cwd, env) {
	const direct = selectNonPullRequestGate(env);
	if (direct !== null) {
		return direct;
	}
	const mergeBase = resolvePullMergeBaseParent(cwd, env.QUALITY_PR_HEAD_SHA ?? "");
	if (!mergeBase.ok) {
		return {
			script: "quality:mutations",
			reason: `${mergeBase.reason}; running mutation controls`,
		};
	}
	const files = diffPullRequestFiles(cwd, mergeBase.baseParent);
	const matched = files.filter((file) => requiresQualityMutations(file));
	if (matched.length > 0) {
		return {
			script: "quality:mutations",
			reason: `pull_request matched ${formatMatchedPaths(matched)}`,
		};
	}
	return {
		script: "quality",
		reason: `pull_request changed ${files.length} file(s); none matched mutation triggers`,
	};
}

/** @param {readonly string[]} args */
function main(args) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: node scripts/ci-code-quality.mjs

Select whether CI runs npm run quality or npm run quality:mutations from
QUALITY_EVENT_NAME, QUALITY_SOURCE_REF, QUALITY_MUTATIONS, QUALITY_PR_HEAD_SHA,
and the checked-out Git merge commit. Appends script=<name> to GITHUB_OUTPUT
when set.`);
		return;
	}
	if (args.length > 0) {
		throw new Error(`Unexpected ci-code-quality arguments: ${args.join(" ")}; use --help`);
	}
	const selection = selectQualityGate(process.cwd(), process.env);
	console.log(`CI quality gate: npm run ${selection.script} (${selection.reason})`);
	const githubOutput = (process.env.GITHUB_OUTPUT ?? "").trim();
	if (githubOutput.length > 0) {
		appendFileSync(githubOutput, `script=${selection.script}\n`, "utf8");
	}
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
