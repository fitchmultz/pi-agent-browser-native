import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, lint, root, run } from "./helpers/code-quality-fixture.js";

function nativeCases(): readonly {
	readonly name: string;
	readonly source: string;
	readonly type: string;
}[] {
	const config: unknown = JSON.parse(readFileSync(path.join(root, ".oxlintrc.json"), "utf8"));
	assert.ok(config !== null && typeof config === "object" && "rules" in config);
	assert.ok(config.rules !== null && typeof config.rules === "object");
	assert.ok("typescript/prefer-readonly-parameter-types" in config.rules);
	const rule: unknown = config.rules["typescript/prefer-readonly-parameter-types"];
	assert.ok(Array.isArray(rule));
	const options: unknown = rule[1];
	assert.ok(options !== null && typeof options === "object" && "allow" in options);
	assert.ok(Array.isArray(options.allow));
	return options.allow.flatMap((entry: unknown) => {
		assert.ok(entry !== null && typeof entry === "object" && "from" in entry && "name" in entry);
		assert.ok(typeof entry.from === "string");
		const names: unknown = entry.name;
		assert.ok(Array.isArray(names));
		const from = entry.from;
		const packageName = "package" in entry ? entry.package : null;
		return names.map((item: unknown) => nativeCase(from, packageName, item));
	});
}

function nativeCase(from: string, packageName: unknown, item: unknown) {
	assert.ok(typeof item === "string" && /^[A-Za-z]\w*$/u.test(item));
	const generic = ["Promise", "PromiseLike", "AgentToolResult"].includes(item) ? "<string>" : "";
	if (from === "lib") {
		return { name: item, source: "", type: `${item}${generic}` };
	}
	assert.equal(from, "package");
	assert.ok(typeof packageName === "string");
	if (packageName === "node" && ["Timeout", "ProcessEnv"].includes(item)) {
		return { name: item, source: "", type: `NodeJS.${item}` };
	}
	if (packageName === "stream-json" && item === "Token") {
		return {
			name: item,
			source: `import type Parser from "stream-json/parser.js";`,
			type: "Parser.Token",
		};
	}
	const nodeOrigins: Readonly<Partial<Record<string, string>>> = {
		ChildProcess: "node:child_process",
		ChildProcessWithoutNullStreams: "node:child_process",
		SpawnOptions: "node:child_process",
		ExecFileOptions: "node:child_process",
		URL: "node:url",
		StatOptions: "node:fs",
		ReadFileOptions: "node:fs",
		Dirent: "node:fs",
		Stats: "node:fs",
		FileHandle: "node:fs/promises",
		Server: "node:http",
		IncomingMessage: "node:http",
		ServerResponse: "node:http",
		AddressInfo: "node:net",
		Buffer: "node:buffer",
		EventEmitter: "node:events",
	};
	const origin = packageName === "node" ? nodeOrigins[item] : packageName;
	assert.ok(origin !== undefined, `Missing real declaration origin for ${item}`);
	const namespace = `Native_${origin.replaceAll(/[^a-zA-Z0-9]/gu, "_")}`;
	return {
		name: item,
		source: `import type * as ${namespace} from ${JSON.stringify(origin)};`,
		type: `${namespace}.${item}${item === "Model" && packageName === "@earendil-works/pi-ai" ? `<${namespace}.Api>` : generic}`,
	};
}

