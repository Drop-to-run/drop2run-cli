import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

/**
 * The MCP surface, driven through a real client rather than by reading the source.
 *
 * <b>Why a client and not a unit test of the handlers.</b> What a model can do with this server is
 * exactly what the protocol exposes: the tool names, their schemas, and which arguments are required.
 * None of that is visible from the functions — it is produced by the SDK from the zod schemas — so a
 * test that called the handlers directly would assert the half that cannot break in an interesting way.
 *
 * The in-memory transport is the same code path stdio uses, minus the pipes.
 */

/** Clients opened by a test, closed afterwards. */
const opened: Client[] = [];

/**
 * Connects a client to a fresh server.
 *
 * @returns The connected client.
 */
async function connect(): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	opened.push(client);

	await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);

	return client;
}

/**
 * HOME, redirected for every test here.
 *
 * <b>Isolation this file turned out not to have.</b> `loadCredentials` falls back to
 * `~/.config/drop2run/config.json`, so "with no credentials" quietly meant "on a machine where nobody
 * has signed in". Once somebody did, the no-credentials test read a real token and the server called
 * production with it — the failure arrived as an answer from dropto.run rather than from a stub.
 *
 * A test must not be able to read a developer's credential or reach the network by accident.
 * `os.homedir()` reads HOME on this platform, so one line covers both.
 */
let realHome: string | undefined;

beforeEach(() => {
	realHome = process.env.HOME;
	process.env.HOME = mkdtempSync(join(tmpdir(), "drop2run-mcp-home-"));
});

afterEach(async () => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;

	await Promise.all(opened.splice(0).map((client) => client.close()));
});

describe("the tool surface", () => {
	it("offers exactly the six tools the README documents", async () => {
		const { tools } = await (await connect()).listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"delete_site",
			"list_sites",
			"login",
			"login_code",
			"publish_dir",
			"publish_files",
		]);
	});

	it("asks for nothing to sign in, either way", async () => {
		// Both arguments are adjustments to a flow that has to work when a model calls it with no
		// arguments at all — which is what it will do the first time a publish is refused.
		const { tools } = await (await connect()).listTools();

		for (const name of ["login", "login_code"]) {
			expect(tools.find((tool) => tool.name === name)?.inputSchema.required ?? []).toEqual([]);
		}
	});

	it("takes a list of files with a path each, and still no required site", async () => {
		const { tools } = await (await connect()).listTools();
		const publishFiles = tools.find((tool) => tool.name === "publish_files");
		const files = publishFiles?.inputSchema.properties?.files as
			| { items?: { required?: string[] } }
			| undefined;

		// `site` optional is the whole of "publishing without naming a site creates a new one": a required
		// site would force a model to pick one, and the one it would pick is somebody's existing site.
		expect(publishFiles?.inputSchema.required).toEqual(["files"]);
		// Both halves of a file are required. A path with no content publishes an empty file, and content
		// with no path has nowhere to go — neither is something a model should be able to send.
		expect(files?.items?.required?.sort()).toEqual(["content", "path"]);
	});

	it("requires a path for a folder publish", async () => {
		const { tools } = await (await connect()).listTools();
		const publishDir = tools.find((tool) => tool.name === "publish_dir");

		expect(publishDir?.inputSchema.required).toEqual(["path"]);
	});

	it("asks for nothing to list sites", async () => {
		const { tools } = await (await connect()).listTools();
		const listSites = tools.find((tool) => tool.name === "list_sites");

		expect(listSites?.inputSchema.required ?? []).toEqual([]);
	});

	it("will not delete a site without the subdomain repeated back", async () => {
		// The confirmation is a required argument rather than a boolean, and required is the half that
		// matters: an optional `confirm` is one a model omits, and a `force: true` flag is one it sets.
		// Repeating the subdomain is something it can only do by having been told which site is meant.
		const { tools } = await (await connect()).listTools();
		const deleteSite = tools.find((tool) => tool.name === "delete_site");

		expect(deleteSite?.inputSchema.required?.sort()).toEqual(["confirm", "site"]);
	});
});

