/**
 * Purpose: Verify the pi-agent-browser-config user setup CLI writes Pi-scoped config safely and redacts secrets.
 */

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { spawn } from "cross-spawn";
import { readRecord } from "./helpers/assertions.js";

const CONFIG_SCRIPT = join(process.cwd(), "scripts", "config.mjs");
const DOCUMENTED_CONFIG_HELPER_PREFIX =
	"npm exec --yes --package pi-agent-browser-native -- pi-agent-browser-config";
const LOCAL_PACKAGE_SPEC = process.cwd();
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

async function runProcess(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly input?: string;
		readonly label?: string;
	} = {},
) {
	return await new Promise<{ readonly stdout: string; readonly stderr: string }>(
		(resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd ?? process.cwd(),
				env: options.env ?? process.env,
				stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			});
			if (child.stdout === null || child.stderr === null) {
				child.kill();
				reject(new Error("Config CLI fixture requires piped stdout and stderr"));
				return;
			}
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", reject);
			// A short-lived command may close stdin before consuming caller input.
			// Only a successful exit may make that EPIPE harmless.
			let stdinError: Readonly<NodeJS.ErrnoException> | undefined;
			child.stdin?.on("error", (error: Readonly<NodeJS.ErrnoException>) => {
				if (error.code === "EPIPE") {
					stdinError = error;
				} else {
					reject(error);
				}
			});
			child.on("close", (code) => {
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					reject(
						Object.assign(
							new Error(`${options.label ?? command} exited with ${code ?? "unknown"}`),
							{
								code,
								stdout,
								stderr,
								cause: stdinError,
							},
						),
					);
				}
			});
			child.stdin?.end(options.input);
		},
	);
}

async function runConfig(
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly input?: string;
	} = {},
) {
	return await runProcess(process.execPath, [CONFIG_SCRIPT, ...args], {
		...options,
		label: "config CLI",
	});
}

async function createFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-config-cli-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	const home = join(root, "home");
	const npmCache = join(root, "npm-cache");
	await mkdir(cwd, { recursive: true });
	await mkdir(npmCache, { recursive: true });
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")),
	);
	return {
		cwd,
		env: {
			...env,
			HOME: home,
			USERPROFILE: home,
			APPDATA: join(home, "AppData", "Roaming"),
			NPM_CONFIG_CACHE: npmCache,
			BRAVE_API_KEY: undefined,
			EXA_API_KEY: undefined,
			PI_AGENT_BROWSER_CONFIG: undefined,
		},
		globalPath: join(home, ".pi", "config", "pi-agent-browser-native", "config.json"),
		projectPath: join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json"),
		root,
	};
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(root, entry.name);
			if (entry.isDirectory()) {
				return collectMarkdownFiles(path);
			}
			if (entry.isFile() && entry.name.endsWith(".md")) {
				return [path];
			}
			return [];
		}),
	);
	return files.flat();
}

function tokenizeDocumentedCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote !== undefined && quote.length > 0) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote !== undefined && quote.length > 0) {
		throw new Error(`Unclosed quote in documented command: ${command}`);
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

function documentedNpmExecArgs(command: string): {
	readonly args: string[];
	readonly input?: string;
} {
	let input: string | undefined;
	let executable = command.trim();
	const stdinPrefix = `printf '%s' "$EXA_API_KEY" | `;
	if (executable.startsWith(stdinPrefix)) {
		input = "doc-secret-exa-key";
		executable = executable.slice(stdinPrefix.length);
	}
	const tokens = tokenizeDocumentedCommand(executable);
	assert.equal(tokens[0], "npm", `documented command must start with npm exec: ${command}`);
	assert.equal(tokens[tokens.indexOf("--") + 1], "pi-agent-browser-config");
	const packageIndex = tokens.indexOf("--package");
	assert.notEqual(packageIndex, -1, `documented command must use --package: ${command}`);
	assert.equal(
		tokens[packageIndex + 1],
		"pi-agent-browser-native",
		`documented command must use the published package spec: ${command}`,
	);
	tokens[packageIndex + 1] = LOCAL_PACKAGE_SPEC;
	return { args: tokens.slice(1), input };
}

test("config CLI prints Pi-scoped paths and pass-through setup help", async (t) => {
	const fixture = await createFixture(t);
	const { stdout } = await runConfig(["paths"], { cwd: fixture.cwd, env: fixture.env });
	assert.ok(stdout.includes(fixture.globalPath), stdout);
	assert.ok(stdout.includes(fixture.projectPath), stdout);
	const { stdout: help } = await runConfig(["--help"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(
		help,
		/Loaded config may use plaintext, environment interpolation, or !command credential sources/,
	);
	assert.match(help, /displayed status redacts resolved keys/);
	assert.doesNotMatch(help, /^  pi-agent-browser-config/m);
});

test("config CLI executes from paths requiring file URL encoding", async (t) => {
	const fixture = await createFixture(t);
	const packageRoot = join(fixture.root, "package space # ü");
	const script = join(packageRoot, "scripts", "config.mjs");
	const policy = join(packageRoot, "extensions", "agent-browser", "lib", "config-policy.js");
	await mkdir(dirname(script), { recursive: true });
	await mkdir(dirname(policy), { recursive: true });
	await copyFile(CONFIG_SCRIPT, script);
	await Promise.all(
		["config-policy.js", "config-providers.js", "config-validation.js"].map((name) =>
			copyFile(
				join(process.cwd(), "extensions", "agent-browser", "lib", name),
				join(dirname(policy), name),
			),
		),
	);
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ type: "module" }));
	const { stdout } = await runProcess(process.execPath, [script, "paths"], {
		cwd: fixture.cwd,
		env: fixture.env,
	});
	assert.ok(stdout.includes(fixture.globalPath), stdout);
	assert.ok(stdout.includes(fixture.projectPath), stdout);
	await assert.rejects(
		runProcess(process.execPath, [script, "not-a-command"], { cwd: fixture.cwd, env: fixture.env }),
		{ code: 2 },
	);
});

