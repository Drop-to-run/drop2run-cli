import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Plain node, one project. Everything here is server-side by definition — a package that needed jsdom
 * would be a package that had stopped being the non-browser half.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@drop2run/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
