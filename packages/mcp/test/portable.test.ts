import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

/**
 * `tools.ts` reaches nothing a Worker does not have.
 *
 * <b>Why a bundle and not a read of the imports.</b> The module that would break the remote server is
 * never the one being edited: `tools.ts` imports `@drop2run/node/portable`, which imports `api.ts`, which
 * once imported `dashboardUrlFor` from `config.ts` — and `config.ts` opens with `node:fs`. Nothing in
 * `tools.ts` looked wrong. A bundle follows every import the way the Worker's build will, including the
 * SDK and zod, so this fails where that build would, before there is a Worker to fail.
 *
 * Every built-in is recorded rather than refused on sight, so the failure lists all of them at once.
 */

/** Every name node resolves as a built-in, in both spellings. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/**
 * Bundles a module the way a Worker build would and returns the built-ins it reached.
 *
 * @param entry Path of the module, relative to this package.
 * @returns The built-ins imported anywhere in its graph, sorted.
 */
async function builtinsReachedFrom(entry: string): Promise<string[]> {
	const reached = new Set<string>();

	await build({
		configFile: false,
		logLevel: "silent",
		resolve: { alias: config.resolve?.alias ?? [] },
		build: {
			write: false,
			lib: {
				entry: fileURLToPath(new URL(`../${entry}`, import.meta.url)),
				formats: ["es"],
				fileName: () => "bundle.js",
			},
			rollupOptions: {
				external: (id) => {
					if (!BUILTINS.has(id)) return false;
					reached.add(id);
					return true;
				},
			},
		},
	});

	return [...reached].sort();
}

describe("the module both servers share", () => {
	it("reaches no node built-in anywhere in its graph", async () => {
		expect(await builtinsReachedFrom("src/tools.ts")).toEqual([]);
	}, 60_000);

	it("is checked by a test that can see one when it is there", async () => {
		// The stdio server reads a config file, so its graph must show up here. Without this, a bundle
		// that silently resolved nothing would pass the test above for the wrong reason.
		expect(await builtinsReachedFrom("src/server.ts")).toContain("node:fs");
	}, 60_000);
});