test("readonly allowances retain origin and mutable-addition isolation", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "readonly.ts");
	writeFileSync(
		file,
		`import type * as fs from "node:fs/promises";
export function accept(value: URL): URL { return value; }
export function rename(...args: Readonly<Parameters<typeof fs.rename>>): unknown { return args; }
export function lstat(...args: Readonly<Parameters<typeof fs.lstat>>): unknown { return args; }
export function readFile(...args: Readonly<Parameters<typeof fs.readFile>>): unknown { return args; }
export function open(...args: Readonly<Parameters<typeof fs.open>>): unknown { return args; }
`,
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		"interface URL { mutable: string; }\nexport function accept(value: URL): URL { return value; }\n",
	);
	const local = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(local.status, 1);
	assert.match(local.stdout, /typescript\(prefer-readonly-parameter-types\)/u);
	writeFileSync(
		file,
		"export function accept(value: URL & { mutable: string }): URL { return value; }\n",
	);
	const intersection = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(intersection.status, 1);
	assert.match(intersection.stdout, /typescript\(prefer-readonly-parameter-types\)/u);
	writeFileSync(
		file,
		"export function accept(value: ReadonlyMap<string, number>): ReadonlyMap<string, number> { return value; }\n",
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		"export function accept(value: ReadonlyMap<string, { mutable: number }>): unknown { return value; }\n",
	);
	assert.equal(lint(directory, ["typescript(prefer-readonly-parameter-types)"]).status, 1);
	writeFileSync(
		file,
		"export function accept(value: Map<string, number>): unknown { return value; }\n",
	);
	assert.equal(lint(directory, ["typescript(prefer-readonly-parameter-types)"]).status, 1);
	writeFileSync(
		file,
		"export function accept(value: ReadonlySet<string>): ReadonlySet<string> { return value; }\n",
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		"export function accept(value: ReadonlySet<{ mutable: string }>): unknown { return value; }\n",
	);
	assert.equal(lint(directory, ["typescript(prefer-readonly-parameter-types)"]).status, 1);
	writeFileSync(file, "export function accept(value: Set<string>): unknown { return value; }\n");
	assert.equal(lint(directory, ["typescript(prefer-readonly-parameter-types)"]).status, 1);
	writeFileSync(
		file,
		`declare global {
	interface ReadonlyMap<K, V> { counter: number; readonly probe?: (key: K, value: V) => readonly [K, V]; }
	interface ReadonlySet<T> { counter: number; readonly probe?: (first: T, second: T) => T; }
}
export function acceptMap(value: ReadonlyMap<string, number>): unknown { return value; }
export function acceptSet(value: ReadonlySet<string>): unknown { return value; }
`,
	);
	const augmented = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(augmented.diagnosticCount, 2);
});

test("readonly branded primitive inputs remain readonly without exempting mutable brands", (t) => {
	const directory = fixture(t);
	const file = path.join(directory, "brand.ts");
	writeFileSync(
		file,
		`declare const generation: unique symbol;
type Token = number & { readonly [generation]: true };
export function accept(value: Readonly<{ update: Token }>): unknown { return value; }
`,
	);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		`declare const generation: unique symbol;
type Token = number & { [generation]: { mutable: string } };
export function accept(value: Readonly<{ update: Token }>): unknown { return value; }
`,
	);
	assert.equal(lint(directory, ["typescript(prefer-readonly-parameter-types)"]).status, 1);
});

test("every configured native readonly name passes actual declarations and rejects local/file/package impostors", (t) => {
	const directory = fixture(t);
	const cases = nativeCases();
	assert.ok(cases.length > 0);
	const file = path.join(directory, "native.test.ts");
	const factory = nativeCase("package", "@earendil-works/pi-coding-agent", "ExtensionFactory");
	const imports = [...new Set([...cases.map((item) => item.source), factory.source])].join("\n");
	const positive = `${imports}\n${cases.map((item, index) => `export function accept${index}(value: ${item.type}): ${item.type} { return value; }`).join("\n")}\nexport function acceptFactory(value: ${factory.type}): ${factory.type} { return value; }\n`;
	writeFileSync(file, positive);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		file,
		cases
			.map(
				(item, index) =>
					`export function local${index}(): unknown { interface ${item.name} { mutable: string; } function accept(value: ${item.name}): ${item.name} { return value; } return accept; }`,
			)
			.join("\n"),
	);
	const local = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(local.diagnosticCount, cases.length);
	const declarations = [
		...new Set(cases.map((item) => `export interface ${item.name} { mutable: string; }`)),
	].join("\n");
	writeFileSync(path.join(directory, "other.ts"), declarations);
	writeFileSync(
		file,
		`import type * as Other from './other.js';\n${cases.map((item, index) => `export function accept${index}(value: Other.${item.name}): Other.${item.name} { return value; }`).join("\n")}`,
	);
	const otherFile = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(otherFile.diagnosticCount, cases.length);
	writeFileSync(
		path.join(directory, "package.json"),
		'{"name":"impostor","type":"module","exports":"./other.ts"}\n',
	);
	writeFileSync(
		file,
		`import type * as Other from 'impostor';\n${cases.map((item, index) => `export function accept${index}(value: Other.${item.name}): Other.${item.name} { return value; }`).join("\n")}`,
	);
	const otherPackage = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(otherPackage.diagnosticCount, cases.length);
	writeFileSync(
		file,
		`${imports}\n${cases.map((item, index) => `export function accept${index}(value: ${item.type} & { mutable: string }): unknown { return value; }`).join("\n")}\n`,
	);
	const intersections = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(intersections.diagnosticCount, cases.length);
	const config = readFileSync(path.join(directory, ".oxlintrc.json"), "utf8");
	writeFileSync(
		path.join(directory, ".oxlintrc.json"),
		config
			.replaceAll(/"package":\s*"[^"]+"/gu, '"package": "impostor"')
			.replaceAll(/"from":\s*"lib"/gu, '"from": "package", "package": "impostor"'),
	);
	writeFileSync(file, positive);
	const wrongOrigins = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(wrongOrigins.diagnosticCount, cases.length);
});

