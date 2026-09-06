import { type DeploySource, deploy, type ProgressEvent } from "@drop2run/core";
import { createSite, listSites, type SiteSummary } from "./api.js";
import type { Credentials } from "./config.js";
import { directorySource } from "./source.js";

/**
 * One publish, from a folder or a single page to a live URL.
 *
 * Sits between a command — an MCP tool or a CLI subcommand — and the engine, and exists to hold the
 * one decision each of them would otherwise make differently: which site a publish goes to.
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
	let failureDetail: unknown;

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
		if (event.type === "error") {
			failure = event.message;
			// Kept alongside the message, because the message alone is unactionable for the failure that
			// happens most: "could not upload x after 4 attempts" names the file and not the status, and
			// the status is the whole of what somebody needs. The engine puts it here; this is what stops
			// it being dropped on the way to a terminal.
			failureDetail = event.detail;
		}
	};

	await deploy(source, target.siteId, record, undefined, {
		baseUrl: credentials.apiBaseUrl,
		token: credentials.token,
	}).catch((error: unknown) => {
		// The engine both reports and throws. Preferring the reported message keeps the wording the same
		// as a browser would show for the same failure, and the detail rides along so a terminal can say
		// why rather than only what.
		const thrown = new Error(
			failure ?? (error instanceof Error ? error.message : String(error)),
		) as Error & { detail?: unknown };

		thrown.detail = failureDetail ?? (error as { detail?: unknown } | null)?.detail;

		throw thrown;
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
	return publishFiles(credentials, [{ path: "index.html", content: html }], site);
}

/** One file a caller wrote, rather than one read off a disk. */
export interface AuthoredFile {
	/** Where it goes in the site, relative to the root. */
	readonly path: string;
	/** Its contents, as text. */
	readonly content: string;
}

/**
 * Cleans one caller-supplied path, or says why it cannot be used.
 *
 * <b>Not a security boundary.</b> The server normalizes every path it is given and derives the storage
 * key itself, so nothing here decides where bytes land. What it decides is when somebody finds out: a
 * model writing `/docs/api.md` or `..\\notes.md` means a file at an ordinary place, and answering that
 * at the tool is a sentence rather than a deploy that fails halfway.
 *
 * @param path The path as given.
 * @returns The cleaned path.
 * @throws Error when it names no usable file.
 */
function cleanPath(path: string): string {
	const cleaned = path
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\.?\//, "");

	if (cleaned === "" || cleaned.endsWith("/")) {
		throw new Error(`"${path}" does not name a file.`);
	}

	if (cleaned.split("/").includes("..") || /^[a-zA-Z]:/.test(cleaned)) {
		throw new Error(
			`"${path}" is not a path inside the site. Give a path relative to the site's root, such as ` +
				"index.html or docs/guide.md.",
		);
	}

	return cleaned;
}

/**
 * Publishes files the caller wrote, rather than files on a disk.
 *
 * The case {@link publishDirectory} cannot serve: the content was written in the conversation and there
 * is no folder to point at. A site needs an `index.html` at its top level, or at least one `.md`,
 * `.markdown` or `.pdf` file — so a single note publishes as a documents site, read through the viewer.
 *
 * Text only, which is why a PDF has to come off a disk: these bytes arrive as a JSON string.
 *
 * @param credentials Token and base URL.
 * @param files What to publish, each with a path relative to the site root.
 * @param site Subdomain or site id, or undefined for a new site.
 * @returns What to tell the caller.
 * @throws Error when a path names nothing usable, or two files claim the same one.
 */
// `async` for the rejection rather than for an await: the path checks run before anything is sent, and
// a plain function returning `Promise` would throw those synchronously — past every caller that handles
// a failed publish by catching the promise, which is all of them.
export async function publishFiles(
	credentials: Credentials,
	files: readonly AuthoredFile[],
	site?: string,
): Promise<PublishResult> {
	const encoder = new TextEncoder();
	const collected = files.map((file) => ({
		path: cleanPath(file.path),
		bytes: encoder.encode(file.content),
	}));

	// Two entries claiming one path would upload both and serve whichever the manifest kept last — a
	// coin toss the caller never sees reported, and one a model writing paths can lose by a typo.
	const seen = new Set<string>();
	for (const file of collected) {
		if (seen.has(file.path)) throw new Error(`Two files were given the same path: ${file.path}`);
		seen.add(file.path);
	}

	return publish(credentials, async () => collected, site);
}
