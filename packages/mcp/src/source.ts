import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type CollectedFile, type DeploySource, shouldIgnore } from "@drop2run/core";

/**
 * Reads files off a disk, which is the half of the engine a browser supplies differently.
 *
 * `@drop2run/core` takes a {@link DeploySource} precisely so it does not know where files come from.
 * The browser hands it a `DataTransfer` or a zip; this hands it a directory. Nothing else about a
 * deploy differs between the two, which is the property that makes "it worked from the page" evidence
 * about publishing from a chat.
 *
 * The junk filter is {@link shouldIgnore} from the engine rather than a list of its own, for exactly
 * that reason: a second copy would mean one surface uploading a `.git` directory that the other
 * refuses.
 */

/**
 * How many files one publish may carry.
 *
 * A guard against pointing this at a home directory by mistake, not a product limit — the server
 * enforces the real one from the `plans` table. It is here because the failure it prevents happens
 * before any request: reading a million files into memory to build a manifest that would be rejected.
 */
const MAX_FILES = 20_000;

/**
 * Builds a source that reads a directory tree.
 *
 * @param root Absolute path of the directory to publish.
 * @returns A source the engine can call.
 */
export function directorySource(root: string): DeploySource {
	return async () => {
		const base = await realpath(root);
		const files: CollectedFile[] = [];
		await walk(base, base, files);

		return files;
	};
}

/**
 * Reads one directory into the accumulator, depth first.
 *
 * @param root The publish root, already resolved, which every path is relative to.
 * @param directory Directory being read.
 * @param into Accumulator, appended in place.
 */
async function walk(root: string, directory: string, into: CollectedFile[]): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		const path = relative(root, full).split(sep).join("/");

		// Checked on the path rather than the name, so a directory the engine excludes takes its whole
		// subtree with it without this loop needing to know which names those are.
		if (shouldIgnore(path)) continue;

		if (entry.isSymbolicLink()) {
			// Resolved, then tested against the root. A link pointing out of the tree is how a publish
			// becomes an exfiltration: aim one at ~/.ssh and the folder "published" carries a private key.
			// Skipped rather than followed, and silently, because a link nobody meant to publish is not a
			// reason to refuse the whole publish.
			const target = await realpath(full).catch(() => null);
			if (target === null || escapesRoot(root, target)) continue;

			const targeted = await stat(target);
			if (targeted.isDirectory()) {
				await walk(root, target, into);
				continue;
			}
			if (!targeted.isFile()) continue;
		} else if (entry.isDirectory()) {
			await walk(root, full, into);
			continue;
		} else if (!entry.isFile()) {
			// Sockets, fifos and devices. Reading one either blocks forever or returns nothing useful.
			continue;
		}

		if (into.length >= MAX_FILES) {
			throw new Error(
				`This folder holds more than ${MAX_FILES.toLocaleString()} files. Publish a build output ` +
					"directory rather than a whole project.",
			);
		}

		into.push({ path, bytes: new Uint8Array(await readFile(full)) });
	}
}

/**
 * Whether a resolved path has left the publish root.
 *
 * @param root The resolved publish root.
 * @param candidate Resolved path to test.
 * @returns True when it is outside, or is the root itself.
 */
function escapesRoot(root: string, candidate: string): boolean {
	const inside = relative(root, candidate);

	return inside === "" || inside.startsWith("..");
}
