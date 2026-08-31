import { ClientErrorCode, DeployError, type ManifestFile } from "./types.js";

/**
 * Uploads files straight to R2 through presigned URLs.
 *
 * The bytes never pass through the API, which is why a large deploy costs the control plane nothing.
 * The flip side is that this code owns retry and concurrency itself.
 */

/** How many uploads run at once. */
const DEFAULT_CONCURRENCY = 8;

/** How many times one file is retried before the deploy fails. */
const DEFAULT_RETRIES = 3;

/** Backoff before each retry, in milliseconds. */
const BACKOFF_MS = [1000, 2000, 4000];

/** Where one file must be PUT, as returned by the prepare endpoint. */
export interface UploadTarget {
	/** Normalized path, matching the manifest entry. */
	readonly path: string;
	/** Presigned URL accepting exactly one PUT of this object. */
	readonly url: string;
	/**
	 * Lowercase hex SHA-256 signed into {@link url}, echoed back by the server.
	 *
	 * The PUT must carry it as `x-amz-checksum-sha256`, base64-encoded, or the signature does not
	 * match and storage rejects the request. It is the same digest this client sent in the manifest.
	 */
	readonly sha256: string;
}

/** Injectable dependencies, so tests need neither a network nor real backoff delays. */
export interface UploadDeps {
	/** Performs the request. Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Waits before a retry. Defaults to a real timer. */
	readonly delay?: (ms: number) => Promise<void>;
	/** How many uploads run at once. */
	readonly concurrency?: number;
	/** How many times one file is retried. */
	readonly retries?: number;
}

/**
 * Uploads every file, reporting progress as each one lands.
 *
 * @param targets Presigned targets from the prepare endpoint.
 * @param files The hashed manifest, used to find the bytes for each target.
 * @param onProgress Called after each successful upload with counts and cumulative bytes.
 * @param signal Cancels in-flight and queued uploads.
 * @param deps Overrides for testing.
 * @throws DeployError When a file still fails after every retry, or when cancelled.
 */
export async function uploadAll(
	targets: readonly UploadTarget[],
	files: readonly ManifestFile[],
	onProgress?: (done: number, total: number, bytes: number) => void,
	signal?: AbortSignal,
	deps: UploadDeps = {},
): Promise<void> {
	const doFetch = deps.fetch ?? globalFetch();
	const delay = deps.delay ?? defaultDelay;
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const retries = deps.retries ?? DEFAULT_RETRIES;

	const byPath = new Map(files.map((file) => [file.path, file]));

	let nextIndex = 0;
	let done = 0;
	let uploadedBytes = 0;

	/** Takes targets off the shared queue until it is empty. */
	const worker = async (): Promise<void> => {
		for (;;) {
			// Reading and incrementing without a lock is safe: JavaScript runs one task at a time, so no
			// two workers can observe the same index.
			const index = nextIndex++;
			const target = targets[index];
			if (target === undefined) return;

			signal?.throwIfAborted();

			const file = byPath.get(target.path);
			if (file === undefined) {
				throw new DeployError(
					ClientErrorCode.UploadFailed,
					`The server asked for ${target.path}, which is not in the manifest.`,
					{ path: target.path },
				);
			}

			await uploadOne(target, file, { doFetch, delay, retries, signal });

			done += 1;
			uploadedBytes += file.bytes.length;
			onProgress?.(done, targets.length, uploadedBytes);
		}
	};

	const workers = Array.from(
		{ length: Math.min(concurrency, targets.length) },
		worker,
	);

	try {
		await Promise.all(workers);
	} catch (error) {
		// One failure means the deploy cannot complete, so surface the first and let the rest settle.
		throw asDeployError(error);
	}
}

/**
 * Uploads one file, retrying with backoff.
 *
 * @param target Where to PUT it.
 * @param file The file to send.
 * @param context Resolved dependencies and the cancellation signal.
 * @throws DeployError When every attempt failed.
 */
