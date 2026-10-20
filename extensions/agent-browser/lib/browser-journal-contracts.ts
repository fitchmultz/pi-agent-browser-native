/** Public read-only identity/ancestry used to admit a browser operation. Entry bodies cross a validation boundary. */
export interface BrowserBranchManager {
	readonly getSessionId: () => string;
	readonly getLeafId: () => string | null;
	readonly getEntry: (id: string) => unknown;
}
/** Published replay additionally inspects the native locator and raw envelopes, not writable SDK internals. */
export interface BrowserJournalManager extends BrowserBranchManager {
	readonly getEntries: () => unknown[];
	readonly getSessionFile: () => string | undefined;
	readonly getHeader: () => Readonly<{ id: string; parentSession?: string }> | null;
}
