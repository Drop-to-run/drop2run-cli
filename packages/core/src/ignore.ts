/**
 * Paths that are never part of a published site.
 *
 * <b>Why this is in the engine rather than beside whichever collector needs it.</b> A folder published
 * from a browser and the same folder published from a chat or a CLI have to produce the same site, and
 * this list is the whole difference between publishing a project and publishing a project's `.git`. Two
 * copies of it would mean one surface quietly uploading what the other refuses — and the one that
 * refuses is the one everybody tested with.
 *
 * Filtered by the caller, before the manifest exists. The server does not know these are junk, so this
 * is the only thing keeping them out.
 */

/** File names dropped wherever they appear. */
const IGNORED_EXACT = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".gitignore", ".gitkeep"]);

/**
 * Directory names whose entire subtree is skipped.
 *
 * `.claude` sits with `.idea` and `.vscode` rather than being a special case: all three are tool
 * configuration that happens to live in the folder somebody publishes, and none of it belongs on a
 * website. It was found the way the others must have been — a publish from a project folder carried
 * `.claude/launch.json` up with the site.
 */
const IGNORED_DIRECTORIES = [
	"__MACOSX",
	".git",
	"node_modules",
	".svn",
	".hg",
	".idea",
	".vscode",
	".claude",
];

/**
 * Whether a collected path should be dropped before it reaches the manifest.
 *
 * @param path Path relative to the publish root, `/`-separated.
 * @returns True when the file must not be uploaded.
 */
export function shouldIgnore(path: string): boolean {
	const segments = path.split("/");
	const name = segments.at(-1) ?? "";

	if (name === "" || IGNORED_EXACT.has(name)) return true;

	// AppleDouble sidecars, which macOS writes into zips next to the real file.
	if (name.startsWith("._")) return true;

	return segments.some((segment) => IGNORED_DIRECTORIES.includes(segment));
}
