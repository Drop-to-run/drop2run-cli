import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 * The API base URL to use when no token has been stored yet.
 *
 * Needed by sign-in specifically: every other call reads the base URL off the credentials, and sign-in is
 * the one that runs when there are none. The precedence is the same as {@link loadCredentials} minus the
 * token, so pointing a shell at a local API signs in against that API rather than production.
 *
 * @param env Environment to read, injectable so a test does not have to mutate the real one.
 * @param read Reads a file, injectable for the same reason.
 * @returns The base URL, ending without a slash.
 */
export function resolveApiBaseUrl(
	env: NodeJS.ProcessEnv = process.env,
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string {
	let stored: StoredConfig = {};
	try {
		stored = JSON.parse(read(configPath())) as StoredConfig;
	} catch {
		// No file, unreadable, or not JSON — all three mean "use the default".
	}

	const url = env.DROP2RUN_API_URL?.trim() || stored.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL;

	return url.replace(/\/+$/, "");
}

/**
 * The dashboard origin that goes with an API base URL.
 *
 * Derived rather than configured separately, because the two are the same deployment and a second setting
 * is a second thing to get wrong: somebody who points the API at a local instance and then opens a consent
 * page on production has signed a local command line in against the wrong account, which is confusing in
 * exactly the way credentials should not be.
 *
 * The API lives under `/api` on the dashboard origin (see plan §4), so this is that path removed.
 *
 * @param apiBaseUrl The API base URL.
 * @returns The origin the browser should be sent to.
 */
export function dashboardUrlFor(apiBaseUrl: string): string {
	return apiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

/**
 * Writes the token to the config file, creating the directory if it has to.
 *
 * <b>Everything else in the file is preserved.</b> It is hand-edited — that was the only way to get a
 * token before sign-in existed — so it may hold an `apiBaseUrl` somebody set deliberately. A write that
 * replaced the whole file would silently point the next command at production.
 *
 * <b>Written through a temporary file and renamed.</b> A truncated write leaves somebody with a config
 * that parses as nothing, which reads as "signed out" right after a successful sign-in. The mode is set
 * on the temporary file before the rename, so the token is never briefly world-readable.
 *
 * @param token The plaintext token to store.
 * @param path Where to write, injectable so a test does not touch a real home directory.
 * @returns The path written to.
 */
export function saveToken(token: string, path: string = configPath()): string {
	let existing: StoredConfig = {};
	try {
		existing = JSON.parse(readFileSync(path, "utf8")) as StoredConfig;
	} catch {
		// Nothing to preserve.
	}

	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

	const temporary = `${path}.tmp`;

	writeFileSync(temporary, `${JSON.stringify({ ...existing, token }, null, "\t")}\n`, {
		mode: 0o600,
	});
	// Set explicitly as well as passed to writeFileSync: the mode argument is only applied when the file
	// is created, so a leftover temporary file from an interrupted write would keep whatever mode it had.
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);

	return path;
}

/**
 * Removes the stored token, leaving the rest of the file alone.
 *
 * Does not touch {@link TOKEN_VARIABLE}: a token in the environment belongs to whatever set it, and a
 * command that could not remove it must not report that it did — which is why `logout` says which source
 * is still in force rather than claiming to have signed anybody out.
 *
 * @param path Where the config lives, injectable for tests.
 * @returns True when a token was removed, false when there was none to remove.
 */
export function clearToken(path: string = configPath()): boolean {
	let existing: StoredConfig;
	try {
		existing = JSON.parse(readFileSync(path, "utf8")) as StoredConfig;
	} catch {
		return false;
	}

	if (existing.token === undefined) return false;

	const { token: _removed, ...rest } = existing;
	const temporary = `${path}.tmp`;

	writeFileSync(temporary, `${JSON.stringify(rest, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);

	return true;
}

/** Which surface is asking, since the way out of having no token is not the same for both. */
export type CredentialSurface = "cli" | "mcp";

/**
 * What to tell somebody who has no token.
 *
 * One function so the wording cannot drift between the command line and the chat, and phrased as the
 * steps that fix it rather than as a description of the fault.
 *
 * <b>The surface changes what the first step is, and it has to.</b> This used to be one message for
 * both, on the reasoning that naming a terminal or a server would be wrong half the time. What it
 * actually named was `drop2run login` — a command that exists only on the half of the machines that
 * installed the CLI. Somebody who added only the MCP server was told to run a command they did not
 * have, and the route left was creating a token on the web and hand-writing this file. The shape stays
 * shared; the sentence that says "do this now" is per surface.
 *
 * @param surface Which surface will show this.
 * @returns The message to print or return.
 */
export function missingCredentialsMessage(surface: CredentialSurface = "cli"): string {
	const signIn =
		surface === "mcp"
			? [
					"Call the `login` tool to sign in through a browser, which stores a token.",
					"",
					"Where no browser can be opened on this machine — a container, a remote host — call",
					"`login_code` instead and pass on the short code it gives you.",
				]
			: ["Run `drop2run login` to sign in through a browser, which stores one for you."];

	// Where the token lives is the same for both, so only this half is worth saying twice — and for the
	// server one of the two options has a catch worth naming, since a shell `export` after it started is
	// a change it cannot see.
	const byHand =
		surface === "mcp"
			? [
					"To set one without signing in here, create a token at",
					"https://dropto.run/account/tokens and either:",
					`  - put it in ${configPath()} as {"token": "d2r_..."}, which this`,
					"    server reads on every call and needs no restart, or",
					`  - set ${TOKEN_VARIABLE} in the environment and restart this server, since it reads`,
					"    the environment it was started in.",
				]
			: [
					"For CI, or where no browser can be opened, create a token at",
					"https://dropto.run/account/tokens and either:",
					`  - set ${TOKEN_VARIABLE} in the environment, or`,
					`  - put it in ${configPath()} as {"token": "d2r_..."}`,
				];

	return [
		"No Drop2Run access token.",
		"",
		...signIn,
		"",
		...byHand,
		"",
		"The token is shown once when it is created and cannot be recovered afterwards.",
	].join("\n");
}
