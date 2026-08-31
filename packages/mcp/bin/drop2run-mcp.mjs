#!/usr/bin/env node
/**
 * Entry point for `npx @drop2run/mcp`.
 *
 * Loads the built server. Kept as a separate file with nothing in it because a `bin` has to survive the
 * build: `files` publishes `bin` and `dist`, and this is the one part of the package whose path an MCP
 * client's configuration names.
 */
import { main } from "../dist/index.js";

main().catch((error) => {
	// stderr, never stdout: stdout is the MCP transport, and a stray line on it corrupts the protocol
	// rather than showing up anywhere a person reads.
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
