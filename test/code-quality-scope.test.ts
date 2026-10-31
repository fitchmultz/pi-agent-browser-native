import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, lint, root, run } from "./helpers/code-quality-fixture.js";

import { sourcePolicy } from "../scripts/code-quality-policy.mjs";

test("suppression policy reads comments, rejects escape hatches, and inventories narrow exceptions", () => {
	const documentation = `const example = "// oxlint-disable"; const other = \`// @ts-ignore\`;
/* Documentation mentions oxlint-disable-next-line, not a directive. */`;
	assert.equal(sourcePolicy("example.ts", documentation).entries.length, 0);
	for (const directive of [
		"oxlint-disable",
		"oxlint-disable-next-line no-floating-promises -- Framework work is owned",
		"oxlint-disable-next-line no-await-in-loop",
		"oxlint-disable-next-line no-await-in-loop, no-control-regex -- Ordered stream commits",
		"eslint-disable-next-line no-await-in-loop",
		"@ts-ignore",
		"@ts-nocheck",
		"@ts-nocheck0",
		"@ts-nocheck_foo",
		"@ts-ignore0",
		"@ts-ignore_foo",
		"@TS-NOCHECK",
		"/ @ts-ignore",
		"/ @ts-nocheck",
		"@ts-expect-error: forbidden outside negative type tests",
	]) {
		// oxlint-disable-next-line node-test/no-conditional-assertion -- Every listed forbidden directive is exhaustively checked.
		assert.throws(() => {
			sourcePolicy("source.ts", `// ${directive}\nexport const value = 1;`);
		});
	}
	const approved = sourcePolicy(
		"journal.ts",
		"// Journal commits must complete in order.\n// oxlint-disable-next-line no-await-in-loop\nawait commit();",
	);
	assert.equal(approved.entries.length, 1);
	assert.equal(approved.entries[0]?.rule, "no-await-in-loop");
	assert.equal(
		sourcePolicy("shape.test-d.ts", "// @ts-expect-error: rejects invalid public input\ncall(1);")
			.entries.length,
		1,
	);
	assert.throws(() => {
		sourcePolicy("shape.test-d.ts", "// @ts-expect-error: short\ncall(1);");
	});
	assert.throws(() => {
		sourcePolicy("source.ts", "/** @ts-ignore */\nexport const value: number = 'wrong';");
	});
	assert.throws(() => {
		sourcePolicy(
			"source.ts",
			"/* Explanation\n @ts-ignore */\nexport const value: number = 'wrong';",
		);
	});
	assert.throws(() => {
		sourcePolicy(
			"source.ts",
			"/* Explanation\n @ts-expect-error: forbidden outside negative type tests */\ncall(1);",
		);
	});
	assert.equal(
		sourcePolicy(
			"shape.test-d.ts",
			"/* Explanation\n @ts-expect-error: rejects invalid public input */\ncall(1);",
		).entries.length,
		1,
	);
	assert.throws(() => {
		sourcePolicy(
			"source.ts",
			"// This validator rejects protocol control characters.\n// oxlint-disable-next-line no-control-regex\n// oxlint-disable-next-line no-await-in-loop\nawait commit();",
		);
	});
	for (const [source, checked] of [
		["/// @ts-check\nexport const value = 1;", true],
		["// @ts-check-foo\nexport const value = 1;", false],
		["// @ts-check_foo\nexport const value = 1;", true],
		["// @ts-check0\nexport const value = 1;", true],
		["// \u00a0@ts-check\nexport const value = 1;", false],
		["// \u2003@ts-check\nexport const value = 1;", false],
		["/* @ts-check */\nexport const value = 1;", false],
		["/** @ts-check */\nexport const value = 1;", false],
		["#! @ts-check\nexport const value = 1;", false],
		["export const value = 1;\n// @ts-check", false],
		["// Documentation mentions @ts-check.\nexport const value = 1;", false],
		['export const value = "// @ts-check";', false],
	] as const) {
		// oxlint-disable-next-line node-test/no-conditional-assertion -- Every checking pragma and non-pragma case is exhaustively validated.
		assert.equal(sourcePolicy("source.js", source).checked, checked, source);
	}
});

