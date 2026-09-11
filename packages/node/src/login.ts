import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";

/**
 * Signing in without anybody pasting a credential.
 *
 * <b>Why this is in `@drop2run/node` and not in the CLI.</b> Two surfaces sign in: the command line, and
 * the MCP server's `login` tool. It lived beside the CLI while the CLI was the only one, and the cost of
 * that showed up the first time somebody installed only the MCP server — the one message telling them how
 * to get a token named a command they did not have, so the only route left was creating a token on the web
 * and hand-writing a config file. A sign-in the chat can run needs this flow reachable from there.
 *
 * Nothing here prints or reads a terminal. The two callers differ in exactly that, so they keep it: the
 * CLI writes progress to stderr as it waits, and the tool returns text once.
 *
 * <b>Why a loopback server and not a pasted code.</b> The token has to end up in this process, and every
 * route that goes through a human — copy from a browser, paste into a terminal — is a route where it ends
 * up in a clipboard, a scrollback buffer and sometimes a screen recording. A listener on 127.0.0.1
 * receives it directly, and the browser is the only thing that ever sees the URL.
 *
 * <b>Why PKCE, when there is no client secret.</b> There cannot be one: this is a program on other
 * people's machines, so anything embedded in it is public. PKCE replaces the secret with one generated per
 * sign-in — the verifier stays in this process's memory, only its hash travels through the browser, and a
 * code intercepted anywhere along the way cannot be exchanged without it.
 *
 * <b>What this file deliberately does not do.</b> It never writes the code anywhere, never logs a URL
 * containing it, and never prints the token it receives. The one durable side effect is the config file,
 * and that is written by `saveToken` in this package, where the mode is enforced.
 */

/** How long to wait for the browser before giving up, in milliseconds. */
const TIMEOUT_MS = 5 * 60 * 1000;

/** Everything one sign-in attempt needs to check what comes back to it. */
export interface Attempt {
	/** The secret this process keeps; only its hash goes through the browser. */
	readonly verifier: string;
	/** Unpadded base64url SHA-256 of the verifier, which the server records against the code. */
	readonly challenge: string;
	/** Random value compared against what the browser returns, so a stray request cannot deliver a code. */
	readonly state: string;
}

/**
 * Generates the per-attempt secrets.
 *
 * 32 bytes each, base64url with no padding: the verifier is 43 characters, which is what the server's
 * challenge length check is derived from, and the alphabet survives a query string unescaped.
 *
 * @returns The verifier, its challenge, and the state value.
 */
export function newAttempt(): Attempt {
	const verifier = randomBytes(32).toString("base64url");

	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
		state: randomBytes(16).toString("base64url"),
	};
}

/**
 * What this machine calls itself, as the name the token will carry.
 *
 * The hostname, because the question the name has to answer later is "which machine is this, and do I
 * still have it" — that is what somebody reads on the tokens page when deciding what to revoke. Bounded
 * and stripped of anything that would need escaping where it is rendered.
 *
 * <b>Why the surface is appended.</b> Two things on one machine sign in now — the command line and the
 * MCP server — and a tokens page listing the same hostname twice cannot answer "which of these is the
 * one I want to revoke". The hostname is truncated to make room rather than the label, so the suffix is
 * never the half that gets cut.
 *
 * @param surface Short label for what is signing in, such as `mcp`. Omitted for the command line, where
 * the bare hostname is what earlier tokens already carry.
 * @returns A name at most 64 characters long, never empty.
 */
export function clientName(surface?: string): string {
	const clean = (value: string): string => value.trim().replace(/[^A-Za-z0-9._-]/g, "-");

	const label = surface === undefined ? "" : `-${clean(surface).slice(0, 16)}`;
	const raw = clean(hostname()).slice(0, 64 - label.length);

	return `${raw === "" ? "drop2run" : raw}${label}`;
}

/**
 * Opens a URL in the platform's browser, and says whether it could.
 *
 * <b>Failure is not fatal and must not be silent.</b> A container, an SSH session or a machine with no
 * browser all land here, and the sign-in still works if the person opens the URL themselves — so the URL
 * is printed either way and this only decides whether to also say "open this yourself". Detached and with
 * output discarded, so a browser that logs to stdout cannot corrupt `--json`.
 *
 * @param url The URL to open.
 * @returns True when a launcher was started; false when this platform has none or it failed immediately.
 */
export function openBrowser(url: string): boolean {
	const [command, args] =
		process.platform === "darwin"
			? (["open", [url]] as const)
			: process.platform === "win32"
				? (["cmd", ["/c", "start", "", url]] as const)
				: (["xdg-open", [url]] as const);

	try {
		const child = spawn(command, [...args], { stdio: "ignore", detached: true });
		child.unref();
		// A launcher that is missing entirely reports it asynchronously, so this cannot be caught here.
		// It does not matter: the URL is printed regardless, which is the fallback either way.
		child.on("error", () => {});

		return true;
	} catch {
		return false;
	}
}

