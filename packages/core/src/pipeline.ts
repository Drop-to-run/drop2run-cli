import { type ApiOptions, completeDeploy, prepareDeploy } from "./api.js";
import { hashAll } from "./hash.js";
import { checkLimits, type PlanLimits } from "./limits.js";
import { suggestSiteName } from "./title.js";
import type { CollectedFile, ProgressListener } from "./types.js";
import { asDeployError, type UploadDeps, uploadAll } from "./upload.js";

/**
 * Orchestrates one deploy, from a set of files to a live URL.
 *
 * The whole sequence lives here so the browser and the CLI share it: neither knows about hashing,
 * retries or the API, only about {@link ProgressListener} events.
 */

/**
 * Where the files come from.
 *
 * <b>The one thing this package does not know.</b> A browser has them as `File` objects behind a
 * `DataTransfer` or a zip; a CLI reads them off a disk; neither belongs here, and an engine that
 * imported either would be portable only to the place it imported from. This used to dispatch on the
 * shape of its argument and reach into the browser collector to do it, which is exactly what stopped
 * the engine being reusable.
 *
 * Called inside the deploy's own try, so a source that throws reports through
 * {@link ProgressListener} like every other failure rather than escaping past it.
 *
 * @param signal Aborts reading.
 * @returns The files to publish, already named.
 */
export type DeploySource = (
	signal?: AbortSignal,
) => Promise<readonly CollectedFile[]>;

/** Everything the caller can vary, separate from the four documented arguments. */
export interface DeployOptions extends ApiOptions {
	/**
	 * Limits to pre-check against, from `GET /api/plans`. Omitted when the caller could not load them,
	 * which skips the numeric part of the check rather than guessing a tier — guessing was the old
	 * behaviour, and it defaulted an anonymous drop to the larger free limits, so the pre-check passed and
	 * the server then rejected it: exactly the round trip the check exists to save.
	 */
	readonly limits?: PlanLimits;
	/** Upload tuning and injectable dependencies, for tests. */
	readonly upload?: UploadDeps;
}

/**
 * Runs a deploy to completion.
 *
 * @param source Reads the files to publish. See {@link DeploySource}.
 * @param siteId Site to deploy to.
 * @param onProgress Receives every stage transition, ending in `done` or `error`.
 * @param signal Cancels the deploy; already-uploaded files are left for the GC job to clean up.
 * @param options API access, plan limits, and upload tuning.
 * @returns Nothing. Success and failure are both reported through {@link onProgress}, and a failure is
 *   additionally thrown so a caller that prefers try/catch can use it.
 */
export async function deploy(
	source: DeploySource,
	siteId: string,
	onProgress: ProgressListener,
	signal?: AbortSignal,
	options: DeployOptions = {},
): Promise<void> {
	try {
		const files = await source(signal);
		onProgress({ type: "collecting", files: files.length });

		const hashed = await hashAll(
			files,
			(done, total) => onProgress({ type: "hashing", done, total }),
			signal,
		);

		// Checked before the API is called, so an oversized drop fails instantly rather than after the
		// round trip. The server checks all of this again — this is UX, not enforcement.
		checkLimits(hashed, options.limits ?? null);

		onProgress({ type: "preparing" });
		const prepared = await prepareDeploy(siteId, hashed, options, signal);

		// The server recognised the whole manifest as what it already serves and created no deploy, so
		// there is nothing to upload and nothing to complete. Checked before any other use of the
		// response: `deployId` here is the version already live, and completing that would rewrite the
		// mapping to where it already points.
		if (prepared.unchanged) {
			onProgress({ type: "unchanged", url: prepared.url ?? "" });
			return;
		}

		// Progress is reported against the whole deploy, not against the upload list. A redeploy that
		// changed three files out of five hundred uploads three, and "3 of 3 files" would read as though
		// the other 497 had been lost — so the files the server is reusing are counted as already done.
		await uploadAll(
			prepared.upload,
			prepared.uploadUrl,
			hashed,
			(done, _total, bytes) =>
				onProgress({
					type: "uploading",
					done: prepared.reused + done,
					total: prepared.total,
					bytes,
					reused: prepared.reused,
				}),
			signal,
			options.upload,
		);

		onProgress({ type: "completing", reused: prepared.reused });

		// Read from the files already in hand rather than fetched back from the site, and sent with the
		// call that takes the deploy live so a site is named by the same request that publishes it. The
		// server ignores it for a site that already has a name.
		const completed = await completeDeploy(
			siteId,
			prepared.deployId,
			options,
			signal,
			suggestSiteName(files),
		);

		onProgress({ type: "done", url: completed.url, name: completed.name });
	} catch (error) {
		const failure = asDeployError(error);

		onProgress({
			type: "error",
			code: failure.code,
			message: failure.message,
			...(failure.detail === undefined ? {} : { detail: failure.detail }),
		});

		throw failure;
	}
}
