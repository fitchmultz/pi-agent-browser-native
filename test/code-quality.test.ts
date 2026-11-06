import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import nodeTest from "node:test";
import { fixture, lint, run } from "./helpers/code-quality-fixture.js";

const assertion = "assert.equal(1 + 1, 2);";
const imports = "import assert from 'node:assert/strict';\nimport nodeTest from 'node:test';\n";

nodeTest(
	"Node checks reject assertion-free, conditional and nested imported registrations",
	(t) => {
		const directory = fixture(t);
		const file = path.join(directory, "framework.test.ts");
		writeFileSync(file, `${imports}nodeTest('valid', () => { ${assertion} });\n`);
		assert.equal(lint(directory).status, 0);
		writeFileSync(
			file,
			"import nodeTest from 'node:test';\nnodeTest('empty', () => { console.log('no assertion'); });\n",
		);
		const empty = lint(directory, ["node-test(require-assertion)"]);
		assert.equal(empty.status, 1);
		assert.deepEqual(empty.diagnosticLocations, [
			{ code: "node-test(require-assertion)", filename: "framework.test.ts", line: 2 },
		]);
		writeFileSync(
			file,
			`${imports}declare const condition: boolean;\nnodeTest('conditional', () => { if (condition) { ${assertion} } });\n`,
		);
		const conditional = lint(directory, ["node-test(no-conditional-assertion)"]);
		assert.equal(conditional.status, 1);
		assert.deepEqual(conditional.diagnosticLocations, [
			{ code: "node-test(no-conditional-assertion)", filename: "framework.test.ts", line: 4 },
		]);
		writeFileSync(
			file,
			`${imports}nodeTest('parent', () => { ${assertion} nodeTest('child', () => { ${assertion} }); });\n`,
		);
		const nested = lint(directory, ["node-test(no-nested-tests)"]);
		assert.equal(nested.status, 1);
		assert.deepEqual(nested.diagnosticLocations, [
			{ code: "node-test(no-nested-tests)", filename: "framework.test.ts", line: 3 },
		]);
	},
);

nodeTest(
	"QX-001 admits actual registrations but rejects wrong origins and floating body work",
	(t) => {
		const directory = fixture(t);
		const file = path.join(directory, "identity.test.ts");
		writeFileSync(
			file,
			`${imports.replace("import nodeTest from", "import nodeTest, { describe } from")}nodeTest('top', () => { ${assertion} });\nawait describe('suite', () => { nodeTest('child', () => { ${assertion} }); });\n`,
		);
		assert.equal(lint(directory).status, 0);
		writeFileSync(
			file,
			`import assert from 'node:assert/strict';\nimport { test as nodeTest, describe } from 'node:test';\nnodeTest('top named', () => { ${assertion} });\nawait describe('suite', () => { nodeTest('child', () => { ${assertion} }); });\n`,
		);
		assert.equal(lint(directory).status, 0);
		writeFileSync(file, "async function nodeTest(): Promise<number> { return 1; }\nnodeTest();\n");
		const local = lint(directory, ["typescript(no-floating-promises)"]);
		assert.equal(local.status, 1);
		assert.deepEqual(local.diagnosticLocations, [
			{ code: "typescript(no-floating-promises)", filename: "identity.test.ts", line: 2 },
		]);
		writeFileSync(
			path.join(directory, "other.ts"),
			"export async function nodeTest(): Promise<number> { return 1; }\n",
		);
		writeFileSync(file, "import { nodeTest } from './other.js';\nnodeTest();\n");
		const foreign = lint(directory, ["typescript(no-floating-promises)"]);
		assert.equal(foreign.status, 1);
		assert.deepEqual(foreign.diagnosticLocations, [
			{ code: "typescript(no-floating-promises)", filename: "identity.test.ts", line: 2 },
		]);
		writeFileSync(
			file,
			`${imports}nodeTest('body', () => { Promise.resolve(1); ${assertion} });\n`,
		);
		const body = lint(directory, ["promise(catch-or-return)", "typescript(no-floating-promises)"]);
		assert.equal(body.status, 1);
		assert.deepEqual(body.diagnosticLocations, [
			{ code: "promise(catch-or-return)", filename: "identity.test.ts", line: 3 },
			{ code: "typescript(no-floating-promises)", filename: "identity.test.ts", line: 3 },
		]);
		writeFileSync(file, "Promise.resolve(1);\n");
		const unrelated = lint(directory, [
			"promise(catch-or-return)",
			"typescript(no-floating-promises)",
		]);
		assert.equal(unrelated.status, 1);
		assert.deepEqual(unrelated.diagnosticLocations, [
			{ code: "promise(catch-or-return)", filename: "identity.test.ts", line: 1 },
			{ code: "typescript(no-floating-promises)", filename: "identity.test.ts", line: 1 },
		]);
		const config = readFileSync(path.join(directory, ".oxlintrc.json"), "utf8");
		writeFileSync(
			path.join(directory, ".oxlintrc.json"),
			config.replace('"package": "node:test"', '"package": "unrelated-runner"'),
		);
		writeFileSync(file, `${imports}nodeTest('origin', () => { ${assertion} });\n`);
		const origin = lint(directory, ["typescript(no-floating-promises)"]);
		assert.equal(origin.status, 1);
		assert.deepEqual(origin.diagnosticLocations, [
			{ code: "typescript(no-floating-promises)", filename: "identity.test.ts", line: 3 },
		]);
	},
);

nodeTest("QX-001 preserves native module hook timing that awaiting registration changes", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "registration.test.mjs");
	const source = `import assert from 'node:assert/strict';\nimport nodeTest, { before } from 'node:test';\nlet ready = false;\nnodeTest('module hook is ready', () => { assert.equal(ready, true); });\nbefore(() => { ready = true; });\n`;
	writeFileSync(file, source);
	const native = run(directory, file, []);
	assert.equal(native.status, 0, native.stdout + native.stderr);
	writeFileSync(file, source.replace("nodeTest('module", "await nodeTest('module"));
	const awaited = run(directory, file, []);
	assert.equal(awaited.status, 1, awaited.stdout + awaited.stderr);
	assert.match(awaited.stdout + awaited.stderr, /ERR_ASSERTION/u);
	assert.match(awaited.stdout + awaited.stderr, /false !== true/u);
});
