import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import nodeTest from "node:test";
import { sourcePolicy } from "../scripts/code-quality-policy.mjs";
import { readRecord } from "./helpers/assertions.js";
import { fixture, lint, root, run } from "./helpers/code-quality-fixture.js";

nodeTest(
	"directive authorization ignores literal examples and accepts described negative type tests",
	() => {
		assert.doesNotThrow(() =>
			sourcePolicy(
				"example.ts",
				`const example = "// oxlint-disable"; const other = \`// @ts-ignore\`;
/* Documentation mentions oxlint-disable-next-line, not a directive. */`,
			),
		);
		assert.doesNotThrow(() =>
			sourcePolicy(
				"shape.test-d.ts",
				"// @ts-expect-error: rejects invalid public input\ncall(1);",
			),
		);
		assert.doesNotThrow(() =>
			sourcePolicy(
				"shape.test-d.ts",
				"/* Explanation\n @ts-expect-error: rejects invalid public input */\ncall(1);",
			),
		);
		assert.throws(
			() => sourcePolicy("shape.test-d.ts", "// @ts-expect-error: short\ncall(1);"),
			/described negative type test required/u,
		);
	},
);

for (const directive of [
	"oxlint-disable",
	"oxlint-disable-next-line max-params -- QX-999: unauthorized operation",
	"eslint-disable-next-line max-params",
	"@ts-ignore",
	"@ts-nocheck",
	"@TS-NOCHECK",
	"/ @ts-ignore",
	"@ts-expect-error: forbidden outside negative type tests",
]) {
	nodeTest(`directive authorization rejects ${directive}`, () => {
		assert.throws(() => sourcePolicy("source.ts", `// ${directive}\nexport const value = 1;`));
	});
}

nodeTest(
	"directive authorization also reads compiler suppressions at the end of block comments",
	() => {
		assert.throws(
			() => sourcePolicy("source.ts", "/** @ts-ignore */\nexport const value: number = 'wrong';"),
			/compiler escape hatch/u,
		);
		assert.throws(
			() =>
				sourcePolicy(
					"source.ts",
					"/* Explanation\n @ts-ignore */\nexport const value: number = 'wrong';",
				),
			/compiler escape hatch/u,
		);
	},
);

for (const file of [
	"extensions/agent-browser/lib/tool-surface.ts",
	"extensions/agent-browser/lib/web-search.ts",
	"extensions/agent-browser/lib/orchestration/extension-tool-boundary.ts",
	"extensions/agent-browser/lib/orchestration/extension-prompt.ts",
	"extensions/agent-browser/lib/config.ts",
	"extensions/agent-browser/lib/process.ts",
	"extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.ts",
]) {
	nodeTest(`exceptions stay attached to their authorized operations in ${file}`, () => {
		const source = readFileSync(path.join(root, file), "utf8");
		const authorized = sourcePolicy(file, source);
		assert.ok(authorized.entries.length > 0);
		assert.throws(
			() => sourcePolicy("other.ts", source),
			/not attached to an authorized operation/u,
		);
		const directive = source.match(/\/\/ oxlint-disable-next-line [^\n]+/u)?.[0];
		assert.ok(directive !== undefined);
		const without = source.replace(directive, "");
		const wrongOperation = `${without}\n${directive}\nexport function unrelated(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }\n`;
		assert.throws(
			() => sourcePolicy(file, wrongOperation),
			/not attached to an authorized operation/u,
		);
		assert.throws(
			() => sourcePolicy(file, source.replace(directive, `${directive}\n${directive}`)),
			/not attached to an authorized operation/u,
		);
		assert.throws(
			() =>
				sourcePolicy(file, source.replace(directive, directive.replace(/QX-00[2345]/u, "QX-999"))),
			/unrecorded lint\/format directive/u,
		);
		assert.throws(
			() =>
				sourcePolicy(
					file,
					source.replace(directive, directive.replace("disable-next-line", "disable")),
				),
			/unrecorded lint\/format directive/u,
		);
	});
}

