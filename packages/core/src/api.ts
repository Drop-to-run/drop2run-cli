import { DeployError, type ManifestFile } from "./types.js";
import type { UploadTarget } from "./upload.js";

/**
 * The two control-plane calls a deploy makes.
 *
 * Deliberately hand-written rather than generated: the pipeline is reused by the CLI in Phase 3, and
 * these two shapes are small enough that a generated client would only add a build step. The response
 * types still have to match `packages/contracts/generated.ts`.
 */

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
	 * {@link uploadAll} — those PUTs go to presigned storage URLs on another host, which need no
	 * credential of ours and must not be handed one. The devtools brief calls this out as its second
	 * risk: this token speaks for a whole account, so every place it is sent is a place it can leak
	 * from.
	 *
	 * A browser leaves this unset and authenticates with its cookie, which is why nothing in apps/web
	 * passes it.
	 */
	readonly token?: string;
	/** Overridable for tests. Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
}

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

	return request<PrepareResponse>(
		`sites/${encodeURIComponent(siteId)}/deploys/prepare`,
		{ files: manifest },
		options,
		signal,
	);
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
 * @throws DeployError When verification fails.
 */
export async function completeDeploy(
	siteId: string,
	deployId: string,
	options: ApiOptions,
	signal?: AbortSignal,
	name?: string | null,
): Promise<CompleteResponse> {
	return request<CompleteResponse>(
		`sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/complete`,
		// A bodyless POST when there is no name to send, which is what this call has always been. The
		// server treats an absent body and an absent field identically, so nothing depends on which of
		// the two a client picks.
		name === null || name === undefined ? undefined : { name },
		options,
		signal,
	);
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
 * @throws DeployError Carrying the API's RFC 9457 `type` as its code, so the UI can branch on it.
 */
async function request<T>(
	path: string,
	body: unknown,
	options: ApiOptions,
	signal?: AbortSignal,
): Promise<T> {
	const doFetch = options.fetch ?? globalFetch();
	const base = options.baseUrl ?? "/api";

	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (options.claimToken) headers[CLAIM_TOKEN_HEADER] = options.claimToken;
	if (options.token) headers.Authorization = `Bearer ${options.token}`;

	const response = await doFetch(`${base}/${path}`, {
		method: "POST",
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		...(signal ? { signal } : {}),
	});

	if (!response.ok) throw await problemToError(response);

	return (await response.json()) as T;
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

	const code =
		typeof problem.type === "string" ? problem.type : `http_${response.status}`;
	const message =
		typeof problem.detail === "string"
			? problem.detail
			: typeof problem.title === "string"
				? problem.title
				: `The server responded with ${response.status}.`;

	return new DeployError(code, message, problem);
}
