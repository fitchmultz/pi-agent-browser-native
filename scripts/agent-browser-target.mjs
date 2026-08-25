export const TARGET_AGENT_BROWSER_SOURCE = "scripts/agent-browser-target.mjs";
export const TARGET_AGENT_BROWSER_VERSION = "0.35.0";
export const TARGET_AGENT_BROWSER_VERSION_LABEL = `agent-browser ${TARGET_AGENT_BROWSER_VERSION}`;
export const SUPPORTED_AGENT_BROWSER_VERSIONS = Object.freeze([TARGET_AGENT_BROWSER_VERSION, "0.34.0"]);
export const SUPPORTED_AGENT_BROWSER_VERSION_LABEL = SUPPORTED_AGENT_BROWSER_VERSIONS.map((version) => `agent-browser ${version}`).join(" or ");
