import { getSuccessfulBatchCloseLifecycle } from "../batch-lifecycle.js";
import { getBrowserResultMessage } from "../browser-transcript.js";
import {
	extractExplicitNamespace,
	extractExplicitSessionName,
	deleteIdentityKeysInNamespace,
} from "../argv-grammar.js";
import { extractUpstreamCommandTokens } from "../runtime.js";
import { isCloseCommand, resultClosedNamespace } from "../command-taxonomy.js";
import { isSuccessfulNativeConfirmedClose } from "../read-confirmation.js";
import { isRecord } from "../parsing.js";
import { getSessionContextKey } from "./browser-run/session-state.js";
import { getCleanupResultClosedManagedSessionIdentities } from "./extension-electron-ownership.js";
import {
	getToolResultArgs,
	getSuccessfulToolResult,
	isAttachedBrowserInvocation,
} from "./extension-resource-replay.js";

interface AttachmentRow {
	readonly details: Readonly<Record<string, unknown>>;
	readonly succeeded: boolean;
	readonly batchCloseLifecycle: ReturnType<typeof getSuccessfulBatchCloseLifecycle>;
	readonly args: readonly string[];
	readonly namespace: string | undefined;
	readonly sessionName: string | undefined;
	readonly retainedFailedAttachment: boolean;
}
function parseAttachmentRow(entry: unknown): AttachmentRow | undefined {
	const message = getBrowserResultMessage(entry);
	const details = isRecord(message?.details) ? message.details : undefined;
	if (!message || !details) {
		return undefined;
	}
	const outcome = isRecord(details.managedSessionOutcome)
		? details.managedSessionOutcome
		: undefined;
	const args = getToolResultArgs(details);
	return {
		details,
		args,
		succeeded: getSuccessfulToolResult(details, message),
		batchCloseLifecycle: getSuccessfulBatchCloseLifecycle(details.batchSteps),
		namespace:
			typeof details.namespace === "string" ? details.namespace : extractExplicitNamespace(args),
		sessionName:
			typeof details.sessionName === "string"
				? details.sessionName
				: extractExplicitSessionName(args),
		retainedFailedAttachment:
			details.attachedBrowserSession === true && outcome?.activeAfter === true,
	};
}
class AttachmentReplay {
	readonly keys = new Set<string>();
	cleanupElectron(row: AttachmentRow): void {
		const electron = isRecord(row.details.electron) ? row.details.electron : undefined;
		const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
		for (const result of Array.isArray(cleanup?.results) ? cleanup.results : []) {
			for (const identity of getCleanupResultClosedManagedSessionIdentities(
				result,
				row.namespace,
			)) {
				this.keys.delete(
					getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
				);
			}
		}
	}
	restoreCloseAll(row: AttachmentRow): boolean {
		const tokens = extractUpstreamCommandTokens([...row.args]);
		if (!resultClosedNamespace(row.details, tokens, row.succeeded)) {
			return false;
		}
		deleteIdentityKeysInNamespace(this.keys, row.namespace);
		return true;
	}
	closesAttachment(row: AttachmentRow): boolean {
		if (row.batchCloseLifecycle?.endsClosed === true) {
			return true;
		}
		const tokens = extractUpstreamCommandTokens([...row.args]);
		const command = typeof row.details.command === "string" ? row.details.command : tokens[0];
		return (
			row.succeeded &&
			(isCloseCommand(command) || isSuccessfulNativeConfirmedClose(tokens, row.details.data))
		);
	}
	canRestore(row: AttachmentRow): boolean {
		return (
			row.succeeded || row.retainedFailedAttachment || row.batchCloseLifecycle?.endsClosed === true
		);
	}
	apply(row: AttachmentRow): void {
		this.cleanupElectron(row);
		if (this.restoreCloseAll(row)) {
			return;
		}
		if (!this.canRestore(row)) {
			return;
		}
		if (row.sessionName === undefined || row.sessionName === "") {
			return;
		}
		const key = getSessionContextKey(row.sessionName, row.namespace) ?? row.sessionName;
		if (this.closesAttachment(row)) {
			this.keys.delete(key);
		} else if (
			row.details.attachedBrowserSession === true ||
			isAttachedBrowserInvocation(row.args, {})
		) {
			this.keys.add(key);
		}
	}
}
export function restoreAttachedSessionKeysFromBranch(branch: readonly unknown[]): Set<string> {
	const replay = new AttachmentReplay();
	for (const entry of branch) {
		const row = parseAttachmentRow(entry);
		if (row) {
			replay.apply(row);
		}
	}
	return replay.keys;
}
