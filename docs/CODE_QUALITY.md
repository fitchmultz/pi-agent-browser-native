# Code quality

Oxlint owns maintained-code linting, Oxfmt owns supported formatting, and TypeScript,
tests, builds, and generated-document checks remain independent gates. Use the pinned
Node runtime and npm version in `package.json`, then `npm ci --ignore-scripts`.

Correctness, long-term maintainability, and reliable enforcement are equal
requirements. Keep production complexity, size, readonly, and safety checks even
when satisfying them requires substantial restructuring. A maintainability finding
does not need to identify a current runtime bug. Refactors must improve responsibility
boundaries, explicit ownership, failure/cancellation flow, and localized changes—not
just move lines, add forwarding layers, or pass a giant mutable context everywhere.
Use already authorized exceptions when their conditions are demonstrated; further
relaxations require concrete evidence and explicit approval.

## Commands

| Command                            | Purpose                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run quality`                  | Canonical non-modifying acceptance: clean build, checker preparation, scope/suppression policy, lint, formatting, compiler checks, tests with real-tool probes, and generated-doc/upstream-help checks |
| `npm run lint`                     | Policy checks followed by strict Oxlint over the complete maintained-code inventory                                                                                                                    |
| `npm run lint:agent`               | Identical coverage with Oxlint agent diagnostics                                                                                                                                                       |
| `npm run lint:fix`                 | Identical policy and coverage; apply ordinary safe Oxlint fixes                                                                                                                                        |
| `npm run format`                   | Format supported maintained files using Oxfmt                                                                                                                                                          |
| `npm run format:check`             | Check formatting without modifying files                                                                                                                                                               |
| `npm run quality:policy`           | Validate language coverage and parsed suppression comments; emit the current exception inventory                                                                                                       |
| `npm run quality:scope -- --write` | Regenerate the final exact unchecked-JavaScript override after an intentional scope/tool change                                                                                                        |
| `npm run quality:probes`           | Run the focused `node:test` real-CLI regression suite                                                                                                                                                  |
| `npm run quality:mutations`        | Require clean acceptance, then prove the real workflow rejects syntax, semantic, compiler, formatting, and allowance-isolation mutations in disposable copies                                          |

Review fixes before committing; dangerous fixes and suggestion fixes are not part of
`lint:fix`. Run formatting after reviewed lint fixes and rerun acceptance. Failures
are never converted to success by these commands.

The default, quality, pre-pr, platform-target, and release facades run scope and
suppression-policy validation once through `lint`, before the corrected checker.
Standalone `quality:policy` and `quality:scope` remain available for focused
inspection and intentional scope regeneration; running them separately in the
facade would repeat the same validation without adding coverage.

### Test scheduling

`npm test` builds once and prepares the corrected checker once, then runs
`tsx --test "test/**/!(*.serial).test.ts"` with Node's default file concurrency, followed by
`tsx --test --test-concurrency=1 "test/**/*.serial.test.ts"`.
The default/quality verification gates use the same two stages. File isolation
keeps environment patches process-local; the shared browser harness supplies a
private short socket directory unless `PI_AGENT_BROWSER_SOCKET_DIR` is already set.
The harness also clears inherited Pi/delegation identity variables; root-default
tests set their identities explicitly after import. No in-file concurrency is enabled.

The serial lane contains `test/agent-browser.startup.serial.test.ts` and
`test/agent-browser.prompt-policy.serial.test.ts` for wall-clock budgets, plus
`test/agent-browser.managed-session-policy-lock.serial.test.ts` for fixtures in
the shared policy collector directory. Their timing and global-GC contracts must
not compete with the parallel lane. Build/pack fixtures must use disposable source trees rather
than rewriting this checkout's `dist/` while other files consume it.
`platform-target` retains its explicit serial subset; `quality:probes` remains a
focused serial checker suite. The allowance-isolation mutation must fail in the
parallel stage with its named `code-quality.test.ts` diagnostic.

The real prepare/pack fixture in `test/verify-package.test.ts` also runs a plain
Node child against emitted checkout modules. It verifies shared process-environment
session/namespace propagation and snapshot-spill cleanup through the imported temp
owner; source-loaded tests cannot detect bundles overwriting these shared modules.

## Language and role scope

The root `.oxlintrc.json` enables type-aware rules and compiler diagnostics. The
canonical `tsconfig.json` includes maintained extension TypeScript, TypeScript
scripts, tests, and explicitly checked configuration-policy JavaScript; build configuration
continues to own emitted extension files.

`scripts/code-quality-policy.mjs` discovers maintained code and effective compiler
projects using the installed TypeScript CLI. It reads inherited settings with
`tsc --showConfig` and actual project/import membership with `tsc --listFilesOnly`.
Oxc's parser identifies genuine leading `@ts-check` comments without mistaking
strings or documentation for directives.

| Source                            | Syntactic lint | Semantic lint | Compiler | Formatting/tests |
| --------------------------------- | -------------- | ------------- | -------- | ---------------- |
| TypeScript                        | Yes            | Yes           | Yes      | Yes              |
| JS with effective `checkJs: true` | Yes            | Yes           | Yes      | Yes              |
| JS with leading `@ts-check`       | Yes            | Yes           | Yes      | Yes              |
| Other maintained JS               | Yes            | No            | No       | Yes              |

Unchecked JavaScript is **not ignored**. The final root override lists its exact
paths and disables only the installed metadata's type-dependent rules plus the
TypeScript-only module-boundary annotation requirement. It is generated explicitly,
not dynamically weakened during a lint run. The policy gate rejects drift in files,
projects, checking directives, metadata, or root lint inventory. Checked files must
be explicit compiler-project inputs: imported-only checked JS can otherwise fall
through Oxlint's compiler project assignment. Imported unchecked JS remains available for resolution
and its TypeScript consumers retain safety checks.

There are no extra lint-only JavaScript semantic opt-ins. Test role and language
scope are separate: unchecked JS tests keep ordinary lint and test checks without
accidentally inheriting type-dependent test rules. Production limits are complexity
10, depth 3, four parameters, 40 statements, 80 nonblank/noncomment function lines,
and 500 nonblank/noncomment file lines. Tests and verified `test/helpers` use
complexity 15, depth 4, six parameters, and no size/statement limits. Handwritten
declarations retain type/API checks without structural metrics.

## Responsibility and ownership changes

The major decompositions preserve the tool surface and lifecycle contracts; they
separate operations and owners rather than creating a new execution framework.

| Before                                                                                                                                                                                 | After and change locality                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` combined registration, prompt caching, command execution, branch replay, and browser/recording/Electron cleanup in one closure.                                             | The entrypoint composes registration. `extension-command-run.ts` makes preparation, durable admission, dispatch, reconciliation, and finish publication explicit. Prompt, artifacts, recording reservations, Electron resources, managed identities, page resources, branch generations, and in-flight code have distinct owners. `BrowserRuntime` is readonly composition, not an exempt mutable bag; leaf helpers receive operations, readonly views, or primitives. |
| Browser preparation and output mixed input guards, observations, native lifecycle state, artifact handling, and presentation.                                                          | `prepare.ts` orders focused validation and preparation. `process-output.ts` exposes native observation, page observation, lifecycle commit, and publication, with owned stdout-spool cleanup in `finally`. Readonly phase results carry evidence; only the existing command, page, restore, probe, and presentation owners receive exact mutation allowances.                                                                                                          |
| Presentation assembled diagnostics, artifact verification/images, notices, output compaction, and redaction together.                                                                  | `results/presentation.ts` retains the visible assembly order; diagnostic families and artifact verification, image handling, and compaction live at their respective boundaries. Mutable presentation identity is retained only at assembly operations; successful data still passes through redaction.                                                                                                                                                                |
| `runtime.ts` combined argv planning, identity/replay, launch compatibility, timeout rules, and credential redaction. Storage conversion combined decoding, streaming, and publication. | Planning remains pre-spawn and filesystem-free, with focused planning/replay/redaction modules and preserved exports. Journal read/replay/projection and legacy conversion are separate responsibilities; conversion still verifies the unchanged source before exclusive separate-copy publication and releases only its owned resources.                                                                                                                             |

