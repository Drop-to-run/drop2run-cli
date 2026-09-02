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
	pollDevice,
	startDevice,
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
 * Signs in without a browser on this machine, by having somebody approve a code elsewhere.
 *
 * <b>What this covers that `login` cannot.</b> The loopback flow ends in a redirect to 127.0.0.1, which
 * requires the browser and this process to be on the same machine. Over SSH, in a dev container or under
 * WSL they are not — so the only channel left is a person carrying eight characters to another screen.
 *
 * <b>The long code never leaves this process and the short one collects nothing.</b> Somebody reading the
 * short code over a shoulder learns which sign-in is waiting, not how to take its token.
 *
 * <b>Waiting is the whole command.</b> It polls at the interval the server hands out, obeys `slow_down`
 * when told, and stops on the deadline rather than running forever — a CI job that hangs here is worse than
 * one that fails.
 *
 * @param print Writes progress for a person, injectable so a test does not print and `--json` can suppress it.
 * @param sleep Waits between polls, injectable so a test does not spend a minute proving the loop works.
 * @returns The result. The token is never in it, in either form.
 */
export async function loginWithDevice(
	print: (line: string) => void = console.error,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<CommandResult> {
	const apiBaseUrl = resolveApiBaseUrl();
	const name = clientName();

	let request: Awaited<ReturnType<typeof startDevice>>;
	try {
		request = await startDevice(apiBaseUrl, name);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}

	print(`Open ${request.verificationUri} and enter this code:`);
	print("");
	print(`    ${request.userCode}`);
	print("");
	print(`Or open the link with the code already in it: ${request.verificationUriComplete}`);
	print(`Waiting for approval of "${name}"…`);

	// From the server's own answer rather than a constant here, so the pace is the server's to change.
	let waitMs = Math.max(1, request.intervalSeconds) * 1000;
	const deadline = Date.now() + DEVICE_TIMEOUT_MS;

	while (Date.now() < deadline) {
		await sleep(waitMs);

		const poll = await pollDevice(apiBaseUrl, request.deviceCode);

		if (poll.state === "granted") {
			const path = saveToken(poll.token.token);

			return {
				text: `Signed in${poll.token.email === null ? "" : ` as ${poll.token.email}`}.\nToken "${poll.token.name}" saved to ${path}`,
				json: { email: poll.token.email, name: poll.token.name, configPath: path, apiBaseUrl },
				code: 0,
			};
		}

		if (poll.state === "dead") return failure(poll.message);

		// Backing off on being told to, rather than only on the next attempt: a client that acknowledged
		// `slow_down` and then polled at the same rate would be told again forever.
		if (poll.state === "slow_down") waitMs = Math.min(waitMs * 2, MAX_POLL_MS);
	}

	return failure("Timed out waiting for approval. Nothing has been changed.");
}

/** How long a device sign-in waits before giving up, matching the fifteen minutes the codes last. */
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

/** Longest gap between polls, so backing off repeatedly cannot stretch into never asking again. */
const MAX_POLL_MS = 30 * 1000;

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
