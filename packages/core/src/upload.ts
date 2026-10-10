import { batchLayout, isBatch, parseBatchResult, type UploadBatch } from "./batch.js";
import {
	ClientErrorCode,
	DeployError,
	describeError,
	type FileContent,
	type ManifestFile,
	sizeOf,
} from "./types.js";

/**
 * Uploads files to the upload Worker, which streams them to R2 from the nearest edge.
 *
 * The bytes never pass through the API, which is why a large deploy costs the control plane nothing.
 * The flip side is that this code owns retry and concurrency itself.
 *
 * Every file goes to the same URL. What may be written is decided entirely by the signed permit in the
 * Authorization header — key, length and digest are all inside it — so there is no address here for a
 * client to alter and nothing for it to sign.
 */

/** How many uploads run at once. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Most bytes in flight at once, across every upload in the pool.
 *
 * Eight at a time is right for a site of small pages and wrong for a drop of large files: eight 50 MB
 * uploads is 400 MB the browser holds in request buffers on top of the files themselves, which is
 * where a phone tab dies. With this, small files still go eight at a time and large ones go one or two
 * at a time. A file larger than the whole budget still goes, on its own — refusing it would fail a
 * deploy the plan allows.
 */
const DEFAULT_BYTES_IN_FLIGHT = 64 * 1024 * 1024;

/** How many times one file is retried before the deploy fails. */
const DEFAULT_RETRIES = 3;

/** Backoff before each retry, in milliseconds. */
const BACKOFF_MS = [1000, 2000, 4000];

/**
 * How long an upload may go without sending a byte, or without an answer once everything is sent,
 * before it is abandoned and retried.
 *
 * A connection that dies quietly — a laptop changing networks, a captive portal, a proxy that drops
 * the socket without a reset — leaves a request open with nothing moving through it. Without a limit
 * that request never settles, so the deploy never fails and never finishes: the state somebody
 * dropping a 200 MB zip described as "stuck, no idea whether it worked". Thirty seconds is long enough
 * that a slow but live connection always shows progress inside it, since the browser reports sent
 * bytes many times a second.
 */
const DEFAULT_STALL_MS = 30_000;

/**
 * Shortest gap between two byte-progress reports.
 *
 * The browser reports sent bytes for every chunk, from up to eight uploads at once. Forwarding each
 * one would be thousands of `postMessage` calls and React renders a second for a number nobody can
 * read that fast. A file finishing is always reported at once, whatever this says.
 */
const PROGRESS_INTERVAL_MS = 200;

/**
 * Sends one upload and resolves with the HTTP status.
 *
 * Separate from {@link UploadDeps.fetch} because `fetch` cannot report upload progress: its body is
 * opaque until the response arrives, so a 50 MB file is invisible for as long as it takes to send.
 */
export type PutTransport = (request: PutRequest) => Promise<number | PutResponse>;

/**
 * A transport's answer when the caller asked for the body ({@link PutRequest.wantsBody}).
 *
 * A single upload only needs the status. A batch answers with what it stored, and that is in the body.
 */
export interface PutResponse {
	/** HTTP status. */
	readonly status: number;
	/** The response body as text. */
	readonly body: string;
}

/** What a {@link PutTransport} is asked to send. */
export interface PutRequest {
	/** The upload endpoint. */
	readonly url: string;
	/** The permit, sent as a bearer token. */
	readonly token: string;
	/** The file's contents: in memory, or a `Blob` the runtime streams from disk as it sends. */
	readonly body: FileContent;
	/** Cancels the request. */
	readonly signal: AbortSignal | undefined;
	/** Called with how many bytes of the body have been sent, where the transport can tell. */
	readonly onSent: (bytes: number) => void;
	/** Idle time after which the transport gives up with a {@link StalledError}. */
	readonly stallMs: number;
	/** Whether the response body is needed, as it is for a batch. */
	readonly wantsBody?: boolean;
}

/** Raised by a transport whose request stopped moving for longer than the stall limit. */
export class StalledError extends Error {
	/** @param seconds How long nothing moved. */
	constructor(seconds: number) {
		super(`No data moved for ${seconds}s.`);
		this.name = "StalledError";
	}
}

