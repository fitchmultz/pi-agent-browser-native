# Performance

The extension avoids redundant work while preserving native browser capabilities,
validation, redaction, page-target checks, transcript integrity, and cleanup
ownership. The largest improvements are in large-result processing and offline
journal conversion. Browser navigation and model latency remain outside those
CPU measurements.

## Captured baseline and integrated result

The [retained measurement record](performance/2026-10-12.json) compares baseline
`41467b70d255c06f5ec5e226a1adec420f8bcf4b` with the integrated runtime, identified by
source and compiled-tree hashes. Measurements used Node 24.21.0 on macOS arm64,
Apple M5 Pro, 18 logical CPUs, and 64 GiB RAM. This was a shared host: recorded load
varied substantially. Paired order was baseline / optimized / optimized / baseline.

### Fixed compiled-owner workloads

Each side has 14 measured samples per workload, after two warmups in each run.
Values are pooled medians in milliseconds; CPU is process user + system time.
Outputs, recovery metadata, ordering, UTF-8, discarded JSON grammar, and recording
replacement controls passed on both revisions.

| Workload                                          | Wall before → after | CPU before → after | CPU reduction |
| ------------------------------------------------- | ------------------: | -----------------: | ------------: |
| Redact 1 MiB prose with embedded credentials      |       33.05 → 20.43 |      37.82 → 23.82 |         37.0% |
| Summarize 20,000 snapshot refs                    |         8.49 → 1.23 |       12.68 → 2.74 |         78.4% |
| Project batch metadata with 10,000 discarded rows |        22.10 → 0.14 |       26.73 → 0.18 |         99.3% |
| Merge 10,000 artifact entries                     |       591.48 → 3.46 |      609.91 → 6.37 |         99.0% |
| Project 1,000 small journal records               |       47.58 → 13.42 |     101.96 → 27.34 |         73.2% |

These are deliberate scaling fixtures, not estimates of every ordinary call.
For example, batch projection's median transient heap delta fell from 59.24 MiB to
0.064 MiB, but that delta is not a retained-memory or allocation-total measurement.
Automatic GC and scheduling still produced wall-time outliers; the record retains
all samples rather than trimming them.

### Actual native browser calls

The registered extension tools also ran against real agent-browser **0.38.1** and
headless Chrome for Testing **151.0.7922.77**, using deterministic loopback pages,
automatic per-root sessions, two warmups, and 30 measured calls per workload on
each revision. These source-loaded harness calls include native/browser subprocess
latency; they do not include Pi's model/provider turn or external-site latency.

| Warm native workload         | Median wall ms before → after |
| ---------------------------- | ----------------------------: |
| Title read with current refs |               156.14 → 127.19 |
| Selector text read           |               188.21 → 158.55 |
| Interactive snapshot         |               229.03 → 211.23 |
| Two-row native getter batch  |               187.07 → 157.04 |
| One-getter browser code cell |               185.03 → 154.88 |

Host noise matters: one snapshot run was slower, 239.08 versus 229.25 ms;
its other pair improved. These samples do not establish a universal browser
speedup. Instrumented fake-native controls provide stronger work-count evidence:
qualifying title/batch calls drop from four subprocesses to three; snapshot and
eval drop from six to five; ref text/fill drop from five to four. No-ref and
unrelated explicit-session controls keep their existing three subprocesses.
Within-revision run medians varied by up to about 40 ms, so differences beyond
the eliminated subprocess are not causally attributed here.

Fifteen fresh import/factory samples on each revision remained below the existing
250 ms budget: baseline 54.91–57.14 ms, optimized 55.29–58.44 ms. Ranges overlap,
so no startup improvement is claimed. Both sides included optional search-tool
registration without a search call. This diagnostic uses the locked development
SDK snapshot; latest official/fork host qualification is a separate delivery gate.

### Additional owner-boundary evidence

Independent timeout-artifact checks remove cumulative retry waits: 1,000 missing
paths took a median 50,700.11 → 59.54 ms, while one path stayed 50.58 → 50.66 ms.
Across three 1,000-path runs, median process-wide sampled peaks were 19.19 MB
heapUsed and 89.33 MB RSS, compared with 13.92 MB / 82.30 MB before (1 ms sampling). This exchanges modest linear transient memory for
overlapping independent timers; it does not infer completed native steps.