/** What the loopback listener received, once it has been checked. */
export interface Callback {
	/** The one-time code the consent page redirected with. */
	readonly code: string;
}

/** A listener waiting for the browser, and the port it is on. */
export interface Listener {
	/** The port the browser must be told to redirect to. */
	readonly port: number;
	/** Resolves with the code, or rejects when the browser sends something that cannot be trusted. */
	readonly received: Promise<Callback>;
	/** Stops listening. Safe to call more than once. */
	readonly close: () => void;
}

/**
 * Starts the loopback listener the consent page will redirect to.
 *
 * Bound to 127.0.0.1 explicitly rather than to every interface: a server on 0.0.0.0 would accept a
 * redirect from another machine on the network, which is precisely the thing loopback is chosen to
 * prevent. Port 0 lets the operating system pick a free one, so two sign-ins at once cannot collide.
 *
 * @param state The value the browser must send back.
 * @returns The listener.
 */
export function listen(state: string): Promise<Listener> {
	return new Promise((resolveListener, rejectListener) => {
		let settle: ((callback: Callback) => void) | null = null;
		let fail: ((error: Error) => void) | null = null;

		const received = new Promise<Callback>((resolveCode, rejectCode) => {
			settle = resolveCode;
			fail = rejectCode;
		});

		const server = createServer((request: IncomingMessage, response: ServerResponse) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");

			if (url.pathname !== "/cb") {
				response.writeHead(404, { "Content-Type": "text/plain" });
				response.end("Not found.\n");

				return;
			}

			const code = url.searchParams.get("code") ?? "";
			const returned = url.searchParams.get("state") ?? "";

			// The state check is what stops anything else on this machine from handing this process a code.
			// Compared before the code is looked at at all, and a mismatch is a failure rather than a retry:
			// the only ways to reach it are a stale tab and something impersonating the consent page.
			if (returned !== state || code === "") {
				respond(
					response,
					400,
					"Sign-in could not be completed",
					"This did not come from the sign-in that was started here. Nothing has been changed.",
				);
				fail?.(new Error("The browser returned a response that did not match this sign-in."));

				return;
			}

			// Deliberately does not say where to go back to: a terminal for the CLI, a chat for the MCP
			// server's `login` tool, and naming one of them is wrong half the times this page is seen.
			respond(response, 200, "Signed in", "You can close this tab now.");
			settle?.({ code });
		});

		server.on("error", (error) => {
			rejectListener(error);
			fail?.(error instanceof Error ? error : new Error(String(error)));
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo | null;

			if (address === null) {
				rejectListener(new Error("Could not open a local port to receive the sign-in."));

				return;
			}

			resolveListener({
				port: address.port,
				received,
				close: () => server.close(),
			});
		});
	});
}

/**
 * Writes one of the two pages the browser sees at the end of a sign-in.
 *
 * Deliberately a whole page rather than bare text: this is the last thing somebody looks at before going
 * back to whatever started the sign-in, and an unstyled word in the corner of a tab reads as a crash. Self-contained, with
 * no request to anywhere — the listener closes moments later, so anything it linked to would fail to load.
 *
 * @param response The response to write.
 * @param status HTTP status.
 * @param title Headline, and the document title.
 * @param detail The sentence under it.
 */
function respond(response: ServerResponse, status: number, title: string, detail: string): void {
	response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	response.end(
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
			`<title>${title} — drop2run</title>` +
			`<style>body{font:16px/1.6 system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 1.5rem;color:#12211f}` +
			`h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;color:#64706e}` +
			`@media(prefers-color-scheme:dark){body{background:#0d1413;color:#e8efee}p{color:#9aa8a6}}</style>` +
			`</head><body><h1>${title}</h1><p>${detail}</p></body></html>\n`,
	);
}

/**
 * Waits for the browser, or gives up.
 *
 * The timeout exists because the alternative is a command that hangs forever when somebody closes the tab
 * — in a CI job, that is a stuck runner rather than a failed step.
 *
 * @param received The listener's promise.
 * @param timeoutMs How long to wait.
 * @returns The code.
 * @throws Error when the wait runs out or the browser sent something unusable.
 */
