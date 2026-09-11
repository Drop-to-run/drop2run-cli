import {
	type Attempt,
	type Callback,
	clientName,
	consentUrl,
	dashboardUrlFor,
	exchange,
	type Listener,
	listen,
	loadCredentials,
	newAttempt,
	openBrowser,
	pollDevice,
	resolveApiBaseUrl,
	saveToken,
	startDevice,
	TOKEN_VARIABLE,
} from "@drop2run/node";

/**
 * Signing in from inside a chat, which is a different shape of the same flow the CLI runs.
 *
 * <b>Why this exists at all.</b> Somebody who adds only the MCP server has no `drop2run` command, so
 * "run `drop2run login`" is not an instruction they can follow — the only route left was creating a
 * token on the dashboard and hand-writing `~/.config/drop2run/config.json`, which is what the first
 * real transcript of this server did. The token flow is the same PKCE loopback the CLI uses; what
 * changes is that nothing here can print while it waits.
 *
 * <b>That one difference is the whole design.</b> A tool call is one request and one answer: there is
 * no channel to say "opening your browser…" and then say something else. So a sign-in that cannot
 * finish inside one call <b>keeps its state in this module and answers with what to do next</b>, and
 * the next call continues it rather than starting again. A flow restarted per call would invalidate the
 * URL it had just handed out.
 *
 * <b>What never enters a tool result.</b> The verifier, the loopback code, the device code and the
 * token itself. The device code is the one that looks harmless and is not — it is what collects the
 * token, so it stays in this process and only the short user code is spoken aloud.
 */

/** How long one `login` call waits for the browser before answering "not yet", in seconds. */
const DEFAULT_WAIT_SECONDS = 120;

/** Longest a caller may ask one call to wait, below the timeout clients tend to impose on a tool. */
export const MAX_WAIT_SECONDS = 240;

/** How long a started sign-in stays resumable, matching what the server gives the codes. */
const ATTEMPT_LIFETIME_MS = 15 * 60 * 1000;

/** Longest gap between device polls, so backing off repeatedly cannot stretch into never asking. */
const MAX_POLL_MS = 30 * 1000;

/** A loopback sign-in that has been started and is still waiting for the browser. */
interface PendingBrowser {
	/** The verifier and state this attempt is checked against. */
	readonly attempt: Attempt;
	/** The listener holding the port named in the URL. */
	readonly listener: Listener;
	/** The consent URL already handed to the caller, which stays valid while this is pending. */
	readonly url: string;
	/** Where to exchange the code. */
	readonly apiBaseUrl: string;
	/** When this stops being resumable. */
	readonly expiresAt: number;
}

/** A device sign-in that has been started and is still waiting for approval. */
interface PendingDevice {
	/** The long code, which never leaves this process. */
	readonly deviceCode: string;
	/** The short code somebody types, already shown to the caller. */
	readonly userCode: string;
	/** Where to type it. */
	readonly verificationUri: string;
	/** Where to open it with the code already filled in. */
	readonly verificationUriComplete: string;
	/** Where to poll. */
	readonly apiBaseUrl: string;
	/** When this stops being resumable. */
	readonly expiresAt: number;
	/** Current gap between polls, which grows when the server says to slow down. */
	waitMs: number;
}

/** The loopback sign-in in progress, if any. At most one — a second would orphan the first's port. */
let pendingBrowser: PendingBrowser | null = null;

/** The device sign-in in progress, if any. */
let pendingDevice: PendingDevice | null = null;

/**
 * Forgets a started loopback sign-in and releases its port.
 *
 * Called on every ending, including failure: a listener left open holds a port and keeps this process
 * alive after the chat has moved on.
 */
function dropPendingBrowser(): void {
	pendingBrowser?.listener.close();
	pendingBrowser = null;
}

/**
 * Turns a requested wait into one this server will actually honour.
 *
 * Bounded at both ends because both ends are somebody's mistake to make: zero seconds is a call that
 * cannot succeed, and an hour is a call the client kills before it answers, which looks to everybody
 * like the sign-in broke. The floor is a second rather than the five the tool schema asks for, so a
 * test can prove the "not approved yet" answer without spending five seconds on each one.
 *
 * @param requested What the caller asked for, if anything.
 * @returns Seconds to wait.
 */
function waitSecondsFor(requested?: number): number {
	if (requested === undefined) return DEFAULT_WAIT_SECONDS;

	return Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.floor(requested)));
}

/**
 * What to say when a token is already stored and the caller did not ask to replace it.
 *
 * <b>Signing in again is not free.</b> It issues another token against the account, which somebody then
 * finds on the tokens page with no way to tell why there are two. So the default is to stop and say
 * what is already there, and replacing it is something the caller has to ask for.
 *
 * @returns The message, or null when there is no token and the sign-in should go ahead.
 */
