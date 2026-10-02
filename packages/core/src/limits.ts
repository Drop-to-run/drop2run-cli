import {
	extensionOf,
	GALLERY_EXTENSIONS,
	DOCUMENT_EXTENSIONS as TABLE_DOCUMENT_EXTENSIONS,
	VIEWABLE_EXTENSIONS as TABLE_VIEWABLE_EXTENSIONS,
	WEB_ASSET_EXTENSIONS,
} from "./fileTypes.js";
import { ClientErrorCode, DeployError, type ManifestFile } from "./types.js";

/**
 * The pre-upload check.
 *
 * It exists purely so the user gets a clear message before a large upload starts instead of a rejection
 * after it. **The server enforces every one of these independently** — a patched client can change the
 * numbers it passes in and gain nothing.
 *
 * No numbers live here. They come from `GET /api/plans`, which serves the same table the server enforces
 * from; see `src/lib/plans.ts`. Copies used to live here and drifted silently.
 */

/**
 * The subset of a plan this check needs.
 *
 * Field names match the API's, so a `Plan` from `src/lib/plans.ts` can be passed straight in without a
 * mapping step — a mapping step is where a wrong-field bug would hide.
 */
export interface PlanLimits {
	/**
	 * Maximum total size of the deploy, in bytes, measured after extraction — or null when the tier
	 * bounds what the account holds in total rather than what one publish may be.
	 */
	readonly maxSiteBytes: number | null;
	/** Maximum size of one file, in bytes. */
	readonly maxFileBytes: number;
	/** Maximum number of files. */
	readonly maxFiles: number;
}

/**
 * Size above which mobile Safari is likely to run out of memory while unzipping.
 * Not a rejection — the user is warned and may continue.
 */
export const MOBILE_WARNING_BYTES = 100 * 1024 * 1024;

/** The file whose presence at the root makes a drop an ordinary static site. */
const REQUIRED_INDEX = "index.html";

/**
 * Extensions that let a drop with no `index.html` be published as a documents site.
 *
 * ⚠️ Mirrors `SiteModeDetection` in `apps/api` — the server holds the same set, and this copy exists only
 * so a drop that will be refused is refused before it is hashed and uploaded. Narrower here than there and
 * a drop is rejected in the browser that the server would have taken; wider and the user watches an upload
 * run to completion before being told no.
 *
 * Read from {@link FILE_TYPES} rather than written out. The list used to be here, next to a second one
 * whose relationship to it was described in prose; both are now columns of one table.
 */
const DOCUMENT_EXTENSIONS = TABLE_DOCUMENT_EXTENSIONS;

/**
 * Whether a path is a document the viewer can open on its own.
 *
 * Exported so the confirmation screen can ask the same question `checkLimits` will ask a moment later.
 * It used to be private, and the screen had no way to know a folder of markdown was publishable — so it
 * warned "No index.html" over a drop the service accepts. A second copy of the extension list would have
 * fixed that display and started the drift this comment exists to prevent.
 *
 * @param path A normalized manifest path.
 * @returns True when its extension is one the documents viewer handles.
 */
