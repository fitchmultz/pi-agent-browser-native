/**
 * Purpose: Provide the canonical agent_browser operating playbook shared by runtime prompt metadata and generated documentation fragments.
 * Responsibilities: Define stable guidance bullets, native tool-call examples, and wrapper-behavior notes without importing runtime/browser process code.
 * Scope: Agent-facing documentation and prompt-guidance text only; command execution and wrapper state behavior live in runtime modules.
 * Usage: Imported by the extension entrypoint for promptGuidelines and by the documentation drift-check script for generated Markdown blocks.
 * Invariants/Assumptions: The native pi tool receives args after the agent-browser binary, stdin is only for batch/eval --stdin/auth save --password-stdin, and wrapper behavior documented here must match implemented behavior.
 */

export const PROJECT_RULE_PROMPT =
	"Project rule: when browser automation is needed, prefer the native `agent_browser` tool. Do not run direct `agent-browser` bash commands unless the user explicitly asks for a bash-oriented workflow or browser-integration debugging.";

export const TOOL_PROMPT_GUIDELINES_PREFIX = [
	"Use agent_browser whenever the task requires a real browser or live web content.",
] as const;

export const QUICK_START_GUIDELINES = [
	"Quick start mental model: use exactly one of args (exact agent-browser CLI args after the binary), semanticAction (a thin find-locator shorthand compiled to find argv), job (a constrained short-workflow schema compiled to batch), qa (a lightweight QA preset built on job/batch), or the experimental sourceLookup / networkSourceLookup helpers (each compiled to batch); stdin is only for batch, eval --stdin, auth save --password-stdin, and wrapper-generated batch stdin from job, qa, sourceLookup, or networkSourceLookup, and other command/stdin combinations are rejected before launch; sessionMode=fresh switches the extension-managed pi-scoped session to a fresh upstream launch when you need new --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device state.",
	"There is no first-class reusable named browser recipe runtime above top-level job, the qa preset, and raw batch stdin; keep recurring flows in documentation examples or those inputs (closed RQ-0068; see docs/ARCHITECTURE.md#no-reusable-recipe-layer-yet).",
	"Common first calls: { args: [\"open\", \"https://example.com\"] } then { args: [\"snapshot\", \"-i\"] }; after navigation, use { args: [\"click\", \"@e2\"] } then { args: [\"snapshot\", \"-i\"] }.",
	"Locator-first clicks and fills without hand-building find argv: { semanticAction: { action: \"click\", locator: \"text\", value: \"Close\" } } or { semanticAction: { action: \"fill\", locator: \"label\", value: \"Email\", text: \"user@example.com\" } }; add semanticAction.session when targeting a named upstream browser session; details.compiledSemanticAction shows the semantic target, while details.effectiveArgs may show a resolved current @ref for active-session role/name click/check/uncheck actions to avoid hidden duplicate matches; selector-not-found failures may append bounded try-*-candidate next actions (and an Agent-browser candidate fallbacks prose block) for specific placeholder/text/label shapes, and stale-ref failures can return retry-semantic-action-after-stale-ref when retry safety is provable.",
	"Common advanced calls: { args: [\"batch\"], stdin: \"[[\\\"open\\\",\\\"https://example.com\\\"],[\\\"snapshot\\\",\\\"-i\\\"]]\" }, { job: { steps: [{ action: \"open\", url: \"https://example.com\" }, { action: \"assertText\", text: \"Example Domain\" }, { action: \"screenshot\", path: \".dogfood/example.png\" }] } }, { qa: { url: \"https://example.com\", expectedText: \"Example Domain\", screenshotPath: \".dogfood/qa-example.png\" } }, { args: [\"eval\", \"--stdin\"], stdin: \"document.title\" }, { args: [\"auth\", \"save\", \"name\", \"--password-stdin\"], stdin: \"<password from user-approved secret source>\" }, { args: [\"--profile\", \"Default\", \"open\", \"https://example.com/account\"], sessionMode: \"fresh\" }, and { args: [\"open\", \"--enable\", \"react-devtools\", \"https://example.com\"], sessionMode: \"fresh\" }.",
	"High-value command reference: download <selector> <path> saves a file triggered by a click; get title/url/text/html/value/attr/count reads page state; screenshot [path] captures an image; pdf <path> saves a PDF; tab list and tab <tab-id-or-label> inspect or recover the active tab; react tree/inspect/renders/suspense introspect React after --enable react-devtools; vitals [url] measures Core Web Vitals; pushstate <url> performs SPA navigation.",
	"For artifact-producing commands, read the visible artifact block and details.artifactVerification before using files: check requested path, absolute path, existence, size bytes, artifact kind, optional mediaType, status, optional limitation, and verified/missing/pending/unverified counts. details.artifacts contains per-file metadata. Browser close does not delete explicit saved files; if close reports details.artifactCleanup, use host file tools to remove paths listed in explicitArtifactPaths (when non-empty) after inspection. For annotated screenshots inside batch, put --annotate in top-level args (for example { args: [\"--annotate\", \"batch\"], stdin: \"[[\\\"screenshot\\\",\\\"/tmp/page.png\\\"]]\" }) rather than inside the screenshot step.",
	"When details.nextActions is present, prefer those exact native agent_browser follow-up payloads over prose guidance; they may include args, stdin, sessionMode, safety notes, or artifactPath for saved files.",
] as const;

