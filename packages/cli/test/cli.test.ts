import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * HOME, redirected for every test in this file.
 *
 * <b>Not tidiness — isolation these tests turned out not to have.</b> `loadCredentials` falls back to
 * `~/.config/drop2run/config.json`, so "without a token" meant "without a token *and* on a machine
 * where nobody has ever signed in". The moment somebody signed in, two tests began reading a real
 * credential and calling production with it: the suite went red with `This access token is not valid`,
 * which is an answer from dropto.run, not from a stub.
 *
 * A test must not be able to read a developer's credential, and must not be able to reach the network
 * by accident. `os.homedir()` reads HOME on this platform, which is what makes one line enough.
 */
let realHome: string | undefined;

beforeEach(() => {
	realHome = process.env.HOME;
	process.env.HOME = mkdtempSync(join(tmpdir(), "drop2run-cli-home-"));
});

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;

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

	it("lists all three ways to sign in, since each covers a case the others cannot", async () => {
		const result = await run(["--help"]);

		// Three, not one: loopback for a developer's own machine, `--device` for a remote shell, and a
		// hand-made token for CI. Help that named only the first would leave somebody over SSH stuck.
		expect(result.text).toContain("drop2run login");
		expect(result.text).toContain("--device");
		expect(result.text).toContain("account/tokens");
		expect(result.text).toContain("DROP2RUN_TOKEN");
	});
});

describe("rm", () => {
	it("refuses without --yes, and names what it would have deleted", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					sites: [
						{
							siteId: "01J",
							subdomain: "calm-cedar",
							url: "https://calm-cedar.dropto.live",
							name: null,
						},
					],
				}),
			),
		);

		const result = await run(["rm", "calm-cedar"]);

		// The refusal has to carry the name: `--yes` is the confirmation, and a confirmation typed before
		// seeing what it confirms is not one.
		expect(result.text).toContain("calm-cedar");
		expect(result.text).toContain("--yes");
		expect(result.code).toBe(1);
	});

	it("deletes when told twice", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				seen.push(`${init?.method ?? "GET"} ${String(input)}`);

				return String(input).endsWith("/sites")
					? Response.json({
							sites: [
								{
									siteId: "01J",
									subdomain: "calm-cedar",
									url: "https://calm-cedar.dropto.live",
									name: null,
								},
							],
						})
					: new Response(null, { status: 204 });
			}),
		);

		const result = await run(["rm", "calm-cedar", "--yes"]);

		expect(result.code).toBe(0);
		expect(seen).toContain("DELETE https://dropto.run/api/sites/01J");
	});

	it("refuses a site that is not the caller's, rather than deleting a different one", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ sites: [] })),
		);

		const result = await run(["rm", "somebody-elses", "--yes"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("somebody-elses");
	});
});

describe("token", () => {
	it("lists tokens without ever printing a secret", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					tokens: [
						{
							id: "01J",
							name: "laptop",
							prefix: "d2r_ABCDEFGH",
							createdAt: "2026-09-01T10:00:00Z",
							lastUsedAt: null,
							expiresAt: null,
							revokedAt: null,
						},
					],
				}),
			),
		);

		const result = await run(["token", "list"]);

		expect(result.text).toContain("laptop");
		// "never used" is the fact the listing exists for: it is what says which token is safe to revoke.
		expect(result.text).toContain("never used");
		expect(result.code).toBe(0);
	});

	it("refuses `token revoke` instead of quietly listing", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";

		const result = await run(["token", "revoke"]);

		// Somebody will type this. Listing instead would read as having worked, and they would go away
		// believing a token was revoked.
		expect(result.code).toBe(1);
		expect(result.text).toContain("account/tokens");
	});
});

describe("logout", () => {
	it("says the environment variable is still in force, rather than claiming a clean sign-out", async () => {
		// Safe to let this write, because HOME is a fresh temporary directory for every test in this file
		// — see the note above `beforeEach`. Against a real home directory this test would delete the
		// developer's own token.
		process.env.DROP2RUN_TOKEN = "d2r_test";

		const result = await run(["logout"]);

		// The file is what `logout` can remove; the variable outranks it. Reporting success while every
		// later command keeps using the same account is the one answer this must never give.
		expect(result.text).toContain("DROP2RUN_TOKEN");
		expect(result.code).toBe(0);
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
