import type { SiteDetail, SiteUpstreams } from "./api.js";

/**
 * How a site's settings read in a terminal and in a chat.
 *
 * <b>One wording for both surfaces.</b> The CLI's `info` and the MCP server's `get_site` answer the same
 * question, and two descriptions of one site are two chances to disagree about whether it is public.
 */

/** How many versions a description lists before summarising the rest as a count. */
const VERSIONS_LISTED = 10;

/**
 * Names a site's serving mode.
 *
 * @param site The site.
 * @returns `spa`, `docs` or `static`.
 */
export function servingModeOf(site: Pick<SiteDetail, "spaMode" | "docsMode">): string {
	if (site.spaMode) return "spa";
	if (site.docsMode) return "docs";

	return "static";
}

/**
 * Says who can open a site.
 *
 * <b>Never "public" on a guess.</b> Invite-only is read from a second request that may not answer, and
 * calling a site public because that request failed is the one wrong answer that matters here.
 *
 * @param site The site.
 * @returns `password`, `invite-only`, `public`, or a sentence saying invite-only could not be read.
 */
export function accessOf(site: Pick<SiteDetail, "passwordProtected" | "invitedOnly">): string {
	if (site.passwordProtected) return "password";
	if (site.invitedOnly === true) return "invite-only";
	if (site.invitedOnly === false) return "public";

	return "no password (whether it is invite-only could not be read)";
}

/**
 * The lines about the site's address beyond the address itself: the names it used to have, and how many
 * more times it may change. Nothing for a site that has never moved on a plan with no limit.
 *
 * @param site The site.
 * @returns Zero, one or two lines.
 */
function addressLines(site: SiteDetail): string[] {
	return [
		...(site.formerSubdomains.length > 0
			? [`  formerly ${site.formerSubdomains.join(", ")} (redirect here)`]
			: []),
		...(site.subdomainChangesLeft === null
			? []
			: [`  address   ${site.subdomainChangesLeft} change(s) left`]),
	];
}

/**
 * The lines about a site's API proxy (docs/briefs/API-PROXY-BRIEF.md): the account's month, each upstream with
 * its methods and header names — the last four characters of a value, never the value — and the live routes.
 *
 * Nothing when the proxy could not be read or is not switched on, so a deployment without it describes sites as
 * it always did. A plan without the proxy and nothing declared reads as one line, like the other settings the
 * plan does not include.
 *
 * @param api What {@link readUpstreams} returned.
 * @returns The lines.
 */
export function describeUpstreams(api: SiteUpstreams | null): string[] {
	if (api === null) return [];

	const { allowance } = api;
	if (allowance.perMonth <= 0 && api.upstreams.length === 0)
		return ["  api       off (not on this plan)"];

	const state = api.proxyBlocked
		? "switched off by Drop2Run — its routes answer 404"
		: allowance.perMonth <= 0
			? "not on this plan — its routes answer 404"
			: allowance.suspended
				? `this month's ${allowance.perMonth.toLocaleString("en-US")} requests are spent — calls answer 429 until ${allowance.resetsAt.slice(0, 10)}`
				: `${allowance.used.toLocaleString("en-US")} of ${allowance.perMonth.toLocaleString("en-US")} requests this month, every site of the account`;

	return [
		`  api       ${state}`,
		...api.upstreams.map((upstream) => {
			const headers =
				upstream.headers.length === 0
					? "no headers"
					: upstream.headers.map((header) => `${header.name} ••••${header.last4}`).join(", ");
			const blocked = upstream.blocked ? " — blocked by Drop2Run, calls answer 502" : "";
			return `    ${upstream.origin}  ${upstream.methods.join(", ")}; ${headers}${blocked}`;
		}),
		...(api.upstreams.length === 0 ? ["    no upstream declared"] : []),
		...api.routes.map((route) => `    route ${route.from} → ${route.to}`),
	];
}

/**
 * Describes a site's settings, state and recent versions as lines of text.
 *
 * A setting the plan does not include says so, because "off" alone reads as something that could be
 * switched on, and the refusal that follows trying is a worse way to learn it.
 *
 * @param site The site, as {@link getSite} reads it.
 * @param folderPath The path of the folder it is filed in, when the caller looked it up; the id is
 * shown otherwise.
 * @param api The site's API connections, from {@link readUpstreams}; left out when absent or null.
 * @returns The description.
 */
export function describeSite(
	site: SiteDetail,
	folderPath?: string,
	api: SiteUpstreams | null = null,
): string {
	const unavailable = (available: boolean) => (available ? "" : " (not on this plan)");
	const versions = site.deploys.slice(0, VERSIONS_LISTED).map((deploy) => {
		// Marked from the site's own pointer as well as the status, which is the one a rollback moves.
		const live = deploy.deployId === site.liveDeployId ? " ← served" : "";
		const kept = deploy.filesKept ? "" : ", files collected — cannot be rolled back to";

		return `  ${deploy.deployId}  ${deploy.createdAt}  ${deploy.status}, ${deploy.fileCount} files${kept}${live}`;
	});
	const more = site.deploys.length - versions.length;

	return [
		`${site.subdomain} — ${site.url}`,
		`  name      ${site.name ?? "(none)"}`,
		`  status    ${site.status}`,
		`  access    ${accessOf(site)}`,
		`  mode      ${servingModeOf(site)}${site.modeIsManual ? "" : " (detected on each publish)"}`,
		`  password  ${site.passwordProtected ? "on" : "off"}${unavailable(site.passwordProtectionAvailable)}`,
		`  forms     ${site.formsEnabled ? "on" : "off"}${unavailable(site.formsAvailable)}`,
		`  comments  ${site.comments ?? "unknown"}${unavailable(site.commentsAvailable)}`,
		`  takedown  ${site.expiresAt === null ? "none" : `${site.expiresAt} (${site.expiryAction})`}${unavailable(site.scheduledExpiryAvailable)}`,
		`  folder    ${site.folderId === null ? "(top level)" : (folderPath ?? site.folderId)}`,
		...addressLines(site),
		...describeUpstreams(api),
		"",
		site.deploys.length === 0 ? "No versions yet." : "Versions, newest first:",
		...versions,
		...(more > 0 ? [`  … and ${more} older`] : []),
	].join("\n");
}
