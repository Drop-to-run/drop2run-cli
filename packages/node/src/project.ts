import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `drop2run.json`: which site a folder publishes to, so nobody has to remember.
 *
 * <b>Why a file in the project rather than a setting somewhere.</b> The alternative is `--site` on every
 * command, and the failure that produces is not forgetting to type it — it is typing it wrong, or leaving
 * it out, and publishing over the wrong site or creating a stray one. A file that travels with the folder
 * makes the right target the default and the wrong one something you have to ask for.
 *
 * <b>Committed or not is the owner's call.</b> A site id is not a secret — it names a site, and every
 * operation on it still needs a token — so a team sharing one in git is fine. Nothing here writes it to
 * `.gitignore` in either direction.
 */

/** The file's name, in the directory a command is run from. */
export const PROJECT_FILE = "drop2run.json";

/** What `drop2run.json` holds. */
export interface Project {
	/** ULID of the site this folder publishes to. */
	readonly siteId: string;
	/** Its subdomain, kept so a command can name the site without asking the API. */
	readonly subdomain: string;
	/**
	 * The folder to publish, relative to the file.
	 *
	 * Stored because a built site is almost never the directory the file is in — `dist`, `build`, `public`
	 * — and getting it wrong publishes a repository instead of a website.
	 */
	readonly dir: string;
}

/**
 * The path `drop2run.json` would have, in a given directory.
 *
 * @param directory Where to look, defaulting to the working directory.
 * @returns Absolute or relative path to the file, matching what was passed in.
 */
export function projectPath(directory: string = process.cwd()): string {
	return join(directory, PROJECT_FILE);
}

/**
 * Reads `drop2run.json`, if there is one.
 *
 * <b>Returns null rather than throwing, and a malformed file counts as none.</b> Most commands run
 * perfectly well without one, so a missing file is not an error — and treating an unparseable file as
 * absent keeps a stray comma from making `deploy` unusable rather than merely unconfigured. What it must
 * never do is guess: a file missing `siteId` is not a project, and reading it as one would send a publish
 * to a site chosen by accident.
 *
 * @param directory Where to look, defaulting to the working directory.
 * @param read Reads a file, injectable so a test does not need a real one.
 * @returns The project, or null when there is none to read.
 */
export function readProject(
	directory: string = process.cwd(),
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Project | null {
	let parsed: Partial<Project>;

	try {
		parsed = JSON.parse(read(projectPath(directory))) as Partial<Project>;
	} catch {
		return null;
	}

	if (typeof parsed.siteId !== "string" || parsed.siteId === "") return null;

	return {
		siteId: parsed.siteId,
		subdomain: typeof parsed.subdomain === "string" ? parsed.subdomain : "",
		dir: typeof parsed.dir === "string" && parsed.dir !== "" ? parsed.dir : ".",
	};
}

/**
 * Writes `drop2run.json`.
 *
 * Plain and readable rather than minified: this is a file people open, edit and put in code review, and
 * the trailing newline is there so appending to it in a shell does not produce a broken line.
 *
 * @param project What to write.
 * @param directory Where to write it, defaulting to the working directory.
 * @returns The path written to.
 */
export function writeProject(project: Project, directory: string = process.cwd()): string {
	const path = projectPath(directory);

	writeFileSync(path, `${JSON.stringify(project, null, "\t")}\n`);

	return path;
}
