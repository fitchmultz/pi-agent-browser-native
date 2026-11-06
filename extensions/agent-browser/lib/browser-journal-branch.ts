import { isRecord } from "./parsing.js";
import type { BrowserBranchManager } from "./browser-journal-contracts.js";
export interface BrowserBranch {
	readonly sessionId: string;
	readonly anchorId: string | null;
	readonly append: (publish: () => void) => void;
	readonly isCurrent: () => boolean;
}
interface NativeEntry {
	readonly value: unknown;
	readonly parentId: string | null;
}
interface Endpoint {
	readonly entry: unknown;
	readonly parentId: string | null;
}
interface WalkResult {
	readonly current: boolean;
	readonly selected?: Endpoint | undefined;
	readonly anchor?: Endpoint | undefined;
}

/** An admitted branch follows native append-only identity/ancestry, never entry body snapshots. */
class CapturedBrowserBranch implements BrowserBranch {
	readonly sessionId: string;
	anchorId: string | null;
	private trackedAnchor: string | null;
	private validatedAnchor: Endpoint | undefined;
	private validatedLeaf: Endpoint | undefined;
	constructor(
		private readonly manager: BrowserBranchManager,
		private readonly isGenerationCurrent: () => boolean,
	) {
		this.sessionId = manager.getSessionId();
		this.anchorId = manager.getLeafId();
		this.trackedAnchor = this.anchorId;
	}
	append(publish: () => void): void {
		publish();
		if (this.anchorId === null) {
			this.anchorId = this.manager.getLeafId();
		}
	}
	isCurrent(): boolean {
		if (!this.isGenerationCurrent() || this.manager.getSessionId() !== this.sessionId) {
			return false;
		}
		if (this.anchorId !== this.trackedAnchor) {
			this.clearCache();
			this.trackedAnchor = this.anchorId;
		}
		const result = this.walk();
		// Native entries/parents are append-only. Cache only after validation to a root or cached endpoint.
		// ponytail: behind-host ancestor mutation without native reseed/generation is outside this contract; upgrade if Pi exposes ancestry revisions.
		if (result.current && result.selected) {
			this.validatedAnchor = result.anchor ?? this.validatedAnchor;
			this.validatedLeaf = result.selected;
		}
		return result.current;
	}
	private clearCache(): void {
		this.validatedAnchor = undefined;
		this.validatedLeaf = undefined;
	}
	private entry(leaf: string): NativeEntry {
		const entry = this.manager.getEntry(leaf);
		if (
			!isRecord(entry) ||
			entry.id !== leaf ||
			(entry.parentId !== null && typeof entry.parentId !== "string")
		) {
			throw new Error("Selected Pi journal ancestry is incomplete.");
		}
		return { value: entry, parentId: entry.parentId };
	}
	private cached(leaf: string): Endpoint | undefined {
		if (leaf === this.anchorId) {
			return this.validatedAnchor;
		}
		return leaf === (isRecord(this.validatedLeaf?.entry) ? this.validatedLeaf.entry.id : undefined)
			? this.validatedLeaf
			: undefined;
	}
	private validCache(leaf: string, entry: NativeEntry): boolean {
		const cached = this.cached(leaf);
		if (!cached) {
			return false;
		}
		// Keep indexed lookup: the native API also refreshes fork journal identity.
		if (cached.entry === entry.value && cached.parentId === entry.parentId) {
			return true;
		}
		this.clearCache();
		return false;
	}
	private walk(): WalkResult {
		let leaf = this.manager.getLeafId();
		// Empty selection is not a universal ancestor of independent roots.
		let current = this.anchorId === null && leaf === null;
		const seen = new Set<string>();
		let selected: Endpoint | undefined;
		let anchor: Endpoint | undefined;
		while (leaf !== null) {
			if (typeof leaf !== "string" || seen.has(leaf)) {
				throw new Error("Selected Pi journal ancestry is invalid or cyclic.");
			}
			seen.add(leaf);
			const entry = this.entry(leaf);
			selected ??= { entry: entry.value, parentId: entry.parentId };
			if (this.validCache(leaf, entry)) {
				current = true;
				break;
			}
			if (leaf === this.anchorId) {
				current = true;
				anchor = { entry: entry.value, parentId: entry.parentId };
			}
			leaf = entry.parentId;
		}
		return { current, selected, anchor };
	}
}
/** Capture before waiting: native branch selection precedes awaited session_tree handlers. */
export function captureBrowserBranch(
	manager: BrowserBranchManager,
	isGenerationCurrent: () => boolean,
): BrowserBranch {
	return new CapturedBrowserBranch(manager, isGenerationCurrent);
}
