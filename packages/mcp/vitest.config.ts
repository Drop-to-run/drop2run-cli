import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Plain node, one project. Everything here is server-side by definition — a package that needed jsdom
 * would be a package that had stopped being the non-browser half.
 */
export default defineConfig({
	resolve: {
		// Exact matches; see vite.config.ts for why not an object.
		alias: [
			{
				find: /^@drop2run\/core$/,
				replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
			},
			{
				find: /^@drop2run\/node$/,
				replacement: fileURLToPath(new URL("../node/src/index.ts", import.meta.url)),
			},
			{
				find: /^@drop2run\/node\/portable$/,
				replacement: fileURLToPath(new URL("../node/src/portable.ts", import.meta.url)),
			},
		],
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
