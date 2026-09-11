import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, saveToken } from "@drop2run/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPendingSignIns, signInWithBrowser, signInWithCode } from "../src/auth.js";

/**
 * Signing in from a tool call, in the parts that decide whether somebody can get a token at all.
 *
 * <b>What is worth asserting here.</b> Not that PKCE works — `packages/node/test/login.test.ts` owns
 * that, and the API's `CliSignInTests` owns the half that issues anything. What is new here is the
 * shape a chat forces: one request and one answer, so a sign-in spans calls, and the properties that
 * makes load-bearing are
 *
 * 1. a call that has not been approved yet answers and keeps the attempt, rather than failing,
 * 2. the consent URL is the same across those calls, since somebody is looking at the first one,
 * 3. the long device code never appears in anything returned to the model,
 * 4. a token already stored is not silently replaced by a second one.
 *
 * <b>No browser opens.</b> The launcher is injected, because a suite that opened a real tab at
 * dropto.run on every run would be a test nobody could run twice in a row.
 */

/** HOME, redirected per test so nothing here can read or overwrite a developer's real token. */
let realHome: string | undefined;

/** DROP2RUN_API_URL, restored per test: the stubbed API has to be the one these calls reach. */
let realApiUrl: string | undefined;

/** DROP2RUN_TOKEN, cleared per test — set in a real environment, it outranks the file and hides it. */
let realToken: string | undefined;

/** The API these tests pretend to talk to. */
const API = "https://api.test/api";

beforeEach(() => {
	realHome = process.env.HOME;
	realApiUrl = process.env.DROP2RUN_API_URL;
	realToken = process.env.DROP2RUN_TOKEN;

	process.env.HOME = mkdtempSync(join(tmpdir(), "drop2run-auth-home-"));
	process.env.DROP2RUN_API_URL = API;
	delete process.env.DROP2RUN_TOKEN;
});

afterEach(() => {
	// Module state, so a half-finished sign-in from one test would otherwise be resumed by the next and
	// asserted against a port that test never opened.
	resetPendingSignIns();
	vi.unstubAllGlobals();

	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realApiUrl === undefined) delete process.env.DROP2RUN_API_URL;
	else process.env.DROP2RUN_API_URL = realApiUrl;
	if (realToken === undefined) delete process.env.DROP2RUN_TOKEN;
	else process.env.DROP2RUN_TOKEN = realToken;
});

/** A launcher that reports the browser opened, without opening one. */
const opened = (): boolean => true;

/** A launcher that reports it could not open one, which is the container case. */
const notOpened = (): boolean => false;

describe("the browser sign-in", () => {
	it("returns the URL instead of waiting when no browser could be opened", async () => {
		// Waiting on a URL nobody has been shown is the one behaviour that guarantees nothing happens.
		const answer = await signInWithBrowser(1, false, notOpened);

		expect(answer).toContain(`${new URL(API).origin}/cli-auth`);
		expect(answer).toContain("call this tool again");
	});

	it("keeps the same URL across calls, because somebody is looking at the first one", async () => {
		const first = await signInWithBrowser(1, false, notOpened);
		const second = await signInWithBrowser(1, false, opened);

		const url = (text: string): string => (text.match(/https:\/\/\S*cli-auth\S*/) ?? [""])[0];

		expect(url(first)).not.toBe("");
		expect(url(second)).toBe(url(first));
	});

	it("answers rather than failing while nobody has approved it", async () => {
		const answer = await signInWithBrowser(1, false, opened);

		expect(answer).toContain("Not approved yet");
		expect(answer).toContain("Nothing has been changed");
	});

	it("never puts the verifier in the URL it hands out", async () => {
		// The one value that must not travel through a browser, or through a transcript.
		const answer = await signInWithBrowser(1, false, notOpened);
		const url = new URL((answer.match(/https:\/\/\S*cli-auth\S*/) ?? [""])[0]);

		expect(url.searchParams.get("challenge")).not.toBeNull();
		expect([...url.searchParams.keys()]).not.toContain("verifier");
	});

	it("names the machine and the surface, so two tokens can be told apart", async () => {
		const answer = await signInWithBrowser(1, false, notOpened);
		const url = new URL((answer.match(/https:\/\/\S*cli-auth\S*/) ?? [""])[0]);

		expect(url.searchParams.get("name")).toMatch(/-mcp$/);
	});

	it("leaves a stored token alone unless asked to replace it", async () => {
		saveToken("d2r_existing");

		const answer = await signInWithBrowser(1, false, notOpened);

		expect(answer).toContain("Already signed in");
		// No attempt was started, so nothing was handed out to approve.
		expect(answer).not.toContain("cli-auth");
	});
});

describe("the code sign-in", () => {
	/**
	 * Stubs the device endpoints.
	 *
	 * @param token What the token endpoint answers with once it is asked.
	 * @returns The URLs that were called.
	 */
	function stubDevice(token: () => Response): string[] {
		const calls: string[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				calls.push(url);

				if (url.endsWith("/auth/cli/device")) {
					return Response.json({
						deviceCode: "d2d_the_long_one_that_collects_the_token",
						userCode: "H7KD-9MXQ",
						verificationUri: "https://dropto.run/device",
						verificationUriComplete: "https://dropto.run/device?code=H7KD-9MXQ",
						intervalSeconds: 0,
					});
				}

				return token();
			}),
		);

		return calls;
	}

	it("answers the first call with the short code and nothing that collects a token", async () => {
		stubDevice(() => Response.json({}));

		const answer = await signInWithCode(1, false);

		expect(answer).toContain("H7KD-9MXQ");
		expect(answer).toContain("https://dropto.run/device");
		// The long code is what exchanges for the token. It stays in this process; a transcript that
		// carried it would be a credential in a chat log.
		expect(answer).not.toContain("d2d_the_long_one_that_collects_the_token");
	});

	it("stores the token on the call that finds it approved", async () => {
		stubDevice(() =>
			Response.json({ token: "d2r_granted", name: "box-mcp", email: "someone@example.com" }),
		);

		await signInWithCode(1, false);
		const answer = await signInWithCode(2, false);

		expect(answer).toContain("Signed in as someone@example.com");
		expect(JSON.parse(readFileSync(configPath(), "utf8")).token).toBe("d2r_granted");
	});

	it("gives up on a refusal rather than polling a dead request", async () => {
		// Pending and refused both come back as a failed status. A client that read them the same way
		// would keep polling after somebody pressed Refuse, leaving a chat that never finishes.
		stubDevice(() =>
			Response.json({ type: "access_denied", detail: "The sign-in was refused." }, { status: 400 }),
		);

		await signInWithCode(1, false);

		await expect(signInWithCode(2, false)).rejects.toThrow("The sign-in was refused.");
	});

	it("says the environment still wins when a token is set there", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_from_the_environment";
		stubDevice(() => Response.json({ token: "d2r_granted", name: "box-mcp", email: null }));

		// `replace` because the environment token counts as being signed in already.
		await signInWithCode(1, true);
		const answer = await signInWithCode(2, true);

		expect(answer).toContain("Signed in");
		expect(answer).toContain("DROP2RUN_TOKEN");
		expect(answer).toContain("still the one in force");
	});
});
