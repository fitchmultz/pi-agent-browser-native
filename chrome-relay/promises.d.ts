// ES2024 `Promise.withResolvers`, which chrome-relay/bridge.ts (vendored, see
// VENDOR.md) uses; the repo targets the ES2022 lib. Node ≥22 provides it at
// runtime, so only the type declaration is missing.
interface PromiseWithResolvers<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface PromiseConstructor {
	withResolvers<T>(): PromiseWithResolvers<T>;
}