test("checking pragma scope agrees with real compiler and semantic coverage", (t) => {
	const directory = fixture(t);
	for (const [name, header] of [
		["triple", "/// @ts-check"],
		["hyphen", "// @ts-check-foo"],
		["underscore", "// @ts-check_foo"],
		["zero", "// @ts-check0"],
		["block", "/* @ts-check */"],
		["jsdoc", "/** @ts-check */"],
	]) {
		writeFileSync(
			path.join(directory, `${name}.js`),
			`${header}\n/** @type {number} */\nexport const value = "wrong";\nasync function operation() { return 1; }\noperation();\n`,
		);
	}
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	const compiler = run(directory, path.join(root, "node_modules/typescript/lib/tsc.js"), [
		"--project",
		"tsconfig.json",
		"--pretty",
		"false",
	]);
	assert.equal(compiler.status, 1, compiler.stdout);
	assert.match(compiler.stdout, /triple\.js.*TS2322/u);
	assert.match(compiler.stdout, /underscore\.js.*TS2322/u);
	assert.match(compiler.stdout, /zero\.js.*TS2322/u);
	assert.doesNotMatch(compiler.stdout, /(?:block|jsdoc|hyphen)\.js/u);
	const semantic = lint(directory, ["typescript(no-floating-promises)", "typescript(TS2322)"]);
	assert.equal(semantic.diagnosticCount, 6);
	assert.match(semantic.stdout, /triple\.js/u);
	assert.match(semantic.stdout, /underscore\.js/u);
	assert.match(semantic.stdout, /zero\.js/u);
	assert.doesNotMatch(semantic.stdout, /(?:block|jsdoc|hyphen)\.js/u);
});

test("real CLI retains unchecked JS syntax checks and checked-source semantic/compiler checks", (t) => {
	const directory = fixture(t);
	writeFileSync(path.join(directory, "unchecked.js"), "export const value = 1;\n");
	writeFileSync(path.join(directory, "checked.js"), "// @ts-check\nexport const value = 1;\n");
	writeFileSync(path.join(directory, "typed.ts"), "export const value = 1;\n");
	const generated = run(directory, "scripts/code-quality.mjs", ["scope", "--write"]);
	assert.equal(generated.status, 0, generated.stderr);

	writeFileSync(path.join(directory, "unchecked.js"), "export const value = 1 == '1';\n");
	const syntactic = lint(directory, ["eslint(eqeqeq)"]);
	assert.equal(syntactic.status, 1);
	assert.match(syntactic.stdout, /eslint\(eqeqeq\)/u);
	writeFileSync(
		path.join(directory, "unchecked.js"),
		"async function operation() { return 1; }\noperation();\n",
	);
	const unchecked = lint(directory);
	assert.equal(unchecked.status, 0, unchecked.stdout);

	writeFileSync(
		path.join(directory, "checked.js"),
		"// @ts-check\nasync function operation() { return 1; }\noperation();\n",
	);
	writeFileSync(
		path.join(directory, "typed.ts"),
		"declare function operation(): Promise<number>;\noperation();\n",
	);
	const semantic = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(semantic.status, 1);
	assert.match(semantic.stdout, /typescript\(no-floating-promises\)/u);
	assert.match(semantic.stdout, /checked\.js/u);
	assert.match(semantic.stdout, /typed\.ts/u);

	writeFileSync(
		path.join(directory, "checked.js"),
		"// @ts-check\n/** @type {number} */\nexport const value = 'wrong';\n",
	);
	writeFileSync(path.join(directory, "typed.ts"), "export const value: number = 'wrong';\n");
	const compiler = lint(directory, ["typescript(TS2322)"]);
	assert.equal(compiler.status, 1);
	assert.match(compiler.stdout, /2322/u);
	assert.match(compiler.stdout, /checked\.js/u);
	assert.match(compiler.stdout, /typed\.ts/u);
	const inheritedSuppression = lint(directory, ["typescript(TS2322)"], {
		OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS: "1",
	});
	assert.equal(inheritedSuppression.status, 1);
	const mixedCaseSuppression = lint(directory, ["typescript(TS2322)"], {
		OxLiNt_TsGoLiNt_DaNgErOuSlY_SuPpReSs_PrOgRaM_DiAgNoStIcS: "1",
	});
	assert.equal(mixedCaseSuppression.status, 1);
	assert.deepEqual(inheritedSuppression.diagnosticLocations, compiler.diagnosticLocations);
	assert.deepEqual(mixedCaseSuppression.diagnosticLocations, compiler.diagnosticLocations);
	assert.deepEqual(
		compiler.diagnosticLocations
			.map((location) => ({ filename: location.filename, line: location.line }))
			.sort((left, right) => left.filename.localeCompare(right.filename)),
		[
			{ filename: "checked.js", line: 3 },
			{ filename: "typed.ts", line: 1 },
		],
	);
});

