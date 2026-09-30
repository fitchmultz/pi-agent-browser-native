// Delay actual native identity-helper startup, never fabricate PID/start identities.
// execFile's real deadline and AbortSignal still terminate the helper process.
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const nativeExecFile = childProcess.execFile;
const delayMs = Number(process.env.PIAB_TEST_IDENTITY_DELAY_MS ?? 0);
const report = (row) => process.stderr.write(`${JSON.stringify({ observer: process.pid, ...row })}\n`);
childProcess.execFile = function (file, args, options, callback) {
	if (typeof options === "function") { callback = options; options = {}; }
	if (!["/bin/ps", "/usr/bin/ps", "ps"].includes(file) && !file.toLowerCase().endsWith("powershell.exe")) {
		return nativeExecFile(file, args, options, callback);
	}
	const started = Date.now();
	const source = `const {execFileSync} = require("node:child_process"); setTimeout(() => { try { process.stdout.write(execFileSync(${JSON.stringify(file)}, ${JSON.stringify(args)})); } catch (error) { process.stderr.write(String(error)); process.exitCode = error.status || 1; } }, ${delayMs});`;
	const command = delayMs > 0 ? process.execPath : file;
	const commandArgs = delayMs > 0 ? ["--eval", source] : args;
	return nativeExecFile(command, commandArgs, { ...options, env: { ...process.env, NODE_OPTIONS: undefined } }, (error, stdout, stderr) => {
		report({ phase: "identity", file, args, timeout: options.timeout, elapsed: Date.now() - started, error: error?.code ?? null, signal: error?.signal ?? null });
		callback(error, stdout, stderr);
	});
};
// Sibling controls also use Node's public promisified { stdout, stderr } API.
childProcess.execFile[promisify.custom] = nativeExecFile[promisify.custom];
for (const operation of ["lstat", "readFile", "rename"]) {
	const native = fs[operation];
	fs[operation] = async function (...args) {
		try { return await native(...args); }
		catch (error) {
			if (String(args[0]).includes(".pi-agent-browser-policy-")) report({ phase: "filesystem", operation, path: String(args[0]), error: error.code ?? error.name });
			throw error;
		}
	};
}
syncBuiltinESMExports();
