import { mapInOrder } from "./concurrency.js";
import {
	bytesOf,
	ClientErrorCode,
	type CollectedFile,
	DeployError,
	describeError,
	type ManifestFile,
	sizeOf,
} from "./types.js";

/**
 * Content hashing. The API rejects a manifest whose checksums are not lowercase hex SHA-256, and
 * Phase 2 uses the same hashes to skip re-uploading unchanged files.
 */

/**
 * Hashes bytes with SHA-256.
 *
 * @param bytes Content to hash.
 * @returns Lowercase hex digest, 64 characters.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// The view itself, not `bytes.buffer`: a Uint8Array may be a view onto a larger ArrayBuffer, and the
	// buffer would hash the whole thing. Web Crypto reads exactly the range a view covers, so no copy is
	// needed — the copy this used to take was a second full-size buffer per file, held for no reason.
	// The cast is about TypeScript only: `BufferSource` excludes views onto a SharedArrayBuffer, which
	// nothing here produces.
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);

	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Most files hashed at once. */
const HASH_CONCURRENCY = 4;

/**
 * Most bytes held for hashing at once.
 *
 * A file still on disk is read whole, hashed and let go, so what is in flight is what is in memory.
 * Sixteen MiB lets four small files overlap their reads while a large one still runs alone — the same
 * shape as the upload's byte budget, for the same reason: the browser that runs out of memory here
 * reports nothing, and the page then blames the drop.
 */
const HASH_BYTES_IN_FLIGHT = 16 * 1024 * 1024;

/**
 * Hashes every collected file, reporting progress as it goes.
 *
 * <b>Several at once, bounded by bytes.</b> This was sequential, on the reasoning that `crypto.subtle`
 * is already native and one file in memory at a time is the safe ceiling. Both halves hold for large
 * files and neither holds for many small ones: the time there is the read from disk, one after
 * another, and a twenty-thousand-file folder spent it twenty thousand times in a row
 * (docs/briefs/UPLOAD-BATCH-BRIEF.md §4.8). So small files overlap, up to {@link HASH_CONCURRENCY} and
 * {@link HASH_BYTES_IN_FLIGHT}, and a file larger than the budget waits until it can run alone — the
 * memory ceiling for large drops is what it was. The manifest still keeps the on-disk handle, not the
 * bytes, so the upload reads it again from disk.
 *
 * The result keeps the input's order. Progress counts files finished, so it still rises one at a time
 * even though they finish out of order.
 *
 * @param files Files to hash.
 * @param onProgress Called after each file with how many are done.
 * @param signal Stops starting new files once aborted.
 * @returns The same files with their checksums attached.
 * @throws DeployError When a file on disk can no longer be read.
 */
export async function hashAll(
	files: readonly CollectedFile[],
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
): Promise<ManifestFile[]> {
	const budget = byteBudget(HASH_BYTES_IN_FLIGHT);
	let done = 0;

	return mapInOrder(
		files,
		HASH_CONCURRENCY,
		async (file) => {
			const size = sizeOf(file.bytes);
			await budget.acquire(size);

			try {
				signal?.throwIfAborted();

				const hashed: ManifestFile = { ...file, sha256: await sha256Hex(await readForHash(file)) };

				done += 1;
				onProgress?.(done, files.length);

				return hashed;
			} finally {
				budget.release(size);
			}
		},
		signal,
	);
}

/**
 * A count of bytes that callers reserve before reading and return after.
 *
 * One reservation is always admitted when nothing else is held, so a file larger than the whole budget
 * runs — alone — instead of waiting for ever.
 *
 * @param limit Most bytes held at once.
 * @returns The two operations.
 */
function byteBudget(limit: number): {
	acquire: (size: number) => Promise<void>;
	release: (size: number) => void;
} {
	let held = 0;
	let waiting: Array<() => void> = [];

	return {
		async acquire(size) {
			while (held > 0 && held + size > limit) {
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			held += size;
		},
		release(size) {
			held -= size;
			const woken = waiting;
			waiting = [];
			for (const wake of woken) wake();
		},
	};
}

/**
 * Reads one file's bytes for hashing, naming the file when that fails.
 *
 * A file from a dropped folder is read for the first time here, so this is where one that was moved,
 * renamed or deleted after the drop surfaces. The browser reports that as a `NotReadableError` that
 * names no file, and an upload error built from it would send somebody looking at their network.
 *
 * @param file The file to read.
 * @returns Its bytes.
 * @throws DeployError When it cannot be read.
 */
async function readForHash(file: CollectedFile): Promise<Uint8Array> {
	try {
		return await bytesOf(file.bytes);
	} catch (error) {
		// Not a read failure: the browser could not allocate the buffer, and the pipeline has its own
		// message for that.
		if (error instanceof RangeError) throw error;

		throw new DeployError(
			ClientErrorCode.ReadFailed,
			`Could not read ${file.path}. It may have been moved, renamed or changed since you dropped it — drop the folder again.`,
			{ path: file.path, cause: describeError(error) },
		);
	}
}
