import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { set } from "../src/commands.js";
import { HiddenLine, readSecret } from "../src/secret.js";

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

				// By path, because the lookup now searches (`/sites?q=…`) rather than reading the bare listing.
				return new URL(String(input)).pathname === "/api/sites"
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

	it("reports a token the API does not know as a token problem, not a crash", async () => {
		// Production answers `/me` with 204 and no body for nobody signed in, which is what a token it
		// does not accept turns into. This used to reach `response.json()` and print a stack trace.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 204 })),
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

	it("asks for the whole listing in one request, not the API's default page of 25", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				urls.push(String(input));

				return Response.json({ sites: [], total: 0 });
			}),
		);

		await run(["ls"]);

		expect(urls).toEqual(["https://dropto.run/api/sites?pageSize=100"]);
	});

	it("says how many it left out past the ceiling, rather than passing a short list off as all", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					sites: [
						{ siteId: "01J", subdomain: "alpha", url: "https://alpha.dropto.live", name: null },
					],
					total: 101,
				}),
			),
		);

		const result = await run(["ls"]);

		expect(result.text.split("\n").at(-1)).toContain("100 more");
		expect(result.code).toBe(0);
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

describe("--subdomain", () => {
	/**
	 * The working directory, redirected for this group.
	 *
	 * <b>`init` writes a file into the folder it is run in.</b> Left alone, the first test here wrote a
	 * `drop2run.json` into `packages/cli` — untracked, easy to commit by accident, and picked up by every
	 * later test in the run, which is how the last one failed with "this folder already has a
	 * drop2run.json" instead of the API's refusal. A command that writes needs somewhere disposable to
	 * write to, the same way the rest of this file needed a HOME of its own.
	 */
	let realCwd: string;

	beforeEach(() => {
		realCwd = process.cwd();
		process.chdir(mkdtempSync(join(tmpdir(), "drop2run-cli-project-")));
	});

	afterEach(() => {
		process.chdir(realCwd);
	});

	it("asks the API for the name that was typed, rather than letting it generate one", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				if (String(input).endsWith("/sites") && init?.method === "POST") {
					bodies.push(String(init.body));
				}

				return Response.json({
					siteId: "01JNEW",
					subdomain: "my-docs",
					url: "https://my-docs.dropto.live",
				});
			}),
		);

		await run(["init", "dist", "--subdomain", "my-docs"]);

		expect(bodies).toEqual(['{"subdomain":"my-docs"}']);
	});

	it("refuses a flag with nothing after it, which would otherwise generate a name in silence", async () => {
		// The failure this rules out is the quiet one. `--subdomain` with no value parses as undefined,
		// which is indistinguishable from never having passed it — so somebody who typed the flag
		// precisely to avoid a generated name would get one anyway, plus a site to delete afterwards.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["deploy", "dist", "--subdomain"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("--subdomain");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("refuses to be given with --site, since one wants a site to exist and the other wants it not to", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["deploy", "--site", "calm-cedar", "--subdomain", "my-docs"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("--site");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("refuses on a command that cannot create a site, rather than ignoring it", async () => {
		// `rm --subdomain x` reads as naming a site. Ignoring the flag would delete whatever the project
		// file points at instead, report success, and leave the name that was typed untouched.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["rm", "--subdomain", "my-docs", "--yes"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("init");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("carries the API's own refusal, since only the server knows which rule a name broke", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ detail: "That name is already taken" }, { status: 400 })),
		);

		const result = await run(["init", "dist", "--subdomain", "taken-name"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("already taken");
	});
});

