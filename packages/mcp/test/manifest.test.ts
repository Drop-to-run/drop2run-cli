import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

/**
 * The MCPB manifest, checked against the things it claims to describe.
 *
 * <b>Why this is a test and not a step in the build script.</b> `scripts/build-mcpb.mjs` asserts the
 * same agreements, and has to: a bundle must not be packed from a manifest that has drifted. But the
 * build only runs when somebody is making a release, and the drift happens in between — a tool renamed
 * here, a version bumped there, and the manifest is wrong for however many commits pass before anybody
 * packs anything. The gate runs on every change, which is where the two should be compared.
 *
 * None of this is visible to the compiler: `manifest.json` is data, nothing imports it, and every field
 * below is a string that agrees with another string somewhere else in the repository.
 */

/** The manifest, read as data rather than imported, because that is how the packer reads it. */
const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"),
) as {
	name: string;
	version: string;
	server: { entry_point: string; mcp_config: { args: string[] } };
	tools: { name: string; description: string }[];
	privacy_policies?: string[];
	icon?: string;
};

/** The package manifest the bundle is built from. */
const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

describe("the MCPB manifest", () => {
	it("carries the version the package is on", () => {
		// Two files, no compiler between them, and the failure is silent: a bundle built from a stale
		// manifest installs and reports a version nobody shipped.
		expect(manifest.version).toBe(pkg.version);
	});

	it("names every tool the server registers, and no others", async () => {
		// The manifest's tool list is what a person reads before installing. A tool missing from it is
		// undersold; a tool listed and not registered is a promise the bundle cannot keep.
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0.0.0" });
		await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
		const { tools } = await client.listTools();
		await client.close();

		expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(
			tools.map((tool) => tool.name).sort(),
		);
	});

	it("starts the entry point the build actually writes", () => {
		// `build.ssr` ignores `lib.fileName` and names the output after its entry, so this pair has come
		// apart once already: the build wrote `mcpb.js` while the manifest asked for `server/index.js`.
		expect(manifest.server.entry_point).toBe("server/index.js");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: `${__dirname}` is MCPB's own substitution
		// syntax, expanded by the host at launch. A template literal here would resolve it in this file,
		// which is the one place it must not be resolved.
		expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/index.js"]);
	});

	it("points at a privacy policy over https", () => {
		// Required for submission, and the one requirement whose absence is an immediate rejection rather
		// than a review comment. Whether the URL resolves to a page of its own is checked at pack time,
		// which is the only place a network call belongs.
		const [policy] = manifest.privacy_policies ?? [];

		expect(policy).toBeTypeOf("string");
		expect(policy?.startsWith("https://")).toBe(true);
	});
});