export async function waitForCallback(
	received: Promise<Callback>,
	timeoutMs: number = TIMEOUT_MS,
): Promise<Callback> {
	let timer: NodeJS.Timeout | undefined;

	try {
		return await Promise.race([
			received,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Timed out waiting for the browser. Nothing has been changed.")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Builds the consent URL the browser is sent to.
 *
 * The challenge, the state, the port and the name are all in the query string, and none of them is a
 * secret: the challenge is a hash, the state is only meaningful to this process, and the other two are
 * facts about this machine. The verifier is the one value that never appears here.
 *
 * @param dashboardUrl Origin of the dashboard.
 * @param attempt The attempt's challenge and state.
 * @param port The loopback port.
 * @param name What this machine calls itself.
 * @returns The URL to open.
 */
export function consentUrl(
	dashboardUrl: string,
	attempt: Attempt,
	port: number,
	name: string,
): string {
	const url = new URL("/cli-auth", dashboardUrl);

	url.searchParams.set("challenge", attempt.challenge);
	url.searchParams.set("state", attempt.state);
	url.searchParams.set("port", String(port));
	url.searchParams.set("name", name);

	return url.toString();
}

/** What opening a device sign-in returns. */
export interface DeviceRequest {
	/** The long code this process keeps; it is what collects the token. */
	readonly deviceCode: string;
	/** The short code a person carries to another machine. */
	readonly userCode: string;
	/** The page to open, with the code already in it. */
	readonly verificationUriComplete: string;
	/** The page to open when the code has to be typed by hand. */
	readonly verificationUri: string;
	/** How long to wait between polls, in seconds. */
	readonly intervalSeconds: number;
}

/**
 * Opens a device sign-in.
 *
 * @param apiBaseUrl Base URL of the API.
 * @param clientName What this machine calls itself.
 * @returns The two codes and where to send somebody.
 * @throws Error carrying the API's own `detail` where it sent one.
 */
export async function startDevice(apiBaseUrl: string, clientName: string): Promise<DeviceRequest> {
	const response = await fetch(`${apiBaseUrl}/auth/cli/device`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ clientName }),
	});

	if (!response.ok) throw new Error(await problemDetail(response));

	return (await response.json()) as DeviceRequest;
}

/** What one poll of a device sign-in produced. */
export type DevicePoll =
	| { readonly state: "pending" }
	| { readonly state: "slow_down" }
	| { readonly state: "granted"; readonly token: ExchangedToken }
	| { readonly state: "dead"; readonly message: string };

/**
 * Asks once whether a device sign-in has been approved.
 *
 * <b>Three outcomes, not two, and the caller must act differently on each.</b> Pending and `slow_down` both
 * mean keep waiting — the second more slowly — while anything else is over. A client that treated a refusal
 * as pending would poll a dead request until it expired, leaving somebody watching a terminal that never
 * finishes after they pressed Refuse.
 *
 * Network failures are reported as pending rather than as death: a laptop that lost its wifi for a moment
 * has not had its sign-in refused, and giving up on the first dropped packet is the wrong reading of a flow
 * that is expected to last minutes.
 *
 * @param apiBaseUrl Base URL of the API.
 * @param deviceCode The long code.
 * @returns What this poll established.
 */
export async function pollDevice(apiBaseUrl: string, deviceCode: string): Promise<DevicePoll> {
	let response: Response;

	try {
		response = await fetch(`${apiBaseUrl}/auth/cli/device/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ deviceCode }),
		});
	} catch {
		return { state: "pending" };
	}

	if (response.ok) {
		const body = (await response.json()) as {
			token: string;
			name: string;
			email: string | null;
		};

		return { state: "granted", token: { token: body.token, name: body.name, email: body.email } };
	}

	const problem = (await response.json().catch(() => null)) as {
		type?: string;
		detail?: string;
	} | null;

	// Branching on the stable code rather than on the message, which is the contract these codes exist for
	// — see `Errors.AuthorizationPending`. A client matching on wording breaks the moment it is rephrased.
	if (problem?.type === "authorization_pending") return { state: "pending" };
	if (problem?.type === "slow_down") return { state: "slow_down" };

	return {
		state: "dead",
		message: problem?.detail ?? `The API answered ${response.status}.`,
	};
}

/**
 * Reads the API's own wording out of a failed response.
 *
 * @param response The failed response.
 * @returns The `detail` the API sent, or a sentence naming the status.
 */
async function problemDetail(response: Response): Promise<string> {
	const problem = (await response.json().catch(() => null)) as { detail?: string } | null;

	return problem?.detail ?? `The API answered ${response.status}.`;
}

/** What the exchange endpoint answers with. */
export interface ExchangedToken {
	/** The plaintext token. */
	readonly token: string;
	/** What the token is called. */
	readonly name: string;
	/** The account's address, so the command can say who it signed in as. */
	readonly email: string | null;
}

/**
 * Exchanges the code and the verifier for a token.
 *
 * @param apiBaseUrl Base URL of the API.
 * @param code The code the browser delivered.
 * @param verifier The verifier this process kept.
 * @returns The token and who it belongs to.
 * @throws Error carrying the API's own `detail` where it sent one, since that text is written to be read.
 */
export async function exchange(
	apiBaseUrl: string,
	code: string,
	verifier: string,
): Promise<ExchangedToken> {
	const response = await fetch(`${apiBaseUrl}/auth/cli/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, verifier }),
	});

	if (!response.ok) throw new Error(await problemDetail(response));

	const body = (await response.json()) as { token: string; name: string; email: string | null };

	return { token: body.token, name: body.name, email: body.email };
}