nodeTest(
	"native SDK directives suppress only their adjacent rule and leave neighboring violations visible",
	(t) => {
		const directory = fixture(t);
		const file = path.join(directory, "subject.ts");
		const arity =
			"export function sum(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }\n";
		const mutation =
			"export function increment(input: { count: number }): void {\ninput.count += 1;\n}\n";
		const arityDirective =
			"// oxlint-disable-next-line max-params -- QX-002: Native ABI comparison probe.\n";
		const mutationDirective =
			"// oxlint-disable-next-line no-param-reassign -- QX-003: Native mutation comparison probe.\n";
		writeFileSync(file, arity + mutation);
		const before = lint(directory, ["eslint(max-params)", "eslint(no-param-reassign)"]);
		assert.equal(before.status, 1);
		const accepted =
			arityDirective + arity + mutation.replace("input.count", mutationDirective + "input.count");
		writeFileSync(file, accepted);
		assert.equal(lint(directory).status, 0);
		assert.throws(
			() => sourcePolicy("subject.ts", accepted),
			/not attached to an authorized operation/u,
		);
		writeFileSync(
			file,
			accepted +
				arity.replace("function sum", "function otherSum") +
				mutation.replace("function increment", "function otherIncrement"),
		);
		const neighbors = lint(directory, ["eslint(max-params)", "eslint(no-param-reassign)"]);
		assert.equal(neighbors.status, 1);
		assert.equal(neighbors.diagnosticCount, 2);
		writeFileSync(
			file,
			accepted
				.replace(", e: number", "")
				.replace(" + e;", ";")
				.replace(": void", ": number")
				.replace("input.count += 1;", "return input.count;"),
		);
		const unused = run(directory, path.join(root, "scripts/oxlint.mjs"), [
			"--format=json",
			"subject.ts",
		]);
		assert.equal(unused.status, 1, unused.stdout + unused.stderr);
		assert.match(unused.stdout, /unused.*directive/iu);
	},
);

nodeTest("prompt exception cannot cover another mutation on the same line", () => {
	const file = "extensions/agent-browser/lib/orchestration/extension-prompt.ts";
	const source = readFileSync(path.join(root, file), "utf8");
	const extended = source.replace(
		"event.systemPromptOptions.sections.agent_browser = this.instructions(ctx);",
		'event.systemPromptOptions.sections.agent_browser = this.instructions(ctx); event.systemPromptOptions.sections.other = "unowned";',
	);
	assert.throws(() => sourcePolicy(file, extended), /unauthorized operation on the same line/u);
});

nodeTest("SDK type and expression callbacks cannot conceal same-line functions", () => {
	const typeFile = "extensions/agent-browser/lib/web-search.ts";
	const typeSource = readFileSync(path.join(root, typeFile), "utf8");
	const extraType = typeSource.replace(
		/readonly execute: \([\s\S]*?\) => Promise<AgentToolResult<Record<string, unknown>>>;/u,
		"readonly execute: (id: string, params: AgentBrowserWebSearchParamsInput, signal?: AbortSignal, update?: unknown, ctx?: WebSearchContext) => Promise<AgentToolResult<Record<string, unknown>>>; readonly unrelated: (a: number, b: number, c: number, d: number, e: number) => number;",
	);
	assert.notEqual(extraType, typeSource);
	assert.throws(
		() => sourcePolicy(typeFile, extraType),
		/unauthorized operation on the same line/u,
	);
	const callbackFile = "extensions/agent-browser/lib/tool-surface.ts";
	const callbackSource = readFileSync(path.join(root, callbackFile), "utf8");
	const extraCallback = callbackSource.replace(
		/const execute: AgentBrowserExecutor = async \(id, params, signal, onUpdate, ctx\) =>\s+finalizeAgentBrowserNativeResult\(\s+await options.execute\(id, params, signal, onUpdate, ctx\),\s+params,\s+\);/u,
		"const execute: AgentBrowserExecutor = async (id, params, signal, onUpdate, ctx) => ((a, b, c, d, e) => a)(id, params, signal, onUpdate, ctx);\n",
	);
	assert.notEqual(extraCallback, callbackSource);
	assert.throws(
		() => sourcePolicy(callbackFile, extraCallback),
		/unauthorized operation on the same line/u,
	);
});

