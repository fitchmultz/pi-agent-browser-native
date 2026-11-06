// Byte-transparent native CLI proxy. Only the delivery time of one successful reply changes.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const root = process.env.PIAB_ORDER_ROOT;
const native = process.env.PIAB_ORDER_NATIVE;
assert.ok(typeof root === "string");
assert.ok(typeof native === "string");
const args = process.argv.slice(2);
const actor = process.env.PIAB_ORDER_ACTOR;
const started = Date.now();
/** @param {Readonly<Record<string, unknown>>} row */
const log = (row) => appendFileSync(path.join(root, "native.jsonl"), `${JSON.stringify(row)}\n`);
log({ event: "spawn", actor, args, at: started });
const child = spawn(native, args, {
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
});
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {
	// Native stdin can close after exit; child error/close owns the result.
});
/** @type {Buffer[]} */
const stdout = [];
/** @type {Buffer[]} */
const stderr = [];
child.stdout.on("data", (/** @type {Buffer} */ chunk) => stdout.push(chunk));
child.stderr.on("data", (/** @type {Buffer} */ chunk) => stderr.push(chunk));
child.on("error", (error) => {
	process.stderr.write(String(error));
	process.exitCode = 127;
});
/** @param {number | null} code @param {NodeJS.Signals | null} signal */
const forwardReply = async (code, signal) => {
	const out = Buffer.concat(stdout),
		err = Buffer.concat(stderr);
	const row = {
		event: "reply",
		actor,
		args,
		started,
		finished: Date.now(),
		code,
		signal,
		stdout: out.toString(),
		stderr: err.toString(),
	};
	log(row);
	const armed = existsSync(path.join(root, "arm"))
		? readFileSync(path.join(root, "arm"), "utf8")
		: "";
	const matches =
		armed === "direct"
			? args.slice(-2).join(" ") === "get url"
			: armed === "code" && args.slice(-2).join(" ") === "eval --stdin";
	if (actor === "A" && matches && code === 0 && !existsSync(path.join(root, "held.json"))) {
		writeFileSync(path.join(root, "held.json"), JSON.stringify(row));
		const deadline = Date.now() + 12_000;
		while (!existsSync(path.join(root, "release")) && Date.now() < deadline) {
			// Poll release only after the previous delay; this is a deliberate delivery barrier.
			await delay(10);
		}
		log({
			event: "forward-held",
			actor,
			at: Date.now(),
			released: existsSync(path.join(root, "release")),
		});
	}
	process.stdout.write(out);
	process.stderr.write(err);
	process.exitCode = code ?? 1;
};
child.on("close", (code, signal) => {
	forwardReply(code, signal).catch((/** @type {unknown} */ error) => {
		console.error(error);
		process.exitCode = 1;
	});
});
/** @type {NodeJS.Signals[]} */
const signals = ["SIGTERM", "SIGINT"];
for (const signal of signals) {
	process.on(signal, () => {
		child.kill(signal);
	});
}
