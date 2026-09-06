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
	it("offers exactly the three tools the README documents", async () => {
		const { tools } = await (await connect()).listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"list_sites",
			"publish_dir",
			"publish_html",
		]);
	});

	it("requires the content to publish, and leaves the site optional", async () => {
		const { tools } = await (await connect()).listTools();
		const publishHtml = tools.find((tool) => tool.name === "publish_html");

		// `site` optional is the whole of "publishing without naming a site creates a new one": a required
		// site would force a model to pick one, and the one it would pick is somebody's existing site.
		expect(publishHtml?.inputSchema.required).toEqual(["html"]);
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
