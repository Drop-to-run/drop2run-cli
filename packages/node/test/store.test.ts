import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearToken,
	DEFAULT_API_BASE_URL,
	dashboardUrlFor,
	resolveApiBaseUrl,
	saveToken,
} from "../src/config.js";

/**
 * Writing and removing the stored token.
 *
 * Against real files in a temporary directory rather than a mocked filesystem, because two of the three
 * things worth asserting here are filesystem facts: that the mode is 0600, and that a write which fails
 * part-way does not leave a file that parses as nothing. A mock would assert that the right functions were
 * called, which is a different claim.
 */

/** A fresh empty directory to write a config into. */
function scratch(): string {
	return join(mkdtempSync(join(tmpdir(), "drop2run-store-")), "config.json");
}

describe("saveToken", () => {
	it("writes the token where the reader looks for it", () => {
		const path = scratch();

		saveToken("d2r_written", path);

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: "d2r_written" });
	});

	it("keeps the file readable only by its owner, since it holds a credential", () => {
		const path = scratch();

		saveToken("d2r_written", path);

		// The low nine bits: 0600 exactly, so neither the group nor anybody else can read it.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("preserves an apiBaseUrl somebody set by hand", () => {
		const path = scratch();
		writeFileSync(path, JSON.stringify({ apiBaseUrl: "http://localhost:8001/api" }));

		saveToken("d2r_written", path);

		// A write that replaced the whole file would silently point the next command at production, which
		// is the same class of mistake as signing in to the wrong account.
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			apiBaseUrl: "http://localhost:8001/api",
			token: "d2r_written",
		});
	});

	it("replaces an existing token rather than adding a second one", () => {
		const path = scratch();

		saveToken("d2r_first", path);
		saveToken("d2r_second", path);

		expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("d2r_second");
	});

	it("creates the directory, because a first sign-in has no ~/.config/drop2run yet", () => {
		const path = join(mkdtempSync(join(tmpdir(), "drop2run-store-")), "nested", "config.json");

		saveToken("d2r_written", path);

		expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("d2r_written");
	});

	it("leaves a malformed file behind rather than merging with nonsense", () => {
		const path = scratch();
		writeFileSync(path, "{ not json");

		saveToken("d2r_written", path);

		// Unparseable means there is nothing to preserve, so the file becomes just the token — which is a
		// working state, unlike a merge that threw.
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: "d2r_written" });
	});
});

describe("clearToken", () => {
	it("removes the token and says it did", () => {
		const path = scratch();
		saveToken("d2r_written", path);

		expect(clearToken(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
	});

	it("keeps everything else in the file", () => {
		const path = scratch();
		writeFileSync(path, JSON.stringify({ apiBaseUrl: "http://localhost:8001/api" }));
		saveToken("d2r_written", path);

		clearToken(path);

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			apiBaseUrl: "http://localhost:8001/api",
		});
	});

	it("reports false when there was nothing to remove, so logout does not claim otherwise", () => {
		const path = scratch();

		expect(clearToken(path)).toBe(false);
	});
});

describe("resolveApiBaseUrl", () => {
	it("defaults to production when nothing says otherwise", () => {
		expect(
			resolveApiBaseUrl({}, () => {
				throw new Error("ENOENT");
			}),
		).toBe(DEFAULT_API_BASE_URL);
	});

	it("lets the environment win over the file, matching loadCredentials", () => {
		const read = () => JSON.stringify({ apiBaseUrl: "http://file:8001/api" });

		expect(resolveApiBaseUrl({ DROP2RUN_API_URL: "http://env:8001/api" }, read)).toBe(
			"http://env:8001/api",
		);
	});

	it("works with no token at all, which is the state sign-in runs in", () => {
		const read = () => JSON.stringify({ apiBaseUrl: "http://localhost:8001/api" });

		expect(resolveApiBaseUrl({}, read)).toBe("http://localhost:8001/api");
	});

	it("drops a trailing slash, so the path it is joined with cannot double up", () => {
		expect(resolveApiBaseUrl({ DROP2RUN_API_URL: "http://localhost:8001/api/" }, () => "")).toBe(
			"http://localhost:8001/api",
		);
	});
});

describe("dashboardUrlFor", () => {
	it("strips the API path, because the two are one deployment", () => {
		expect(dashboardUrlFor("https://dropto.run/api")).toBe("https://dropto.run");
	});

	it("follows a local API, so a local sign-in does not open production", () => {
		expect(dashboardUrlFor("http://localhost:8001/api")).toBe("http://localhost:8001");
	});

	it("leaves an origin with no API path alone", () => {
		expect(dashboardUrlFor("https://dropto.run")).toBe("https://dropto.run");
	});
});