describe("--folder", () => {
	/** The working directory, redirected for the same reason as in the `--subdomain` group. */
	let realCwd: string;

	beforeEach(() => {
		realCwd = process.cwd();
		process.chdir(mkdtempSync(join(tmpdir(), "drop2run-cli-project-")));
	});

	afterEach(() => {
		process.chdir(realCwd);
	});

	/** `Clients` with `Acme` inside it, as `GET /site-folders` sends them. */
	const tree = [
		{ folderId: "01JCLIENTS", parentId: null, name: "Clients" },
		{ folderId: "01JACME", parentId: "01JCLIENTS", name: "Acme" },
	];

	/**
	 * Answers the folder listing and site creation, recording what creation was sent.
	 *
	 * @returns The bodies of every `POST /sites`.
	 */
	function stubFolders(): string[] {
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);

				if (url.endsWith("/site-folders")) {
					return Response.json({ folders: tree, maxFolders: 500, maxDepth: 5 });
				}

				if (url.endsWith("/sites") && init?.method === "POST") bodies.push(String(init.body));

				return Response.json({
					siteId: "01JNEW",
					subdomain: "calm-cedar",
					url: "https://calm-cedar.dropto.live",
				});
			}),
		);

		return bodies;
	}

	it("files the site `init` creates in the folder the path names", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const bodies = stubFolders();

		const result = await run(["init", "dist", "--folder", "Clients/Acme"]);

		expect(result.code).toBe(0);
		expect(bodies).toEqual(['{"folderId":"01JACME"}']);
	});

	it("is not read as the folder to publish", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		stubFolders();

		await run(["init", "--folder", "Clients", "--json"]);

		expect(JSON.parse(readFileSync("drop2run.json", "utf8")).dir).toBe(".");
	});

	it("creates no site for a folder that does not exist, and names the ones that do", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const bodies = stubFolders();

		const result = await run(["init", "dist", "--folder", "Clients/Acmee"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("Clients/Acme");
		expect(bodies).toEqual([]);
	});

	it("refuses to be given with --site, since it only files a site being created", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["deploy", "--site", "calm-cedar", "--folder", "Clients"]);

		// Names the command that does move a site, which the dashboard used to be the only way to.
		expect(result.code).toBe(1);
		expect(result.text).toContain("drop2run set folder");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("refuses a flag with nothing after it, rather than filing the site at the top level", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["deploy", "dist", "--folder"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("--folder Clients/Acme");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("refuses on a command that cannot create a site, rather than ignoring it", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["ls", "--folder", "Clients"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("drop2run folders");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("refuses in a project that already publishes somewhere, rather than making a second site", async () => {
		// `deploy --folder Clients` next to a drop2run.json reads as "move my site into Clients" as
		// easily as "make a new one there". Guessing the second leaves the real site where it was and
		// the person looking at a URL they did not expect.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		writeFileSync(
			"drop2run.json",
			JSON.stringify({ siteId: "01JOLD", subdomain: "old-site", dir: "." }),
		);
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["deploy", "--folder", "Clients"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("old-site");
		expect(fetched).not.toHaveBeenCalled();
	});
});

describe("folders", () => {
	it("prints one path per line with its id, so a line pastes straight after --folder", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					folders: [
						{ folderId: "01JCLIENTS", parentId: null, name: "Clients" },
						{ folderId: "01JACME", parentId: "01JCLIENTS", name: "Acme" },
					],
					maxFolders: 500,
					maxDepth: 5,
				}),
			),
		);

		const result = await run(["folders"]);

		expect(result.code).toBe(0);
		expect(result.text).toBe("Clients\t01JCLIENTS\nClients/Acme\t01JACME");
	});

	it("says there are none and where to make one, rather than printing an empty answer", async () => {
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ folders: [], maxFolders: 500, maxDepth: 5 })),
		);

		const result = await run(["folders"]);

		expect(result.code).toBe(0);
		expect(result.text).toContain("No folders yet");
	});
});