/** One file's upload permit, as returned by the prepare endpoint. */
export interface UploadTarget {
	/** Normalized path, matching the manifest entry. */
	readonly path: string;
	/**
	 * Bearer token authorising exactly this object.
	 *
	 * Signed by the control plane and verified by the upload Worker, which holds per-deploy state and
	 * refuses a second write of the same key without touching R2. That refusal is why the token
	 * replaced a presigned URL: R2 honoured those with nobody in between, so every replay was billed.
	 */
	readonly token: string;
	/**
	 * Lowercase hex SHA-256 of this file, echoed back by the server.
	 *
	 * Not sent as a header — it is inside the token, and R2 verifies the body against it on write. It
	 * is here so a client can match a target back to the bytes it hashed without a second index.
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
	/** Most bytes in flight at once. See {@link DEFAULT_BYTES_IN_FLIGHT}. */
	readonly maxBytesInFlight?: number;
	/** How many times one file is retried. */
	readonly retries?: number;
	/**
	 * Sends one request. Defaults to `XMLHttpRequest` where one exists — a browser page or Worker —
	 * because it is the only browser API that reports upload progress, and to {@link fetch} elsewhere.
	 * Passing `fetch` without `put` selects the fetch transport, which is what every test written
	 * before this option relies on.
	 */
	readonly put?: PutTransport;
	/** Idle limit before an upload is retried. See {@link DEFAULT_STALL_MS}. */
	readonly stallMs?: number;
	/** Clock for throttling progress reports. Defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * Receives one file's retry, before the backoff that precedes it.
 *
 * @param path The file being retried.
 * @param attempt The attempt about to start, counting the first as 1.
 * @param attempts Every attempt the file gets.
 * @param stalled Whether the previous attempt stalled rather than failed.
 */
export type RetryListener = (
	path: string,
	attempt: number,
	attempts: number,
	stalled: boolean,
) => void;

/**
 * Uploads every file, reporting progress as each one lands and, where the transport can see it, as
 * bytes leave.
 *
 * @param targets Upload permits from the prepare endpoint.
 * @param uploadUrl The one endpoint every permit is presented to, also from the prepare endpoint.
 * @param files The hashed manifest, used to find the bytes for each target.
 * @param onProgress Called after each successful upload with counts, bytes sent, and the path that just
 * landed; and, no more often than every {@link PROGRESS_INTERVAL_MS}, while files are in flight, with
 * no path. `bytes` counts the in-flight part of each file, so it moves during a large upload.
 * @param signal Cancels in-flight and queued uploads.
 * @param deps Overrides for testing.
 * @param onRetry Told before a file is tried again, so a caller can say why the numbers paused.
 * @throws DeployError When a file still fails after every retry, or when cancelled.
 */
export async function uploadAll(
	targets: readonly (UploadTarget | UploadBatch)[],
	uploadUrl: string,
	files: readonly ManifestFile[],
	onProgress?: (done: number, total: number, bytes: number, path?: string) => void,
	signal?: AbortSignal,
	deps: UploadDeps = {},
	onRetry?: RetryListener,
): Promise<void> {
	const put = deps.put ?? defaultTransport(deps.fetch);
	const delay = deps.delay ?? defaultDelay;
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const retries = deps.retries ?? DEFAULT_RETRIES;
	const stallMs = deps.stallMs ?? DEFAULT_STALL_MS;
	const now = deps.now ?? Date.now;
	const maxBytesInFlight = deps.maxBytesInFlight ?? DEFAULT_BYTES_IN_FLIGHT;

	const byPath = new Map(files.map((file) => [file.path, file]));
	// Files, not targets: a batch is one target and many files, and progress is counted in files.
	const fileCount = targets.reduce(
		(sum, target) => sum + (isBatch(target) ? target.files.length : 1),
		0,
	);

	let nextIndex = 0;
	let done = 0;
	// Set by the first upload to fail for good. The deploy is lost at that point, so the rest of the
	// pool stops taking new files rather than spending minutes uploading what can never be published.
	let failed = false;
	// That first failure, kept so it is the one reported: the uploads it cancels fail too, a moment
	// later, and whichever settled first used to decide what the user was told.
	let firstFailure: unknown;

	// Every upload runs under this rather than under the caller's signal, so a failure can stop the ones
	// still in flight. Stopping only new files was not enough: an upload already on the wire carried on,
	// and when it landed after the failure it reported progress — which the page read as the deploy
	// being alive again, until the watchdog called a finished Worker dead (UPLOAD-BATCH-BRIEF §2.3).
	//
	// Linked by hand rather than with `AbortSignal.any`: the CLI and MCP run on Node 20, which gained
	// `any` only in 20.3.
	const local = new AbortController();
	const forward = (): void => local.abort(signal?.reason);
	if (signal?.aborted) local.abort(signal.reason);
	else signal?.addEventListener("abort", forward, { once: true });
	const inner = local.signal;

	/**
	 * Records the first failure and stops everything still running.
	 *
	 * @param error What failed.
	 */
	const fail = (error: unknown): void => {
		if (failed) return;
		failed = true;
		firstFailure = error;
		local.abort();
	};

	// The byte budget: what uploads in flight have reserved, and the workers waiting for room.
	let reserved = 0;
	let waiting: Array<() => void> = [];

	/**
	 * Waits until a file of this size fits the budget, then reserves it.
	 *
	 * @param size Bytes the upload will hold.
	 */
	const acquire = async (size: number): Promise<void> => {
		while (reserved > 0 && reserved + size > maxBytesInFlight) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		reserved += size;
	};

	/**
	 * Returns a reservation and wakes every waiter to try again.
	 *
	 * @param size Bytes that were reserved.
	 */
	const release = (size: number): void => {
		reserved -= size;
		const woken = waiting;
		waiting = [];
		for (const wake of woken) wake();
	};
	// Bytes of files that have landed, plus — separately, because an attempt can be abandoned and its
	// bytes then stop counting — what each upload still in flight has sent so far.
	let landedBytes = 0;
	const inFlight = new Map<number, number>();
	let lastReport = Number.NEGATIVE_INFINITY;

	/**
	 * Reports the current totals. A file landing always reports; byte movement is throttled.
	 *
	 * @param path The file that just landed, or undefined for a byte-progress report.
	 */
	const report = (path?: string): void => {
		// Nothing after a failure. The deploy has already been reported as failed, and a count that moves
		// afterwards tells the page the opposite.
		if (onProgress === undefined || failed) return;

		const at = now();
		if (path === undefined && at - lastReport < PROGRESS_INTERVAL_MS) return;
		lastReport = at;

		let bytes = landedBytes;
		for (const sent of inFlight.values()) bytes += sent;

		onProgress(done, fileCount, bytes, path);
	};

	/** Takes targets off the shared queue until it is empty. */
	const worker = async (): Promise<void> => {
		for (;;) {
			if (failed) return;

			// Reading and incrementing without a lock is safe: JavaScript runs one task at a time, so no
			// two workers can observe the same index.
			const index = nextIndex++;
			const target = targets[index];
			if (target === undefined) return;

			inner.throwIfAborted();

			// A batch is several files and a single target is one; past this point both are a list of the
			// files to send, so counting, the byte budget and reporting are the same code for either.
			const refs = isBatch(target) ? target.files : [target];
			const members: ManifestFile[] = [];

			for (const ref of refs) {
				const file = byPath.get(ref.path);
				if (file === undefined) {
					const missing = new DeployError(
						ClientErrorCode.UploadFailed,
						`The server asked for ${ref.path}, which is not in the manifest.`,
						{ path: ref.path },
					);
					fail(missing);
					throw missing;
				}
				members.push(file);
			}

			const layout = isBatch(target)
				? new TextEncoder().encode(
						batchLayout(
							target.files.map((ref, i) => ({
								sha256: ref.sha256,
								size: sizeOf((members[i] as ManifestFile).bytes),
							})),
						),
					)
				: null;
			const size = members.reduce((sum, file) => sum + sizeOf(file.bytes), layout?.length ?? 0);
			const label = (members[0] as ManifestFile).path;
			await acquire(size);

			try {
				// Checked again after the wait: the deploy may have failed or been cancelled meanwhile.
				if (failed) return;
				inner.throwIfAborted();

				const context = {
					put,
					delay,
					retries,
					signal: inner,
					uploadUrl,
					stallMs,
					onSent: (sent: number) => {
						inFlight.set(index, sent);
						report();
					},
					onRetry: (attempt: number, stalled: boolean) => {
						// The abandoned attempt's bytes are not on the server, so they stop counting.
						inFlight.set(index, 0);
						onRetry?.(label, attempt, retries + 1, stalled);
					},
				};

				if (isBatch(target) && layout !== null)
					await uploadBatchOne(target, members, layout, context);
				else await uploadOne(target as UploadTarget, members[0] as ManifestFile, context);
			} catch (error) {
				fail(error);
				throw error;
			} finally {
				release(size);
			}

			inFlight.delete(index);
			done += members.length;
			landedBytes += size;
			report((members.at(-1) as ManifestFile).path);
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker);

	try {
		await Promise.all(workers);
	} catch (error) {
		// One failure means the deploy cannot complete. The first one is what happened; the rest are the
		// uploads it cancelled.
		throw asDeployError(firstFailure ?? error);
	} finally {
		signal?.removeEventListener("abort", forward);
	}
}

/**
 * Uploads one file, retrying with backoff.
 *
 * @param target Where to PUT it.
 * @param file The file to send.
 * @param context Resolved dependencies, the cancellation signal, and the two listeners.
 * @throws DeployError When every attempt failed.
 */
async function uploadOne(
	target: UploadTarget,
	file: ManifestFile,
	context: {
		put: PutTransport;
		delay: (ms: number) => Promise<void>;
		retries: number;
		// Explicitly `| undefined` rather than optional: exactOptionalPropertyTypes distinguishes an
		// absent property from one set to undefined, and the caller always passes the key.
		signal: AbortSignal | undefined;
		uploadUrl: string;
		stallMs: number;
		onSent: (bytes: number) => void;
		onRetry: (attempt: number, stalled: boolean) => void;
	},
): Promise<void> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= context.retries; attempt++) {
		context.signal?.throwIfAborted();

		if (attempt > 0) {
			context.onRetry(attempt + 1, lastError instanceof StalledError);
			// Last entry repeats if retries were configured higher than the backoff table.
			await context.delay(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 1000);
			context.signal?.throwIfAborted();
		}

		try {
			const answer = await context.put({
				url: context.uploadUrl,
				token: target.token,
				body: untyped(file.bytes),
				signal: context.signal,
				onSent: context.onSent,
				stallMs: context.stallMs,
			});
			const status = typeof answer === "number" ? answer : answer.status;

			if (status >= 200 && status < 300) return;

			// A forged or expired permit will not start working, and neither will a deploy that has
			// already used every upload it was authorised for. Stop rather than spending three retries
			// on an answer that cannot change.
			if (status === 401 || status === 403 || status === 429) {
				throw new DeployError(
					ClientErrorCode.UploadFailed,
					`Upload of ${target.path} was refused. The upload window may have expired — try deploying again.`,
					{ path: target.path, status },
				);
			}

			// The edge refuses a body over the zone's ceiling before the Worker sees it. Nothing a retry
			// sends will be smaller, so four attempts were four full uploads of a file that could never land.
			// Only a client that can read the status gets here: the edge's 413 carries no CORS headers, so a
			// browser sees a network error instead — see docs/briefs/LARGE-FILES-BRIEF.md.
			if (status === 413) {
				throw new DeployError(
					ClientErrorCode.UploadFailed,
					`${target.path} is too large to upload in one request. Make it smaller, or leave it out of this publish.`,
					{ path: target.path, status },
				);
			}

			lastError = new Error(`HTTP ${status}`);
		} catch (error) {
			if (error instanceof DeployError) throw error;
			if (isAbort(error)) throw cancelled();

			lastError = error;
		}
	}

