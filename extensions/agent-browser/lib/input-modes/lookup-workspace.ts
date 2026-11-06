import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { distinctNetworkCandidates } from "./lookup-network-evidence.js";
import {
	SOURCE_LOOKUP_IGNORED_DIRECTORIES,
	SOURCE_LOOKUP_WORKSPACE_EXTENSIONS,
	type AgentBrowserNetworkSourceLookupCandidate,
	type AgentBrowserNetworkSourceLookupRequest,
	type AgentBrowserSourceLookupCandidate,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserSourceLookup,
} from "./types.js";

interface WorkspaceScan<T> {
	readonly candidates: readonly T[];
	readonly limitations: readonly string[];
}

async function walkWorkspaceSourceFiles(root: string, maxFiles: number): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		if (files.length >= maxFiles) {
			return;
		}
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			// Unreadable workspace directories contribute no source candidates.
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) {
				return;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory() && !SOURCE_LOOKUP_IGNORED_DIRECTORIES.has(entry.name)) {
				// Ordered depth-first traversal preserves which files enter the bounded scan.
				await visit(path);
			}
			if (entry.isFile() && SOURCE_LOOKUP_WORKSPACE_EXTENSIONS.has(extname(entry.name))) {
				files.push(path);
			}
		}
	}
	await visit(root);
	return files;
}

async function readWorkspaceText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch {
		// A file removed or unreadable after enumeration is not lookup evidence.
		return undefined;
	}
}

function scanLimitations(files: readonly string[], maxFiles: number): string[] {
	return files.length >= maxFiles ? [`Workspace source scan stopped at ${maxFiles} files.`] : [];
}

function componentPattern(name: string): RegExp {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?:function|class)\\s+${escaped}\\b|(?:const|let|var)\\s+${escaped}\\s*=|export\\s+default\\s+function\\s+${escaped}\\b`,
	);
}

export async function scanWorkspaceComponent(
	query: CompiledAgentBrowserSourceLookup["query"],
	cwd: string,
): Promise<WorkspaceScan<AgentBrowserSourceLookupCandidate>> {
	const componentName = query.componentName;
	if (componentName === undefined || componentName.length === 0) {
		return { candidates: [], limitations: [] };
	}
	const files = await walkWorkspaceSourceFiles(cwd, query.maxWorkspaceFiles);
	const pattern = componentPattern(componentName);
	const candidates: AgentBrowserSourceLookupCandidate[] = [];
	for (const file of files) {
		// Reads remain serial so the ten-candidate budget stops further filesystem work.
		const text = await readWorkspaceText(file);
		if (text === undefined) {
			continue;
		}
		const match = pattern.exec(text);
		if (match === null) {
			continue;
		}
		candidates.push({
			componentName,
			confidence: "low",
			evidence: [`local workspace contains a matching ${componentName} declaration`],
			file,
			line: text.slice(0, match.index).split("\n").length,
			source: "workspace-search",
		});
		if (candidates.length >= 10) {
			break;
		}
	}
	return { candidates, limitations: scanLimitations(files, query.maxWorkspaceFiles) };
}

function requestNeedles(value: string): string[] {
	try {
		const parsed = new URL(value);
		return [value, parsed.pathname].filter((item) => item.length > 0 && item !== "/");
	} catch {
		return [value];
	}
}

function workspaceRequestNeedles(
	query: CompiledAgentBrowserNetworkSourceLookup["query"],
	failedRequests: readonly AgentBrowserNetworkSourceLookupRequest[],
): string[] {
	return [
		...new Set(
			[query.url, query.filter, ...failedRequests.map((request) => request.url)]
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.flatMap(requestNeedles),
		),
	].slice(0, 8);
}

function requestLiteralCandidates(
	text: string,
	file: string,
	needles: readonly string[],
): AgentBrowserNetworkSourceLookupCandidate[] {
	const candidates: AgentBrowserNetworkSourceLookupCandidate[] = [];
	for (const needle of needles) {
		const index = text.indexOf(needle);
		if (index !== -1) {
			candidates.push({
				confidence: "low",
				evidence: [`local workspace contains request URL literal ${needle}`],
				file,
				line: text.slice(0, index).split("\n").length,
				requestUrl: needle,
				source: "workspace-search",
			});
		}
	}
	return candidates;
}

export async function scanWorkspaceRequests(
	query: CompiledAgentBrowserNetworkSourceLookup["query"],
	failedRequests: readonly AgentBrowserNetworkSourceLookupRequest[],
	cwd: string,
): Promise<WorkspaceScan<AgentBrowserNetworkSourceLookupCandidate>> {
	const needles = workspaceRequestNeedles(query, failedRequests);
	if (needles.length === 0) {
		return { candidates: [], limitations: [] };
	}
	const files = await walkWorkspaceSourceFiles(cwd, query.maxWorkspaceFiles);
	let candidates: AgentBrowserNetworkSourceLookupCandidate[] = [];
	for (const file of files) {
		// Preserve first-match ordering and stop reading files at the candidate budget.
		const text = await readWorkspaceText(file);
		if (text === undefined) {
			continue;
		}
		candidates = distinctNetworkCandidates([
			...candidates,
			...requestLiteralCandidates(text, file, needles),
		]).slice(0, 10);
		if (candidates.length >= 10) {
			break;
		}
	}
	return { candidates, limitations: scanLimitations(files, query.maxWorkspaceFiles) };
}