describe("what the tools answer with", () => {
	/**
	 * Output schemas as the client receives them, keyed by tool name.
	 *
	 * @returns Every tool's declared output schema, or undefined where there is none.
	 */
	async function outputSchemas(): Promise<Record<string, Record<string, unknown> | undefined>> {
		const { tools } = await (await connect()).listTools();

		return Object.fromEntries(
			tools.map((tool) => [tool.name, tool.outputSchema as Record<string, unknown> | undefined]),
		);
	}

	it("describes a publish as fields, not only as a sentence", async () => {
		// "Publish this, then send me the link" is the shape most of these requests take, and without a
		// schema the link has to be read back out of English before anything can use it.
		const schemas = await outputSchemas();

		for (const name of ["publish_files", "publish_dir"]) {
			expect(Object.keys((schemas[name]?.properties as object) ?? {}).sort(), name).toEqual([
				"files",
				"siteId",
				"subdomain",
				"unchanged",
				"url",
			]);
		}
	});

	it("describes a site listing as fields", async () => {
		const schemas = await outputSchemas();

		expect(Object.keys((schemas.list_sites?.properties as object) ?? {})).toEqual(["sites"]);
	});

	it("leaves the sign-in tools unstructured, having nothing to structure", async () => {
		// Not an oversight. They answer with what a person should do next, which is prose by nature, and
		// declaring a schema that says nothing would make the schemas mean less everywhere else.
		const schemas = await outputSchemas();

		expect(schemas.login).toBeUndefined();
		expect(schemas.login_code).toBeUndefined();
	});
});

describe("what each tool admits it does", () => {
	/**
	 * Annotations as the client receives them, keyed by tool name.
	 *
	 * Read back over the protocol rather than imported from the source, because the assertion worth
	 * making is about what reaches a host: a constant declared and then not passed to `registerTool`
	 * would satisfy an import and tell a client nothing.
	 *
	 * @returns Every tool's annotations.
	 */
	async function annotations(): Promise<Record<string, Record<string, unknown>>> {
		const { tools } = await (await connect()).listTools();

		return Object.fromEntries(
			tools.map((tool) => [tool.name, (tool.annotations ?? {}) as Record<string, unknown>]),
		);
	}

	it("marks both publishes destructive", async () => {
		// The hint a host reads to decide whether to ask first. Publishing over a subdomain takes down
		// the pages that were there, and a person who is not asked finds out from the URL.
		const hints = await annotations();

		for (const name of ["publish_files", "publish_dir"]) {
			expect(hints[name]?.readOnlyHint, name).toBe(false);
			expect(hints[name]?.destructiveHint, name).toBe(true);
		}
	});

	it("does not let a publish claim to be idempotent", async () => {
		// True of an identical publish to a named site, which answers "already live" — and false of the
		// same call with `site` omitted, which makes one more site every run. The tool cannot tell which
		// it is from the annotation, so it claims the weaker thing.
		const hints = await annotations();

		for (const name of ["publish_files", "publish_dir"]) {
			expect(hints[name]?.idempotentHint, name).toBe(false);
		}
	});

	it("marks signing in as a write, but not as a destructive one", async () => {
		// It stores a credential; it does not replace anything the person owns. Marking it destructive
		// would train a host to confirm the one tool whose whole job is to be run when nothing works yet.
		const hints = await annotations();

		for (const name of ["login", "login_code"]) {
			expect(hints[name]?.readOnlyHint, name).toBe(false);
			expect(hints[name]?.destructiveHint, name).toBe(false);
		}
	});

	it("marks listing sites read-only, and leaves the write hints off it", async () => {
		// The spec gives `destructiveHint` and `idempotentHint` meaning only when `readOnlyHint` is
		// false. Present-but-safe-looking values here would read as a judgement that was never made.
		const hints = await annotations();

		expect(hints.list_sites?.readOnlyHint).toBe(true);
		expect(hints.list_sites).not.toHaveProperty("destructiveHint");
		expect(hints.list_sites).not.toHaveProperty("idempotentHint");
	});

	it("marks deleting a site destructive, and not idempotent", async () => {
		// The one call here nothing undoes. `idempotentHint` false is not bookkeeping: a second delete
		// fails to find anything, and a client told otherwise would retry into an error and read it as a
		// transient one.
		const hints = await annotations();

		expect(hints.delete_site?.readOnlyHint).toBe(false);
		expect(hints.delete_site?.destructiveHint).toBe(true);
		expect(hints.delete_site?.idempotentHint).toBe(false);
	});

	it("admits every tool reaches dropto.run", async () => {
		// None of the five is answerable from this machine alone, so none of them may look local.
		const hints = await annotations();

		for (const [name, hint] of Object.entries(hints)) {
			expect(hint.openWorldHint, name).toBe(true);
		}
	});

	it("leaves no tool to the spec's defaults", async () => {
		// The reason to be explicit at all: an omitted `destructiveHint` defaults to true, so a tool that
		// says nothing is read as destructive. Silence here is a claim, and it is usually the wrong one.
		const hints = await annotations();

		for (const [name, hint] of Object.entries(hints)) {
			expect(hint.readOnlyHint, name).toBeTypeOf("boolean");
			expect(hint.openWorldHint, name).toBeTypeOf("boolean");
		}
	});
});

