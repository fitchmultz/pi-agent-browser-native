/**
 * Purpose: Compile and analyze experimental DOM/source and network source lookup input modes.
 * Responsibilities: Build lookup batches, collect DOM/React/workspace candidates, and redact network lookup surfaces.
 * Scope: Source lookup and network source lookup only.
 */

import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { isRecord } from "../parsing.js";
import { redactInvocationArgs, redactSensitiveText } from "../runtime.js";
import { getBatchResultItems, validateLookupMaxWorkspaceFiles } from "./shared.js";
import {
	SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES,
	SOURCE_LOOKUP_IGNORED_DIRECTORIES,
	SOURCE_LOOKUP_MAX_WORKSPACE_FILES,
	SOURCE_LOOKUP_WORKSPACE_EXTENSIONS,
	type AgentBrowserNetworkSourceLookupAnalysis,
	type AgentBrowserNetworkSourceLookupCandidate,
	type AgentBrowserNetworkSourceLookupRequest,
	type AgentBrowserNetworkSourceLookupStatus,
	type AgentBrowserSourceLookupAnalysis,
	type AgentBrowserSourceLookupAnalysisContext,
	type AgentBrowserSourceLookupCandidate,
	type AgentBrowserSourceLookupStatus,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserSourceLookup,
	type CompiledAgentBrowserSourceLookupStep,
} from "./types.js";

export function compileAgentBrowserSourceLookup(input: unknown): { compiled?: CompiledAgentBrowserSourceLookup; error?: string } {
	if (!isRecord(input)) {
		return { error: "sourceLookup must be an object." };
	}
	const selector = input.selector;
	const reactFiberId = input.reactFiberId;
	const componentName = input.componentName;
	if (selector !== undefined && (typeof selector !== "string" || selector.trim().length === 0)) {
		return { error: "sourceLookup.selector must be a non-empty string when provided." };
	}
	if (reactFiberId !== undefined && (typeof reactFiberId !== "string" || reactFiberId.trim().length === 0)) {
		return { error: "sourceLookup.reactFiberId must be a non-empty string when provided." };
	}
	if (componentName !== undefined && (typeof componentName !== "string" || componentName.trim().length === 0)) {
		return { error: "sourceLookup.componentName must be a non-empty string when provided." };
	}
	if (selector === undefined && reactFiberId === undefined && componentName === undefined) {
		return { error: "sourceLookup requires selector, reactFiberId, or componentName." };
	}
	if (input.includeDomHints !== undefined && typeof input.includeDomHints !== "boolean") {
		return { error: "sourceLookup.includeDomHints must be a boolean when provided." };
	}
	const rawMaxWorkspaceFiles = input.maxWorkspaceFiles;
	if (rawMaxWorkspaceFiles !== undefined && (typeof rawMaxWorkspaceFiles !== "number" || !Number.isInteger(rawMaxWorkspaceFiles) || rawMaxWorkspaceFiles <= 0)) {
		return { error: "sourceLookup.maxWorkspaceFiles must be a positive integer when provided." };
	}
	if (typeof rawMaxWorkspaceFiles === "number" && rawMaxWorkspaceFiles > SOURCE_LOOKUP_MAX_WORKSPACE_FILES) {
		return { error: `sourceLookup.maxWorkspaceFiles must be ${SOURCE_LOOKUP_MAX_WORKSPACE_FILES} or less.` };
	}
	const includeDomHints = input.includeDomHints !== false;
	const maxWorkspaceFiles = (rawMaxWorkspaceFiles as number | undefined) ?? SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES;
	const steps: CompiledAgentBrowserSourceLookupStep[] = [];
	if (typeof selector === "string") {
		steps.push({ action: "dom", args: ["is", "visible", selector] });
		if (includeDomHints) {
			steps.push({ action: "dom", args: ["get", "html", selector] });
		}
	}
	if (typeof reactFiberId === "string") {
		steps.push({ action: "react", args: ["react", "inspect", reactFiberId] });
	}
	if (typeof componentName === "string") {
		steps.push({ action: "react", args: ["react", "tree"] });
	}
	return {
		compiled: {
			args: ["batch"],
			query: { componentName, includeDomHints, maxWorkspaceFiles, reactFiberId, selector },
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}

function extractStringField(value: Record<string, unknown>, names: string[]): string | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.trim().length > 0) return field;
	}
	return undefined;
}

function extractNumberField(value: Record<string, unknown>, names: string[]): number | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "number" && Number.isFinite(field)) return field;
		if (typeof field === "string" && /^\d+$/.test(field)) return Number(field);
	}
	return undefined;
}