The distinct-session conversion comparison isolates branch retention: its
pre-retention converter has the baseline retention logic **with the new tokenizer**,
not the unchanged baseline commit. At 2,000 identities, median process-wide sampled
peak heapUsed fell from 96.16 to 31.35 MB (1 ms sampling). At 4,000 identities,
that pre-retention converter aborted with heap exhaustion (exit 134); the optimized
converter completed with exact source/checksum checks. Both used `--max-old-space-size=128`; the actual total V8 heap limit was
335,544,320 bytes, not a 128 MiB process-memory cap.
The separate integrated compiled >1 GiB proof converted 1,612,280,613 source
bytes to 1,078,631,285 bytes, verifying 34,683 refs, 100 receipts, three branches,
and 4,001 distinct sessions. Its actual V8 heap limit was 335,544,320 bytes and
peak RSS was 375,568 KiB. This correctness proof is separate from the smaller
scaling comparison.

Synthetic macOS discovery fixtures removed 360 unnecessary payload filesystem
requests (601 → 241), with median CPU 19.86 → 10.27 ms. The strict quality-prefix
fixture reduced duplicate policy passes from three to one, with median wall time
6,085.27 → 3,665.97 ms. That is the prefix, not the entire quality workflow. Raw
owner measurements and their fixture protocols are retained alongside the final
integrated profiles.

## Reproduce the warm-path profile

Use the repository's Node and npm versions, install its locked dependencies, and
build the target first:

```sh
npm ci --ignore-scripts
npm run build
npm run performance-profile -- --samples 7 > performance.json
```

The profiler imports compiled production owners and checks independently specified
outputs. It runs two warmups and records every measured sample for five fixed
workloads: 1 MiB prose redaction, a 20,000-ref snapshot summary, metadata projection
of a batch containing 10,000 data rows, a 10,000-entry artifact manifest, and 1,000
small journal projections. It does not launch a browser, Pi, npm, or a subprocess.

To compare revisions, build each in its own worktree and use the **same profiler**
against both compiled trees. Alternate the order to reduce host-load bias:

```sh
node --expose-gc scripts/profile-performance.mjs --root ../baseline --samples 7 > baseline-a.json
node --expose-gc scripts/profile-performance.mjs --root . --samples 7 > optimized-a.json
node --expose-gc scripts/profile-performance.mjs --root . --samples 7 > optimized-b.json
node --expose-gc scripts/profile-performance.mjs --root ../baseline --samples 7 > baseline-b.json
```

Keep Node, fixtures, configuration, and hardware constant. Do not run broad tests
or builds alongside timing samples. Source, compiled-tree, lockfile, fixture, and
profiler hashes identify the actual inputs; a package version alone is not a
revision identifier.

Wall time excludes imports, fixture construction, explicit pre-sample GC, and
output assertions. CPU includes process user and system time during that interval.
Heap deltas are transient `heapUsed` differences with the output still alive—not
allocation totals, retained memory, or peaks. RSS is process-wide; the reported
high-water mark also includes setup. Shared-host load and automatic GC remain
sources of variation. There are no warm-path timing thresholds.

Entrypoint startup has a separate fresh-process profiler and its existing 250 ms
budget:

```sh
npm run verify -- startup-profile --samples 3
```