	// A connection that went quiet is worth naming as such: "could not upload" reads as a problem
	// with the file, when the thing to check is the network.
	const message =
		lastError instanceof StalledError
			? `Upload of ${target.path} stopped moving and did not recover after ${context.retries + 1} attempts. Check your connection and try again.`
			: `Could not upload ${target.path} after ${context.retries + 1} attempts.`;

	throw new DeployError(ClientErrorCode.UploadFailed, message, {
		path: target.path,
		cause: describeError(lastError),
	});
}

/**
 * Sends one batch — several files in one request — retrying the whole batch with backoff.
 *
 * The body is the layout, then each file's bytes in layout order, as one `Blob` built with no type: a
 * `Blob` assembled from `File`s keeps references to them, so the browser streams them from disk and
 * copies nothing, and an empty type means no `Content-Type` header, which the Worker's CORS policy would
 * refuse (see {@link untyped}).
 *
 * The Worker answers 200 with what it stored. Files already written are cheap to send again — the
 * ledger answers "already" and nothing is written — so a partial failure is retried as the whole batch
 * rather than tracked file by file. A file whose bytes no longer match its digest changed on disk after
 * it was hashed; no retry fixes that, so it stops the deploy at once.
 *
 * @param batch The batch permit.
 * @param members The batch's files, in layout order.
 * @param layout The layout bytes the permit signed.
 * @param context Same dependencies as {@link uploadOne}.
 * @throws DeployError When a file changed, the batch was refused, or every attempt failed.
 */
