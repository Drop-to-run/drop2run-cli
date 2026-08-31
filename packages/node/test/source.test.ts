import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directorySource } from "../src/source.js";

/**
 * What a folder on disk turns into, and the two things a publish must never carry out of one.
 *
 * The first is junk: a `.git` directory published and then served is a repository handed to anybody who
 * asks. The engine's own `shouldIgnore` decides that, and the case here is that this source actually
 * asks it — a filter that exists and is not consulted is the same as no filter.
 *
 * The second is a symlink out of the tree. Publishing a folder should publish that folder; a link
 * pointing at a home directory turns "publish this" into "upload my keys", and nothing about the request
 * would look wrong.
 */

/** Directories made during a test, removed afterwards. */
const made: string[] = [];

/**
 * Builds a throwaway directory tree.
 *
 * @param files Paths relative to the root, and their contents.
 * @returns Absolute path of the root.
 */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "drop2run-source-"));
	made.push(root);

	for (const [path, contents] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, contents);
	}

	return root;
}

afterEach(() => {
	made.length = 0;
});

describe("directorySource", () => {
	it("reads a flat folder", async () => {
		const root = tree({ "index.html": "<h1>hi</h1>" });

		const files = await directorySource(root)();

		expect(files.map((file) => file.path)).toEqual(["index.html"]);
		expect(new TextDecoder().decode(files[0]!.bytes)).toBe("<h1>hi</h1>");
	});

	it("uses forward slashes whatever the platform separator is", async () => {
		const root = tree({ "index.html": "x", "assets/app.js": "y" });

		const files = await directorySource(root)();

		expect(files.map((file) => file.path).sort()).toEqual(["assets/app.js", "index.html"]);
	});

	it("leaves out what the engine says is never part of a site", async () => {
		const root = tree({
			"index.html": "x",
			".DS_Store": "junk",
			".git/config": "secret",
			"node_modules/pkg/index.js": "dep",
		});

		const files = await directorySource(root)();

		expect(files.map((file) => file.path)).toEqual(["index.html"]);
	});

	it("follows a symlink that stays inside the folder", async () => {
		const root = tree({ "index.html": "x", "real/page.html": "y" });
		symlinkSync(join(root, "real/page.html"), join(root, "linked.html"));

		const files = await directorySource(root)();

		expect(files.map((file) => file.path).sort()).toEqual([
			"index.html",
			"linked.html",
			"real/page.html",
		]);
	});

	it("skips a symlink pointing out of the folder", async () => {
		const outside = tree({ "private-key": "SECRET" });
		const root = tree({ "index.html": "x" });
		symlinkSync(join(outside, "private-key"), join(root, "id_rsa"));

		const files = await directorySource(root)();

		expect(files.map((file) => file.path)).toEqual(["index.html"]);
		expect(files.some((file) => new TextDecoder().decode(file.bytes).includes("SECRET"))).toBe(
			false,
		);
	});

	it("skips a symlinked directory pointing out of the folder", async () => {
		const outside = tree({ "keys/private": "SECRET" });
		const root = tree({ "index.html": "x" });
		symlinkSync(join(outside, "keys"), join(root, "keys"));

		const files = await directorySource(root)();

		expect(files.map((file) => file.path)).toEqual(["index.html"]);
	});

	it("skips a broken symlink rather than failing the publish", async () => {
		const root = tree({ "index.html": "x" });
		symlinkSync(join(root, "does-not-exist"), join(root, "dangling.html"));

		const files = await directorySource(root)();

		expect(files.map((file) => file.path)).toEqual(["index.html"]);
	});

	it("reports a folder that does not exist rather than publishing nothing", async () => {
		await expect(directorySource(join(tmpdir(), "drop2run-not-here-at-all"))()).rejects.toThrow();
	});
});
