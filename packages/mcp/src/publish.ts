import { type DeploySource, deploy, type ProgressEvent } from "@drop2run/core";
import { createSite, listSites, type SiteSummary } from "./api.js";
import type { Credentials } from "./config.js";
import { directorySource } from "./source.js";

/**
 * One publish, from a folder or a single page to a live URL.
 *
 * Sits between the MCP tools and the engine, and exists to hold the one decision the tools would
 * otherwise each make differently: which site a publish goes to.
 */

/** What a publish reports back to the chat. */
export interface PublishResult {
	/** The live URL. */
	readonly url: string;
	/** ULID of the site published to. */
	readonly siteId: string;
	/** Its subdomain. */
	readonly subdomain: string;
	/** How many files were published. */
	readonly files: number;
	/** True when the content was already live, so no version was created. */
	readonly unchanged: boolean;
}

/**
 * Finds the site to publish to, creating one when the caller named none.
 *
 * <b>Never guesses.</b> Given no site, it makes a new one rather than reusing the most recent — the
 * alternative silently overwrites whatever the account happened to publish last, which is the worst
 * possible default for a tool a model calls on somebody's behalf. Given a subdomain or an id that does
 * not match, it fails rather than falling back to creating one, because "I could not find that site so
 * I made a different one" is not a thing anybody asked for.
 *
 * @param credentials Token and base URL.
 * @param site Subdomain or site id the caller named, or undefined.
 * @returns The site to publish to.
 * @throws Error when a named site does not exist.
 */
async function resolveSite(credentials: Credentials, site?: string): Promise<SiteSummary> {
	if (site === undefined) return await createSite(credentials);

	const wanted = site.trim().toLowerCase();
	const found = (await listSites(credentials)).find(
		(candidate) =>
			candidate.siteId.toLowerCase() === wanted || candidate.subdomain.toLowerCase() === wanted,
	);

	if (found === undefined) {
		throw new Error(
			`No site of yours is called "${site}". Leave the site out to publish to a new one, or use ` +
				"list_sites to see what exists.",
		);
	}

	return found;
}

/**
 * Publishes files to a site.
 *
 * @param credentials Token and base URL.
 * @param source Where the files come from.
 * @param site Subdomain or site id to publish to, or undefined for a new site.
 * @returns What to tell the caller.
 * @throws Error when the deploy fails, carrying the engine's message.
 */
export async function publish(
	credentials: Credentials,
	source: DeploySource,
	site?: string,
): Promise<PublishResult> {
	const target = await resolveSite(credentials, site);

	let files = 0;
	let url = target.url;
	let unchanged = false;
	let failure: string | null = null;

	// The engine reports through a listener rather than returning, because a browser draws a progress
	// bar from it. Here there is nothing to draw on until the tool returns, so the events are collapsed
	// into the three facts worth reporting.
	const record = (event: ProgressEvent) => {
		if (event.type === "collecting") files = event.files;
		if (event.type === "unchanged") {
			unchanged = true;
			url = event.url || target.url;
		}
		if (event.type === "done") url = event.url;
		if (event.type === "error") failure = event.message;
	};

	await deploy(source, target.siteId, record, undefined, {
		baseUrl: credentials.apiBaseUrl,
		token: credentials.token,
	}).catch((error: unknown) => {
		// The engine both reports and throws. Preferring the reported message keeps the wording the same
		// as a browser would show for the same failure.
		throw new Error(failure ?? (error instanceof Error ? error.message : String(error)));
	});

	return { url, siteId: target.siteId, subdomain: target.subdomain, files, unchanged };
}

/**
 * Publishes a directory.
 *
 * @param credentials Token and base URL.
 * @param directory Absolute path of the folder to publish.
 * @param site Subdomain or site id, or undefined for a new site.
 * @returns What to tell the caller.
 */
export function publishDirectory(
	credentials: Credentials,
	directory: string,
	site?: string,
): Promise<PublishResult> {
	return publish(credentials, directorySource(directory), site);
}

/**
 * Publishes one page of HTML as a whole site.
 *
 * The common case for a chat: a model has written a page and wants it on the air. It becomes
 * `index.html` because that is the only name the server will serve as a site's entry point.
 *
 * @param credentials Token and base URL.
 * @param html The page.
 * @param site Subdomain or site id, or undefined for a new site.
 * @returns What to tell the caller.
 */
export function publishHtml(
	credentials: Credentials,
	html: string,
	site?: string,
): Promise<PublishResult> {
	const bytes = new TextEncoder().encode(html);

	return publish(credentials, async () => [{ path: "index.html", bytes }], site);
}