That measurement is extension import/factory time, not full Pi startup or browser
launch time. See [the proof contract](REFERENCE.md#proof-and-verification).

## What changed

### Results and command planning

- Embedded-JSON redaction searches for structured-value openers and copies ordinary
  prose in slices rather than appending every character. Balanced-value parsing,
  malformed-input handling, credential redaction, and unchanged output survive.
- Snapshot summaries count the existing refs without constructing and sorting a
  complete ref list that the summary never uses.
- Compact batch metadata excludes `data` and `stdout` before recursive projection
  and redaction. Required metadata, warnings, and exact recovery actions remain;
  full result and replay ownership do not move into the compact observation.
- Artifact-manifest merging materializes recording candidates only when the entry
  can supersede a recording. Ordinary image entries no longer copy a growing map
  for a check that immediately returns empty. Recording identity and ordering stay
  unchanged.
- Argv descriptors reuse their already-cleaned command tokens. Launch-flag checks
  discover command position only for the special `wait --state` distinction;
  native boolean and restore flag semantics remain intact.

### Journal and artifact storage

Journal projection uses the installed streaming parser's raw tokenizer instead of
building a Node stream pipeline for each record. Live replay applies the same
native-or-token selection as its metadata scan to retained-size records; larger
records still use the tokenizer. Both paths validate UTF-8 and complete JSON,
including discarded values. The streaming path retains its explicit end-of-input
flush, and the parser is still loaded lazily.

Both offline converters retain a branch projection only until its last source
child consumes it. Linear histories no longer retain every historical state map;
real forks keep the independent state they need. Conversion still verifies the
unchanged source and publishes an exclusive separate copy, never rewriting the
original journal. The large-journal proof includes an individual string above
Node's string ceiling and 4,000 distinct session identities:

```sh
npm run build
node --max-old-space-size=128 test/helpers/large-browser-journal.mjs
```

The `128` setting limits V8 old space, not total V8 heap or process RSS. Report
those separately. See [session storage](SESSION_STORAGE.md#verification).

Artifact-retention scans overlap four independent file stats at a time, preserving
scan order before eviction. This does not change the secure socket-directory
traversal or its validation/error order.

### Browser execution and timeout recovery

A daemon observation may be reused only within one locked call, for its exact
socket/namespace/session identity, before any intervening browser helper. It is
not a cross-call cache. Replacement and unknown-generation checks remain
fail-closed; capture still obtains its distinct post-operation generation receipt.
Calls with no redundant observation keep their existing probes.

A call waiting for another Pi process's browser operation no longer starts a
process-identity query every 10 ms while that holder is confirmed alive. It sleeps
on the holder's owner-lifetime socket and re-runs normal arbitration when the
socket closes on release or exit. Unverifiable and still-choosing claims, older
owners, unavailable endpoints, socket paths over the platform limit and native
Windows keep polling. See [execution coordination](ARCHITECTURE.md).

Independent timeout-artifact retry windows now overlap. Each declared path still
gets up to three checks, 25 ms apart; results retain native plan order and page
inspection starts afterward. A file finishing after **its own** window may remain
missing. Existing files and recovered URLs remain current-state evidence, never
proof that a timed-out step executed. See
[the timeout contract](TOOL_CONTRACT.md#details).

### Discovery, verification, and packages

macOS Electron discovery stops after a missing framework instead of also probing
its payload. Positive app verification and discovery order are unchanged.

The quality facade runs scope and suppression-policy validation once through
`lint`, rather than also repeating those checks as standalone steps. The same
strict checker, compiler, formatting, tests, mutation probes, and document checks
remain required.

The build retains the complete emitted checkout tree. npm selects the bundled
extension, unchanged permissioned code worker, and standalone helper bundles under
`dist/packaged/lib/`. Package-only helpers do not overwrite raw checkout modules:
that would split shared async-local process context and temporary-resource owners.
Pi peers stay external and host-provided; source installs keep the existing
`prepare` build. The package consumer checks execute config, offline conversion,
the permissioned worker, and real Pi SDK/CLI loading without optional host peers
installed in the consumer.

## Preserved boundaries and rejected approaches

No cross-call config/secret/DOM cache, pooled JavaScript worker, new recipe layer,
or weaker validation gate was introduced. Fresh code globals, ordered secrets,
rate spacing, cancellation, shared locks, live page checks, redaction, and
branch-visible replay retain their existing owners.

Parallel socket-directory traversal was not adopted: candidate traversal and
native unknown-Dirent fallback behavior did not preserve the baseline's integrity
and failure-order controls. The original traversal remains. Helper bundles that
overwrite emitted checkout modules were also rejected and replaced with separate
package-only outputs. Smaller whitespace-only bundles did not demonstrate a
startup improvement beyond host noise.

These decisions bound the performance claims. Synthetic CPU/scaling improvements
are not an equivalent speedup for arbitrary browser workflows, external sites,
model responses, or installation time. Windows qualification remains subject to
the explicit owner waiver in [release guidance](RELEASE.md#current-0616-rollout-waiver).
