// Opt-in bounded-heap storage proof. No Pi, provider, extension tool or browser is started.
// Run after npm run build: node --max-old-space-size=128 test/helpers/large-browser-journal.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { convertBrowserSession } from '../../dist/extensions/agent-browser/lib/browser-session-conversion.js';
import { readBrowserEntries, readRange } from '../../dist/extensions/agent-browser/lib/browser-journal.js';
import { applyArtifactChanges, getBrowserRecord } from '../../dist/extensions/agent-browser/lib/browser-transcript.js';
import { SessionPageState } from '../../dist/extensions/agent-browser/lib/session-page-state.js';

const root = await mkdtemp(join(tmpdir(), 'piab-large-journal-'));
const source = join(root, 'original.jsonl'), destination = join(root, 'converted.jsonl');
const hashFile = async path => {
  const file = await open(path, 'r');
  try { const hash = createHash('sha256'); for await (const bytes of readRange(file, { offset: 0, length: (await file.stat()).size })) hash.update(bytes); return hash.digest('hex'); }
  finally { await file.close(); }
};
try {
  const file = await open(source, 'wx', 0o600);
  const timestamp = '2026-09-30T00:00:00.000Z';
  const header = { type: 'session', version: 3, id: 'large-session', cwd: root, timestamp };
  try {
    await file.write(JSON.stringify(header) + '\n');
    await file.write('{"type":"custom","customType":"unrelated","id":"giant","parentId":null,"timestamp":"' + timestamp + '","data":{"ignored":"');
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let index = 0; index < 1025; index++) await file.write(chunk); // The ignored string alone exceeds 1 GiB and Node's whole-string ceiling.
    await file.write('"}}\n');
    const refIds = Array.from({ length: 34683 }, (_, index) => `e${index + 1}`);
    const target = { url: 'https://fixture.test/large#exact-fragment', targetId: 'native-target' };
    const snapshot = { refIds, refs: Object.fromEntries(refIds.map(id => [id, { role: 'textbox', name: 'Field', isEditable: true }])), target };
    const entries = Array.from({ length: 100 }, (_, index) => ({ path: join(root, `caller-${index}.png`), kind: 'image', storageScope: 'explicit-path', retentionState: 'live', createdAtMs: index }));
    const manifest = { version: 1, entries, liveCount: 100, evictedCount: 0, maxEntries: 100, updatedAtMs: 100 };
    const legacy = (id, parentId, details) => ({ type: 'custom', customType: 'agent-browser-transition', id, parentId, timestamp, data: { toolCallId: 'large-outer', isError: false, details } });
    const details = { args: ['get', 'title'], command: 'get', subcommand: 'title', sessionName: 'large', sessionTabTarget: target, refSnapshot: snapshot, artifactManifest: manifest };
    await file.write(JSON.stringify(legacy('capture', 'giant', { ...details, args: ['snapshot', '-i'], command: 'snapshot' })) + '\n');
    let parent = 'capture';
    for (let index = 0; index < 220; index++) { const id = `read-${index}`; await file.write(JSON.stringify(legacy(id, parent, details)) + '\n'); parent = id; }
    await file.write(JSON.stringify(legacy('branch-b', 'capture', { ...details, sessionTabTarget: { url: 'https://fixture.test/b#branch' }, refSnapshot: { refIds: ['e7'], refs: { e7: { role: 'button', name: 'Other' } } } })) + '\n');
    await file.sync();
  } finally { await file.close(); }
  const before = await hashFile(source);
  const receipt = await convertBrowserSession({ source, destination, confirmedStopped: true });
  assert.equal(receipt.sourceSha256, before);
  assert.equal(await hashFile(source), before);
  assert.equal(receipt.snapshotDefinitions, 2);
  assert.ok(receipt.sourceBytes > 1024 * 1024 * 1024);
  assert.ok(receipt.sourceBytes - receipt.destinationBytes > 400 * 1024 * 1024, 'repeated legacy maps collapse without dropping the ignored value');
  const manager = leaf => ({ getSessionFile: () => destination, getHeader: () => header, getSessionId: () => header.id, getLeafId: () => leaf,
    getEntries() { throw Error('No eager entries'); }, getBranch() { throw Error('No eager branch'); }, getEntry() { throw Error('No eager native payload'); } });
  const branch = await readBrowserEntries(manager('read-219'));
  const page = SessionPageState.fromBranch(branch).get('large');
  assert.equal(page.refSnapshot.refIds.length, 34683);
  assert.deepEqual(page.refSnapshot.refs.e34683, { role: 'textbox', name: 'Field', isEditable: true });
  assert.equal(page.tabTarget.url, 'https://fixture.test/large#exact-fragment');
  let recent; for (const entry of branch) recent = applyArtifactChanges(recent, getBrowserRecord(entry)?.event.artifacts);
  assert.equal(recent.entries.length, 100);
  const other = SessionPageState.fromBranch(await readBrowserEntries(manager('branch-b'))).get('large');
  assert.deepEqual(other.refSnapshot.refIds, ['e7']);
  assert.equal(other.tabTarget.url, 'https://fixture.test/b#branch');
  assert.equal((await stat(source)).size, receipt.sourceBytes);
  console.log(JSON.stringify({ ...receipt, heapLimitBytes: getHeapStatistics().heap_size_limit, maxRssKiB: process.resourceUsage().maxRSS, selectedRefs: page.refSnapshot.refIds.length, recentReceipts: recent.entries.length, branchesVerified: 2 }));
} finally { await rm(root, { recursive: true, force: true }); }
