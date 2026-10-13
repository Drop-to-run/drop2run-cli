import type { Credentials } from "@drop2run/node/portable";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRemoteServer } from "./tools.js";

/**
 * One request to the remote MCP server, answered without any state carried between requests.
 *
 * <b>Why it lives here and not in `apps/mcp`.</b> Every import of the MCP SDK stays in this package, so the
 * Worker resolves one copy of it — this package's — and `test/portable.test.ts` checks the whole graph the
 * Worker bundles. The Worker's job is OAuth: it decides whose token this request carries and hands it over.
 *
 * <b>Stateless, JSON responses.</b> The 2025-11-25 transport in its stateless form (REMOTE-MCP-BRIEF.md D6):
 * no session id, no server-sent stream, a fresh server per request. A Worker cannot hold a session between
 * requests anyway, and every tool here is one call to the API that finishes before the response is written.
 */

/** What answering one request produced. */
export interface RemoteAnswer {
	/** The MCP response to send back, unless {@link tokenRefused} says otherwise. */
	readonly response: Response;
	/**
	 * True when the API refused the token during this request. The Worker answers HTTP 401 instead of
	 * {@link response}, so the chat client runs its sign-in again rather than showing a sentence about a
	 * revoked token that nobody in the chat can act on.
	 */
	readonly tokenRefused: boolean;
}

/**
 * Answers one MCP request over Streamable HTTP.
 *
 * @param request The HTTP request, as the Worker received it.
 * @param credentials The token this request speaks with, or null when it carries none.
 * @param missingCredentials What a tool answers when there is no token.
 * @returns The response, and whether the API refused the token along the way.
 */
export async function serveRemote(
	request: Request,
	credentials: Credentials | null,
	missingCredentials: () => string,
): Promise<RemoteAnswer> {
	let tokenRefused = false;

	const server = createRemoteServer({
		credentials: () => credentials,
		missingCredentials,
		tokenRefused: () => {
			tokenRefused = true;
		},
	});
	// No `sessionIdGenerator`: leaving it out is what makes the transport stateless.
	const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

	await server.connect(transport);

	try {
		const response = await transport.handleRequest(request);

		return { response: await withoutToken(response, credentials), tokenRefused };
	} finally {
		await server.close();
	}
}

/**
 * The response with every occurrence of the token taken out.
 *
 * <b>Why a tool's answer could hold the token at all.</b> A tool answers a failure with the API's own
 * sentence, and the API is not the only thing that can write one: a proxy in front of it, a future error
 * message that quotes a header. On the local server that sentence reaches the person who owns the token.
 * Here it reaches a hosted chat's transcript — stored by somebody else, shared, quoted back — and the token
 * is one the Worker holds on the person's behalf, which they never saw. So nothing leaves with it in.
 *
 * JSON responses only, which is all this server sends (`enableJsonResponse`); anything else passes as it is.
 *
 * @param response The transport's response.
 * @param credentials The token this request spoke with.
 * @returns The response, scrubbed.
 */
async function withoutToken(
	response: Response,
	credentials: Credentials | null,
): Promise<Response> {
	if (credentials === null || !response.headers.get("content-type")?.includes("application/json")) {
		return response;
	}

	const body = await response.text();

	if (!body.includes(credentials.token)) {
		return new Response(body, { status: response.status, headers: response.headers });
	}

	return new Response(body.replaceAll(credentials.token, "[token]"), {
		status: response.status,
		headers: response.headers,
	});
}