describe("a flag's value", () => {
	/** A folder to publish, so a deploy that reads the right one has something to read. */
	let folder: string;
	let realCwd: string;

	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), "drop2run-cli-site-"));
		writeFileSync(join(folder, "index.html"), "<!doctype html><title>Page</title>");
		realCwd = process.cwd();
		process.chdir(folder);
	});

	afterEach(() => {
		process.chdir(realCwd);
	});

	it("is not read as the folder to publish", async () => {
		// Reported from a real terminal: `deploy --subdomain test11223355` answered "no such file or
		// directory … /test11223355". The parser kept every word that did not start with a dash, so the
		// name of the site became the name of the directory. `--site` had the same defect and had it
		// first; it hid because every example in the documentation names the folder before the flag.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const paths: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				paths.push(url);

				if (url.endsWith("/sites") && init?.method === "POST") {
					return Response.json({
						siteId: "01JNEW",
						subdomain: "my-docs",
						url: "https://my-docs.dropto.live",
					});
				}

				if (url.includes("/deploys/prepare")) {
					return Response.json({
						deployId: "01JDEPLOY",
						total: 1,
						reused: 0,
						upload: [{ path: "index.html", token: "permit", sha256: "x".repeat(64) }],
						uploadUrl: "https://storage.test/v1/object",
					});
				}

				if (url.startsWith("https://storage.test/")) return new Response(null, { status: 200 });

				return Response.json({ url: "https://my-docs.dropto.live", name: "Page" });
			}),
		);

		// `--json` here only to keep the progress writer off this suite's output; the parsing under test
		// happens before either branch.
		const result = await run(["deploy", "--subdomain", "my-docs", "--json"]);

		// It published the working directory, which is what `deploy` with no folder has always meant.
		expect(result.code).toBe(0);
		expect(result.text).toContain("my-docs.dropto.live");
	});
});

describe("a folder that is not there", () => {
	it("is refused before a site is created for it", async () => {
		// The order used to be the other way round, and the cost was permanent: the site was made, the
		// read then failed, and the subdomain that had been asked for was held by an empty site. Trying
		// again with the same name answered "already taken" — by the wreckage of the first attempt.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["deploy", "/tmp/drop2run-no-such-folder", "--subdomain", "my-docs"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("drop2run-no-such-folder");
		expect(fetched).not.toHaveBeenCalled();
	});
});

/**
 * Answers the API calls the settings commands make, recording each one as `METHOD path body`.
 *
 * The settings and pause responses carry the API's own enum spelling (`Pause`, `Paused`), which is what
 * the lowercasing in `@drop2run/node` exists for.
 *
 * @param seen Collects the requests.
 * @returns The fetch stub.
 */
function settingsApi(seen: string[]) {
	process.env.DROP2RUN_TOKEN = "d2r_test";

	return vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push(`${init?.method ?? "GET"} ${url.pathname} ${init?.body ?? ""}`.trim());

		if (url.pathname === "/api/sites") {
			return Response.json({
				sites: [
					{
						siteId: "01J",
						subdomain: "calm-cedar",
						url: "https://calm-cedar.dropto.live",
						name: null,
					},
				],
			});
		}

		if (url.pathname.endsWith("/pause")) {
			return Response.json({
				siteId: "01J",
				subdomain: "calm-cedar",
				status: "Paused",
				ownerPaused: true,
				statusChangedAt: null,
			});
		}

		return Response.json({
			siteId: "01J",
			name: null,
			spaMode: false,
			docsMode: false,
			live: true,
			passwordProtected: false,
			expiresAt: null,
			expiryAction: "Pause",
			formsEnabled: false,
			folderId: null,
		});
	});
}

/**
 * The PATCH a command sent, if any.
 *
 * @param seen What the stub recorded.
 * @returns The PATCH line, or undefined.
 */
function patchOf(seen: readonly string[]): string | undefined {
	return seen.find((call) => call.startsWith("PATCH"));
}