export function isDocumentPath(path: string): boolean {
	const lower = path.toLowerCase();

	return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Extensions the viewer can render, which make a drop of **exactly one file** publishable.
 *
 * ⚠️ Mirrors `_viewableExtensions` in `SiteModeDetection`, which in turn mirrors `kindOf` in
 * `apps/viewer/src/paths.ts` minus its `binary` fallback. Three lists, one fact, and no compiler
 * between them: widen the viewer without widening these and a file the product can display is refused
 * before it is uploaded; widen these without the viewer and a published file is handed back as a
 * download. Both of the other two are now checked against {@link FILE_TYPES} by a test of their own.
 *
 * Only ever asked of a single-file drop, and that bound is the point rather than an omission. Nearly
 * every web project folder holds a `.json` or a `.css`, so counting these at any size would take a
 * `dist/assets/` dropped instead of `dist/` and publish it as a documents site of JavaScript bundles
 * — instead of the refusal that says which folder to drop. One file has no such ambiguity: there is
 * nothing else it could have been part of, and the person picked that exact file.
 *
 * `.html` is in here as a floor. {@link renameOfLoneHtmlPage} turns a lone HTML file into the
 * `index.html` it plainly is, so the normal path never reaches this entry; a caller that skips the
 * rename should still get a readable one-file site rather than a rejection.
 */
const VIEWABLE_EXTENSIONS = TABLE_VIEWABLE_EXTENSIONS;

/**
 * Whether a path is a file the viewer can render.
 *
 * Wider than {@link isDocumentPath}, and only meaningful for a drop of one file — see
 * {@link VIEWABLE_EXTENSIONS} for why both halves of that are true.
 *
 * @param path A normalized manifest path.
 * @returns True when its extension is one the viewer renders.
 */
export function isViewablePath(path: string): boolean {
	const lower = path.toLowerCase();

	return VIEWABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Whether a set of paths is a folder of pictures, and so is something to look at rather than run.
 *
 * <b>Two halves, and neither works alone.</b> At least one picture, and not one script, stylesheet or
 * page anywhere in the drop. Somebody who has just generated thirty images has the first and not the
 * second; somebody who dragged `dist/assets/` instead of `dist/` has both, and gets the refusal that
 * names the folder to drop rather than a site nobody asked for.
 *
 * ⚠️ This is the first rule about a drop that cannot be asked of one path. {@link isDocumentPath}
 * answers "is this file a document"; this one has no per-file answer, because a `.png` means a gallery
 * in one drop and a sprite in another. Mirrored by `SiteModeDetection.IsImageFolder` in `apps/api`,
 * which has the same shape for the same reason.
 *
 * @param paths Normalized manifest paths.
 * @returns True when the drop is a folder of pictures.
 */
export function isImageFolder(paths: readonly string[]): boolean {
	let pictures = false;

	for (const path of paths) {
		const ext = extensionOf(path);

		if (WEB_ASSET_EXTENSIONS.includes(ext)) return false;
		if (GALLERY_EXTENSIONS.includes(ext)) pictures = true;
	}

	return pictures;
}

/**
 * Whether a set of paths leaves something at the root of a site, and so can be published at all.
 *
 * Four rules, the same four `SiteModeDetection.CanServe` applies on the server and in the same order:
 * an `index.html` at the root, or one document at any depth, or a folder of pictures, or a single file
 * the viewer can render.
 *
 * Exported so the confirmation screen and {@link checkLimits} cannot answer it differently — the screen
 * used to compute its own version and told people a folder of markdown had no index page.
 *
 * @param paths Normalized manifest paths.
 * @returns True when the drop can be published.
 */
export function canPublish(paths: readonly string[]): boolean {
	if (paths.some((path) => path === REQUIRED_INDEX)) return true;
	if (paths.some(isDocumentPath)) return true;
	if (isImageFolder(paths)) return true;

	return paths.length === 1 && paths[0] !== undefined && isViewablePath(paths[0]);
}

/**
 * The name a lone HTML page is about to be published under, when it is not already `index.html`.
 *
 * <b>A single dropped `page.html` is a page, and a page wants to be the site's root.</b> Left alone it
 * would publish as a one-file documents site whose only content is a link to itself, because the viewer
 * deliberately does not render HTML inline — a customer's page is a page, and framing it inside the
 * reader's chrome would put two documents on one screen. Renaming it makes the address the person
 * actually wanted: the site's root serves their page.
 *
 * Reported as a rename rather than applied silently. The published URL is the thing somebody is about to
 * share, so a step that changes which file answers it has to be visible on the confirmation screen
 * before anything is uploaded.
 *
 * Only for one file. In a folder, `page.html` is a page of a site among others and renaming it would
 * decide which page is the front door — a choice that belongs to whoever built the folder.
 *
 * @param paths Normalized manifest paths.
 * @returns The path that will be renamed to `index.html`, or null when nothing will be.
 */
export function renameOfLoneHtmlPage(paths: readonly string[]): string | null {
	if (paths.length !== 1) return null;

	const [only] = paths;
	if (only === undefined || only === REQUIRED_INDEX) return null;

	const lower = only.toLowerCase();

	return lower.endsWith(".html") || lower.endsWith(".htm") ? only : null;
}

/**
 * Formats a byte count the way a person reads it.
 *
 * @param bytes Number of bytes.
 * @returns A short string such as `4.2 MB`.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

	// The scale stopped at MB, which was right while the only thing measured here was one deploy. It is
	// also used for an account's total storage, and that is where it broke down: 1.8 GB in use read as
	// "1843.2 MB", and a Pro account near its ceiling as "51200.0 MB" — a figure nobody converts in
	// their head, next to a limit already written as "50 GB".
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Checks a manifest against a plan before anything is sent.
 *
 * @param files The hashed manifest.
 * @param limits Limits of the caller's plan, or null when they could not be loaded. Null skips the
 * numeric checks and keeps the structural ones — the server enforces the numbers regardless, so a
 * failed `GET /api/plans` should cost the user a round trip, not their deploy.
 * @throws DeployError When the drop cannot be deployed as it stands.
 */
export function checkLimits(files: readonly ManifestFile[], limits: PlanLimits | null): void {
	if (files.length === 0) {
		throw new DeployError(
			ClientErrorCode.Empty,
			"That drop contained no files to deploy. Folders like .git and node_modules are skipped.",
		);
	}

	// Either an entry point, something to read, or one file worth reading on its own. A folder of
	// markdown, a lone PDF and a lone note all publish, so requiring an index here would refuse drops the
	// server accepts — and refuse them in the one place the user cannot argue with.
	//
	// `canPublish` rather than the branches inlined: the server asks the same three questions through
	// `SiteModeDetection.CanServe`, and this copy exists only to fail fast. Narrower than the server and
	// the browser refuses what the service would have taken; wider and somebody watches an upload finish
	// before being told no.
	if (!canPublish(files.map((file) => file.path))) {
		throw new DeployError(
			ClientErrorCode.MissingIndex,
			`A site needs an ${REQUIRED_INDEX} at its top level, or at least one .md or .pdf file to publish as a documents site — or be a single file that can be displayed on its own, such as a note, a PDF, a page or an image. Drop the folder that contains it, not the folder above.`,
		);
	}

	const refusal = sizeRefusal(
		files.map((file) => ({ path: file.path, size: file.bytes.length })),
		limits,
	);

	if (refusal) throw refusal;
}

/**
 * A file whose size is known, whether or not its bytes have been read.
 *
 * What a `File` handle already carries, which is what makes {@link sizeRefusal} askable on the
 * confirmation screen — before anything is hashed, and before a site exists to publish to.
 */
export interface SizedFile {
	/** Path relative to the drop root. */
	readonly path: string;
	/** Size in bytes. */
	readonly size: number;
}

/**
 * The half of {@link checkLimits} that is arithmetic: how many files, how big each one is, how big the
 * drop is in total.
 *
 * Returns the refusal rather than throwing it, because it is asked from two places that want two
 * different things with the same answer. {@link checkLimits} throws it, as the pipeline has always
 * done. The confirmation screen renders it beside the drop's listing and disables Publish — and that
 * screen is the one that matters here: a site is reserved the moment somebody confirms, so a drop
 * refused only after `hashAll` had already cost them a subdomain and a slot for a folder that was
 * never going to publish.
 *
 * Split out rather than copied for the reason this file keeps repeating: two implementations of one
 * rule answer differently the first time either is edited. This is the implementation; `checkLimits`
 * is a caller of it.
 *
 * @param files Every file in the drop, with its size.
 * @param limits Limits of the caller's plan, or null when they could not be loaded — which skips
 *   every check here, since the server enforces the numbers regardless.
 * @returns The refusal, or null when the drop is within the plan.
 */
export function sizeRefusal(
	files: readonly SizedFile[],
	limits: PlanLimits | null,
): DeployError | null {
	if (!limits) return null;

	if (files.length > limits.maxFiles) {
		return new DeployError(
			ClientErrorCode.TooManyFiles,
			`That is ${files.length} files, and this plan allows ${limits.maxFiles}.`,
			{ limit: limits.maxFiles, actual: files.length },
		);
	}

	const oversized = files.find((file) => file.size > limits.maxFileBytes);
	if (oversized) {
		return new DeployError(
			ClientErrorCode.FileTooLarge,
			`${oversized.path} is ${formatBytes(oversized.size)}, and this plan allows ${formatBytes(limits.maxFileBytes)} per file.`,
			{
				path: oversized.path,
				limit: limits.maxFileBytes,
				actual: oversized.size,
			},
		);
	}

	// Null is not "no check" by accident: a tier with no per-publish ceiling is bounded by what the
	// account already holds, and the browser has no way to know that figure. The server does, and it is
	// where the refusal has to come from anyway — so this check steps aside rather than guessing.
	const total = files.reduce((sum, file) => sum + file.size, 0);
	if (limits.maxSiteBytes !== null && total > limits.maxSiteBytes) {
		return new DeployError(
			ClientErrorCode.TooLarge,
			`That drop is ${formatBytes(total)}, and this plan allows ${formatBytes(limits.maxSiteBytes)}.`,
			{ limit: limits.maxSiteBytes, actual: total },
		);
	}

	return null;
}

/**
 * What can be refused about a `.zip` before it is opened: its compressed size against the per-publish
 * ceiling, and nothing else.
 *
 * Not {@link sizeRefusal} with the archive as a one-entry drop. That is what the confirmation screen
 * used to do, and it weighed the whole archive against `maxFileBytes` — so a 200 MB zip of small pages,
 * well inside a 250 MB-per-publish plan, was refused as "200 MB, and this plan allows 10 MB per file".
 * The compressed size bounds what the archive expands to in total, never the size of any one entry in
 * it. The per-file and file-count checks run once the entries exist: while the archive is expanded,
 * and again in {@link checkLimits} on what came out.
 *
 * Shared by the confirmation screen and the zip reader, so the two cannot word or measure this
 * differently.
 *
 * @param archive The archive's name and compressed size.
 * @param limits Limits of the caller's plan, or null when they could not be loaded.
 * @returns The refusal, or null when the archive may be opened.
 */
export function archiveRefusal(archive: SizedFile, limits: PlanLimits | null): DeployError | null {
	// A tier with no per-publish ceiling has no figure to refuse against here; the server still does.
	if (limits?.maxSiteBytes == null || archive.size <= limits.maxSiteBytes) return null;

	return new DeployError(
		ClientErrorCode.ZipTooLarge,
		`${archive.path} is ${formatBytes(archive.size)} compressed, and this plan allows ${formatBytes(limits.maxSiteBytes)} per site.`,
		{ limit: limits.maxSiteBytes, actual: archive.size },
	);
}

/**
 * Sums the size of every file.
 *
 * @param files Files to measure.
 * @returns Total bytes.
 */
export function totalBytes(files: readonly { bytes: Uint8Array }[]): number {
	return files.reduce((sum, file) => sum + file.bytes.length, 0);
}

/**
 * Whether the drop is big enough to warn a mobile user about.
 *
 * @param files Files to measure.
 * @returns True when a warning is warranted.
 */
export function shouldWarnAboutSize(files: readonly { bytes: Uint8Array }[]): boolean {
	return totalBytes(files) > MOBILE_WARNING_BYTES;
}
