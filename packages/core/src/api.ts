import { ClientErrorCode, DeployError, describeError, type ManifestFile } from "./types.js";
import type { UploadTarget } from "./upload.js";

/**
 * The two control-plane calls a deploy makes.
 *
 * Deliberately hand-written rather than generated: the pipeline is reused by the CLI in Phase 3, and
 * these two shapes are small enough that a generated client would only add a build step. The response
 * types still have to match `packages/contracts/generated.ts`.
 */

/**
 * The header naming the account a request acts on. Mirrors `ICurrentAccount.AccountHeaderName`.
 *
 * Exported so the browser and the CLI spell it the same way. A second spelling of it would be a header
 * silently ignored by the server, which is indistinguishable from acting on the right account until the
 * day it is not.
 */
export const ACCOUNT_HEADER = "X-Drop2Run-Account";

/** Header carrying the claim token of an anonymous site, mirroring the API constant. */
export const CLAIM_TOKEN_HEADER = "X-Claim-Token";

/** Response of `POST /sites/{siteId}/deploys/prepare`. */
export interface PrepareResponse {
	/** ULID of the new deploy. */
	readonly deployId: string;
	/** One upload permit per file that must be uploaded. */
	readonly upload: readonly UploadTarget[];
	/**
	 * The one endpoint every permit is presented to.
	 *
	 * Sent by the server rather than known by the client, because it differs between development,
	 * tests and production — and because a client that knew it without being told would still know it
	 * after we moved.
	 */
	readonly uploadUrl: string;
	/**
	 * How many files the live deploy already holds byte-identical. These are absent from `upload` and
	 * the server copies them within the bucket while completing the deploy, so the client never sends
	 * their bytes.
	 */
	readonly reused: number;
	/** Files in the whole deploy: `reused` plus `upload.length`. What the progress UI counts towards. */
	readonly total: number;
	/**
	 * True when the manifest is exactly what the site already serves, so the server created no deploy.
	 * There is nothing to upload and `complete` must not be called — `deployId` is the version already
	 * live, and completing it again would only rewrite the mapping to where it already points.
	 */
	readonly unchanged?: boolean;
	/** Public URL of the site. Sent only alongside `unchanged`, which ends the deploy there. */
	readonly url?: string;
}

/** Response of `POST /sites/{siteId}/deploys/{deployId}/complete`. */
export interface CompleteResponse {
	/** ULID of the deploy that is now live. */
	readonly deployId: string;
	/** Always `live` on success. */
	readonly status: string;
	/** Public URL of the site. */
	readonly url: string;
	/** Number of verified files. */
	readonly fileCount: number;
	/** Total verified size in bytes. */
	readonly totalBytes: number;
	/**
	 * What the site is called now, or null when it has none.
	 *
	 * Not the same as the name this call sent: the server cleans it, and it refuses to overwrite a name
	 * the site already had — so a redeploy usually gets back a different string from the one it offered.
	 * This is the one to store.
	 */
	readonly name: string | null;
}

/** What the pipeline needs to talk to the API. */
export interface ApiOptions {
	/** Base path of the API. Same origin in production, so a path rather than a URL. */
	readonly baseUrl?: string;
	/** Claim token, for a site that has no owner yet. */
	readonly claimToken?: string;
	/**
	 * Personal access token, for a caller with no browser session.
	 *
	 * <b>Reaches the control plane and nothing else.</b> It is attached in {@link request} only, never by
	 * {@link uploadAll}: an upload carries its own permit, which names one key and one length and is
	 * worth nothing else. That was true when the PUTs went to presigned R2 URLs and it is still true now
	 * they go to our upload Worker — what changed is that the endpoint is ours, which is a reason to be
	 * more careful rather than less. The devtools brief calls this out as its second risk: this token
	 * speaks for a whole account, so every place it is sent is a place it can leak from.
	 *
	 * A browser leaves this unset and authenticates with its cookie, which is why nothing in apps/web
	 * passes it.
	 */
	readonly token?: string;
	/**
	 * Account to publish to, when the caller belongs to more than one.
	 *
	 * Sent as a header for the same reason the browser stores the choice rather than the server: the
	 * server reads membership on every request, so this only selects among accounts it already agrees
	 * the caller is in — an unrecognised value is refused, not honoured.
	 *
	 * Left unset, the server resolves the caller's own account, which is the right answer for everybody
	 * who has never switched. It matters most here of anywhere: a deploy that omitted it from a page
	 * describing a team would publish to the caller's personal account and report success.
	 */
	readonly accountId?: string;
	/** Overridable for tests. Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * How long one call may go without an answer before it is abandoned, in milliseconds. Defaults to
	 * {@link DEFAULT_REQUEST_TIMEOUT_MS}.
	 */
	readonly timeoutMs?: number;
	/** Waits between retries of `complete`. Overridable for tests; defaults to a real timer. */
	readonly delay?: (ms: number) => Promise<void>;
}

