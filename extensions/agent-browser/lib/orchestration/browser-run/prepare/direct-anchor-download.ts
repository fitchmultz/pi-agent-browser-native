import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRecord } from "../../../parsing.js";
import { buildAgentBrowserResultCategoryDetails } from "../../../results.js";
import { redactSensitiveText, type CompatibilityWorkaround } from "../../../runtime.js";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.js";

import type { AgentBrowserToolResult } from "../types.js";

const DIRECT_ANCHOR_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;

function getDirectDownloadRequest(commandTokens: string[]): { path: string; selector: string } | undefined {
	if (commandTokens[0] !== "download" || commandTokens.length !== 3) return undefined;
	const selector = commandTokens[1];
	const path = commandTokens[2];
	if (!selector || !path || selector.startsWith("@")) return undefined;
	return { path, selector };
}

function buildAnchorDownloadProbe(selector: string): string {
	return `(async () => {\n  const selector = ${JSON.stringify(selector)};\n  const maxBytes = ${DIRECT_ANCHOR_DOWNLOAD_MAX_BYTES};\n  const isLoopbackHttpUrl = (url) => (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");\n  const element = document.querySelector(selector);\n  const anchor = element?.closest?.("a[href]");\n  const pageUrl = location.href;\n  const page = new URL(pageUrl);\n  if (!anchor) return { status: "no-anchor", pageUrl };\n  const href = anchor.href;\n  const anchorUrl = new URL(href, pageUrl);\n  if (!isLoopbackHttpUrl(page)) return { download: anchor.getAttribute("download") || "", href, pageUrl, status: "not-loopback-page" };\n  if (anchorUrl.origin !== page.origin) return { download: anchor.getAttribute("download") || "", href, pageUrl, status: "not-same-origin" };\n  if (!isLoopbackHttpUrl(anchorUrl)) return { download: anchor.getAttribute("download") || "", href, pageUrl, status: "not-loopback-href" };\n  const response = await fetch(anchorUrl.href, { credentials: "include", redirect: "manual" });\n  if (!response.ok) return { download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, status: "fetch-failed", statusCode: response.status };\n  const responseUrl = new URL(response.url);\n  if (!isLoopbackHttpUrl(responseUrl) || responseUrl.origin !== page.origin) return { download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, status: "not-loopback-response" };\n  const buffer = await response.arrayBuffer();\n  if (buffer.byteLength > maxBytes) return { download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, sizeBytes: buffer.byteLength, status: "too-large" };\n  const bytes = new Uint8Array(buffer);\n  let binary = "";\n  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));\n  return { bodyBase64: btoa(binary), contentType: response.headers.get("content-type") || "", download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, sizeBytes: buffer.byteLength, status: "fetched-anchor" };\n})()`;
}

function isLoopbackHttpUrl(url: URL): boolean {
	return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");
}

export async function tryDirectAnchorDownload(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = getDirectDownloadRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	try {
		const probeData = await runSessionCommandData({
			args: ["eval", "--stdin"],
			cwd: options.cwd,
			sessionName: options.sessionName,
			signal: options.signal,
			stdin: buildAnchorDownloadProbe(request.selector),
		});
		const probe = isRecord(probeData) && isRecord(probeData.result) ? probeData.result : probeData;
		if (!isRecord(probe) || probe.status !== "fetched-anchor" || typeof probe.href !== "string" || typeof probe.pageUrl !== "string" || typeof probe.bodyBase64 !== "string") return undefined;
		const href = new URL(probe.href);
		const pageUrl = new URL(probe.pageUrl);
		const responseUrl = typeof probe.responseUrl === "string" ? new URL(probe.responseUrl) : href;
		if (!isLoopbackHttpUrl(pageUrl) || !isLoopbackHttpUrl(href) || !isLoopbackHttpUrl(responseUrl) || href.origin !== pageUrl.origin || responseUrl.origin !== pageUrl.origin) return undefined;
		const body = Buffer.from(probe.bodyBase64, "base64");
		if (body.byteLength > DIRECT_ANCHOR_DOWNLOAD_MAX_BYTES) return undefined;
		if (typeof probe.sizeBytes === "number" && probe.sizeBytes !== body.byteLength) return undefined;
		const absolutePath = resolve(options.cwd, request.path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, body);
		const fileStat = await stat(absolutePath);
		const mediaType = typeof probe.contentType === "string" && probe.contentType.length > 0 ? probe.contentType : undefined;
		const artifact = {
			absolutePath,
			artifactType: "download" as const,
			command: "download",
			cwd: options.cwd,
			exists: true,
			kind: "download" as const,
			mediaType,
			path: absolutePath,
			requestedPath: request.path,
			session: options.sessionName,
			sizeBytes: fileStat.size,
			status: "saved" as const,
		};
		const artifactVerification = {
			artifacts: [{
				absolutePath,
				exists: true,
				kind: "download" as const,
				mediaType,
				path: absolutePath,
				requestedPath: request.path,
				sizeBytes: fileStat.size,
				state: "verified" as const,
				status: "saved" as const,
			}],
			missingCount: 0,
			pendingCount: 0,
			unverifiedCount: 0,
			verified: true,
			verifiedCount: 1,
		};
		const savedFile = { command: "download" as const, kind: "download" as const, metadata: { download: probe.download, href: redactSensitiveText(href.href), method: "direct-anchor-fetch" }, path: absolutePath };
		return {
			content: [{
				type: "text",
				text: [
					`Download completed: ${absolutePath}`,
					`Requested path: ${request.path}`,
					`Source: ${redactSensitiveText(href.href)}`,
					`Size: ${fileStat.size} bytes`,
					"Method: direct anchor fetch before upstream download fallback.",
				].join("\n"),
			}],
			details: {
				args: options.redactedArgs,
				artifacts: [artifact],
				artifactVerification,
				command: "download",
				compatibilityWorkaround: options.compatibilityWorkaround,
				downloadRecovery: { href: redactSensitiveText(href.href), method: "direct-anchor-fetch", selector: request.selector },
				effectiveArgs: options.effectiveArgs,
				savedFile,
				savedFilePath: absolutePath,
				sessionMode: options.sessionMode,
				...buildAgentBrowserResultCategoryDetails({ artifacts: [artifact], args: options.effectiveArgs, command: "download", savedFile, succeeded: true }),
				...buildSessionDetailFields(options.sessionName, options.usedImplicitSession),
				summary: `Download completed: ${absolutePath}`,
			},
			isError: false,
		};
	} catch {
		return undefined;
	}
}
