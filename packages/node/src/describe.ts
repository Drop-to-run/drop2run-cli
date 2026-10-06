import type { SiteDetail } from "./api.js";

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
 * Describes a site's settings, state and recent versions as lines of text.
 *
 * A setting the plan does not include says so, because "off" alone reads as something that could be
 * switched on, and the refusal that follows trying is a worse way to learn it.
 *
 * @param site The site, as {@link getSite} reads it.
 * @param folderPath The path of the folder it is filed in, when the caller looked it up; the id is
 * shown otherwise.
 * @returns The description.
 */
export function describeSite(site: SiteDetail, folderPath?: string): string {
	const unavailable = (available: boolean) => (available ? "" : " (not on this plan)");
	const versions = site.deploys.slice(0, VERSIONS_LISTED).map((deploy) => {
		const live = deploy.deployId === site.liveDeployId ? " ← live" : "";
		const kept = deploy.filesKept ? "" : ", files collected";

		return `  ${deploy.deployId}  ${deploy.createdAt}  ${deploy.status}, ${deploy.fileCount} files${kept}${live}`;
	});
	const more = site.deploys.length - versions.length;

	return [
		`${site.subdomain} — ${site.url}`,
		`  name      ${site.name ?? "(none)"}`,
		`  status    ${site.status}`,
		`  mode      ${servingModeOf(site)}${site.modeIsManual ? "" : " (detected on each publish)"}`,
		`  password  ${site.passwordProtected ? "on" : "off"}${unavailable(site.passwordProtectionAvailable)}`,
		`  forms     ${site.formsEnabled ? "on" : "off"}${unavailable(site.formsAvailable)}`,
		`  takedown  ${site.expiresAt === null ? "none" : `${site.expiresAt} (${site.expiryAction})`}${unavailable(site.scheduledExpiryAvailable)}`,
		`  folder    ${site.folderId === null ? "(top level)" : (folderPath ?? site.folderId)}`,
		"",
		site.deploys.length === 0 ? "No versions yet." : "Versions, newest first:",
		...versions,
		...(more > 0 ? [`  … and ${more} older`] : []),
	].join("\n");
}
