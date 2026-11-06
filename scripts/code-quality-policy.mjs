import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { exceptionSites } from "./quality-exceptions.mjs";

const recordSchema = Type.Record(Type.String(), Type.Unknown());
const recordsSchema = Type.Array(recordSchema);
const stringsSchema = Type.Array(Type.String());
const generatedRoots = ["node_modules", "dist", ".artifacts", ".crabbox", ".cueloop"];
const generatedDirectories = generatedRoots.map((root) => `${root}/**`);
const compilerProjects = ["tsconfig.json", "tsconfig.build.json", "tsconfig.declarations.json"];
const testSupport = [
	"test/helpers/**/*.{ts,js,mjs,cjs}",
	"scripts/verify-recording-native.mjs",
	"scripts/verify-agent-browser-dogfood.ts",
];
const nodeTestRules = {
	"node-test/require-assertion": "error",
	"node-test/no-conditional-assertion": "error",
	"node-test/no-nested-tests": "error",
	"node-test/no-unawaited-subtest": "error",
	"node-test/no-unawaited-rejects": "error",
	"node-test/no-only-test": "error",
};
const compilerMinimums = {
	strict: true,
	noImplicitReturns: true,
	noFallthroughCasesInSwitch: true,
	noImplicitOverride: true,
	noUncheckedIndexedAccess: true,
	exactOptionalPropertyTypes: true,
	noUncheckedSideEffectImports: true,
	forceConsistentCasingInFileNames: true,
	noCheck: false,
	allowJs: true,
	checkJs: true,
};

/** @param {unknown} value
 * @param {string} label */
function record(value, label) {
	assert.ok(Check(recordSchema, value), `${label}: expected an object`);
	return value;
}

/** @param {string} file */
function readJson(file) {
	const value = record(JSON.parse(readFileSync(file, "utf8")), file);
	return value;
}

/** @param {string} cwd
 * @param {string} heading */
function guideConfig(cwd, heading = "## Appendix A: Base Oxlint configuration") {
	const guide = readFileSync(
		path.join(cwd, "docs/Strict-Oxlint-Oxfmt-Engineering-Guide.md"),
		"utf8",
	);
	const appendix = guide.split(heading)[1];
	assert.ok(appendix !== undefined, `Missing adopted guide section: ${heading}`);
	const json = /```json\s*\n([\s\S]*?)\n```/u.exec(appendix)?.[1];
	assert.ok(json !== undefined, "Missing guide configuration");
	return record(JSON.parse(json), "Guide configuration");
}

/** @param {string} cwd */
function expectedConfig(cwd) {
	const config = guideConfig(cwd);
	const plugins = config.plugins;
	const overrides = config.overrides;
	assert.ok(Check(stringsSchema, plugins));
	assert.ok(Check(recordsSchema, overrides));
	const [testProfile] = overrides;
	assert.ok(testProfile !== undefined);
	const files = testProfile.files;
	assert.ok(Check(stringsSchema, files));
	const rules = record(config.rules, "Guide rules");
	const floating = rules["typescript/no-floating-promises"];
	assert.ok(Array.isArray(floating));
	const promiseOptions = record(floating[1], "Guide Promise options");
	testProfile.files = [...files, ...testSupport];
	testProfile.rules = {
		...record(testProfile.rules, "Guide test rules"),
		...nodeTestRules,
		"typescript/no-floating-promises": [
			"error",
			{
				...promiseOptions,
				allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["nodeTest"] }],
			},
		],
	};
	return {
		...config,
		plugins: [...plugins, "node"],
		jsPlugins: [{ name: "node-test", specifier: "eslint-node-test" }],
		ignorePatterns: generatedDirectories,
		overrides,
	};
}

/** @param {string} name
 * @param {readonly string[]} args
 * @param {string} cwd */
