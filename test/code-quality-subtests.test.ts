import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, lint } from "./helpers/code-quality-fixture.js";

test("real Node subtests and bound aliases cannot escape complete promise-ownership enforcement", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "subtests.test.ts");
	const imports = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";
	writeFileSync(
		file,
		`${imports}test('parent', async (t) => { assert.equal(1 + 1, 2); t.test('child', () => { assert.equal(1 + 1, 2); }); });\n`,
	);
	const direct = lint(directory, [
		"node-test(no-unawaited-subtest)",
		"typescript(no-floating-promises)",
	]);
	assert.equal(direct.status, 1);
	writeFileSync(
		file,
		`${imports}test('parent', async (t) => { assert.equal(1 + 1, 2); const child = t.test.bind(t); child('child', () => { assert.equal(1 + 1, 2); }); });\n`,
	);
	const alias = lint(directory, ["typescript(no-floating-promises)"]);
	assert.equal(alias.diagnosticCount, 1);
	writeFileSync(
		file,
		`${imports}test('parent', async (t) => { assert.equal(1 + 1, 2); await t.test('direct child', () => { assert.equal(1 + 1, 2); }); const child = t.test.bind(t); await child('bound child', () => { assert.equal(1 + 1, 2); }); });\n`,
	);
	assert.equal(lint(directory).status, 0);
	for (const body of [
		"declare function wrap(body: () => Promise<void>): () => Promise<void>;\ntest('parent', wrap(async () => { assert.equal(1 + 1, 2); test('child', () => { assert.equal(1 + 1, 2); }); }));",
		"const holder = { body: () => { assert.equal(1 + 1, 2); test('child', () => { assert.equal(1 + 1, 2); }); } };\ntest('parent', holder.body);",
		"function helper(): void { test('child', () => { assert.equal(1 + 1, 2); }); }\ntest('parent', () => { assert.equal(1 + 1, 2); helper(); });",
	]) {
		writeFileSync(file, `${imports}${body}\n`);
		const indirect = lint(directory, ["typescript(no-floating-promises)"]);
		// oxlint-disable-next-line node-test/no-conditional-assertion -- Every indirect registration variant must independently expose one ownership failure.
		assert.equal(indirect.diagnosticCount, 1);
	}
	writeFileSync(
		file,
		`${imports.replace("import test from 'node:test';", "import test, { describe } from 'node:test';")}\nfunction defineCases(): void { test('child', () => { assert.equal(1 + 1, 2); }); }\ndescribe('suite', defineCases);\n`,
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		`${imports.replace("import test from 'node:test';", "import test, { describe } from 'node:test';")}
function defineCases(): void {
	test('child', () => { assert.equal(1 + 1, 2); });
}
describe('suite', defineCases);
test('parent', () => { assert.equal(1 + 1, 2); defineCases(); });
`,
	);
	const reusedSuite = lint(directory, ["typescript(no-floating-promises)"]);
	assert.deepEqual(reusedSuite.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "subtests.test.ts", line: 5 },
	]);
	writeFileSync(
		file,
		`${imports.replace("import test from 'node:test';", "import test, { describe } from 'node:test';")}
const defineCases = function named(): void { test('child', () => { assert.equal(1 + 1, 2); }); };
describe('suite', defineCases);
`,
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		`${imports.replace("import test from 'node:test';", "import test, { describe } from 'node:test';")}
const defineCases = function named(): void {
	test('child', () => { assert.equal(1 + 1, 2); });
	test('parent', () => { assert.equal(1 + 1, 2); if (Date.now() < 0) { named(); } });
};
describe('suite', defineCases);
`,
	);
	const namedReuse = lint(directory, ["typescript(no-floating-promises)"]);
	assert.deepEqual(namedReuse.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "subtests.test.ts", line: 5 },
		{ code: "typescript(no-floating-promises)", filename: "subtests.test.ts", line: 6 },
	]);
	writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		path.join(directory, "suite.ts"),
		`${imports.replace("import test from 'node:test';", "import test, { describe } from 'node:test';")}
export function defineCases(): void {
	test('child', () => { assert.equal(1 + 1, 2); });
}
describe('suite', defineCases);
`,
	);
	writeFileSync(file, `${imports}test('unrelated', () => { assert.equal(1 + 1, 2); });\n`);
	assert.equal(lint(directory).status, 0);
	mkdirSync(path.join(directory, "foreign"));
	writeFileSync(path.join(directory, "unrelated.ts"), "export const value = 1;\n");
	writeFileSync(path.join(directory, "foreign", "anchor.ts"), "export const anchor = 'foreign';\n");
	writeFileSync(
		path.join(directory, "foreign", "unrelated.ts"),
		"export { defineCases } from '../suite.js';\nexport const source = 'foreign';\n",
	);
	for (const consumer of [
		"import * as suite from './suite.js';\nconst { defineCases } = suite;\ntest('parent', () => { assert.equal(1 + 1, 2); defineCases(); });",
		"test('parent', async () => { assert.equal(1 + 1, 2); const { defineCases } = await import('./suite.js'); defineCases(); });",
		"test('parent', async () => { assert.equal(1 + 1, 2); const suite = await import('./suite.js'); suite['defineCases'](); });",
		"test('parent', async () => { assert.equal(1 + 1, 2); await import('./suite.js').then(({ defineCases }) => { defineCases(); }); });",
		"test('parent', async () => { assert.equal(1 + 1, 2); const [{ defineCases }] = await Promise.all([import('./suite.js'), import('node:path')]); defineCases(); });",
		"test('parent', async () => { assert.equal(1 + 1, 2); const { mod: { defineCases } } = { mod: await import('./suite.js') }; defineCases(); });",
		"import { createRequire } from 'node:module';\ninterface SuiteModule { readonly defineCases: () => void; }\nconst load: (id: string) => SuiteModule = createRequire(import.meta.url);\ntest('parent', () => { assert.equal(1 + 1, 2); load('./suite.ts').defineCases(); });",
		"import { source } from './foreign/unrelated.js';\nimport { createRequire } from 'node:module';\ninterface SuiteModule { readonly defineCases: () => void; }\nconst load: (id: string) => SuiteModule = createRequire(new URL('./foreign/anchor.ts', import.meta.url));\ntest('parent', () => { assert.equal(source, 'foreign'); load('./unrelated.ts').defineCases(); });",
		"import { createRequire } from 'node:module';\ninterface SuiteModule { readonly defineCases: () => void; }\nconst load: (id: string) => SuiteModule = createRequire(import.meta.url);\ntest('parent', () => { assert.equal(1 + 1, 2); load['call'](globalThis, './suite.ts').defineCases(); });",
		"import { createRequire } from 'node:module';\ninterface SuiteModule { readonly defineCases: () => void; }\nconst load: (id: string) => SuiteModule = createRequire(import.meta.url);\ntest('parent', () => { assert.equal(1 + 1, 2); load['apply'](globalThis, ['./suite.ts']).defineCases(); });",
		"import { createRequire } from 'node:module';\ninterface SuiteModule { readonly defineCases: () => void; }\nconst load: (id: string) => SuiteModule = createRequire(import.meta.url);\ntest('parent', () => { assert.equal(1 + 1, 2); load.call(globalThis, './suite.ts').defineCases(); });",
		"import { createRequire } from 'node:module';\ninterface SuiteModule { readonly defineCases: () => void; }\nconst load: (id: string) => SuiteModule = createRequire(import.meta.url);\ntest('parent', () => { assert.equal(1 + 1, 2); load.apply(globalThis, ['./suite.ts']).defineCases(); });",
		"import vm from 'node:vm';\ntest('parent', () => { assert.equal(1 + 1, 2); vm.runInThisContext(\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); });",
		"import vm from 'node:vm';\ntest('parent', () => { assert.equal(1 + 1, 2); vm['runInThisContext'](\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); });",
		"import vm from 'node:vm';\nconst { runInThisContext } = vm;\ntest('parent', () => { assert.equal(1 + 1, 2); runInThisContext(\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); });",
		"const { runInThisContext } = process.getBuiltinModule('node:vm');\ntest('parent', () => { assert.equal(1 + 1, 2); runInThisContext(\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); });",
		"import vm from 'node:vm';\nconst { native: { runInThisContext } } = { native: vm };\ntest('parent', () => { assert.equal(1 + 1, 2); runInThisContext(\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); });",
		"import vm from 'node:vm';\ntest('parent', () => { assert.equal(1 + 1, 2); for (const { runInThisContext } of [vm]) { runInThisContext(\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); } });",
		"import vm from 'node:vm';\ntest('parent', () => { assert.equal(1 + 1, 2); [vm].forEach(({ runInThisContext }) => { runInThisContext(\"process.getBuiltinModule('node:module').createRequire(\" + JSON.stringify(import.meta.url) + \")('./suite.ts').defineCases()\"); }); });",
	]) {
		writeFileSync(file, `${imports}${consumer}\n`);
		const importedReuse = lint(directory, ["typescript(no-floating-promises)"]);
		// oxlint-disable-next-line node-test/no-conditional-assertion -- Each module-reference form must expose the exact unowned registration in the exported suite.
		assert.deepEqual(importedReuse.diagnosticLocations, [
			{ code: "typescript(no-floating-promises)", filename: "suite.ts", line: 5 },
		]);
	}
	writeFileSync(
		path.join(directory, "package.json"),
		'{"name":"owned-suite","type":"module","exports":{"types":"./types.d.ts","require":"./runtime.mjs","default":"./runtime.mjs"}}\n',
	);
	writeFileSync(path.join(directory, "types.d.ts"), "export declare const marker: string;\n");
	writeFileSync(
		path.join(directory, "runtime.mjs"),
		"export const marker = 'owned';\nexport { defineCases } from './suite.ts';\n",
	);
	writeFileSync(
		file,
		`${imports}import { createRequire } from 'node:module';
import { marker } from 'owned-suite';
interface SuiteModule { readonly defineCases: () => void; }
const load: (id: string) => SuiteModule = createRequire(import.meta.url);
test('parent', () => { assert.equal(marker, 'owned'); load('owned-suite').defineCases(); });
`,
	);
	const declarationOnlyTarget = lint(directory, ["typescript(no-floating-promises)"]);
	assert.deepEqual(declarationOnlyTarget.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "suite.ts", line: 5 },
	]);
	writeFileSync(
		path.join(directory, "package.json"),
		'{"name":"owned-suite","type":"module","exports":{"types":"./innocent.ts","require":"./runtime.mjs","default":"./runtime.mjs"}}\n',
	);
	writeFileSync(path.join(directory, "innocent.ts"), "export const marker = 'owned';\n");
	const sourceTypesTarget = lint(directory, ["typescript(no-floating-promises)"]);
	assert.deepEqual(sourceTypesTarget.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "suite.ts", line: 5 },
	]);
	writeFileSync(path.join(directory, "innocent.js"), "export { defineCases } from './suite.ts';\n");
	writeFileSync(
		file,
		`${imports}import { createRequire } from 'node:module';
interface SuiteModule { readonly defineCases: () => void; }
const load: (id: string) => SuiteModule = createRequire(import.meta.url);
test('parent', () => { assert.equal(1 + 1, 2); load('./innocent.js').defineCases(); });
`,
	);
	const substitutedRuntimeTarget = lint(directory, ["typescript(no-floating-promises)"]);
	assert.deepEqual(substitutedRuntimeTarget.diagnosticLocations, [
		{ code: "typescript(no-floating-promises)", filename: "suite.ts", line: 5 },
	]);
});
