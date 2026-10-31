import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runtime = new URL("../dist/extensions/agent-browser/lib/", import.meta.url);
const setup = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readClaim, readClaims } from ${JSON.stringify(new URL("browser-execution-claim-storage.js", runtime))};
import { acquireExecutionClaim } from ${JSON.stringify(new URL("browser-execution-claims.js", runtime))};
import { ensureCoordinationDirectory, getBrowserExecutionLockPath } from ${JSON.stringify(new URL("browser-execution-identity.js", runtime))};
import { readProcessStartIdentity, resolveProcessStartIdentityFromCommands } from ${JSON.stringify(new URL("process-identity.js", runtime))};
const root = process.argv[1];
const token = 'PRIVATE_OWNER_TOKEN';
const owner = { version: 4, pid: process.pid, startIdentity: 'PRIVATE_START_IDENTITY', token, sessionNames: ['PRIVATE_SESSION_NAME'] };
async function plant(base, content = JSON.stringify(owner)) {
  const path = base + '.claim-' + token;
  await fs.mkdir(path, { mode: 0o700 });
  await fs.writeFile(join(path, 'owner.json'), content, { mode: 0o600 });
  return path;
}
`;

async function runDiagnostic(
	enabled: boolean,
	scenario: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
	const root = await mkdtemp(join(tmpdir(), "private-policy-debug-"));
	try {
		return await new Promise((resolve, reject) => {
			execFile(
				process.execPath,
				["--input-type=module", "-e", setup + scenario, root],
				{
					env: { ...process.env, NODE_DEBUG: enabled ? "pi-agent-browser-policy" : "" },
					maxBuffer: 256 * 1_024,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(new Error("Policy diagnostic subprocess failed", { cause: error }));
					} else {
						resolve({ stdout, stderr });
					}
				},
			);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const refusedScenarios = `