function alreadySignedIn(): string | null {
	const credentials = loadCredentials();
	if (credentials === null) return null;

	return [
		"Already signed in — a token is stored, so publishing should work.",
		"",
		`API: ${credentials.apiBaseUrl}`,
		"",
		"If publishing is refused as unauthorized, or this is the wrong account, call this tool again",
		"with replace set to true to sign in over it.",
	].join("\n");
}

/**
 * Notes a token in the environment, which outranks the one just written.
 *
 * Said rather than silently accepted, for the reason `logout` says the same thing: a sign-in that
 * reported success while a different token stayed in force would be lying about the one fact somebody
 * called it to establish.
 *
 * @returns A sentence to append, or an empty string when nothing is in the way.
 */
function environmentOverrideNote(): string {
	if (!process.env[TOKEN_VARIABLE]?.trim()) return "";

	return [
		"",
		`Note: ${TOKEN_VARIABLE} is set in this server's environment and outranks the stored file, so`,
		"that token is still the one in force. Unset it and restart this server to use the new one.",
	].join("\n");
}

/**
 * How a finished sign-in reads.
 *
 * @param email The account's address, where the API sent one.
 * @param name What the token is called on the tokens page.
 * @param path Where it was written.
 * @returns The text.
 */
function signedIn(email: string | null, name: string, path: string): string {
	return [
		`Signed in${email === null ? "" : ` as ${email}`}.`,
		"",
		`Token "${name}" saved to ${path}. Publishing works from the next call — nothing needs`,
		"restarting.",
		environmentOverrideNote(),
	].join("\n");
}

/**
 * Signs in through a browser on this machine, across as many calls as it takes.
 *
 * <b>Three answers, not two.</b> Signed in, not yet, and could not start. "Not yet" is the ordinary one:
 * the browser is open and somebody has not clicked yet, so the call returns what is still true and the
 * attempt stays alive for the next one. Treating that as a failure would throw away a valid consent URL
 * somebody is looking at.
 *
 * <b>A browser that will not open is not a failure either.</b> On a machine with no desktop the URL is
 * still openable from somewhere else, so it is returned rather than waited on — waiting silently on a
 * URL nobody has seen is the one behaviour that guarantees nothing happens.
 *
 * @param waitSeconds How long this call may wait, clamped.
 * @param replace Sign in even when a token is already stored.
 * @param open Launches the browser, injectable so a test can prove the waiting behaviour without a real
 * tab opening on the machine running it.
 * @returns The text to show.
 * @throws Error when no local port can be opened, or the exchange is refused.
 */
