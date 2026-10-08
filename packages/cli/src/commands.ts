import { resolve } from "node:path";
import {
	accessOf,
	type CommentThread,
	type Credentials,
	clearToken,
	clientName,
	configPath,
	consentUrl,
	createSite,
	dashboardUrlFor,
	deleteSite,
	describeMode,
	describeSite,
	exchange,
	findSite,
	getSite,
	listComments,
	listen,
	listFolders,
	listSites,
	listTokens,
	loadCredentials,
	missingCredentialsMessage,
	type NewSite,
	newAttempt,
	// Shared with `open`: the same three platform launchers, and the same "failure is not fatal" rule.
	openBrowser,
	PROJECT_FILE,
	type Project,
	pollDevice,
	promoteDeploy,
	publishDirectory,
	readProject,
	replyToComment,
	resolveApiBaseUrl,
	resolveFolder,
	resolveFolderTarget,
	type ServingMode,
	type SiteSettingsChange,
	saveToken,
	servingModeOf,
	setCommentResolved,
	setSitePaused,
	startDevice,
	TOKEN_VARIABLE,
	updateSiteSettings,
	waitForCallback,
	writeProject,
} from "@drop2run/node";
import { type ProgressWriter, silentProgress } from "./progress.js";
import { readSecret } from "./secret.js";

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

	// 204 is how `/me` says nobody is signed in — it answers that rather than 401 so the dashboard's
	// signed-out page loads stay quiet — and a token the API does not accept arrives as nobody. Read
	// as success, it crashed here parsing an empty body with a stack trace instead of saying why.
	if (!response.ok || response.status === 204) {
		return failure(
			response.status === 401 || response.status === 204
				? "This token is not valid any more. It may have been revoked or expired — create another " +
						"at https://app.dropto.run/account/tokens."
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
 * Lists the account's sites, in one request.
 *
 * <b>One request, and it says when that was not all of them.</b> The API pages its listing and allows
 * at most 100 a page; an account holds a handful, so a loop over pages would be machinery for a case
 * that does not happen. If it does, the last line says how many were left out rather than letting a
 * short list pass for the whole one — the defect this replaced was exactly that, at 25.
 *
 * @returns The result.
 */
export async function list(): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const { sites, total } = await listSites(found.credentials);
	if (sites.length === 0) {
		return {
			text: "No sites yet. `drop2run deploy` publishes one.",
			json: { sites: [], total: 0 },
			code: 0,
		};
	}

	const lines = sites.map(
		(site) => `${site.subdomain}\t${site.url}${site.name ? `\t${site.name}` : ""}`,
	);
	if (total > sites.length) {
		lines.push(
			`… and ${(total - sites.length).toLocaleString()} more — this lists the newest ` +
				`${sites.length.toLocaleString()} of ${total.toLocaleString()}.`,
		);
	}

	return {
		text: lines.join("\n"),
		json: { sites, total },
		code: 0,
	};
}

/**
 * Lists the account's folders, one path per line, so `--folder` has something to be copied from.
 *
 * Paths rather than a drawn tree, because a path is exactly what `--folder` takes: a line of this output
 * pasted after the flag is a working command, and a tree would have to be read back into one.
 *
 * @returns The result.
 */
export async function folders(): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	try {
		const all = await listFolders(found.credentials);

		if (all.length === 0) {
			return {
				text:
					"No folders yet. Make one in the dashboard at " +
					`${dashboardUrlFor(found.credentials.apiBaseUrl)}, then file a new site in it with ` +
					"`--folder`.",
				json: { folders: [] },
				code: 0,
			};
		}

		return {
			text: all.map((folder) => `${folder.path}\t${folder.folderId}`).join("\n"),
			json: { folders: all },
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Publishes a folder.
 *
 * <b>Four sources for "which site", in one order.</b> `--subdomain` wins, then `--site` because it was
 * typed for this run;
 * then `drop2run.json`, because somebody ran `init` in this folder and meant it; and only with neither
 * does a new site get created. The order matters more than it looks: a publish that silently created a
 * site when a project file existed would leave the real one untouched and the person looking at a URL
 * they did not expect.
 *
 * The same order decides the folder, so `drop2run deploy` in a project with `dir: "dist"` publishes
 * `dist` rather than the repository around it.
 *
 * <b>It says what it is doing while it does it.</b> A deploy is the one command here that takes long
 * enough for silence to read as a hang, and the engine has always reported its stages — the CLI simply
 * dropped them. They go to stderr, so a shell reading stdout still gets the URL and nothing else.
 *
 * <b>`--subdomain` is a fourth source, and it outranks the other three</b> because it cannot mean
 * anything else: naming a subdomain for a site that does not exist yet is a request to create one under
 * that name, and there is no reading of it that refers to the project file. It is refused alongside
 * `--site` before this is called — see `run` — so the two cannot both be set here.
 *
 * <b>`--folder` does not outrank the project file.</b> It files a *new* site, and on its own it is not
 * a request for one — `deploy --folder Clients` in a project that already publishes somewhere reads
 * just as well as "move my site into Clients". That is a different request, so it is refused and named
 * rather than answered by creating a second site nobody asked for.
 *
 * @param directory Folder to publish, or undefined to use the project file and then the working directory.
 * @param site Subdomain or site id to publish over, or undefined to use the project file.
 * @param report Receives progress, injectable so a test does not print and `--json` can suppress it.
 * @param newSite Name and folder for a new site. A subdomain here means a new site is wanted.
 * @returns The result.
 */
export async function deployCommand(
	directory: string | undefined,
	site?: string,
	report: ProgressWriter = silentProgress,
	newSite: NewSite = {},
): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const project = readProject();
	const folder = directory ?? project?.dir ?? ".";

	// Only when no name was typed for a new site. Passing both the project file's site and a subdomain
	// would ask to publish over a site and to create one in the same call, which is refused below rather
	// than resolved by preferring one — see `resolveSite`.
	const target = newSite.subdomain === undefined ? (site ?? project?.siteId) : undefined;

	// `--site` with `--folder` never gets here — `run` refuses it — so a target at this point came from
	// the project file, and the refusal names that file rather than a flag nobody typed.
	if (newSite.folder !== undefined && target !== undefined && project !== null) {
		return failure(
			`This folder's ${PROJECT_FILE} already publishes to ${project.subdomain || project.siteId}, and ` +
				"`--folder` only files a new site. Move that site with `drop2run set folder <path>`, or " +
				"add `--subdomain` to create a new one in the folder.",
		);
	}

	try {
		const result = await publishDirectory(
			found.credentials,
			resolve(folder),
			target,
			report,
			newSite,
		);
		const what = result.unchanged
			? "Already up to date — nothing needed publishing."
			: `Published ${result.files.toLocaleString()} ${result.files === 1 ? "file" : "files"}.`;
		// After the URL, so the address stays on its own line where a script reading the second line of
		// the output has always found it.
		const mode = describeMode(result);

		return {
			text: `${what}\n${result.url}${mode === null ? "" : `\n${mode}`}`,
			json: result,
			code: 0,
		};
	} catch (error) {
		return failureFrom(error);
	} finally {
		// In `finally` because a failed deploy leaves a half-drawn line too, and printing an error on top
		// of it is how a message ends up with "Uploading 41/98" still attached to its tail.
		report.done();
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
 * <b>`--subdomain` names the site it creates.</b> Without it the server generates a name, which is the
 * right default for a folder nobody has decided about yet and the wrong one for a project that will be
 * linked to from somewhere. It is a separate flag from `--site` rather than a fallback inside it,
 * because `--site` that matches nothing must keep failing: a typo turned into a new site under the
 * typo's name is a mistake nobody notices until the old URL is asked for.
 *
 * <b>`--folder` files the site it creates</b>, and is resolved before anything is created: a folder that
 * does not exist fails with the list of those that do, and leaves no site behind.
 *
 * @param directory Folder to publish, relative to the working directory.
 * @param site Subdomain or site id of an existing site, or undefined to create one.
 * @param newSite Name and folder for the site this creates, when `site` is undefined.
 * @returns The result.
 */
export async function init(
	directory: string,
	site?: string,
	newSite: NewSite = {},
): Promise<CommandResult> {
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
				? await createSite(
						found.credentials,
						newSite.subdomain,
						newSite.folder === undefined
							? undefined
							: await resolveFolder(found.credentials, newSite.folder),
					)
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
 * Picks the site a command acts on: the one named, or the one in the project file.
 *
 * @param site Subdomain or site id, or undefined to use the project file.
 * @param usage How to name a site for this command, for the refusal.
 * @returns The site's identifier as typed, or a refusal.
 */
function siteOr(
	site: string | undefined,
	usage: string,
): { named: string } | { result: CommandResult } {
	const named = site ?? readProject()?.siteId;

	return named === undefined
		? {
				result: failure(
					`Name the site: \`${usage}\`, or run this in a folder with a ${PROJECT_FILE}.`,
				),
			}
		: { named };
}

/**
 * Shows one site's settings, state and versions.
 *
 * The question to answer before `set`, `pause` or `rollback`: what is it now, and which version id is
 * the one to go back to.
 *
 * @param site Subdomain or site id, or undefined to use the project file.
 * @returns The result.
 */
export async function info(site: string | undefined): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const target = siteOr(site, "drop2run info <subdomain>");
	if ("result" in target) return target.result;

	try {
		const summary = await findSite(found.credentials, target.named);
		const detail = await getSite(found.credentials, summary.siteId);
		const folderPath =
			detail.folderId === null
				? undefined
				: (await listFolders(found.credentials)).find(
						(folder) => folder.folderId === detail.folderId,
					)?.path;

		return {
			text: describeSite(detail, folderPath),
			json: { ...detail, mode: servingModeOf(detail), folderPath: folderPath ?? null },
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Takes a site off the air, or puts it back.
 *
 * No `--yes` on either: a pause keeps every file, version and the subdomain, and `resume` undoes it.
 *
 * @param action `pause` or `resume`.
 * @param site Subdomain or site id, or undefined to use the project file.
 * @returns The result.
 */
export async function pauseOrResume(
	action: "pause" | "resume",
	site: string | undefined,
): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const target = siteOr(site, `drop2run ${action} <subdomain>`);
	if ("result" in target) return target.result;

	try {
		const summary = await findSite(found.credentials, target.named);
		const state = await setSitePaused(found.credentials, summary.siteId, action);

		return {
			text:
				action === "resume"
					? `${state.subdomain} is back on the air.\n${summary.url}`
					: state.status === "paused"
						? `Paused ${state.subdomain}. Its files and subdomain are kept; \`drop2run resume\` puts it back.`
						: // A site Drop2Run suspended stays suspended: the pause is recorded for when that lifts,
							// and promising `resume` here would be promising something the API refuses.
							`${state.subdomain} is ${state.status}, not paused by you, so \`drop2run resume\` ` +
							"cannot bring it back. The pause is recorded and applies if that is lifted.",
			json: state,
			code: 0,
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/** The settings `set` and `unset` know, and how each is written. */
const SETTINGS_USAGE = [
	"  name <text>                 What the dashboard calls the site",
	"  mode static|spa|docs        How it serves files",
	"  password                    Read from stdin, or typed at a hidden prompt",
	"  forms on|off                Whether its forms accept submissions",
	"  expires <ISO 8601 instant>  When it comes down; add --then delete to delete rather than pause",
	"  folder <path|id|root>       Which folder it is filed in",
].join("\n");

/** What a reader of a password is, injectable so a test does not need a terminal. */
export type PasswordReader = () => Promise<string>;

/**
 * What `set` was asked to change, before anything that needs the network or a keyboard.
 *
 * A folder and a password are named here and filled in later: the folder needs the account's folder
 * list, and the password is asked for only once the site is known to exist, so a mistyped subdomain
 * does not cost somebody typing a password into nothing.
 */
type ParsedSetting =
	| { readonly change: SiteSettingsChange }
	| { readonly folder: string }
	| { readonly password: true }
	| { readonly refusal: string };

/**
 * Turns `set <setting> <value>` into a settings change, or says why it cannot.
 *
 * @param setting What to change.
 * @param values The words after it.
 * @param then The value of `--then`, for `expires`.
 * @returns The change, or the refusal to print.
 */
function settingChange(
	setting: string | undefined,
	values: readonly string[],
	then: string | undefined,
): ParsedSetting {
	// Several words for a name, so `set name Launch notes` needs no quotes.
	const value = setting === "name" ? values.join(" ").trim() : values[0];
	const needs = (example: string) => ({
		refusal: `\`set ${setting}\` needs a value, for example \`drop2run set ${setting} ${example}\`.`,
	});

	if (then !== undefined && setting !== "expires") {
		return { refusal: "`--then` only applies to `set expires`." };
	}

	// A second word is refused rather than dropped: `set mode spa other-site` reads like naming a site,
	// and dropping it would change the site in drop2run.json instead. `password` has its own refusal.
	if (setting !== "name" && setting !== "password" && values.length > 1) {
		return {
			refusal:
				`\`set ${setting}\` takes one value, and "${values.slice(1).join(" ")}" is extra. ` +
				"Name the site with `--site <subdomain>`.",
		};
	}

	switch (setting) {
		case "name":
			return value ? { change: { name: value } } : needs('"Launch notes"');
		case "mode":
			if (value === "static" || value === "spa" || value === "docs") {
				return { change: { mode: value satisfies ServingMode } };
			}
			return { refusal: "`set mode` takes `static`, `spa` or `docs`." };
		case "forms":
			if (value === "on" || value === "off") return { change: { formsEnabled: value === "on" } };
			return { refusal: "`set forms` takes `on` or `off`." };
		case "password": {
			if (value !== undefined) {
				// Refused even though the value is right there: taking it would teach the habit of
				// typing a password where shell history keeps it.
				return {
					refusal:
						"`set password` does not take the password as an argument, where it would stay in " +
						"your shell history. Run `drop2run set password` and type it, or pipe it in: " +
						'`printf %s "$SITE_PASSWORD" | drop2run set password`.',
				};
			}

			return { password: true };
		}
		case "expires": {
			if (value === undefined) return needs("2026-12-31T09:00:00Z");
			if (then !== undefined && then !== "pause" && then !== "delete") {
				return { refusal: "`--then` takes `pause` or `delete`." };
			}
			return {
				change: {
					expiresAt: value,
					...(then === undefined ? {} : { expiryAction: then }),
				},
			};
		}
		case "folder":
			return value ? { folder: value } : needs("Clients/Acme");
		default:
			return {
				refusal: `${setting === undefined ? "Name a setting." : `\`${setting}\` is not a setting.`} Settings:\n${SETTINGS_USAGE}`,
			};
	}
}

/**
 * Changes one setting of a site.
 *
 * <b>One setting per run.</b> Each is a different sentence — `set mode spa`, `set expires …` — and a
 * command that took several would need flags for all of them, which is a second spelling of the same
 * thing. The API takes them together; the terminal does not need to.
 *
 * <b>A scheduled deletion needs `--yes`</b>, for the reason `rm` does: when it falls due the files go
 * and the subdomain is released, and there is no undo then either.
 *
 * @param site Subdomain or site id, or undefined to use the project file.
 * @param setting What to change.
 * @param values The words after it.
 * @param options `--then` for `expires`, and whether `--yes` was given.
 * @param readPassword Reads the password for `password`; a test passes its own.
 * @returns The result.
 */
export async function set(
	site: string | undefined,
	setting: string | undefined,
	values: readonly string[],
	options: { readonly then?: string | undefined; readonly confirmed: boolean },
	readPassword: PasswordReader = () => readSecret("Password for visitors: "),
): Promise<CommandResult> {
	// Read before the token, so a mistyped setting is answered without one.
	const parsed = settingChange(setting, values, options.then);
	if ("refusal" in parsed) return failure(parsed.refusal);

	const found = credentialsOr();
	if ("result" in found) return found.result;

	const target = siteOr(site, `drop2run set ${setting} … --site <subdomain>`);
	if ("result" in target) return target.result;

	try {
		const summary = await findSite(found.credentials, target.named);
		let change: SiteSettingsChange;

		if ("folder" in parsed) {
			change = { folderId: await resolveFolderTarget(found.credentials, parsed.folder) };
		} else if ("password" in parsed) {
			const password = await readPassword();

			if (password === "") {
				return failure("No password was given. To remove one, run `drop2run unset password`.");
			}
			change = { password };
		} else {
			change = parsed.change;
		}

		if (change.expiryAction === "delete" && !options.confirmed) {
			return failure(
				`This would delete ${summary.subdomain} and every version published to it when ` +
					`${change.expiresAt} arrives, with no way back then.\n` +
					"Add --yes if that is what you want, or leave out --then to pause it instead.",
			);
		}

		return await applied(found.credentials, summary.siteId, summary.subdomain, change);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Clears one setting of a site: its name, its password or its scheduled takedown.
 *
 * @param site Subdomain or site id, or undefined to use the project file.
 * @param setting What to clear.
 * @returns The result.
 */
export async function unset(
	site: string | undefined,
	setting: string | undefined,
	extra: readonly string[] = [],
): Promise<CommandResult> {
	// Refused for the reason `set` refuses a second value: `unset password other-site` would otherwise
	// make the site in drop2run.json public.
	if (extra.length > 0) {
		return failure(
			`\`unset ${setting}\` takes nothing after it, and "${extra.join(" ")}" is extra. Name the site ` +
				"with `--site <subdomain>`.",
		);
	}

	// Empty strings, which the API reads as "clear" — null would mean "leave alone".
	// A Map rather than an object literal, so `unset toString` finds nothing instead of a prototype method.
	const clear = new Map<string, SiteSettingsChange>([
		["name", { name: "" }],
		["password", { password: "" }],
		["expires", { expiresAt: "" }],
	]);
	const change = setting === undefined ? undefined : clear.get(setting);

	if (change === undefined) {
		return failure(
			"`unset` clears `name`, `password` or `expires`. To file the site at the top level, run " +
				"`drop2run set folder root`.",
		);
	}

	const found = credentialsOr();
	if ("result" in found) return found.result;

	const target = siteOr(site, `drop2run unset ${setting} --site <subdomain>`);
	if ("result" in target) return target.result;

	try {
		const summary = await findSite(found.credentials, target.named);

		return await applied(found.credentials, summary.siteId, summary.subdomain, change);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Sends a settings change and says what the site is set to now.
 *
 * @param credentials Token and base URL.
 * @param siteId ULID of the site.
 * @param subdomain Its subdomain, for the sentence.
 * @param change What to change.
 * @returns The result.
 */
async function applied(
	credentials: Credentials,
	siteId: string,
	subdomain: string,
	change: SiteSettingsChange,
): Promise<CommandResult> {
	const settings = await updateSiteSettings(credentials, siteId, change);
	const takedown =
		settings.expiresAt === null ? "none" : `${settings.expiresAt} (${settings.expiryAction})`;

	return {
		text: [
			`Updated ${subdomain}.`,
			`  name      ${settings.name ?? "(none)"}`,
			`  access    ${accessOf(settings)}`,
			`  mode      ${servingModeOf(settings)}`,
			`  forms     ${settings.formsEnabled ? "on" : "off"}`,
			`  takedown  ${takedown}`,
			...(settings.replacedInviteOnly
				? [
						"The password replaced invite-only: the people on its list can no longer get in " +
							"without it. The list is kept for if you switch back in the dashboard.",
					]
				: []),
			settings.live
				? "Reaching every edge takes up to about a minute."
				: "Nothing is published yet, so this applies from the first publish.",
		].join("\n"),
		json: { ...settings, mode: servingModeOf(settings) },
		code: 0,
	};
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

/** What `comments` takes besides its subcommand and positionals. */
export interface CommentOptions {
	/** Value of `--status`: `open`, `resolved` or `all`. */
	readonly status?: string | undefined;
	/** Value of `--path`: one page of the site. */
	readonly path?: string | undefined;
	/** Whether `--resolve` was given, to resolve a thread with the reply. */
	readonly resolve?: boolean | undefined;
}

/** How `comments` is used, for its refusals. */
const COMMENTS_USAGE = [
	"  drop2run comments [site] [--status open|resolved|all] [--path /page]",
	"  drop2run comments reply <thread> <text> [--resolve] [--site X]",
	"  drop2run comments resolve|reopen <thread> [--site X]",
].join("\n");

/**
 * Reads a site's comments, or answers, resolves or reopens a thread as its owner
 * (docs/briefs/FEEDBACK-MCP-BRIEF.md §4.6).
 *
 * <b>Reading names the site in the same place every other read does</b> — `comments calm-cedar`, like
 * `info calm-cedar` — while the three that act on a thread take it after the subcommand, so they name the
 * site with `--site` or the project file, as `set` does.
 *
 * <b>A reply does not resolve unless asked.</b> A resolved thread stays on the version it was opened on, so
 * resolving right after the deploy that fixed it would take it off the live page before the person who
 * raised it has seen the answer.
 *
 * @param subcommand `reply`, `resolve`, `reopen`, or anything else for reading (then it is the site).
 * @param rest The positionals after the subcommand.
 * @param site Value of `--site`, if given.
 * @param options `--status`, `--path` and `--resolve`.
 * @returns The result.
 */
export async function comments(
	subcommand: string | undefined,
	rest: readonly string[],
	site: string | undefined,
	options: CommentOptions,
): Promise<CommandResult> {
	const found = credentialsOr();
	if ("result" in found) return found.result;

	const acting = subcommand === "reply" || subcommand === "resolve" || subcommand === "reopen";

	if (!acting) {
		const status = options.status ?? "open";
		if (status !== "open" && status !== "resolved" && status !== "all") {
			return failure(
				`\`--status\` is open, resolved or all, not "${status}".\n\n${COMMENTS_USAGE}`,
			);
		}

		const target = siteOr(subcommand ?? site, "drop2run comments <subdomain>");
		if ("result" in target) return target.result;

		try {
			const summary = await findSite(found.credentials, target.named);
			const read = await listComments(found.credentials, summary.siteId, {
				status,
				path: options.path,
			});

			return {
				text: describeComments(read.threads, status, summary.subdomain, read.more),
				json: read,
				code: 0,
			};
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	}

	const [thread, ...words] = rest;
	if (thread === undefined)
		return failure(`Name the thread, from \`drop2run comments\`.\n\n${COMMENTS_USAGE}`);

	const body = words.join(" ").trim();
	if (subcommand === "reply" && body === "") {
		return failure(`Write the reply after the thread id.\n\n${COMMENTS_USAGE}`);
	}

	const target = siteOr(site, `drop2run comments ${subcommand} <thread> --site <subdomain>`);
	if ("result" in target) return target.result;

	try {
		const summary = await findSite(found.credentials, target.named);
		const answered =
			subcommand === "reply"
				? await replyToComment(
						found.credentials,
						summary.siteId,
						thread,
						body,
						options.resolve === true,
					)
				: await setCommentResolved(
						found.credentials,
						summary.siteId,
						thread,
						subcommand === "resolve",
					);

		const done =
			subcommand === "reply"
				? `Replied on ${answered.path}${answered.resolvedAt === null ? "" : " and resolved the thread"}.`
				: `${subcommand === "resolve" ? "Resolved" : "Reopened"} the thread on ${answered.path}.`;

		return { text: `${done}\n${answered.url}`, json: answered, code: 0 };
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

/**
 * A page of threads as a terminal shows it: each thread's id, page and the words it points at, then its
 * comments one to a line.
 *
 * @param threads The threads.
 * @param status Which threads were asked for, for the heading.
 * @param subdomain The site.
 * @param more Whether another page follows.
 * @returns The text.
 */
function describeComments(
	threads: readonly CommentThread[],
	status: string,
	subdomain: string,
	more: boolean,
): string {
	const which = status === "all" ? "" : `${status} `;
	if (threads.length === 0) return `No ${which}comment threads on ${subdomain}.`;

	const heading =
		`${threads.length} ${which}comment ${threads.length === 1 ? "thread" : "threads"} on ${subdomain}` +
		(more ? " (more follow; `--json` shows the cursor)." : ".");

	const blocks = threads.map((thread) => {
		const where = thread.place.quote ?? (thread.place.snippet || null);
		const flags = [
			...(thread.resolvedAt === null ? [] : ["resolved"]),
			...(thread.outdated ? ["earlier version"] : []),
		];

		return [
			`${thread.id}  ${thread.path}${where === null ? "" : `  "${where}"`}` +
				(flags.length === 0 ? "" : `  (${flags.join(", ")})`),
			...thread.comments.map((comment) => {
				const who = comment.author.owner ? `${comment.author.name} (owner)` : comment.author.name;

				return `  ${who}: ${comment.body.replace(/\s*\n\s*/g, " ")}`;
			}),
			`  ${thread.url}`,
		].join("\n");
	});

	return [heading, ...blocks].join("\n\n");
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
