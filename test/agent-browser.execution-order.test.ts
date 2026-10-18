/** Opt-in registered-extension race regression. No mocks or second browser driver.
 * PI_AGENT_BROWSER_REAL_UPSTREAM=1 node --import tsx --test test/agent-browser.execution-order.test.ts
 * PI_AGENT_BROWSER_EXECUTION_TEST_ROOT selects another checkout (with dependencies and built script worker).
 * PI_AGENT_BROWSER_EXECUTION_TEST_EVIDENCE retains synthetic receipts/logs after private runtime cleanup.
 */
import assert from "node:assert/strict";
import {
	readRecord,
	readArray,
	readString,
	readNumber,
	hasErrorCode,
} from "./helpers/assertions.js";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	appendFile,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import which from "which";

const sourceRoot = resolve(
	process.env.PI_AGENT_BROWSER_EXECUTION_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
);
let skip: string | false = false;
if (process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1") {
	skip = "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run the real browser race.";
} else if (process.platform === "win32") {
	skip = "This POSIX response-gating fixture does not claim native Windows coverage.";
}
const timeoutMs = 60_000;

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	// Poll the observed race condition once before each bounded delay.
	// oxlint-disable-next-line no-await-in-loop
	while (!(await check())) {
		assert.ok(Date.now() < deadline, label);
		// Recheck only after the polling interval, not concurrently with the previous probe.
		// oxlint-disable-next-line no-await-in-loop
		await delay(10);
	}
}
async function present(path: string) {
	return readFile(path, "utf8").catch((error: unknown) => {
		if (hasErrorCode(error, "ENOENT")) {
			return "";
		}
		throw error;
	});
}
function successful(value: unknown) {
	const result = readRecord(value);
	assert.equal(result.isError, false, JSON.stringify(result));
	return result;
}

