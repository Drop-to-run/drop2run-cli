/**
 * The parts of `@drop2run/node` that run where there is no disk: the API client, the wording that
 * describes a site, and publishing files that were written rather than read.
 *
 * <b>Why an entry of its own.</b> The remote MCP Worker (docs/briefs/REMOTE-MCP-BRIEF.md §4.1) serves the
 * same tools as the local server, and a Worker has no home directory and no config file. Importing the
 * package's main entry would pull `config.ts` in, and with it `node:fs` — a bundle that either fails to
 * build or carries a stub that fails at the first call. Everything exported here reaches nothing in
 * `node:`, and `packages/mcp/test/portable.test.ts` bundles the module built on it to keep it that way.
 *
 * The main entry re-exports all of it, so the CLI and the local server import from one place as before.
 */

export {
	type AccessToken,
	type ApiFailure,
	type CommentAudience,
	type CommentPage,
	type CommentPlace,
	type CommentQuery,
	type CommentThread,
	createSite,
	deleteSite,
	findSite,
	getSite,
	type Invitation,
	invitePeople,
	isTokenRefused,
	listComments,
	listFolders,
	listPeople,
	listSites,
	listTokens,
	lookUpSite,
	type PersonRole,
	type PromotedDeploy,
	promoteDeploy,
	ROOT_FOLDER,
	readInvitedOnly,
	removePerson,
	replyToComment,
	resolveFolder,
	resolveFolderTarget,
	type ServingMode,
	type SiteDetail,
	type SiteFolder,
	type SiteListing,
	type SitePauseState,
	type SitePeople,
	type SitePerson,
	type SiteSettings,
	type SiteSettingsChange,
	type SiteSummary,
	type SiteVersion,
	setCommentResolved,
	setSitePaused,
	type ThreadComment,
	updateSiteSettings,
} from "./api.js";
export { type Credentials, DEFAULT_API_BASE_URL, dashboardUrlFor } from "./credentials.js";
export { accessOf, describeSite, servingModeOf } from "./describe.js";
export {
	type AuthoredFile,
	describeMode,
	type NewSite,
	type PublishResult,
	publish,
	publishFiles,
} from "./publish.js";
