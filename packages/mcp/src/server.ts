import {
	type Credentials,
	deleteSite,
	describeMode,
	describeSite,
	findSite,
	getSite,
	listFolders,
	listSites,
	loadCredentials,
	missingCredentialsMessage,
	type PublishResult,
	promoteDeploy,
	publishDirectory,
	publishFiles,
	resolveFolderTarget,
	type SiteDetail,
	type SiteSettingsChange,
	servingModeOf,
	setSitePaused,
	updateSiteSettings,
} from "@drop2run/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_WAIT_SECONDS, signInWithBrowser, signInWithCode } from "./auth.js";

/**
 * The MCP surface: the tools that need a token, and two that get one.
 *
 * <b>Every tool answers, none of them throws at startup.</b> A server with no credential is
 * unconfigured rather than broken, and the difference is what the person sees: a sentence in the chat
 * telling them how to sign in, rather than a client reporting that the server died. That is why
 * credentials are read per call instead of once at boot — it also means a token stored while the chat
 * is open starts working without restarting anything, which is what makes `login` a tool rather than
 * an instruction to go and do something in a terminal.
 */

/**
 * The version this server reports to a client.
 *
 * Written here rather than read from `package.json` because the build bundles this file for node and a
 * runtime read would resolve against `dist/`, not the package root. A test asserts the two match, so a
 * release that bumps only the manifest fails before it is published rather than telling every client
 * the wrong version.
 */
const SERVER_VERSION = "0.8.0";

/**
 * How the tools below describe their own effects to a client.
 *
 * These are the hints a host reads to decide what to confirm with the person before running, so they
 * are a safety surface rather than documentation: a tool that replaces a live website while claiming
 * to be read-only is asking to be run without being shown. Anthropic's connector review treats a wrong
 * hint as a rejection, and the SDK's silence is the reason to be explicit — the spec's default for
 * `destructiveHint` is true, so a tool that omits it is read as destructive whether or not it is, and
 * `list_sites` would be confirmed like a publish.
 *
 * `openWorldHint` is true on every one of them: all of them talk to dropto.run, and none of them is
 * answerable from this machine alone.
 */

/**
 * Stores a token where the other tools will find it.
 *
 * Not read-only — it writes a credential file — but not destructive either: nothing the person owns is
 * replaced, and `replace` swaps a token the caller asked to swap. Not idempotent, because a second
 * successful sign-in can land on a different account than the first.
 */
const CREDENTIAL_WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
} as const;

/**
 * Replaces what a site serves.
 *
 * Destructive on purpose and not as a formality: publishing over an existing subdomain takes down the
 * pages that were there. That it is cheap for us to do — a KV flip onto an immutable deploy — says
 * nothing to the person whose URL now shows something else, which is who the hint is for.
 *
 * Not idempotent, and the reason is the `site` argument rather than the content: an identical publish
 * to a named site answers "already live" and writes no new version, but the same call with `site`
 * omitted creates one more site every time it runs.
 */
const REPLACES_A_SITE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;

/**
 * Reads and changes nothing.
 *
 * `destructiveHint` and `idempotentHint` are left off rather than set to safe-looking values: the spec
 * gives them meaning only when `readOnlyHint` is false, and writing them here would suggest this tool
 * was weighed on a scale that does not apply to it.
 */
const READS_ONLY = {
	readOnlyHint: true,
	openWorldHint: true,
} as const;

/**
 * What a publish answers with, beside the sentence.
 *
 * Shared by both publish tools because they differ in what they take, not in what they produce — and a
 * model that has learned one shape should not have to learn the other to do the same thing with it.
 */
const PUBLISH_OUTPUT = {
	url: z.string().describe("The live URL of the published site."),
	siteId: z.string().describe("Identifier of the site, stable across publishes."),
	subdomain: z.string().describe("The site's subdomain, which is what `site` accepts."),
	files: z.number().int().describe("How many files the site now serves."),
	unchanged: z
		.boolean()
		.describe(
			"True when every file already matched what the site served, so no new version was published.",
		),
};

