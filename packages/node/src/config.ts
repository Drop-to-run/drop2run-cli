import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the access token comes from, and what happens when there is none.
 *
 * Two sources, checked in this order: the `DROP2RUN_TOKEN` environment variable, then the config file
 * the CLI will write. Environment first so a wrapper can point one chat at a different account without
 * editing a file two processes share, and because that is the form CI uses — the same precedence the
 * devtools brief gives the CLI, kept identical so the two never disagree about which token is in force.
 */

/** Environment variable holding a token, which wins over the file. */
export const TOKEN_VARIABLE = "DROP2RUN_TOKEN";

/**
 * Where the CLI keeps its credentials, and where this server reads them from.
 *
 * Deliberately the same file rather than one of this package's own: a person who has signed in once
 * should not have to do it again for the chat, and two files would drift into disagreeing about which
 * account is theirs.
 *
 * @returns Absolute path to the config file.
 */
export function configPath(): string {
	return join(homedir(), ".config", "drop2run", "config.json");
}

/** What the config file holds, of which only the token is required. */
interface StoredConfig {
	/** The personal access token. */
	readonly token?: string;
	/** Base URL of the API, for pointing at something other than production. */
	readonly apiBaseUrl?: string;
}

/** Everything the server needs to talk to the control plane. */
export interface Credentials {
	/** The token to send as a bearer credential. */
	readonly token: string;
	/** Base URL of the API. */
	readonly apiBaseUrl: string;
}

/** The API this server talks to unless told otherwise. */
export const DEFAULT_API_BASE_URL = "https://dropto.run/api";

/**
 * Reads the token and the API base URL.
 *
 * <b>Returns null rather than throwing.</b> An MCP server with no credential is not broken — it is
 * unconfigured, and the difference matters to what the caller sees: every tool can then answer with the
 * two lines that fix it, instead of the client reporting that the server crashed at startup.
 *
 * A malformed config file is treated as no config, for the same reason and one more: the file is
 * hand-edited until the CLI exists, so a stray comma is the likeliest thing to find in it.
 *
 * @param env Environment to read, injectable so a test does not have to mutate the real one.
 * @param read Reads a file, injectable for the same reason.
 * @returns The credentials, or null when no token was found anywhere.
 */
export function loadCredentials(
	env: NodeJS.ProcessEnv = process.env,
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Credentials | null {
	let stored: StoredConfig = {};
	try {
		stored = JSON.parse(read(configPath())) as StoredConfig;
	} catch {
		// No file, unreadable, or not JSON. All three mean the same thing here.
	}

	const token = env[TOKEN_VARIABLE]?.trim() || stored.token?.trim();
	if (!token) return null;

	return {
		token,
		apiBaseUrl: env.DROP2RUN_API_URL?.trim() || stored.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL,
	};
}

/**
 * What to tell somebody whose server has no token.
 *
 * Written once and returned by every command and every tool, so the instructions cannot drift between
 * them — and phrased as the two steps that fix it rather than as a description of the fault.
 *
 * Deliberately says nothing about being a server or a command line: both read it, and wording that
 * named one of them would be wrong half the time it is shown.
 *
 * @returns The message shown in the chat.
 */
export function missingCredentialsMessage(): string {
	return [
		"No Drop2Run access token.",
		"",
		"Create one at https://dropto.run/account/tokens, then either:",
		`  - set ${TOKEN_VARIABLE} in the environment, or`,
		`  - put it in ${configPath()} as {"token": "d2r_..."}`,
		"",
		"The token is shown once when it is created and cannot be recovered afterwards.",
	].join("\n");
}
