import { join, relative, sep } from "node:path";
import type { CollectedFile, DeploySource } from "@drop2run/core";

/**
 * Bundling a folder's `_functions/` before it is published (docs/briefs/FUNCTIONS-BRIEF.md D6, §4.6).
 *
 * <b>Why the CLI bundles.</b> The platform runs each route as a module with no build step on the server (D6):
 * an import of an npm package by name — `import Stripe from "stripe"` — has nothing to resolve against at the
 * edge and fails when the route first loads. Bundling here, on the machine that has `node_modules`, turns every
 * route into one self-contained module, so the same folder works whether its functions import packages or not.
 * TypeScript routes come out as JavaScript on the way.
 *
 * <b>What is sent.</b> One bundled module per route, at the route's own path (`.ts` becomes `.js`, `.mts`
 * becomes `.mjs`), and nothing else from `_functions/`: helpers — any file or folder starting with `_` — are
 * inlined into the routes that import them, so they have no reason to travel on their own.
 *
 * <b>Not a security boundary</b>, as D6 says of every lint: the server never trusts what arrives here.
 */

/** The folder, as a prefix of a published path, that holds a site's functions. */
export const FUNCTIONS_DIR = "_functions/";

/** What a route's file may be called: JavaScript or TypeScript, as a module. */
const ROUTE_SOURCE = /\.(?:m?js|m?ts)$/;

/** A bundled route as the bundler reports it: where it goes under `_functions/`, and its bytes. */
export interface BundledRoute {
	/** The path under `_functions/`, `/`-separated — `api/users/[id].js`. */
	readonly path: string;
	/** The module. */
	readonly bytes: Uint8Array;
}

/**
 * Bundles route files into self-contained modules. Injectable so a test can check what the CLI sends without
 * running esbuild; the CLI passes {@link esbuildBundler}.
 */
export type Bundler = (
	root: string,
	entries: readonly string[],
) => Promise<readonly BundledRoute[]>;

/**
 * Whether a path under `_functions/` is a helper rather than a route: any segment starts with `_` (D5).
 *
 * @param path The path relative to `_functions/`.
 * @returns True for `_lib/db.js`, `api/_util.ts` and the like.
 */
export function isHelper(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("_"));
}

/**
 * The routes a folder's `_functions/` declares, as paths under it: every JavaScript or TypeScript module that is
 * not a helper and not a type declaration.
 *
 * @param files What the folder holds.
 * @returns The route files, in the order read.
 */
export function routeEntries(files: readonly CollectedFile[]): string[] {
	return files
		.filter((file) => file.path.startsWith(FUNCTIONS_DIR))
		.map((file) => file.path.slice(FUNCTIONS_DIR.length))
		.filter((path) => ROUTE_SOURCE.test(path) && !/\.d\.m?ts$/.test(path) && !isHelper(path));
}

/**
 * Wraps a folder's source so its `_functions/` is replaced by bundled routes before anything is hashed.
 *
 * A folder without `_functions/`, or whose `_functions/` holds no route, passes through untouched: there is
 * nothing to bundle, and the server answers for the folder as it always did.
 *
 * @param source What reads the folder.
 * @param root Absolute path of the folder, which every published path is relative to.
 * @param bundler Turns the route files into modules.
 * @returns A source that sends the bundled routes in place of `_functions/`.
 */
export function withBundledFunctions(
	source: DeploySource,
	root: string,
	bundler: Bundler = esbuildBundler,
): DeploySource {
	return async (signal, onRead) => {
		const files = await source(signal, onRead);
		const entries = routeEntries(files);
		if (entries.length === 0) return files;

		const routes = await bundler(root, entries);

		return [
			...files.filter((file) => !file.path.startsWith(FUNCTIONS_DIR)),
			...routes.map((route) => ({ path: FUNCTIONS_DIR + route.path, bytes: route.bytes })),
		];
	};
}