test("scope drift cannot silently add unchecked files or hide a JS checking directive", (t) => {
	const directory = fixture(t);
	writeFileSync(path.join(directory, "unchecked.js"), "export const value = 1;\n");
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	writeFileSync(path.join(directory, "unchecked.js"), "// @ts-check\nexport const value = 1;\n");
	const addedDirective = run(directory, "scripts/code-quality.mjs", ["check"]);
	assert.equal(addedDirective.status, 1);
	assert.match(addedDirective.stderr, /scope\/metadata drift/u);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	writeFileSync(path.join(directory, "new.js"), "export const value = 1;\n");
	assert.equal(run(directory, "scripts/code-quality.mjs", ["check"]).status, 1);
	writeFileSync(path.join(directory, "checked.js"), "// @ts-nocheck\nexport const value = 1;\n");
	const nocheck = run(directory, "scripts/code-quality.mjs", ["check"]);
	assert.equal(nocheck.status, 1);
	assert.match(nocheck.stderr, /compiler escape hatch/u);
});

async function lintWithClosedReader(directory: string, args: readonly string[]) {
	const child = spawn(
		process.execPath,
		[path.join(root, "scripts/code-quality.mjs"), "lint", ...args],
		{
			cwd: directory,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		},
	);
	// The reader is gone before the first write, as with `| head -c` or a quit pager.
	child.stdout.destroy();
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const status = await new Promise<number | null>((fulfill) => {
		child.on("close", fulfill);
	});
	return { status, stderr };
}

test("lint keeps its real verdict when the stdout reader has already closed", async (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "subject.ts");
	writeFileSync(
		file,
		"export function same(left: unknown, right: unknown): boolean {\n\treturn left === right;\n}\n",
	);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	assert.deepEqual(await lintWithClosedReader(directory, []), { status: 0, stderr: "" });
	writeFileSync(
		file,
		"export function same(left: unknown, right: unknown): boolean {\n\tlet loose = left == right;\n\treturn loose;\n}\n",
	);
	const failed = await lintWithClosedReader(directory, ["--fix"]);
	// The fixed declaration proves Oxlint ran; the unfixable comparison must still fail.
	assert.match(readFileSync(file, "utf8"), /const loose = left == right/u);
	assert.deepEqual(failed, { status: 1, stderr: "" });
});

test("inherited checkJs controls compiler and semantic coverage independently of test role", (t) => {
	const directory = fixture(t);
	const config = readFileSync(path.join(directory, "tsconfig.json"), "utf8");
	writeFileSync(
		path.join(directory, "tsconfig.base.json"),
		config.replace('"allowJs":true', '"allowJs":true,"checkJs":true'),
	);
	writeFileSync(path.join(directory, "tsconfig.json"), '{"extends":"./tsconfig.base.json"}\n');
	writeFileSync(
		path.join(directory, "inherited.js"),
		"async function operation() { return 1; }\noperation();\n",
	);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	const semantic = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(semantic.status, 1);
	assert.match(semantic.stdout, /typescript\(no-floating-promises\)/u);
	assert.match(semantic.stdout, /inherited\.js/u);
	writeFileSync(
		path.join(directory, "inherited.js"),
		"/** @type {number} */\nexport const value = 'wrong';\n",
	);
	const compiler = lint(directory, ["typescript(TS2322)"]);
	assert.equal(compiler.status, 1);
	assert.match(compiler.stdout, /2322/u);
	assert.match(compiler.stdout, /inherited\.js/u);
});

