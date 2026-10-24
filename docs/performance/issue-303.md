# Unchanged-journal replay

## Result

Warm tree navigation through the real official Pi 1.4.0 SDK took **1,104 ms before and 11.4 ms after** on a synthetic 43,231,570-byte journal. These are medians of five alternating samples per side. The ranges were 1,011–1,273 ms before and 10.2–15.5 ms after. Every run restored the expected selected page, emitted three tree events and reported zero extension errors.

The compiled replay micro measurement took 1,207 ms before and 4.08 ms after. Its ranges were 1,077–1,301 ms and 3.73–4.67 ms. Cold extension binding remained inconclusive. Its ranges overlap, so this change makes no cold-start speedup claim.

These are cloud/source results, not installed macOS latency measurements. The historical issue samples came from older installed native/public builds. Neither those samples nor the owner's private journal were used here.

[Raw commands, programs, samples, inputs and profile summaries](issue-303.json) make the comparison inspectable. The artifact also records rejected measurement attempts rather than treating them as results.

## Work and limiter

A separate instrumented run read 86,463,532 stream bytes in 5,846 reads for one baseline replay. The candidate read the selected 392-byte browser body in one read. The same work counts occurred at the SDK tree boundary. The baseline profile identifies byte framing, `stream-json` parsing/projection and native reads as the main work. Those instrumented timings are not comparative samples.

Both sides use Node 24.22.1, npm 12.2.0, the same official 1.4.0 SDK graph and the same fixture hash. Both compiled artifact copies contain the identical package manifest and dependency link. Each fresh process opens the actual SDK session, binds the compiled extension and performs two warm tree navigations before measurement. The timer awaits the complete replay or `AgentSession.navigateTree()` promise. Assertions consume the results outside that timer. Every run verifies that SDK use leaves the fixture hash unchanged.

The fixture contains an assistant seed, a thinking-level entry, 5,180 synthetic custom entries with 8 KiB ignored strings and two sibling canonical browser-state leaves. It has 5,184 native entries plus the session header. It models large discarded journal payloads, not the owner's conversation distribution.

The first comparison was rejected because its baseline artifact omitted `package.json`, which changed Jiti's loading path. The final comparison uses matched immutable artifact layouts. A separate profile failed when the platform doctor invoked the package prepare lifecycle against a generated directory being imported. Its error is retained. Rebuilt outputs matched the recorded candidate hashes before final profiling.

## Design and limits

The extension retains structural metadata for four recently read paths per loaded module instance. Reuse requires matching device, inode, size and nanosecond modification/change times from the opened descriptor. It does not cache SDK bodies, selected branches, snapshots or reducer state.

Every restore still validates session identity and selected ancestry, projects browser records, resolves winning snapshots and verifies the descriptor against its path. Every file change, including append, invalidates the index. This deliberately retains a full validation scan for changed files. Append alone cannot prove that an old prefix was not rewritten. Growth during replay causes one fresh read with the originally captured leaf. Repeated change fails closed.

Cold reads and evicted indexes still scan the journal. The bound is four indexes, not a fixed number of bytes independent of entry count. Compiled ESM may retain a module across reload; a new module starts cold. Native generation checks, refs, interrupted intents, artifact/recording ownership, cleanup and optional conversion are unchanged.

## Verification and review

The new read-work regression failed on main and passes with the cache. Focused cache and existing storage recovery tests passed 55 cases with zero failures or skips. Independent same-model review found a rewrite-plus-growth race in the first candidate. The regression failed against that compiled candidate and passes after bounded revalidation. The reviewer inspected the correction and independently checked rewrite, append and repeated-growth cases. This was not a diverse-model panel.

An actual official 1.4.0 CLI RPC process loaded the compiled candidate and switched into the retained synthetic session. It exited zero with three successful requests, three lifecycle events and zero extension errors. That is credential-free SDK/CLI evidence, not actual-model TUI smoke. The complete latest-host runs have zero parallel failures, but the unchanged 250 ms cold-import gate failed in each serial stage. Those initial local full gates did not qualify. A one-shot untouched-main diagnostic also failed the same unchanged 250 ms budget: 342.4, 311.7 and 310.1 ms, compared with 283.5, 332.8 and 364.0 ms for the candidate. Both sides failed. This is an absolute machine/base budget blocker, not comparative speedup or regression evidence. Later exact-head CI results belong to the PR, not these failed-run counters. The earlier root-only ownership and detached-child failures disappear under a non-root user and native subreaper; their failed logs remain retained.

## Actual-model receipt

The coordinator ran the real interactive official Pi 1.4.0 CLI on macOS with the explicitly selected `zai/glm-5.3-flash` model at low thinking. This was not an OpenAI inference attempt or fallback. The code-owner configuration in the admission record remains separate.

Five real `agent_browser` calls opened and inspected `example.com` and Playwright's installation page, then closed only the disposable `issue303-smoke` session. All five succeeded. The open observations supplied both expected titles; fresh snapshots contained 1 and 183 refs. The full verified snapshot spill remains retained after close. Six actual assistant messages confirm the selected provider/model. The final assistant stopped normally and the interactive CLI exited zero after Ctrl-D.

[The original public-safe journal, PTY, launch, pane, manifests and receipt](issue-303-model-smoke.tar.gz) are preserved without changing their bytes. The archive is 46,315 bytes with SHA-256 `0a7c3b11ae8815822699ac1cd5341150b39b2a8d9690098b5e56605bbe517519`. Before extraction, the guest rejected unsafe path/link/special entries, verified the exact 15 regular members and checked all 14 declared member sizes and hashes. The raw artifact embeds the original receipt and verification results. Source paths in those files are provenance, not commands or live account authority.

This smoke executed tree `888fa28250a516e5965c77d94df8d5ef168c7ca8`. All nine source and four build/lock digests matched before and after. A later **test-only** correction fixes the restored-mtime fixture's nanosecond precision. That correction passes 7/7; a temporary ctime-omitted mutant fails exactly that case. Its nine-file source tree is `0c346a0046c3c028c6f5d801c464711ec63d16c1`, which was **not** model-executed. The production source, product documents, project lock and actual compiled runtime bytes are unchanged. Evidence-only additions and the final full Git tree are likewise not labelled as model-executed.

The receipt proves official macOS TUI/model/browser behavior. It does not prove fork-model behavior, rollover, replay latency or cache-hit improvement, and it does not waive any remaining quality, CI, review or platform gate. No Pi JSONL was deleted.

## Admission

The coordinator verified this task's active configuration through an owner-authenticated read-only GET of chat `43bf2197-2323-459a-9163-b219efd8eb07` at `2026-10-24T13:23:16.312911+00:00`. Canonical AgentDoc-backed values were provider `openai`, model `gpt-6.1-sol`, thinking `xhigh`, context 300000 and `connectionReady=true`. Configuration-version SHA-256 was `c52404be6ba45b2e0427d98acc645cf5eeba33d251e1acd2e798807cd4d3d5ea`. The coordinator retains the original `actual-model-evidence.json`. This records configured runtime evidence, not a model self-description. No configuration was changed.

The baseline is current main resolved at admission, `ae821a9b69dc271f3ab69f15a8cead31528f359a`. The measured source/test/product-doc candidate tree is `888fa28250a516e5965c77d94df8d5ef168c7ca8`, written with a temporary Git index before commit. The raw artifact records source, lock and compiled-output hashes. Later evidence-only additions do not change those measured runtime inputs.