async function uploadOne(
	target: UploadTarget,
	file: ManifestFile,
	context: {
		doFetch: typeof fetch;
		delay: (ms: number) => Promise<void>;
		retries: number;
		// Explicitly `| undefined` rather than optional: exactOptionalPropertyTypes distinguishes an
		// absent property from one set to undefined, and the caller always passes the key.
		signal: AbortSignal | undefined;
	},
): Promise<void> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= context.retries; attempt++) {
		context.signal?.throwIfAborted();

		if (attempt > 0) {
			// Last entry repeats if retries were configured higher than the backoff table.
			await context.delay(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 1000);
			context.signal?.throwIfAborted();
		}

		try {
			const response = await context.doFetch(target.url, {
				method: "PUT",
				body: new Blob([file.bytes.slice().buffer]),
				// Signed into the URL, so this is not optional: storage checks the bytes against it and
				// rejects the PUT if they disagree. `Content-Length` is signed too but cannot be set
				// here — it is a forbidden header name, and the browser derives it from the body, which
				// is exactly the value the server signed.
				headers: { "x-amz-checksum-sha256": toBase64Digest(target.sha256) },
				...(context.signal ? { signal: context.signal } : {}),
			});

			if (response.ok) return;

			// A rejected signature or an expired URL will not start working, so stop early rather than
			// spending three retries on it.
			if (response.status === 403 || response.status === 401) {
				throw new DeployError(
					ClientErrorCode.UploadFailed,
					`Upload of ${target.path} was rejected by storage. The upload window may have expired — try deploying again.`,
					{ path: target.path, status: response.status },
				);
			}

			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			if (error instanceof DeployError) throw error;
			if (isAbort(error)) throw cancelled();

			lastError = error;
		}
	}

	throw new DeployError(
		ClientErrorCode.UploadFailed,
		`Could not upload ${target.path} after ${context.retries + 1} attempts.`,
		{ path: target.path, cause: String(lastError) },
	);
}

/**
 * Re-encodes a hex SHA-256 as the base64 form the S3 checksum header carries.
 *
 * The manifest, the API and this pipeline all speak lowercase hex; only the storage wire format wants
 * base64, so the conversion stays here at the edge rather than changing what the manifest holds.
 *
 * @param sha256Hex Lowercase hex digest of 64 characters.
 * @returns The same 32 bytes, base64-encoded.
 */
function toBase64Digest(sha256Hex: string): string {
	const bytes = new Uint8Array(sha256Hex.length / 2);

	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(sha256Hex.slice(i * 2, i * 2 + 2), 16);
	}

	return btoa(String.fromCharCode(...bytes));
}

/**
 * The global `fetch`, kept callable.
 *
 * `globalThis.fetch` must not simply be assigned to a variable: browsers require `window` as the
 * receiver and throw `TypeError: Illegal invocation` when it is called detached. Node's fetch does not
 * care, so this fails only in a browser and no amount of unit testing under node would have caught it.
 *
 * @returns A bound reference safe to store and call later.
 */
function globalFetch(): typeof fetch {
	return globalThis.fetch.bind(globalThis);
}

/**
 * Waits, for real.
 *
 * @param ms Milliseconds to wait.
 */
function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a thrown value is an abort rather than a genuine failure.
 *
 * @param error The thrown value.
 * @returns True for an abort.
 */
export function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	);
}

/** Builds the error used when the user cancels. */
export function cancelled(): DeployError {
	return new DeployError(ClientErrorCode.Cancelled, "Deploy cancelled.");
}

/**
 * Normalizes anything thrown during upload into a {@link DeployError}.
 *
 * @param error The thrown value.
 * @returns A DeployError describing it.
 */
export function asDeployError(error: unknown): DeployError {
	if (error instanceof DeployError) return error;
	if (isAbort(error)) return cancelled();

	return new DeployError(
		ClientErrorCode.UploadFailed,
		error instanceof Error ? error.message : "Upload failed.",
		error,
	);
}