function toolOutput(name, args, cwd) {
	if (name === "tsc" && process.platform === "android") {
		return execFileSync("tsgo", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	}
	const entry = name === "tsc" ? "typescript/lib/tsc.js" : "oxlint/bin/oxlint";
	return execFileSync(process.execPath, [path.join(cwd, "node_modules", entry), ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

/** @param {string} cwd */
function repositoryFiles(cwd) {
	return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	})
		.split("\0")
		.filter((file) => file.length > 0 && existsSync(path.join(cwd, file)));
}

/** @param {readonly string[]} files */
function verifyComposition(files) {
	const nested = files.filter((file) => {
		if (file === ".oxlintrc.json" || file === ".oxfmtrc.json") {
			return false;
		}
		return /(?:^|\/)(?:\.oxlintrc\..+|\.oxfmtrc\..+|oxlint\.config\..+|oxfmt\.config\..+|\.eslintignore|\.prettierignore|\.editorconfig)$/u.test(
			file,
		);
	});
	assert.deepEqual(nested, [], "Repository mapping uses one root lint and format configuration");
}

/** @param {string} cwd
 * @param {readonly string[]} files */
function verifyIgnores(cwd, files) {
	const child = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
		cwd,
		encoding: "utf8",
		input: `${files.join("\0")}\0`,
	});
	assert.equal(child.error, undefined);
	assert.equal(child.signal, null);
	assert.ok(child.status === 0 || child.status === 1, child.stderr);
	assert.equal(child.stdout, "", "Maintained source is hidden by a Git ignore rule");
	const formatter = readJson(path.join(cwd, ".oxfmtrc.json"));
	const expected = guideConfig(cwd, "### 7.1 Formatter ownership");
	expected.useTabs = true;
	expected.ignorePatterns = ["package-lock.json", ...generatedDirectories];
	assert.deepEqual(
		formatter,
		expected,
		"Formatter differs from guide and established repository conventions",
	);
}

/** @param {string} cwd
 * @param {string} project */
function projectMembership(cwd, project) {
	const config = record(
		JSON.parse(toolOutput("tsc", ["-p", project, "--showConfig"], cwd)),
		project,
	);
	const options = record(config.compilerOptions, `${project} compilerOptions`);
	for (const [option, value] of Object.entries(compilerMinimums)) {
		assert.equal(options[option], value, `${project}: ${option}`);
	}
	for (const option of [
		"strictNullChecks",
		"strictFunctionTypes",
		"strictBindCallApply",
		"strictPropertyInitialization",
		"strictBuiltinIteratorReturn",
		"noImplicitAny",
		"noImplicitThis",
		"alwaysStrict",
		"useUnknownInCatchVariables",
	]) {
		assert.notEqual(options[option], false, `${project}: strict-family relaxation ${option}`);
	}
	if (project === "tsconfig.declarations.json") {
		assert.equal(options.skipLibCheck, false, "Handwritten declarations must be checked");
	}
	return new Set(
		toolOutput("tsc", ["-p", project, "--listFilesOnly"], cwd)
			.trim()
			.split(/\r?\n/u)
			.map((file) => path.relative(cwd, file).split(path.sep).join("/")),
	);
}

/** @param {string} cwd
 * @param {readonly string[]} files */
function verifyCompilerCoverage(cwd, files) {
	const memberships = new Map(
		compilerProjects.map((project) => [project, projectMembership(cwd, project)]),
	);
	for (const file of files) {
		const project = /\.d\.[cm]?ts$/u.test(file) ? "tsconfig.declarations.json" : "tsconfig.json";
		assert.ok(
			memberships.get(project)?.has(file) === true,
			`${file}: missing from checked ${project}`,
		);
	}
}

/** @param {string} cwd */
function verifyCommands(cwd) {
	const manifest = readJson(path.join(cwd, "package.json"));
	const scripts = record(manifest.scripts, "package scripts");
	const commands = {
		lint: "node ./scripts/code-quality.mjs lint",
		"lint:agent": "node ./scripts/code-quality.mjs lint --format=agent",
		"lint:fix": "node ./scripts/code-quality.mjs lint --fix",
		format: "oxfmt --write .",
		"format:check": "oxfmt --check .",
		quality: "node ./scripts/project.mjs verify quality",
		typecheck: "node ./scripts/project.mjs verify typecheck",
		test: "node ./scripts/project.mjs test",
		build: "node ./scripts/build.mjs",
	};
	for (const [name, command] of Object.entries(commands)) {
		assert.equal(scripts[name], command, `Required command changed: ${name}`);
	}
	const dependencies = record(manifest.devDependencies, "quality dependencies");
	for (const name of [
		"oxlint",
		"oxlint-tsgolint",
		"oxfmt",
		"typescript",
		"oxc-parser",
		"eslint-node-test",
	]) {
		const installed = readJson(path.join(cwd, "node_modules", name, "package.json"));
		assert.equal(
			installed.version,
			dependencies[name],
			`Installed ${name} differs from package.json`,
		);
	}
}

/** @param {ReturnType<typeof parseSync>["comments"][number]} comment
 * @param {string} text
 * @param {string} file
 * @param {string} location */
