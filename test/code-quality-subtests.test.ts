import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import nodeTest from "node:test";
import { fixture, lint } from "./helpers/code-quality-fixture.js";

nodeTest("QX-001 does not exempt context subtests or their bound callbacks", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "subtests.test.ts");
	const imports = "import assert from 'node:assert/strict';\nimport nodeTest from 'node:test';\n";
	const assertion = "assert.equal(1 + 1, 2);";
	writeFileSync(
		file,
		`${imports}nodeTest('parent', async (t) => { ${assertion} await t.test('child', () => { ${assertion} }); });\n`,
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		`${imports}nodeTest('parent', async (t) => { ${assertion} t.test('child', () => { ${assertion} }); });\n`,
	);
	const direct = lint(directory, [
		"node-test(no-unawaited-subtest)",
		"typescript(no-floating-promises)",
	]);
	assert.equal(direct.status, 1);
	assert.deepEqual(
		direct.diagnosticLocations.find(({ code }) => code === "typescript(no-floating-promises)"),
		{
			code: "typescript(no-floating-promises)",
			filename: "subtests.test.ts",
			line: 3,
		},
	);
	writeFileSync(
		file,
		`${imports}nodeTest('parent', async (t) => { ${assertion} const child = t.test.bind(t); child('child', () => { ${assertion} }); });\n`,
	);
	const bound = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(bound.status, 1);
	assert.deepEqual(bound.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "subtests.test.ts", line: 3 },
	]);
	writeFileSync(
		file,
		`${imports}nodeTest('parent', async (t) => { ${assertion} const child = t.test.bind(t); await child('child', () => { ${assertion} }); });\n`,
	);
	assert.equal(lint(directory).status, 0);
});
