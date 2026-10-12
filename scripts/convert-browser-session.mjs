#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		output: { type: "string" },
		receipt: { type: "string" },
		"confirm-stopped": { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
});
if (values.help) {
	console.log(
		"Usage: pi-agent-browser-convert --source <retained.jsonl> --output <private-archive/copy.jsonl> --confirm-stopped [--receipt <new.json>]\nStop/quiesce the exact writer first. This offline command never starts Pi, a provider or a browser, never edits the source, and publishes only a separate private copy. Keep the destination outside automatic session discovery until explicitly selected. The receipt and each converted record identify the retained source checksum/byte range.",
	);
} else {
	try {
		if (!values.source || !values.output) {
			throw new Error(
				"--source and --output are required; use --help for the stopped-writer workflow.",
			);
		}
		const { convertBrowserSession } =
			await import("../dist/packaged/lib/browser-session-conversion.js");
		const receipt = await convertBrowserSession({
			source: values.source,
			destination: values.output,
			confirmedStopped: values["confirm-stopped"] === true,
		});
		console.log(JSON.stringify(receipt, null, 2));
		if (values.receipt) {
			await writeFile(values.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