assert.equal(await ensureCoordinationDirectory(join(root, 'absent', 'directory'), process.platform), false);
await fs.writeFile(join(root, 'not-directory'), 'PRIVATE_CONTENT');
assert.equal(await ensureCoordinationDirectory(join(root, 'not-directory'), process.platform), false);
assert.equal(await readClaims(join(root, 'absent', 'table')), undefined);
const base = join(root, 'table');
const path = await plant(base, '{PRIVATE_MALFORMED_OWNER');
assert.equal(await readClaims(base), undefined);
await fs.writeFile(join(path, 'owner.json'), JSON.stringify(owner));
await fs.writeFile(join(path, 'ticket.json'), JSON.stringify({ version: 4, token: 'PRIVATE_WRONG_TOKEN', ticket: 1 }), { mode: 0o600 });
assert.equal(await readClaim(path), undefined);
await fs.rm(join(path, 'ticket.json'));
await fs.rm(join(path, 'owner.json'));
await fs.mkdir(join(path, 'owner.json'));
assert.equal(await readClaim(path), undefined);
// Native spawn syscall includes the executable path: the logger must normalize it.
assert.equal(await resolveProcessStartIdentityFromCommands([{ file: join(root, 'PRIVATE_EXECUTABLE'), args: [] }]), undefined);
assert.equal(await resolveProcessStartIdentityFromCommands([{ file: process.execPath, args: ['-e', 'process.exit(7)'] }]), undefined);
assert.equal(await readProcessStartIdentity(process.pid, process.platform, { deadline: 0 }), undefined);
assert.equal(await acquireExecutionClaim({ identity: { socketContext: 'PRIVATE_CONTEXT', sessionNames: ['PRIVATE_SESSION'] }, signal: AbortSignal.abort() }), undefined);
process.stdout.write('refused');
`;

test("policy debug is silent by default and preserves refusals when enabled", async () => {
	const quiet = await runDiagnostic(false, refusedScenarios);
	const enabled = await runDiagnostic(true, refusedScenarios);
	assert.equal(quiet.stdout, "refused");
	assert.equal(quiet.stderr, "");
	assert.equal(enabled.stdout, quiet.stdout);
	assert.match(
		enabled.stderr,
		/PI-AGENT-BROWSER-POLICY \d+: attempt=0 phase=standalone stage=prepare\.directory-mkdir reason=native-error code=ENOENT syscall=mkdir/,
	);
	assert.match(enabled.stderr, /stage=prepare\.directory-stat reason=unsafe-metadata/);
	assert.match(
		enabled.stderr,
		/stage=claims\.readdir reason=native-error code=ENOENT syscall=scandir/,
	);
	assert.match(enabled.stderr, /stage=claim\.owner-read reason=invalid-owner/);
	assert.match(enabled.stderr, /stage=claims\.inspect reason=absence-not-confirmed/);
	assert.match(enabled.stderr, /stage=claim\.ticket-read reason=invalid-ticket-or-token/);
	assert.match(enabled.stderr, /stage=claim\.metadata reason=unsafe-directory-or-owner/);
	assert.match(
		enabled.stderr,
		/stage=probe\.execute reason=native-error code=ENOENT syscall=spawn/,
	);
	assert.match(enabled.stderr, /stage=probe\.execute reason=native-error code=- syscall=- exit=7/);
	assert.match(enabled.stderr, /stage=probe\.budget reason=deadline/);
	assert.match(enabled.stderr, /stage=acquire\.begin reason=cancelled/);
	assert.doesNotMatch(enabled.stderr, /PRIVATE_|private-policy-debug|[\\/]|Error:|\bat /);
});

const quietRaces = `
const base = join(root, 'table');
const path = await plant(base);
assert.equal((await readClaim(path)).ticket, null);
assert.equal((await readClaims(base)).length, 1);
// Disappear at the existing owner-stat observation; all errors/results still come from native I/O.
const nativeLstat = fs.lstat;
mock.method(fs, 'lstat', async (...args) => {
  if (args[0] === join(path, 'owner.json')) await fs.rm(path, { recursive: true });
  return nativeLstat(...args);
});
syncBuiltinESMExports();
assert.deepEqual(await readClaims(base), []);
mock.reset();
syncBuiltinESMExports();
process.stdout.write('choosing-and-disappearance-safe');
`;

test("policy debug stays quiet for choosing tickets and confirmed disappearance", async () => {
	const quiet = await runDiagnostic(false, quietRaces);
	const enabled = await runDiagnostic(true, quietRaces);
	assert.equal(quiet.stdout, "choosing-and-disappearance-safe");
	assert.equal(enabled.stdout, quiet.stdout);
	assert.equal(quiet.stderr, "");
	assert.equal(enabled.stderr, "");
});

test("policy debug preserves the native owner ENOENT when its published directory still exists", async () => {
	const enabled = await runDiagnostic(
		true,
		`
const base = join(root, 'table');
const path = await plant(base);
const nativeRead = fs.readFile;
mock.method(fs, 'readFile', async (...args) => {
  if (args[0] === join(path, 'owner.json')) await fs.rm(args[0]);
  return nativeRead(...args);
});
syncBuiltinESMExports();
assert.equal(await readClaims(base), undefined);
mock.reset();
syncBuiltinESMExports();
process.stdout.write('refused');
`,
	);
	assert.equal(enabled.stdout, "refused");
	assert.match(
		enabled.stderr,
		/stage=claim\.owner-read reason=native-error code=ENOENT syscall=open/,
	);
	assert.match(enabled.stderr, /stage=claims\.inspect reason=absence-not-confirmed/);
	assert.doesNotMatch(enabled.stderr, /PRIVATE_|private-policy-debug|[\\/]/);
});

test("policy debug retains both refusal and unresolved-absence errors from existing observations", async () => {
	const enabled = await runDiagnostic(
		true,
		`