export const BRAVE_SEARCH_PROMPT_GUIDELINE =
	"When a non-empty BRAVE_API_KEY is available in the current environment, prefer the Brave Search API via bash/curl to discover specific destination URLs, then open the chosen URL with agent_browser instead of browsing a search engine results page just to find the target.";

export const SHARED_BROWSER_PLAYBOOK_GUIDELINES = [
	"Standard workflow: open the page, snapshot -i, interact using current @refs from that snapshot, and re-snapshot after navigation, scrolling, rerendering, or other major DOM changes because refs are page-scoped; the wrapper fails mutation-prone stale/recycled refs before upstream can silently target a different current-page element.",
	"When snapshot -i compacts because the tree is oversized, scan visible output for Omitted high-value controls and optional details.data.highValueControlRefIds before opening the spill file: those list bounded searchboxes, textboxes, comboboxes, buttons, tabs, checkboxes, radios, options, and menuitems that did not fit the key/other ref previews.",
	"When a visible text or accessible-name target should survive ref churn, prefer find locators such as role, text, label, placeholder, alt, title, or testid with the intended action instead of guessing a CSS selector.",
	"Do not assume Playwright selector dialects such as text=Close or button:has-text('Close') are supported wrapper syntax unless current upstream agent-browser behavior has been verified.",
	"For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.",
	"Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.",
	"When using --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.",
	"If you already used the implicit session and now need launch-scoped flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device, retry with sessionMode set to fresh or pass an explicit --session for the new launch. After a successful unnamed fresh launch, later auto calls follow that new session.",
	"For React introspection, launch the page with --enable react-devtools before first navigation, then use react tree, react inspect <fiberId>, sourceLookup candidates for local UI source hints, react renders start/stop, or react suspense; sourceLookup is experimental and reports confidence/evidence instead of guaranteed DOM-to-file mappings. For failed fetches and APIs, networkSourceLookup (experimental) correlates failed network requests with initiator metadata and bounded workspace URL literals—candidates only, not definitive blame. Use vitals [url] for Core Web Vitals and hydration timing, and pushstate <url> for client-side SPA navigation.",
	"For first-navigation setup, use open without a URL plus network route --resource-type <csv>, cookies set --curl <file>, or --init-script/--enable before navigate/opening the target page.",
	"For stateful browser context work, prefer purpose-specific page actions before dumping browser data: use auth save --password-stdin with the tool stdin field for credentials, state save/load for portable test state, cookies get/set/clear and storage local|session only when the task needs those values, and expect cookie/storage/auth/state summaries to redact credential-like fields.",
	"For batch chains that touch cookies, storage, auth, or other secret-bearing commands, use details.batchSteps for per-step artifacts, categories, spill paths, and full structured errors; top-level details.data on batch is only a compact redacted step matrix (success, argv-redacted command, redacted result or scrubbed error text) built from the same presentation rules as standalone calls.",
	"For non-core families, pass current upstream commands through the native tool directly: network route/requests/har, diff snapshot/screenshot/url, trace/profiler/record, console/errors/highlight/inspect/clipboard, stream enable/disable/status, dashboard start/stop, and chat. Artifact-producing commands report details.artifacts and verification state; long-running starts such as stream, dashboard, trace/profiler, and record should be paired with the matching stop/disable command when the task is done.",
	"For provider or specialized app workflows, load version-matched upstream guidance with skills get agentcore|electron|slack|dogfood|vercel-sandbox through the native tool. Provider launches such as -p ios, --provider browserbase/kernel/browseruse/browserless/agentcore, and iOS --device are upstream-owned setup paths; use sessionMode fresh when switching providers and expect external credentials or local Appium/Xcode setup to be required.",
	"For dialogs and frames, use dialog status/accept/dismiss and frame <selector|main> through native args; when --confirm-actions produces a pending confirmation, use details.nextActions or exact confirm <id> / deny <id> calls instead of inventing ids.",
	"If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <tab-id-or-label> / snapshot -i to recover state before retrying different URLs or fallback strategies. Only use wait with an explicit argument like milliseconds, --load <state>, --url <matcher>, --fn <js>, or --text <matcher>.",
	"For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.",
	"For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.",
	"For downloads, prefer download <selector> <path> when an element click should save a file. Do not rely on click alone when you need the downloaded file on disk.",
	"When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.",
	"When using eval --stdin for extraction, return the value you want instead of relying on console.log as the primary result channel. Prefer plain expressions like ({ title: document.title }) or explicitly invoked functions like (() => ({ title: document.title }))(); if a function-shaped snippet returns {}, details.evalStdinHint may warn that the function was serialized instead of called. If get text on a CSS selector surfaces details.selectorTextVisibility or selectorTextVisibilityAll, prefer a visible @ref, a more specific selector, or the inspect-visible-text-candidates nextAction over hidden tab content.",
	"When details.pageChangeSummary is present, use changeType and summary as a compact signal for navigation, DOM mutation, confirmations, or artifacts; when nextActionIds is set, match those ids to entries in details.nextActions (or per-step nextActions inside batch) for concrete follow-up payloads instead of inferring from prose alone. If a no-navigation click surfaces details.overlayBlockers, inspect the fresh snapshot evidence before using a close/dismiss candidate nextAction; ordinary page chrome without dialog/alertdialog evidence should not trigger this diagnostic.",
	"When commands save or spill files (screenshots, downloads, PDFs, traces, recordings, HAR, large snapshot spills), treat paths as provisional until details.artifactVerification shows every row verified: branch on missingCount, pendingCount, unverifiedCount, per-entry state, and optional limitation before downstream file use.",
	"Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.",
] as const;