async function uploadBatchOne(
	batch: UploadBatch,
	members: readonly ManifestFile[],
	layout: Uint8Array,
	context: Parameters<typeof uploadOne>[2],
): Promise<void> {
	const first = (members[0] as ManifestFile).path;
	const label = members.length === 1 ? first : `${first} and ${members.length - 1} more`;
	let lastError: unknown;

	for (let attempt = 0; attempt <= context.retries; attempt++) {
		context.signal?.throwIfAborted();

		if (attempt > 0) {
			context.onRetry(attempt + 1, lastError instanceof StalledError);
			await context.delay(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 1000);
			context.signal?.throwIfAborted();
		}

		try {
			// Rebuilt per attempt: a Blob is a description of its parts, not a copy of them, so this costs
			// nothing and leaves no consumed stream behind.
			// The parts type is spelled through the constructor because the CLI builds without DOM types,
			// where `BlobPart` does not exist; the cast is the SharedArrayBuffer distinction `sha256Hex`
			// explains, nothing more.
			const body = new Blob([layout, ...members.map((file) => file.bytes)] as NonNullable<
				ConstructorParameters<typeof Blob>[0]
			>);
			const answer = await context.put({
				url: context.uploadUrl,
				token: batch.token,
				body,
				signal: context.signal,
				onSent: context.onSent,
				stallMs: context.stallMs,
				wantsBody: true,
			});
			const status = typeof answer === "number" ? answer : answer.status;

			if (status >= 200 && status < 300) {
				const result = typeof answer === "number" ? null : parseBatchResult(answer.body);
				if (result === null) {
					lastError = new Error(
						"The upload service answered with something that is not a batch result.",
					);
					continue;
				}
				if (result.failed.length === 0) return;

				const changed = result.failed.find((failure) => failure.reason === "hash_mismatch");
				if (changed !== undefined) {
					const path = (members[changed.i] as ManifestFile | undefined)?.path ?? first;

					throw new DeployError(
						ClientErrorCode.ReadFailed,
						`${path} changed after it was read, so it no longer matches what was checked. Drop the folder again.`,
						{ path },
					);
				}

				lastError = new Error(
					`${result.failed.length} of ${members.length} files were not stored.`,
				);
				continue;
			}

			// As for one file: a refused, expired or malformed permit, or one over its deploy's allowance,
			// will not start working on a retry. 400 and 411 here mean the batch itself was not what its
			// permit described, which is a bug on one side and equally final.
			if ([400, 401, 403, 411, 413, 429].includes(status)) {
				throw new DeployError(
					ClientErrorCode.UploadFailed,
					`Upload of ${label} was refused. The upload window may have expired — try deploying again.`,
					{ path: first, status },
				);
			}

			lastError = new Error(`HTTP ${status}`);
		} catch (error) {
			if (error instanceof DeployError) throw error;
			if (isAbort(error)) throw cancelled();

			lastError = error;
		}
	}

	const message =
		lastError instanceof StalledError
			? `Upload of ${label} stopped moving and did not recover after ${context.retries + 1} attempts. Check your connection and try again.`
			: `Could not upload ${label} after ${context.retries + 1} attempts.`;

	throw new DeployError(ClientErrorCode.UploadFailed, message, {
		path: first,
		cause: describeError(lastError),
	});
}

