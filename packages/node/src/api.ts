import type { Credentials } from "./config.js";

/**
 * The control-plane calls this server makes that the engine does not.
 *
 * `@drop2run/core` covers one deploy end to end. What it has no opinion about is which site to deploy
 * to, so creating one and listing them live here.
 */

/** One of the caller's sites, as the tools report it. */
export interface SiteSummary {
	/** ULID of the site. */
	readonly siteId: string;
	/** Its subdomain. */
	readonly subdomain: string;
	/** Its public URL. */
	readonly url: string;
	/** What it is called, or null when it has no name. */
	readonly name: string | null;
}

/**
 * Calls the API with the bearer token.
 *
 * @param credentials Token and base URL.
 * @param path Path under the API root, without a leading slash.
 * @param init Method and body.
 * @returns The parsed response.
 * @throws Error carrying the API's `detail` where it sent one, since that text is written to be read by
 * whoever asked rather than by a program.
 */
async function call<T>(credentials: Credentials, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${credentials.apiBaseUrl}/${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${credentials.token}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;

		throw new Error(problem?.detail ?? `The API answered ${response.status}.`);
	}

	return (await response.json()) as T;
}

/**
 * Finds one of the caller's sites by subdomain or id.
 *
 * <b>Never falls back to another site.</b> The failure mode this rules out is the one that matters for
 * a command that deletes or rolls back: "I could not find the site you named, so I acted on a different
 * one" is not a mistake anybody recovers from.
 *
 * @param credentials Token and base URL.
 * @param site Subdomain or site id.
 * @returns The site.
 * @throws Error naming what was not found, when nothing matches.
 */
export async function findSite(credentials: Credentials, site: string): Promise<SiteSummary> {
	const wanted = site.trim().toLowerCase();
	const found = (await listSites(credentials)).find(
		(candidate) =>
			candidate.siteId.toLowerCase() === wanted || candidate.subdomain.toLowerCase() === wanted,
	);

	if (found === undefined) {
		throw new Error(`No site of yours is called "${site}". \`drop2run ls\` shows what exists.`);
	}

	return found;
}

/**
 * Deletes a site and everything published to it.
 *
 * The API answers 204, so there is no body to read and nothing to return. Whether the caller meant it is
 * decided before this is called — see the `rm` command, which will not run without being told twice.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function deleteSite(credentials: Credentials, siteId: string): Promise<void> {
	const response = await fetch(`${credentials.apiBaseUrl}/sites/${encodeURIComponent(siteId)}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${credentials.token}` },
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;

		throw new Error(problem?.detail ?? `The API answered ${response.status}.`);
	}
}

/** What promoting an earlier deploy reports back. */
export interface PromotedDeploy {
	/** ULID of the deploy that is now live. */
	readonly deployId: string;
	/** The URL it is live on. */
	readonly url: string;
}

/**
 * Makes an earlier deploy live again.
 *
 * The rollback the dashboard offers, from a terminal. It can fail with 410 rather than 404 when the
 * version existed and its files have since been collected, and that difference is worth keeping in the
 * message: no retry brings those files back, so the only offer left is publishing again.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param deployId ULID of the deploy to make live.
 * @returns What is now live.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function promoteDeploy(
	credentials: Credentials,
	siteId: string,
	deployId: string,
): Promise<PromotedDeploy> {
	return await call<PromotedDeploy>(
		credentials,
		`sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/promote`,
		{ method: "POST" },
	);
}

/** One access token, as the listing reports it. */
export interface AccessToken {
	/** ULID of the token. */
	readonly id: string;
	/** What its owner called it. */
	readonly name: string;
	/** Its first characters — the only part of the secret that survives. */
	readonly prefix: string;
	/** When it was issued. */
	readonly createdAt: string;
	/** When a request last authenticated with it, or null if none ever has. */
	readonly lastUsedAt: string | null;
	/** When it stops working on its own, or null. */
	readonly expiresAt: string | null;
	/** When it was revoked, or null while it stands. */
	readonly revokedAt: string | null;
}

/**
 * Lists the account's access tokens.
 *
 * <b>The one token command that exists</b>, and the reason the other two do not: creating and revoking
 * require a browser session, because a token that could mint its replacement would make revoking the
 * first one meaningless. Listing is safe — it returns prefixes, never secrets — and it answers the
 * question somebody actually has at a terminal: which machine is still holding a credential.
 *
 * @param credentials Token and base URL.
 * @returns The tokens, newest first as the API orders them.
 */
export async function listTokens(credentials: Credentials): Promise<AccessToken[]> {
	const body = await call<{ tokens: AccessToken[] }>(credentials, "tokens");

	return body.tokens;
}

/**
 * Lists the account's sites.
 *
 * @param credentials Token and base URL.
 * @returns The sites, newest first as the API orders them.
 */
export async function listSites(credentials: Credentials): Promise<SiteSummary[]> {
	const body = await call<{ sites: SiteSummary[] }>(credentials, "sites");

	return body.sites;
}

/**
 * Creates a site with a generated subdomain.
 *
 * @param credentials Token and base URL.
 * @returns The new site.
 */
export async function createSite(credentials: Credentials): Promise<SiteSummary> {
	const created = await call<{ siteId: string; subdomain: string; url: string }>(
		credentials,
		"sites",
		{ method: "POST", body: JSON.stringify({}) },
	);

	return { ...created, name: null };
}
