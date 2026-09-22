/** Opt-in registered-extension race regression. No mocks or second browser driver.
 * PI_AGENT_BROWSER_REAL_UPSTREAM=1 node --import tsx --test test/agent-browser.execution-order.test.ts
 * PI_AGENT_BROWSER_EXECUTION_TEST_ROOT selects another checkout (with dependencies and built script worker).
 * PI_AGENT_BROWSER_EXECUTION_TEST_EVIDENCE retains synthetic receipts/logs after private runtime cleanup.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import which from "which";

const sourceRoot = resolve(process.env.PI_AGENT_BROWSER_EXECUTION_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const skip = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1" ? "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run the real browser race."
	: process.platform === "win32" ? "This POSIX response-gating fixture does not claim native Windows coverage." : false;
const timeoutMs = 60_000;
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
type Message = { kind: string; id?: number; pid?: number; lockPath?: string; tools?: string[]; result?: ToolResult; error?: string };
type NativeRow = { event: string; actor: string; args: string[]; stdout?: string; at?: number; started?: number; finished?: number; released?: boolean };
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}
async function present(path: string) { return readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }); }
function successful(result: ToolResult) { assert.equal(result.isError, false, JSON.stringify(result)); return result; }

function worker(root: string, actor: string, env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), fileURLToPath(new URL("./helpers/browser-execution-order-worker.ts", import.meta.url))], {
		cwd: root, env: { ...env, PIAB_ORDER_ACTOR: actor }, stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const messages: Message[] = [];
	let stderr = "";
	child.stdout!.on("data", chunk => { stderr += chunk; });
	child.stderr!.on("data", chunk => { stderr += chunk; });
	child.on("message", value => messages.push(value as Message));
	const exited = once(child, "exit");
	let id = 0;
	return {
		child, messages, exited,
		async ready() { await until(() => messages.some(m => m.kind === "ready"), `worker ${actor} failed to register: ${stderr}`); return messages.find(m => m.kind === "ready")!; },
		call(params: unknown, tool = "agent_browser") {
			const callId = ++id;
			child.send({ kind: "call", id: callId, tool, params });
			return {
				id: callId,
				get settled() { return messages.some(m => m.id === callId && ["result", "error"].includes(m.kind)); },
				abort() { child.send({ kind: "abort", id: callId }); },
				async result() {
					await until(() => messages.some(m => m.id === callId && ["result", "error"].includes(m.kind)), `worker ${actor} call ${callId} timed out: ${stderr}`, 35_000);
					const message = messages.find(m => m.id === callId && ["result", "error"].includes(m.kind))!;
					assert.equal(message.kind, "result", message.error);
					return message.result!;
				},
			};
		},
		async stop() {
			if (child.connected) child.send({ kind: "stop" });
			const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			try { const [code, signal] = await exited; return { pid: child.pid, code, signal, stderr }; }
			finally { clearTimeout(timer); }
		},
	};
}

for (const mode of ["direct", "code", "cancel-waiter"] as const) {
	test(mode === "direct" ? "real registered direct helper/action keeps another process off the verified page"
		: mode === "code" ? "real registered code cell holds its browser through read, local branch, and action"
		: "real registered cancellation removes a waiting peer without dispatching its navigation", { skip, timeout: timeoutMs }, async t => {
		// macOS Unix sockets need a short path, including native's namespace suffix.
		const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "piab-order-"));
		const namespace = basename(root).toLowerCase();
		const args = ["--namespace", namespace, "--session", "shared"];
		const nativePath = await realpath(which.sync("agent-browser"));
		const rows: Array<{ event: string; page: string; at: number }> = [];
		const counts = { A: 0, B: 0 };
		const evidence: Record<string, unknown> = { mode, root, sourceRoot, namespace, nativePath, counts, receipts: rows };
		const workers: ReturnType<typeof worker>[] = [];
		let lockPath: string | undefined;
		for (const name of ["bin", "home", "pi", "s", "t"]) await mkdir(join(root, name), { mode: 0o700 });
		await writeFile(join(root, "empty.json"), "{}");
		await writeFile(join(root, "bin/agent-browser"), `#!${process.execPath}\n${await readFile(new URL("./helpers/browser-execution-order-proxy.cjs", import.meta.url), "utf8")}`);
		await chmod(join(root, "bin/agent-browser"), 0o700);
		const env: NodeJS.ProcessEnv = {
			PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: join(root, "home"), USERPROFILE: join(root, "home"), TMPDIR: join(root, "t"), LANG: "en_US.UTF-8",
			PI_CODING_AGENT_DIR: join(root, "pi"), AGENT_BROWSER_CONFIG: join(root, "empty.json"),
			AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
			AGENT_BROWSER_IDLE_TIMEOUT_MS: "20000",
			...(process.platform === "darwin" ? { AGENT_BROWSER_EXECUTABLE_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}),
			PIAB_ORDER_ROOT: root, PIAB_ORDER_NATIVE: nativePath, PIAB_ORDER_NAMESPACE: namespace,
			PI_AGENT_BROWSER_EXECUTION_TEST_ROOT: sourceRoot,
		};
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const page = url.pathname === "/receipt" ? url.searchParams.get("page") : url.pathname.slice(1);
			if (page !== "A" && page !== "B") { res.writeHead(404).end(); return; }
			rows.push({ event: url.pathname === "/receipt" ? "click" : "navigate", page, at: Date.now() });
			if (url.pathname === "/receipt") { counts[page]++; res.writeHead(204).end(); return; }
			res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
			res.end(`<!doctype html><title>Fixture ${page}</title><body data-page="${page}"><button id="count" onclick="document.querySelector('output').textContent=String(++window.clicks); fetch('/receipt?page=${page}',{method:'POST'}).then(()=>document.body.dataset.received='yes')">Count ${page}</button><output>0</output><script>window.clicks=0</script></body>`);
		});
		const native = (tail: string[]) => JSON.parse(execFileSync(nativePath, ["--args", "--no-startup-window", "--json", ...args, ...tail], { cwd: root, env, encoding: "utf8", timeout: 12_000 }));
		const claims = async () => !lockPath ? [] : (await readdir(dirname(lockPath))).filter(name => name.startsWith(`${basename(lockPath!)}.claim-`));
		t.after(async () => {
			await writeFile(join(root, "release"), "release");
			try {
				evidence.workerExit = await Promise.all(workers.map(w => w.stop()));
				evidence.close = native(["close"]);
				await until(() => {
					evidence.afterClose = native(["session", "info"]);
					return (evidence.afterClose as { data: { active: boolean } }).data.active === false;
				}, "Native daemon did not finish closing", 5_000);
				evidence.remainingClaims = await claims();
				assert.deepEqual(evidence.remainingClaims, []);
				for (const exit of evidence.workerExit as Array<{ code: number }>) assert.equal(exit.code, 0);
			} finally {
				server.closeAllConnections();
				await new Promise<void>(resolve => server.close(() => resolve()));
				await writeFile(join(root, "results.json"), JSON.stringify(evidence, null, 2));
				const destination = process.env.PI_AGENT_BROWSER_EXECUTION_TEST_EVIDENCE;
				if (destination) {
					const output = join(resolve(destination), mode);
					await mkdir(output, { recursive: true });
					for (const file of await readdir(root)) if (file.endsWith(".json") || file.endsWith(".jsonl")) await cp(join(root, file), join(output, file));
					t.diagnostic(`Synthetic race evidence: ${output}`);
				}
				await rm(root, { recursive: true, force: true });
			}
		});
		const diff = execFileSync("git", ["-C", sourceRoot, "diff", "HEAD", "--", "extensions", "test/helpers/agent-browser-harness.ts"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
		const untracked = execFileSync("git", ["-C", sourceRoot, "ls-files", "--others", "--exclude-standard", "extensions"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
		evidence.source = {
			head: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			trackedDiffSha256: createHash("sha256").update(diff).digest("hex"),
			untracked: await Promise.all(untracked.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(sourceRoot, path))).digest("hex") }))),
			compiledWorkerSha256: createHash("sha256").update(await present(join(sourceRoot, "dist/extensions/agent-browser/script-worker.js"))).digest("hex"),
		};
		evidence.version = execFileSync(nativePath, ["--version"], { env, encoding: "utf8", timeout: 10_000 }).trim();
		assert.equal(evidence.version, "agent-browser 0.38.1");
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address(); assert.ok(address && typeof address === "object");
		const base = `http://127.0.0.1:${address.port}`;
		const a = worker(root, "A", env), b = worker(root, "B", env); workers.push(a, b);
		const [readyA, readyB] = await Promise.all([a.ready(), b.ready()]);
		evidence.workers = [readyA, readyB];
		assert.notEqual(readyA.pid, readyB.pid);
		assert.equal(readyA.lockPath, readyB.lockPath);
		lockPath = readyA.lockPath;
		evidence.openA = successful(await a.call({ args: [...args, "open", `${base}/A`], timeoutMs: 20_000 }).result());
		const initial = await b.call({ args: [...args, "session", "info"], timeoutMs: 10_000 }).result();
		successful(initial); // Warm B without navigating, attaching another controller, or changing launch flags.
		await writeFile(join(root, "arm"), mode === "code" ? "code" : "direct");
		const inspect = "({page:document.body.dataset.page,clicks:window.clicks})";
		const action = mode === "code" ? a.call({ session: "shared", namespace, timeoutMs: 25_000, code: `
const read = await browser({args:["eval","--stdin"],stdin:${JSON.stringify(inspect)}});
if (!read.success || read.data.result.page !== "A") throw new Error("Expected page A before branching");
// B is already waiting. This bounded local work separates browser calls without another browser command.
const start = Date.now(); while (Date.now() - start < 1000) {}
const clicked = await browser({args:["click","#count"]});
if (!clicked.success) throw new Error("Click failed: " + JSON.stringify(clicked));
await browser({args:["wait","--fn","document.body.dataset.received === 'yes'"]});
const after = await browser({args:["eval","--stdin"],stdin:${JSON.stringify(inspect)}});
emit({page:after.data.result.page,clicks:after.data.result.clicks,branchGapMs:Date.now()-start});
` }, "agent_browser_code") : a.call({ args: [...args, "click", "#count"], timeoutMs: 25_000 });
		await until(async () => Boolean(await present(join(root, "held.json"))) || action.settled, "A never reached the real response gate");
		const heldText = await present(join(root, "held.json"));
		if (!heldText) assert.fail(`A finished before the response gate: ${JSON.stringify(await action.result())}`);
		const held = JSON.parse(heldText) as NativeRow; evidence.held = held;
		if (mode !== "code") assert.equal(JSON.parse(held.stdout!).data.url, `${base}/A`);
		else assert.deepEqual(JSON.parse(held.stdout!).data.result, { page: "A", clicks: 0 });
		const navigation = b.call({ args: [...args, "open", `${base}/B`], timeoutMs: 20_000 });
		await until(async () => (await claims()).length === 2 || navigation.settled, "B neither queued nor completed");
		await delay(100);
		evidence.peerWaited = !navigation.settled && (await claims()).length === 2;
		if (mode === "cancel-waiter") {
			navigation.abort(); evidence.cancelled = await navigation.result();
			assert.equal((evidence.cancelled as ToolResult).isError, true);
			await until(async () => (await claims()).length === 1, "Cancelled waiter retained its claim");
		}
		await writeFile(join(root, "release"), "release");
		evidence.action = await action.result();
		if (mode !== "cancel-waiter") evidence.navigation = await navigation.result();
		await until(() => counts.A + counts.B > 0, "No independent fixture click receipt");
		// B owns the current page after navigation; cancelled B leaves A selected.
		const observer = mode === "cancel-waiter" ? a : b;
		evidence.dom = await observer.call({ args: [...args, "eval", "--stdin"], stdin: inspect, timeoutMs: 10_000 }).result();
		const nativeRows = (await present(join(root, "native.jsonl"))).trim().split("\n").map(line => JSON.parse(line) as NativeRow);
		evidence.launchHashes = [...new Set(nativeRows.flatMap(row => {
			if (!row.stdout?.startsWith("{")) return [];
			const hash = JSON.parse(row.stdout).data?.lifecycle?.effectiveLaunch?.launchHash;
			return hash == null ? [] : [hash];
		}))];
		await appendFile(join(root, "schedule.jsonl"), `${JSON.stringify({ mode, counts, peerWaited: evidence.peerWaited, receipts: rows })}\n`);
		assert.deepEqual(counts, { A: 1, B: 0 }, "A's verified click must affect A, never the peer's page B");
		assert.equal(evidence.peerWaited, true, "B must remain queued while A's real preflight response is held");
		successful(evidence.action as ToolResult);
		successful(evidence.dom as ToolResult);
		assert.equal((evidence.launchHashes as unknown[]).length, 1, "All helpers/actions must reuse one native launch configuration");
		if (mode === "code") {
			const data = (evidence.action as ToolResult).details?.data as { page: string; clicks: number; branchGapMs: number };
			assert.equal(data.page, "A"); assert.equal(data.clicks, 1); assert.ok(data.branchGapMs >= 1000);
		}
		const dom = (evidence.dom as ToolResult).details?.data as { result: { page: string; clicks: number } };
		assert.deepEqual(dom.result, mode === "cancel-waiter" ? { page: "A", clicks: 1 } : { page: "B", clicks: 0 });
		if (mode === "cancel-waiter") assert.ok(!nativeRows.some(row => row.actor === "B" && row.args.includes(`${base}/B`)), "Cancelled navigation must never spawn");
		else {
			successful(evidence.navigation as ToolResult);
			assert.ok(rows.findIndex(row => row.event === "click" && row.page === "A") < rows.findIndex(row => row.event === "navigate" && row.page === "B"), "Independent receipt must precede peer navigation");
		}
	});
}