describe("the instructions", () => {
	it("warn that publishing over a site replaces it", async () => {
		// The one thing a model can do here that a person cannot undo. It belongs in the instructions
		// rather than only in a tool description, because a model reads these before choosing a tool.
		const client = await connect();

		expect(client.getInstructions()).toContain("replaces what it serves");
	});
});

describe("a tool called with no credentials", () => {
	it("answers with how to get a token rather than failing the call", async () => {
		// Nothing is stubbed: this machine has no token, which is the state a first-time user is in. The
		// result must be a readable answer, not a protocol error — a crashed tool tells them nothing.
		const result = await (await connect()).callTool({ name: "list_sites", arguments: {} });

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("account/tokens");
	});

	it("names the login tool and not a command line that may not be installed", async () => {
		// The failure this asserts against happened: the message said to run `drop2run login`, and
		// somebody who had added only this server had no such command. What was left was creating a token
		// on the web and hand-writing a config file — for a server that can open a browser itself.
		const result = await (await connect()).callTool({ name: "list_sites", arguments: {} });
		const text = JSON.stringify(result.content);

		expect(text).toContain("`login` tool");
		expect(text).not.toContain("drop2run login");
	});

	it("says which of the two ways to set a token by hand needs a restart", async () => {
		// Both are offered, and only one of them takes effect while the chat is open. A model told they
		// are equivalent will suggest the `export` that this already-running process cannot see.
		const result = await (await connect()).callTool({ name: "list_sites", arguments: {} });
		const text = JSON.stringify(result.content);

		expect(text).toContain("needs no restart");
		expect(text).toContain("restart this server");
	});
});

describe("the instructions about signing in", () => {
	it("tell a model to call login rather than to ask for a token", async () => {
		const client = await connect();

		expect(client.getInstructions()).toContain("call login");
	});
});

describe("the version the server reports", () => {
	it("is the version of the package", async () => {
		// Two places name it: the manifest npm publishes, and the constant the SDK hands to clients. A
		// release that bumps only the manifest would leave every client told the wrong version, and
		// nothing else would notice.
		const manifest = (await import("../package.json", { with: { type: "json" } })).default as {
			version: string;
		};
		const client = await connect();

		expect(client.getServerVersion()?.version).toBe(manifest.version);
	});
});