/**
 * How long a control-plane call may go without an answer by default.
 *
 * <b>Why there is one at all.</b> Without it a request the network lost stays pending for ever: in the
 * 30 September stress runs one client in a hundred sat after prepare with its `complete` unanswered,
 * and the run waited on it until somebody pressed Ctrl-C. The server never saw that request, so no
 * server-side timeout could have ended it.
 *
 * <b>Why two minutes.</b> `complete` verifies every file against the bucket and copies the ones reused
 * from the live deploy, so on a large site it is honestly slow; this has to sit well above that, and
 * only below "for ever".
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Waits before each retry of `complete`, so three attempts in all.
 *
 * Short, because the failure being retried is a lost connection rather than an overloaded server —
 * an overloaded server answers, and an answer is never retried.
 */
const COMPLETE_RETRY_DELAYS_MS = [1_000, 4_000] as const;

/**
 * Asks the API to validate a manifest and hand back upload URLs.
 *
 * @param siteId Site to deploy to.
 * @param files The hashed manifest.
 * @param options API access options.
 * @param signal Cancels the request.
 * @returns The deploy id and its upload targets.
 * @throws DeployError When the API rejects the manifest.
 */
export async function prepareDeploy(
	siteId: string,
	files: readonly ManifestFile[],
	options: ApiOptions,
	signal?: AbortSignal,
): Promise<PrepareResponse> {
	// Only the three fields the API reads; the bytes stay on this side.
	const manifest = files.map((file) => ({
		path: file.path,
		sha256: file.sha256,
		size: file.bytes.length,
	}));

	const prepared = await request<PrepareResponse>(
		`sites/${encodeURIComponent(siteId)}/deploys/prepare`,
		{ files: manifest },
		options,
		signal,
	);

	return { ...prepared, uploadUrl: absolute(prepared.uploadUrl, options.baseUrl) };
}

/**
 * Resolves the upload endpoint against the API's own origin when the server sent a path.
 *
 * <b>Why the server sends a path at all.</b> Uploads go to a Worker behind the same proxy as the API,
 * so `/upload/v1/object` is what a page needs — same origin, no CORS, and it stays correct when the
 * deployment moves. A browser resolves it against the document; that is why this was invisible for as
 * long as the browser was the only client.
 *
 * <b>Why it broke.</b> Uploads used to go to presigned R2 URLs, which are absolute, so
 * <c>fetch</c> in Node worked by accident. Once they moved behind the Worker, every non-browser client
 * — the CLI and the MCP server — started failing with `Failed to parse URL from /upload/v1/object`,
 * four attempts deep, naming a file rather than the cause.
 *
 * Left alone when it is already absolute, and left alone when there is no absolute base to resolve
 * against: in a browser both the base and this are paths, and the correct behaviour there is the one
 * that was already working.
 *
 * @param uploadUrl What the server sent.
 * @param baseUrl The API base, which is absolute for every client that is not a page.
 * @returns An absolute URL where one can be worked out, and the input otherwise.
 */
function absolute(uploadUrl: string, baseUrl: string | undefined): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(uploadUrl)) return uploadUrl;
	if (baseUrl === undefined || !/^[a-z][a-z0-9+.-]*:/i.test(baseUrl)) return uploadUrl;

	// Resolved against the base's *origin*, not the base itself: the API lives under a path
	// (`https://dropto.run/api`) while the upload endpoint is rooted at the host, so joining them
	// would produce `/api/upload/v1/object` — a 404 that would have read as a broken Worker.
	return new URL(uploadUrl, baseUrl).toString();
}

/**
 * Tells the API every file has been uploaded, which verifies them and takes the deploy live.
 *
 * @param siteId Site being deployed to.
 * @param deployId Deploy to complete.
 * @param options API access options.
 * @param signal Cancels the request.
 * @param name A display name read out of the drop's `index.html`, or null when it offered none. The
 *   server stores it only for a site that has none yet, so a later deploy never overwrites a name its
 *   owner typed — see `suggestSiteName`.
 * @returns The live deploy and the site's URL.
 * @throws DeployError When verification fails, or when every attempt went unanswered.
 */