/**
 * The contents as a body that carries no media type.
 *
 * ⚠️ A dropped `File` has one — `text/markdown`, `image/png` — and a browser sends a typed `Blob` body
 * with that as its `Content-Type` header. The upload Worker allows exactly one request header,
 * `Authorization`, so the preflight for every such upload was refused and the browser reported
 * "Request header field content-type is not allowed by Access-Control-Allow-Headers". It shipped that
 * way the moment folder files started going up as `File`s rather than as bytes, and failed every upload
 * from a dropped folder in production. A slice with no type argument is the same bytes on disk with an
 * empty type, so the browser sends no `Content-Type` and nothing is copied. The type was never wanted
 * anyway: the router derives it from the extension when it serves the file (I10).
 *
 * @param content In memory or on disk.
 * @returns Contents the runtime will send without a `Content-Type`.
 */
export function untyped(content: FileContent): FileContent {
	if (ArrayBuffer.isView(content) || content.type === "") return content;

	return content.slice(0, content.size);
}

/**
 * Picks the transport when the caller did not.
 *
 * @param doFetch A `fetch` the caller supplied, which selects the fetch transport.
 * @returns XHR where the runtime has it and no `fetch` was supplied, otherwise fetch.
 */
function defaultTransport(doFetch: typeof fetch | undefined): PutTransport {
	if (doFetch !== undefined) return fetchTransport(doFetch);

	const Xhr = (globalThis as { XMLHttpRequest?: XhrConstructor }).XMLHttpRequest;

	return Xhr === undefined ? fetchTransport(globalFetch()) : xhrTransport(Xhr);
}

