import { TARGET_AGENT_BROWSER_VERSION, TARGET_AGENT_BROWSER_VERSION_LABEL } from "../../../scripts/agent-browser-target.mjs";

export { TARGET_AGENT_BROWSER_VERSION, TARGET_AGENT_BROWSER_VERSION_LABEL };

export function parseAgentBrowserVersionOutput(stdout: string): string | undefined {
	const match = stdout.trim().match(/^agent-browser\s+(\S+)$/);
	return match?.[1];
}

export function getAgentBrowserVersionValidationError(stdout: string): string | undefined {
	const observed = parseAgentBrowserVersionOutput(stdout);
	if (observed === TARGET_AGENT_BROWSER_VERSION) return undefined;
	return observed
		? `Installed agent-browser ${observed} does not match this extension's exact ${TARGET_AGENT_BROWSER_VERSION} capability baseline. Install ${TARGET_AGENT_BROWSER_VERSION_LABEL}, run pi-agent-browser-doctor, then reload Pi.`
		: `agent-browser --version returned an unrecognized value; expected exactly ${JSON.stringify(TARGET_AGENT_BROWSER_VERSION_LABEL)}. Run pi-agent-browser-doctor and install the exact supported upstream version.`;
}