export async function completeDeploy(
	siteId: string,
	deployId: string,
	options: ApiOptions,
	signal?: AbortSignal,
	name?: string | null,
): Promise<CompleteResponse> {
	const path = `sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/complete`;
	// A bodyless POST when there is no name to send, which is what this call has always been. The server
	// treats an absent body and an absent field identically, so nothing depends on which of the two a
	// client picks.
	const body = name === null || name === undefined ? undefined : { name };
	const delay = options.delay ?? wait;

	/*
	 * Retried when it went unanswered, and only then.
	 *
	 * Safe because the endpoint is idempotent (I9): a deploy already live on its site is answered with
	 * the same success, and a second call arriving while the first is still verifying waits on the
	 * site's lock and then takes that same branch. So whether the lost attempt never reached the server
	 * or reached it and lost only its reply, calling again ends in the one live deploy.
	 *
	 * An HTTP error is never retried: it is the server's answer, and asking again gets it again. Nor is
	 * `prepare`, which creates a deploy each time it is called.
	 */
	for (let attempt = 0; ; attempt++) {
		try {
			return await request<CompleteResponse>(path, body, options, signal);
		} catch (error) {
			const unanswered =
				error instanceof DeployError && error.code === ClientErrorCode.NetworkFailed;
			if (!unanswered || attempt >= COMPLETE_RETRY_DELAYS_MS.length || signal?.aborted) throw error;

			await delay(COMPLETE_RETRY_DELAYS_MS[attempt] ?? 1_000);
			signal?.throwIfAborted();
		}
	}
}

/**
 * Waits, for real.
 *
 * @param ms Milliseconds to wait.
 */
function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts to the API and turns a failure into a {@link DeployError}.
 *
 * @typeParam T Expected response shape.
 * @param path Path relative to the API base.
 * @param body JSON body, or undefined for a bodyless POST.
 * @param options API access options.
 * @param signal Cancels the request.
 * @returns The parsed response.
 * @throws DeployError Carrying the API's RFC 9457 `type` as its code, so the UI can branch on it, or
 *   {@link ClientErrorCode.NetworkFailed} when no answer arrived within {@link ApiOptions.timeoutMs}.
 */
async function request<T>(
	path: string,
	body: unknown,
	options: ApiOptions,
	signal?: AbortSignal,
): Promise<T> {
	const doFetch = options.fetch ?? globalFetch();
	const base = options.baseUrl ?? "/api";
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (options.claimToken) headers[CLAIM_TOKEN_HEADER] = options.claimToken;
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.accountId) headers[ACCOUNT_HEADER] = options.accountId;

	/*
	 * One controller for both ways a call can end early, built by hand rather than with
	 * `AbortSignal.timeout` and `AbortSignal.any`. The first raises a `TimeoutError`, which `isAbort`
	 * reads as the user cancelling — a timeout would have been reported as "Deploy cancelled." — and the
	 * second is missing from browsers this dashboard still serves. The flag is what tells the two apart.
	 */
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const forwardCancel = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener("abort", forwardCancel, { once: true });

	try {
		const response = await doFetch(`${base}/${path}`, {
			method: "POST",
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: controller.signal,
		});

		if (!response.ok) throw await problemToError(response);

		return (await response.json()) as T;
	} catch (error) {
		// The caller's own cancel goes up unchanged, so it is still reported as a cancel.
		if (error instanceof DeployError || signal?.aborted) throw error;

		if (timedOut) {
			throw new DeployError(
				ClientErrorCode.NetworkFailed,
				`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
				{ path, cause: describeError(error) },
			);
		}

		// What `fetch` throws for a connection that failed before any response: a TypeError, in Node and
		// in every browser. Anything else — a body that is not JSON, say — is not a lost connection and
		// must not be mistaken for one, because that is the signal `complete` retries on.
		if (error instanceof TypeError) {
			throw new DeployError(ClientErrorCode.NetworkFailed, "Could not reach the server.", {
				path,
				cause: describeError(error),
			});
		}

		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", forwardCancel);
	}
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
 * Converts an error response into a {@link DeployError}.
 *
 * The API answers with RFC 9457, whose `type` is a stable code and whose `detail` is already written for
 * a person, so both are used as they are rather than being rewritten here.
 *
 * @param response The failed response.
 * @returns The error to throw.
 */
async function problemToError(response: Response): Promise<DeployError> {
	let problem: Record<string, unknown> = {};

	try {
		problem = (await response.json()) as Record<string, unknown>;
	} catch {
		// A proxy or gateway failure will not be JSON at all.
		return new DeployError(
			`http_${response.status}`,
			`The server responded with ${response.status}.`,
		);
	}

	const code = typeof problem.type === "string" ? problem.type : `http_${response.status}`;
	const message =
		typeof problem.detail === "string"
			? problem.detail
			: typeof problem.title === "string"
				? problem.title
				: `The server responded with ${response.status}.`;

	return new DeployError(code, message, problem);
}
