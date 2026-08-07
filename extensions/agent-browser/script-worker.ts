import { randomBytes } from "node:crypto";
import { createContext, runInContext, Script } from "node:vm";

function parseLimit(value: string | undefined, label: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}.`);
	return parsed;
}

const maxMessageBytes = parseLimit(process.argv[2], "script IPC message limit");
const maxCumulativeBytes = parseLimit(process.argv[3], "script IPC cumulative limit");
let cumulativeBytes = 0;
let inputBuffer = Buffer.alloc(0);
let started = false;
const sandbox: Record<string, unknown> = Object.create(null);
const context = createContext(sandbox, {
	codeGeneration: { strings: false, wasm: false },
	name: "agent-browser-script",
});
const bridgeKey = `__piab_send_${randomBytes(16).toString("hex")}`;
const stateName = `__piab_state_${randomBytes(16).toString("hex")}`;
const hostSend = (json: string): boolean => {
	if (typeof json !== "string") return false;
	const bytes = Buffer.byteLength(json, "utf8") + 1;
	if (bytes > maxMessageBytes || cumulativeBytes + bytes > maxCumulativeBytes) return false;
	cumulativeBytes += bytes;
	try {
		process.stdout.write(`${json}\n`);
		return true;
	} catch {
		return false;
	}
};
Object.setPrototypeOf(hostSend, null);
Object.freeze(hostSend);
sandbox[bridgeKey] = hostSend;
runInContext(
	"const " + stateName + " = (() => {\n" +
	"  'use strict';\n" +
	"  const send = globalThis[" + JSON.stringify(bridgeKey) + "];\n" +
	"  delete globalThis[" + JSON.stringify(bridgeKey) + "];\n" +
	"  for (const name of ['console','process','require','Buffer','fetch','WebSocket','setTimeout','setInterval','setImmediate','queueMicrotask','clearTimeout','clearInterval','clearImmediate']) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });\n" +
	"  const NativePromise = Promise;\n" +
	"  const promiseThen = Promise.prototype.then;\n" +
	"  const reflectApply = Reflect.apply;\n" +
	"  const pending = new Map();\n" +
	"  let nextId = 0;\n" +
	"  const encode = (value) => { const json = JSON.stringify(value); if (typeof json !== 'string') throw new TypeError('Value must be JSON-serializable.'); return json; };\n" +
	"  const sendValue = (value) => { const json = encode(value); if (json.length + 1 > " + maxMessageBytes + " || send(json) !== true) throw new RangeError('Script IPC limit exceeded.'); };\n" +
	"  const browser = function browser(params) {\n" +
	"    return new NativePromise((resolve, reject) => {\n" +
	"      const id = ++nextId;\n" +
	"      pending.set(id, { resolve, reject });\n" +
	"      try { sendValue({ type: 'call', id, params }); } catch (error) { pending.delete(id); reject(error); }\n" +
	"    });\n" +
	"  };\n" +
	"  const emit = function emit(value) { sendValue({ type: 'emit', value }); };\n" +
	"  Object.setPrototypeOf(browser, null);\n" +
	"  Object.setPrototypeOf(emit, null);\n" +
	"  Object.freeze(browser);\n" +
	"  Object.freeze(emit);\n" +
	"  Object.defineProperties(globalThis, { browser: { value: browser, writable: false, configurable: false }, emit: { value: emit, writable: false, configurable: false } });\n" +
	"  const complete = (ok, value) => {\n" +
	"    if (ok) {\n" +
	"      try { sendValue(value === undefined ? { type: 'complete', hasValue: false } : { type: 'complete', hasValue: true, value }); }\n" +
	"      catch { sendValue({ type: 'complete', error: { name: 'RangeError', message: 'Final script value is not serializable or exceeds the IPC limit.' } }); }\n" +
	"      return;\n" +
	"    }\n" +
	"    let name = 'Error'; let message = 'Script execution failed.';\n" +
	"    try { if (value && typeof value.name === 'string') name = value.name.slice(0, 80); } catch {}\n" +
	"    try { if (value && typeof value.message === 'string') message = value.message.replace(/[\\r\\n]+/g, ' ').slice(0, 400); } catch {}\n" +
	"    sendValue({ type: 'complete', error: { name, message } });\n" +
	"  };\n" +
	"  return Object.freeze({\n" +
	"    deliver(json) {\n" +
	"      const message = JSON.parse(json);\n" +
	"      const target = pending.get(message.id);\n" +
	"      if (!target) return;\n" +
	"      pending.delete(message.id);\n" +
	"      target.resolve(message.envelope);\n" +
	"    },\n" +
	"    run(thunk) {\n" +
	"      let promise;\n" +
	"      try { promise = reflectApply(thunk, undefined, []); } catch (error) { complete(false, error); return; }\n" +
	"      reflectApply(promiseThen, promise, [value => complete(true, value), error => complete(false, error)]);\n" +
	"    }\n" +
	"  });\n" +
	"})();",
	context,
	{ timeout: 1_000 },
);
const deliver = runInContext(`${stateName}.deliver`, context, { timeout: 1_000 }) as (json: string) => void;

function fail(name: string, message: string): void {
	hostSend(JSON.stringify({ type: "complete", error: { name, message } }));
}

function describeError(error: unknown, fallback: string): { message: string; name: string } {
	if (!error || typeof error !== "object") return { message: fallback, name: "Error" };
	const candidate = error as { message?: unknown; name?: unknown };
	return {
		message: typeof candidate.message === "string" ? candidate.message.replace(/[\r\n]+/g, " ").slice(0, 400) : fallback,
		name: typeof candidate.name === "string" ? candidate.name.slice(0, 80) : "Error",
	};
}

function handleLine(line: string): void {
	const bytes = Buffer.byteLength(line, "utf8") + 1;
	if (bytes > maxMessageBytes || cumulativeBytes + bytes > maxCumulativeBytes) {
		fail("RangeError", "Script IPC limit exceeded.");
		return;
	}
	cumulativeBytes += bytes;
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		fail("Error", "Invalid parent IPC message.");
		return;
	}
	if (!started) {
		if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "start" || typeof (message as { code?: unknown }).code !== "string") {
			fail("Error", "Invalid script start message.");
			return;
		}
		started = true;
		try {
			const source = `'use strict';\n${stateName}.run(async function () {\n'use strict';\n${(message as { code: string }).code}\n});`;
			const script = new Script(source, {
				filename: "agent-browser-script.js",
				importModuleDynamically() {
					process.exit(70);
				},
			});
			script.runInContext(context, { timeout: undefined });
		} catch (error) {
			const described = describeError(error, "Script compilation failed.");
			fail(described.name, described.message);
		}
		return;
	}
	if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "response") {
		fail("Error", "Invalid parent IPC response.");
		return;
	}
	try {
		deliver(line);
	} catch {
		fail("Error", "Invalid browser response envelope.");
	}
}

process.stdin.on("data", (rawChunk) => {
	const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
	inputBuffer = Buffer.concat([inputBuffer, chunk]);
	if (inputBuffer.length > maxMessageBytes) {
		fail("RangeError", "Script IPC message limit exceeded.");
		process.stdin.pause();
		return;
	}
	for (;;) {
		const newline = inputBuffer.indexOf(10);
		if (newline < 0) break;
		const line = inputBuffer.subarray(0, newline).toString("utf8");
		inputBuffer = inputBuffer.subarray(newline + 1);
		handleLine(line);
	}
});
process.stdin.on("error", () => undefined);
hostSend(JSON.stringify({ type: "ready" }));
