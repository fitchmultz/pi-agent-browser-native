# Browser session storage

Pi's native JSONL journal owns conversation history and branch ancestry. Browser replay uses small ordered `agent-browser-transition` entries in that journal; it has no separate database or snapshot sidecar.

## Events and snapshots

Every browser-affecting direct, code, or Electron host operation records a begin before dispatch and a finish after observing its effects. With a journal, each record requires confirmed publication. Direct browser use in a disabled/no-file session (`--no-session`) uses Pi's current in-memory ancestry without claiming persistence. Code still requires a published intent journal; a named but not-yet-published persistent conversation also refuses browser dispatch. Sessionless local inspections and browser-independent reads remain available before publication, including full redacted private spills and caller-selected output files. Their observation-only artifact receipts do not require a journal; browser effects, page changes and native confirmations retain their required records. `data.event` version 1 correlates them with an operation ID, the outer tool-call ID and inner command index. The same reducer applies committed live events and replays the selected branch.

A finish explicitly reuses, replaces, invalidates, or leaves refs unknown. Each complete capture defines one `data.snapshot`: an ID, keyed ref membership and accessible metadata, exact private target, and verified native daemon generation when available. Ordinary completions name the ancestral definition instead of copying its map. Dedicated snapshot results and requested structured exports still retain their full data. Native delta baselines remain native; a Pi snapshot ID cannot restore them.

An unfinished begin retains the old snapshot only as an inaccessible candidate. Failed begin publication prevents dispatch. Failed finish publication means changes may already have happened: dependent code calls stop and recovery requires inspection, without repeating the mutation. URL inspection alone cannot revive those refs. Presentation or file-export failure does not erase observed native launch, close, or page effects. Publication verifies the matching native entry through bounded JSONL framing, including native recovery that flushes older accepted entries or replaces the journal. These are synchronous journal receipts, not power-loss-atomic browser transactions.

A saved URL or map cannot prove the native browser survived. Reuse checks native PID/start identity and socket context; a changed or unverifiable generation invalidates refs until a complete new snapshot succeeds. Cold managed reopen keeps the exact remembered URL, including its fragment, under the existing native restore policy. An unverifiable generation invalidates refs without authorizing navigation over a live tab. Filtered and helper captures use the same native generation check as ordinary snapshots. A wrapper-owned launch also retains a small daemon receipt with the observed restore key and PID/start/socket generation. Restart may reuse that launch provenance only for the same Pi owner after native inspection matches both fields; a replacement daemon cannot inherit it.

## Reading and retention

Replay locates the journal through Pi's public session file, UUID and selected leaf. It captures that leaf before asynchronous reads and uses the same boundary for file and optional native ancestry validation, so concurrent appends cannot change the branch being replayed. It token-validates complete newline-terminated records with unpacked discarded strings, projects envelopes, follows ancestry, and reads only winning snapshot bodies. An incomplete live tail remains uncommitted. Optional public metadata APIs and `getEntry()` provide structural ancestry and selected snapshot access on the maintained fork. No writable manager or private core storage is used.

Official Pi 0.99.2 eagerly loads its own native journal before extension startup. This extension reduces browser write duplication and bounds extension recovery on that host; complete heap-independent host loading requires adoption of the native core repair. A caller-requested individual snapshot/result still must fit its consumer's memory. This is not an unlimited model-context or single-value API.

Artifact events persist row upserts/removals in journal order. The internal recent view defaults to 100 rows; it is separate from cumulative journal size and the independent recording reservation/tombstone journal. Artifact upserts are credential-redacted before persistence. Tool `details.artifactManifest` contains only changed or referenced receipts for that invocation, including evictions observed during that call. Retention summaries and close cleanup guidance can describe the internal recent view without copying it into every result.

Required replay snapshots stay in retained journal ancestry, outside observation-spill eviction. Caller-selected files remain caller-owned. Redacted persistent spills retain their existing byte budget; process-private files retain their existing cleanup. A receipt does not make external bytes immutable or include them in an export/checkpoint. Preserve referenced files in the matching archive layout when needed.

Tree changes join code execution through its complete observation finalization before restoring branch-visible state. Interrupted results retain complete caller observations in process-private spills without publishing their artifact state onto the newly selected branch. Tree changes do not roll back the real browser; process-owned cleanup and recording facts remain separate. An ordinary fork has a new native Pi UUID and cannot acquire its parent's managed/Electron/script cleanup rights. Wrapper-owned begins retain their selected socket root and owner UUID even if the launch finish is lost; restart can inspect or clean that original identity without declaring the launch successful. Owned follow-ups, code and cleanup keep that root when process defaults change; unrelated caller sessions retain native routing. Optional checkpoints refuse live or unverified resources and never close browsers to manufacture readiness.

## Converting a retained legacy journal

Legacy repeated maps/manifests and retired isolated-script leases are decoded only by the offline converter. Normal runtime replay requires the canonical event format and reports a conversion requirement rather than keeping a permanent second replay engine.

1. Stop or quiesce the exact writer through its owner. Do not convert an active journal or relaunch work merely to repair storage.
2. Keep the original journal and choose a distinct private destination outside automatic session discovery.
3. Run the packaged command:

```sh
npm exec --package pi-agent-browser-native -- pi-agent-browser-convert \
  --source /archive/original.jsonl \
  --output /private-converted/copy.jsonl --confirm-stopped \
  --receipt /private-converted/conversion-receipt.json
```

From a built checkout, use `node scripts/convert-browser-session.mjs` with the same arguments. The command never starts Pi, tools, providers, or browsers.

Conversion preserves the native header UUID, every entry ID/parent/timestamp, branches, labels, settings, usage, message content/images and explicit result data. It normalizes repeated browser state along each entry's actual ancestry, defines captures once on reachable ancestors, preserves unfinished outcomes and source cleanup ownership, and emits source checksum/byte-range provenance for transformed fields. Already-modern observations remain observations: their explicit data is preserved, and an invocation-only manifest cannot overwrite canonical replay state. Original audit bytes remain available in the retained source.

The source is opened read-only. Conversion validates UTF-8/JSON, rejects malformed records, missing/forward parents and duplicate IDs, and accepts a sealed valid unterminated final record without repairing the source. A private staged file is synced and published exclusively; occupied outputs, source aliases/symlinks and source changes are refused. The receipt records both locators, the unchanged native UUID, checksums, byte counts and conversion counts. A successful conversion always prints its receipt before attempting the optional exclusive receipt-file write. If that write fails, the command reports the error and exits unsuccessfully, while the published copy and printed receipt remain available; it never overwrites the occupied receipt or destination. Keep the receipt with the retained source and destination.

Select the converted locator explicitly through the native session/worker owner. Copies share a UUID, so do not leave both to arbitrary automatic lookup. Do not resume the original at an older boundary after newer effects. Conversion cannot recover evicted files, unstored credentials or an unrecorded mutation outcome; those remain unavailable or unknown.

## Verification

Focused storage tests exercise incident-sized refs, small-event growth, begin/finish append faults with actual dispatch counts, interruption, branch projections and native generation replacement. Existing tab/ref, confirmation, recording, artifact and lifecycle suites retain their behavior checks.

After `npm run build`, the opt-in model-free proof runs a journal above 1 GiB, including an ignored individual string above Node's string ceiling and repeated legacy maps, through conversion and selected replay under a constrained V8 heap:

```sh
node --max-old-space-size=128 test/helpers/large-browser-journal.mjs
```

The printed receipt reports the actual heap limit and peak RSS separately; a V8 old-space cap is not a total-memory cap. Ordinary package, official/fork host, native platform and CI qualification remain separate checks.
