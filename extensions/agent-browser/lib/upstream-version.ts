import {
	SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
	SUPPORTED_AGENT_BROWSER_VERSIONS,
	TARGET_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_VERSION_LABEL,
} from "../../../scripts/agent-browser-target.mjs";

export {
	SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
	SUPPORTED_AGENT_BROWSER_VERSIONS,
	TARGET_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_VERSION_LABEL,
};

export function parseAgentBrowserVersionOutput(stdout: string): string | undefined {
	const match = stdout.trim().match(/^agent-browser\s+(\S+)$/);
	return match?.[1];
}

export function getAgentBrowserVersionValidationError(stdout: string): string | undefined {
	const observed = parseAgentBrowserVersionOutput(stdout);
	if (observed && SUPPORTED_AGENT_BROWSER_VERSIONS.includes(observed)) return undefined;
	return observed
		? `Installed agent-browser ${observed} is unsupported. Install ${TARGET_AGENT_BROWSER_VERSION_LABEL} (preferred) or another supported runtime (${SUPPORTED_AGENT_BROWSER_VERSIONS.join(", ")}), run pi-agent-browser-doctor, then reload Pi.`
		: `agent-browser --version returned an unrecognized value; expected ${SUPPORTED_AGENT_BROWSER_VERSION_LABEL}. Run pi-agent-browser-doctor and install a supported upstream version.`;
}
