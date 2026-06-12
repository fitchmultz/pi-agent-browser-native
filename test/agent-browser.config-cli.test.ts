/**
 * Purpose: Verify the pi-agent-browser-config user setup CLI writes Pi-scoped config safely and redacts secrets.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const CONFIG_SCRIPT = join(process.cwd(), "scripts", "config.mjs");
const DOCUMENTED_CONFIG_HELPER_PREFIX = "npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config";
const LOCAL_PACKAGE_SPEC = process.cwd();
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

async function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; label?: string } = {}) {
	return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? process.cwd(),
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
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
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(Object.assign(new Error(`${options.label ?? command} exited with ${code ?? "unknown"}`), { code, stdout, stderr }));
			}
		});
		child.stdin.end(options.input ?? "");
	});
}

async function runConfig(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
	return await runProcess(process.execPath, [CONFIG_SCRIPT, ...args], { ...options, label: "config CLI" });
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-config-cli-test-"));
	const cwd = join(root, "repo");
	const home = join(root, "home");
	const npmCache = join(root, "npm-cache");
	await mkdir(cwd, { recursive: true });
	await mkdir(npmCache, { recursive: true });
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")));
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
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectMarkdownFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(path);
		}
	}
	return files;
}

function tokenizeDocumentedCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) throw new Error(`Unclosed quote in documented command: ${command}`);
	if (current) tokens.push(current);
	return tokens;
}

function documentedNpmExecArgs(command: string): { args: string[]; input?: string } {
	let input: string | undefined;
	let executable = command.trim();
	const stdinPrefix = `printf '%s' "$EXA_API_KEY" | `;
	if (executable.startsWith(stdinPrefix)) {
		input = "doc-secret-exa-key";
		executable = executable.slice(stdinPrefix.length);
	}
	const tokens = tokenizeDocumentedCommand(executable);
	assert.equal(tokens[0], "npm", `documented command must start with npm exec: ${command}`);
	const packageIndex = tokens.indexOf("--package");
	assert.notEqual(packageIndex, -1, `documented command must use --package: ${command}`);
	assert.equal(tokens[packageIndex + 1], "pi-agent-browser-native@latest", `documented command must use the published package spec: ${command}`);
	tokens[packageIndex + 1] = LOCAL_PACKAGE_SPEC;
	return { args: tokens.slice(1), input };
}

test("config CLI prints Pi-scoped paths and pass-through setup help", async () => {
	const fixture = await createFixture();
	const { stdout } = await runConfig(["paths"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /\.pi\/config\/pi-agent-browser-native\/config\.json/);
	const { stdout: help } = await runConfig(["--help"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(help, /Loaded config may use plaintext, environment interpolation, or !command credential sources/);
	assert.match(help, /displayed status redacts resolved keys/);
	assert.doesNotMatch(help, /^  pi-agent-browser-config/m);
});

test("published package config docs only use npm-exec helper examples", async () => {
	const markdownFiles = ["README.md", "CHANGELOG.md", ...await collectMarkdownFiles("docs")];
	const violations: string[] = [];
	for (const path of markdownFiles) {
		const text = await readFile(path, "utf8");
		for (const [lineIndex, line] of text.split("\n").entries()) {
			if (line.includes("pi-agent-browser-config") && !line.includes(DOCUMENTED_CONFIG_HELPER_PREFIX)) {
				violations.push(`${path}:${lineIndex + 1}: ${line.trim()}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});

test("documented npm-exec package config examples execute against an isolated config", async () => {
	const fixture = await createFixture();
	const documentedCommands = new Map<string, string>();
	for (const path of ["README.md", "docs/COMMAND_REFERENCE.md"]) {
		const text = await readFile(path, "utf8");
		for (const line of text.split("\n")) {
			if (line.includes(DOCUMENTED_CONFIG_HELPER_PREFIX)) {
				documentedCommands.set(line.trim(), path);
			}
		}
	}
	assert.notEqual(documentedCommands.size, 0);
	for (const [command, path] of documentedCommands) {
		const { args, input } = documentedNpmExecArgs(command);
		await runProcess(NPM_COMMAND, args, {
			cwd: fixture.cwd,
			env: { ...fixture.env, EXA_API_KEY: "doc-secret-exa-key" },
			input,
			label: `${path} documented npm-exec config example`,
		});
	}
});

test("config CLI writes and redacts global plaintext Brave key", async () => {
	const fixture = await createFixture();
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
		assert.equal(mode, 0o600);
	}
});

test("config CLI requires providers for ambiguous credential writes", async () => {
	const fixture = await createFixture();
	await assert.rejects(
		() => runConfig(["web-search", "set-key", "--stdin"], {
			cwd: fixture.cwd,
			env: fixture.env,
			input: "real-secret-value\n",
		}),
		(error: { code?: number; stderr?: string }) => {
			assert.equal(error.code, 2);
			assert.match(error.stderr ?? "", /--provider is required and must be exa or brave/);
			return true;
		},
	);
	await assert.rejects(
		() => runConfig(["web-search", "clear"], { cwd: fixture.cwd, env: fixture.env }),
		(error: { code?: number; stderr?: string }) => {
			assert.equal(error.code, 2);
			assert.match(error.stderr ?? "", /--provider is required and must be exa, brave, or all/);
			return true;
		},
	);
});

test("config CLI writes project-local Brave key sources and redacts status", async () => {
	const fixture = await createFixture();
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

	await runConfig(["web-search", "set-command", "op read op://vault/item/key", "--provider", "brave", "--project"], {
		cwd: fixture.cwd,
		env: fixture.env,
	});
	raw = await readFile(fixture.projectPath, "utf8");
	assert.match(raw, /!op read op:\/\/vault\/item\/key/);
	({ stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env }));
	assert.match(stdout, /configured via command \(project\)/);
});

test("config CLI writes project env source, project profile, and project executable path", async () => {
	const fixture = await createFixture();
	await runConfig(["web-search", "set-env", "BRAVE_API_KEY", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(["web-search", "set-env", "EXA_API_KEY", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(["web-search", "prefer", "exa", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(["web-search", "disable", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(["browser", "profile", "set", "Profile 1", "--policy", "authenticated-only", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(["browser", "executable", "set", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "--project"], { cwd: fixture.cwd, env: fixture.env });
	const projectPath = join(fixture.cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
	const config = JSON.parse(await readFile(projectPath, "utf8")) as {
		webSearch?: { braveApiKey?: string; enabled?: boolean; exaApiKey?: string; preferredProvider?: string };
		browser?: { defaultProfile?: { name?: string; policy?: string }; executablePath?: string };
	};
	assert.equal(config.webSearch?.braveApiKey, "$BRAVE_API_KEY");
	assert.equal(config.webSearch?.exaApiKey, "$EXA_API_KEY");
	assert.equal(config.webSearch?.preferredProvider, "exa");
	assert.equal(config.webSearch?.enabled, false);
	assert.deepEqual(config.browser?.defaultProfile, { name: "Profile 1", policy: "authenticated-only" });
	assert.equal(config.browser?.executablePath, "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
	const { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /webSearch\.enabled: false/);
	assert.match(stdout, /webSearch\.exaApiKey: configured via environment interpolation/);
	assert.match(stdout, /browser\.defaultProfile: Profile 1 \(policy: authenticated-only; project\)/);
	assert.match(stdout, /browser\.executablePath: \/Applications\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser \(project\)/);
});

test("config CLI status accepts project-local custom web-search env aliases", async () => {
	const fixture = await createFixture();
	await mkdir(dirname(fixture.projectPath), { recursive: true });
	await writeFile(fixture.projectPath, JSON.stringify({ version: 1, webSearch: { braveApiKey: "$MY_BRAVE_ALIAS" } }, null, 2));
	const { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: { ...fixture.env, MY_BRAVE_ALIAS: "alias-secret" } });
	assert.doesNotMatch(stdout, /Validation errors:/);
	assert.match(stdout, /webSearch\.braveApiKey: configured via environment interpolation \(project\)/);
	assert.doesNotMatch(stdout, /alias-secret/);
});

test("config CLI writes project-local custom web-search env aliases", async () => {
	const fixture = await createFixture();
	await runConfig(["web-search", "set-env", "AWS_SECRET_ACCESS_KEY", "--provider", "exa", "--project"], { cwd: fixture.cwd, env: fixture.env });
	const raw = await readFile(fixture.projectPath, "utf8");
	assert.match(raw, /AWS_SECRET_ACCESS_KEY/);
	const { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: { ...fixture.env, AWS_SECRET_ACCESS_KEY: "aws-secret" } });
	assert.match(stdout, /webSearch\.exaApiKey: configured via environment interpolation \(project\)/);
	assert.doesNotMatch(stdout, /aws-secret/);
});