export async function signInWithBrowser(
	waitSeconds?: number,
	replace = false,
	open: (url: string) => boolean = openBrowser,
): Promise<string> {
	if (!replace) {
		const already = alreadySignedIn();
		if (already !== null) return already;
	}

	if (pendingBrowser !== null && pendingBrowser.expiresAt <= Date.now()) dropPendingBrowser();

	let current: PendingBrowser;
	let resumed: boolean;

	if (pendingBrowser === null) {
		resumed = false;

		const apiBaseUrl = resolveApiBaseUrl();
		const attempt = newAttempt();

		let listener: Listener;
		try {
			listener = await listen(attempt.state);
		} catch (error) {
			throw new Error(
				`Could not open a local port to receive the sign-in: ${
					error instanceof Error ? error.message : String(error)
				}. Call login_code instead, which needs no port.`,
			);
		}

		current = {
			attempt,
			listener,
			url: consentUrl(dashboardUrlFor(apiBaseUrl), attempt, listener.port, clientName("mcp")),
			apiBaseUrl,
			expiresAt: Date.now() + ATTEMPT_LIFETIME_MS,
		};
		pendingBrowser = current;

		// A handler registered now, discarding nothing: the promise outlives this call, and a rejection
		// with no handler attached is an unhandled rejection, which takes the whole server down. The call
		// that resumes the attempt awaits the same promise and still sees the rejection.
		current.listener.received.catch(() => {});

		// Attempted only on the first call: a resumed attempt already has its tab open somewhere, and a
		// second one would ask somebody to approve the same sign-in twice.
		if (!open(current.url)) {
			return [
				"Could not open a browser here. Ask the person to open this URL and approve the sign-in:",
				"",
				current.url,
				"",
				"Then call this tool again to collect the token. The URL stays valid until then.",
			].join("\n");
		}
	} else {
		resumed = true;
		current = pendingBrowser;
	}

	try {
		const waited = await waitOrTimeOut(
			current.listener.received,
			waitSecondsFor(waitSeconds) * 1000,
		);

		if (waited === null) {
			return [
				resumed
					? "Still not approved."
					: "A browser has been opened for the sign-in. Not approved yet.",
				"",
				current.url,
				"",
				"Call this tool again to keep waiting. Nothing has been changed yet.",
			].join("\n");
		}

		const issued = await exchange(current.apiBaseUrl, waited.code, current.attempt.verifier);
		const path = saveToken(issued.token);

		dropPendingBrowser();

		return signedIn(issued.email, issued.name, path);
	} catch (error) {
		// Not a timeout — the browser sent something that cannot be trusted, or the API refused the
		// exchange. Neither is worth resuming, and leaving the port open after either would hold it for
		// a sign-in that can no longer complete.
		dropPendingBrowser();

		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Waits for the browser, or gives up for now.
 *
 * <b>Timing out is a value here, not an exception.</b> The CLI's `waitForCallback` throws, which is
 * right for a command that has nothing else to do — but this caller has to tell a timeout apart from a
 * refused exchange, and telling them apart by the text of an error message would break the moment the
 * message is rephrased.
 *
 * @param received The listener's promise.
 * @param timeoutMs How long to wait.
 * @returns The callback, or null when the wait ran out.
 * @throws Error when the browser delivered something that did not match this sign-in.
 */
async function waitOrTimeOut(
	received: Promise<Callback>,
	timeoutMs: number,
): Promise<Callback | null> {
	let timer: NodeJS.Timeout | undefined;

	try {
		return await Promise.race([
			received,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Signs in without a browser on this machine, by having somebody approve a short code elsewhere.
 *
 * <b>Two calls, and the split is not arbitrary.</b> The first call has to answer immediately, because
 * what it returns — the code and where to type it — is the thing somebody needs before anything can
 * happen. A first call that waited would hold the code back until after the wait it was waiting for.
 * The second call polls.
 *
 * @param waitSeconds How long a polling call may wait, clamped.
 * @param replace Sign in even when a token is already stored.
 * @returns The text to show.
 * @throws Error when the sign-in cannot be started, or is refused.
 */
export async function signInWithCode(waitSeconds?: number, replace = false): Promise<string> {
	if (!replace) {
		const already = alreadySignedIn();
		if (already !== null) return already;
	}

	if (pendingDevice !== null && pendingDevice.expiresAt <= Date.now()) pendingDevice = null;

	if (pendingDevice === null) {
		const apiBaseUrl = resolveApiBaseUrl();
		const request = await startDevice(apiBaseUrl, clientName("mcp"));

		pendingDevice = {
			deviceCode: request.deviceCode,
			userCode: request.userCode,
			verificationUri: request.verificationUri,
			verificationUriComplete: request.verificationUriComplete,
			apiBaseUrl,
			expiresAt: Date.now() + ATTEMPT_LIFETIME_MS,
			waitMs: Math.max(1, request.intervalSeconds) * 1000,
		};

		return [
			`Ask the person to open ${request.verificationUri} and enter this code:`,
			"",
			`    ${request.userCode}`,
			"",
			`Or send them this link, which has the code in it: ${request.verificationUriComplete}`,
			"",
			"Then call this tool again to wait for the approval and collect the token.",
		].join("\n");
	}

	const pending = pendingDevice;
	const deadline = Date.now() + waitSecondsFor(waitSeconds) * 1000;

	while (Date.now() < deadline) {
		await new Promise<void>((done) => {
			setTimeout(done, pending.waitMs);
		});

		const poll = await pollDevice(pending.apiBaseUrl, pending.deviceCode);

		if (poll.state === "granted") {
			const path = saveToken(poll.token.token);
			pendingDevice = null;

			return signedIn(poll.token.email, poll.token.name, path);
		}

		if (poll.state === "dead") {
			pendingDevice = null;
			throw new Error(poll.message);
		}

		// Backing off on being told to rather than on the next attempt: a client that acknowledged
		// `slow_down` and then polled at the same rate would be told again forever.
		if (poll.state === "slow_down") pending.waitMs = Math.min(pending.waitMs * 2, MAX_POLL_MS);
	}

	return [
		"Not approved yet.",
		"",
		`Code ${pending.userCode}, at ${pending.verificationUri}.`,
		"",
		"Call this tool again to keep waiting. Nothing has been changed yet.",
	].join("\n");
}

/**
 * Forgets any sign-in in progress.
 *
 * Exists for tests: the pending attempts are module state, so one test's half-finished sign-in would
 * otherwise be resumed by the next one and assert against a port that test never opened.
 */
export function resetPendingSignIns(): void {
	dropPendingBrowser();
	pendingDevice = null;
}