nodeTest("cancellation exceptions cannot cover unrelated conditions or inline body checks", () => {
	const file = "extensions/agent-browser/lib/process.ts";
	const source = readFileSync(path.join(root, file), "utf8");
	assert.throws(
		() =>
			sourcePolicy(
				file,
				source.replace(
					"if (signal && signal.aborted) {",
					"if (signal && signal.aborted && true) {",
				),
			),
		/Missing cancellation guard/u,
	);
	assert.throws(
		() =>
			sourcePolicy(
				file,
				source.replace(
					"if (signal && signal.aborted) {",
					"if (signal && signal.aborted) { if (true) return cancelledResult();",
				),
			),
		/Missing cancellation guard/u,
	);
});

nodeTest(
	"native redaction and cancellation directives leave neighboring violations visible",
	(t) => {
		const directory = fixture(t);
		const file = path.join(directory, "subject.ts");
		const redaction =
			"export function redact(): void {\ntry { throw new Error('secret'); } catch (error) {\nif (!(error instanceof Error)) { throw error; }\nthrow new Error('safe');\n}\n}\n";
		const cancellation =
			"export async function cancelled(signal: AbortSignal): Promise<boolean> {\nif (signal.aborted) { return true; }\nawait Promise.resolve();\nif (signal.aborted) { return true; }\nreturn false;\n}\n";
		const redactionDirective =
			"// oxlint-disable-next-line eslint/preserve-caught-error -- QX-004: Content-free failure.\n";
		const cancellationDirective =
			"// oxlint-disable-next-line typescript/no-unnecessary-condition -- QX-005: Live signal after await.\n";
		const codes = ["eslint(preserve-caught-error)", "typescript(no-unnecessary-condition)"];
		writeFileSync(file, redaction + cancellation);
		assert.equal(lint(directory, codes).diagnosticCount, 2);
		const accepted =
			redaction.replace(
				"throw new Error('safe');",
				redactionDirective + "throw new Error('safe');",
			) +
			cancellation.replace(
				"await Promise.resolve();\n",
				"await Promise.resolve();\n" + cancellationDirective,
			);
		writeFileSync(file, accepted);
		assert.equal(lint(directory).status, 0);
		writeFileSync(
			file,
			accepted +
				redaction.replace("function redact", "function otherRedact") +
				cancellation.replace("function cancelled", "function otherCancelled"),
		);
		const neighbors = lint(directory, codes);
		assert.equal(neighbors.status, 1);
		assert.equal(neighbors.diagnosticCount, 2);
		writeFileSync(
			file,
			accepted
				.replace("throw new Error('safe');", "return;")
				.replace("if (signal.aborted) { return true; }\nawait", "await"),
		);
		const unused = run(directory, path.join(root, "scripts/oxlint.mjs"), [
			"--format=json",
			"subject.ts",
		]);
		assert.equal(unused.status, 1, unused.stdout + unused.stderr);
		assert.match(unused.stdout, /unused.*directive/iu);
	},
);

nodeTest(
	"SDK parameter exceptions do not authorize a sixth argument or an inline nested callback",
	() => {
		const file = "extensions/agent-browser/lib/web-search.ts";
		const source = readFileSync(path.join(root, file), "utf8");
		assert.throws(
			() =>
				sourcePolicy(
					file,
					source.replace(
						"async execute(_toolCallId, params, signal, _onUpdate, ctx)",
						"async execute(_toolCallId, params, signal, _onUpdate, ctx, extra)",
					),
				),
			/only the five-position SDK contract is authorized/u,
		);
		assert.throws(
			() =>
				sourcePolicy(
					file,
					source.replace(
						"async execute(_toolCallId, params, signal, _onUpdate, ctx) {",
						"async execute(_toolCallId, params, signal, _onUpdate, ctx) { function unrelated(a, b, c, d, e) {}",
					),
				),
			/unauthorized operation on the same line/u,
		);
	},
);