/**
 * Sends with `fetch`, which reports nothing until the response arrives.
 *
 * No stall limit here, and that is deliberate rather than an omission: with no sent-byte events there
 * is no telling a slow upload from a dead one, and any fixed limit would abandon a large file on a slow
 * line that was working. The CLI uses this, where a hung request is a terminal somebody can interrupt.
 *
 * @param doFetch The fetch to call.
 * @returns The transport.
 */
function fetchTransport(doFetch: typeof fetch): PutTransport {
	return async (request) => {
		const { url, token, body, signal } = request;
		const response = await doFetch(url, {
			method: "PUT",
			// The view, not a copy. Wrapping it in `new Blob([body.slice().buffer])` made two extra
			// full-size copies of every file in flight — eight at once, so up to 400 MB on a drop of
			// 50 MB files. `fetch` sends exactly the range a view covers. The cast is TypeScript's
			// SharedArrayBuffer distinction again; see `sha256Hex`. A `Blob` goes as it is, and the runtime
			// streams it from disk.
			body: body as Uint8Array<ArrayBuffer> | Blob,
			// The permit is the whole request. `Content-Length` is required by the Worker and cannot be
			// set here — it is a forbidden header name — but the runtime derives it from the body, which
			// is exactly the length the token names.
			headers: { Authorization: `Bearer ${token}` },
			...(signal ? { signal } : {}),
		});

		return request.wantsBody === true
			? { status: response.status, body: await response.text() }
			: response.status;
	};
}

