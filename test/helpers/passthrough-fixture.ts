export const stripWrapperPrefix = (args: readonly string[]): string[] => {
	const stripped = [...args];
	if (stripped[0] === "--allow-file-access") {
		stripped.splice(0, 2);
	}
	if (stripped[0] === "--json") {
		stripped.shift();
	}
	if (stripped[0] === "--namespace") {
		stripped.splice(0, 2);
	}
	if (stripped[0] === "--session") {
		stripped.splice(0, 2);
	}
	return stripped;
};

// The wrapper resolves the implicit root Pi session to a native named session and live-verifies the
// active page URL with a `get url` probe before page-content access. Explicit navigation, history or
// attachment transitions that themselves re-establish the target, tab selection/close, lifecycle
// closes, dialogs, and `get url` itself are exempt; everything else is probed first.
export const needsRootSessionPageCheck = (args: readonly string[]): boolean => {
	const command = args[0];
	const subcommand = args[1];
	if (command === "get") {
		return subcommand !== "url";
	}
	if (
		[
			"open",
			"goto",
			"navigate",
			"pushstate",
			"vitals",
			"web-vitals",
			"back",
			"forward",
			"reload",
			"connect",
			"close",
			"quit",
			"exit",
			"dialog",
		].includes(command)
	) {
		return false;
	}
	if (command === "state") {
		return subcommand !== "load";
	}
	if (command === "tab") {
		return subcommand === "new";
	}
	if (command === "diff") {
		return subcommand !== "url";
	}
	if (command === "record") {
		return subcommand !== "stop";
	}
	return true;
};