test("config module imports without invoking the CLI or inspecting the caller operand", async (t) => {
	const fixture = await createFixture(t);
	const moduleUrl = JSON.stringify(pathToFileURL(CONFIG_SCRIPT).href);
	const { stdout, stderr } = await runProcess(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { main } = await import(${moduleUrl}); if (typeof main !== "function") throw new Error("missing main export");`,
			join(fixture.root, "nonexistent-caller"),
		],
		{ cwd: fixture.cwd, env: fixture.env },
	);
	assert.equal(stdout, "");
	assert.equal(stderr, "");
});

test("published package config docs only use npm-exec helper examples", async () => {
	const markdownFiles = ["README.md", "CHANGELOG.md", ...(await collectMarkdownFiles("docs"))];
	const violations: string[] = [];
	const markdown = await Promise.all(
		markdownFiles.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
	);
	for (const { path, text } of markdown) {
		for (const [lineIndex, line] of text.split("\n").entries()) {
			if (
				line.includes("pi-agent-browser-config") &&
				!line.includes(DOCUMENTED_CONFIG_HELPER_PREFIX)
			) {
				violations.push(`${path}:${lineIndex + 1}: ${line.trim()}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});

test("documented npm-exec package config examples execute against an isolated config", async (t) => {
	const fixture = await createFixture(t);
	const documentedCommands = new Map<string, string>();
	const markdown = await Promise.all(
		["README.md", "docs/COMMAND_REFERENCE.md"].map(async (path) => ({
			path,
			text: await readFile(path, "utf8"),
		})),
	);
	for (const { path, text } of markdown) {
		for (const line of text.split("\n")) {
			if (line.includes(DOCUMENTED_CONFIG_HELPER_PREFIX)) {
				documentedCommands.set(line.trim(), path);
			}
		}
	}
	assert.notEqual(documentedCommands.size, 0);
	// Resolve npm's installed bin directory once; each example still invokes the installed helper.
	const { stdout: helperPath } = await runProcess(
		NPM_COMMAND,
		[
			"exec",
			"--yes",
			"--package",
			LOCAL_PACKAGE_SPEC,
			"--",
			process.execPath,
			"-e",
			"process.stdout.write(process.env.PATH)",
		],
		{
			cwd: fixture.cwd,
			env: { ...fixture.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
		},
	);
	for (const [command, path] of documentedCommands) {
		const { args, input } = documentedNpmExecArgs(command);
		const helperIndex = args.indexOf("--") + 1;
		// Each installed helper command mutates the same isolated configuration in documented order.
		// oxlint-disable-next-line no-await-in-loop
		await runProcess(args[helperIndex], args.slice(helperIndex + 1), {
			cwd: fixture.cwd,
			env: { ...fixture.env, PATH: helperPath, EXA_API_KEY: "doc-secret-exa-key" },
			input,
			label: `${path} documented npm-exec config example`,
		});
	}
});

test("config CLI writes and redacts global plaintext Brave key", async (t) => {
	const fixture = await createFixture(t);
	await runConfig(["web-search", "set-key", "--provider", "brave", "--stdin"], {
		cwd: fixture.cwd,
		env: fixture.env,
		input: "real-secret-value\n",
	});
	const raw = await readFile(fixture.globalPath, "utf8");
	assert.match(raw, /real-secret-value/);
	const { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /configured as plaintext global value \[redacted\]/);
	assert.doesNotMatch(stdout, /real-secret-value/);
	if (process.platform !== "win32") {
		const mode = (await stat(fixture.globalPath)).mode & 0o777;
		// POSIX config files require mode 0600; native Windows has no equivalent permission-bit contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(mode, 0o600);
	}
});

test("config CLI parse diagnostics do not expose malformed credential values", async (t) => {
	const fixture = await createFixture(t);
	await mkdir(dirname(fixture.projectPath), { recursive: true });
	await writeFile(fixture.projectPath, '{"webSearch":{"braveApiKey":cfgkey7}}');
	const { stdout, stderr } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /Validation errors:/);
	assert.match(stdout, /Could not parse project config .*config\.json/);
	assert.doesNotMatch(stdout + stderr, /cfgkey7/);
});

test("config CLI requires providers for ambiguous credential writes", async (t) => {
	const fixture = await createFixture(t);
	await assert.rejects(
		() =>
			runConfig(["web-search", "set-key", "--stdin"], {
				cwd: fixture.cwd,
				env: fixture.env,
				input: "real-secret-value\n",
			}),
		(error: { readonly code?: number; readonly stderr?: string }) => {
			assert.equal(error.code, 2);
			assert.match(error.stderr ?? "", /--provider is required and must be exa or brave/);
			return true;
		},
	);
	await assert.rejects(
		() => runConfig(["web-search", "clear"], { cwd: fixture.cwd, env: fixture.env }),
		(error: { readonly code?: number; readonly stderr?: string }) => {
			assert.equal(error.code, 2);
			assert.match(error.stderr ?? "", /--provider is required and must be exa, brave, or all/);
			return true;
		},
	);
});

test("config CLI writes project-local Brave key sources and redacts status", async (t) => {
	const fixture = await createFixture(t);
	await runConfig(["web-search", "set-key", "--provider", "brave", "--stdin", "--project"], {
		cwd: fixture.cwd,
		env: fixture.env,
		input: "real-secret-value\n",
	});
	let raw = await readFile(fixture.projectPath, "utf8");
	assert.match(raw, /real-secret-value/);
	let { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /configured as plaintext project value \[redacted\]/);
	assert.doesNotMatch(stdout, /real-secret-value/);

	await runConfig(
		[
			"web-search",
			"set-command",
			"op read op://vault/item/key",
			"--provider",
			"brave",
			"--project",
		],
		{
			cwd: fixture.cwd,
			env: fixture.env,
		},
	);
	raw = await readFile(fixture.projectPath, "utf8");
	assert.match(raw, /!op read op:\/\/vault\/item\/key/);
	({ stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env }));
	assert.match(stdout, /configured via command \(project\)/);
});

