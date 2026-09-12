import {
	type Credentials,
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
 * The MCP surface: three tools that need a token, and two that get one.
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
const SERVER_VERSION = "0.4.1";

/** What a tool hands back to the client. */
type ToolResult = {
	content: { type: "text"; text: string }[];
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
 * Runs a tool with credentials, turning both absence and failure into something readable.
 *
 * @param work What to do once there are credentials.
 * @returns The tool result.
 */
async function withCredentials(
	work: (credentials: Credentials) => Promise<string>,
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
async function attempt(work: () => Promise<string>): Promise<ToolResult> {
	try {
		return say(await work());
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
		},
		({ files, site }) =>
			withCredentials(async (credentials) =>
				describe(await publishFiles(credentials, files, site)),
			),
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
		},
		({ path, site }) =>
			withCredentials(async (credentials) =>
				describe(await publishDirectory(credentials, path, site)),
			),
	);

	server.registerTool(
		"list_sites",
		{
			title: "List sites",
			description: "Lists the sites on this account, so a publish can go to one of them.",
			inputSchema: {},
		},
		() =>
			withCredentials(async (credentials) => {
				const sites = await listSites(credentials);
				if (sites.length === 0) {
					return "No sites on this account yet. Publishing without a `site` creates one.";
				}

				return sites
					.map((site) => `${site.subdomain} — ${site.url}${site.name ? ` — ${site.name}` : ""}`)
					.join("\n");
			}),
	);

	return server;
}
