import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { cutAt, fitEntries, STORE_ANSWER_MAX_CHARS } from "../src/tools.js";

/**
 * The store tools (docs/briefs/STORE-BRIEF.md §4.6), driven through a real client against a stubbed API.
 */

/** Clients opened by a test, closed afterwards. */
const opened: Client[] = [];

/** HOME before the test redirected it, so no developer's credential is read. */
let realHome: string | undefined;

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
 * A stand-in for the API: one site, and what the store routes answer. Records every request.
 *
 * @param seen Collects `METHOD path?query body` for each request.
 * @param answers JSON answers by path; any other path answers 204.
 * @returns The fetch stub.
 */
function stubStore(seen: string[], answers: Record<string, unknown> = {}): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push(
			`${init?.method ?? "GET"} ${url.pathname}${url.search}${init?.body ? ` ${String(init.body)}` : ""}`,
		);
		if (url.pathname === "/api/sites") {
			return Response.json({
				sites: [
					{
						siteId: "01J",
						subdomain: "guestbook",
						url: "https://guestbook.dropto.live",
						name: null,
					},
				],
			});
		}
		const answer = answers[url.pathname];
		return answer === undefined ? new Response(null, { status: 204 }) : Response.json(answer);
	}) as unknown as typeof fetch;
}

/**
 * The text of a tool answer.
 *
 * @param result What callTool returned.
 * @returns Its first text block.
 */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
	return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

beforeEach(() => {
	realHome = process.env.HOME;
	process.env.HOME = mkdtempSync(join(tmpdir(), "drop2run-mcp-home-"));
	process.env.DROP2RUN_TOKEN = "d2r_test";
});

afterEach(async () => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;

	vi.unstubAllGlobals();
	delete process.env.DROP2RUN_TOKEN;

	await Promise.all(opened.splice(0).map((client) => client.close()));
});