function checkCompilerComment(comment, text, file, location) {
	const directive =
		comment.type === "Block"
			? (comment.value.split(/[\r\n\u2028\u2029]/u).at(-1) ?? "").replace(/^[ \t]*[/*]*[ \t]*/u, "")
			: text;
	const pragma = /^\/?[ \t]*@([a-zA-Z-]+)/u.exec(text)?.[1]?.toLowerCase();
	if (/^@ts-ignore/iu.test(directive) || pragma === "ts-nocheck") {
		throw new Error(`${location}: compiler escape hatch is forbidden`);
	}
	if (/^@ts-expect-error/iu.test(directive)) {
		const reason = directive.replace(/^@ts-expect-error\s*[:-]?\s*/iu, "").trim();
		assert.ok(
			/\.test-d\.[cm]?ts$/u.test(file) && reason.length >= 10,
			`${location}: described negative type test required`,
		);
	}
}

/** @param {import("oxc-parser").Comment} comment
 * @param {string} text
 * @param {{file: string, location: string, source: string, program: import("oxc-parser").Program}} context
 * @param {Set<string>} used */
function lintException(comment, text, context, used) {
	const directive =
		/^oxlint-disable-next-line (max-params|no-param-reassign|eslint\/preserve-caught-error|typescript\/no-unnecessary-condition) -- (QX-00[2345]): (.+)$/u.exec(
			text,
		);
	assert.ok(
		comment.type === "Line" && directive,
		`${context.location}: unrecorded lint/format directive`,
	);
	const [, rule, id, reason] = directive;
	assert.ok(rule !== undefined && id !== undefined && reason !== undefined);
	const site = exceptionSites(context.file, context.program).find(
		(candidate) =>
			candidate.rule === rule &&
			candidate.id === id &&
			candidate.start >= comment.end &&
			/^[ \t]*\r?\n[ \t]*$/u.test(context.source.slice(comment.end, candidate.start)),
	);
	assert.ok(site, `${context.file}: directive is not attached to an authorized operation`);
	if (site.end !== undefined && !context.source.slice(site.start, site.end).includes("\n")) {
		const lineEnd = context.source.indexOf("\n", site.end);
		assert.match(
			context.source.slice(site.end, lineEnd < 0 ? undefined : lineEnd),
			/^[ \t\r]*$/u,
			`${context.file}: directive also covers an unauthorized operation on the same line`,
		);
	}
	assert.ok(
		!used.has(site.operation),
		`${context.file}: duplicate exception for ${site.operation}`,
	);
	used.add(site.operation);
	return { rule, reason, operation: site.operation, id };
}

/** @param {string} file
 * @param {string} source */
export function sourcePolicy(file, source) {
	const parsed = parseSync(file, source);
	assert.equal(parsed.errors.length, 0, `${file}: ${JSON.stringify(parsed.errors)}`);
	/** @type {{file: string, location: string, rule: string, reason: string, operation: string, id: string}[]} */
	const entries = [];
	/** @type {Set<string>} */
	const used = new Set();
	for (const comment of parsed.comments) {
		const text = comment.value.trim().replace(/^[/*]+\s*/u, "");
		const line = source.slice(0, comment.start).split("\n").length;
		const location = `${file}:${line}`;
		checkCompilerComment(comment, text, file, location);
		if (/^(?:eslint|oxlint)(?:-|\s)|^(?:prettier|oxfmt)-ignore/u.test(text)) {
			entries.push({
				file,
				location,
				...lintException(comment, text, { file, location, source, program: parsed.program }, used),
			});
		}
	}
	return { checked: true, entries, program: parsed.program };
}

/** @param {string} cwd */
export function verifyScope(cwd = process.cwd()) {
	const inventory = repositoryFiles(cwd).filter(
		(file) => !generatedRoots.some((root) => file === root || file.startsWith(`${root}/`)),
	);
	verifyComposition(inventory);
	const files = [
		...new Set(inventory.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file))),
	].sort();
	assert.ok(files.length > 0, "No maintained source selected");
	assert.deepEqual(
		readJson(path.join(cwd, ".oxlintrc.json")),
		expectedConfig(cwd),
		"Oxlint policy differs from guide and repository mappings",
	);
	verifyIgnores(
		cwd,
		inventory.filter((file) => file !== "package-lock.json"),
	);
	verifyCommands(cwd);
	verifyCompilerCoverage(cwd, files);
	const linted = toolOutput("oxlint", ["--debug=files", "."], cwd).trim().split(/\r?\n/u).sort();
	assert.deepEqual(linted, files, "Maintained source differs from native Oxlint selection");
	const exceptions = files.flatMap(
		(file) => sourcePolicy(file, readFileSync(path.join(cwd, file), "utf8")).entries,
	);
	return { files, projects: compilerProjects, exceptions };
}
