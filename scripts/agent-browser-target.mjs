export const TARGET_AGENT_BROWSER_SOURCE = "scripts/agent-browser-target.mjs";
export const TARGET_AGENT_BROWSER_VERSION = "0.36.0";
export const TARGET_AGENT_BROWSER_VERSION_LABEL = `agent-browser ${TARGET_AGENT_BROWSER_VERSION}`;
export const MINIMUM_AGENT_BROWSER_VERSION = "0.35.0";
export const MINIMUM_AGENT_BROWSER_VERSION_LABEL = `agent-browser ${MINIMUM_AGENT_BROWSER_VERSION}`;
export const SUPPORTED_AGENT_BROWSER_VERSION_LABEL = `${MINIMUM_AGENT_BROWSER_VERSION_LABEL} or newer`;

function stableVersionParts(version) {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	return match?.slice(1).map(Number);
}

export function isSupportedAgentBrowserVersion(version) {
	const actual = stableVersionParts(version);
	const minimum = stableVersionParts(MINIMUM_AGENT_BROWSER_VERSION);
	if (!actual || !minimum) return false;
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
	}
	return true;
}
