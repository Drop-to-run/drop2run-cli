import type { CollectedFile, ManifestFile } from "./types";

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
	// Copied into a fresh buffer: a Uint8Array may be a view onto a larger ArrayBuffer, and passing the
	// view's buffer directly would hash the whole thing.
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Hashes every collected file, reporting progress as it goes.
 *
 * Sequential on purpose: `crypto.subtle` is already native, and hashing in parallel on one thread only
 * adds scheduling overhead while making progress reporting jump around.
 *
 * @param files Files to hash.
 * @param onProgress Called after each file with how many are done.
 * @param signal Aborts between files.
 * @returns The same files with their checksums attached.
 */
export async function hashAll(
	files: readonly CollectedFile[],
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
): Promise<ManifestFile[]> {
	const hashed: ManifestFile[] = [];

	for (const [index, file] of files.entries()) {
		signal?.throwIfAborted();

		hashed.push({ ...file, sha256: await sha256Hex(file.bytes) });
		onProgress?.(index + 1, files.length);
	}

	return hashed;
}