Ordering, branch-generation guards, cancellation, append-failure behavior, native
argument presence, and cleanup ownership remain independent behavioral contracts.
The real-CLI probes also reject mutable additions to qualified owners and verify
that ordinary runtime records and parameter-property writes remain checked.

## Corrected checker and allowance integrity

The locked baseline is Oxlint **1.87.0**, `oxlint-tsgolint` **7.0.2003**, Oxfmt
**0.72.0**, TypeScript **7.0.2**, and `oxc-parser` **0.153.0**. Framework rules use
`eslint-node-test` **1.0.1** through Oxlint's supported JS-plugin mechanism; ESLint
is its required runtime API dependency, not another configured lint owner.

The original backend has reproduced file-safe-call origin and readonly
intersection/container defects. `scripts/prepare-quality-checker.mjs` builds the
pinned backend revision `eb9339115edde6811ca94c3433adf69ea9852880` and compiler
submodule `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`, applies
`patches/oxlint-tsgolint.patch`, and verifies the cached binary's fingerprint/hash.
It selects Go **1.27.1**. A clean install needs Git, Go, and network access for this
first build; no manual installed-package edits or install lifecycle hooks are needed.

All semantic lint goes through `scripts/oxlint.mjs`, which forces the verified
binary through upstream's `OXLINT_TSGOLINT_PATH`. CLI, probes, fixes, and the editor
must use this same launcher. The checked-in VS Code setting `oxc.path.oxlint` points
to `./scripts/oxlint.mjs`; the Oxc extension starts `.mjs` launchers with Node.
Keep Node 24.21.0+ available to the editor. Oxc normally resolves `node` from its
environment; an editor launched without that PATH can use its user-level
`oxc.path.node` setting to select the supported executable. Oxc 1.63+ also supports
`oxc.useExecPath: true` when the editor's bundled Node meets that floor. Do not
enable it blindly on an editor with an older bundled runtime.
For another editor, start the language server with `node scripts/oxlint.mjs --lsp`
using its documented executable mechanism. Do not substitute an independently
installed global Oxlint or the uncorrected raw backend. Root configuration is shared,
including JS scope and the actual Node test rules.

