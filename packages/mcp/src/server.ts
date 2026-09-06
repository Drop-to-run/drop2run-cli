import {
	type Credentials,
	listSites,
	loadCredentials,
	missingCredentialsMessage,
	type PublishResult,
	publishDirectory,
	publishFiles,
	publishHtml,
} from "@drop2run/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The MCP surface: three tools, and the rule that none of them can be reached without a token.
 *
 * <b>Every tool answers, none of them throws at startup.</b> A server with no credential is
 * unconfigured rather than broken, and the difference is what the person sees: a sentence in the chat
 * telling them where to make a token, rather than a client reporting that the server died. That is why
 * credentials are read per call instead of once at boot — it also means a token added while the chat is
 * open starts working without restarting anything.
 */

/**
 * The version this server reports to a client.
 *
 * Written here rather than read from `package.json` because the build bundles this file for node and a
 * runtime read would resolve against `dist/`, not the package root. A test asserts the two match, so a
 * release that bumps only the manifest fails before it is published rather than telling every client
 * the wrong version.
 */
const SERVER_VERSION = "0.2.0";

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
	if (credentials === null) return say(missingCredentialsMessage(), true);

	try {
		return say(await work(credentials));
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
				"Use publish_html for a single page you have written, publish_files for anything else you",
				"wrote yourself — markdown notes, several pages, a page with its stylesheet — and",
				"publish_dir for a folder that already exists on disk. Leave `site` unset to publish to a",
				"brand-new site; pass a subdomain to publish over an existing one. list_sites shows what",
				"already exists.",
				"",
				"A site needs an index.html at its top level, or at least one .md, .markdown or .pdf file,",
				"which publishes as a documents site and is read through a viewer. So a single note is a",
				"whole publish; it does not need wrapping in HTML.",
				"",
				"Publishing over an existing site replaces what it serves, so ask before doing that to a",
				"site the person did not name.",
			].join("\n"),
		},
	);

	server.registerTool(
		"publish_html",
		{
			title: "Publish a page",
			description:
				"Publishes one HTML page as a whole site and returns its URL. The page becomes index.html.",
			inputSchema: {
				html: z.string().min(1).describe("The complete HTML document to publish."),
				site: z
					.string()
					.optional()
					.describe("Subdomain or site id to publish over. Omit to create a new site."),
			},
		},
		({ html, site }) =>
			withCredentials(async (credentials) => describe(await publishHtml(credentials, html, site))),
	);

	server.registerTool(
		"publish_files",
		{
			title: "Publish files you wrote",
			description:
				"Publishes one or more files written here — markdown, HTML, CSS, JSON — as a site, and " +
				"returns its URL. Needs an index.html at the top level, or at least one .md, .markdown or " +
				".pdf file, which is served through the documents viewer. Text only: a PDF or an image has " +
				"to be published from disk with publish_dir.",
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