nodeTest(
	"all maintained JS is compiler-checked and semantic lint remains an independent gate",
	(t) => {
		const directory = fixture(t);
		const js = path.join(directory, "checked.js");
		const ts = path.join(directory, "typed.ts");
		writeFileSync(js, "/** @type {number} */\nexport const value = 1;\n");
		writeFileSync(ts, "export const value: number = 1;\n");
		const gate = path.join(root, "scripts/project.mjs");
		const valid = run(directory, gate, ["verify", "typecheck"]);
		assert.equal(valid.status, 0, valid.stdout + valid.stderr);
		assert.equal(lint(directory).status, 0);
		writeFileSync(js, "/** @type {number} */\nexport const value = 'wrong';\n");
		writeFileSync(ts, "export const value: number = 'wrong';\n");
		const invalid = run(directory, gate, ["verify", "typecheck"]);
		assert.equal(invalid.status, 1);
		assert.match(invalid.stdout, /checked\.js\(2,\d+\): error TS2322/u);
		assert.match(invalid.stdout, /typed\.ts\(1,\d+\): error TS2322/u);
		writeFileSync(js, "async function operation() { return 1; }\noperation();\n");
		writeFileSync(ts, "async function operation(): Promise<number> { return 1; }\noperation();\n");
		const semantic = lint(directory, ["typescript(no-floating-promises)"]);
		assert.equal(semantic.status, 1);
		assert.deepEqual(
			semantic.diagnosticLocations
				.map(({ filename, line }) => ({ filename, line }))
				.sort((a, b) => a.filename.localeCompare(b.filename)),
			[
				{ filename: "checked.js", line: 2 },
				{ filename: "typed.ts", line: 2 },
			],
		);
		const inherited = lint(directory, ["typescript(no-floating-promises)"], {
			OXLINT_TSGOLINT_PATH: path.join(directory, "unowned-backend"),
			OxLiNt_TsGoLiNt_PaTh: path.join(directory, "unowned-backend"),
		});
		assert.equal(inherited.status, 1);
		assert.deepEqual(inherited.diagnosticLocations, semantic.diagnosticLocations);
	},
);

nodeTest(
	"the real typecheck gate checks handwritten declarations and unused expected errors",
	(t) => {
		const directory = fixture(t);
		const gate = path.join(root, "scripts/project.mjs");
		const declaration = path.join(directory, "contract.d.ts");
		writeFileSync(
			declaration,
			"export interface Parent { value: string; }\nexport interface Child extends Parent { value: string; }\n",
		);
		assert.equal(run(directory, gate, ["verify", "typecheck"]).status, 0);
		writeFileSync(
			declaration,
			"export interface Parent { value: string; }\nexport interface Child extends Parent { value: number; }\n",
		);
		const invalid = run(directory, gate, ["verify", "typecheck"]);
		assert.equal(invalid.status, 1);
		assert.match(invalid.stdout, /contract\.d\.ts\(2,\d+\): error TS2430/u);
		writeFileSync(declaration, "export declare const marker: string;\n");
		const negative = path.join(directory, "contract.test-d.ts");
		writeFileSync(
			negative,
			"// @ts-expect-error: strings are not accepted as numbers\nexport const value: number = 'wrong';\n",
		);
		assert.equal(run(directory, gate, ["verify", "typecheck"]).status, 0);
		writeFileSync(
			negative,
			"// @ts-expect-error: strings are not accepted as numbers\nexport const value: number = 1;\n",
		);
		const unused = run(directory, gate, ["verify", "typecheck"]);
		assert.equal(unused.status, 1);
		assert.match(unused.stdout, /contract\.test-d\.ts\(1,\d+\): error TS2578/u);
	},
);

