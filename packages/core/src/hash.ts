import {
	bytesOf,
	ClientErrorCode,
	type CollectedFile,
	DeployError,
	describeError,
	type ManifestFile,
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

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Hashes every collected file, reporting progress as it goes.
 *
 * Sequential on purpose: `crypto.subtle` is already native, and hashing in parallel on one thread only
 * adds scheduling overhead while making progress reporting jump around. It also bounds memory: a file
 * still on disk is read here, hashed and let go, so only one is ever held — and the manifest keeps the
 * on-disk handle, not the bytes, so the upload reads it again from disk.
 *
 * @param files Files to hash.
 * @param onProgress Called after each file with how many are done.
 * @param signal Aborts between files.
 * @returns The same files with their checksums attached.
 * @throws DeployError When a file on disk can no longer be read.
 */
export async function hashAll(
	files: readonly CollectedFile[],
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
): Promise<ManifestFile[]> {
	const hashed: ManifestFile[] = [];

	for (const [index, file] of files.entries()) {
		signal?.throwIfAborted();

		hashed.push({ ...file, sha256: await sha256Hex(await readForHash(file)) });
		onProgress?.(index + 1, files.length);
	}

	return hashed;
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
