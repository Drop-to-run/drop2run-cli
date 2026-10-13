import { fileURLToPath } from "node:url";
import type { Alias } from "vite";

/**
 * How this package's builds and tests find the sibling packages it is not installed with.
 *
 * <b>One list for all three configs.</b> `vite.config.ts` (npm), `vite.mcpb.config.ts` (the `.mcpb`
 * bundle) and `vitest.config.ts` each used to carry their own copy. When `@drop2run/node/portable` was
 * added, two copies were updated and the `.mcpb` one was not: the gate's bundle step builds only the npm
 * config, so everything was green, and the first build to notice would have been `deploy-web.yml` on main.
 *
 * <b>Exact matches, as a list.</b> A string key in Vite's alias object also matches as a prefix, so
 * `"@drop2run/node"` turns `"@drop2run/node/portable"` into `.../node/src/index.ts/portable`.
 */
export const ALIASES: Alias[] = [
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
];