/**
 * Bundles with esbuild, the way the platform runs the result: an ES module, no Node built-ins, the packages'
 * Worker and browser builds preferred over their Node ones.
 *
 * Loaded on first use rather than at start-up, so a publish without `_functions/` never pays for it, and a
 * machine where its native binary failed to install can still publish everything else.
 *
 * @param root Absolute path of the folder being published.
 * @param entries Route files, relative to its `_functions/`.
 * @returns One module per route.
 * @throws Error naming each file esbuild could not bundle, and why.
 */
export async function esbuildBundler(
	root: string,
	entries: readonly string[],
): Promise<readonly BundledRoute[]> {
	const esbuild = await import("esbuild");
	const outdir = join(root, FUNCTIONS_DIR);

	try {
		const result = await esbuild.build({
			absWorkingDir: root,
			entryPoints: entries.map((entry) => join(outdir, entry)),
			outbase: outdir,
			outdir,
			bundle: true,
			format: "esm",
			// Neither node nor browser: functions have no Node built-ins (no `nodejs_compat`, D3), and a browser
			// build would pull in `window`. The conditions below still pick a package's Worker or browser build.
			platform: "neutral",
			conditions: ["workerd", "worker", "browser", "import", "default"],
			mainFields: ["browser", "module", "main"],
			target: "es2022",
			write: false,
			splitting: false,
			minify: false,
			legalComments: "none",
			logLevel: "silent",
		});

		// esbuild names every output `.js`; an `.mjs` or `.mts` route keeps the `.mjs` the platform also accepts.
		return result.outputFiles.map((file) => ({
			path: relative(outdir, file.path)
				.split(sep)
				.join("/")
				.replace(/\.js$/, extensionFor(file.path, entries, outdir)),
			bytes: file.contents,
		}));
	} catch (error) {
		throw bundleFailure(root, error);
	}
}

/**
 * The extension a bundled route keeps: `.mjs` for an `.mjs` or `.mts` source, `.js` for the rest.
 *
 * @param output The bundled file's absolute path, always ending `.js`.
 * @param entries Route files, relative to `_functions/`.
 * @param outdir Absolute path of `_functions/`.
 * @returns The extension.
 */
function extensionFor(output: string, entries: readonly string[], outdir: string): string {
	const stem = relative(outdir, output).split(sep).join("/").replace(/\.js$/, "");
	return entries.some((entry) => entry.replace(/\.m[jt]s$/, "") === stem && /\.m[jt]s$/.test(entry))
		? ".mjs"
		: ".js";
}

/**
 * The error a failed bundle becomes: each of esbuild's messages with its file and line, and the two causes
 * worth naming outright.
 *
 * @param root Absolute path of the folder, so files are named relative to it.
 * @param error What esbuild threw.
 * @returns The error to report.
 */
function bundleFailure(root: string, error: unknown): Error {
	const messages =
		(error as { errors?: { text: string; location?: { file: string; line: number } | null }[] })
			.errors ?? [];
	if (messages.length === 0) return error instanceof Error ? error : new Error(String(error));

	const lines = messages.slice(0, 5).map((message) => {
		const where = message.location
			? `${relative(root, join(root, message.location.file)).split(sep).join("/")}:${message.location.line}: `
			: "";
		return `  ${where}${message.text}`;
	});
	const builtIn = messages.some((message) =>
		/"node:|Could not resolve "(fs|path|crypto|os|http|https|stream|buffer)"/.test(message.text),
	);
	const unresolved = messages.some((message) => message.text.startsWith("Could not resolve"));

	return new Error(
		[
			"Could not bundle _functions/:",
			...lines,
			...(messages.length > 5 ? [`  … and ${messages.length - 5} more`] : []),
			...(builtIn
				? [
						"Functions run without Node's built-ins. Use the web APIs instead: fetch, crypto.subtle, URL, TextEncoder.",
					]
				: unresolved
					? [
							"Install the package in this folder (npm install) so it can be bundled, or check the import's spelling.",
						]
					: []),
			"To publish _functions/ as it is, without bundling, add --no-bundle.",
		].join("\n"),
	);
}
