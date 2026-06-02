/**
 * Purpose: Verify the pi-agent-browser-config user setup CLI writes Pi-scoped config safely and redacts secrets.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CONFIG_SCRIPT = join(process.cwd(), "scripts", "config.mjs");

async function runConfig(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
	return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [CONFIG_SCRIPT, ...args], {
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
				reject(Object.assign(new Error(`config CLI exited with ${code ?? "unknown"}`), { code, stdout, stderr }));
			}
		});
		child.stdin.end(options.input ?? "");
	});
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-config-cli-test-"));
	const cwd = join(root, "repo");
	await mkdir(cwd, { recursive: true });
	return {
		cwd,
		env: { ...process.env, HOME: join(root, "home"), BRAVE_API_KEY: undefined, PI_AGENT_BROWSER_CONFIG: undefined },
		globalPath: join(root, "home", ".pi", "config", "pi-agent-browser-native", "config.json"),
		root,
	};
}

test("config CLI prints Pi-scoped paths and setup safety help", async () => {
	const fixture = await createFixture();
	const { stdout } = await runConfig(["paths"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /\.pi\/config\/pi-agent-browser-native\/config\.json/);
	const { stdout: help } = await runConfig(["--help"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(help, /Project-local plaintext, interpolation-literal, malformed, and command-backed web-search keys are refused/);
});

test("config CLI writes and redacts global plaintext Brave key", async () => {
	const fixture = await createFixture();
	await runConfig(["web-search", "set-key", "--stdin"], {
		cwd: fixture.cwd,
		env: fixture.env,
		input: "real-secret-value\n",
	});
	const raw = await readFile(fixture.globalPath, "utf8");
	assert.match(raw, /real-secret-value/);
	const { stdout } = await runConfig(["show"], { cwd: fixture.cwd, env: fixture.env });
	assert.match(stdout, /configured as plaintext \[redacted\]/);
	assert.doesNotMatch(stdout, /real-secret-value/);
	if (process.platform !== "win32") {
		const mode = (await stat(fixture.globalPath)).mode & 0o777;
		assert.equal(mode, 0o600);
	}
});

test("config CLI refuses unsafe project-local Brave key sources", async () => {
	const fixture = await createFixture();
	await assert.rejects(
		() => runConfig(["web-search", "set-key", "--stdin", "--project"], {
			cwd: fixture.cwd,
			env: fixture.env,
			input: "real-secret-value\n",
		}),
		(error: { code?: number; stderr?: string }) => {
			assert.equal(error.code, 2);
			assert.match(error.stderr ?? "", /Plaintext Brave keys cannot be written to project-local config/);
			return true;
		},
	);
	await assert.rejects(
		() => runConfig(["web-search", "set-command", "op read op://vault/item/key", "--project"], {
			cwd: fixture.cwd,
			env: fixture.env,
		}),
		(error: { code?: number; stderr?: string }) => {
			assert.equal(error.code, 2);
			assert.match(error.stderr ?? "", /Command-backed Brave keys cannot be written to project-local config/);
			return true;
		},
	);
});

test("config CLI writes project env source and browser default profile", async () => {
	const fixture = await createFixture();
	await runConfig(["web-search", "set-env", "BRAVE_API_KEY", "--project"], { cwd: fixture.cwd, env: fixture.env });
	await runConfig(["browser", "profile", "set", "Default", "--policy", "authenticated-only", "--project"], { cwd: fixture.cwd, env: fixture.env });
	const projectPath = join(fixture.cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
	const config = JSON.parse(await readFile(projectPath, "utf8")) as {
		webSearch?: { braveApiKey?: string };
		browser?: { defaultProfile?: { name?: string; policy?: string } };
	};
	assert.equal(config.webSearch?.braveApiKey, "$BRAVE_API_KEY");
	assert.deepEqual(config.browser?.defaultProfile, { name: "Default", policy: "authenticated-only" });
});
