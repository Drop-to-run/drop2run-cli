/**
 * Batch permits: several small files sent as one request (docs/briefs/UPLOAD-BATCH-BRIEF.md).
 *
 * The server packs small files into batches and signs, for each, the digest of a layout — one line
 * `<sha256> <size>\n` per file, in order. The client builds that same layout from the digests the server
 * returned and the sizes it measured, sends it at the head of the body, and follows it with each file's
 * bytes. If the two layouts differ by a byte the Worker refuses the batch, so the format is a contract
 * with `UploadBatchLayout` (C#) and `packages/edge/src/uploadBatch.ts`, held by a shared fixture at
 * `packages/edge/fixtures/batch-layout.json`. It is copied here rather than imported because core imports
 * nothing but `fflate`; the fixture is what keeps the copy honest.
 */

/** One file inside a batch, as the prepare endpoint returns it. */
export interface BatchFileRef {
	/** Normalized path, used to find the bytes and to name a failure. */
	readonly path: string;
	/** Lowercase hex SHA-256, which is also how the layout line is built. */
	readonly sha256: string;
}

/** One batch permit, as the prepare endpoint returns it. */
export interface UploadBatch {
	/** Bearer token authorising exactly these files. */
	readonly token: string;
	/** The files, in the order their bytes follow the layout. */
	readonly files: readonly BatchFileRef[];
}

/** What a batch upload answers with when the Worker accepted the request. */
export interface BatchResult {
	/** Files written now. */
	readonly stored: number;
	/** Files that were already on storage. */
	readonly present: number;
	/** Files not stored, by their index in the batch. */
	readonly failed: readonly { readonly i: number; readonly reason: string }[];
}

/**
 * Builds the layout for a batch.
 *
 * @param members Each file's digest and size, in the order their bytes will follow.
 * @returns The layout text, ASCII.
 */
export function batchLayout(
	members: readonly { readonly sha256: string; readonly size: number }[],
): string {
	return members.map((member) => `${member.sha256} ${member.size}\n`).join("");
}

/**
 * Whether an upload target is a batch rather than one file.
 *
 * @param target A target from the prepare response.
 * @returns True for a batch.
 */
export function isBatch(target: object): target is UploadBatch {
	return "files" in target;
}

/**
 * Reads a batch result, refusing anything that is not one.
 *
 * @param body The response text.
 * @returns The result, or null when the text is not a batch result.
 */
export function parseBatchResult(body: string): BatchResult | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return null;

		const { stored, present, failed } = parsed as Record<string, unknown>;
		if (typeof stored !== "number" || typeof present !== "number" || !Array.isArray(failed))
			return null;

		return { stored, present, failed: failed as BatchResult["failed"] };
	} catch {
		return null;
	}
}
