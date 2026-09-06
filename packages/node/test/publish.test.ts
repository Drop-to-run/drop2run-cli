import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credentials } from "../src/config.js";
import { publishFiles } from "../src/publish.js";

/**
 * Which site a publish goes to, and what the request carries.
 *
 * <b>The decision worth guarding.</b> A publish with no site named creates a new one. The tempting
 * alternative — reuse the most recent — would silently overwrite whatever the account last published,
 * and this is a tool a model calls on somebody's behalf: the person asking "put this online" has not
 * said "and replace my last site". A named site that does not exist fails, rather than quietly becoming
 * a new one.
 *
 * <b>And the credential.</b> The bearer token goes to the control plane and must never go to the storage
 * host. Those PUTs are presigned and need nothing from us, so a token attached there would be a
 * control-plane credential handed to another service for no reason at all.
 */

/** Credentials pointing at a stubbed API. */
const credentials: Credentials = { token: "d2r_secret", apiBaseUrl: "https://api.test/api" };

/** A one-page publish, which is what most of these tests are about the *site* of rather than the files. */
const page = { path: "index.html", content: "<h1>hi</h1>" };

/** Manifest paths of the most recent prepare, filled in by the stub. */
const paths: string[] = [];

/** One request the code under test made. */
interface Recorded {
	readonly url: string;
	readonly method: string;
	readonly authorization: string | null;
}

/**
 * Answers the whole deploy sequence, recording every request.
 *
 * @param sites What `GET /sites` returns.
 * @returns The recorded requests, filled in as they happen.
 */
function stubApi(sites: unknown[] = []): Recorded[] {
	const seen: Recorded[] = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			seen.push({
				url,
				method: init?.method ?? "GET",
				authorization: headers.get("Authorization"),
			});

			if (url.endsWith("/api/sites") && (init?.method ?? "GET") === "GET") {
				return Response.json({ sites });
			}

			if (url.endsWith("/api/sites") && init?.method === "POST") {
				return Response.json({
					siteId: "01JNEWSITE0000000000000",
					subdomain: "brave-otter-4f2a",
					url: "https://brave-otter-4f2a.dropto.live",
				});
			}

			if (url.includes("/deploys/prepare")) {
				// Echoes the manifest rather than answering with a fixed file. The server issues one permit
				// per path it was sent, and a stub that always said `index.html` could only ever exercise a
				// one-file publish — which is every publish this file made until `publishFiles` existed.
				const manifest = JSON.parse(String(init?.body ?? "{}")) as {
					files?: { path: string; sha256: string }[];
				};
				const files = manifest.files ?? [];
				paths.splice(0, paths.length, ...files.map((file) => file.path));

				return Response.json({
					deployId: "01JDEPLOY000000000000001",
					total: files.length,
					reused: 0,
					upload: files.map((file) => ({
						path: file.path,
						token: `permit-for-${file.path}`,
						sha256: file.sha256,
					})),
					uploadUrl: "https://storage.test/v1/object",
				});
			}

			if (url.startsWith("https://storage.test/")) return new Response(null, { status: 200 });

			if (url.includes("/complete")) {
				return Response.json({ url: "https://brave-otter-4f2a.dropto.live", name: "Page" });
			}

			throw new Error(`Unexpected request to ${init?.method ?? "GET"} ${url}`);
		}),
	);

	return seen;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("publishing with no site named", () => {
	it("creates a new site rather than reusing the last one", async () => {
		const seen = stubApi([
			{
				siteId: "01JOLDSITE0000000000000",
				subdomain: "old-site",
				url: "https://old-site.dropto.live",
				name: null,
			},
		]);

		const result = await publishFiles(credentials, [page]);

		expect(result.siteId).toBe("01JNEWSITE0000000000000");
		expect(
			seen.some((request) => request.method === "POST" && request.url.endsWith("/api/sites")),
		).toBe(true);
	});

	it("returns the published URL", async () => {
		stubApi();

		expect((await publishFiles(credentials, [page])).url).toBe(
			"https://brave-otter-4f2a.dropto.live",
		);
	});
});

