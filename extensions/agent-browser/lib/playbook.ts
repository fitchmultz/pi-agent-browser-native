import type { BrowserDefaultProfilePolicy } from "./config.js";

/** Always-on orientation. Detailed command and result contracts stay in the installed docs. */
export const BROWSER_GUIDANCE = [
	"Use agent_browser, not bash, for agent-browser. One native command per call: { args, stdin?, outputPath?, timeoutMs?, sessionMode? }. Workflow: open <url>, snapshot -i, act on current @refs, re-snapshot after navigation or DOM changes. Use batch --bail with JSON-array stdin for a fixed sequence, and codemode scripts (tools.agent_browser) for loops, branches, and aggregation.",
	"Bare calls share one browser within your root Pi group; sessionMode:fresh launches a separate managed browser. Native args, profiles, auth, providers, engines, launch flags, paths, config, and environment pass through. Verify authentication after a restart; never close an unrelated browser.",
	"Follow details.nextActions when present. Treat pending confirmations and outcome_unknown as inspection boundaries, not retries. Check details.artifactVerification before reporting a saved screenshot, download, or recording. Screenshot pixels are not CSS coordinates: use imageObservations geometry, prefer refs, and use vision only when the task needs it.",
	"Use read <url> for page text; get title/url/text/html/attr for targeted state; eval --stdin with the script in stdin, returning the value. Do not drive public search-engine forms for discovery: headless runs get redirected to CAPTCHA pages; open known URLs directly.",
	"Ordinary non-destructive submissions in the requested flow may proceed in unattended or auto-approved contexts; purchases, production changes, destructive actions, and account, security, or privacy changes need explicit authorization.",
	"Deferred tools: agent_browser_action (click/fill/select by locator), agent_browser_qa (page verdict), agent_browser_electron (owned desktop apps), agent_browser_source and agent_browser_network_source (experimental source candidates). Find them with tool_search or call them from codemode scripts.",
] as const;

/** Added only while the credential-gated web search tool is registered. */
export const WEB_SEARCH_GUIDANCE =
	"Use agent_browser_web_search for live discovery and current facts before opening a target URL with agent_browser; pass searchType deep-lite for research before implementation. Cite result URLs when web evidence informed the answer.";

export function buildInstalledDocsGuideline(paths: {
	readonly readmePath: string;
	readonly commandReferencePath: string;
	readonly toolContractPath: string;
}): string {
	return `Details on demand: ${paths.readmePath} (setup), ${paths.commandReferencePath} (commands), ${paths.toolContractPath} (results and details). Read targeted sections, not whole files.`;
}

/** Config values bootstrap only the inactive automatic root Chrome launch; other launches pass the flag. */
export function buildBrowserExecutablePathGuideline(
	executablePath: string | undefined,
): string | undefined {
	if (executablePath === undefined || executablePath.length === 0) {
		return undefined;
	}
	return `agent_browser config sets browser.executablePath to ${JSON.stringify(executablePath)}. It bootstraps only the automatic root Chrome launch; sessionMode:fresh, explicit --session, and non-Chrome engines take --executable-path ${JSON.stringify(executablePath)} on their first command.`;
}

export function buildBrowserDefaultProfileGuideline(
	profile: { readonly name: string; readonly policy: BrowserDefaultProfilePolicy } | undefined,
): string | undefined {
	if (!profile || profile.policy === "explicit-only") {
		return undefined;
	}
	const flag = `--profile ${JSON.stringify(profile.name)}`;
	if (profile.policy === "always") {
		return `agent_browser config sets browser.defaultProfile.name to ${JSON.stringify(profile.name)} with policy always. It bootstraps only the automatic root Chrome launch; sessionMode:fresh, explicit --session, and non-Chrome engines take ${flag} on their first command. Verify actual app auth after a restart; profile content is model-visible user data.`;
	}
	return `agent_browser config sets browser.defaultProfile.name to ${JSON.stringify(profile.name)}; for signed-in tasks, reuse a configured native shared session with bare calls, otherwise start with ${flag} plus sessionMode:fresh unless the user asks for a different profile.`;
}

export function buildToolPromptGuidelines(options: {
	readonly browserDefaultProfile?:
		| {
				readonly name: string;
				readonly policy: BrowserDefaultProfilePolicy;
		  }
		| undefined;
	readonly browserExecutablePath?: string | undefined;
	readonly includeWebSearch?: boolean;
	readonly docs?: {
		readonly readmePath: string;
		readonly commandReferencePath: string;
		readonly toolContractPath: string;
	};
}): string[] {
	const browserDefaultProfileGuideline = buildBrowserDefaultProfileGuideline(
		options.browserDefaultProfile,
	);
	const browserExecutablePathGuideline = buildBrowserExecutablePathGuideline(
		options.browserExecutablePath,
	);
	return [
		...BROWSER_GUIDANCE,
		...(options.includeWebSearch === true ? [WEB_SEARCH_GUIDANCE] : []),
		...(options.docs ? [buildInstalledDocsGuideline(options.docs)] : []),
		...(browserExecutablePathGuideline !== undefined ? [browserExecutablePathGuideline] : []),
		...(browserDefaultProfileGuideline !== undefined ? [browserDefaultProfileGuideline] : []),
	];
}