test("TS and checked-JS array aliases retain exact declaration identity without wrapper types", (t) => {
	const directory = fixture(t);
	const tsFile = path.join(directory, "test/helpers/agent-browser-harness.ts");
	const jsFile = path.join(directory, "extensions/agent-browser/lib/config-validation.js");
	mkdirSync(path.dirname(tsFile), { recursive: true });
	mkdirSync(path.dirname(jsFile), { recursive: true });
	writeFileSync(
		tsFile,
		"export type FixtureBranch = unknown[];\nexport function accept(value: FixtureBranch): FixtureBranch { return value; }\n",
	);
	writeFileSync(
		jsFile,
		"// @ts-check\n/** @typedef {string[]} ConfigDiagnostics */\n/** @param {ConfigDiagnostics} value @returns {ConfigDiagnostics} */\nexport function accept(value) { return value; }\n",
	);
	writeFileSync(
		path.join(directory, "tsconfig.json"),
		readFileSync(path.join(directory, "tsconfig.json"), "utf8").replace(
			'"include":["*.ts","*.js","test/**/*.ts"]',
			'"include":["*.ts","*.js","test/**/*.ts","extensions/**/*.js"]',
		),
	);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	assert.equal(lint(directory).status, 0);
	writeFileSync(
		path.join(path.dirname(tsFile), "wrong-harness.ts"),
		"export type FixtureBranch = unknown[];\n",
	);
	writeFileSync(
		path.join(path.dirname(jsFile), "wrong-validation.js"),
		"// @ts-check\n/** @typedef {string[]} ConfigDiagnostics */\nexport const value = 1;\n",
	);
	const config = readFileSync(path.join(directory, ".oxlintrc.json"), "utf8");
	writeFileSync(
		path.join(directory, ".oxlintrc.json"),
		config
			.replaceAll('"./test/helpers/agent-browser-harness.ts"', '"./test/helpers/wrong-harness.ts"')
			.replaceAll(
				'"./extensions/agent-browser/lib/config-validation.js"',
				'"./extensions/agent-browser/lib/wrong-validation.js"',
			),
	);
	const wrongPaths = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(wrongPaths.diagnosticCount, 2);
});

