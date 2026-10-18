import type {
	AgentBrowserNetworkSourceLookupAnalysis,
	AgentBrowserNetworkSourceLookupStatus,
	AgentBrowserSourceLookupAnalysis,
	AgentBrowserSourceLookupAnalysisContext,
	AgentBrowserSourceLookupStatus,
	CompiledAgentBrowserNetworkSourceLookup,
	CompiledAgentBrowserSourceLookup,
} from "./types.js";

export {
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserSourceLookup,
} from "./lookup-plan.js";
export {
	redactNetworkSourceLookupAnalysis,
	redactNetworkSourceLookupArgs,
	redactNetworkSourceLookupSurface,
	redactNetworkSourceLookupUrl,
} from "./lookup-redaction.js";

function sourceStatus(
	candidateCount: number,
	unsupported: boolean,
): AgentBrowserSourceLookupStatus {
	if (candidateCount > 0) {
		return "candidates-found";
	}
	return unsupported ? "unsupported" : "no-candidates";
}

function sourceSummary(
	status: AgentBrowserSourceLookupStatus,
	candidateCount: number,
	electronWorkspace?: string,
): string {
	switch (status) {
		case "candidates-found":
			return `Source lookup found ${candidateCount} candidate location(s).`;
		case "unsupported":
			return "Source lookup could not inspect React metadata in this session.";
		case "no-candidates":
			if (electronWorkspace !== undefined) {
				return `Source lookup found no candidate locations. The workspace scan was limited to ${electronWorkspace}; packaged Electron app code may live outside that cwd in app resources or app.asar.`;
			}
			return "Source lookup found no candidate locations.";
	}
}

export async function analyzeSourceLookupResults(
	data: unknown,
	compiled: CompiledAgentBrowserSourceLookup,
	cwd: string,
	context?: AgentBrowserSourceLookupAnalysisContext,
): Promise<AgentBrowserSourceLookupAnalysis> {
	const { distinctSourceCandidates, observeSourceCandidates } =
		await import("./lookup-source-evidence.js");
	const { scanWorkspaceComponent } = await import("./lookup-workspace.js");
	const observed = observeSourceCandidates(data);
	const workspace = await scanWorkspaceComponent(compiled.query, cwd);
	const candidates = distinctSourceCandidates([...observed.candidates, ...workspace.candidates]);
	const status = sourceStatus(candidates.length, observed.unsupported);
	const electronContext = status === "no-candidates" ? context?.electronContext : undefined;
	const workspaceRoot = context?.workspaceRoot ?? cwd;
	const limitations = [
		"Experimental lookup only reports candidates with evidence; it cannot guarantee a DOM node maps to one source file.",
		"React source hints require the page to be opened with --enable react-devtools and source information from the app build.",
		...workspace.limitations,
	];
	if (electronContext) {
		limitations.push(
			`Workspace source scan is limited to the captured execution directory: ${workspaceRoot}.`,
			"Packaged Electron app code may live inside installed app resources or app.asar outside the workspace; the wrapper does not unpack asar files or scan app bundle resources.",
		);
	}
	return {
		candidates,
		electronContext,
		limitations,
		status,
		summary: sourceSummary(status, candidates.length, electronContext ? workspaceRoot : undefined),
		workspaceRoot: electronContext ? workspaceRoot : undefined,
	};
}

function networkStatus(
	failedCount: number,
	candidateCount: number,
): AgentBrowserNetworkSourceLookupStatus {
	if (failedCount === 0) {
		return "no-failed-requests";
	}
	return candidateCount > 0 ? "failed-requests-found" : "no-candidates";
}

function networkSummary(
	status: AgentBrowserNetworkSourceLookupStatus,
	failedCount: number,
	candidateCount: number,
): string {
	switch (status) {
		case "no-failed-requests":
			return "Network source lookup found no failed requests.";
		case "failed-requests-found":
			return `Network source lookup found ${failedCount} failed request(s) and ${candidateCount} candidate source hint(s).`;
		case "no-candidates":
			return `Network source lookup found ${failedCount} failed request(s) but no source candidates.`;
	}
}

export async function analyzeNetworkSourceLookupResults(
	data: unknown,
	compiled: CompiledAgentBrowserNetworkSourceLookup,
	cwd: string,
): Promise<AgentBrowserNetworkSourceLookupAnalysis> {
	const { distinctNetworkCandidates, getFailedNetworkRequests, observeInitiatorCandidates } =
		await import("./lookup-network-evidence.js");
	const { scanWorkspaceRequests } = await import("./lookup-workspace.js");
	const queryText = compiled.query.filter ?? compiled.query.url;
	const failedRequests = getFailedNetworkRequests(data, queryText);
	const observed = observeInitiatorCandidates(data, failedRequests, queryText);
	const workspace = await scanWorkspaceRequests(compiled.query, failedRequests, cwd);
	const candidates = distinctNetworkCandidates([...observed, ...workspace.candidates]);
	const status = networkStatus(failedRequests.length, candidates.length);
	return {
		candidates,
		failedRequests,
		limitations: [
			"Experimental network source hints report candidates only; failed requests can be triggered indirectly by frameworks, caches, service workers, or third-party scripts.",
			"Initiator/source-map metadata is upstream/browser-build dependent and may be absent.",
			...workspace.limitations,
		],
		status,
		summary: networkSummary(status, failedRequests.length, candidates.length),
	};
}
