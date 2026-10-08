import { type Credentials, dashboardUrlFor } from "./config.js";

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
	const found = await lookUpSite(credentials, site);

	if (found === undefined) {
		// Names both ways to list sites: this is shared by the CLI and the MCP server, and a model told to
		// run a command it has no shell for has been told nothing.
		throw new Error(
			`No site of yours is called "${site}". \`drop2run ls\` or the list_sites tool shows what exists.`,
		);
	}

	return found;
}

/**
 * Something shaped like a site id: 26 letters and digits.
 *
 * Looser than Crockford base32 on purpose. This only decides whether a second request is worth making,
 * and the server answers 404 for anything that is not one of the caller's sites — so a stricter check
 * here could only turn away an id the server would have found.
 */
const SITE_ID_SHAPE = /^[0-9a-z]{26}$/i;

/**
 * Looks one of the caller's sites up by subdomain or id, or answers undefined.
 *
 * <b>Asked of the server, not searched for in a listing.</b> This used to read `GET /sites` and look
 * through the result, which stopped being every site when the listing became paged (`f0c30de2`): the
 * default page is 25, so a site older than the newest 25 answered "No site of yours is called" while it
 * plainly existed. A subdomain goes through the listing's own search, which matches it as a substring,
 * and the exact match is picked out of what comes back. An id is not something that search reads, so an
 * id goes to `GET /sites/{id}`, which answers 404 for a site that is not the caller's or is deleted.
 *
 * @param credentials Token and base URL.
 * @param site Subdomain or site id, in any case.
 * @returns The site, or undefined when the caller has none by that name or id.
 * @throws Error carrying the API's wording for any failure other than "not found".
 */
export async function lookUpSite(
	credentials: Credentials,
	site: string,
): Promise<SiteSummary | undefined> {
	const wanted = site.trim().toLowerCase();
	if (wanted === "") return undefined;

	const { sites } = await call<{ sites: SiteSummary[] }>(
		credentials,
		`sites?pageSize=${SITES_PER_REQUEST}&q=${encodeURIComponent(wanted)}`,
	);
	const bySubdomain = sites.find((candidate) => candidate.subdomain.toLowerCase() === wanted);

	if (bySubdomain !== undefined) return bySubdomain;
	if (!SITE_ID_SHAPE.test(wanted)) return undefined;

	const response = await fetch(
		`${credentials.apiBaseUrl}/sites/${encodeURIComponent(wanted.toUpperCase())}`,
		{ headers: { Authorization: `Bearer ${credentials.token}` } },
	);

	if (response.status === 404) return undefined;
	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;

		throw new Error(problem?.detail ?? `The API answered ${response.status}.`);
	}

	const detail = (await response.json()) as SiteSummary;

	return { siteId: detail.siteId, subdomain: detail.subdomain, url: detail.url, name: detail.name };
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

/** One published version of a site, as its detail lists it. */
export interface SiteVersion {
	/** ULID of the deploy, which a rollback takes. */
	readonly deployId: string;
	/**
	 * Where the deploy got to: `live` for the one being served, `superseded` for one that was live
	 * before, `ready` for one that finished but was never served, `failed`, or a stage still under way.
	 * Whether it can be rolled back to is {@link filesKept}, not this.
	 */
	readonly status: string;
	/** How many files it carries. */
	readonly fileCount: number;
	/** How many bytes they add up to. */
	readonly totalBytes: number;
	/** When it was started. */
	readonly createdAt: string;
	/** When it finished, or null when it never did. */
	readonly completedAt: string | null;
	/** Whether its files are still stored, which is what decides whether it can be rolled back to. */
	readonly filesKept: boolean;
}

/**
 * One of the caller's sites with every setting the dashboard's settings panel shows.
 *
 * A subset of what `GET /sites/{id}` answers: the fields a terminal or a chat can act on. The ones left
 * out — analytics windows, editor availability, the custom-domain allowance — describe screens this
 * package has no equivalent of.
 */
