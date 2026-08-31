import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Bundles the CLI into `dist/index.js` for node.
 *
 * <b>Why this bundles rather than compiling file by file.</b> `@drop2run/core` is resolved by an alias,
 * not installed — the lock-file wall described in `packages/contracts/README.md` — so a plain `tsc`
 * emit would leave `import … from "@drop2run/core"` in the output, and that import resolves to nothing
 * on a machine that installed this package from a registry. Bundling folds the engine in, which turns
 * the alias into an implementation detail of the build rather than a promise the published package
 * cannot keep.
 *
 * This package has no runtime dependencies at all — the argument parser is a function, deliberately, in
 * a package people install globally and hand a credential to.
 *
 * `vite` rather than a bundler of its own: it is already the pinned build tool in this repository, and
 * `apps/web` already uses its SSR mode for the prerenderer, and packages/mcp is built the same way.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@drop2run/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
			"@drop2run/node": fileURLToPath(new URL("../node/src/index.ts", import.meta.url)),
		},
	},
	build: {
		ssr: true,
		target: "node20",
		outDir: "dist",
		emptyOutDir: true,
		lib: {
			entry: fileURLToPath(new URL("src/index.ts", import.meta.url)),
			formats: ["es"],
			fileName: () => "index.js",
		},
		rollupOptions: {
			external: [
				// Every node built-in, in both spellings. Left to a regex rather than a list because a
				// missing entry is a build that inlines a stub of `fs` and fails at runtime.
				/^node:/,
			],
		},
	},
});
