import { resolve } from "node:path";
import {
	type Credentials,
	configPath,
	listSites,
	loadCredentials,
	missingCredentialsMessage,
	publishDirectory,
	TOKEN_VARIABLE,
} from "@drop2run/node";

/**
 * What each subcommand does, separated from how it was typed.
 *
 * Every command returns text and an exit code rather than printing and exiting. That is what makes them
 * testable without a subprocess, and it is also what keeps `--json` from being a second implementation:
 * one function decides what happened, and the caller decides how to say it.
 */

/** The outcome of one command. */
export interface CommandResult {
	/** What to print for a person. */
	readonly text: string;
	/** What to print under `--json`, or null when the command has no structured answer. */
	readonly json: unknown;
	/** Process exit code. Non-zero goes to stderr. */
	readonly code: number;
}

/**
 * Builds a failure result.
 *
 * @param text What went wrong.
 * @returns The result.
 */
function failure(text: string): CommandResult {
	return { text, json: { error: text }, code: 1 };
}

/**
 * Reads credentials, or explains how to get some.
 *
 * @returns The credentials, or a result to return instead.
 */
function credentialsOr(): { credentials: Credentials } | { result: CommandResult } {
	const credentials = loadCredentials();
	if (credentials === null) return { result: failure(missingCredentialsMessage()) };

	return { credentials };
}

/**
 * Reports which account the token belongs to.
 *
 * <b>Asks the API rather than reading the config.</b> The question is "does this token work, and for
 * whom" — a command that answered from the file on disk would report a happy account while every deploy
 * failed, which is the opposite of what somebody runs `whoami` to find out.
 *
 * @returns The result.
 */
export async function whoami(): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const response = await fetch(`${found.credentials.apiBaseUrl}/me`, {
		headers: { Authorization: `Bearer ${found.credentials.token}` },
	});

	if (!response.ok) {
		return failure(
			response.status === 401
				? "This token is not valid any more. It may have been revoked or expired — create another " +
						"at https://dropto.run/account/tokens."
				: `The API answered ${response.status}.`,
		);
	}

	const me = (await response.json()) as { email: string; plan?: { name?: string } };
	const plan = me.plan?.name ? ` on ${me.plan.name}` : "";

	return {
		text: `${me.email}${plan}\nAPI: ${found.credentials.apiBaseUrl}`,
		json: me,
		code: 0,
	};
}

/**
 * Lists the account's sites.
 *
 * @returns The result.
 */
export async function list(): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const sites = await listSites(found.credentials);
	if (sites.length === 0) {
		return {
			text: "No sites yet. `drop2run deploy` publishes one.",
			json: { sites: [] },
			code: 0,
		};
	}

	return {
		text: sites
			.map((site) => `${site.subdomain}\t${site.url}${site.name ? `\t${site.name}` : ""}`)
			.join("\n"),
		json: { sites },
		code: 0,
	};
}

/**
 * Publishes a folder.
 *
 * @param directory Folder to publish, relative to the working directory or absolute.
 * @param site Subdomain or site id to publish over, or undefined for a new site.
 * @returns The result.
 */
export async function deployCommand(directory: string, site?: string): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	try {
		const result = await publishDirectory(found.credentials, resolve(directory), site);
		const what = result.unchanged
			? "Already up to date — nothing needed publishing."
			: `Published ${result.files.toLocaleString()} ${result.files === 1 ? "file" : "files"}.`;

		return {
			text: `${what}\n${result.url}`,
			json: result,
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Explains where the token is read from, without printing it.
 *
 * <b>Never shows the token.</b> The one thing somebody debugging credentials wants is to see the value,
 * and it is the one thing this must not do: the output of a CLI ends up in issue reports, terminal
 * recordings and CI logs. It says which source won instead, which answers the actual question — "why is
 * it using the wrong account".
 *
 * @returns The result.
 */
export function where(): CommandResult {
	const fromEnvironment = process.env[TOKEN_VARIABLE]?.trim();
	const credentials = loadCredentials();

	const source = fromEnvironment
		? `${TOKEN_VARIABLE} (environment)`
		: credentials === null
			? "nowhere — no token found"
			: configPath();

	return {
		text: [
			`Token source: ${source}`,
			`Config file:  ${configPath()}`,
			`API:          ${credentials?.apiBaseUrl ?? "—"}`,
		].join("\n"),
		json: {
			tokenSource: source,
			configPath: configPath(),
			apiBaseUrl: credentials?.apiBaseUrl ?? null,
		},
		code: credentials === null ? 1 : 0,
	};
}