describe("set", () => {
	it("sends both mode switches, so switching mode can never leave two on", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await run(["set", "mode", "spa", "--site", "calm-cedar"]);

		expect(result.code).toBe(0);
		expect(patchOf(seen)).toBe('PATCH /api/sites/01J {"spaMode":true,"docsMode":false}');
	});

	it("takes a name of several words without quotes", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		await run(["set", "name", "Launch", "notes", "--site", "calm-cedar"]);

		expect(patchOf(seen)).toBe('PATCH /api/sites/01J {"name":"Launch notes"}');
	});

	it("refuses a password typed as an argument, and sends nothing", async () => {
		// It is in shell history the moment it is typed. Taking it anyway would make that the habit.
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);
		process.env.DROP2RUN_TOKEN = "d2r_test";

		const result = await run(["set", "password", "hunter22", "--site", "calm-cedar"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("shell history");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("will not schedule a deletion without --yes", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await run([
			"set",
			"expires",
			"2030-01-01T00:00:00Z",
			"--then",
			"delete",
			"--site",
			"calm-cedar",
		]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("calm-cedar");
		expect(result.text).toContain("--yes");
		expect(patchOf(seen)).toBeUndefined();
	});

	it("schedules the deletion when told twice", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await run([
			"set",
			"expires",
			"2030-01-01T00:00:00Z",
			"--then",
			"delete",
			"--site",
			"calm-cedar",
			"--yes",
		]);

		expect(result.code).toBe(0);
		expect(patchOf(seen)).toBe(
			'PATCH /api/sites/01J {"expiresAt":"2030-01-01T00:00:00Z","expiryAction":"delete"}',
		);
	});

	it("answers an unknown setting without a token, listing the ones there are", async () => {
		const result = await run(["set", "colour", "blue"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("mode static|spa|docs");
		expect(result.text).not.toContain("DROP2RUN_TOKEN");
	});

	it("refuses a second value rather than dropping it, so a site named there is not missed", async () => {
		// `set mode spa other-site` reads like naming a site. Dropping the word would change the site in
		// drop2run.json instead, and nothing in the output would say which one changed.
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["set", "mode", "spa", "other-site"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("--site");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("keeps words starting with a dash in a name given after --", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		await run(["set", "--site", "calm-cedar", "name", "--", "Release", "-", "v2"]);

		expect(patchOf(seen)).toBe('PATCH /api/sites/01J {"name":"Release - v2"}');
	});

	it("says when a password replaced invite-only", async () => {
		// The API turns invite-only off rather than refusing, and everybody on the list loses access with
		// it. The response alone cannot say that happened, so the state is read first.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const base = settingsApi([]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;

				if (path.endsWith("/viewers")) return Response.json({ invitedOnly: true });
				if (init?.method === "PATCH") {
					return Response.json({
						siteId: "01J",
						name: null,
						spaMode: false,
						docsMode: false,
						live: true,
						passwordProtected: true,
						expiresAt: null,
						expiryAction: "Pause",
						formsEnabled: false,
						folderId: null,
						invitedOnly: false,
					});
				}
				return base(input, init);
			}),
		);

		const result = await set(
			"calm-cedar",
			"password",
			[],
			{ confirmed: false },
			async () => "secret-password",
		);

		expect(result.code).toBe(0);
		expect(result.text).toContain("replaced invite-only");
	});

	it("refuses --then on anything but expires", async () => {
		const result = await run(["set", "mode", "spa", "--then", "delete"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("set expires");
	});
});

describe("set password", () => {
	it("asks for the password only once the site is known to exist", async () => {
		// A mistyped subdomain should fail before somebody types a password into nothing.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ sites: [] })),
		);
		const asked = vi.fn(async () => "secret-password");

		const result = await set("no-such-site", "password", [], { confirmed: false }, asked);

		expect(result.code).toBe(1);
		expect(asked).not.toHaveBeenCalled();
	});

	it("sends what was typed", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await set(
			"calm-cedar",
			"password",
			[],
			{ confirmed: false },
			async () => "secret-password",
		);

		expect(result.code).toBe(0);
		expect(patchOf(seen)).toBe('PATCH /api/sites/01J {"password":"secret-password"}');
	});

	it("refuses an empty one rather than reading it as removing the password", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await set("calm-cedar", "password", [], { confirmed: false }, async () => "");

		expect(result.code).toBe(1);
		expect(result.text).toContain("unset password");
		expect(patchOf(seen)).toBeUndefined();
	});
});