export interface SiteDetail extends SiteSummary {
	/** `active`, `paused`, or a state the platform put it in, such as `suspended` or `quota-held`. */
	readonly status: string;
	/**
	 * Whether only invited people can open the site, or null when that could not be read — an API that
	 * predates sharing, or a request that failed. Null is "unknown", never "no".
	 */
	readonly invitedOnly: boolean | null;
	/** ULID of the deploy being served, or null when nothing has been published. */
	readonly liveDeployId: string | null;
	/** Whether an unmatched path falls back to index.html. */
	readonly spaMode: boolean;
	/** Whether the site is read through the documents viewer. */
	readonly docsMode: boolean;
	/** Whether the owner chose the mode, rather than detection choosing it on each publish. */
	readonly modeIsManual: boolean;
	/** Whether a visitor has to type a password first. */
	readonly passwordProtected: boolean;
	/** Whether the plan allows a password at all. */
	readonly passwordProtectionAvailable: boolean;
	/** Whether the site's hostnames accept form submissions. */
	readonly formsEnabled: boolean;
	/** Whether the plan allows forms at all. */
	readonly formsAvailable: boolean;
	/** When the site is scheduled to come down, or null. */
	readonly expiresAt: string | null;
	/** What happens then — `pause` or `delete` — or null when nothing is scheduled. See {@link actionOf}. */
	readonly expiryAction: string | null;
	/** Whether the plan allows scheduling a takedown at all. */
	readonly scheduledExpiryAvailable: boolean;
	/** The folder it is filed in, or null at the top level. */
	readonly folderId: string | null;
	/** Its versions, newest first. */
	readonly deploys: readonly SiteVersion[];
}

/**
 * Turns the API's spelling of an enum value into the one these tools report.
 *
 * The API sends a site's status and expiry action as the enum's own name (`Active`, `QuotaHeld`,
 * `Pause`), while deploy statuses arrive lowercase. Reported kebab-case so every status reads the same
 * way and `QuotaHeld` does not become `quotaheld`.
 *
 * @param value The API's spelling.
 * @returns The lowercase, hyphenated form.
 */
