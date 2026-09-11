import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clientName,
	consentUrl,
	exchange,
	listen,
	newAttempt,
	pollDevice,
	startDevice,
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

	it("appends the surface, so two tokens from one machine can be told apart", () => {
		// Both surfaces sign in now. A tokens page listing the same hostname twice cannot answer the only
		// question somebody is there to ask, which is which of the two to revoke.
		const withSurface = clientName("mcp");

		expect(withSurface.endsWith("-mcp")).toBe(true);
		expect(clientName().startsWith(withSurface.slice(0, -4))).toBe(true);
	});

	it("keeps the surface when the hostname is long enough to be cut", () => {
		// The suffix is the half that identifies what is asking, so the hostname is what gives way.
		const name = clientName("a".repeat(20));

		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toContain(`-${"a".repeat(16)}`);
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

/**
 * Builds a problem response the way the API does.
 *
 * @param type Stable error code.
 * @param detail Wording for whoever asked.
 * @returns A 400 carrying both.
 */
function problem(type: string, detail = "…"): Response {
	return new Response(JSON.stringify({ type, detail }), {
		status: 400,
		headers: { "Content-Type": "application/problem+json" },
	});
}

describe("pollDevice", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads pending and slow_down as two different instructions", async () => {
		// The distinction the codes exist for: both mean keep waiting, and only one means slow down. A
		// client that could not tell them apart would have no way to learn it is the problem.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => problem("authorization_pending")),
		);
		expect((await pollDevice("https://dropto.run/api", "d2d_x")).state).toBe("pending");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => problem("slow_down")),
		);
		expect((await pollDevice("https://dropto.run/api", "d2d_x")).state).toBe("slow_down");
	});

	it("treats a refusal as over rather than as pending", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => problem("invalid_grant", "Whoever was asked declined it.")),
		);

		const poll = await pollDevice("https://dropto.run/api", "d2d_x");

		// If this read as pending, pressing Refuse would leave the far-away terminal polling a dead
		// request until it expired — the failure hardest to explain to whoever pressed it.
		expect(poll.state).toBe("dead");
		expect(poll.state === "dead" && poll.message).toMatch(/declined/);
	});

	it("returns the token once it is granted", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ token: "d2r_new", name: "ssh-box", email: "who@example.test" }),
			),
		);

		expect(await pollDevice("https://dropto.run/api", "d2d_x")).toEqual({
			state: "granted",
			token: { token: "d2r_new", name: "ssh-box", email: "who@example.test" },
		});
	});

	it("treats a dropped connection as pending, not as a refusal", async () => {
		// A laptop that lost its wifi for a moment has not had its sign-in refused, and a flow expected to
		// last minutes must not give up on one failed request.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		expect((await pollDevice("https://dropto.run/api", "d2d_x")).state).toBe("pending");
	});

	it("branches on the code rather than on the wording", async () => {
		// The same situation described differently: a client matching on prose would break the next time
		// somebody rephrased a message.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => problem("authorization_pending", "Nobody has got round to it.")),
		);

		expect((await pollDevice("https://dropto.run/api", "d2d_x")).state).toBe("pending");
	});
});

describe("startDevice", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the client name and returns both codes", async () => {
		const seen: { url: string; body: Record<string, unknown> } = { url: "", body: {} };

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				seen.url = String(input);
				seen.body = JSON.parse(String(init?.body));

				return Response.json({
					deviceCode: "d2d_long",
					userCode: "H7KD-9MXQ",
					verificationUri: "https://dropto.run/device",
					verificationUriComplete: "https://dropto.run/device?code=H7KD-9MXQ",
					intervalSeconds: 5,
				});
			}),
		);

		const request = await startDevice("https://dropto.run/api", "ssh-box");

		expect(seen.url).toBe("https://dropto.run/api/auth/cli/device");
		expect(seen.body).toEqual({ clientName: "ssh-box" });
		expect(request.deviceCode).toBe("d2d_long");
		expect(request.userCode).toBe("H7KD-9MXQ");
	});
});
