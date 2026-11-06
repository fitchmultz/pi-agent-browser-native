import { normalizeProcessError } from "./process-errors.js";
import { openSecureTempFile, writeSecureTempChunk } from "./temp.js";

const MAX_BUFFERED_STDOUT_BYTES = 512 * 1_024;
const MAX_BUFFERED_STDOUT_TAIL_CHARS = 32_000;

export function appendProcessOutputTail(text: string, addition: string, maxChars: number): string {
	const combined = text + addition;
	return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

/** Own buffered output, sequential spill writes and the spill handle through subprocess completion. */
export class ProcessStdout {
	private buffers: Buffer[] = [];
	private bufferedBytes = 0;
	private tail = "";
	private handle: Awaited<ReturnType<typeof openSecureTempFile>>["fileHandle"] | undefined;
	private spillPath: string | undefined;
	private spillPending = false;
	private pendingWrite = Promise.resolve();
	private spillError: Error | undefined;

	queue(buffer: Buffer): void {
		this.tail = appendProcessOutputTail(
			this.tail,
			buffer.toString("utf8"),
			MAX_BUFFERED_STDOUT_TAIL_CHARS,
		);
		if (this.spillError) {
			return;
		}
		if (
			!this.spillPending &&
			this.spillPath === undefined &&
			this.bufferedBytes + buffer.length <= MAX_BUFFERED_STDOUT_BYTES
		) {
			this.buffers.push(buffer);
			this.bufferedBytes += buffer.length;
			return;
		}
		this.spillPending = true;
		this.pendingWrite = this.pendingWrite
			.then(() => this.write(buffer))
			.catch((error: unknown) => {
				this.spillError = normalizeProcessError(error);
			});
	}

	private async write(buffer: Buffer): Promise<void> {
		if (this.spillError) {
			return;
		}
		if (!this.handle || this.spillPath === undefined) {
			const file = await openSecureTempFile("process-stdout", ".json");
			this.handle = file.fileHandle;
			this.spillPath = file.path;
			if (this.buffers.length > 0) {
				await writeSecureTempChunk({
					content: Buffer.concat(this.buffers),
					fileHandle: this.handle,
					path: this.spillPath,
				});
				this.buffers = [];
				this.bufferedBytes = 0;
			}
		}
		await writeSecureTempChunk({ content: buffer, fileHandle: this.handle, path: this.spillPath });
	}

	async drain(): Promise<void> {
		await this.pendingWrite;
	}

	async finish(): Promise<{
		readonly stdout: string;
		readonly stdoutSpillPath?: string | undefined;
		readonly error?: Error | undefined;
	}> {
		await this.pendingWrite;
		if (this.handle) {
			await this.handle.close().catch(() => {
				/* Spill close is best-effort after all writes settled. */
			});
		}
		return {
			stdout:
				this.spillPath === undefined ? Buffer.concat(this.buffers).toString("utf8") : this.tail,
			stdoutSpillPath: this.spillPath,
			error: this.spillError,
		};
	}
}