function candidateKey(candidate: AgentBrowserSourceLookupCandidate): string {
	return [candidate.source, candidate.file ?? "", candidate.line ?? "", candidate.column ?? "", candidate.componentName ?? ""].join(":");
}

function addSourceLookupCandidate(candidates: AgentBrowserSourceLookupCandidate[], candidate: AgentBrowserSourceLookupCandidate): void {
	if (!candidates.some((existing) => candidateKey(existing) === candidateKey(candidate))) {
		candidates.push(candidate);
	}
}

function collectSourceCandidatesFromValue(value: unknown, source: "react-inspect" | "dom-attribute", candidates: AgentBrowserSourceLookupCandidate[], evidence: string[], depth = 0): void {
	if (depth > 6 || value === undefined || value === null) return;
	if (typeof value === "string") {
		const sourcePattern = /([A-Za-z0-9_./@-]+\.(?:tsx|jsx|ts|js))(?:[:#](\d+))?(?:[:#](\d+))?/g;
		for (const match of value.matchAll(sourcePattern)) {
			addSourceLookupCandidate(candidates, {
				column: match[3] ? Number(match[3]) : undefined,
				confidence: source === "react-inspect" ? "high" : "medium",
				evidence,
				file: match[1],
				line: match[2] ? Number(match[2]) : undefined,
				source,
			});
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSourceCandidatesFromValue(item, source, candidates, evidence, depth + 1);
		return;
	}
	if (!isRecord(value)) return;
	const file = extractStringField(value, ["file", "fileName", "filename", "filePath", "path", "source", "url"]);
	if (file && /\.(?:tsx|jsx|ts|js)(?:$|[:?#])/.test(file)) {
		addSourceLookupCandidate(candidates, {
			column: extractNumberField(value, ["column", "columnNumber", "col"]),
			confidence: source === "react-inspect" ? "high" : "medium",
			evidence,
			file,
			line: extractNumberField(value, ["line", "lineNumber"]),
			source,
		});
	}
	for (const nested of Object.values(value)) {
		collectSourceCandidatesFromValue(nested, source, candidates, evidence, depth + 1);
	}
}

function getHtmlAttributeValue(html: string, name: string): string | undefined {
	const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
	return pattern.exec(html)?.[1];
}

function collectDomSourceCandidates(html: unknown, candidates: AgentBrowserSourceLookupCandidate[]): void {
	if (typeof html !== "string") return;
	const file = getHtmlAttributeValue(html, "(?:data-source-file|data-file|data-component-file|data-source)");
	if (file && /\.(?:tsx|jsx|ts|js)$/.test(file)) {
		const line = getHtmlAttributeValue(html, "(?:data-source-line|data-line)");
		const column = getHtmlAttributeValue(html, "(?:data-source-column|data-column)");
		addSourceLookupCandidate(candidates, {
			column: column && /^\d+$/.test(column) ? Number(column) : undefined,
			confidence: "medium",
			evidence: ["selector HTML contained source-like data attributes"],
			file,
			line: line && /^\d+$/.test(line) ? Number(line) : undefined,
			source: "dom-attribute",
		});
	}
	collectSourceCandidatesFromValue(html, "dom-attribute", candidates, ["selector HTML contained source-like text"]);
}

async function walkWorkspaceSourceFiles(root: string, maxFiles: number): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		if (files.length >= maxFiles) return;
		let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) return;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SOURCE_LOOKUP_IGNORED_DIRECTORIES.has(entry.name)) await visit(path);
			} else if (entry.isFile() && SOURCE_LOOKUP_WORKSPACE_EXTENSIONS.has(extname(entry.name))) {
				files.push(path);
			}
		}
	}
	await visit(root);
	return files;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectWorkspaceComponentCandidates(query: CompiledAgentBrowserSourceLookup["query"], cwd: string, candidates: AgentBrowserSourceLookupCandidate[], limitations: string[]): Promise<void> {
	if (!query.componentName) return;
	const files = await walkWorkspaceSourceFiles(cwd, query.maxWorkspaceFiles);
	if (files.length >= query.maxWorkspaceFiles) {
		limitations.push(`Workspace source scan stopped at ${query.maxWorkspaceFiles} files.`);
	}
	const componentPattern = new RegExp(`(?:function|class)\\s+${escapeRegExp(query.componentName)}\\b|(?:const|let|var)\\s+${escapeRegExp(query.componentName)}\\s*=|export\\s+default\\s+function\\s+${escapeRegExp(query.componentName)}\\b`);
	for (const file of files) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const match = componentPattern.exec(text);
		if (!match) continue;
		const line = text.slice(0, match.index).split("\n").length;
		addSourceLookupCandidate(candidates, {
			componentName: query.componentName,
			confidence: "low",
			evidence: [`local workspace contains a matching ${query.componentName} declaration`],
			file,
			line,
			source: "workspace-search",
		});
		if (candidates.filter((candidate) => candidate.source === "workspace-search").length >= 10) break;
	}
}

