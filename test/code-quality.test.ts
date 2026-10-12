import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, lint } from "./helpers/code-quality-fixture.js";

test("Node test rules reject vacuous/conditional tests and nested imported registrations", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "framework.test.ts");
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('works', () => { assert.equal(1 + 1, 2); });\n",
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		"import test from 'node:test';\ntest('vacuous', () => { console.log('not an assertion'); });\n",
	);
	const vacuous = lint(directory, ["node-test(require-assertion)"]);
	assert.equal(vacuous.status, 1);
	assert.match(vacuous.stdout, /node-test\(require-assertion\)/u);
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport test from 'node:test';\ndeclare const condition: boolean;\ntest('conditional', () => { if (condition) { assert.equal(1 + 1, 2); } });\n",
	);
	const conditional = lint(directory, ["node-test(no-conditional-assertion)"]);
	assert.equal(conditional.status, 1);
	assert.match(conditional.stdout, /node-test\(no-conditional-assertion\)/u);
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('parent', () => { assert.equal(1 + 1, 2); test('child', () => { assert.equal(1 + 1, 2); }); });\n",
	);
	const nested = lint(directory, [
		"node-test(no-nested-tests)",
		"typescript(no-floating-promises)",
	]);
	assert.equal(nested.status, 1);
	assert.match(nested.stdout, /node-test\(no-nested-tests\)/u);
});

test("qualified registration allowance cannot exempt shadows, other declarations or ordinary work", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "identity.test.ts");
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport { test as register } from 'node:test';\nregister('actual declaration', () => { assert.equal(1 + 1, 2); });\n",
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport { test as register } from 'node:test';\nregister('actual declaration', () => { assert.equal(1 + 1, 2); });\nasync function test(): Promise<number> { return 1; }\ntest();\n",
	);
	const local = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(local.status, 1);
	assert.match(local.stdout, /typescript\(no-floating-promises\)/u);
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport * as native from 'node:test';\nconst fake: typeof native = { ...native, test: Object.assign(async () => { await Promise.resolve(); }, native.test) };\nfake.test('ordinary work', () => { assert.equal(1 + 1, 2); });\n",
	);
	const borrowedNamespace = lint(directory, ["typescript(no-floating-promises)"]);
	assert.deepEqual(borrowedNamespace.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "identity.test.ts", line: 4 },
	]);
	writeFileSync(
		path.join(directory, "other.ts"),
		"export async function test(): Promise<number> { return 1; }\n",
	);
	writeFileSync(file, "import { test } from './other.js';\ntest();\n");
	const other = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(other.status, 1);
	assert.match(other.stdout, /typescript\(no-floating-promises\)/u);
	const config = readFileSync(path.join(directory, ".oxlintrc.json"), "utf8");
	writeFileSync(
		path.join(directory, ".oxlintrc.json"),
		config.replace('"package": "node:test"', '"package": "unrelated-test-runner"'),
	);
	writeFileSync(
		file,
		"import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('actual declaration', () => { assert.equal(1 + 1, 2); });\n",
	);
	const wrongPackage = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(wrongPackage.status, 1);
	assert.match(wrongPackage.stdout, /typescript\(no-floating-promises\)/u);
});
