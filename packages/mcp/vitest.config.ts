import { defineConfig } from "vitest/config";
import { ALIASES } from "./aliases.js";

/**
 * Plain node, one project. Everything here is server-side by definition — a package that needed jsdom
 * would be a package that had stopped being the non-browser half.
 */
export default defineConfig({
	resolve: {
		alias: ALIASES,
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
