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
