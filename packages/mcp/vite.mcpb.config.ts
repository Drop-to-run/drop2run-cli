import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Bundles the server into one file for an MCP Bundle (`.mcpb`).
 *
 * <b>Why this is a second config rather than a flag on the first.</b> The npm build in
 * `vite.config.ts` deliberately leaves `@modelcontextprotocol/sdk` and `zod` external: npm installs
 * them beside the package, so a user who reinstalls gets whatever security fix has landed since. A
 * `.mcpb` has no such moment. It is a zip a person opens once, and every byte in it is frozen until a
 * new bundle replaces it — so the argument for keeping the SDK external does not survive the move, and
 * what is left is the cost of carrying a `node_modules` tree inside the archive.
 *
 * So this one inlines everything except node's own builtins. The result is a single file, which is
 * also the only arrangement where "does the bundle have all its dependencies" is not a question
 * somebody has to answer by reading a directory listing.
 *
 * `ssr.noExternal` is what does it. `build.ssr` alone externalises anything resolved out of
 * `node_modules`, which produced a bundle byte-for-byte the size of the npm one — inlining that looked
 * like it had happened and had not.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@drop2run/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
			"@drop2run/node": fileURLToPath(new URL("../node/src/index.ts", import.meta.url)),
		},
	},
	ssr: {
		noExternal: true,
	},
	build: {
		ssr: true,
		target: "node20",
		// Straight into the staging directory the packer zips, rather than into a `dist` of its own that
		// a script then copies: one fewer place for a stale file to survive a rebuild.
		outDir: "mcpb/server",
		emptyOutDir: true,
		lib: {
			entry: fileURLToPath(new URL("src/mcpb.ts", import.meta.url)),
			formats: ["es"],
		},
		rollupOptions: {
			// Every node built-in, in both spellings. Left to a regex rather than a list because a missing
			// entry is a build that inlines a stub of `fs` and fails at runtime.
			external: [/^node:/],
			// The output name is set here rather than through `lib.fileName`, which `build.ssr` ignores:
			// the file is named after its entry instead. `vite.config.ts` appears to use `fileName` and
			// does not — its entry is already called `index.ts`, so the setting has never had to work.
			// Here the entry is `mcpb.ts` and the manifest names `server/index.js`, so the difference is
			// the whole build: it wrote `mcpb.js` and the pack step refused it.
			output: {
				entryFileNames: "index.js",
			},
		},
	},
});