/**
 * Takes a site down for good.
 *
 * The only tool here whose effect no later call can undo. A publish over a site replaces what it
 * serves and the site survives; this removes the site, its history and its subdomain, and the
 * subdomain is the part that matters — it is the URL somebody else already has.
 *
 * `idempotentHint` is false and means it: a second call does not quietly succeed, it fails to find
 * anything, which is the honest answer and the one that stops a retry loop from looking like progress.
 */
const REMOVES_A_SITE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;

/**
 * Changes how a site serves, or whether it does, in a way a later call can put back.
 *
 * Destructive because the person's visitors feel it: a password, a pause, a rollback or a scheduled
 * deletion each change what a URL somebody already has shows. Idempotent because each one sets a state
 * rather than adding to one — the same call twice leaves the site where the first one did.
 */
const CHANGES_A_SITE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

/**
 * Puts a paused site back on the air.
 *
 * Not destructive: nothing that was there is replaced, the site returns to serving what it served.
 */
const RESTORES_A_SITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

/** `site` on every tool that acts on one existing site. */
const SITE_INPUT = z.string().min(1).describe("Subdomain or site id, from list_sites.");

/** One version of a site, as `get_site` reports it. */
const VERSION_OUTPUT = z.object({
	deployId: z.string().describe("Identifier of the version, which rollback_site takes."),
	status: z.string().describe("`ready` for a version that finished publishing."),
	fileCount: z.number().int().describe("How many files it carries."),
	createdAt: z.string().describe("When it was published, ISO 8601."),
	filesKept: z
		.boolean()
		.describe(
			"Whether its files are still stored; a version without them cannot be rolled back to.",
		),
	live: z.boolean().describe("Whether this is the version being served."),
});

/** A site's settings, as `get_site` and `update_site` both report them. */
const SETTINGS_OUTPUT = {
	siteId: z.string().describe("Identifier of the site."),
	name: z.string().nullable().describe("What it is called, or null."),
	mode: z.enum(["static", "spa", "docs"]).describe("How it serves its files."),
	passwordProtected: z.boolean().describe("Whether visitors must type a password."),
	formsEnabled: z.boolean().describe("Whether it accepts form submissions."),
	expiresAt: z.string().nullable().describe("When it is scheduled to come down, or null."),
	expiryAction: z.string().describe("What the takedown does: `pause` or `delete`."),
	folderId: z.string().nullable().describe("The folder it is filed in, or null at the top level."),
};

/** What `pause_site` and `resume_site` report. */
const PAUSE_OUTPUT = {
	siteId: z.string().describe("Identifier of the site."),
	subdomain: z.string().describe("Its subdomain."),
	status: z.string().describe("`active` or `paused` afterwards."),
	ownerPaused: z.boolean().describe("Whether the pause is the owner's own."),
};

/**
 * Looks up the path of the folder a site is filed in, for a description.
 *
 * @param credentials Token and base URL.
 * @param folderId The folder's id, or null.
 * @returns Its path, or undefined at the top level or when it is not found.
 */
async function folderPathOf(
	credentials: Credentials,
	folderId: string | null,
): Promise<string | undefined> {
	if (folderId === null) return undefined;

	return (await listFolders(credentials)).find((folder) => folder.folderId === folderId)?.path;
}

/**
 * A site's detail as `get_site` structures it.
 *
 * @param site The site.
 * @returns The structured answer.
 */
function structuredSite(site: SiteDetail): Record<string, unknown> {
	return {
		siteId: site.siteId,
		subdomain: site.subdomain,
		url: site.url,
		name: site.name,
		status: site.status,
		mode: servingModeOf(site),
		passwordProtected: site.passwordProtected,
		formsEnabled: site.formsEnabled,
		expiresAt: site.expiresAt,
		expiryAction: site.expiryAction,
		folderId: site.folderId,
		available: {
			password: site.passwordProtectionAvailable,
			forms: site.formsAvailable,
			scheduledTakedown: site.scheduledExpiryAvailable,
		},
		versions: site.deploys.map((deploy) => ({
			deployId: deploy.deployId,
			status: deploy.status,
			fileCount: deploy.fileCount,
			createdAt: deploy.createdAt,
			filesKept: deploy.filesKept,
			live: deploy.deployId === site.liveDeployId,
		})),
	};
}