function enumName(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Reports what a takedown will do, or null when there is none.
 *
 * <b>Null without a date, whatever the API stored.</b> The API keeps the last action after a schedule is
 * cancelled — production answered `Delete` for a site that had never had a date — and a date set later
 * without an action gets `Pause` regardless. Reporting the stored word would tell a reader a site is
 * due to be deleted when nothing is due at all.
 *
 * @param expiresAt When the takedown falls due, or null.
 * @param action The API's spelling of the stored action.
 * @returns `pause` or `delete`, or null when nothing is scheduled.
 */
function actionOf(expiresAt: string | null, action: string): string | null {
	return expiresAt === null ? null : enumName(action);
}

/**
 * Reads whether only invited people can open a site.
 *
 * <b>Asked of the viewers listing, because `GET /sites/{id}` does not carry it.</b> Answers null rather
 * than throwing when it cannot be read — an API deployed before sharing has no such route — because
 * "unknown" is a true answer and "public" would not be.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @returns Whether the site is invite-only, or null when that could not be read.
 */
export async function readInvitedOnly(
	credentials: Credentials,
	siteId: string,
): Promise<boolean | null> {
	try {
		const page = await call<{ invitedOnly?: boolean }>(
			credentials,
			`sites/${encodeURIComponent(siteId)}/viewers?pageSize=1`,
		);

		return typeof page.invitedOnly === "boolean" ? page.invitedOnly : null;
	} catch {
		return null;
	}
}

/**
 * Reads which folder a site is filed in from the sites listing.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param subdomain Its subdomain, which the listing's search matches.
 * @returns The folder id, or null at the top level or when the listing does not find it.
 */
async function folderFromListing(
	credentials: Credentials,
	siteId: string,
	subdomain: string,
): Promise<string | null> {
	const { sites } = await call<{ sites: { siteId: string; folderId?: string | null }[] }>(
		credentials,
		`sites?pageSize=${SITES_PER_REQUEST}&q=${encodeURIComponent(subdomain)}`,
	);

	return sites.find((candidate) => candidate.siteId === siteId)?.folderId ?? null;
}

/**
 * Reads one site's settings, state and versions.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @returns The site as it now stands.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function getSite(credentials: Credentials, siteId: string): Promise<SiteDetail> {
	const [site, invitedOnly] = await Promise.all([
		call<Omit<SiteDetail, "folderId"> & { folderId?: string | null }>(
			credentials,
			`sites/${encodeURIComponent(siteId)}`,
		),
		readInvitedOnly(credentials, siteId),
	]);

	// An API older than folders on the detail answers without the field, while its listing carries it.
	// Read from there rather than defaulted to null, which would report a filed site as at the top level.
	const folderId =
		site.folderId !== undefined
			? site.folderId
			: await folderFromListing(credentials, site.siteId, site.subdomain);

	return {
		siteId: site.siteId,
		subdomain: site.subdomain,
		url: site.url,
		name: site.name,
		status: enumName(site.status),
		invitedOnly,
		liveDeployId: site.liveDeployId,
		spaMode: site.spaMode,
		docsMode: site.docsMode,
		modeIsManual: site.modeIsManual,
		passwordProtected: site.passwordProtected,
		passwordProtectionAvailable: site.passwordProtectionAvailable,
		formsEnabled: site.formsEnabled,
		formsAvailable: site.formsAvailable,
		expiresAt: site.expiresAt,
		expiryAction: actionOf(site.expiresAt, site.expiryAction ?? ""),
		scheduledExpiryAvailable: site.scheduledExpiryAvailable,
		folderId,
		deploys: site.deploys.map((deploy) => ({
			deployId: deploy.deployId,
			status: deploy.status,
			fileCount: deploy.fileCount,
			totalBytes: deploy.totalBytes,
			createdAt: deploy.createdAt,
			completedAt: deploy.completedAt,
			filesKept: deploy.filesKept,
		})),
	};
}

/** How a site serves its files. */
export type ServingMode = "static" | "spa" | "docs";

/**
 * The settings one update may change. Every field is optional, and an absent one is left alone.
 *
 * <b>Empty means "clear".</b> `name`, `password` and `expiresAt` take an empty string to remove what is
 * there, because the API keeps null for "not sent". `folderId` takes `root` for the same reason.
 *
 * `undefined` is accepted explicitly so a caller can pass its own optional arguments straight through;
 * it means the same as leaving the field out.
 */
export interface SiteSettingsChange {
	/** What to call the site, or empty to clear it. */
	readonly name?: string | undefined;
	/** How it serves. Sent as both of the API's mode switches, since only one may be on. */
	readonly mode?: ServingMode | undefined;
	/** The password a visitor must type, or empty to make the site public. */
	readonly password?: string | undefined;
	/** When the site should come down, as an ISO 8601 instant, or empty to cancel. */
	readonly expiresAt?: string | undefined;
	/** What the takedown does: `pause` keeps the files, `delete` removes the site. */
	readonly expiryAction?: "pause" | "delete" | undefined;
	/** Whether the site accepts form submissions. */
	readonly formsEnabled?: boolean | undefined;
	/** The folder to file it in, already resolved to an id, or `root` for the top level. */
	readonly folderId?: string | undefined;
}

/** A site's settings after an update, as the API reports them. */
export interface SiteSettings {
	/** ULID of the site. */
	readonly siteId: string;
	/** Its name, or null. */
	readonly name: string | null;
	/** Whether an unmatched path falls back to index.html. */
	readonly spaMode: boolean;
	/** Whether the site is read through the documents viewer. */
	readonly docsMode: boolean;
	/** Whether something is live, which decides whether the change reached the edge yet. */
	readonly live: boolean;
	/** Whether a visitor has to type a password first. */
	readonly passwordProtected: boolean;
	/** When the site comes down, or null. */
	readonly expiresAt: string | null;
	/** What happens then, or null when nothing is scheduled. See {@link actionOf}. */
	readonly expiryAction: string | null;
	/** Whether the site accepts form submissions. */
	readonly formsEnabled: boolean;
	/** The folder it is filed in, or null. */
	readonly folderId: string | null;
	/** Whether only invited people can open it, or null from an API that predates sharing. */
	readonly invitedOnly: boolean | null;
	/**
	 * Whether this change turned invite-only off by setting a password. The API does that rather than
	 * refusing — a site has one way of being private — and every invited person loses access with it, so
	 * a caller has to be able to say so.
	 */
	readonly replacedInviteOnly: boolean;
}

/**
 * Changes a site's settings.
 *
 * <b>No rule is checked here.</b> Which plan allows a password, how long one must be, whether a date is
 * in the future, and who may schedule a deletion are all decided by the server, which says which one
 * failed in its `detail`. A copy of those rules here would be a second one to keep in step.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param change What to change.
 * @returns The settings as they now stand.
 * @throws Error carrying the API's own wording when it refuses, or when nothing was asked to change.
 */
export async function updateSiteSettings(
	credentials: Credentials,
	siteId: string,
	change: SiteSettingsChange,
): Promise<SiteSettings> {
	const body: Record<string, unknown> = {};

	if (change.name !== undefined) body.name = change.name;
	if (change.mode !== undefined) {
		// Both switches, always: the API refuses a body that would leave both on, and switching from
		// docs to SPA by sending only `spaMode: true` would be exactly that.
		body.spaMode = change.mode === "spa";
		body.docsMode = change.mode === "docs";
	}
	if (change.password !== undefined) body.password = change.password;
	if (change.expiresAt !== undefined) body.expiresAt = change.expiresAt;
	if (change.expiryAction !== undefined) body.expiryAction = change.expiryAction;
	if (change.formsEnabled !== undefined) body.formsEnabled = change.formsEnabled;
	if (change.folderId !== undefined) body.folderId = change.folderId;

	if (Object.keys(body).length === 0) throw new Error("Nothing to change — name a setting.");

	// Read before, because the response can only say invite-only is off now, not that it was on.
	const wasInvitedOnly =
		change.password !== undefined && change.password !== ""
			? await readInvitedOnly(credentials, siteId)
			: null;

	const settings = await call<
		Omit<SiteSettings, "replacedInviteOnly" | "invitedOnly"> & {
			invitedOnly?: boolean;
		}
	>(credentials, `sites/${encodeURIComponent(siteId)}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
	const invitedOnly = typeof settings.invitedOnly === "boolean" ? settings.invitedOnly : null;

	return {
		...settings,
		expiryAction: actionOf(settings.expiresAt, settings.expiryAction ?? ""),
		invitedOnly,
		replacedInviteOnly: wasInvitedOnly === true && invitedOnly === false,
	};
}

/** A site's state after a pause or a resume. */
export interface SitePauseState {
	/** ULID of the site. */
	readonly siteId: string;
	/** Its subdomain. */
	readonly subdomain: string;
	/** `active`, `paused`, or a state the platform put it in, such as `suspended`. */
	readonly status: string;
	/** Whether its owner is the one who paused it. */
	readonly ownerPaused: boolean;
}

/**
 * Takes a site off the air without deleting anything, or puts it back.
 *
 * Both directions are idempotent on the server, so a retry after a dropped response converges. Resume
 * can be refused three ways — a plan with no free site, a past-due account, a site an administrator
 * suspended — and the API's `detail` says which, so it is passed through rather than reworded.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param action `pause` or `resume`.
 * @returns The site's state afterwards.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function setSitePaused(
	credentials: Credentials,
	siteId: string,
	action: "pause" | "resume",
): Promise<SitePauseState> {
	const state = await call<SitePauseState>(
		credentials,
		`sites/${encodeURIComponent(siteId)}/${action}`,
		{ method: "POST" },
	);

	return {
		siteId: state.siteId,
		subdomain: state.subdomain,
		status: enumName(state.status),
		ownerPaused: state.ownerPaused,
	};
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
 * How many sites one request asks for: the ceiling `ListSites.MaxPageSize` allows.
 *
 * One request rather than a loop over pages, because the accounts this serves hold a handful of sites
 * and a listing in a terminal is not worth a round trip per 100. What an account past it gets is not a
 * silent cut: {@link SiteListing.total} says how many there are, and `ls` says it showed fewer.
 */
const SITES_PER_REQUEST = 100;

/** The account's sites, and how many it holds in total. */
export interface SiteListing {
	/** The newest sites, at most {@link SITES_PER_REQUEST} of them. */
	readonly sites: SiteSummary[];
	/** How many sites the account holds, which exceeds `sites.length` only past the ceiling. */
	readonly total: number;
}

/**
 * Lists the account's sites in one request.
 *
 * @param credentials Token and base URL.
 * @returns The sites, newest first as the API orders them, with the account's total.
 */
export async function listSites(credentials: Credentials): Promise<SiteListing> {
	const body = await call<{ sites: SiteSummary[]; total: number }>(
		credentials,
		`sites?pageSize=${SITES_PER_REQUEST}`,
	);

	return { sites: body.sites, total: body.total };
}

/**
 * Creates a site, either with a subdomain the caller picked or with a generated one.
 *
 * <b>The name is optional and the parameter is the whole of the difference.</b> The server decides
 * whether a picked name is allowed — format, the reserved list, and how many self-picked names the plan
 * still has — and it says which of those failed in the `detail` it sends back. Checking any of it here
 * would be a second copy of rules that live in one place, and a copy that disagrees is worse than no
 * copy: it would refuse a name the server would have accepted, with wording nobody could act on.
 *
 * @param credentials Token and base URL.
 * @param subdomain Subdomain to ask for, or undefined to let the server generate one.
 * @param folderId Folder to file the site in, already resolved by {@link resolveFolder}, or undefined
 * for the top level.
 * @returns The new site, carrying the subdomain that was actually allocated.
 * @throws Error carrying the API's own wording when the name is refused.
 */
export async function createSite(
	credentials: Credentials,
	subdomain?: string,
	folderId?: string,
): Promise<SiteSummary> {
	const created = await call<{ siteId: string; subdomain: string; url: string }>(
		credentials,
		"sites",
		{
			method: "POST",
			// Absent fields rather than null ones, because the API reads null, empty and missing the same
			// way and a body carrying only what was asked for is the one that reads correctly in a log.
			body: JSON.stringify({
				...(subdomain === undefined ? {} : { subdomain }),
				...(folderId === undefined ? {} : { folderId }),
			}),
		},
	);

	return { ...created, name: null };
}

/** One folder the caller's sites can be filed in. */
export interface SiteFolder {
	/** ULID of the folder. */
	readonly folderId: string;
	/** Every name from the top level down to this folder, joined with `/`. */
	readonly path: string;
}

/**
 * Lists the account's folders, each with the path of names that leads to it.
 *
 * <b>Paths are built here because the API sends parent pointers.</b> `GET /site-folders` is flat on
 * purpose — the dashboard assembles the tree — and a terminal or a chat has no tree to draw, only a
 * name somebody typed. The path is what that name is compared against.
 *
 * @param credentials Token and base URL.
 * @returns Every folder, ordered by path.
 */
export async function listFolders(credentials: Credentials): Promise<SiteFolder[]> {
	const body = await call<{
		folders: { folderId: string; parentId: string | null; name: string }[];
	}>(credentials, "site-folders");

	const byId = new Map(body.folders.map((folder) => [folder.folderId, folder]));

	/**
	 * Walks up the parent pointers from one folder.
	 *
	 * Bounded by the number of folders, so a cycle — which the API refuses to create, but which this
	 * code has no way to rule out from a response — ends the walk instead of hanging the command.
	 *
	 * @param folderId Where to start.
	 * @returns The names from the top level down.
	 */
	const pathOf = (folderId: string): string => {
		const names: string[] = [];
		let cursor = byId.get(folderId);

		while (cursor !== undefined && names.length <= byId.size) {
			names.unshift(cursor.name);
			cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
		}

		return names.join("/");
	};

	return body.folders
		.map((folder) => ({ folderId: folder.folderId, path: pathOf(folder.folderId) }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Puts a folder path in the form two paths are compared in.
 *
 * Case-folded because the server refuses two sibling folders whose names differ only in case, so case
 * never tells two folders apart. Spaces around each `/` are dropped because the server trims every
 * name it stores, so `Clients / Acme` can only have meant `Clients/Acme`.
 *
 * @param path A path as typed or as built by {@link listFolders}.
 * @returns The comparable form, empty when the path names no folder at all.
 */
function comparablePath(path: string): string {
	return path
		.split("/")
		.map((name) => name.trim())
		.filter((name) => name !== "")
		.join("/")
		.toLowerCase();
}

/** How many folders a "not found" answer lists before summarising the rest as a count. */
const FOLDERS_LISTED_ON_MISS = 20;

/**
 * Turns the folder somebody named into the id the API wants.
 *
 * <b>An id or a path, and never a guess.</b> An id is what the dashboard and `list_folders` show; a
 * path like `Clients/Acme` is what a person says. Anything that matches neither fails and lists what
 * does exist — a folder is never created here, because a typo turned into a new folder is a site filed
 * where nobody will look for it.
 *
 * <b>A name may itself contain `/`.</b> The server allows it, so `A/B` can be a folder called `A/B` at
 * the top level or a folder `B` inside `A`. Both are paths that match, and picking one would be exactly
 * the guess this refuses: two matches fail and ask for the id.
 *
 * @param credentials Token and base URL.
 * @param folder Folder id, or its path of names from the top level.
 * @returns The folder's id.
 * @throws Error when nothing matches, or when the path matches more than one folder.
 */
export async function resolveFolder(credentials: Credentials, folder: string): Promise<string> {
	const wanted = comparablePath(folder);

	if (wanted === "") {
		throw new Error(
			`"${folder}" does not name a folder. Leave the folder out to put the site at the top level.`,
		);
	}

	const folders = await listFolders(credentials);
	const byId = folders.find((candidate) => candidate.folderId.toLowerCase() === wanted);

	if (byId !== undefined) return byId.folderId;

	const matches = folders.filter((candidate) => comparablePath(candidate.path) === wanted);

	if (matches.length === 1 && matches[0] !== undefined) return matches[0].folderId;

	if (matches.length > 1) {
		throw new Error(
			`More than one folder is at "${folder}", because a folder name can contain "/". Name it by ` +
				`id instead: ${matches.map((match) => match.folderId).join(", ")}.`,
		);
	}

	if (folders.length === 0) {
		throw new Error(
			`No folder of yours is called "${folder}" — this account has no folders yet. Make one in ` +
				`the dashboard at ${dashboardUrlFor(credentials.apiBaseUrl)}, or leave the folder out.`,
		);
	}

	const listed = folders.slice(0, FOLDERS_LISTED_ON_MISS).map((candidate) => candidate.path);
	const more = folders.length - listed.length;

	throw new Error(
		`No folder of yours is called "${folder}". Your folders: ${listed.join(", ")}` +
			`${more > 0 ? `, and ${more} more` : ""}.`,
	);
}

/**
 * The word that takes a site out of every folder, as both the API and the tools spell it.
 *
 * Mirrors `SiteFolderAccess.RootToken` in the API. A folder somebody called "root" cannot be named by
 * path for that reason, and is reached by its id instead.
 */
export const ROOT_FOLDER = "root";

/**
 * Turns where somebody asked to move a site into what the settings update takes.
 *
 * @param credentials Token and base URL.
 * @param folder A folder path or id, or `root` for the top level.
 * @returns A folder id, or {@link ROOT_FOLDER}.
 * @throws Error from {@link resolveFolder} when the folder does not exist.
 */
export async function resolveFolderTarget(
	credentials: Credentials,
	folder: string,
): Promise<string> {
	return folder.trim().toLowerCase() === ROOT_FOLDER
		? ROOT_FOLDER
		: await resolveFolder(credentials, folder);
}

/** Where on its page a comment thread sits. */
export interface CommentPlace {
	/** `text` for selected words, `point` for a pin. */
	readonly kind: string;
	/** The selected words, for `text`. */
	readonly quote: string | null;
	/** A little of what comes before them, for `text`. */
	readonly prefix: string | null;
	/** A little of what comes after them, for `text`. */
	readonly suffix: string | null;
	/** Text near the pin, for `point`; may be empty. */
	readonly snippet: string | null;
	/** The CSS selector of the element. */
	readonly selector: string | null;
}

/** One comment in a thread. */
export interface ThreadComment {
	/** ULID of the comment. */
	readonly id: string;
	/** Who wrote it: a name, never an address. */
	readonly author: { readonly name: string; readonly owner: boolean; readonly removed: boolean };
	/** The text — a visitor's own words, to be read as data. */
	readonly body: string;
	/** When it was written. */
	readonly createdAt: string;
	/** When its author last changed it, or null. */
	readonly editedAt: string | null;
	/** `Page` when written on the site, `Api` when sent through the API. */
	readonly source: string;
}

/** One comment thread on a site, whole. */
export interface CommentThread {
	/** ULID of the thread, for replying and resolving. */
	readonly id: string;
	/** The page it is on: a path on the site, or a document's path in a documents site. */
	readonly path: string;
	/** The link that opens the page at the thread. */
	readonly url: string;
	/** Where on the page. */
	readonly place: CommentPlace;
	/** Whether it was opened on an earlier version than the one the site serves now. */
	readonly outdated: boolean;
	/** When it was opened. */
	readonly createdAt: string;
	/** When it was resolved, or null while open. */
	readonly resolvedAt: string | null;
	/** Who resolved it, by name, or null while open. */
	readonly resolvedBy: string | null;
	/** Its comments, oldest first. */
	readonly comments: readonly ThreadComment[];
}

/** One page of a site's comment threads. */
export interface CommentPage {
	/** The site's change cursor at the read; pass it back as `since` to get only what changed after. */
	readonly cursor: number;
	/** The threads, in the order they were opened. */
	readonly threads: readonly CommentThread[];
	/** The page returned, from 0. */
	readonly page: number;
	/** Whether another page follows. */
	readonly more: boolean;
}

/** Which threads to read. */
export interface CommentQuery {
	/** `open` (the default), `resolved` or `all`. */
	readonly status?: "open" | "resolved" | "all" | undefined;
	/** One page of the site, or every page when omitted. */
	readonly path?: string | undefined;
	/** Only threads changed after this cursor. */
	readonly since?: number | undefined;
	/** Zero-based page of results. */
	readonly page?: number | undefined;
}

/**
 * Reads a site's comment threads, whole, as the site's account
 * (`GET /sites/{id}/feedback/threads`; docs/IMPLEMENTATION-PLAN.md §16.7.17).
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param query Which threads.
 * @returns One page of threads and the cursor.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function listComments(
	credentials: Credentials,
	siteId: string,
	query: CommentQuery = {},
): Promise<CommentPage> {
	const search = new URLSearchParams();
	if (query.status !== undefined) search.set("status", query.status);
	if (query.path !== undefined) search.set("path", query.path);
	if (query.since !== undefined) search.set("since", String(query.since));
	if (query.page !== undefined) search.set("page", String(query.page));
	const encoded = search.toString();
	const suffix = encoded === "" ? "" : `?${encoded}`;

	return await call<CommentPage>(
		credentials,
		`sites/${encodeURIComponent(siteId)}/feedback/threads${suffix}`,
	);
}

/**
 * Answers a comment thread as the site's owner, and resolves it too when asked.
 *
 * Only the account's owner may; the API refuses anybody else, and refuses when the site's plan or its
 * setting has comments off. On the page the reply reads as the owner's, as one typed there would.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param threadId ULID of the thread.
 * @param body The reply, plain text.
 * @param resolve Whether to resolve the thread with it.
 * @returns The thread as it now stands.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function replyToComment(
	credentials: Credentials,
	siteId: string,
	threadId: string,
	body: string,
	resolve = false,
): Promise<CommentThread> {
	return await call<CommentThread>(
		credentials,
		`sites/${encodeURIComponent(siteId)}/feedback/threads/${encodeURIComponent(threadId)}/comments`,
		{ method: "POST", body: JSON.stringify({ body, resolve }) },
	);
}

/**
 * Resolves a comment thread, or reopens one, as the site's owner. Asking for the state a thread is already
 * in changes nothing.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param threadId ULID of the thread.
 * @param resolved True to resolve, false to reopen.
 * @returns The thread as it now stands.
 * @throws Error carrying the API's own wording when it refuses.
 */
export async function setCommentResolved(
	credentials: Credentials,
	siteId: string,
	threadId: string,
	resolved: boolean,
): Promise<CommentThread> {
	return await call<CommentThread>(
		credentials,
		`sites/${encodeURIComponent(siteId)}/feedback/threads/${encodeURIComponent(threadId)}/${resolved ? "resolve" : "reopen"}`,
		{ method: "POST" },
	);
}