Oxlint 1.87's language server reports lint diagnostics but does not expose its CLI
compiler-diagnostic pass. Keep the editor's native TypeScript/JavaScript validation
enabled (the workspace settings do so), and retain `npm run typecheck` and the
canonical CLI as independent compiler gates. A successful lint-server handshake
does not establish compiler coverage. Oxlint 1.87 also does not merge unsaved
cross-file editor overlays into a dependent file's semantic project. Save referenced
files and reanalyze the dependent document; the canonical launcher diagnoses and
clears cross-module ownership at that save/re-pull boundary. This is an upstream
limitation shared by the unpatched backend, not a persistent native-checker cache.

`allowForKnownSafePromises` stays empty. The only safe-call registration group is
the declaration-qualified `node:test` package's `test`, `it`, `describe`, and `suite`.
Ordinary floating work, local shadows, and unrelated exports/packages retain
floating-Promise checking. The complete policy also requires owned native `t.test`
subtests; do not assume a diagnostic came from `no-floating-promises` when it came
from `node-test/no-unawaited-subtest`. `node-test/no-nested-tests` additionally rejects
imported test registration inside a test body; use an owned `t.test` subtest instead.
The repository uses direct imports, not custom registration reexports; requalify
framework scope before adopting a different registration pattern. Suite callbacks
receive an exemption only when their value uses establish exclusive native suite
ownership. Borrowing a native callable or namespace type does not establish native
value identity. Opaque module loading or native VM code execution withholds that
claim for exported callbacks, including when module resolution supplies only a
declaration or external-library target instead of maintained runtime code. The
Require analysis uses a precise target only for an explicit relative file operand
whose native resolved path equals the runtime operand; package conditions and
extension substitution remain opaque. The checker does not interpret code strings
or promise a runtime security boundary.

Native readonly allowances are declaration-qualified, not shape/name-only. They
accept the actual native contract, not mutable application additions or runtime
freezing. Generic `Map`, `Record`, `Readonly`, and callable shapes are not blanket
allowances. The correction checks native readonly map/set elements recursively
while preserving mutable-container and mutable-nested-value counterexamples.
Non-generic TS/JSDoc array aliases retain exact declared identity without introducing
wrapper types. Built-in browser `URL` and Node's `node:url` `URL` have distinct
origins; the filesystem `PathLike` contract requires the Node-qualified allowance.

The real-CLI probes are split by contract: `test/code-quality.test.ts` covers
framework diagnostics and qualified registration isolation;
`test/code-quality-scope.test.ts` covers language/compiler scope, consumer resolution,
test-role boundaries, suppression policy, and formatting idempotence;
`test/code-quality-subtests.test.ts` covers subtest promise ownership and nested
registration; `test/code-quality-readonly.test.ts` covers declaration isolation and
mutable additions/intersections. `npm run quality:probes` runs all four files. Probes
check expected rule identities; setup/configuration/parser failures are not valid
negative evidence. Keep minimal unsuppressed checker reproductions when upgrading
the backend and retire the patch only after the same controls pass.

## Semantic exceptions

Native directives must be exact, single-rule `oxlint-disable-next-line` comments
with a specific adjacent explanation. Supported semantic rules are:

- `no-await-in-loop`: journals, dependency ordering, retries, backpressure, locks,
  and ordered cleanup.
- `no-control-regex`: intentionally escaped field/protocol control-character
  validation.
- `typescript/no-unnecessary-condition`: necessary live lifecycle checks whose
  state can change during an awaited operation.
- `typescript/prefer-readonly-parameter-types`: reproduced plain generic callback
  false positives, never mutable callable properties.
- `node-test/no-conditional-assertion`, **only in tests/test helpers**: exhaustive
  variant validation or independently proven fail-closed narrowing.

