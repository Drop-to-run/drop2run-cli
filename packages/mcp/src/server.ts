import { loadCredentials, missingCredentialsMessage, publishDirectory } from "@drop2run/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_WAIT_SECONDS, signInWithBrowser, signInWithCode } from "./auth.js";
import {
	attempt,
	describe,
	FOLDER_INPUT,
	instructionsFor,
	PUBLISH_OUTPUT,
	REPLACES_A_SITE,
	registerPublishFiles,
	registerSiteTools,
	report,
	SERVER_VERSION,
	type ToolContext,
	titled,
	withCredentials,
} from "./tools.js";

/**
 * The local MCP server: the shared tools in `tools.ts`, plus the three only a process on the person's
 * own machine can offer — signing in through a browser here (`login`, `login_code`) and publishing a
 * folder off the disk (`publish_dir`).
 *
 * The token is the one the CLI stores, or `DROP2RUN_TOKEN`, read again on every call; see the note at
 * the top of `tools.ts` for why.
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
 * Where the local server's tools find a token, and what they say when there is none.
 *
 * "mcp" rather than the default: the message names the first step, and here that step is the `login`
 * tool. It used to name `drop2run login`, a command nobody who installed only this server has.
 */
const LOCAL: ToolContext = {
	surface: "local",
	credentials: () => loadCredentials(),
	missingCredentials: () => missingCredentialsMessage("mcp"),
};

/**
 * Builds the server with its tools registered.
 *
 * @returns The server, ready to connect to a transport.
 */
export function createServer(): McpServer {
	const context = LOCAL;
	const server = new McpServer(
		{ name: "drop2run", version: SERVER_VERSION },
		{ instructions: instructionsFor("local") },
	);

	server.registerTool(
		"login",
		{
			...titled("Sign in to Drop2Run", CREDENTIAL_WRITE),
			description:
				"Signs in through a browser on this machine and stores an access token, which every other " +
				"tool then uses. Opens the browser here and waits for the person to approve. If it answers " +
				"that nothing has been approved yet, call it again to keep waiting — that is not a " +
				"failure. Needs no command line and no token pasted by hand. Where no browser can open on " +
				"this machine — a container, a remote host — use login_code instead.",
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
			...titled("Sign in with a code", CREDENTIAL_WRITE),
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

	registerPublishFiles(server, context);

	server.registerTool(
		"publish_dir",
		{
			...titled("Publish a folder", REPLACES_A_SITE),
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
							"name is the URL somebody will be given, changing it later spends one of the few " +
							"changes a site gets, and an unused site made under a guessed name has to be " +
							"deleted by hand.",
					),
				folder: FOLDER_INPUT,
			},
			outputSchema: PUBLISH_OUTPUT,
		},
		({ path, site, subdomain, folder }) =>
			withCredentials(context, async (credentials) => {
				const result = await publishDirectory(credentials, path, site, undefined, {
					subdomain,
					folder,
				});

				return report(describe(result), { ...result });
			}),
	);

	registerSiteTools(server, context);

	return server;
}
