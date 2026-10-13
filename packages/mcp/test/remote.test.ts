import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createRemoteServer } from "../src/tools.js";

/**
 * The server a hosted chat reaches by URL, against the local one it shares its tools with.
 *
 * The remote server has no disk and is signed in by the chat client, so three local tools do not exist
 * on it and every sentence that names them would send a model looking for something it cannot call.
 * Everything else must be the same tool — same schema, same annotations — or the two surfaces have
 * drifted into describing different products.
 */

/** Clients opened by a test, closed afterwards. */
const opened: Client[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(opened.splice(0).map((client) => client.close()));
});

/**
 * Connects a client to a server.
 *
 * @param server The server to connect to.
 * @returns The connected client.
 */
async function connect(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	opened.push(client);

	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	return client;
}

/**
 * A remote server whose calls have no credentials.
 *
 * @returns The connected client.
 */
async function connectSignedOut(): Promise<Client> {
	return connect(
		createRemoteServer(
			() => null,
			() => "Reconnect the connector.",
		),
	);
}

/** The tools only a process on the person's own machine can offer. */
const LOCAL_ONLY = ["login", "login_code", "publish_dir"];

describe("the remote tool surface", () => {
	it("offers every local tool except the three that need this machine, in the same order", async () => {
		const local = (await (await connect(createServer())).listTools()).tools.map(
			(tool) => tool.name,
		);
		const remote = (await (await connectSignedOut()).listTools()).tools.map((tool) => tool.name);

		expect(remote).toEqual(local.filter((name) => !LOCAL_ONLY.includes(name)));
	});

	it("describes every tool it shares exactly as the local server does, except publish_files", async () => {
		const local = (await (await connect(createServer())).listTools()).tools;
		const remote = (await (await connectSignedOut()).listTools()).tools;

		for (const tool of remote) {
			const twin = local.find((candidate) => candidate.name === tool.name);

			expect(twin, tool.name).toBeDefined();
			expect(tool.inputSchema, tool.name).toEqual(twin?.inputSchema);
			expect(tool.outputSchema, tool.name).toEqual(twin?.outputSchema);
			expect(tool.annotations, tool.name).toEqual(twin?.annotations);
			if (tool.name !== "publish_files")
				expect(tool.description, tool.name).toBe(twin?.description);
		}
	});

	it("never names a tool it does not have, in the instructions or in any description", async () => {
		const client = await connectSignedOut();
		const texts = [
			client.getInstructions() ?? "",
			...(await client.listTools()).tools.map((tool) => tool.description ?? ""),
		];

		for (const text of texts) {
			for (const name of LOCAL_ONLY) expect(text).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
	});

	it("tells a model that only text can be published, and not to ask the person for a token", async () => {
		const client = await connectSignedOut();
		const instructions = client.getInstructions() ?? "";
		const publish = (await client.listTools()).tools.find((tool) => tool.name === "publish_files");

		expect(instructions).toContain("Only text can be published here");
		expect(instructions).toContain("Never ask the person for a token");
		expect(instructions).not.toContain(".pdf");
		expect(publish?.description).toContain("cannot publish a PDF, an image or an Office file");
	});
});

describe("a remote call", () => {
	it("answers with the surface's own message when there are no credentials", async () => {
		const result = await (await connectSignedOut()).callTool({ name: "list_sites", arguments: {} });

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Reconnect the connector." }]);
	});

	it("reads the credentials on every call, with the token they give", async () => {
		const credentials = vi.fn(() => ({ token: "d2r_remote", apiBaseUrl: "https://api.test/api" }));
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ items: [], total: 0 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetch);

		const client = await connect(createRemoteServer(credentials, () => "unused"));
		await client.callTool({ name: "list_sites", arguments: {} });
		await client.callTool({ name: "list_sites", arguments: {} });

		expect(credentials).toHaveBeenCalledTimes(2);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url.startsWith("https://api.test/api/")).toBe(true);
		expect(new Headers(init.headers).get("authorization")).toBe("Bearer d2r_remote");
	});
});
