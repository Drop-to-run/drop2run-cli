import { resolve } from "node:path";
import {
	type Credentials,
	clearToken,
	configPath,
	dashboardUrlFor,
	listSites,
	loadCredentials,
	missingCredentialsMessage,
	publishDirectory,
	resolveApiBaseUrl,
	saveToken,
	TOKEN_VARIABLE,
} from "@drop2run/node";
import {
	clientName,
	consentUrl,
	exchange,
	listen,
	newAttempt,
	openBrowser,
	waitForCallback,
} from "./login.js";

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
 * Signs in through a browser and stores the token that comes back.
 *
 * <b>The order of operations is the security of the whole flow.</b> The listener is opened before the
 * browser, so the port in the consent URL is one this process already holds; the verifier never leaves
 * this function; and the token is written only after the exchange has succeeded, so a failed sign-in
 * cannot leave a half-written credential behind a working one.
 *
 * <b>Prints the URL rather than relying on the browser opening.</b> A container, an SSH session and a
 * machine with no desktop all reach this, and in every one of them the flow still completes if the person
 * opens the URL themselves. Under `--json` the URL is in the result instead, because a wrapper reading
 * JSON cannot use a line of prose telling somebody to click something.
 *
 * @param print Writes progress for a person, injectable so a test does not print and so `--json` can
 * suppress it.
 * @returns The result. The token is never in it, in either form.
 */
export async function login(print: (line: string) => void = console.error): Promise<CommandResult> {
	const apiBaseUrl = resolveApiBaseUrl();
	const attempt = newAttempt();
	const name = clientName();

	let listener: Awaited<ReturnType<typeof listen>>;
	try {
		listener = await listen(attempt.state);
	} catch (error) {
		return failure(
			`Could not open a local port to receive the sign-in: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	try {
		const url = consentUrl(dashboardUrlFor(apiBaseUrl), attempt, listener.port, name);

		print(`Opening ${url}`);
		if (!openBrowser(url)) print("Could not open a browser. Open the URL above yourself.");
		print(`Waiting for authorization of "${name}"…`);

		const { code } = await waitForCallback(listener.received);
		const issued = await exchange(apiBaseUrl, code, attempt.verifier);
		const path = saveToken(issued.token);

		return {
			text: `Signed in${issued.email === null ? "" : ` as ${issued.email}`}.\nToken "${issued.name}" saved to ${path}`,
			json: { email: issued.email, name: issued.name, configPath: path, apiBaseUrl },
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	} finally {
		// Always, on every path: a listener left open holds a port and keeps the process alive, which turns
		// a failed sign-in into a command that never returns.
		listener.close();
	}
}

/**
 * Removes the stored token.
 *
 * <b>Says what is still in force rather than claiming success.</b> A token in the environment outranks the
 * file, so a `logout` that printed "signed out" while `DROP2RUN_TOKEN` was set would be lying about the
 * one thing somebody ran it to be sure of.
 *
 * @returns The result.
 */
export function logout(): CommandResult {
	const removed = clearToken();
	const fromEnvironment = process.env[TOKEN_VARIABLE]?.trim();

	const lines = [
		removed
			? `Removed the token stored in ${configPath()}.`
			: "There was no stored token to remove.",
	];

	if (fromEnvironment) {
		lines.push(
			`${TOKEN_VARIABLE} is still set in this environment, so commands will keep using it. Unset it to sign out fully.`,
		);
	}

	return {
		text: lines.join("\n"),
		json: { removed, environmentTokenStillSet: Boolean(fromEnvironment) },
		code: 0,
	};
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
