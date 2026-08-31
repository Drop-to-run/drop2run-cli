import {
	type Credentials,
	listSites,
	loadCredentials,
	missingCredentialsMessage,
	type PublishResult,
	publishDirectory,
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
		{ name: "drop2run", version: "0.0.0" },
		{
			instructions: [
				"Publishes static sites to Drop2Run.",
				"",
				"Use publish_html for a single page you have written, and publish_dir for a folder that is",
				"already built. Leave `site` unset to publish to a brand-new site; pass a subdomain to",
				"publish over an existing one. list_sites shows what already exists.",
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