export async function analyzeSourceLookupResults(
	data: unknown,
	compiled: CompiledAgentBrowserSourceLookup,
	cwd: string,
	context?: AgentBrowserSourceLookupAnalysisContext,
): Promise<AgentBrowserSourceLookupAnalysis> {
	const items = getBatchResultItems(data);
	const candidates: AgentBrowserSourceLookupCandidate[] = [];
	const limitations = [
		"Experimental lookup only reports candidates with evidence; it cannot guarantee a DOM node maps to one source file.",
		"React source hints require the page to be opened with --enable react-devtools and source information from the app build.",
	];
	let unsupported = false;
	for (const item of items) {
		const command = Array.isArray(item.command) ? item.command : [];
		const result = isRecord(item.result) && "data" in item.result ? item.result.data : item.result;
		if (item.success === false && command[0] === "react") unsupported = true;
		if (command[0] === "react" && command[1] === "inspect") {
			collectSourceCandidatesFromValue(result, "react-inspect", candidates, ["react inspect returned source-like metadata"]);
		}
		if (command[0] === "get" && command[1] === "html") {
			collectDomSourceCandidates(result, candidates);
		}
	}
	await collectWorkspaceComponentCandidates(compiled.query, cwd, candidates, limitations);
	const status: AgentBrowserSourceLookupStatus = candidates.length > 0 ? "candidates-found" : unsupported ? "unsupported" : "no-candidates";
	const electronContext = status === "no-candidates" ? context?.electronContext : undefined;
	const workspaceRoot = context?.workspaceRoot ?? cwd;
	if (electronContext) {
		limitations.push(
			`Workspace source scan is limited to the Pi tool session cwd: ${workspaceRoot}.`,
			"Packaged Electron app code may live inside installed app resources or app.asar outside the workspace; the wrapper does not unpack asar files or scan app bundle resources.",
		);
	}
	return {
		candidates,
		electronContext,
		limitations,
		status,
		summary: candidates.length > 0
			? `Source lookup found ${candidates.length} candidate location(s).`
			: unsupported
				? "Source lookup could not inspect React metadata in this session."
				: electronContext
					? `Source lookup found no candidate locations. The workspace scan was limited to ${workspaceRoot}; packaged Electron app code may live outside that cwd in app resources or app.asar.`
					: "Source lookup found no candidate locations.",
		workspaceRoot: electronContext ? workspaceRoot : undefined,
	};
}