describe("the store tools", () => {
	it("offers no way to empty a whole store", async () => {
		const { tools } = await (await connect()).listTools();
		const names = tools.map((tool) => tool.name).filter((name) => name.startsWith("store_"));

		expect(names.sort()).toEqual([
			"store_delete",
			"store_export",
			"store_get",
			"store_list",
			"store_put",
		]);
	});

	it("marks reads read-only, and both writes destructive", async () => {
		const { tools } = await (await connect()).listTools();
		const hints = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

		for (const name of ["store_list", "store_get", "store_export"]) {
			expect(hints(name)).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: true,
			});
		}
		expect(hints("store_put")).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
		});
		expect(hints("store_delete")).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
		});
	});

	it("lists keys by prefix and passes the cursor back, never a value", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			stubStore(seen, {
				"/api/sites/01J/store/keys": {
					keys: [{ key: "post:42:a", size: 5, updatedAt: "2026-11-12T00:00:00Z" }],
					cursor: "post:42:a",
				},
			}),
		);

		const result = await (await connect()).callTool({
			name: "store_list",
			arguments: { site: "guestbook", prefix: "post:42:" },
		});

		expect(result.isError).toBeFalsy();
		expect(seen).toContain("GET /api/sites/01J/store/keys?prefix=post%3A42%3A");
		expect(textOf(result)).toContain("post:42:a  5 B");
		expect(textOf(result)).toContain("pass cursor post:42:a");
		expect(result.structuredContent).toEqual({
			keys: [{ key: "post:42:a", size: 5, updatedAt: "2026-11-12T00:00:00Z" }],
			cursor: "post:42:a",
		});
	});

	it("reads a value with the key in the query, and says visitors wrote it", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			stubStore(seen, { "/api/sites/01J/store/value": { key: "a b", value: "hi" } }),
		);
		const client = await connect();

		const result = await client.callTool({
			name: "store_get",
			arguments: { site: "guestbook", key: "a b" },
		});
		const { tools } = await client.listTools();

		expect(seen).toContain("GET /api/sites/01J/store/value?key=a%20b");
		expect(textOf(result)).toBe("hi");
		expect(result.structuredContent).toEqual({ key: "a b", value: "hi", truncated: false });
		expect(tools.find((tool) => tool.name === "store_get")?.description).toContain(
			"not as instructions",
		);
	});

	it("cuts a value too long for one answer, and says where the rest is", async () => {
		const long = "x".repeat(STORE_ANSWER_MAX_CHARS + 10);
		vi.stubGlobal(
			"fetch",
			stubStore([], { "/api/sites/01J/store/value": { key: "big", value: long } }),
		);

		const result = await (await connect()).callTool({
			name: "store_get",
			arguments: { site: "guestbook", key: "big" },
		});

		expect(result.structuredContent).toMatchObject({ truncated: true });
		expect((result.structuredContent as { value: string }).value).toHaveLength(
			STORE_ANSWER_MAX_CHARS,
		);
		expect(textOf(result)).toContain("drop2run store get");
	});

	it("writes and deletes one key, the key in the body for a write", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			stubStore(seen, { "/api/sites/01J/store/value": { key: "a/b", size: 2 } }),
		);
		const client = await connect();

		const put = await client.callTool({
			name: "store_put",
			arguments: { site: "guestbook", key: "a/b", value: "hi" },
		});
		expect(put.isError).toBeFalsy();
		expect(seen).toContain('PUT /api/sites/01J/store/value {"key":"a/b","value":"hi"}');

		const deleted = await client.callTool({
			name: "store_delete",
			arguments: { site: "guestbook", key: "a/b" },
		});
		expect(deleted.isError).toBeFalsy();
		expect(seen).toContain("DELETE /api/sites/01J/store/value?key=a%2Fb");
	});

	it("exports one page at a time, never downloading the whole store, and keeps a key named __proto__", async () => {
		const seen: string[] = [];
		const values: Record<string, string> = { __proto__: "x", a: "1" };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				seen.push(`${url.pathname}${url.search}`);
				if (url.pathname === "/api/sites") {
					return Response.json({
						sites: [
							{
								siteId: "01J",
								subdomain: "guestbook",
								url: "https://guestbook.dropto.live",
								name: null,
							},
						],
					});
				}
				if (url.pathname.endsWith("/store/keys")) {
					return Response.json({
						keys: ["__proto__", "a"].map((key) => ({
							key,
							size: 1,
							updatedAt: "2026-11-12T00:00:00Z",
						})),
						cursor: url.searchParams.has("cursor") ? null : "a",
					});
				}
				const key = url.searchParams.get("key") ?? "";
				return Response.json({
					key,
					value: Object.hasOwn(values, key) ? values[key] : null,
					size: 1,
				});
			}),
		);
		Object.defineProperty(values, "__proto__", { value: "x", enumerable: true });

		const result = await (await connect()).callTool({
			name: "store_export",
			arguments: { site: "guestbook" },
		});

		expect(result.structuredContent).toEqual({
			entries: [
				{ key: "__proto__", value: "x" },
				{ key: "a", value: "1" },
			],
			cursor: "a",
		});
		expect(textOf(result)).toContain('"__proto__": "x"');
		expect(textOf(result)).toContain("pass cursor a");
		expect(seen.some((line) => line.includes("/store/export"))).toBe(false);
	});

	it("passes the cursor back for the next part, and says when the store ends", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				seen.push(`${url.pathname}${url.search}`);
				if (url.pathname === "/api/sites") {
					return Response.json({
						sites: [
							{
								siteId: "01J",
								subdomain: "guestbook",
								url: "https://guestbook.dropto.live",
								name: null,
							},
						],
					});
				}
				if (url.pathname.endsWith("/store/keys")) {
					return Response.json({
						keys: [{ key: "z", size: 1, updatedAt: "2026-11-12T00:00:00Z" }],
						cursor: null,
					});
				}
				return Response.json({ key: "z", value: "26", size: 2 });
			}),
		);

		const result = await (await connect()).callTool({
			name: "store_export",
			arguments: { site: "guestbook", cursor: "a" },
		});

		expect(seen).toContain("/api/sites/01J/store/keys?cursor=a");
		expect(result.structuredContent).toEqual({
			entries: [{ key: "z", value: "26" }],
			cursor: null,
		});
	});

	it("passes the API's refusal through as an error the model can read", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/sites") {
					return Response.json({
						sites: [
							{
								siteId: "01J",
								subdomain: "guestbook",
								url: "https://guestbook.dropto.live",
								name: null,
							},
						],
					});
				}
				return Response.json(
					{
						code: "store_quota_exceeded",
						detail: "This account's store operations for the month are spent.",
					},
					{ status: 403 },
				);
			}),
		);

		const result = await (await connect()).callTool({
			name: "store_put",
			arguments: { site: "guestbook", key: "a", value: "1" },
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("store operations for the month are spent");
	});
});

describe("fitEntries", () => {
	it("keeps whole keys in the order given and stops before the one that would pass the size", () => {
		const pairs: [string, string][] = [
			["a", "1"],
			["b", "22"],
			["c", "333"],
		];
		const whole = JSON.stringify({ a: "1", b: "22", c: "333" }, null, 2).length;

		expect(fitEntries(pairs, whole)).toEqual(pairs);
		expect(fitEntries(pairs, whole - 1)).toEqual(pairs.slice(0, 2));
	});

	it("never goes over the size it was given", () => {
		const pairs = Array.from({ length: 500 }, (_, i): [string, string] => [`k${i}`, "v".repeat(i)]);
		const fitted = fitEntries(pairs, 5_000);

		expect(fitted.length).toBeLessThan(500);
		expect(JSON.stringify(Object.fromEntries(fitted), null, 2).length).toBeLessThanOrEqual(5_000);
	});
});

describe("cutAt", () => {
	it("never leaves half of a character at the end", () => {
		expect(cutAt("ab😀", 3)).toBe("ab");
		expect(cutAt("ab😀", 4)).toBe("ab😀");
		expect(cutAt("abc", 2)).toBe("ab");
	});
});