/** The part of `XMLHttpRequest` the transport uses, declared here because the CLI builds without DOM types. */
interface XhrLike {
	/** HTTP status once loaded. */
	readonly status: number;
	/** The response body as text once loaded; optional so a stand-in that never answers a batch can omit it. */
	readonly responseText?: string;
	/** Progress of the request body. */
	readonly upload: { onprogress: ((event: { loaded: number }) => void) | null };
	/** Fires as the response arrives. */
	onprogress: (() => void) | null;
	/** Fires once the response is complete. */
	onload: (() => void) | null;
	/** Fires on a network failure. */
	onerror: (() => void) | null;
	/** Starts a request. */
	open(method: string, url: string): void;
	/** Sets one request header. */
	setRequestHeader(name: string, value: string): void;
	/** Sends the body. */
	send(body: FileContent): void;
	/** Cancels the request. */
	abort(): void;
}

/** Constructor of {@link XhrLike}. */
type XhrConstructor = new () => XhrLike;

/**
 * Sends with `XMLHttpRequest`, reporting sent bytes and abandoning a request that stops moving.
 *
 * The idle timer restarts on every sent-byte event and on every response chunk, so it measures silence
 * rather than duration: a large file on a slow line never trips it while bytes are still leaving.
 *
 * @param Xhr The runtime's `XMLHttpRequest`.
 * @returns The transport.
 */
export function xhrTransport(Xhr: XhrConstructor): PutTransport {
	return ({ url, token, body, signal, onSent, stallMs, wantsBody }) =>
		new Promise<number | PutResponse>((resolve, reject) => {
			const xhr = new Xhr();
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			/** Settles once, releasing the timer and the abort listener. */
			const settle = (finish: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				finish();
			};

			/** Restarts the idle timer. */
			const arm = (): void => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					xhr.abort();
					settle(() => reject(new StalledError(Math.round(stallMs / 1000))));
				}, stallMs);
			};

			/** Cancels on the caller's signal. */
			function onAbort(): void {
				xhr.abort();
				settle(() => reject(abortReason(signal)));
			}

			if (signal?.aborted) {
				reject(abortReason(signal));
				return;
			}

			signal?.addEventListener("abort", onAbort, { once: true });

			xhr.open("PUT", url);
			// Same permit, same reason as the fetch transport: the browser sets Content-Length itself.
			xhr.setRequestHeader("Authorization", `Bearer ${token}`);
			xhr.upload.onprogress = (event) => {
				arm();
				onSent(event.loaded);
			};
			xhr.onprogress = arm;
			xhr.onload = () =>
				settle(() =>
					resolve(
						wantsBody === true ? { status: xhr.status, body: xhr.responseText ?? "" } : xhr.status,
					),
				);
			xhr.onerror = () => settle(() => reject(new TypeError("Network error during upload.")));

			arm();
			// The view itself, not a copy: XHR sends exactly the bytes a view covers. A `Blob` is read
			// from disk as it goes.
			xhr.send(body);
		});
}

/**
 * What an aborted signal was aborted with, as an error {@link isAbort} recognises.
 *
 * @param signal The aborted signal.
 * @returns The signal's reason when it is an error, otherwise a fresh AbortError.
 */
function abortReason(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error) return reason;

	const error = new Error("Aborted.");
	error.name = "AbortError";

	return error;
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
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Builds the error used when the user cancels. */
export function cancelled(): DeployError {
	return new DeployError(ClientErrorCode.Cancelled, "Deploy cancelled.");
}

/**
 * The refusal for a browser that could not allocate the memory a drop needed.
 *
 * What a browser throws then is a `RangeError` — "Array buffer allocation failed" in Chrome, "invalid
 * array length" or "out of memory" elsewhere — and none of those names the fix. One sentence for every
 * place it can happen: reading a zip, expanding it, or hashing a large file.
 *
 * @param detail The browser's own message, kept for the log.
 * @returns The refusal.
 */
export function outOfMemory(detail?: string): DeployError {
	return new DeployError(
		ClientErrorCode.OutOfMemory,
		"This browser ran out of memory reading what you dropped. Drop the unzipped folder instead, or try again in a desktop browser with fewer tabs open.",
		detail,
	);
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
	if (error instanceof RangeError) return outOfMemory(error.message);

	return new DeployError(
		ClientErrorCode.UploadFailed,
		error instanceof Error ? error.message : "Upload failed.",
		error,
	);
}
