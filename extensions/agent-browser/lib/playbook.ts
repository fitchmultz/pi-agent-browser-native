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
	"Quick start mental model: use either args (exact agent-browser CLI args after the binary) or semanticAction (a thin find-locator shorthand compiled to find argv); stdin is only for batch, eval --stdin, and auth save --password-stdin, and other command/stdin combinations are rejected before launch; sessionMode=fresh switches the extension-managed pi-scoped session to a fresh upstream launch when you need new --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable state.",
	"Common first calls: { args: [\"open\", \"https://example.com\"] } then { args: [\"snapshot\", \"-i\"] }; after navigation, use { args: [\"click\", \"@e2\"] } then { args: [\"snapshot\", \"-i\"] }.",
	"Locator-first clicks and fills without hand-building find argv: { semanticAction: { action: \"click\", locator: \"text\", value: \"Close\" } } or { semanticAction: { action: \"fill\", locator: \"label\", value: \"Email\", text: \"user@example.com\" } }; details.compiledSemanticAction shows the derived find command, and stale-ref failures for compiled semantic targets can return a retry-semantic-action-after-stale-ref next action when retry safety is provable.",
	"Common advanced calls: { args: [\"batch\"], stdin: \"[[\\\"open\\\",\\\"https://example.com\\\"],[\\\"snapshot\\\",\\\"-i\\\"]]\" }, { args: [\"eval\", \"--stdin\"], stdin: \"document.title\" }, { args: [\"auth\", \"save\", \"name\", \"--password-stdin\"], stdin: \"<password from user-approved secret source>\" }, { args: [\"--profile\", \"Default\", \"open\", \"https://example.com/account\"], sessionMode: \"fresh\" }, and { args: [\"open\", \"--enable\", \"react-devtools\", \"https://example.com\"], sessionMode: \"fresh\" }.",
	"High-value command reference: download <selector> <path> saves a file triggered by a click; get title/url/text/html/value/attr/count reads page state; screenshot [path] captures an image; pdf <path> saves a PDF; tab list and tab <tab-id-or-label> inspect or recover the active tab; react tree/inspect/renders/suspense introspect React after --enable react-devtools; vitals [url] measures Core Web Vitals; pushstate <url> performs SPA navigation.",
	"For artifact-producing commands, read the visible artifact block for requested path, absolute path, existence, size, type, cwd, and session; details.artifacts contains the same machine-readable metadata. For annotated screenshots inside batch, put --annotate in top-level args (for example { args: [\"--annotate\", \"batch\"], stdin: \"[[\\\"screenshot\\\",\\\"/tmp/page.png\\\"]]\" }) rather than inside the screenshot step.",
	"When details.nextActions is present, prefer those exact native agent_browser follow-up payloads over prose guidance; they may include args, stdin, sessionMode, safety notes, or artifactPath for saved files.",
] as const;

export const BRAVE_SEARCH_PROMPT_GUIDELINE =
	"When a non-empty BRAVE_API_KEY is available in the current environment, prefer the Brave Search API via bash/curl to discover specific destination URLs, then open the chosen URL with agent_browser instead of browsing a search engine results page just to find the target.";

export const SHARED_BROWSER_PLAYBOOK_GUIDELINES = [
	"Standard workflow: open the page, snapshot -i, interact using current @refs from that snapshot, and re-snapshot after navigation, scrolling, rerendering, or other major DOM changes because refs can become stale.",
	"When a visible text or accessible-name target should survive ref churn, prefer find locators such as role, text, label, placeholder, alt, title, or testid with the intended action instead of guessing a CSS selector.",
	"Do not assume Playwright selector dialects such as text=Close or button:has-text('Close') are supported wrapper syntax unless current upstream agent-browser behavior has been verified.",
	"For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.",
	"Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.",
	"When using --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.",
	"If you already used the implicit session and now need launch-scoped flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable, retry with sessionMode set to fresh or pass an explicit --session for the new launch. After a successful unnamed fresh launch, later auto calls follow that new session.",
	"For React introspection, launch the page with --enable react-devtools before first navigation, then use react tree, react inspect <fiberId>, react renders start/stop, or react suspense; use vitals [url] for Core Web Vitals and hydration timing, and pushstate <url> for client-side SPA navigation.",
	"For first-navigation setup, use open without a URL plus network route --resource-type <csv>, cookies set --curl <file>, or --init-script/--enable before navigate/opening the target page.",
	"If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <tab-id-or-label> / snapshot -i to recover state before retrying different URLs or fallback strategies. Only use wait with an explicit argument like milliseconds, --load <state>, --url <matcher>, --fn <js>, or --text <matcher>.",
	"For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.",
	"For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.",
	"For downloads, prefer download <selector> <path> when an element click should save a file. Do not rely on click alone when you need the downloaded file on disk.",
	"When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.",
	"When using eval --stdin for extraction, return the value you want instead of relying on console.log as the primary result channel.",
	"When details.pageChangeSummary is present, use changeType and summary as a compact signal for navigation, DOM mutation, confirmations, or artifacts; when nextActionIds is set, match those ids to entries in details.nextActions (or per-step nextActions inside batch) for concrete follow-up payloads instead of inferring from prose alone.",
	"Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.",
] as const;

export const TOOL_PROMPT_GUIDELINES_SUFFIX = [
	"Prefer agent_browser over bash for opening sites, reading docs on the web, clicking, filling, screenshots, eval, and batch workflows.",
	"Do not fall back to osascript, AppleScript, or generic browser-driving bash commands when agent_browser can do the job.",
	"Pass exact agent-browser CLI arguments in args when you are not using semanticAction, excluding the binary name.",
	"Use stdin only for eval --stdin, batch, and auth save --password-stdin instead of shell heredocs or password args; other command/stdin combinations are rejected before launch.",
	"Let the extension-managed session handle the common path unless you explicitly need a fresh launch for upstream flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable.",
	"Use sessionMode=fresh when switching from an existing implicit session to a new profile/debug/init-script launch without inventing a fixed explicit session name; later auto calls will follow that new session.",
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
