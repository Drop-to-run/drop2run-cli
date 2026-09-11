import { resolve } from "node:path";
import {
	type Credentials,
	clearToken,
	clientName,
	configPath,
	consentUrl,
	createSite,
	dashboardUrlFor,
	deleteSite,
	exchange,
	findSite,
	listen,
	listSites,
	listTokens,
	loadCredentials,
	missingCredentialsMessage,
	newAttempt,
	// Shared with `open`: the same three platform launchers, and the same "failure is not fatal" rule.
	openBrowser,
	PROJECT_FILE,
	type Project,
	pollDevice,
	promoteDeploy,
	publishDirectory,
	readProject,
	resolveApiBaseUrl,
	saveToken,
	startDevice,
	TOKEN_VARIABLE,
	waitForCallback,
	writeProject,
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
 * Turns whatever was thrown into something a person can act on.
 *
 * <b>Carries the detail as well as the message</b>, which the engine's own errors have and the first
 * version of this threw away. `Could not upload x after 4 attempts` names the file and nothing about
 * why — no status, no reason — so the one question it provokes is the one it cannot answer. The engine
 * already puts the underlying failure in `DeployError.detail`; this is what gets it to a terminal.
 *
 * @param error Whatever was caught.
 * @returns The failure result, with the cause appended when there is one.
 */
function failureFrom(error: unknown): CommandResult {
	const message = error instanceof Error ? error.message : String(error);
	const detail = (error as { detail?: unknown } | null)?.detail;
	const cause = (detail as { cause?: unknown } | null | undefined)?.cause;

	// Only when it says something the message does not. `String(undefined)` in an error report is worse
	// than a shorter error report.
	const extra = cause === undefined || cause === null ? "" : `\n${String(cause)}`;

	return {
		text: `${message}${extra}`,
		json: { error: message, ...(detail === undefined ? {} : { detail }) },
		code: 1,
	};
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
 * <b>Three sources for "which site", in one order.</b> `--site` wins because it was typed for this run;
 * then `drop2run.json`, because somebody ran `init` in this folder and meant it; and only with neither
 * does a new site get created. The order matters more than it looks: a publish that silently created a
 * site when a project file existed would leave the real one untouched and the person looking at a URL
 * they did not expect.
 *
 * The same order decides the folder, so `drop2run deploy` in a project with `dir: "dist"` publishes
 * `dist` rather than the repository around it.
 *
 * @param directory Folder to publish, or undefined to use the project file and then the working directory.
 * @param site Subdomain or site id to publish over, or undefined to use the project file.
 * @returns The result.
 */
export async function deployCommand(
	directory: string | undefined,
	site?: string,
): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const project = readProject();
	const target = site ?? project?.siteId;
	const folder = directory ?? project?.dir ?? ".";

	try {
		const result = await publishDirectory(found.credentials, resolve(folder), target);
		const what = result.unchanged
			? "Already up to date — nothing needed publishing."
			: `Published ${result.files.toLocaleString()} ${result.files === 1 ? "file" : "files"}.`;

		return {
			text: `${what}\n${result.url}`,
			json: result,
			code: 0,
		};
	} catch (error) {
		return failureFrom(error);
	}
}

/**
 * Writes `drop2run.json` so this folder has a site of its own.
 *
 * <b>It creates a site when none is named</b>, which is a real remote effect from a command that sounds
 * local. That is what makes `init` worth having: the point is to end up with a file naming a site that
 * exists, and an `init` that only wrote a placeholder would leave the first `deploy` to create one
 * anyway — at which point the file would be wrong.
 *
 * <b>It refuses to overwrite.</b> A second `init` in a folder that already has one would silently
 * repoint it, and the version in git would then disagree with the version on the machine that ran it.
 *
 * @param directory Folder to publish, relative to the working directory.
 * @param site Subdomain or site id of an existing site, or undefined to create one.
 * @returns The result.
 */
export async function init(directory: string, site?: string): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	if (readProject() !== null) {
		return failure(
			`This folder already has a ${PROJECT_FILE}. Edit it, or delete it and run \`init\` again.`,
		);
	}

	try {
		const target =
			site === undefined
				? await createSite(found.credentials)
				: await findSite(found.credentials, site);

		const project: Project = {
			siteId: target.siteId,
			subdomain: target.subdomain,
			dir: directory,
		};

		const path = writeProject(project);

		return {
			text: `Wrote ${path}\n${target.url}\n\`drop2run deploy\` now publishes ${directory} to this site.`,
			json: { ...project, url: target.url, configPath: path },
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Deletes a site and everything published to it.
 *
 * <b>Refuses without `--yes`.</b> There is no undo, no trash and no second copy: the R2 objects go and
 * the subdomain is released. A terminal has no confirmation dialog, so the flag is the confirmation —
 * and it has to be typed after seeing the name, which is why the refusal names the site it would have
 * deleted.
 *
 * @param site Subdomain or site id, or undefined to use the project file.
 * @param confirmed Whether `--yes` was given.
 * @returns The result.
 */
export async function remove(site: string | undefined, confirmed: boolean): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const named = site ?? readProject()?.siteId;

	if (named === undefined) {
		return failure(
			`Name the site to delete: \`drop2run rm <subdomain>\`, or run this in a folder with a ${PROJECT_FILE}.`,
		);
	}

	try {
		const target = await findSite(found.credentials, named);

		if (!confirmed) {
			return failure(
				`This would delete ${target.subdomain} and every version published to it, with no way back.\n` +
					`Run \`drop2run rm ${target.subdomain} --yes\` if that is what you want.`,
			);
		}

		await deleteSite(found.credentials, target.siteId);

		return {
			text: `Deleted ${target.subdomain}.`,
			json: { siteId: target.siteId, subdomain: target.subdomain, deleted: true },
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Makes an earlier version live again.
 *
 * The command somebody runs when the thing they just published is broken, which is why it takes a deploy
 * id and nothing else to think about. `drop2run ls` does not list versions — the site's page does, and so
 * does the JSON from a previous `deploy`.
 *
 * @param deployId ULID of the deploy to make live.
 * @param site Subdomain or site id, or undefined to use the project file.
 * @returns The result.
 */
export async function rollback(
	deployId: string | undefined,
	site?: string,
): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	if (deployId === undefined) {
		return failure("Name the version to roll back to: `drop2run rollback <deployId>`.");
	}

	const named = site ?? readProject()?.siteId;

	if (named === undefined) {
		return failure(
			`Name the site: \`drop2run rollback <deployId> --site <subdomain>\`, or run this in a folder with a ${PROJECT_FILE}.`,
		);
	}

	try {
		const target = await findSite(found.credentials, named);
		const promoted = await promoteDeploy(found.credentials, target.siteId, deployId);

		return {
			text: `${target.subdomain} is back on ${promoted.deployId}.\n${promoted.url}`,
			json: promoted,
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Opens a site in a browser.
 *
 * Prints the URL as well as opening it, because the two failure modes are different: a machine with no
 * browser still gets something to copy, and a machine that opened the wrong profile can see what it was
 * meant to open.
 *
 * @param site Subdomain or site id, or undefined to use the project file.
 * @param launch Opens a URL, injectable so a test does not open a browser.
 * @returns The result.
 */
export async function open(
	site: string | undefined,
	launch: (url: string) => boolean = openBrowser,
): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const named = site ?? readProject()?.siteId;

	if (named === undefined) {
		return failure(
			`Name the site: \`drop2run open <subdomain>\`, or run this in a folder with a ${PROJECT_FILE}.`,
		);
	}

	try {
		const target = await findSite(found.credentials, named);
		const opened = launch(target.url);

		return {
			text: opened ? target.url : `${target.url}\n(Could not open a browser — open it yourself.)`,
			json: { url: target.url, siteId: target.siteId, subdomain: target.subdomain, opened },
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Lists the account's access tokens.
 *
 * <b>The only `token` subcommand there is</b>, and `where` says why: creating and revoking need a browser
 * session, because a token able to mint its replacement would make revoking meaningless. What this
 * answers is the question a terminal can answer — which machines are still holding a credential, and
 * which of them has not used it since it was made.
 *
 * @returns The result.
 */
export async function tokens(): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	try {
		const list = await listTokens(found.credentials);

		if (list.length === 0) {
			return { text: "No access tokens.", json: { tokens: [] }, code: 0 };
		}

		const text = list
			.map((token) => {
				const state =
					token.revokedAt !== null
						? "revoked"
						: token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now()
							? "expired"
							: "active";
				const used =
					token.lastUsedAt === null ? "never used" : `last used ${day(token.lastUsedAt)}`;

				return `${token.prefix}…\t${token.name}\t${state}\t${used}`;
			})
			.join("\n");

		return { text, json: { tokens: list }, code: 0 };
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Formats a timestamp as a calendar date.
 *
 * @param iso The timestamp.
 * @returns The date, or the input when it cannot be parsed — which is more useful here than a dash,
 * because anything unparseable in this field is a contract problem worth seeing.
 */
function day(iso: string): string {
	const parsed = new Date(iso);

	return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString().slice(0, 10);
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
