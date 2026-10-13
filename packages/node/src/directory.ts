import { stat } from "node:fs/promises";
import type { ProgressListener } from "@drop2run/core";
import type { Credentials } from "./credentials.js";
import { type NewSite, type PublishResult, publish } from "./publish.js";
import { directorySource } from "./source.js";

/**
 * Publishing a folder off the disk — the one kind of publish that needs a filesystem.
 *
 * Its own module so that `publish.ts` imports nothing from `node:`; see the note there.
 */

/**
 * Publishes a directory.
 *
 * <b>The folder is checked before anything is created.</b> The engine reads files only after it has a
 * site to publish them to, so a path that does not exist used to fail *after* a site had been made for
 * it — leaving an empty site behind and, when a subdomain was asked for, that name taken by it. The
 * second attempt then failed as "already taken" by the wreckage of the first. One `stat` ahead of the
 * request is the whole fix: nothing is created for a publish that cannot happen.
 *
 * @param credentials Token and base URL.
 * @param directory Absolute path of the folder to publish.
 * @param site Subdomain or site id, or undefined for a new site.
 * @param onProgress Receives every stage the engine reports. See {@link publish}.
 * @param newSite Name and folder for the site this creates. See {@link publish}.
 * @returns What to tell the caller.
 * @throws Error when the path does not exist or is not a directory.
 */
export async function publishDirectory(
	credentials: Credentials,
	directory: string,
	site?: string,
	onProgress?: ProgressListener,
	newSite: NewSite = {},
): Promise<PublishResult> {
	const found = await stat(directory).catch(() => null);

	if (found === null) throw new Error(`There is no folder at ${directory}.`);
	if (!found.isDirectory()) throw new Error(`${directory} is a file, not a folder to publish.`);

	return await publish(credentials, directorySource(directory), site, onProgress, newSite);
}