test("owned Map and Set aliases retain exact origin through readonly transfer records", (t) => {
	const directory = fixture(t);
	const base = "extensions/agent-browser/lib/orchestration/electron-host";
	mkdirSync(path.join(directory, base), { recursive: true });
	writeFileSync(
		path.join(directory, "tsconfig.json"),
		readFileSync(path.join(directory, "tsconfig.json"), "utf8").replace(
			'"include":["*.ts","*.js","test/**/*.ts"]',
			'"include":["*.ts","*.js","test/**/*.ts","extensions/**/*.ts"]',
		),
	);
	const declarations = `export type ElectronHostLaunchRecords = Map<string, { readonly label: string }>;
export type ElectronHostChildProcesses = Map<string, { readonly pid: number }>;
`;
	writeFileSync(path.join(directory, base, "contracts.ts"), declarations);
	writeFileSync(path.join(directory, base, "wrong-contracts.ts"), declarations);
	writeFileSync(
		path.join(directory, base, "cleanup.ts"),
		`import type { ElectronHostLaunchRecords, ElectronHostChildProcesses } from "./contracts.js";
export function accept(value: Readonly<{ launches: ElectronHostLaunchRecords; children: ElectronHostChildProcesses }>): unknown { return value; }
`,
	);
	const runtime = "extensions/agent-browser/lib/orchestration/extension-resource-contracts.ts";
	writeFileSync(
		path.join(directory, runtime),
		"export type ValidatedUpstreamPaths = Set<string>;\n",
	);
	writeFileSync(
		path.join(directory, runtime.replace(".ts", "-wrong.ts")),
		"export type ValidatedUpstreamPaths = Set<string>;\n",
	);
	const version = path.join(
		directory,
		"extensions/agent-browser/lib/orchestration/extension-version-check.ts",
	);
	writeFileSync(
		version,
		'import type { ValidatedUpstreamPaths } from "./extension-resource-contracts.js";\nexport function accept(value: Readonly<{ paths: ValidatedUpstreamPaths }>): unknown { return value; }\n',
	);
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	assert.equal(lint(directory).status, 0);
	const config = readFileSync(path.join(directory, ".oxlintrc.json"), "utf8");
	writeFileSync(
		path.join(directory, ".oxlintrc.json"),
		config
			.replaceAll(`./${base}/contracts.ts`, `./${base}/wrong-contracts.ts`)
			.replaceAll(`./${runtime}`, `./${runtime.replace(".ts", "-wrong.ts")}`),
	);
	const wrongOrigin = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(wrongOrigin.diagnosticCount, 2);
	writeFileSync(path.join(directory, ".oxlintrc.json"), config);
	writeFileSync(
		path.join(directory, base, "cleanup.ts"),
		"export function accept(value: Map<string, { readonly label: string }>): unknown { return value; }\n",
	);
	writeFileSync(version, "export function accept(value: Set<string>): unknown { return value; }\n");
	const ordinaryContainers = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(ordinaryContainers.diagnosticCount, 2);
});

