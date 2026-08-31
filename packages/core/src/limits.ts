import { ClientErrorCode, DeployError, type ManifestFile } from "./types";

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
	/** Maximum total size of the deploy, in bytes, measured after extraction. */
	readonly maxSiteBytes: number;
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
 */
const DOCUMENT_EXTENSIONS = [".md", ".markdown", ".pdf"];

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
 * Formats a byte count the way a person reads it.
 *
 * @param bytes Number of bytes.
 * @returns A short string such as `4.2 MB`.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
export function checkLimits(
	files: readonly ManifestFile[],
	limits: PlanLimits | null,
): void {
	if (files.length === 0) {
		throw new DeployError(
			ClientErrorCode.Empty,
			"That drop contained no files to deploy. Folders like .git and node_modules are skipped.",
		);
	}

	// Either an entry point or something to read. A folder of markdown or a lone PDF publishes as a
	// documents site, so requiring an index here would refuse a drop the server accepts — and refuse it
	// in the one place the user cannot argue with.
	const hasIndex = files.some((file) => file.path === REQUIRED_INDEX);
	if (!hasIndex && !files.some((file) => isDocumentPath(file.path))) {
		throw new DeployError(
			ClientErrorCode.MissingIndex,
			`A site needs an ${REQUIRED_INDEX} at its top level, or at least one .md or .pdf file to publish as a documents site. Drop the folder that contains it, not the folder above.`,
		);
	}

	if (!limits) return;

	if (files.length > limits.maxFiles) {
		throw new DeployError(
			ClientErrorCode.TooManyFiles,
			`That is ${files.length} files, and this plan allows ${limits.maxFiles}.`,
			{ limit: limits.maxFiles, actual: files.length },
		);
	}

	const oversized = files.find(
		(file) => file.bytes.length > limits.maxFileBytes,
	);
	if (oversized) {
		throw new DeployError(
			ClientErrorCode.FileTooLarge,
			`${oversized.path} is ${formatBytes(oversized.bytes.length)}, and this plan allows ${formatBytes(limits.maxFileBytes)} per file.`,
			{
				path: oversized.path,
				limit: limits.maxFileBytes,
				actual: oversized.bytes.length,
			},
		);
	}

	const total = totalBytes(files);
	if (total > limits.maxSiteBytes) {
		throw new DeployError(
			ClientErrorCode.TooLarge,
			`That drop is ${formatBytes(total)}, and this plan allows ${formatBytes(limits.maxSiteBytes)}.`,
			{ limit: limits.maxSiteBytes, actual: total },
		);
	}
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
export function shouldWarnAboutSize(
	files: readonly { bytes: Uint8Array }[],
): boolean {
	return totalBytes(files) > MOBILE_WARNING_BYTES;
}
