import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import nodeTest from "node:test";
import { readRecord, readString, hasErrorCode, readNumber } from "./helpers/assertions.js";
import crossSpawn from "cross-spawn";
import {
	buildAgentBrowserProcessEnv,
	runAgentBrowserProcess,
} from "../extensions/agent-browser/lib/process.js";
import { resolveWindowsStockLauncher } from "../extensions/agent-browser/lib/windows-stock-launcher.js";
import { withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

const windows = process.platform === "win32";
const template =
	'@ECHO off\r\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*\r\n';
const vector = [
	"",
	"one two",
	'"quoted"',
	"C:\\path with space\\",
	"雪 🐎",
	"one\ntwo",
	"one\r\ntwo",
	"%PATH%",
	"a&b",
	"a^b",
];
const capture =
	"process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:require('node:fs').readFileSync(0,'utf8'),exe:process.execPath}));";
async function sameFile(a: string, b: string) {
	const [left, right] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
	assert.deepEqual([left.dev, left.ino], [right.dev, right.ino]);
}
async function stock(root: string) {
	const bin = join(root, "node_modules", "agent-browser", "bin");
	await mkdir(bin, { recursive: true });
	await writeFile(
		join(dirname(bin), "package.json"),
		JSON.stringify({ name: "agent-browser", bin: { "agent-browser": "bin/agent-browser.js" } }),
	);
	const exe = join(bin, "agent-browser-win32-x64.exe");
	await copyFile(process.execPath, exe);
	await writeFile(join(root, "agent-browser.cmd"), template);
	return exe;
}
function childEnv(path: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "path") {
			env[key] = undefined;
		}
	}
	return { ...env, Path: path };
}
function original(
	cwd: string,
	env: Readonly<NodeJS.ProcessEnv>,
	args: readonly string[],
	input = "",
) {
	// Use the same effective environment, not the override map: undefined keys
	// mean deletion to the product, but Node deduplicates PATH casing before
	// dropping undefined values. Command selection itself is the real library.
	const result = crossSpawn.sync("agent-browser", args, {
		cwd,
		env: buildAgentBrowserProcessEnv(process.env, env),
		input,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(result.error);
	return result;
}

nodeTest(
	"stock CMD correction preserves the complete argv vector and stdin; original CMD loses newlines",
	{ skip: !windows },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "stock-"));
		try {
			const prefix = join(root, "stock space 雪"),
				exe = await stock(prefix);
			const script = join(root, "capture.cjs");
			await writeFile(script, capture);
			const env = childEnv(prefix),
				cwdBefore = process.cwd();
			await sameFile(readString(resolveWindowsStockLauncher(root, env)), exe);
			assert.equal(process.cwd(), cwdBefore);
			const args = [script, ...vector],
				stdin = "stdin\r\n雪\n";
			const old = original(root, env, args, stdin);
			assert.equal(old.status, 0, old.stderr);
			assert.notDeepEqual(readRecord(JSON.parse(old.stdout)).args, vector);
			const result = await runAgentBrowserProcess({ cwd: root, env, args, stdin });
			assert.equal(result.spawnError, undefined);
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.agentBrowserStarted, true);
			assert.equal(result.aborted, false);
			assert.equal(result.timedOut, false);
			const received = readRecord(JSON.parse(result.stdout));
			assert.deepEqual(received.args, vector);
			assert.equal(received.stdin, stdin);
			await sameFile(readString(received.exe), exe);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"selection matches actual cross-spawn controls for PATHEXT, custom shadows, child cwd and relative Path",
	{ skip: !windows },
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "select-"));
		try {
			const prefix = join(root, "stock"),
				exe = await stock(prefix),
				cwd = join(root, "cwd"),
				custom = join(root, "custom");
			await mkdir(cwd);
			await mkdir(custom);
			const script = join(root, "capture.cjs");
			await writeFile(script, capture);
			await copyFile(process.execPath, join(prefix, "agent-browser.exe"));
			for (const order of [".EXE;.CMD", ".CMD;.EXE"]) {
				const reversedOrder = order === ".EXE;.CMD" ? ".CMD;.EXE" : ".EXE;.CMD";
				await withPatchedEnv({ PATHEXT: order }, async () => {
					for (const differing of [false, true]) {
						await t.test(`${order}, differing=${differing}`, async (variant) => {
							// which uses parent PATHEXT to choose transport; cmd.exe itself
							// uses child PATHEXT to select the command it actually executes.
							const env = {
								...childEnv(relative(cwd, prefix)),
								PATHEXT: differing ? reversedOrder : order,
							};
							const raw = original(cwd, env, [script, "probe"]);
							assert.equal(raw.status, 0, raw.stderr);
							const expected =
								order.startsWith(".EXE") || differing ? join(prefix, "agent-browser.exe") : exe;
							await sameFile(readString(readRecord(JSON.parse(raw.stdout)).exe), expected);
							const chosen = resolveWindowsStockLauncher(cwd, env);
							if (order.startsWith(".EXE") || differing) {
								await variant.test("keeps native command selection", () => {
									assert.equal(chosen, undefined);
								});
							} else {
								await sameFile(readString(chosen), exe);
							}
							const integrated = await runAgentBrowserProcess({
								cwd,
								env,
								args: [script, "probe"],
							});
							assert.equal(integrated.exitCode, 0, integrated.stderr);
							await sameFile(readString(readRecord(JSON.parse(integrated.stdout)).exe), expected);
						});
					}
				});
			}
			await writeFakeAgentBrowserBinary(custom, "process.stdout.write('custom-cmd');");
			const ambiguous = { ...childEnv(prefix), PATH: custom, Path: prefix };
			// which sees Path's EXE and requests shell-free spawn, but Node selects
			// PATH (only a CMD). The real original result is ENOENT, not that CMD.
			const ambiguousRaw = crossSpawn.sync("agent-browser", ["probe"], {
				cwd,
				env: buildAgentBrowserProcessEnv(process.env, ambiguous),
				encoding: "utf8",
				timeout: 10_000,
			});
			assert.equal(hasErrorCode(ambiguousRaw.error, "ENOENT"), true);
			assert.equal(resolveWindowsStockLauncher(cwd, ambiguous), undefined);
			const ambiguousResult = await runAgentBrowserProcess({
				cwd,
				env: ambiguous,
				args: ["probe"],
			});
			assert.equal(ambiguousResult.exitCode, 127);
			assert.equal(hasErrorCode(ambiguousResult.spawnError, "ENOENT"), true);
			assert.equal(ambiguousResult.agentBrowserStarted, false);
			for (const location of [custom, cwd]) {
				await t.test(`shadow ${location}`, async () => {
					if (location === cwd) {
						await writeFakeAgentBrowserBinary(cwd, "process.stdout.write('cwd-cmd');");
					}
					const env = childEnv(`${custom};${prefix}`);
					const raw = original(cwd, env, ["probe"]);
					assert.equal(raw.status, 0, raw.stderr);
					assert.equal(raw.stdout, location === cwd ? "cwd-cmd" : "custom-cmd");
					assert.equal(resolveWindowsStockLauncher(cwd, env), undefined);
					const integrated = await runAgentBrowserProcess({ cwd, env, args: ["probe"] });
					assert.equal(integrated.exitCode, raw.status);
					assert.equal(integrated.stdout, raw.stdout);
				});
			}
			await rm(join(cwd, "agent-browser.cmd"));
			await copyFile(process.execPath, join(custom, "agent-browser.exe"));
			await withPatchedEnv({ PATHEXT: ".EXE;.CMD" }, async () => {
				const env = childEnv(`${custom};${prefix}`),
					raw = original(cwd, env, [script, "probe"]);
				await sameFile(
					readString(readRecord(JSON.parse(raw.stdout)).exe),
					join(custom, "agent-browser.exe"),
				);
				assert.equal(resolveWindowsStockLauncher(cwd, env), undefined);
				const integrated = await runAgentBrowserProcess({ cwd, env, args: [script, "probe"] });
				await sameFile(
					readString(readRecord(JSON.parse(integrated.stdout)).exe),
					join(custom, "agent-browser.exe"),
				);
			});
			const stockCwd = join(root, "stock-cwd");
			await stock(stockCwd);
			const noCwd = { ...childEnv(custom), NoDefaultCurrentDirectoryInExePath: "1" };
			const noCwdRaw = original(stockCwd, noCwd, [script, "probe"]);
			assert.equal(noCwdRaw.status, 0, noCwdRaw.stderr);
			assert.equal(resolveWindowsStockLauncher(stockCwd, noCwd), undefined);
			const noCwdResult = await runAgentBrowserProcess({
				cwd: stockCwd,
				env: noCwd,
				args: [script, "probe"],
			});
			assert.equal(noCwdResult.exitCode, noCwdRaw.status);
			assert.deepEqual(
				readRecord(JSON.parse(noCwdResult.stdout)),
				readRecord(JSON.parse(noCwdRaw.stdout)),
			);
			await withPatchedEnv({ ComSpec: process.execPath }, async () => {
				const env = childEnv(stockCwd),
					raw = original(stockCwd, env, [script, "probe"]);
				assert.equal(resolveWindowsStockLauncher(stockCwd, env), undefined);
				const result = await runAgentBrowserProcess({
					cwd: stockCwd,
					env,
					args: [script, "probe"],
				});
				assert.equal(result.exitCode, raw.status);
				assert.equal(result.stdout, raw.stdout);
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"custom CMD keeps its original multiline limitation rather than being rewritten",
	{ skip: !windows },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "custom-lf-"));
		try {
			await writeFakeAgentBrowserBinary(root, capture);
			const env = childEnv(root),
				args = ["fill", "#field", "one\ntwo"],
				stdin = "literal\r\nstdin";
			assert.equal(resolveWindowsStockLauncher(root, env), undefined);
			const raw = original(root, env, args, stdin);
			const result = await runAgentBrowserProcess({ cwd: root, env, args, stdin });
			assert.equal(result.exitCode, raw.status);
			assert.deepEqual(readRecord(JSON.parse(result.stdout)), readRecord(JSON.parse(raw.stdout)));
			assert.notDeepEqual(readRecord(JSON.parse(result.stdout)).args, args);
			assert.equal(readRecord(JSON.parse(result.stdout)).stdin, stdin);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"unrecognized stock layouts retain original fallback and never scan to a later stock installation",
	{ skip: !windows },
	async (t) => {
		const root = await mkdtemp(join(tmpdir(), "fallback-"));
		try {
			const first = join(root, "first"),
				later = join(root, "later");
			const exe = await stock(first);
			await stock(later);
			const script = join(root, "capture.cjs");
			await writeFile(script, capture);
			const env = childEnv(`${first};${later}`),
				shim = join(first, "agent-browser.cmd"),
				manifest = join(first, "node_modules", "agent-browser", "package.json");
			const originalManifest = await readFile(manifest, "utf8");
			for (const kind of [
				"extra-command",
				"quoted-forwarding",
				"wrong-package",
				"missing-binary",
				"directory-binary",
			]) {
				await t.test(kind, async () => {
					let shimContent = template;
					if (kind === "extra-command") {
						shimContent += "@REM custom command\r\n";
					} else if (kind === "quoted-forwarding") {
						shimContent = template.replace("%*", '"%*"');
					}
					await writeFile(shim, shimContent);
					await writeFile(
						manifest,
						kind === "wrong-package" ? '{"name":"custom"}' : originalManifest,
					);
					if (kind === "missing-binary") {
						await rm(exe);
					}
					if (kind === "directory-binary") {
						await mkdir(exe);
					}
					assert.equal(resolveWindowsStockLauncher(root, env), undefined, kind);
					const raw = original(root, env, [script, "probe"]);
					const integrated = await runAgentBrowserProcess({
						cwd: root,
						env,
						args: [script, "probe"],
					});
					assert.equal(integrated.exitCode, raw.status, kind);
					assert.equal(integrated.stdout, raw.stdout, kind);
				});
			}
			const missingEnv = childEnv(join(root, "absent"));
			assert.equal(resolveWindowsStockLauncher(root, missingEnv), undefined);
			const missing = await runAgentBrowserProcess({
				cwd: root,
				env: missingEnv,
				args: ["--version"],
			});
			assert.equal(missing.exitCode, 127);
			assert.equal(hasErrorCode(missing.spawnError, "ENOENT"), true);
			assert.equal(missing.agentBrowserStarted, false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

for (const mode of ["abort", "timeout"] as const) {
	nodeTest(
		`recognized shell-free stock route reaps child on ${mode}`,
		{ skip: !windows },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "stock-kill-")),
				controller = new AbortController();
			let pid: number | undefined;
			let running: ReturnType<typeof runAgentBrowserProcess> | undefined;
			try {
				const prefix = join(root, "stock");
				await stock(prefix);
				const script = join(root, "wait.cjs"),
					marker = join(root, "pid");
				await writeFile(
					script,
					`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
				);
				running = runAgentBrowserProcess({
					cwd: root,
					env: childEnv(prefix),
					args: [script],
					signal: controller.signal,
					timeoutMs: mode === "timeout" ? 800 : 0,
				});
				for (let count = 0; count < 100; count++) {
					try {
						// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
						pid = Number(await readFile(marker, "utf8"));
						break;
					} catch {
						// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
						await new Promise<void>((resolve) => {
							setTimeout(resolve, 20);
						});
					}
				}
				assert.ok(pid !== undefined && pid !== 0, "child must start before cancellation");
				if (mode === "abort") {
					controller.abort();
				}
				const result = await running;
				assert.equal(result.aborted, mode === "abort");
				assert.equal(result.timedOut, mode === "timeout");
				assert.throws(
					() => process.kill(readNumber(pid), 0),
					{ code: "ESRCH" },
					"reaped before returning",
				);
			} finally {
				controller.abort();
				await running;
				if (pid !== undefined && pid !== 0) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* already reaped */
					}
				}
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

nodeTest(
	"actual stock Rust receives exact LF/CRLF and every vector operand through production integration",
	{
		skip:
			!windows ||
			process.env.PI_AGENT_BROWSER_STOCK_PREFIX === undefined ||
			process.env.PI_AGENT_BROWSER_STOCK_PREFIX === "",
	},
	async (t) => {
		const prefix = readString(process.env.PI_AGENT_BROWSER_STOCK_PREFIX);
		const root = await mkdtemp(join(tmpdir(), "rust-argv-"));
		try {
			const exe = join(
					prefix,
					"node_modules",
					"agent-browser",
					"bin",
					"agent-browser-win32-x64.exe",
				),
				env = childEnv(prefix);
			await sameFile(readString(resolveWindowsStockLauncher(root, env)), exe);
			for (const operand of [
				"--no-startup-window,--disable-gpu\n--no-sandbox",
				"--no-startup-window,--disable-gpu\r\n--no-sandbox",
				...vector,
			]) {
				await t.test(JSON.stringify(operand), async (variant) => {
					const args = ["--json", "dashboard", operand];
					const expected = `${operand.startsWith("-") ? "Unknown dashboard option" : "Unknown dashboard subcommand"}: ${operand}`;
					const direct = spawnSync(exe, args, {
						cwd: root,
						env: buildAgentBrowserProcessEnv(process.env, env),
						encoding: "utf8",
						timeout: 10_000,
					});
					assert.equal(direct.status, 1, direct.stderr);
					assert.equal(readRecord(JSON.parse(direct.stdout)).error, expected);
					const old = original(root, env, args);
					if (operand.includes("\n")) {
						await variant.test("CMD loses newline operand", () => {
							assert.notEqual(readRecord(JSON.parse(old.stdout)).error, expected);
						});
					}
					const result = await runAgentBrowserProcess({ cwd: root, env, args });
					assert.equal(result.exitCode, 1, result.stderr);
					assert.equal(result.spawnError, undefined);
					assert.equal(readRecord(JSON.parse(result.stdout)).error, expected);
					console.log(
						JSON.stringify({
							operand,
							hex: Buffer.from(operand).toString("hex"),
							direct: direct.stdout,
							original: old.stdout,
							candidate: result.stdout,
						}),
					);
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