test("unchecked imported JavaScript stays resolvable while consumers retain type safety", (t) => {
	const directory = fixture(t);
	writeFileSync(path.join(directory, "unchecked.js"), "export const value = 'text';\n");
	writeFileSync(
		path.join(directory, "consumer.ts"),
		"import { value } from './unchecked.js';\nexport const number: number = value;\n",
	);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	const result = lint(directory, ["typescript(TS2322)"]);
	assert.equal(result.status, 1);
	assert.match(result.stdout, /2322/u);
	assert.match(result.stdout, /consumer\.ts/u);
	assert.doesNotMatch(result.stdout, /unchecked\.js.*(?:2322|no-floating-promises)/u);
});

test("checked imported JS cannot rely on compiler fallback outside explicit project inputs", (t) => {
	const directory = fixture(t);
	const config = readFileSync(path.join(directory, "tsconfig.json"), "utf8")
		.replace('"allowJs":true', '"allowJs":true,"checkJs":true')
		.replace('"include":["*.ts","*.js","test/**/*.ts"]', '"include":["consumer.ts"]');
	writeFileSync(path.join(directory, "tsconfig.json"), config);
	writeFileSync(
		path.join(directory, "checked.js"),
		"/** @type {number} */\nexport const value = 'wrong';\n",
	);
	writeFileSync(path.join(directory, "consumer.ts"), "export { value } from './checked.js';\n");
	const outside = run(directory, "scripts/code-quality.mjs", ["scope", "--write"]);
	assert.equal(outside.status, 1);
	assert.match(
		outside.stderr,
		/checked\.js: checked source is missing from explicit compiler project inputs/u,
	);
	writeFileSync(
		path.join(directory, "tsconfig.json"),
		config.replace('"include":["consumer.ts"]', '"include":["consumer.ts","checked.js"]'),
	);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	assert.equal(lint(directory, ["typescript(TS2322)"]).status, 1);
});

test("test role keeps unchecked JS syntax, TS promise checks and parameter limits", (t) => {
	const directory = fixture(t);
	mkdirSync(path.join(directory, "test"));
	writeFileSync(path.join(directory, "test", "scope.test.ts"), "export const value = 1;\n");
	writeFileSync(path.join(directory, "test", "scope.test.mjs"), "export const value = 1;\n");
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	writeFileSync(
		path.join(directory, "test", "scope.test.mjs"),
		"export function parameters(a,b,c,d,e,f,g) { return [a,b,c,d,e,f,g]; }\nPromise.resolve(1);\n",
	);
	writeFileSync(
		path.join(directory, "test", "scope.test.ts"),
		"declare function operation(): Promise<number>;\noperation();\n",
	);
	const result = lint(directory, [
		"eslint(max-params)",
		"typescript(no-floating-promises)",
		"promise(catch-or-return)",
	]);
	assert.equal(result.status, 1);
	assert.match(result.stdout, /eslint\(max-params\)/u);
	assert.match(result.stdout, /scope\.test\.ts/u);
});

test("Oxfmt preserves tabs and rejects formatting mutations through the actual CLI", (t) => {
	const directory = fixture(t);
	cpSync(path.join(root, ".oxfmtrc.json"), path.join(directory, ".oxfmtrc.json"));
	const file = path.join(directory, "format.js");
	writeFileSync(file, "export function value(){return 1}\n");
	const executable = path.join(root, "node_modules/oxfmt/bin/oxfmt");
	assert.equal(run(directory, executable, ["--check", "format.js"]).status, 1);
	assert.equal(run(directory, executable, ["--write", "format.js"]).status, 0);
	const once = readFileSync(file, "utf8");
	assert.match(once, /\n\treturn 1;/u);
	assert.equal(run(directory, executable, ["--check", "format.js"]).status, 0);
	assert.equal(run(directory, executable, ["--write", "format.js"]).status, 0);
	assert.equal(readFileSync(file, "utf8"), once);
});