function worker(root: string, actor: string, env: Readonly<NodeJS.ProcessEnv>) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			fileURLToPath(import.meta.resolve("tsx")),
			fileURLToPath(new URL("./helpers/browser-execution-order-worker.ts", import.meta.url)),
		],
		{
			cwd: root,
			env: { ...env, PIAB_ORDER_ACTOR: actor },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const messages: Record<string, unknown>[] = [];
	let stderr = "";
	assert.ok(child.stdout);
	assert.ok(child.stderr);
	const collectOutput = (chunk: unknown) => {
		assert.ok(Buffer.isBuffer(chunk));
		stderr += chunk.toString();
	};
	child.stdout.on("data", collectOutput);
	child.stderr.on("data", collectOutput);
	child.on("message", (value) => {
		messages.push(readRecord(value));
	});
	const exited = once(child, "exit");
	let id = 0;
	return {
		child,
		messages,
		exited,
		async ready() {
			await until(
				() => messages.some((m) => m.kind === "ready"),
				`worker ${actor} failed to register: ${stderr}`,
			);
			const ready = messages.find((m) => m.kind === "ready");
			assert.ok(ready);
			return ready;
		},
		call(params: unknown, tool = "agent_browser") {
			const callId = ++id;
			child.send({ kind: "call", id: callId, tool, params });
			return {
				id: callId,
				get settled() {
					return messages.some(
						(m) => m.id === callId && ["result", "error"].includes(readString(m.kind)),
					);
				},
				abort() {
					child.send({ kind: "abort", id: callId });
				},
				async result() {
					await until(
						() =>
							messages.some(
								(m) => m.id === callId && ["result", "error"].includes(readString(m.kind)),
							),
						`worker ${actor} call ${callId} timed out: ${stderr}`,
						35_000,
					);
					const message = messages.find(
						(m) => m.id === callId && ["result", "error"].includes(readString(m.kind)),
					);
					assert.ok(message);
					assert.equal(
						message.kind,
						"result",
						typeof message.error === "string" ? message.error : undefined,
					);
					return readRecord(message.result);
				},
			};
		},
		async stop() {
			if (child.connected) {
				child.send({ kind: "stop" });
			}
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 5_000);
			try {
				const [code, signal] = readArray(await exited);
				return { pid: child.pid, code, signal, stderr };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

for (const mode of ["direct", "code", "cancel-waiter"] as const) {
	test(
		{
			direct: "real registered direct helper/action keeps another process off the verified page",
			code: "real registered code cell holds its browser through read, local branch, and action",
			"cancel-waiter":
				"real registered cancellation removes a waiting peer without dispatching its navigation",
		}[mode],
		{ skip, timeout: timeoutMs },
		async (t) => {
			// macOS Unix sockets need a short path, including native's namespace suffix.
			const root = await mkdtemp(
				join(process.platform === "darwin" ? "/tmp" : tmpdir(), "piab-order-"),
			);
			const namespace = basename(root).toLowerCase();
			const args = ["--namespace", namespace, "--session", "shared"];
			const nativePath = await realpath(which.sync("agent-browser"));
			const rows: Array<{ event: string; page: string; at: number }> = [];
			const counts = { A: 0, B: 0 };
			const evidence: Record<string, unknown> = {
				mode,
				root,
				sourceRoot,
				namespace,
				nativePath,
				counts,
				receipts: rows,
			};
			const workers: ReturnType<typeof worker>[] = [];
			const ownership: { lockPath?: string } = {};
			await Promise.all(
				["bin", "home", "pi", "s", "t"].map((name) => mkdir(join(root, name), { mode: 0o700 })),
			);
			await writeFile(join(root, "empty.json"), "{}");
			await writeFile(
				join(root, "bin/agent-browser"),
				`#!${process.execPath}\n${await readFile(new URL("./helpers/browser-execution-order-proxy.cjs", import.meta.url), "utf8")}`,
			);
			await chmod(join(root, "bin/agent-browser"), 0o700);
			const env: Readonly<NodeJS.ProcessEnv> = {
				PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
				HOME: join(root, "home"),
				USERPROFILE: join(root, "home"),
				TMPDIR: join(root, "t"),
				LANG: "en_US.UTF-8",
				PI_CODING_AGENT_DIR: join(root, "pi"),
				AGENT_BROWSER_CONFIG: join(root, "empty.json"),
				AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
				PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
				AGENT_BROWSER_IDLE_TIMEOUT_MS: "20000",
				...(process.platform === "darwin"
					? {
							AGENT_BROWSER_EXECUTABLE_PATH:
								"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						}
					: {}),
				PIAB_ORDER_ROOT: root,
				PIAB_ORDER_NATIVE: nativePath,
				PIAB_ORDER_NAMESPACE: namespace,
				PI_AGENT_BROWSER_EXECUTION_TEST_ROOT: sourceRoot,
			};
			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				const page =
					url.pathname === "/receipt" ? url.searchParams.get("page") : url.pathname.slice(1);
				if (page !== "A" && page !== "B") {
					res.writeHead(404).end();
					return;
				}
				rows.push({
					event: url.pathname === "/receipt" ? "click" : "navigate",
					page,
					at: Date.now(),
				});
				if (url.pathname === "/receipt") {
					counts[page]++;
					res.writeHead(204).end();
					return;
				}
				res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
				res.end(
					`<!doctype html><title>Fixture ${page}</title><body data-page="${page}"><button id="count" onclick="document.querySelector('output').textContent=String(++window.clicks); fetch('/receipt?page=${page}',{method:'POST'}).then(()=>document.body.dataset.received='yes')">Count ${page}</button><output>0</output><script>window.clicks=0</script></body>`,
				);
			});
			const native = (tail: readonly string[]) =>
				readRecord(
					JSON.parse(
						execFileSync(
							nativePath,
							["--args", "--no-startup-window", "--json", ...args, ...tail],
							{
								cwd: root,
								env,
								encoding: "utf8",
								timeout: 12_000,
							},
						),
					),
				);
			const claims = async () =>
				ownership.lockPath === undefined || ownership.lockPath.length === 0
					? []
					: (await readdir(dirname(ownership.lockPath))).filter((name) =>
							name.startsWith(`${basename(readString(ownership.lockPath))}.claim-`),
						);
			t.after(async () => {
				await writeFile(join(root, "release"), "release");
				try {
					evidence.workerExit = await Promise.all(workers.map((w) => w.stop()));
					evidence.close = native(["close"]);
					await until(
						() => {
							evidence.afterClose = native(["session", "info"]);
							return readRecord(readRecord(evidence.afterClose).data).active === false;
						},
						"Native daemon did not finish closing",
						5_000,
					);
					evidence.remainingClaims = await claims();
					assert.deepEqual(evidence.remainingClaims, []);
					for (const exit of readArray(evidence.workerExit).map(readRecord)) {
						// Every explicitly started worker must exit successfully before cleanup completes.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(exit.code, 0);
					}
				} finally {
					server.closeAllConnections();
					await new Promise<void>((complete) => {
						server.close(() => complete());
					});
					await writeFile(join(root, "results.json"), JSON.stringify(evidence, null, 2));
					const destination = process.env.PI_AGENT_BROWSER_EXECUTION_TEST_EVIDENCE;
					if (destination !== undefined && destination.length > 0) {
						const output = join(resolve(destination), mode);
						await mkdir(output, { recursive: true });
						await Promise.all(
							(await readdir(root))
								.filter((file) => file.endsWith(".json") || file.endsWith(".jsonl"))
								.map((file) => cp(join(root, file), join(output, file))),
						);
						t.diagnostic(`Synthetic race evidence: ${output}`);
					}
					await rm(root, { recursive: true, force: true });
				}
			});
			const diff = execFileSync(
				"git",
				[
					"-C",
					sourceRoot,
					"diff",
					"HEAD",
					"--",
					"extensions",
					"test/helpers/agent-browser-harness.ts",
				],
				{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
			);
			const untracked = execFileSync(
				"git",
				["-C", sourceRoot, "ls-files", "--others", "--exclude-standard", "extensions"],
				{ encoding: "utf8" },
			)
				.trim()
				.split("\n")
				.filter(Boolean);
			evidence.source = {
				head: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim(),
				trackedDiffSha256: createHash("sha256").update(diff).digest("hex"),
				untracked: await Promise.all(
					untracked.map(async (path) => ({
						path,
						sha256: createHash("sha256")
							.update(await readFile(join(sourceRoot, path)))
							.digest("hex"),
					})),
				),
				compiledWorkerSha256: createHash("sha256")
					.update(await present(join(sourceRoot, "dist/extensions/agent-browser/script-worker.js")))
					.digest("hex"),
			};
			evidence.version = execFileSync(nativePath, ["--version"], {
				env,
				encoding: "utf8",
				timeout: 10_000,
			}).trim();
			assert.equal(evidence.version, "agent-browser 0.38.1");
			await new Promise<void>((complete) => {
				server.listen(0, "127.0.0.1", complete);
			});
			const address = server.address();
			assert.ok(address !== null && typeof address === "object");
			const base = `http://127.0.0.1:${address.port}`;
			const a = worker(root, "A", env),
				b = worker(root, "B", env);
			workers.push(a, b);
			const [readyA, readyB] = await Promise.all([a.ready(), b.ready()]);
			evidence.workers = [readyA, readyB];
			assert.notEqual(readyA.pid, readyB.pid);
			assert.equal(readyA.lockPath, readyB.lockPath);
			ownership.lockPath = readString(readyA.lockPath);
			evidence.openA = successful(
				await a.call({ args: [...args, "open", `${base}/A`], timeoutMs: 20_000 }).result(),
			);
			const initial = await b
				.call({ args: [...args, "session", "info"], timeoutMs: 10_000 })
				.result();
			successful(initial); // Warm B without navigating, attaching another controller, or changing launch flags.
			await writeFile(join(root, "arm"), mode === "code" ? "code" : "direct");
			const inspect = "({page:document.body.dataset.page,clicks:window.clicks})";
			const action =
				mode === "code"
					? a.call(
							{
								session: "shared",
								namespace,
								timeoutMs: 25_000,
								code: `
const read = await browser({args:["eval","--stdin"],stdin:${JSON.stringify(inspect)}});
if (!read.success || read.data.result.page !== "A") throw new Error("Expected page A before branching");
// B is already waiting. This bounded local work separates browser calls without another browser command.
const start = Date.now(); while (Date.now() - start < 1000) {}
const clicked = await browser({args:["click","#count"]});
if (!clicked.success) throw new Error("Click failed: " + JSON.stringify(clicked));
await browser({args:["wait","--fn","document.body.dataset.received === 'yes'"]});
const after = await browser({args:["eval","--stdin"],stdin:${JSON.stringify(inspect)}});
emit({page:after.data.result.page,clicks:after.data.result.clicks,branchGapMs:Date.now()-start});
`,
							},
							"agent_browser_code",
						)
					: a.call({ args: [...args, "click", "#count"], timeoutMs: 25_000 });
			await until(
				async () => Boolean(await present(join(root, "held.json"))) || action.settled,
				"A never reached the real response gate",
			);
			const heldText = await present(join(root, "held.json"));
			if (heldText.length === 0) {
				throw new Error(
					`A finished before the response gate: ${JSON.stringify(await action.result())}`,
				);
			}
			const held = readRecord(JSON.parse(heldText));
			evidence.held = held;
			if (mode !== "code") {
				// The direct-action fixture must be held on A; the code variant checks its own receipt below.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					readRecord(readRecord(JSON.parse(readString(held.stdout))).data).url,
					`${base}/A`,
				);
			} else {
				// The code fixture must be held on A with no click; direct variants assert their URL above.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(readRecord(readRecord(JSON.parse(readString(held.stdout))).data).result, {
					page: "A",
					clicks: 0,
				});
			}
			const navigation = b.call({ args: [...args, "open", `${base}/B`], timeoutMs: 20_000 });
			await until(
				async () => (await claims()).length === 2 || navigation.settled,
				"B neither queued nor completed",
			);
			await delay(100);
			evidence.peerWaited = !navigation.settled && (await claims()).length === 2;
			if (mode === "cancel-waiter") {
				navigation.abort();
				evidence.cancelled = await navigation.result();
				// The explicit cancel-waiter variant must acknowledge cancellation before gate release.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(evidence.cancelled).isError, true);
				await until(
					async () => (await claims()).length === 1,
					"Cancelled waiter retained its claim",
				);
			}
			await writeFile(join(root, "release"), "release");
			evidence.action = await action.result();
			if (mode !== "cancel-waiter") {
				evidence.navigation = await navigation.result();
			}
			await until(() => counts.A + counts.B > 0, "No independent fixture click receipt");
			// B owns the current page after navigation; cancelled B leaves A selected.
			const observer = mode === "cancel-waiter" ? a : b;
			evidence.dom = await observer
				.call({ args: [...args, "eval", "--stdin"], stdin: inspect, timeoutMs: 10_000 })
				.result();
			const nativeRows = (await present(join(root, "native.jsonl")))
				.trim()
				.split("\n")
				.map((line) => readRecord(JSON.parse(line)));
			evidence.launchHashes = [
				...new Set(
					nativeRows.flatMap((row) => {
						if (typeof row.stdout !== "string" || !row.stdout.startsWith("{")) {
							return [];
						}
						const data = readRecord(readRecord(JSON.parse(row.stdout)).data);
						if (data.lifecycle === undefined) {
							return [];
						}
						const launch = readRecord(readRecord(data.lifecycle).effectiveLaunch);
						const hash = launch.launchHash;
						if (hash === null || hash === undefined) {
							return [];
						}
						assert.ok(
							typeof hash === "string" || (typeof hash === "number" && Number.isFinite(hash)),
							"native launchHash must be a string or finite number",
						);
						return [String(hash)];
					}),
				),
			];
			await appendFile(
				join(root, "schedule.jsonl"),
				`${JSON.stringify({ mode, counts, peerWaited: evidence.peerWaited, receipts: rows })}\n`,
			);
			assert.deepEqual(
				counts,
				{ A: 1, B: 0 },
				"A's verified click must affect A, never the peer's page B",
			);
			assert.equal(
				evidence.peerWaited,
				true,
				"B must remain queued while A's real preflight response is held",
			);
			successful(evidence.action);
			successful(evidence.dom);
			assert.equal(
				readArray(evidence.launchHashes).length,
				1,
				"All helpers/actions must reuse one native launch configuration",
			);
			if (mode === "code") {
				const data = readRecord(readRecord(readRecord(evidence.action).details).data);
				// The code variant must retain A across its cell; common ordering is asserted above.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(data.page, "A");
				// The code variant must dispatch exactly one click before releasing ownership.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(data.clicks, 1);
				// The code variant must retain the execution lock across the intentionally suspended cell.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(readNumber(data.branchGapMs) >= 1000);
			}
			const dom = readRecord(readRecord(readRecord(evidence.dom).details).data);
			assert.deepEqual(
				dom.result,
				mode === "cancel-waiter" ? { page: "A", clicks: 1 } : { page: "B", clicks: 0 },
			);
			if (mode === "cancel-waiter") {
				// The cancel-waiter variant must never spawn its cancelled peer navigation.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(
					!nativeRows.some((row) => row.actor === "B" && readArray(row.args).includes(`${base}/B`)),
					"Cancelled navigation must never spawn",
				);
			} else {
				successful(evidence.navigation);
				// Noncancelled variants must navigate only after the independent click receipt.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(
					rows.findIndex((row) => row.event === "click" && row.page === "A") <
						rows.findIndex((row) => row.event === "navigate" && row.page === "B"),
					"Independent receipt must precede peer navigation",
				);
			}
		},
	);
}
