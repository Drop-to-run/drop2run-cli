import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CollectedFile } from "@drop2run/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { set } from "../src/commands.js";
import {
	type Bundler,
	esbuildBundler,
	routeEntries,
	withBundledFunctions,
} from "../src/functions.js";

/**
 * What the CLI does with a folder's `_functions/` and with a site's function variables
 * (docs/briefs/FUNCTIONS-BRIEF.md D6, D17, §4.6).
 *
 * The bundler runs for real here, on folders written to a temporary directory: what matters is what reaches the
 * server — one self-contained module per route, at the route's path — and a stub would only prove the stub.
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

/**
 * Writes a folder.
 *
 * @param files Contents by path, `/`-separated.
 * @returns Its absolute path.
 */
function folder(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "drop2run-fn-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

/**
 * The files of a folder as the engine would collect them, without the ignore list: enough for the wrapper.
 *
 * @param files Contents by path.
 * @returns The collected files.
 */
function collected(files: Record<string, string>): CollectedFile[] {
	return Object.entries(files).map(([path, content]) => ({
		path,
		bytes: new TextEncoder().encode(content),
	}));
}

/**
 * Decodes a module.
 *
 * @param bytes What the bundler made.
 * @returns The text.
 */
function text(bytes: CollectedFile["bytes"]): string {
	return new TextDecoder().decode(bytes as Uint8Array);
}

describe("which files under _functions/ are routes", () => {
	it("takes JavaScript and TypeScript modules, and leaves helpers and type declarations out", () => {
		expect(
			routeEntries(
				collected({
					"index.html": "",
					"_functions/api/hello.js": "",
					"_functions/api/users/[id].ts": "",
					"_functions/feed.mjs": "",
					"_functions/_lib/db.js": "",
					"_functions/api/_util.ts": "",
					"_functions/types.d.ts": "",
					"_functions/data.json": "",
				}),
			),
		).toEqual(["api/hello.js", "api/users/[id].ts", "feed.mjs"]);
	});
});

describe("wrapping a folder's source", () => {
	it("sends the bundled routes in place of everything under _functions/, and the rest untouched", async () => {
		const files = collected({
			"index.html": "<h1>hi</h1>",
			"_functions/api/hello.ts": "source",
			"_functions/_lib/db.js": "helper",
		});
		const bundler: Bundler = async (_root, entries) =>
			entries.map((entry) => ({
				path: entry.replace(/\.ts$/, ".js"),
				bytes: new TextEncoder().encode(`bundled ${entry}`),
			}));

		const sent = await withBundledFunctions(async () => files, "/site", bundler)();

		expect(sent.map((file) => file.path)).toEqual(["index.html", "_functions/api/hello.js"]);
		expect(text(sent[1]!.bytes)).toBe("bundled api/hello.ts");
	});

	it("leaves a folder without a route as it is, and never calls the bundler", async () => {
		const files = collected({ "index.html": "", "_functions/_lib/db.js": "" });
		const bundler = vi.fn<Bundler>();

		const sent = await withBundledFunctions(async () => files, "/site", bundler)();

		expect(sent).toBe(files);
		expect(bundler).not.toHaveBeenCalled();
	});
});

describe("bundling with esbuild", () => {
	it("makes each route one module with its helpers and npm packages inlined, at the route's own path", async () => {
		const root = folder({
			"_functions/api/hello.ts":
				'import { greet } from "../_lib/greet";\nimport shout from "tiny-shout";\n' +
				"export const onRequestGet = (): Response => new Response(shout(greet()));\n",
			"_functions/_lib/greet.ts": 'export const greet = (): string => "hello from the helper";\n',
			"_functions/api/users/[id].mjs":
				"export function onRequest({ params }) { return Response.json({ id: params.id }); }\n",
			"node_modules/tiny-shout/package.json": JSON.stringify({
				name: "tiny-shout",
				main: "node.cjs",
				browser: "browser.js",
			}),
			"node_modules/tiny-shout/node.cjs": 'module.exports = () => "the node build";\n',
			"node_modules/tiny-shout/browser.js":
				"export default function shout(text) { return text.toUpperCase() + ' from the browser build'; }\n",
		});

		const routes = await esbuildBundler(root, ["api/hello.ts", "api/users/[id].mjs"]);
		const byPath = new Map(routes.map((route) => [route.path, text(route.bytes)]));

		expect([...byPath.keys()].sort()).toEqual(["api/hello.js", "api/users/[id].mjs"]);

		const hello = byPath.get("api/hello.js") ?? "";
		expect(hello).toContain("hello from the helper");
		expect(hello).toContain("from the browser build");
		expect(hello).not.toContain("the node build");
		expect(hello).not.toMatch(/\bimport\s.*from\s/);
		expect(hello).toMatch(/export\s*\{[^}]*onRequestGet/);
	});

	it("says a Node built-in cannot be used, names the file, and offers --no-bundle", async () => {
		const root = folder({
			"_functions/api/hash.js":
				'import { createHash } from "node:crypto";\nexport const onRequest = () => new Response(createHash("sha256").digest("hex"));\n',
		});

		await expect(esbuildBundler(root, ["api/hash.js"])).rejects.toThrow(
			/Could not bundle _functions\/:[\s\S]*_functions\/api\/hash\.js:1:[\s\S]*without Node's built-ins[\s\S]*--no-bundle/,
		);
	});

	it("says a package that is not installed should be", async () => {
		const root = folder({
			"_functions/api/pay.js":
				'import Stripe from "not-installed-anywhere";\nexport const onRequest = () => new Response(String(Stripe));\n',
		});

		await expect(esbuildBundler(root, ["api/pay.js"])).rejects.toThrow(/npm install/);
	});
});

describe("set env and unset env", () => {
	/**
	 * Answers the listing and the variable routes.
	 *
	 * @param seen Collects each request as `METHOD path body`.
	 * @returns The fetch stub.
	 */
	function envApi(seen: string[]) {
		process.env.DROP2RUN_TOKEN = "d2r_test";

		return vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			seen.push(`${method} ${url.pathname} ${init?.body ?? ""}`.trim());

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
			if (url.pathname.startsWith("/api/sites/01J/env/") && method === "PUT") {
				const value = (JSON.parse(String(init?.body)) as { value: string }).value;
				return Response.json({
					name: url.pathname.split("/").at(-1),
					last4: value.slice(-4),
					createdAt: "2026-11-02T00:00:00Z",
					updatedAt: "2026-11-02T00:00:00Z",
				});
			}
			if (url.pathname === "/api/sites/01J/env/OPENAI_API_KEY" && method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected request to ${method} ${url.pathname}`);
		});
	}

	it("takes the name as an argument and the value only at the prompt, trimmed, and never prints it", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", envApi(seen));
		const prompts: string[] = [];

		const result = await set(
			"calm-cedar",
			"env",
			["OPENAI_API_KEY"],
			{ confirmed: false },
			async (prompt) => {
				prompts.push(prompt ?? "");
				return "  sk-secret-Wq9z\n";
			},
		);

		expect(result.code).toBe(0);
		expect(prompts).toEqual(["Value for OPENAI_API_KEY: "]);
		expect(seen).toContain('PUT /api/sites/01J/env/OPENAI_API_KEY {"value":"sk-secret-Wq9z"}');
		expect(result.text).toContain("OPENAI_API_KEY ••••Wq9z");
		expect(result.text).toContain("env.OPENAI_API_KEY");
		expect(result.text).not.toContain("sk-secret");
	});

	it("refuses a value on the command line and a name that cannot be one, before reaching the network", async () => {
		const fetched = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetched);
		process.env.DROP2RUN_TOKEN = "d2r_test";

		const withValue = await run([
			"set",
			"env",
			"OPENAI_API_KEY",
			"sk-live-123",
			"--site",
			"calm-cedar",
		]);
		const lowercase = await run(["set", "env", "openai_key", "--site", "calm-cedar"]);
		const nameless = await run(["set", "env", "--site", "calm-cedar"]);

		expect(withValue.code).toBe(1);
		expect(withValue.text).toContain("shell history");
		expect(lowercase.code).toBe(1);
		expect(lowercase.text).toContain("uppercase letters");
		expect(nameless.code).toBe(1);
		expect(fetched).not.toHaveBeenCalled();
	});

	it("removes a variable by name", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", envApi(seen));

		const result = await run(["unset", "env", "OPENAI_API_KEY", "--site", "calm-cedar"]);

		expect(result.code).toBe(0);
		expect(seen).toContain("DELETE /api/sites/01J/env/OPENAI_API_KEY");
		expect(result.text).toContain("Removed OPENAI_API_KEY from calm-cedar");
	});
});
