import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { debugPolicyFailure } from "./browser-execution-policy-debug.js";
import { getErrorCode } from "./process-errors.js";

/*
 * Owner-held liveness endpoint for one published claim. The owner listens before publishing its
 * ticket and closes after removing the claim; the kernel closes it when the owner process exits.
 * A waiter may sleep on a connection to a confirmed-live predecessor with an immutable ticket
 * instead of re-probing native process identity. Every wake re-runs normal arbitration, and an
 * unavailable endpoint keeps the existing polling path.
 *
 * Windows keeps polling: a busy named pipe makes libuv wait in WaitNamedPipeW for up to 30 s on a
 * worker the caller cannot cancel (Node v24.22.2 deps/uv/src/win/pipe.c L828-836, L942-958).
 */
const endpointsSupported = process.platform !== "win32";
const MAX_TIMER_MS = 2_147_483_647;

/*
 * Kept short so typical Android/Termux coordination paths fit sun_path (108 bytes with its NUL in
 * Bionic and Linux, 104 on macOS); Node rejects longer paths instead of truncating them.
 */
function claimEndpointPath(claimPath: string, token: string): string {
	return join(dirname(claimPath), `.l-${token}`);
}
export interface ClaimEndpoint {
	readonly close: () => void;
}
export function openClaimEndpoint(claimPath: string, token: string): ClaimEndpoint | undefined {
	if (!endpointsSupported) {
		return undefined;
	}
	const server = createServer();
	const subscribers = new Set<Socket>();
	let closed = false;
	const close = (): void => {
		if (closed) {
			return;
		}
		closed = true;
		server.close();
		for (const subscriber of subscribers) {
			subscriber.destroy();
		}
		subscribers.clear();
	};
	server.on("connection", (subscriber) => {
		// Subscribers never keep an exiting owner alive; release destroys them after its callbacks drain.
		subscriber.unref();
		subscribers.add(subscriber);
		subscriber.on("error", () => {
			/* A departing subscriber ends only its own connection. */
		});
		subscriber.on("close", () => {
			subscribers.delete(subscriber);
		});
		subscriber.resume();
	});
	server.on("error", (error) => {
		debugPolicyFailure("endpoint.listen", "native-error", error);
		close();
	});
	server.unref();
	// Node binds and listens synchronously and reports failure on the next tick; too-long paths
	// fail instead of truncating (lib/net.js L2338-2412, src/pipe_wrap.cc L167).
	server.listen(claimEndpointPath(claimPath, token));
	return { close };
}
/** Owner endpoints disappear with their process; this removes the leftover name of a dead owner. */
export async function removeClaimEndpoint(claimPath: string, token: string): Promise<void> {
	if (!endpointsSupported) {
		return;
	}
	try {
		await unlink(claimEndpointPath(claimPath, token));
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			debugPolicyFailure("endpoint.unlink", "native-error", error);
		}
	}
}
export interface ClaimSubscription {
	readonly token: string;
	readonly connected: () => boolean;
	/** Resolves on disconnect, cancellation or the deadline; the caller re-runs arbitration. */
	readonly wait: (signal: AbortSignal | undefined, deadline: number) => Promise<void>;
	readonly close: () => void;
}
function sleep(
	signal: AbortSignal | undefined,
	deadline: number,
	setWake: (wake: (() => void) | undefined) => void,
): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(
			done,
			Math.max(0, Math.min(deadline - performance.now(), MAX_TIMER_MS)),
		);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			setWake(undefined);
			resolve();
		}
		setWake(done);
		signal?.addEventListener("abort", done, { once: true });
		if (signal?.aborted === true) {
			done();
		}
	});
}
/** Connect within the original budget; any failure leaves the caller on its polling path. */
export async function subscribeClaimEndpoint(
	claimPath: string,
	token: string,
	signal: AbortSignal | undefined,
	deadline: number,
): Promise<ClaimSubscription | undefined> {
	if (!endpointsSupported) {
		return undefined;
	}
	let connected = false;
	let disconnected = false;
	let wake: (() => void) | undefined;
	const open = (): boolean => connected && !disconnected;
	const setWake = (next: (() => void) | undefined): void => {
		wake = next;
	};
	const socket = createConnection(claimEndpointPath(claimPath, token));
	// Latch before connecting so a release or owner exit during later arbitration is never missed.
	socket.on("error", (error) => {
		if (!connected) {
			debugPolicyFailure("endpoint.connect", "unavailable", error);
		}
		disconnected = true;
		wake?.();
	});
	socket.on("close", () => {
		disconnected = true;
		wake?.();
	});
	socket.once("connect", () => {
		connected = true;
		wake?.();
	});
	await sleep(signal, deadline, setWake);
	if (!open()) {
		socket.destroy();
		return undefined;
	}
	// The owner never writes; flowing mode observes its EOF without application data.
	socket.resume();
	return {
		token,
		connected: open,
		wait: async (waitSignal, waitDeadline) => {
			if (!disconnected) {
				await sleep(waitSignal, waitDeadline, setWake);
			}
		},
		close: () => {
			wake = undefined;
			socket.destroy();
		},
	};
}