const base = join(root, 'table');
const path = await plant(base);
const nativeRead = fs.readFile;
const nativeStat = fs.lstat;
let directoryStats = 0;
mock.method(fs, 'readFile', async (...args) => {
  if (args[0] === join(path, 'owner.json')) await fs.rm(args[0]);
  return nativeRead(...args);
});
mock.method(fs, 'lstat', async (...args) => {
  if (args[0] === path && ++directoryStats === 2) {
    throw Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'), { code: 'EACCES', syscall: 'lstat', path: 'PRIVATE_PATH' });
  }
  return nativeStat(...args);
});
syncBuiltinESMExports();
assert.equal(await readClaims(base), undefined);
assert.equal(directoryStats, 2);
mock.reset();
syncBuiltinESMExports();
process.stdout.write('refused');
`,
	);
	assert.equal(enabled.stdout, "refused");
	assert.match(
		enabled.stderr,
		/stage=claims\.absence-stat reason=absence-not-confirmed code=EACCES syscall=lstat/,
	);
	assert.match(
		enabled.stderr,
		/stage=claim\.owner-read reason=native-error code=ENOENT syscall=open/,
	);
	assert.doesNotMatch(enabled.stderr, /PRIVATE_|private-policy-debug|[\\/]/);
});

const concurrentAttempts = `
// These claims live in the shared coordination directory, where other processes' GC verifies
// owner liveness against the real native start identity; a substituted identity reads as PID reuse.
const startIdentity = await readProcessStartIdentity(process.pid);
assert.ok(startIdentity);
const goodIdentity = { socketContext: randomUUID(), sessionNames: ['PRIVATE_SESSION_NAME'] };
const badIdentity = { socketContext: randomUUID(), sessionNames: ['PRIVATE_SESSION_NAME'] };
const badBase = getBrowserExecutionLockPath(badIdentity);
await ensureCoordinationDirectory(dirname(badBase), process.platform);
const badPath = await plant(badBase, '{PRIVATE_MALFORMED_OWNER');
let good;
let goodPath;
let originalOwner;
try {
  const results = await Promise.all([
    acquireExecutionClaim({ identity: goodIdentity, timeoutMs: 0 }),
    acquireExecutionClaim({ identity: badIdentity, timeoutMs: 0 }),
  ]);
  good = results[0];
  assert.ok(good);
  assert.equal(results[1], undefined);
  const goodBase = getBrowserExecutionLockPath(goodIdentity);
  const names = await fs.readdir(dirname(goodBase));
  goodPath = join(dirname(goodBase), names.find(name => name.startsWith(basename(goodBase) + '.claim-')));
  originalOwner = await fs.readFile(join(goodPath, 'owner.json'));
  await fs.writeFile(join(goodPath, 'owner.json'), '{PRIVATE_MALFORMED_OWNER');
  // Release is invoked after the other acquisition completed: its original attempt must survive.
  assert.equal(await good.release(), undefined);
  await fs.writeFile(join(goodPath, 'owner.json'), originalOwner);
  await good.release();
  good = undefined;
  process.stdout.write('success-and-fail-closed\\n' + startIdentity);
} finally {
  if (good && goodPath && originalOwner) {
    await fs.writeFile(join(goodPath, 'owner.json'), originalOwner);
    await good.release();
  }
  await fs.rm(badPath, { recursive: true, force: true });
}
`;

test("policy debug correlates concurrent acquisition failures and later release without changing outcomes", async () => {
	const quiet = await runDiagnostic(false, concurrentAttempts);
	const enabled = await runDiagnostic(true, concurrentAttempts);
	const [quietOutcome] = quiet.stdout.split("\n");
	const [enabledOutcome, startIdentity] = enabled.stdout.split("\n");
	assert.equal(quietOutcome, "success-and-fail-closed");
	assert.equal(quiet.stderr, "");
	assert.equal(enabledOutcome, quietOutcome);
	assert.match(
		enabled.stderr,
		/attempt=2 phase=acquire stage=claim\.owner-read reason=invalid-owner/,
	);
	assert.match(
		enabled.stderr,
		/attempt=2 phase=acquire stage=ticket\.scan reason=claims-unavailable/,
	);
	assert.match(
		enabled.stderr,
		/attempt=1 phase=release stage=claim\.owner-read reason=invalid-owner/,
	);
	assert.match(
		enabled.stderr,
		/attempt=1 phase=release stage=release\.complete reason=claim-not-removed/,
	);
	assert.doesNotMatch(enabled.stderr, /PRIVATE_|private-policy-debug|[\\/]/);
	assert.match(startIdentity, /\S/);
	assert.equal(enabled.stderr.includes(startIdentity), false);
});
