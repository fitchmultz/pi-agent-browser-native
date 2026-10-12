import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { scanJournalMetadata } from "./browser-journal-reader.js";
import { getErrorCode } from "./process-errors.js";
import { BrowserConversionWriter, sourceChecksum } from "./browser-session-conversion-stream.js";
export { convertLegacyBrowserEntry, convertBrowserEntries } from "./browser-legacy-projection.js";
export interface BrowserConversionReceipt {
	readonly version: 1;
	readonly source: string;
	readonly destination: string;
	readonly sessionId: string;
	readonly sourceSha256: string;
	readonly destinationSha256: string;
	readonly entryCount: number;
	readonly convertedRecords: number;
	readonly snapshotDefinitions: number;
	readonly sourceBytes: number;
	readonly destinationBytes: number;
}
interface ConversionOptions {
	readonly source: string;
	readonly destination: string;
	readonly confirmedStopped: boolean;
}
async function validateConversionPaths(
	options: ConversionOptions,
): Promise<
	Readonly<{ source: string; destination: string; directory: string; sourceStat: Stats }>
> {
	if (!options.confirmedStopped) {
		throw new Error(
			"Stop/quiesce the exact session writer first, then pass --confirm-stopped. Conversion never stops a session.",
		);
	}
	const source = resolve(options.source);
	const destination = resolve(options.destination);
	if (source === destination) {
		throw new Error("Conversion requires a separate destination; originals are never rewritten.");
	}
	const sourceStat = await lstat(source);
	if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
		throw new Error("Conversion source must be a regular file, not a symlink.");
	}
	const directory = dirname(destination);
	await mkdir(directory, { mode: 0o700, recursive: true });
	await validateDestination(directory, destination);
	return { source, destination, directory, sourceStat };
}
async function validateDestination(directory: string, destination: string): Promise<void> {
	const entry = await lstat(directory);
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		(process.platform !== "win32" &&
			(entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0))
	) {
		throw new Error(
			"Conversion destination must be a private current-user directory (0700 on POSIX), without symlinks.",
		);
	}
	try {
		await lstat(destination);
		throw new Error("Conversion destination is occupied.");
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") {
			throw error;
		}
	}
}
async function verifySourceUnchanged(
	file: FileHandle,
	source: string,
	initial: Stats,
	checksum: string,
): Promise<void> {
	const final = await file.stat();
	const finalPath = await lstat(source);
	if (
		final.dev !== initial.dev ||
		final.ino !== initial.ino ||
		final.size !== initial.size ||
		final.mtimeMs !== initial.mtimeMs ||
		finalPath.dev !== initial.dev ||
		finalPath.ino !== initial.ino ||
		(await sourceChecksum(file, initial.size)) !== checksum
	) {
		throw new Error("Conversion source changed; no destination was published.");
	}
}
async function syncPublishedDirectory(directory: string): Promise<void> {
	const parent = await open(directory, constants.O_RDONLY);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
/** Separate-copy publication only. The operator must quiesce the exact writer first. */
export async function convertBrowserSession(
	options: ConversionOptions,
): Promise<BrowserConversionReceipt> {
	const { source, destination, directory, sourceStat } = await validateConversionPaths(options);
	const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	const stagePath = `${destination}.${randomUUID()}.tmp`;
	let stage: FileHandle | undefined;
	let published = false;
	try {
		const initial = await file.stat();
		if (initial.dev !== sourceStat.dev || initial.ino !== sourceStat.ino) {
			throw new Error("Conversion source changed before capture.");
		}
		const checksum = await sourceChecksum(file, initial.size);
		const metadata = await scanJournalMetadata(file, initial.size, true);
		const header = metadata.at(0);
		if (
			header === undefined ||
			header.value.type !== "session" ||
			typeof header.value.id !== "string"
		) {
			throw new Error("Conversion source has no native session header.");
		}
		stage = await open(stagePath, "wx+", 0o600);
		const writer = new BrowserConversionWriter(
			file,
			stage,
			{ sessionId: header.value.id, checksum },
			metadata,
		);
		for (const entry of metadata) {
			// Native ancestry and output byte ordering require each entry to finish before the next.
			// oxlint-disable-next-line no-await-in-loop
			await writer.write(entry, initial.size);
		}
		await stage.sync();
		const output = await stage.stat();
		const destinationSha256 = await sourceChecksum(stage, output.size);
		await verifySourceUnchanged(file, source, initial, checksum);
		await stage.close();
		stage = undefined;
		await link(stagePath, destination); // Exclusive publication; never overwrite an existing destination.
		published = true;
		return {
			version: 1,
			source,
			destination,
			sessionId: header.value.id,
			sourceSha256: checksum,
			destinationSha256,
			...writer.counts,
			sourceBytes: initial.size,
			destinationBytes: output.size,
		};
	} finally {
		await stage?.close();
		await file.close();
		await unlink(stagePath).catch((error: unknown) => {
			if (getErrorCode(error) !== "ENOENT") {
				throw error;
			}
		});
		if (published && process.platform !== "win32") {
			await syncPublishedDirectory(directory);
		}
	}
}