/** One site, as `list_sites` reports it. */
const SITE_OUTPUT = z.object({
	siteId: z.string().describe("Identifier of the site."),
	subdomain: z.string().describe("Its subdomain, which is what `site` accepts."),
	url: z.string().describe("Its live URL."),
	name: z.string().nullable().describe("What it is called, or null when it has no name."),
});

/** One folder, as `list_folders` reports it. */
const FOLDER_OUTPUT = z.object({
	folderId: z.string().describe("Identifier of the folder, which `folder` accepts."),
	path: z
		.string()
		.describe(
			"Every name from the top level down to it, joined with /, which `folder` accepts too.",
		),
});

/**
 * `folder` on both publish tools.
 *
 * Shared for the reason {@link PUBLISH_OUTPUT} is: the two tools differ in where files come from, not
 * in where a new site goes, and two descriptions of one argument are two chances for them to disagree.
 */
const FOLDER_INPUT = z
	.string()
	.optional()
	.describe(
		"Folder to file the new site in, when the person asked for one: its path of names such as " +
			"Clients/Acme, or its id from list_folders. Only for a new site — do not pass it together " +
			"with `site`; moving an existing site is update_site's `folder`. It never creates a folder: a " +
			"folder that does not exist is refused with the list of those that do, and nothing is published.",
	);

/** What a tool hands back to the client. */
type ToolResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

/**
 * Wraps text as a tool result.
 *
 * @param text What to say.
 * @param isError Whether the client should treat it as a failure.
 * @returns The result.
 */