nodeTest("scope includes new source automatically and rejects missing compiler ownership", (t) => {
	const directory = fixture(t);
	writeFileSync(path.join(directory, "new.js"), "export const value = 1;\n");
	const valid = run(directory, "scripts/code-quality.mjs", ["scope"]);
	assert.equal(valid.status, 0, valid.stdout + valid.stderr);
	const config = readRecord(
		JSON.parse(readFileSync(path.join(directory, "tsconfig.json"), "utf8")),
	);
	writeFileSync(
		path.join(directory, "tsconfig.json"),
		JSON.stringify({ ...config, include: ["scripts/**/*.mjs", "contract.d.ts"] }),
	);
	const omitted = run(directory, "scripts/code-quality.mjs", ["scope"]);
	assert.equal(omitted.status, 1);
	assert.match(omitted.stderr, /new\.js: missing from checked tsconfig\.json/u);
});

nodeTest("scope rejects a policy downgrade and a used but unauthorized directive", (t) => {
	const directory = fixture(t);
	const configFile = path.join(directory, ".oxlintrc.json");
	const original = readFileSync(configFile, "utf8");
	const config = readRecord(JSON.parse(original));
	writeFileSync(
		configFile,
		JSON.stringify({ ...config, options: { ...readRecord(config.options), typeAware: false } }),
	);
	const weakened = run(directory, "scripts/code-quality.mjs", ["scope"]);
	assert.equal(weakened.status, 1);
	assert.match(weakened.stderr, /Oxlint policy differs/u);
	writeFileSync(configFile, original);
	writeFileSync(
		path.join(directory, "source.ts"),
		"// oxlint-disable-next-line max-params -- QX-999: unauthorized operation\nexport function sum(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }\n",
	);
	assert.equal(lint(directory).status, 0, "The directive is actually used, not rejected as unused");
	const unauthorized = run(directory, "scripts/code-quality.mjs", ["scope"]);
	assert.equal(unauthorized.status, 1);
	assert.match(unauthorized.stderr, /source\.ts:1: unrecorded lint\/format directive/u);
});

nodeTest("a Git ignore cannot hide maintained source from lint or formatting", (t) => {
	const directory = fixture(t);
	writeFileSync(path.join(directory, "subject.js"), "export const value = 1;\n");
	const added = spawnSync("git", ["add", "--", "subject.js"], { cwd: directory, encoding: "utf8" });
	assert.equal(added.status, 0, added.stderr);
	writeFileSync(
		path.join(directory, ".gitignore"),
		`${readFileSync(path.join(directory, ".gitignore"), "utf8")}\nsubject.js\n`,
	);
	const hidden = run(directory, "scripts/code-quality.mjs", ["scope"]);
	assert.equal(hidden.status, 1);
	assert.match(hidden.stderr, /Maintained source is hidden by a Git ignore rule/u);
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
	child.stdout.destroy();
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const status = await new Promise<number | null>((fulfill, reject) => {
		child.on("error", reject);
		child.on("close", fulfill);
	});
	return { status, stderr };
}

nodeTest("lint preserves its verdict when the stdout reader has closed", async (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "subject.ts");
	writeFileSync(
		file,
		"export function same(left: unknown, right: unknown): boolean { return left === right; }\n",
	);
	assert.deepEqual(await lintWithClosedReader(directory, []), { status: 0, stderr: "" });
	writeFileSync(
		file,
		"export function same(left: unknown, right: unknown): boolean { let loose = left == right; return loose; }\n",
	);
	const failed = await lintWithClosedReader(directory, ["--fix"]);
	assert.match(readFileSync(file, "utf8"), /const loose = left == right/u);
	assert.deepEqual(failed, { status: 1, stderr: "" });
});

nodeTest("Oxfmt preserves tabs, detects drift and is idempotent through its actual CLI", (t) => {
	const directory = fixture(t);
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