test("local owner qualifiers isolate declaration paths, shadows and mutable additions", (t) => {
	const directory = fixture(t);
	const base = "extensions/agent-browser/lib";
	const cases = [
		["LegacyProjectionState", "browser-legacy-types.ts", "browser-legacy-projection.ts"],
		[
			"ManagedSessionRestoreState",
			"managed-session-restore-state.ts",
			"managed-session-restore-policy.ts",
		],
		["BrowserBranch", "browser-journal-branch.ts", "browser-journal.ts"],
		[
			"SessionPageState",
			"session-page-state.ts",
			"orchestration/browser-run/final-result-recovery.ts",
		],
		[
			"BrowserRunState",
			"orchestration/browser-run/types.ts",
			"orchestration/browser-run/native-helper-observation.ts",
		],
		[
			"ClickDispatchProbe",
			"orchestration/browser-run/observation-types.ts",
			"orchestration/browser-run/click-dispatch.ts",
		],
		[
			"ToolPresentation",
			"results/contracts.ts",
			"orchestration/browser-run/process-output-presentation.ts",
		],
		[
			"BrowserPrompt",
			"orchestration/extension-prompt.ts",
			"orchestration/extension-tool-boundary.ts",
		],
		["BrowserArtifacts", "orchestration/extension-artifacts.ts", "orchestration/extension-code.ts"],
		[
			"BrowserRecordingRegistry",
			"orchestration/extension-recording.ts",
			"orchestration/extension-command-run.ts",
		],
		[
			"BrowserElectronResources",
			"orchestration/extension-electron-ownership.ts",
			"orchestration/extension-host-run.ts",
		],
		[
			"BrowserManagedSessions",
			"orchestration/extension-runtime.ts",
			"orchestration/extension-command-admission.ts",
		],
		[
			"BrowserSessionResources",
			"orchestration/extension-runtime.ts",
			"orchestration/extension-command-result.ts",
		],
		[
			"BrowserBranchState",
			"orchestration/extension-runtime.ts",
			"orchestration/extension-branch-restore.ts",
		],
		[
			"BrowserCodeActivity",
			"orchestration/extension-runtime.ts",
			"orchestration/extension-lifecycle.ts",
		],
		[
			"AsyncExecutionQueue",
			"orchestration/execution-queue.ts",
			"orchestration/extension-command-output.ts",
		],
		[
			"KeyedAsyncExecutionQueue",
			"orchestration/execution-queue.ts",
			"orchestration/extension-execution-queue.ts",
		],
	] as const;
	writeFileSync(
		path.join(directory, "tsconfig.json"),
		readFileSync(path.join(directory, "tsconfig.json"), "utf8").replace(
			'"include":["*.ts","*.js","test/**/*.ts"]',
			'"include":["*.ts","*.js","test/**/*.ts","extensions/**/*.ts"]',
		),
	);
	for (const [name, declaration, consumer] of cases) {
		const declarationFile = path.join(directory, base, declaration);
		const consumerFile = path.join(directory, base, consumer);
		mkdirSync(path.dirname(declarationFile), { recursive: true });
		mkdirSync(path.dirname(consumerFile), { recursive: true });
		writeFileSync(declarationFile, `export interface ${name} { mutable: string; }\n`, {
			flag: "a",
		});
		writeFileSync(
			declarationFile.replace(".ts", "-wrong.ts"),
			`export interface ${name} { mutable: string; }\n`,
			{ flag: "a" },
		);
		const relative = path
			.relative(path.dirname(consumerFile), declarationFile)
			.replaceAll("\\", "/");
		const specifier = `${relative.startsWith(".") ? "" : "./"}${relative.replace(/\.ts$/u, ".js")}`;
		writeFileSync(
			consumerFile,
			`import type { ${name} } from ${JSON.stringify(specifier)};\nexport function accept(value: ${name}): unknown { return value; }\n`,
		);
	}
	assert.equal(run(directory, "scripts/code-quality.mjs", ["scope", "--write"]).status, 0);
	assert.equal(lint(directory).status, 0);
	const config = readFileSync(path.join(directory, ".oxlintrc.json"), "utf8");
	let wrongConfig = config;
	for (const [, declaration] of cases) {
		wrongConfig = wrongConfig.replaceAll(
			`./${base}/${declaration}`,
			`./${base}/${declaration.replace(".ts", "-wrong.ts")}`,
		);
	}
	writeFileSync(path.join(directory, ".oxlintrc.json"), wrongConfig);
	const wrongPath = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(wrongPath.diagnosticCount, cases.length);
	writeFileSync(path.join(directory, ".oxlintrc.json"), config);
	for (const [name, , consumer] of cases) {
		writeFileSync(
			path.join(directory, base, consumer),
			`interface ${name} { mutable: string; }\nexport function accept(value: ${name}): unknown { return value; }\n`,
		);
	}
	const shadows = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(shadows.diagnosticCount, cases.length);
	for (const [name, declaration, consumer] of cases) {
		const consumerFile = path.join(directory, base, consumer);
		const relative = path
			.relative(path.dirname(consumerFile), path.join(directory, base, declaration))
			.replaceAll("\\", "/");
		const specifier = `${relative.startsWith(".") ? "" : "./"}${relative.replace(/\.ts$/u, ".js")}`;
		writeFileSync(
			consumerFile,
			`import type { ${name} } from ${JSON.stringify(specifier)};\nexport function accept(value: ${name} & { mutableAddition: string }): unknown { return value; }\n`,
		);
	}
	const additions = lint(directory, ["typescript(prefer-readonly-parameter-types)"]);
	assert.equal(additions.diagnosticCount, cases.length);
	writeFileSync(
		path.join(directory, base, "orchestration/extension-runtime.ts"),
		"export interface BrowserRuntime { mutable: string; }\n",
		{ flag: "a" },
	);
	writeFileSync(
		path.join(directory, base, "orchestration/extension-host-coordination.ts"),
		`import type { BrowserRuntime } from "./extension-runtime.js";
export function accept(runtime: BrowserRuntime): unknown { runtime.mutable = "changed"; return runtime; }
`,
	);
	const rootMutation = lint(directory, [
		"typescript(prefer-readonly-parameter-types)",
		"eslint(no-param-reassign)",
	]);
	assert.equal(rootMutation.diagnosticCount, cases.length + 2);
	assert.deepEqual(
		rootMutation.diagnosticLocations.filter(
			(location) => location.filename === `${base}/orchestration/extension-host-coordination.ts`,
		),
		[
			{
				code: "eslint(no-param-reassign)",
				filename: `${base}/orchestration/extension-host-coordination.ts`,
				line: 2,
			},
			{
				code: "typescript(prefer-readonly-parameter-types)",
				filename: `${base}/orchestration/extension-host-coordination.ts`,
				line: 2,
			},
		],
	);
});
