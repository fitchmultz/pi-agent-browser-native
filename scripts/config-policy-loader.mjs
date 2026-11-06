/** Resolve the same config policy from a checkout or its standalone packaged bundle. */
import { existsSync } from "node:fs";

export async function loadConfigPolicyModule() {
	const sourcePolicyUrl = new URL(
		"../extensions/agent-browser/lib/config-policy.js",
		import.meta.url,
	);
	if (existsSync(sourcePolicyUrl)) {
		return import("../extensions/agent-browser/lib/config-policy.js");
	}
	return import("../dist/packaged/lib/config-policy.js");
}