An explanation is not semantic proof. Review the actual ownership/ordering/guard
contract and retain boundary tests, including interrupted and uninterrupted paths.
Do not suppress floating-Promise protection to compensate for a matcher defect.
Blanket disables, multi-rule disables, ESLint directives, `@ts-ignore`, and
`@ts-nocheck` are forbidden. Described `@ts-expect-error` is accepted only in
dedicated `*.test-d.ts` negative type tests with at least ten explanation characters.
Unused native disables remain errors.

The policy command prints current paths, locations, rules, and reasons for every
comment exception. Exact configuration exceptions are reviewable in root config:

`scripts/code-quality-boundaries.mjs` is the canonical inventory of exact local
declaration and mutation boundaries, including their reasons. `quality:scope -- --write`
generates their complete rule options immediately before the final JS override;
overlapping boundaries retain all allowed declarations and the entire strict native
baseline. Never hand-edit those generated overrides or turn generic maps/sets into
blanket allowances. The inventory covers diagnostics collectors, next-action
accumulators, replay fixtures, canonical runtime/resource owners, presentation
assembly, and the browser-run reducer—not arbitrary input records or read-only views.

Reviewed native-resource readonly exceptions remain single-site directives:
`browser-journal-projection.ts` receives its native async cursor in `projectJson`;
`browser-session-conversion-stream.ts` receives native async cursors in `writeBytes`
and `inject`; `recording-reservations.ts` deliberately mutates its existing index
only in `applyRecordingArtifactsToReservations` and `retireRecordingReservation`.
These contracts do not exempt generic `AsyncIterable` or `Map` inputs elsewhere.

The exact site-policy map in `code-quality-policy.mjs` additionally permits only
the reviewed native `promisify` callback contracts, sanitized secret-error propagation,
native cancellation reason identity, and the private numeric generation-token
constructor. Their unused directives remain errors and their actual locations and
reasons appear in the emitted inventory.

| Scope                                                                                                                                                                                                                            | Exception                                               | Contract/verification                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Tests and test-only helpers                                                                                                                                                                                                      | `no-useless-undefined.checkArguments: false`            | Preserve argument presence and negative input fixtures; other rule checks remain active         |
| `test/agent-browser.tool-surface.test.ts`, `test/verify-package.test.ts`, `test/doctor.test.ts`                                                                                                                                  | Additionally `checkArrowFunctionBody: false`            | Preserve required undefined-returning fixture callbacks                                         |
| `managed-session-policy-lock.ts`, `browser-execution-claims.ts`, `browser-execution-claim-storage.ts`, `temp-mutation-queue.ts`, `temp-artifact-budget.ts`, `temp-root-ownership.ts`, `temp-root.ts` under the extension library | `checkArrowFunctionBody: false` only                    | Required undefined-returning release/error callbacks; argument checking remains active          |
| `test/agent-browser.batch-fidelity.test.ts`, `test/agent-browser.native-lifecycle.test.mjs`                                                                                                                                      | `no-await-in-loop: off`                                 | Cohesive inherently ordered native lifecycle suites; original behavior tests retained           |
| `scripts/verify-recording-native.mjs`, `scripts/verify-agent-browser-dogfood.ts`                                                                                                                                                 | Exact test role, including `checkTypePredicates: false` | Actual nonpackaged assertion harnesses, not production helpers                                  |
| `tool-surface.ts`, `web-search.ts`, `orchestration/extension-tool-boundary.ts`, `config-validation.js`, `redaction-fields.ts` under the extension library                                                                        | `max-params: 5`                                         | Fixed SDK/public config/regex replacement callback arity; other production limits remain active |

## Formatting, generation, and CI

Oxfmt preserves the repository's tabs, LF endings, semicolons, and existing import
order. Optional sorting and JSDoc rewriting remain off. The package manager owns
`package-lock.json`; compiled output and task artifact directories are excluded.
Generator-owned documentation must converge with Oxfmt through its generator,
not by hand-editing generated blocks or ignoring maintained documents.

`.github/workflows/code-quality.yml` installs locked dependencies, the selected Go
toolchain, and the separately installed command-reference upstream target. It runs
the real acceptance and mutation controls without modifying maintained artifacts.
The release workflow requires this job before publishing. Existing official/fork
Pi qualification and lifecycle checks remain separate and are not replaced by
quality acceptance.

Classify findings accurately: scope/configuration reductions, checker-integrity
fixes, genuine source improvements, fixture corrections, and production runtime
bugs are different outcomes. Zero diagnostics is meaningful only with scope,
suppression, allowance, typecheck, test, build, generation, and formatting gates
all passing on the exact integrated revision. Major refactors also require review
of their resulting responsibilities, ownership, API surface, asynchronous phases,
and before/after change locality. Green checks do not substitute for that review.
