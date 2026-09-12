import { main } from "./index.js";

/**
 * Entry point for the `.mcpb` bundle.
 *
 * The npm package starts through `bin/drop2run-mcp.mjs`, a file whose whole job is to survive the
 * build because an MCP client's configuration names its path. A bundle has no such file: the manifest
 * names `server/index.js` and the host runs it with `node` directly, so the built artifact has to
 * start itself rather than export something for a wrapper to call.
 *
 * The error handling is the wrapper's, repeated here rather than shared, because the two entry points
 * are the one place the two distributions genuinely differ and a shared helper would hide that.
 */
main().catch((error: unknown) => {
	// stderr, never stdout: stdout is the MCP transport, and a stray line on it corrupts the protocol
	// rather than showing up anywhere a person reads.
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