export function compileAgentBrowserNetworkSourceLookup(input: unknown): { compiled?: CompiledAgentBrowserNetworkSourceLookup; error?: string } {
	if (!isRecord(input)) return { error: "networkSourceLookup must be an object." };
	const filter = input.filter;
	const requestId = input.requestId;
	const session = input.session;
	const url = input.url;
	if (filter !== undefined && (typeof filter !== "string" || filter.trim().length === 0)) return { error: "networkSourceLookup.filter must be a non-empty string when provided." };
	if (requestId !== undefined && (typeof requestId !== "string" || requestId.trim().length === 0)) return { error: "networkSourceLookup.requestId must be a non-empty string when provided." };
	if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) return { error: "networkSourceLookup.session must be a non-empty string when provided." };
	if (url !== undefined && (typeof url !== "string" || url.trim().length === 0)) return { error: "networkSourceLookup.url must be a non-empty string when provided." };
	if (filter === undefined && requestId === undefined && url === undefined) return { error: "networkSourceLookup requires requestId, filter, or url." };
	const maxWorkspaceFiles = validateLookupMaxWorkspaceFiles(input.maxWorkspaceFiles, "networkSourceLookup.maxWorkspaceFiles");
	if (maxWorkspaceFiles.error) return { error: maxWorkspaceFiles.error };
	const steps: Array<{ action: "network"; args: string[] }> = [];
	if (typeof requestId === "string") {
		steps.push({ action: "network", args: ["network", "request", requestId] });
	}
	const effectiveFilter = typeof filter === "string" ? filter : typeof url === "string" ? url : undefined;
	if (effectiveFilter) {
		steps.push({ action: "network", args: ["network", "requests", "--filter", effectiveFilter] });
	}
	const args = typeof session === "string" ? ["--session", session, "batch"] : ["batch"];
	return { compiled: { args, query: { filter, maxWorkspaceFiles: maxWorkspaceFiles.value as number, requestId, session, url }, stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}

function getResultPayload(item: Record<string, unknown>): unknown {
	return isRecord(item.result) && "data" in item.result ? item.result.data : item.result;
}

function networkRequestMatchesQuery(url: string | undefined, queryText: string | undefined): boolean {
	return queryText === undefined || url === undefined || url.includes(queryText) || queryText.includes(url);
}

function isFailedNetworkRecord(request: Record<string, unknown>): boolean {
	const status = typeof request.status === "number" ? request.status : undefined;
	const error = typeof request.error === "string" ? request.error : undefined;
	return request.failed === true || error !== undefined || (status !== undefined && status >= 400);
}

function getFailedNetworkRequests(data: unknown, queryText?: string): AgentBrowserNetworkSourceLookupRequest[] {
	const failed: AgentBrowserNetworkSourceLookupRequest[] = [];
	for (const item of getBatchResultItems(data)) {
		const payload = getResultPayload(item);
		const requests = isRecord(payload) && Array.isArray(payload.requests) ? payload.requests : Array.isArray(payload) ? payload : isRecord(payload) ? [payload] : [];
		for (const request of requests) {
			if (!isRecord(request)) continue;
			const url = typeof request.url === "string" ? request.url : undefined;
			if (!networkRequestMatchesQuery(url, queryText) || !isFailedNetworkRecord(request)) continue;
			failed.push({
				error: typeof request.error === "string" ? request.error : undefined,
				method: typeof request.method === "string" ? request.method : undefined,
				requestId: typeof request.id === "string" ? request.id : typeof request.requestId === "string" ? request.requestId : undefined,
				status: typeof request.status === "number" ? request.status : undefined,
				url,
			});
		}
	}
	return failed;
}

function addNetworkCandidate(candidates: AgentBrowserNetworkSourceLookupCandidate[], candidate: AgentBrowserNetworkSourceLookupCandidate): void {
	const key = [candidate.source, candidate.file ?? "", candidate.line ?? "", candidate.requestUrl ?? ""].join(":");
	if (!candidates.some((existing) => [existing.source, existing.file ?? "", existing.line ?? "", existing.requestUrl ?? ""].join(":") === key)) candidates.push(candidate);
}

function collectInitiatorCandidates(data: unknown, failedRequests: AgentBrowserNetworkSourceLookupRequest[], candidates: AgentBrowserNetworkSourceLookupCandidate[]): void {
	const failedRequestIds = new Set(failedRequests.map((request) => request.requestId).filter((value): value is string => value !== undefined));
	const failedRequestUrls = new Set(failedRequests.map((request) => request.url).filter((value): value is string => value !== undefined));
	for (const item of getBatchResultItems(data)) {
		const payload = getResultPayload(item);
		const requestValues = isRecord(payload) && Array.isArray(payload.requests) ? payload.requests : [payload];
		for (const value of requestValues) {
			if (!isRecord(value)) continue;
			const requestUrl = typeof value.url === "string" ? value.url : undefined;
			const requestId = typeof value.id === "string" ? value.id : typeof value.requestId === "string" ? value.requestId : undefined;
			const correlatesWithFailedRequest = (requestId !== undefined && failedRequestIds.has(requestId)) || (requestUrl !== undefined && failedRequestUrls.has(requestUrl));
			if (!correlatesWithFailedRequest && !isFailedNetworkRecord(value)) continue;
			for (const field of [value.initiator, value.stack, value.source, value.trace]) {
				const localCandidates: AgentBrowserSourceLookupCandidate[] = [];
				collectSourceCandidatesFromValue(field, "dom-attribute", localCandidates, ["failed network request included source-like initiator metadata"]);
				for (const candidate of localCandidates) {
					addNetworkCandidate(candidates, { confidence: "medium", evidence: candidate.evidence, file: candidate.file, line: candidate.line, requestUrl, source: "initiator" });
				}
			}
		}
	}
}

async function collectWorkspaceRequestCandidates(query: CompiledAgentBrowserNetworkSourceLookup["query"], failedRequests: AgentBrowserNetworkSourceLookupRequest[], cwd: string, candidates: AgentBrowserNetworkSourceLookupCandidate[], limitations: string[]): Promise<void> {
	const needles = [...new Set([query.url, query.filter, ...failedRequests.map((request) => request.url)].filter((value): value is string => typeof value === "string" && value.length > 0).flatMap((value) => {
		try {
			const parsed = new URL(value);
			return [value, parsed.pathname].filter((item) => item && item !== "/");
		} catch {
			return [value];
		}
	}))].slice(0, 8);
	if (needles.length === 0) return;
	const files = await walkWorkspaceSourceFiles(cwd, query.maxWorkspaceFiles);
	if (files.length >= query.maxWorkspaceFiles) limitations.push(`Workspace source scan stopped at ${query.maxWorkspaceFiles} files.`);
	for (const file of files) {
		let text: string;
		try { text = await readFile(file, "utf8"); } catch { continue; }
		for (const needle of needles) {
			const index = text.indexOf(needle);
			if (index === -1) continue;
			addNetworkCandidate(candidates, { confidence: "low", evidence: [`local workspace contains request URL literal ${needle}`], file, line: text.slice(0, index).split("\n").length, requestUrl: needle, source: "workspace-search" });
			if (candidates.filter((candidate) => candidate.source === "workspace-search").length >= 10) return;
		}
	}
}

export function redactNetworkSourceLookupUrl(value: string | undefined): string | undefined {
	if (!value) return value;
	try {
		const isRelative = value.startsWith("/");
		const url = new URL(value, isRelative ? "https://redacted.invalid" : undefined);
		url.username = url.username ? "[REDACTED]" : "";
		url.password = url.password ? "[REDACTED]" : "";
		for (const key of [...url.searchParams.keys()]) {
			url.searchParams.set(key, "[REDACTED]");
		}
		if (/(?:token|secret|password|passwd|pwd|key|auth|session|jwt|credential)/i.test(url.hash)) {
			url.hash = "#[REDACTED]";
		}
		return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
	} catch {
		return redactSensitiveText(value
			.replace(/([a-z][a-z0-9+.-]*:\/\/)\S+:\S+@/gi, "$1[REDACTED]@")
			.replace(/([?&][^=]+)=([^&#\s"'\]]+)/g, "$1=[REDACTED]"));
	}
}

export function redactNetworkSourceLookupArgs(args: string[]): string[] {
	return redactInvocationArgs(args).map((arg) => redactNetworkSourceLookupUrl(arg) ?? arg);
}

export function redactNetworkSourceLookupSurface(value: unknown): unknown {
	if (typeof value === "string") return redactNetworkSourceLookupUrl(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => redactNetworkSourceLookupSurface(item));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNetworkSourceLookupSurface(item)]));
}

export function redactNetworkSourceLookupAnalysis(analysis: AgentBrowserNetworkSourceLookupAnalysis): AgentBrowserNetworkSourceLookupAnalysis {
	return {
		...analysis,
		candidates: analysis.candidates.map((candidate) => ({
			...candidate,
			evidence: candidate.evidence.map((item) => redactNetworkSourceLookupUrl(item) ?? redactSensitiveText(item)),
			file: redactNetworkSourceLookupUrl(candidate.file),
			requestUrl: redactNetworkSourceLookupUrl(candidate.requestUrl),
		})),
		failedRequests: analysis.failedRequests.map((request) => ({ ...request, error: redactNetworkSourceLookupUrl(request.error), url: redactNetworkSourceLookupUrl(request.url) })),
	};
}

export async function analyzeNetworkSourceLookupResults(data: unknown, compiled: CompiledAgentBrowserNetworkSourceLookup, cwd: string): Promise<AgentBrowserNetworkSourceLookupAnalysis> {
	const limitations = [
		"Experimental network source hints report candidates only; failed requests can be triggered indirectly by frameworks, caches, service workers, or third-party scripts.",
		"Initiator/source-map metadata is upstream/browser-build dependent and may be absent.",
	];
	const failedRequests = getFailedNetworkRequests(data, compiled.query.url ?? compiled.query.filter);
	const candidates: AgentBrowserNetworkSourceLookupCandidate[] = [];
	collectInitiatorCandidates(data, failedRequests, candidates);
	await collectWorkspaceRequestCandidates(compiled.query, failedRequests, cwd, candidates, limitations);
	const status: AgentBrowserNetworkSourceLookupStatus = failedRequests.length === 0 ? "no-failed-requests" : candidates.length > 0 ? "failed-requests-found" : "no-candidates";
	return { candidates, failedRequests, limitations, status, summary: failedRequests.length === 0 ? "Network source lookup found no failed requests." : candidates.length > 0 ? `Network source lookup found ${failedRequests.length} failed request(s) and ${candidates.length} candidate source hint(s).` : `Network source lookup found ${failedRequests.length} failed request(s) but no source candidates.` };
}