test("config CLI writes project env source, project profile, and project executable path", async (t) => {
	const fixture = await createFixture(t);
	await runConfig(["web-search", "set-env", "BRAVE_API_KEY", "--project"], {
		cwd: fixture.cwd,
		env: fixture.env,
	});
	await runConfig(["web-search", "set-env", "EXA_API_KEY", "--project"], {
		cwd: fixture.cwd,
		env: fixture.env,
	});
	await runConfig(["web-search", "prefer", "exa", "--project"], {
		cwd: fixture.cwd,
		env: fixture.env,
	});
	await runConfig(["web-search", "disable", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(
		["browser", "profile", "set", "Profile 1", "--policy", "authenticated-only", "--project"],
		{ cwd: fixture.cwd, env: fixture.env },
	);
	await runConfig(
		[
			"browser",
			"executable",
			"set",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"--project",
		],
		{ cwd: fixture.cwd, env: fixture.env },
	);
	const projectPath = join(fixture.cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
	const config = readRecord(JSON.parse(await readFile(projectPath, "utf8")));
	assert.equal(readRecord(config.webSearch).braveApiKey, "$BRAVE_API_KEY");
	assert.equal(readRecord(config.webSearch).exaApiKey, "$EXA_API_KEY");
	assert.equal(readRecord(config.webSearch).preferredProvider, "exa");
	assert.equal(readRecord(config.webSearch).enabled, false);
	assert.deepEqual(readRecord(config.browser).defaultProfile, {
		name: "Profile 1",
		policy: "authenticated-only",
	});
	assert.equal(
		readRecord(config.browser).executablePath,
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	);
	const { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /webSearch\.enabled: false/);
	assert.match(stdout, /webSearch\.exaApiKey: configured via environment interpolation/);
	assert.match(
		stdout,
		/browser\.defaultProfile: Profile 1 \(policy: authenticated-only; project\)/,
	);
	assert.match(
		stdout,
		/browser\.executablePath: \/Applications\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser \(project\)/,
	);
});

for (const [provider, alias] of [
	["exa", "AWS_SECRET_ACCESS_KEY"],
	["brave", "MY_BRAVE_ALIAS"],
] as const) {
	test(`config CLI writes project-local custom ${provider} env aliases and preserves search defaults`, async (t) => {
		const fixture = await createFixture(t);
		await mkdir(dirname(fixture.projectPath), { recursive: true });
		await writeFile(
			fixture.projectPath,
			JSON.stringify({ version: 1, webSearch: { defaultSearchType: "deep-lite" } }),
		);
		await runConfig(["web-search", "set-env", alias, "--provider", provider, "--project"], {
			cwd: fixture.cwd,
			env: fixture.env,
		});
		const raw = readRecord(JSON.parse(await readFile(fixture.projectPath, "utf8")));
		assert.equal(readRecord(raw.webSearch)[`${provider}ApiKey`], `$${alias}`);
		assert.equal(readRecord(raw.webSearch).defaultSearchType, "deep-lite");
		const { stdout } = await runConfig(["show"], {
			cwd: fixture.cwd,
			env: { ...fixture.env, [alias]: "alias-secret" },
		});
		assert.doesNotMatch(stdout, /Validation errors:/);
		assert.match(stdout, /webSearch\.defaultSearchType: deep-lite/);
		assert.match(
			stdout,
			new RegExp(
				`webSearch\\.${provider}ApiKey: configured via environment interpolation \\(project\\)`,
			),
		);
		assert.doesNotMatch(stdout, /alias-secret/);
	});
}
