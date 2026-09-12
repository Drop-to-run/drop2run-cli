import {
	type Credentials,
	deleteSite,
	findSite,
	listSites,
	loadCredentials,
	missingCredentialsMessage,
	type PublishResult,
	publishDirectory,
	publishFiles,
} from "@drop2run/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_WAIT_SECONDS, signInWithBrowser, signInWithCode } from "./auth.js";

/**
 * The MCP surface: four tools that need a token, and two that get one.
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
const SERVER_VERSION = "0.4.3";

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
 * `openWorldHint` is true on every one of them: all six talk to dropto.run, and none of them is
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

/** One site, as `list_sites` reports it. */
const SITE_OUTPUT = z.object({
	siteId: z.string().describe("Identifier of the site."),
	subdomain: z.string().describe("Its subdomain, which is what `site` accepts."),
	url: z.string().describe("Its live URL."),
	name: z.string().nullable().describe("What it is called, or null when it has no name."),
});

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

	return [
		what,
		"",
		result.url,
		"",
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
				"Publishes static sites to Drop2Run.",
				"",
				"Use publish_files for anything you wrote here — a page, a markdown note, several files",
				"together — and publish_dir for a folder that already exists on disk. Leave `site` unset to",
				"publish to a brand-new site; pass a subdomain to publish over an existing one. list_sites",
				"shows what already exists.",
				"",
				"A site needs an index.html at its top level, or at least one .md, .markdown or .pdf file,",
				"which publishes as a documents site and is read through a viewer. So one page goes at",
				"index.html, and a single note is a whole publish that needs no wrapping in HTML.",
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
			},
			outputSchema: PUBLISH_OUTPUT,
			annotations: REPLACES_A_SITE,
		},
		({ files, site }) =>
			withCredentials(async (credentials) => {
				const result = await publishFiles(credentials, files, site);

				return report(describe(result), { ...result });
			}),
	);

	server.registerTool(
		"publish_dir",
		{
			title: "Publish a folder",
			description:
				"Publishes a folder of static files and returns its URL. The folder needs an index.html at " +
				"its root, or .md and .pdf files, which are served through the reader.",
			inputSchema: {
				path: z.string().min(1).describe("Absolute path of the folder to publish."),
				site: z
					.string()
					.optional()
					.describe("Subdomain or site id to publish over. Omit to create a new site."),
			},
			outputSchema: PUBLISH_OUTPUT,
			annotations: REPLACES_A_SITE,
		},
		({ path, site }) =>
			withCredentials(async (credentials) => {
				const result = await publishDirectory(credentials, path, site);

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
			outputSchema: { sites: z.array(SITE_OUTPUT).describe("Every site on this account.") },
			annotations: READS_ONLY,
		},
		() =>
			withCredentials(async (credentials) => {
				const sites = await listSites(credentials);
				// The empty case still carries the empty array. A tool that answers a sentence here and a
				// structure everywhere else makes "no sites" the one branch a caller has to read English for.
				const text =
					sites.length === 0
						? "No sites on this account yet. Publishing without a `site` creates one."
						: sites
								.map(
									(site) => `${site.subdomain} — ${site.url}${site.name ? ` — ${site.name}` : ""}`,
								)
								.join("\n");

				return report(text, { sites: sites.map((site) => ({ ...site })) });
			}),
	);

	return server;
}
