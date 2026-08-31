import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Starts the server on stdio, which is the transport a local MCP client speaks.
 *
 * Nothing here reads credentials: see the note on `createServer`. A server that refused to start
 * without a token would report as a crashed server rather than as one nobody has signed in to yet.
 */
export async function main(): Promise<void> {
	await createServer().connect(new StdioServerTransport());
}