function say(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Wraps a result that is both read and used.
 *
 * <b>Why both halves.</b> The prose is what a person sees in the chat and it stays the same sentence it
 * was. The `structuredContent` beside it is for the model: a publish whose URL is only stated in
 * English has to be read back out of English before anything can be done with it, and "publish this,
 * then send me the link" is the shape most of these requests take. A tool that declares an
 * `outputSchema` and answers with a paragraph is a tool whose next step is a guess.
 *
 * The text is not derived from the structure, deliberately. They answer different questions — one says
 * what happened, the other says what it happened to — and generating the sentence from the fields
 * would make the sentence worse in exactly the way that reads as machine output.
 *
 * @param text What a person reads.
 * @param structured What a model reads, matching the tool's declared `outputSchema`.
 * @returns The result.
 */
function report(text: string, structured: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Runs a tool with credentials, turning both absence and failure into something readable.
 *
 * @param work What to do once there are credentials.
 * @returns The tool result.
 */
async function withCredentials(
	work: (credentials: Credentials) => Promise<string | ToolResult>,
): Promise<ToolResult> {
	const credentials = loadCredentials();
	// "mcp" rather than the default: the message names the first step, and here that step is the `login`
	// tool. It used to name `drop2run login`, a command nobody who installed only this server has.
	if (credentials === null) return say(missingCredentialsMessage("mcp"), true);

	return attempt(() => work(credentials));
}

/**
 * Runs a tool, turning a thrown error into something readable rather than a protocol failure.
 *
 * @param work What to do.
 * @returns The tool result.
 */
async function attempt(work: () => Promise<string | ToolResult>): Promise<ToolResult> {
	try {
		// A string is the plain case — a tool with nothing structured to say. Anything else is already a
		// result, built by `report` because the tool declares an `outputSchema`.
		const answer = await work();

		return typeof answer === "string" ? say(answer) : answer;
	} catch (error) {
		// The message rather than the stack: these are read in a chat, and every one of them is either the
		// API's own `detail` or a sentence this package wrote.
		return say(error instanceof Error ? error.message : String(error), true);
	}
}

/**
 * How a finished publish reads in the chat.
 *
 * Says "already live" distinctly from "published", because they are different answers to the same
 * request and collapsing them would report work that did not happen.
 *
 * @param result What the publish returned.
 * @returns The text.
 */
function describe(result: PublishResult): string {
	const what = result.unchanged
		? "Already live — every file matched what the site already serves, so no new version was published."
		: `Published ${result.files.toLocaleString()} ${result.files === 1 ? "file" : "files"}.`;

	const mode = describeMode(result);

	return [
		what,
		"",
		result.url,
		"",
		...(mode === null ? [] : [mode, ""]),
		`Site ${result.subdomain} (${result.siteId}). Reaching every edge takes up to about a minute.`,
	].join("\n");
}

/**
 * Builds the server with its tools registered.
 *
 * @returns The server, ready to connect to a transport.
 */
export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "drop2run", version: SERVER_VERSION },
		{
			instructions: [
				"Publishes pages, documents and static sites to Drop2Run, and returns a URL.",
				"",
				"Use publish_files for anything you wrote here — a page, a markdown note, several files",
				"together — and publish_dir for a folder that already exists on disk. Leave `site` unset to",
				"publish to a brand-new site; pass a subdomain to publish over an existing one. list_sites",
				"shows what already exists.",
				"",
				"A new site gets a generated name unless `subdomain` asks for one. Pass it when the person",
				"named the address they want, and otherwise leave it out — a name is what somebody will be",
				"given as a URL, it cannot be changed later, and a site created under a guessed one has to",
				"be deleted by hand. `site` and `subdomain` are opposites: one publishes over a site that",
				"exists, the other creates one that does not. Never pass both.",
				"",
				"A new site goes at the top level of the dashboard unless `folder` files it somewhere. Pass",
				"it when the person named a folder, as its path (Clients/Acme) or its id; list_folders shows",
				"what exists. Like `subdomain`, it only describes a new site, so never pass it with `site`.",
				"",
				"A site needs an index.html at its top level, or at least one document (.md, .markdown,",
				".pdf, .docx, .xlsx or .epub), which publishes as a documents site and is read through a",
				"viewer. So one page goes at index.html, and a single note is a whole publish that needs",
				"no wrapping in HTML.",
				"",
				"Publishing needs an access token. If there is none, call login — it opens a browser and",
				"stores one, and no command line or manual token is involved. Where no browser can be",
				"opened, login_code gives a short code to approve from another machine.",
				"",
				"Publishing over an existing site replaces what it serves, so ask before doing that to a",
				"site the person did not name.",
				"",
				"delete_site is permanent and frees the subdomain for anybody to claim. Ask the person for",
				"the subdomain and pass what they say as `confirm` — do not fill it in from what you already",
				"know, because being told it is the point of the step.",
				"",
				"An existing site's settings are read with get_site and changed with update_site: its name,",
				"serving mode (static, spa, docs), a password, whether forms accept submissions, a scheduled",
				"takedown, and its folder. pause_site and resume_site take it off the air and back without",
				"deleting anything, and rollback_site serves an earlier version from get_site's list. Use",
				"a password or a date only when the person gave one, and scheduling a deletion asks for",
				"`confirm` the way delete_site does.",
			].join("\n"),
		},
	);

	server.registerTool(
		"login",
		{
			title: "Sign in to Drop2Run",
			description:
				"Signs in through a browser on this machine and stores an access token, which every other " +
				"tool then uses. Opens the browser here and waits for the person to approve. If it answers " +
				"that nothing has been approved yet, call it again to keep waiting — that is not a " +
				"failure. Needs no command line and no token pasted by hand.",
			inputSchema: {
				waitSeconds: z
					.number()
					.int()
					.min(5)
					.max(MAX_WAIT_SECONDS)
					.optional()
					.describe("How long this call waits for the approval before answering. Default 120."),
				replace: z
					.boolean()
					.optional()
					.describe(
						"Sign in even though a token is already stored. Use when switching accounts, or " +
							"when the stored token is being refused.",
					),
			},
			annotations: CREDENTIAL_WRITE,
		},
		({ waitSeconds, replace }) => attempt(() => signInWithBrowser(waitSeconds, replace)),
	);

	server.registerTool(
		"login_code",
		{
			title: "Sign in with a code",
			description:
				"Signs in where no browser can be opened on this machine — a container, a remote host. The " +
				"first call returns a short code and a URL to enter it at, which the person opens " +
				"anywhere; call it again to wait for the approval and store the token.",
			inputSchema: {
				waitSeconds: z
					.number()
					.int()
					.min(5)
					.max(MAX_WAIT_SECONDS)
					.optional()
					.describe("How long a waiting call polls before answering. Default 120."),
				replace: z.boolean().optional().describe("Sign in even though a token is already stored."),
			},
			annotations: CREDENTIAL_WRITE,
		},
		({ waitSeconds, replace }) => attempt(() => signInWithCode(waitSeconds, replace)),
	);

	server.registerTool(
		"publish_files",
		{
			title: "Publish files you wrote",
			description:
				"Publishes one or more files written here — markdown, HTML, CSS, JSON — as a site, and " +
				"returns its URL. A single page goes at index.html; a single .md, .markdown or .pdf file " +
				"is a site on its own, served through the documents viewer. Text only: a PDF or an image " +
				"has to be published from disk with publish_dir.",
			inputSchema: {
				files: z
					.array(
						z.object({
							path: z
								.string()
								.min(1)
								.describe("Path inside the site, such as index.html or docs/guide.md."),
							content: z.string().describe("The file's contents."),
						}),
					)
					.min(1)
					.describe("The files to publish."),
				site: z
					.string()
					.optional()
					.describe("Subdomain or site id to publish over. Omit to create a new site."),
				subdomain: z
					.string()
					.optional()
					.describe(
						"Subdomain to create the new site under, when the person asked for a particular " +
							"address. Only for a new site: leave it out to publish over an existing one, " +
							"and do not pass it together with `site`. Ask rather than inventing one — the " +
							"name is the URL somebody will be given, it cannot be changed afterwards, and " +
							"an unused site made under a guessed name has to be deleted by hand.",
					),
				folder: FOLDER_INPUT,
			},
			outputSchema: PUBLISH_OUTPUT,
			annotations: REPLACES_A_SITE,
		},
		({ files, site, subdomain, folder }) =>
			withCredentials(async (credentials) => {
				const result = await publishFiles(credentials, files, site, { subdomain, folder });

				return report(describe(result), { ...result });
			}),
	);

	server.registerTool(
		"publish_dir",
		{
			title: "Publish a folder",
			description:
				"Publishes a folder from disk and returns its URL. The folder needs an index.html at its " +
				"root, or documents (.md, .pdf, .docx, .xlsx, .epub), which are served through the reader.",
			inputSchema: {
				path: z.string().min(1).describe("Absolute path of the folder to publish."),
				site: z
					.string()
					.optional()
					.describe("Subdomain or site id to publish over. Omit to create a new site."),
				subdomain: z
					.string()
					.optional()
					.describe(
						"Subdomain to create the new site under, when the person asked for a particular " +
							"address. Only for a new site: leave it out to publish over an existing one, " +
							"and do not pass it together with `site`. Ask rather than inventing one — the " +
							"name is the URL somebody will be given, it cannot be changed afterwards, and " +
							"an unused site made under a guessed name has to be deleted by hand.",
					),
				folder: FOLDER_INPUT,
			},
			outputSchema: PUBLISH_OUTPUT,
			annotations: REPLACES_A_SITE,
		},
		({ path, site, subdomain, folder }) =>
			withCredentials(async (credentials) => {
				const result = await publishDirectory(credentials, path, site, undefined, {
					subdomain,
					folder,
				});

				return report(describe(result), { ...result });
			}),
	);

	server.registerTool(
		"delete_site",
		{
			title: "Delete a site",
			description:
				"Takes a site down permanently — its files, its history and its subdomain. Nothing here " +
				"undoes it, and the subdomain becomes available for anybody to claim. Requires `confirm` " +
				"to repeat the site's own subdomain exactly; ask the person for it rather than filling it " +
				"in from what you already know, because that is the step this asks for.",
			inputSchema: {
				site: z.string().min(1).describe("Subdomain or site id to delete."),
				confirm: z
					.string()
					.min(1)
					.describe(
						"The subdomain of the site being deleted, repeated exactly. A mismatch refuses the " +
							"call rather than guessing which site was meant.",
					),
			},
			outputSchema: {
				siteId: z.string().describe("Identifier of the site that was deleted."),
				subdomain: z.string().describe("Its subdomain, now unclaimed."),
			},
			annotations: REMOVES_A_SITE,
		},
		({ site, confirm }) =>
			withCredentials(async (credentials) => {
				// Resolved first, so `confirm` is compared against the site that would actually go — not
				// against what was typed. Passing an id as `site` and its subdomain as `confirm` is the
				// normal case, and the two are only the same string by coincidence.
				const found = await findSite(credentials, site);

				if (confirm.trim().toLowerCase() !== found.subdomain.toLowerCase()) {
					// Thrown rather than returned, so it travels the same path as an API failure and arrives
					// as `isError`. A refusal that reads like a successful answer is worse than no check.
					throw new Error(
						`Refusing to delete ${found.subdomain}: \`confirm\` said "${confirm}". ` +
							"Repeat the subdomain exactly to go ahead.",
					);
				}

				await deleteSite(credentials, found.siteId);

				return report(
					`Deleted ${found.subdomain}. Its files and history are gone, and the subdomain is free ` +
						"for anybody to claim.",
					{ siteId: found.siteId, subdomain: found.subdomain },
				);
			}),
	);

	server.registerTool(
		"list_sites",
		{
			title: "List sites",
			description: "Lists the sites on this account, so a publish can go to one of them.",
			inputSchema: {},
			outputSchema: {
				sites: z
					.array(SITE_OUTPUT)
					.describe("The account's sites, newest first — every one unless `total` is larger."),
				total: z
					.number()
					.int()
					.describe("How many sites the account holds. Larger than `sites` only past 100."),
			},
			annotations: READS_ONLY,
		},
		() =>
			withCredentials(async (credentials) => {
				const { sites, total } = await listSites(credentials);
				// The empty case still carries the empty array. A tool that answers a sentence here and a
				// structure everywhere else makes "no sites" the one branch a caller has to read English for.
				const text =
					sites.length === 0
						? "No sites on this account yet. Publishing without a `site` creates one."
						: sites
								.map(
									(site) => `${site.subdomain} — ${site.url}${site.name ? ` — ${site.name}` : ""}`,
								)
								.join("\n") +
							(total > sites.length
								? `\n… and ${total - sites.length} more; these are the newest ${sites.length} of ${total}.`
								: "");

				return report(text, { sites: sites.map((site) => ({ ...site })), total });
			}),
	);

	server.registerTool(
		"list_folders",
		{
			title: "List folders",
			description:
				"Lists the folders on this account, each with the path a publish's `folder` accepts. " +
				"Folders are made and rearranged in the dashboard; no tool here creates one.",
			inputSchema: {},
			outputSchema: {
				folders: z.array(FOLDER_OUTPUT).describe("Every folder on this account, ordered by path."),
			},
			annotations: READS_ONLY,
		},
		() =>
			withCredentials(async (credentials) => {
				const folders = await listFolders(credentials);
				// The empty case carries the empty array, for the reason `list_sites` gives.
				const text =
					folders.length === 0
						? "No folders on this account. A new site goes at the top level; folders are made in " +
							"the dashboard."
						: folders.map((folder) => `${folder.path} — ${folder.folderId}`).join("\n");

				return report(text, { folders: folders.map((folder) => ({ ...folder })) });
			}),
	);

	server.registerTool(
		"get_site",
		{
			title: "Read a site's settings",
			description:
				"Reads one site's settings and state — serving mode, password, forms, scheduled " +
				"takedown, folder, whether it is paused — and its versions, newest first, with the one " +
				"being served marked. Also says which settings the account's plan does not include.",
			inputSchema: { site: SITE_INPUT },
			outputSchema: {
				...SETTINGS_OUTPUT,
				subdomain: z.string().describe("Its subdomain."),
				url: z.string().describe("Its live URL."),
				status: z.string().describe("`active`, `paused`, or a state the platform put it in."),
				available: z
					.object({
						password: z.boolean(),
						forms: z.boolean(),
						scheduledTakedown: z.boolean(),
					})
					.describe("Which settings the account's plan includes."),
				versions: z.array(VERSION_OUTPUT).describe("Its versions, newest first."),
			},
			annotations: READS_ONLY,
		},
		({ site }) =>
			withCredentials(async (credentials) => {
				const found = await findSite(credentials, site);
				const detail = await getSite(credentials, found.siteId);

				return report(
					describeSite(detail, await folderPathOf(credentials, detail.folderId)),
					structuredSite(detail),
				);
			}),
	);

	server.registerTool(
		"update_site",
		{
			title: "Change a site's settings",
			description:
				"Changes one or more settings of an existing site; anything left out stays as it is. " +
				"Takes effect on every edge within about a minute, without publishing again. Settings " +
				"the plan does not include are refused with the reason. Only change what the person " +
				"asked for — never invent a password or a date.",
			inputSchema: {
				site: SITE_INPUT,
				name: z
					.string()
					.optional()
					.describe("What to call the site in the dashboard. An empty string clears it."),
				mode: z
					.enum(["static", "spa", "docs"])
					.optional()
					.describe(
						"How the site serves: `static` answers 404 for a missing path, `spa` falls back to " +
							"index.html for a client-side router, `docs` reads documents through the viewer. " +
							"Setting it stops the mode being detected on each publish.",
					),
				password: z
					.string()
					.optional()
					.describe(
						"A password visitors must type before seeing the site, as the person gave it. An " +
							"empty string removes it and makes the site public again.",
					),
				forms: z
					.boolean()
					.optional()
					.describe("Whether the site's forms (marked data-drop2run) accept submissions."),
				expiresAt: z
					.string()
					.optional()
					.describe(
						"When the site should come down, as an ISO 8601 instant in the future such as " +
							"2026-12-01T09:00:00Z. An empty string cancels a scheduled takedown.",
					),
				expiryAction: z
					.enum(["pause", "delete"])
					.optional()
					.describe(
						"What the takedown does, read only with `expiresAt`: `pause` (the default) keeps the " +
							"files and can be resumed; `delete` removes the site and frees its subdomain, " +
							"and needs `confirm`.",
					),
				folder: z
					.string()
					.optional()
					.describe(
						"Folder to move the site to — a path such as Clients/Acme or an id from " +
							"list_folders — or `root` for the top level. Never creates a folder.",
					),
				confirm: z
					.string()
					.optional()
					.describe(
						"Required only with `expiryAction: delete`: the site's subdomain, repeated exactly as " +
							"the person said it. Ask for it rather than filling it in.",
					),
			},
			outputSchema: SETTINGS_OUTPUT,
			annotations: CHANGES_A_SITE,
		},
		({ site, name, mode, password, forms, expiresAt, expiryAction, folder, confirm }) =>
			withCredentials(async (credentials) => {
				const found = await findSite(credentials, site);

				if (expiryAction !== undefined && expiresAt === undefined) {
					throw new Error("`expiryAction` only applies with `expiresAt` — send the date too.");
				}

				// A scheduled deletion is a deletion with a delay, so it asks what delete_site asks: the
				// subdomain, told by the person, compared against the site that would actually go.
				if (
					expiryAction === "delete" &&
					confirm?.trim().toLowerCase() !== found.subdomain.toLowerCase()
				) {
					throw new Error(
						`Refusing to schedule ${found.subdomain} for deletion: \`confirm\` said ` +
							`"${confirm ?? ""}". Repeat the subdomain exactly to go ahead, or use ` +
							"`expiryAction: pause`, which keeps the files.",
					);
				}

				const change: SiteSettingsChange = {
					name,
					mode,
					password,
					expiresAt,
					expiryAction,
					formsEnabled: forms,
					folderId:
						folder === undefined ? undefined : await resolveFolderTarget(credentials, folder),
				};
				const settings = await updateSiteSettings(credentials, found.siteId, change);
				const lines = [
					`Updated ${found.subdomain}.`,
					`  mode      ${servingModeOf(settings)}`,
					`  password  ${settings.passwordProtected ? "on" : "off"}`,
					`  forms     ${settings.formsEnabled ? "on" : "off"}`,
					`  takedown  ${settings.expiresAt === null ? "none" : `${settings.expiresAt} (${settings.expiryAction})`}`,
					...(settings.live
						? ["Reaching every edge takes up to about a minute."]
						: ["Nothing is published yet, so this applies from the first publish."]),
				];

				return report(lines.join("\n"), {
					siteId: settings.siteId,
					name: settings.name,
					mode: servingModeOf(settings),
					passwordProtected: settings.passwordProtected,
					formsEnabled: settings.formsEnabled,
					expiresAt: settings.expiresAt,
					expiryAction: settings.expiryAction,
					folderId: settings.folderId,
				});
			}),
	);

	server.registerTool(
		"pause_site",
		{
			title: "Pause a site",
			description:
				"Takes a site off the air without deleting anything: visitors see that it is paused, and " +
				"its files, versions and subdomain are kept. resume_site puts it back.",
			inputSchema: { site: SITE_INPUT },
			outputSchema: PAUSE_OUTPUT,
			annotations: CHANGES_A_SITE,
		},
		({ site }) =>
			withCredentials(async (credentials) => {
				const found = await findSite(credentials, site);
				const state = await setSitePaused(credentials, found.siteId, "pause");

				return report(
					`Paused ${state.subdomain}. Its files and subdomain are kept; resume_site puts it back.`,
					{ ...state },
				);
			}),
	);

	server.registerTool(
		"resume_site",
		{
			title: "Resume a paused site",
			description:
				"Puts a paused site back on the air. Refused, with the reason, when the plan has no room " +
				"for another active site, the account is past due, or the site was suspended by Drop2Run.",
			inputSchema: { site: SITE_INPUT },
			outputSchema: PAUSE_OUTPUT,
			annotations: RESTORES_A_SITE,
		},
		({ site }) =>
			withCredentials(async (credentials) => {
				const found = await findSite(credentials, site);
				const state = await setSitePaused(credentials, found.siteId, "resume");

				return report(`${state.subdomain} is back on the air.\n${found.url}`, { ...state });
			}),
	);

	server.registerTool(
		"rollback_site",
		{
			title: "Roll a site back",
			description:
				"Serves an earlier version of a site again, without publishing anything. get_site lists " +
				"the versions; one whose files were collected cannot be rolled back to.",
			inputSchema: {
				site: SITE_INPUT,
				deployId: z.string().min(1).describe("The version to serve, from get_site's `versions`."),
			},
			outputSchema: {
				deployId: z.string().describe("The version now being served."),
				url: z.string().describe("The URL it is served on."),
			},
			annotations: CHANGES_A_SITE,
		},
		({ site, deployId }) =>
			withCredentials(async (credentials) => {
				const found = await findSite(credentials, site);
				const promoted = await promoteDeploy(credentials, found.siteId, deployId);

				return report(
					`${found.subdomain} is back on ${promoted.deployId}. Reaching every edge takes up to ` +
						`about a minute.\n${promoted.url}`,
					{ deployId: promoted.deployId, url: promoted.url },
				);
			}),
	);

	return server;
}