export const TOOL_PROMPT_GUIDELINES_SUFFIX = [
	"Prefer agent_browser over bash for opening sites, reading docs on the web, clicking, filling, screenshots, eval, and batch workflows.",
	"Do not fall back to osascript, AppleScript, or generic browser-driving bash commands when agent_browser can do the job.",
	"Pass exact agent-browser CLI arguments in args when you are not using semanticAction, job, or qa, excluding the binary name.",
	"Use stdin only for eval --stdin, batch, auth save --password-stdin, or wrapper-generated job/qa batches instead of shell heredocs or password args; other command/stdin combinations are rejected before launch.",
	"Let the extension-managed session handle the common path unless you explicitly need a fresh launch for upstream flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device.",
	"Use sessionMode=fresh when switching from an existing implicit session to a new profile/debug/init-script/provider launch without inventing a fixed explicit session name; later auto calls will follow that new session.",
] as const;

export const INSPECTION_TOOL_CALL_EXAMPLES = [
	'{ "args": ["--help"] }',
	'{ "args": ["--version"] }',
] as const;

export const WRAPPER_TAB_RECOVERY_BEHAVIOR = [
	"After launch-scoped open/goto/navigate calls that can restore existing tabs (for example --profile, --session-name, or --state), agent_browser best-effort re-selects the tab whose URL matches the returned page when restored tabs steal focus during launch.",
	"After a target tab is known for a session, later active-tab commands best-effort pin that tab inside the same upstream invocation when reconnect drift would otherwise move the command to a restored/background tab.",
	"After a successful command on a known target tab, agent_browser also best-effort restores that intended tab if a restored/background tab steals focus after the command completes.",
	"If a known session target unexpectedly reports about:blank, agent_browser preserves the prior intended target, best-effort re-selects it when it still exists, and reports exact recovery guidance when it cannot be re-selected.",
] as const;

export function buildSharedBrowserPlaybookGuidelines(options: { includeBraveSearch: boolean }): string[] {
	return [
		SHARED_BROWSER_PLAYBOOK_GUIDELINES[0],
		...(options.includeBraveSearch ? [BRAVE_SEARCH_PROMPT_GUIDELINE] : []),
		...SHARED_BROWSER_PLAYBOOK_GUIDELINES.slice(1),
	];
}

export function buildToolPromptGuidelines(options: { includeBraveSearch: boolean }): string[] {
	return [
		...TOOL_PROMPT_GUIDELINES_PREFIX,
		...QUICK_START_GUIDELINES,
		...buildSharedBrowserPlaybookGuidelines(options),
		...TOOL_PROMPT_GUIDELINES_SUFFIX,
	];
}