describe("publishing to a named site", () => {
	it("finds it by subdomain", async () => {
		stubApi([
			{
				siteId: "01JOLDSITE0000000000000",
				subdomain: "old-site",
				url: "https://old-site.dropto.live",
				name: null,
			},
		]);

		expect((await publishFiles(credentials, [page], "old-site")).siteId).toBe(
			"01JOLDSITE0000000000000",
		);
	});

	it("finds it by site id", async () => {
		stubApi([
			{
				siteId: "01JOLDSITE0000000000000",
				subdomain: "old-site",
				url: "https://old-site.dropto.live",
				name: null,
			},
		]);

		expect((await publishFiles(credentials, [page], "01JOLDSITE0000000000000")).siteId).toBe(
			"01JOLDSITE0000000000000",
		);
	});

	it("fails rather than creating a different site when the name matches nothing", async () => {
		const seen = stubApi([]);

		await expect(publishFiles(credentials, [page], "not-mine")).rejects.toThrow(/not-mine/);
		expect(seen.some((request) => request.method === "POST")).toBe(false);
	});
});

describe("the token", () => {
	it("is sent to the control plane", async () => {
		const seen = stubApi();

		await publishFiles(credentials, [page]);

		const api = seen.filter((request) => request.url.startsWith("https://api.test/"));
		expect(api.length).toBeGreaterThan(0);
		expect(api.every((request) => request.authorization === "Bearer d2r_secret")).toBe(true);
	});

	it("is never sent to the storage host", async () => {
		const seen = stubApi();

		await publishFiles(credentials, [page]);

		const storage = seen.filter((request) => request.url.startsWith("https://storage.test/"));
		expect(storage.length).toBeGreaterThan(0);

		// Uploads do carry an Authorization header now — the per-object permit the control plane minted,
		// which authorises one key and nothing else. What must never travel there is the account's own
		// token: it publishes to every site the account owns, and the upload host has no business
		// holding it.
		expect(
			storage.every((request) => request.authorization === "Bearer permit-for-index.html"),
		).toBe(true);
		expect(storage.every((request) => !request.authorization?.includes("d2r_secret"))).toBe(true);
	});
});

describe("publishing files written here rather than read off a disk", () => {
	it("publishes a lone markdown file, which needs no index.html", async () => {
		// The gap this closes. A site is publishable with an index.html *or* at least one .md, .markdown
		// or .pdf, so a note somebody asked to put online is already a whole publish — and a tool that
		// only took HTML left a model wrapping it in a page to get through.
		stubApi();

		const result = await publishFiles(credentials, [
			{ path: "notes.md", content: "# Notes\n\nSomething worth reading." },
		]);

		expect(paths).toEqual(["notes.md"]);
		expect(result.url).toBe("https://brave-otter-4f2a.dropto.live");
	});

	it("carries every file, not only the first", async () => {
		stubApi();

		const result = await publishFiles(credentials, [
			{ path: "index.html", content: "<link rel=stylesheet href=style.css>" },
			{ path: "style.css", content: "body { color: rebeccapurple }" },
			{ path: "docs/guide.md", content: "# Guide" },
		]);

		expect([...paths].sort()).toEqual(["docs/guide.md", "index.html", "style.css"]);
		expect(result.files).toBe(3);
	});

	it("takes a path written the way a model writes one", async () => {
		stubApi();

		await publishFiles(credentials, [
			{ path: "/index.html", content: "<h1>hi</h1>" },
			{ path: "./docs\\guide.md", content: "# Guide" },
		]);

		expect([...paths].sort()).toEqual(["docs/guide.md", "index.html"]);
	});

	it("refuses a path that climbs out of the site, before sending anything", async () => {
		const seen = stubApi();

		await expect(
			publishFiles(credentials, [{ path: "../../.ssh/id_rsa", content: "x" }]),
		).rejects.toThrow(/inside the site/);

		// Nothing left: no manifest, and no site created to hold one.
		expect(seen).toEqual([]);
	});

	it("refuses two files claiming one path rather than serving whichever won", async () => {
		stubApi();

		await expect(
			publishFiles(credentials, [
				{ path: "index.html", content: "first" },
				{ path: "./index.html", content: "second" },
			]),
		).rejects.toThrow(/same path/);
	});
});
