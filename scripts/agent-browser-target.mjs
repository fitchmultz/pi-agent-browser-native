export const TARGET_AGENT_BROWSER_SOURCE = "scripts/agent-browser-target.mjs";
export const TARGET_AGENT_BROWSER_VERSION = "0.43.0";
export const TARGET_AGENT_BROWSER_VERSION_LABEL = `agent-browser ${TARGET_AGENT_BROWSER_VERSION}`;
export const MINIMUM_AGENT_BROWSER_VERSION = "0.35.0";
export const MINIMUM_AGENT_BROWSER_VERSION_LABEL = `agent-browser ${MINIMUM_AGENT_BROWSER_VERSION}`;
export const SUPPORTED_AGENT_BROWSER_VERSION_LABEL = `${MINIMUM_AGENT_BROWSER_VERSION_LABEL} or newer`;

/** @param {string} version
 * @returns {readonly [number, number, number] | undefined} */
function stableVersionParts(version) {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {string} version
 * @returns {boolean} */
export function isSupportedAgentBrowserVersion(version) {
	const actual = stableVersionParts(version);
	const minimum = stableVersionParts(MINIMUM_AGENT_BROWSER_VERSION);
	if (!actual || !minimum) {
		return false;
	}
	const [major, minor, patch] = actual;
	const [minimumMajor, minimumMinor, minimumPatch] = minimum;
	return (
		major > minimumMajor ||
		(major === minimumMajor &&
			(minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)))
	);
}
