import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";

/**
 * What the command line does with what it was typed.
 *
 * Every command returns text, JSON and an exit code rather than printing, which is what lets these run
 * without a subprocess — and, more usefully, what stops `--json` from being a second implementation of
 * each command that could disagree with the first.
 *
 * The exit codes are asserted as carefully as the text. A CLI whose failures exit 0 is a CLI that cannot
 * be used in CI, and that is the whole point of shipping one.
 */

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.DROP2RUN_TOKEN;
});

describe("with no arguments", () => {
	it("prints help and fails, because being run with nothing is a mistake", async () => {
		const result = await run([]);

		expect(result.text).toContain("drop2run deploy");
		expect(result.code).toBe(1);
	});
});

describe("--help", () => {
	it("prints help and succeeds, because asking for it is not a mistake", async () => {
		const result = await run(["--help"]);

		expect(result.text).toContain("drop2run deploy");
		expect(result.code).toBe(0);
	});

	it("says how to get a token, since there is no login yet", async () => {
		const result = await run(["--help"]);

		expect(result.text).toContain("account/tokens");
		expect(result.text).toContain("DROP2RUN_TOKEN");
	});
});

describe("--version", () => {
	it("reports what the manifest says, so the two cannot disagree", async () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };

		expect((await run(["--version"])).text).toBe(manifest.version);
	});
});

describe("an unknown command", () => {
	it("names it, prints help, and fails", async () => {
		const result = await run(["frobnicate"]);

		expect(result.text).toContain('Unknown command "frobnicate"');
		expect(result.text).toContain("drop2run deploy");
		expect(result.code).toBe(1);
	});
});

describe("without a token", () => {
	it("explains how to get one rather than reporting a network error", async () => {
		const result = await run(["ls"]);

		expect(result.text).toContain("account/tokens");
		expect(result.code).toBe(1);
	});

	it("says so in --json too, on the same exit code", async () => {
		const result = await run(["ls", "--json"]);

		expect(JSON.parse(result.text)).toHaveProperty("error");
		expect(result.code).toBe(1);
	});
});

describe("whoami", () => {
	it("asks the API rather than reading the file, so it answers the question actually asked", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				seen.push(String(input));
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer d2r_test");

				return Response.json({ email: "person@example.com", plan: { name: "Free" } });
			}),
		);

		const result = await run(["whoami"]);

		expect(seen.some((url) => url.endsWith("/me"))).toBe(true);
		expect(result.text).toContain("person@example.com");
		expect(result.text).toContain("Free");
		expect(result.code).toBe(0);
	});

	it("reports a revoked token as a token problem, not as a server error", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 401 })),
		);

		const result = await run(["whoami"]);

		expect(result.text).toContain("not valid any more");
		expect(result.code).toBe(1);
	});
});

describe("ls", () => {
	it("lists one site per line, tab separated, so it pipes into cut", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					sites: [
						{
							siteId: "01J",
							subdomain: "alpha",
							url: "https://alpha.dropto.live",
							name: "Alpha",
						},
					],
				}),
			),
		);

		expect((await run(["ls"])).text).toBe("alpha\thttps://alpha.dropto.live\tAlpha");
	});

	it("says there are none rather than printing an empty answer", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ sites: [] })),
		);

		const result = await run(["ls"]);

		expect(result.text).toContain("No sites yet");
		expect(result.code).toBe(0);
	});
});

describe("where", () => {
	it("names the environment when the token came from there", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";

		expect((await run(["where"])).text).toContain("DROP2RUN_TOKEN");
	});

	it("never prints the token itself, because CLI output ends up in issue reports", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_the_actual_secret";

		const result = await run(["where"]);

		expect(result.text).not.toContain("d2r_the_actual_secret");
		expect(JSON.stringify(result.json)).not.toContain("d2r_the_actual_secret");
	});
});

describe("--site", () => {
	it("is ignored when it has no value, rather than swallowing the next flag", async () => {
		// `deploy --site --json` used to read "--json" as the site name. The result was a publish to a
		// site called --json, which fails with a confusing message about a site that does not exist.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				seen.push(`${init?.method ?? "GET"} ${String(input)}`);

				return Response.json({
					siteId: "01JNEW",
					subdomain: "new-site",
					url: "https://new-site.dropto.live",
				});
			}),
		);

		await run(["deploy", "--site", "--json"]);

		// A new site was created, which is what "no site named" means — rather than a lookup for "--json".
		expect(seen.some((request) => request.startsWith("POST"))).toBe(true);
	});
});
