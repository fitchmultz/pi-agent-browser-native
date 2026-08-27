import {
	MINIMUM_AGENT_BROWSER_VERSION,
	MINIMUM_AGENT_BROWSER_VERSION_LABEL,
	SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
	TARGET_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_VERSION_LABEL,
	isSupportedAgentBrowserVersion,
} from "../../../scripts/agent-browser-target.mjs";

export {
	MINIMUM_AGENT_BROWSER_VERSION,
	MINIMUM_AGENT_BROWSER_VERSION_LABEL,
	SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
	TARGET_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_VERSION_LABEL,
	isSupportedAgentBrowserVersion,
};

export function parseAgentBrowserVersionOutput(stdout: string): string | undefined {
	const match = stdout.trim().match(/^agent-browser\s+(\S+)$/);
	return match?.[1];
}

export function getAgentBrowserVersionValidationError(stdout: string): string | undefined {
	const observed = parseAgentBrowserVersionOutput(stdout);
	if (observed && isSupportedAgentBrowserVersion(observed)) return undefined;
	return observed
		? `Installed agent-browser ${observed} is unsupported; stable versions must be at least ${MINIMUM_AGENT_BROWSER_VERSION_LABEL}. Install ${TARGET_AGENT_BROWSER_VERSION_LABEL} (recommended), run pi-agent-browser-doctor, then reload Pi.`
		: `agent-browser --version returned an unrecognized value; expected ${SUPPORTED_AGENT_BROWSER_VERSION_LABEL}. Run pi-agent-browser-doctor and install a supported upstream version.`;
}
