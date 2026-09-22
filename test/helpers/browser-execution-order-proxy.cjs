// Byte-transparent native CLI proxy. Only the delivery time of one successful reply changes.
const { spawn } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.PIAB_ORDER_ROOT;
const args = process.argv.slice(2);
const actor = process.env.PIAB_ORDER_ACTOR;
const started = Date.now();
const log = row => appendFileSync(join(root, "native.jsonl"), `${JSON.stringify(row)}\n`);
log({ event: "spawn", actor, args, at: started });
const child = spawn(process.env.PIAB_ORDER_NATIVE, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
const stdout = [], stderr = [];
child.stdout.on("data", chunk => stdout.push(chunk));
child.stderr.on("data", chunk => stderr.push(chunk));
child.on("error", error => { process.stderr.write(String(error)); process.exitCode = 127; });
child.on("close", async (code, signal) => {
	const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
	const row = { event: "reply", actor, args, started, finished: Date.now(), code, signal, stdout: out.toString(), stderr: err.toString() };
	log(row);
	const armed = existsSync(join(root, "arm")) ? readFileSync(join(root, "arm"), "utf8") : "";
	const matches = armed === "direct" ? args.slice(-2).join(" ") === "get url" : armed === "code" && args.slice(-2).join(" ") === "eval --stdin";
	if (actor === "A" && matches && code === 0 && !existsSync(join(root, "held.json"))) {
		writeFileSync(join(root, "held.json"), JSON.stringify(row));
		const deadline = Date.now() + 12_000;
		while (!existsSync(join(root, "release")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
		log({ event: "forward-held", actor, at: Date.now(), released: existsSync(join(root, "release")) });
	}
	process.stdout.write(out);
	process.stderr.write(err);
	process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
