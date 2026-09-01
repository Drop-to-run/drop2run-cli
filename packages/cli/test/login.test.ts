import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clientName,
	consentUrl,
	exchange,
	listen,
	newAttempt,
	waitForCallback,
} from "../src/login.js";

/**
 * The loopback sign-in, in the parts that can be checked without a browser.
 *
 * What is worth asserting here is not that the flow works — that needs a browser and a server, and the
 * API's own `CliSignInTests` covers the half that decides anything. It is the four properties that make it
 * safe, each of which is one careless edit away from being lost:
 *
 * 1. the verifier never appears in the URL that goes to the browser,
 * 2. the challenge really is `S256` of the verifier, and not the verifier itself,
 * 3. a callback carrying the wrong `state` is refused rather than accepted,
 * 4. the listener is on loopback, so nothing off this machine can deliver a code.
 */

describe("newAttempt", () => {
	it("derives the challenge as S256 of the verifier, which is the whole of PKCE here", () => {
		const attempt = newAttempt();

		expect(attempt.challenge).toBe(
			createHash("sha256").update(attempt.verifier).digest("base64url"),
		);
	});

	it("produces a verifier the API will accept the length of", () => {
		// 43 characters, which is what base64url of 32 bytes comes to and what the server's challenge
		// length check is derived from. A shorter verifier is refused by the request contract.
		expect(newAttempt().verifier).toHaveLength(43);
	});

	it("never repeats, so two sign-ins cannot be confused for one another", () => {
		const first = newAttempt();
		const second = newAttempt();

		expect(first.verifier).not.toBe(second.verifier);
		expect(first.state).not.toBe(second.state);
	});
});

describe("consentUrl", () => {
	it("carries the challenge, the state, the port and the name", () => {
		const attempt = newAttempt();
		const url = new URL(consentUrl("https://dropto.run", attempt, 51234, "laptop"));

		expect(url.pathname).toBe("/cli-auth");
		expect(url.searchParams.get("challenge")).toBe(attempt.challenge);
		expect(url.searchParams.get("state")).toBe(attempt.state);
		expect(url.searchParams.get("port")).toBe("51234");
		expect(url.searchParams.get("name")).toBe("laptop");
	});

	it("never carries the verifier, which is the one value the browser must not see", () => {
		const attempt = newAttempt();
		const url = consentUrl("https://dropto.run", attempt, 51234, "laptop");

		// The assertion the whole exchange rests on: a code read out of browser history, a proxy log or
		// somebody's screen is worth nothing as long as this stays true.
		expect(url).not.toContain(attempt.verifier);
	});

	it("follows the API base URL, so a local sign-in does not open production", () => {
		const url = consentUrl("http://localhost:8001", newAttempt(), 51234, "laptop");

		expect(url.startsWith("http://localhost:8001/cli-auth")).toBe(true);
	});
});

describe("clientName", () => {
	it("is never empty and never longer than the server allows", () => {
		const name = clientName();

		expect(name.length).toBeGreaterThan(0);
		expect(name.length).toBeLessThanOrEqual(64);
	});

	it("contains nothing that would need escaping where it is rendered", () => {
		expect(clientName()).toMatch(/^[A-Za-z0-9._-]+$/);
	});
});

describe("the loopback listener", () => {
	it("listens on 127.0.0.1 and hands over a code that carries the right state", async () => {
		const attempt = newAttempt();
		const listener = await listen(attempt.state);

		try {
			// Addressed to 127.0.0.1 explicitly rather than to localhost: a listener bound to every
			// interface would answer this too, and the point is that it is not.
			const response = await fetch(
				`http://127.0.0.1:${listener.port}/cb?code=d2c_test&state=${encodeURIComponent(attempt.state)}`,
			);

			expect(response.status).toBe(200);
			expect(await listener.received).toEqual({ code: "d2c_test" });
		} finally {
			listener.close();
		}
	});

	it("refuses a callback whose state does not match, rather than taking the code", async () => {
		const attempt = newAttempt();
		const listener = await listen(attempt.state);

		try {
			// The expectation is attached before the request is made, not after. The listener rejects while
			// handling it, and a rejection with nothing yet awaiting it is an unhandled rejection — which
			// fails the run for a reason that has nothing to do with the behaviour under test.
			const refused = expect(listener.received).rejects.toThrow(/did not match/);
			const response = await fetch(
				`http://127.0.0.1:${listener.port}/cb?code=d2c_test&state=wrong`,
			);

			expect(response.status).toBe(400);
			// The promise rejects, so the command fails rather than signing in with a code something else
			// on this machine chose.
			await refused;
		} finally {
			listener.close();
		}
	});

	it("refuses a callback with no code at all", async () => {
		const attempt = newAttempt();
		const listener = await listen(attempt.state);

		try {
			const refused = expect(listener.received).rejects.toThrow();
			const response = await fetch(
				`http://127.0.0.1:${listener.port}/cb?state=${encodeURIComponent(attempt.state)}`,
			);

			expect(response.status).toBe(400);
			await refused;
		} finally {
			listener.close();
		}
	});

	it("answers anything but the callback path with a 404", async () => {
		const listener = await listen(newAttempt().state);

		try {
			expect((await fetch(`http://127.0.0.1:${listener.port}/`)).status).toBe(404);
		} finally {
			listener.close();
		}
	});
});

describe("waitForCallback", () => {
	it("gives up rather than hanging, so a closed tab does not wedge a CI job", async () => {
		const never = new Promise<never>(() => {});

		await expect(waitForCallback(never, 10)).rejects.toThrow(/Timed out/);
	});
});

describe("exchange", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts the code and the verifier to the exchange endpoint", async () => {
		// Declared as a mutable pair rather than a nullable one: assigned inside the stub, TypeScript
		// narrows the outer variable to `null` and every read of it becomes an error on `never`.
		const seen: { url: string; body: Record<string, unknown> } = { url: "", body: {} };

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				seen.url = String(input);
				seen.body = JSON.parse(String(init?.body));

				return Response.json({ token: "d2r_new", name: "laptop", email: "who@example.test" });
			}),
		);

		const issued = await exchange("https://dropto.run/api", "d2c_code", "the-verifier");

		expect(issued).toEqual({ token: "d2r_new", name: "laptop", email: "who@example.test" });
		expect(seen.url).toBe("https://dropto.run/api/auth/cli/token");
		expect(seen.body).toEqual({ code: "d2c_code", verifier: "the-verifier" });
	});

	it("reports the API's own wording, which is written to be read by whoever asked", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							type: "invalid_grant",
							detail: "That sign-in code is not valid any more. Run the sign-in again.",
						}),
						{ status: 400, headers: { "Content-Type": "application/problem+json" } },
					),
			),
		);

		await expect(exchange("https://dropto.run/api", "d2c_code", "v")).rejects.toThrow(
			/not valid any more/,
		);
	});

	it("falls back to the status when the body is not a problem document", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("gateway blew up", { status: 502 })),
		);

		await expect(exchange("https://dropto.run/api", "d2c_code", "v")).rejects.toThrow(/502/);
	});
});
