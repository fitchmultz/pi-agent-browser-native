# Code quality

The [Strict Oxlint/Oxfmt Engineering Guide v5.2](https://github.com/fitchmultz/pi-agent-browser-native/blob/main/docs/Strict-Oxlint-Oxfmt-Engineering-Guide.md)
owns the engineering standard. Oxlint owns linting, Oxfmt owns supported formatting,
and the compiler, tests, build, and generated-document checks remain independent gates.
Use the Node and npm versions in `package.json` and install with `npm ci --ignore-scripts`.

## Commands

| Command                     | Purpose                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run quality`           | Clean build, scope policy, lint, format check, compiler projects, ordinary tests, generated docs, and live upstream help checks |
| `npm run lint`              | Scope policy and native Oxlint over every maintained JS and TS file                                                             |
| `npm run lint:agent`        | The same coverage with agent diagnostics                                                                                        |
| `npm run lint:fix`          | The same coverage with ordinary safe native fixes                                                                               |
| `npm run format`            | Format maintained files with Oxfmt                                                                                              |
| `npm run format:check`      | Check formatting without writes                                                                                                 |
| `npm run quality:scope`     | Check effective compiler membership, configuration, native file selection, and directives                                       |
| `npm run quality:policy`    | Run the same policy check                                                                                                       |
| `npm run quality:probes`    | Run the focused checker contracts serially                                                                                      |
| `npm run quality:mutations` | Run clean acceptance, then require the actual workflow to reject isolated mutations                                             |

Review autofixes before committing. Dangerous fixes and suggestion fixes are not part
of `lint:fix`. Scope commands validate configuration without regenerating or weakening it.
The aggregate checks preserve failed exit status even when another stage passes.
Native browser, package-consumer, official/fork host, and platform qualification remain
separate delivery checks documented in [RELEASE.md](RELEASE.md).

## Checked scope

All maintained TypeScript and JavaScript receive syntactic lint, semantic lint,
compiler checking, and formatting. `tsconfig.json` enables `allowJs` and `checkJs`
and includes extension code, scripts, and tests. `tsconfig.build.json` owns emitted
extension files. `tsconfig.declarations.json` checks handwritten declarations with
`skipLibCheck: false`.

`scripts/code-quality-policy.mjs` compares the root configuration against Appendix A
of the adopted guide plus explicit repository mappings. It obtains effective compiler
options through `tsc --showConfig`, membership through `tsc --listFilesOnly`, and native
lint selection through `oxlint --debug=files`. Git-tracked and untracked maintained
sources must agree with that selection. Git ignores cannot hide maintained files.

The repository mappings are:

- Add the native `node` plugin and the `eslint-node-test` JS plugin.
- Apply the guide's test profile to `test/helpers` and the two assertion programs
  `scripts/verify-recording-native.mjs` and `scripts/verify-agent-browser-dogfood.ts`.
- Apply QX-001 only in that test profile.
- Exclude installed dependencies, compiled output, and task/provider artifacts in
  `node_modules`, `dist`, `.artifacts`, `.crabbox`, and `.cueloop`.
- Keep the repository's tabs in Oxfmt. The package manager owns `package-lock.json`.

Production limits are complexity 10, depth 3, four parameters, 40 statements,
80 nonblank/noncomment function lines, and 500 nonblank/noncomment file lines.
The guide's test profile uses complexity 15, depth 4, six parameters, and no
function/file-size or statement limits. Actual Node test rules require assertions,
reject conditional assertions and imported nested registrations, and require owned
subtests and rejection assertions.

## Native checker and editor

The locked versions are Oxlint 1.91.0, oxlint-tsgolint 7.0.2005, Oxfmt 0.76.0,
TypeScript 7.0.2, oxc-parser 0.157.0, and eslint-node-test 1.0.1. `package.json` and
`package-lock.json` are the version authorities. The policy check verifies installed
quality packages against their declared versions.

`scripts/oxlint.mjs` launches the installed published checker. It removes inherited
backend-path and compiler-diagnostic-suppression environment overrides and forwards
the native process verdict. The CLI and editor share this launcher and root config.
The VS Code `oxc.path.oxlint` setting selects `./scripts/oxlint.mjs`. Other editors
can start the server with `node scripts/oxlint.mjs --lsp`. Keep a supported Node on
the editor's PATH and keep its TypeScript/JavaScript validation enabled.

CLI compiler checks remain required. A language-server handshake alone does not
prove compiler diagnostics or cross-file unsaved-overlay behavior.

## Quality exceptions

The guide's section 2 governs eligibility and review. An identifier alone does not
justify an exception. Each decision below compares the imposed contract with a
reasonable alternative and retains neighboring checks. Reassess a decision when
its dependency contract or native rule changes.

### QX-001: Native Node test registration

`typescript/no-floating-promises` permits only the `node:test` package's `nodeTest`
callable in the test profile. Repository tests import the native test function under
that name. `allowForKnownSafePromises` remains empty.

Native registration returns a Promise but Node owns its scheduling and failures.
Awaiting a top-level registration can run it before later module-level hooks are
registered. `test/code-quality.test.ts` demonstrates this with an actual Node test
process: unawaited registration sees the module hook, while awaiting it fails the
same assertion. A wrapper or discarded Promise adds no ownership.

The native origin controls accept default and named native imports, reject local
and foreign same-name functions, reject a wrong package allowance, and retain
floating-body checks. `test/code-quality-subtests.test.ts` verifies that context
subtests and their bound callbacks are still awaited. The loss is floating-Promise
reporting for this native registration only; Node's runner and the Node test plugin
own its execution and test-body safety.

### QX-002: Pi's five-position execute contract

Oxlint's `max-params` limit is four. Pi's `ToolDefinition.execute` accepts
`toolCallId`, `params`, `signal`, `onUpdate`, and `ctx` in that order. The browser
callbacks use the fifth position for session, branch, cwd, and trust behavior or
forward it to the owner that does.

The authoritative contracts are official Pi [v1.5.0 types.ts, lines 670–676](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/extensions/types.ts#L670-L676)
and fork [e6c04cb types.ts, lines 735–741](https://github.com/fitchmultz/pi/blob/e6c04cb27845611fb0be62652b7e03e2fc4caf74/packages/coding-agent/src/core/extensions/types.ts#L735-L741).
Internal execution uses invocation objects; registration retains the native ABI.

Replacing the callback with an options object changes what Pi calls. Removing the
fourth argument puts `onUpdate` where `ctx` is expected. A sound rest-tuple spelling
can clear the metric without improving the contract:

```ts
const execute: AgentBrowserExecutor = async (...[id, params, signal, onUpdate, ctx]) =>
	finalizeAgentBrowserNativeResult(
		await options.execute(id, params, signal, onUpdate, ctx),
		params,
	);
```

That spelling hides the same five-position operation. A forwarding adapter still
needs that operation and adds another call boundary. The direct named parameters
are clearer and retain contextual SDK typing.

The standalone `WebSearchTool.execute` accepts optional signal, update, and a small
cwd/trust context. Replacing it with the full SDK callback type would narrow its
standalone callers. Its type and implementation retain the compatible five positions.

`scripts/quality-exceptions.mjs` enumerates these operations:

| File under `extensions/agent-browser/lib/` | Authorized operation                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-surface.ts`                          | `registerActionTool`, `registerQaTool`, and `registerElectronTool` execute; `registerSourceTools` source and network execute; `registerAgentBrowserToolSurface` execute variable |
| `orchestration/extension-tool-boundary.ts` | `registerBrowserTools` execute                                                                                                                                                   |
| `web-search.ts`                            | `WebSearchTool.execute` type and `createAgentBrowserWebSearchTool` execute                                                                                                       |

Each directive suppresses only `max-params` on that operation. The parser checks
its enclosing declaration, registration schema or property identity, direct
next-line attachment, and exactly five parameters. A sixth parameter is rejected.
Compiler checks retain the parameter and return relationships. All other functions
retain their profile's parameter limit.

### QX-003: Pi's additive prompt section

Pi explicitly exposes mutable `before_agent_start.systemPromptOptions`. The browser
sets only `sections.agent_browser`. Later handlers and Pi's prompt-delta machinery
observe the same options object.

Official [runner.ts, lines 1427–1476](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/extensions/runner.ts#L1427-L1476)
and fork [runner.ts, lines 1684–1733](https://github.com/fitchmultz/pi/blob/e6c04cb27845611fb0be62652b7e03e2fc4caf74/packages/coding-agent/src/core/extensions/runner.ts#L1684-L1733)
implement this composition. Pi's `prompt-customizer.ts` example uses the same direct
assignment. The hook's return type offers a message or a complete prompt replacement,
not an additive section.

The return-value alternative is:

```ts
return { systemPrompt: `${event.systemPrompt}\n\n${this.instructions(ctx)}` };
```

It forces the complete prompt instead of a named section, changing prompt replay,
cache behavior, and composition with later handlers. Mutating a copied event is
invisible to Pi. `Object.assign`, an alias, or reflection merely hides the same mutation.

One next-line `no-param-reassign` directive is authorized for
`BrowserPrompt.register`'s `before_agent_start` callback assigning
`event.systemPromptOptions.sections.agent_browser`. The parser checks that assignment
and event registration. Other properties, callbacks, and mutation rules remain checked.
Prompt composition and managed/unmanaged instruction behavior retain their runtime tests.

### QX-004: Credential command redaction

`resolveCommandCredential` returns a content-free error after a failed secret-manager
command. Node's promisified `exec` attaches `stdout` and `stderr` to its rejection,
and the native command failure includes the command. See Node's
[`customPromiseExecFunction`](https://github.com/nodejs/node/blob/v24.22.1/lib/child_process.js#L241-L253).
The original error must not remain reachable through the returned error.

The ordinary `preserve-caught-error` fix is:

```ts
throw new Error("Credential command failed.", { cause: error });
```

That retains secrets in the cause even when the outer message is safe. Rebuilding
a sanitized cause adds an error object without preserving useful native identity.
Moving the throw outside the catch merely hides the same intentional discard.
The cancellation branch still rethrows its original error.

One `eslint/preserve-caught-error` directive applies to the final throw in
`config.ts`'s `resolveCommandCredential` catch. The parser requires a direct
`new Error` with one literal message, not an arbitrary thrown expression.
`test/agent-browser.config.test.ts` runs an actual failing credential command and
checks the error, cause, and hidden-property inspection for leaked output or paths.
Other catches retain cause checking.

### QX-005: Live cancellation after preparation

`AbortSignal.aborted` is a live getter, not a frozen Boolean. Node reads its current
state in [`AbortSignal`](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/abort_controller.js#L260-L283).
Native semantic lint retains the earlier `false` narrowing across an awaited
operation and reports subsequent cancellation checks as always false.

The process boundary returns a `ProcessRunResult` for cancellation. Electron
attachment verification returns `false` rather than granting daemon provenance.
Replacing the checks directly with `signal?.throwIfAborted()` rejects these calls
instead. Preserving those contracts with that API requires exception translation:

```ts
try {
	signal?.throwIfAborted();
} catch {
	return cancelledResult();
}
```

This adds exception control flow to a Boolean decision and catches failures of the
method call as well as cancellation. A listener-owned Boolean adds registration,
cleanup, and another copy of native state. An alias or coercion only hides the
check. Direct reads retain the existing cancellation boundary.

The operation inventory contains three `typescript/no-unnecessary-condition` sites:

| File under `extensions/agent-browser/lib/`                   | Authorized operation                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `process.ts`                                                 | `runAgentBrowserProcess`, immediately after `prepared` filesystem validation        |
| `process.ts`                                                 | `runAgentBrowserProcess`, immediately after `stockLauncher` resolution              |
| `orchestration/browser-run/managed-session-daemon-policy.ts` | `verifyRestoredElectronAttachment`, immediately after the awaited `connection` read |

The first process check preserves cancellation before validation-error reporting.
The second retains the pre-spawn check after launch preparation. The Electron
check prevents a cancelled CDP read from establishing attachment provenance.
The parser requires the direct `signal && signal.aborted` guard in each location,
with a single return in its body. Additional conditions and same-line body checks
are rejected. All other conditions retain semantic lint.

Process tests cover cancellation before invocation and during filesystem
validation, along with child reaping and listener cleanup. Electron branch tests
abort an active CDP read and check the returned failure and child termination.
These tests use native child processes and local fixtures, not an installed
Electron desktop application.

### Directive enforcement

Only the enumerated QX-002 through QX-005 next-line directives are accepted. Each has one
rule, its decision identifier, and an adjacent reason. The parser reads actual comments,
not matching strings. `sourcePolicy` returns file, location, rule, reason, decision,
and operation for review. The CLI reports the inventory total.

`test/code-quality-scope.test.ts` exercises accepted sites, copies to another file,
same-count moves to a different operation, duplicate directives, unknown identifiers,
range disables, and excess SDK parameters. Native lint checks actual attachment and
unused directives. Blanket disables, ESLint directives, `@ts-ignore`, and `@ts-nocheck`
are forbidden. Described `@ts-expect-error` is limited to `*.test-d.ts` negative type
tests, and the compiler rejects unused expected errors.

## Test scheduling

`npm test` builds once, then runs
`tsx --test "test/**/!(*.serial).test.ts"` with Node's default file concurrency, followed
by `tsx --test --test-concurrency=1 "test/**/*.serial.test.ts"`. Quality uses the same
stages. No in-file concurrency is enabled.

The shared browser harness uses a process-private short socket directory unless
`PI_AGENT_BROWSER_SOCKET_DIR` is set. It clears inherited Pi/delegation identities;
root-default tests set them explicitly. Each file worker keeps its default Pi ID
across its reload/resume instances. Windows coordination uses namespace/session
identity, so independent Windows fixtures also need distinct identities.

Serial tests own startup/prompt wall-clock budgets and shared policy-directory or
default-namespace contention. Garbage-collection cases use private directories or
live claims because other processes may sweep proven-dead shared artifacts. An
awaited context subtest also runs Node's inherited cleanup hooks; a live claim must
not cross a subtest that releases it. Build/pack fixtures use disposable source trees,
not this checkout's `dist/` while another test consumes it.

## State ownership and verification

`BrowserRuntime` composes the actual branch, resource, prompt, artifact, and execution
owners. `CapturedBrowserBranch` keeps branch identity through an invocation.
`BrowserRunState` owns mutable command-phase state. Legacy conversion allocates its
own state before streaming and publication. Readonly views describe borrowed data;
mutable state stays with the allocating owner.

Refactors preserve argument presence, error identity, ordering, cancellation,
append-failure handling, branch-generation checks, and cleanup ownership. Fixture
repairs preserve assertions and native opt-in coverage. A skipped platform test is
not native evidence.

The recording-warning repair is a behavior change: `extension-recording.ts` adds the
persistence warning to `details.warnings` so canonical rendering retains it. Its
observation regression is separate from type and lint repairs.

## Formatting and CI

Oxfmt owns tabs, LF endings, semicolons, and existing import order. Optional import
sorting and JSDoc rewriting remain off. Generated docs converge through their
producer rather than through ignored files or hand edits to generated blocks.

`.github/workflows/code-quality.yml` installs locked dependencies and the separately
installed upstream browser target, then runs real acceptance and mutation controls.
It checks that verification leaves maintained artifacts unchanged. The release workflow
requires quality alongside the separate host and platform checks.

A clean lint result is one result, not delivery. Acceptance also requires scope,
compiler projects, formatting, tests, build, generated docs, required runtime checks,
and review of the resulting responsibilities and contracts.