describe("unset", () => {
	it("clears with an empty string, which the API reads as clear rather than leave alone", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await run(["unset", "password", "--site", "calm-cedar"]);

		expect(result.code).toBe(0);
		expect(patchOf(seen)).toBe('PATCH /api/sites/01J {"password":""}');
	});

	it("refuses a word after the setting, rather than clearing the project's site", async () => {
		// `unset password other-site` dropping `other-site` would make the site in drop2run.json public.
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);

		const result = await run(["unset", "password", "other-site"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("--site");
		expect(fetched).not.toHaveBeenCalled();
	});

	it("knows nothing on the object prototype", async () => {
		const result = await run(["unset", "toString", "--site", "calm-cedar"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("`unset` clears");
	});
});

describe("pause", () => {
	it("reports the state in lowercase, whatever spelling the API used", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", settingsApi(seen));

		const result = await run(["pause", "calm-cedar", "--json"]);

		expect(result.code).toBe(0);
		expect(seen).toContain("POST /api/sites/01J/pause");
		expect(JSON.parse(result.text)).toMatchObject({ status: "paused" });
	});
});

describe("readSecret", () => {
	it("reads piped input whole, dropping only the newline echo added", async () => {
		/**
		 * Yields the chunks a pipe would deliver.
		 *
		 * @yields Each chunk.
		 */
		async function* chunks() {
			yield "two words ";
			yield "here\n";
		}
		const piped = Object.assign(chunks(), {
			isTTY: false,
			resume: () => {},
			pause: () => {},
			setEncoding: () => {},
			on: () => {},
			off: () => {},
		});

		expect(await readSecret("unused", piped, { write: () => {} })).toBe("two words here");
	});
});

describe("HiddenLine", () => {
	it("keeps no arrow key, Tab or Alt+key in the password", () => {
		// Nothing is echoed, so a password carrying `\x1b[D` from a left-arrow is one nobody can type
		// again — and every visitor is locked out by it.
		const line = new HiddenLine();

		expect(line.type("ab\u001b[Dc\td\u001bxe\u001bOAf\r")).toBe("done");
		expect(line.value).toBe("abcdef");
	});

	it("deletes a whole emoji on Backspace, not half of it", () => {
		const line = new HiddenLine();

		line.type("a😀\u007f");

		expect(line.value).toBe("a");
	});

	it("starts again on Ctrl+U, and cancels on Ctrl+C", () => {
		const line = new HiddenLine();

		line.type("wrong\u0015right");
		expect(line.value).toBe("right");
		expect(line.type("\u0003")).toBe("cancelled");
	});
});

describe("info against an API whose site detail has no folderId", () => {
	it("reads the folder from the listing instead of calling the site top-level", async () => {
		// Production answered GET /sites/{id} without `folderId` while its listing carried it, and the
		// first build printed `folder undefined`. Defaulting to null would have been worse: a filed site
		// reported as being at the top level.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const path = new URL(String(input)).pathname;

				if (path === "/api/sites") {
					return Response.json({
						sites: [
							{
								siteId: "01J",
								subdomain: "calm-cedar",
								url: "https://calm-cedar.dropto.live",
								name: null,
								folderId: "01F",
							},
						],
					});
				}
				if (path === "/api/site-folders") {
					return Response.json({ folders: [{ folderId: "01F", parentId: null, name: "Clients" }] });
				}
				if (path.endsWith("/viewers")) return new Response(null, { status: 404 });

				return Response.json({
					siteId: "01J",
					subdomain: "calm-cedar",
					url: "https://calm-cedar.dropto.live",
					name: null,
					status: "Active",
					liveDeployId: null,
					spaMode: false,
					docsMode: false,
					modeIsManual: false,
					passwordProtected: false,
					passwordProtectionAvailable: true,
					formsEnabled: false,
					formsAvailable: true,
					expiresAt: null,
					expiryAction: "Pause",
					scheduledExpiryAvailable: true,
					deploys: [],
				});
			}),
		);

		const result = await run(["info", "calm-cedar"]);

		expect(result.code).toBe(0);
		expect(result.text).toMatch(/folder\s+Clients/);
		expect(result.text).not.toContain("undefined");
	});
});

describe("pause on a site Drop2Run suspended", () => {
	it("does not promise that resume brings it back", async () => {
		// The API records the pause and answers `Suspended`; resume is refused for such a site.
		process.env.DROP2RUN_TOKEN = "d2r_test";
		const base = settingsApi([]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) =>
				new URL(String(input)).pathname.endsWith("/pause")
					? Response.json({
							siteId: "01J",
							subdomain: "calm-cedar",
							status: "Suspended",
							ownerPaused: true,
							statusChangedAt: null,
						})
					: base(input, init),
			),
		);

		const result = await run(["pause", "calm-cedar"]);

		expect(result.text).toContain("suspended");
		expect(result.text).toContain("cannot bring it back");
	});
});
