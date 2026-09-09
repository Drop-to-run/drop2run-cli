import { canPublish, isDocumentPath, renameOfLoneHtmlPage } from "./limits.js";
import type { DroppedFile } from "./types.js";

/**
 * What was dropped, described well enough to be shown to a person before anything is uploaded.
 *
 * Built entirely from `File` handles: a dropped folder arrives as {@link DroppedFile}s that already
 * carry a path and a size, so every figure here is known without reading a single byte, without a
 * request, and without hashing. That is the whole reason a confirmation step is affordable — it costs
 * nothing but a render.
 *
 * A `.zip` is the exception and is described as {@link ArchiveSummary}: its contents do not exist until
 * fflate has expanded it, and expanding megabytes of archive on the main thread to populate a list is
 * not worth freezing the page for. What is still true for both is the promise the page makes — nothing
 * leaves the machine until the visitor confirms.
 */
export type DropSummary = FolderSummary | ArchiveSummary;

/** One row of the top-level listing: either a folder, collapsed, or a file. */
export type SummaryEntry =
	| {
			readonly kind: "folder";
			/** Folder name, without a trailing slash. */
			readonly name: string;
			/** Files anywhere beneath it, at any depth. */
			readonly files: number;
			/** Total size of those files. */
			readonly bytes: number;
	  }
	| {
			readonly kind: "file";
			readonly name: string;
			readonly bytes: number;
	  };

/** A dropped folder, counted and listed one level deep. */
export interface FolderSummary {
	readonly kind: "folder";
	/** Every file in the drop, at any depth. */
	readonly files: number;
	/** Total bytes of all of them. */
	readonly bytes: number;
	/** Distinct top-level folders. */
	readonly folders: number;
	/** Whether there is an `index.html` at the top level, which makes this an ordinary static site. */
	readonly hasIndexHtml: boolean;
	/**
	 * How many `.md`, `.markdown` or `.pdf` files there are, at any depth.
	 *
	 * A drop with no `index.html` is still publishable when it has one of these — it goes up as a
	 * documents site. Counted rather than flagged so the screen can say what kind of drop this is
	 * instead of only that it is allowed.
	 */
	readonly documents: number;
	/**
	 * Whether this drop can be published at all.
	 *
	 * The same question {@link checkLimits} asks a moment later and from the same predicate, which is
	 * the point: anything this reports as publishable must not then be refused in the browser, and
	 * anything it refuses must be something the caller can stop before an upload starts.
	 */
	readonly publishable: boolean;
	/**
	 * The file about to be renamed to `index.html`, or null when none is.
	 *
	 * Only ever set for a drop of one HTML page, which publishes as the site's root rather than as a
	 * one-file documents site holding a link to itself. Reported rather than done quietly: the renamed
	 * file is the one that answers the URL somebody is about to share, so the screen has to say so
	 * before anything is uploaded.
	 */
	readonly renamedToIndex: string | null;
	/**
	 * Whether this looks like a project rather than a project's build output — the single most common
	 * mistake this product has.
	 *
	 * Two signals together, never one: no `index.html` at the top level, AND something that only a
	 * source tree carries. A `package.json` on its own proves nothing, because a built site may well
	 * ship one; a missing `index.html` on its own is already reported separately and might just be a
	 * misspelling. It is the pair that identifies the mistake.
	 */
	readonly looksLikeProject: boolean;
	/**
	 * The top level, folders first and heaviest first inside each group.
	 *
	 * Sorted by size rather than by name because the ordering is doing work: when somebody has dropped a
	 * source tree, `node_modules/` is both the heaviest thing in it and the proof, so weight-first
	 * ordering puts the answer on the first row instead of somewhere down an alphabet.
	 */
	readonly entries: readonly SummaryEntry[];
}

/** A dropped `.zip`, which cannot be listed without expanding it first. */
export interface ArchiveSummary {
	readonly kind: "archive";
	readonly name: string;
	readonly bytes: number;
}

/** Names that only ever appear in a source tree, never in something already built. */
const PROJECT_MARKERS = new Set(["node_modules", "src", ".git", "vendor"]);

/**
 * Describes a payload for the confirmation screen.
 *
 * @param payload What {@link readDrop} returned: a folder's files, or one archive.
 * @returns The summary to render.
 */
export function summarise(payload: readonly DroppedFile[] | File): DropSummary {
	if (!Array.isArray(payload)) {
		const file = payload as File;
		return { kind: "archive", name: file.name, bytes: file.size };
	}

	const dropped = payload as readonly DroppedFile[];
	const folders = new Map<string, { files: number; bytes: number }>();
	const files: { name: string; bytes: number }[] = [];
	let bytes = 0;
	let hasIndexHtml = false;
	let documents = 0;

	for (const entry of dropped) {
		bytes += entry.file.size;

		// At any depth, matching how `checkLimits` looks for one — a documents site is a folder of
		// markdown, and requiring the markdown to be at the root would refuse most of them.
		if (isDocumentPath(entry.path)) documents += 1;

		const slash = entry.path.indexOf("/");

		if (slash === -1) {
			files.push({ name: entry.path, bytes: entry.file.size });
			// Paths from the pipeline are already normalised and lower-cased comparison is safe here:
			// the server derives the real answer from the manifest, and this only decides what to show.
			if (entry.path.toLowerCase() === "index.html") hasIndexHtml = true;
			continue;
		}

		const top = entry.path.slice(0, slash);
		const seen = folders.get(top);

		if (seen === undefined) {
			folders.set(top, { files: 1, bytes: entry.file.size });
		} else {
			seen.files += 1;
			seen.bytes += entry.file.size;
		}
	}

	const folderEntries: SummaryEntry[] = [...folders]
		.map(([name, counts]) => ({ kind: "folder" as const, name, ...counts }))
		.sort((a, b) => b.bytes - a.bytes);

	const fileEntries: SummaryEntry[] = files
		.map((file) => ({ kind: "file" as const, ...file }))
		.sort((a, b) => b.bytes - a.bytes);

	// The same predicate `checkLimits` refuses on, rather than the two conditions this line used to
	// carry. It had `hasIndexHtml || documents > 0`, which was the whole rule at the time and became two
	// thirds of it — so a lone note would have been shown as unpublishable right up to the moment the
	// service published it.
	const paths = dropped.map((entry) => entry.path);
	const renamedToIndex = renameOfLoneHtmlPage(paths);
	// Asked of the paths as they will be sent, which for a lone HTML page means after the rename: the
	// screen must not report "nothing to serve" about a drop that is about to become an index page.
	const publishable = canPublish(renamedToIndex === null ? paths : ["index.html"]);

	// Asks `hasIndexHtml`, not `publishable`, and the difference is a real case: a source tree almost
	// always carries a README, so a project dropped whole is publishable — as a documents site of its
	// own readme. It is still the wrong folder. Whether to warn and whether to refuse are two questions,
	// and the screen answers them separately.
	const looksLikeProject =
		!hasIndexHtml &&
		(folderEntries.some((entry) => PROJECT_MARKERS.has(entry.name)) ||
			fileEntries.some((entry) => entry.name === "package.json"));

	return {
		kind: "folder",
		files: dropped.length,
		bytes,
		folders: folders.size,
		hasIndexHtml,
		documents,
		publishable,
		renamedToIndex,
		looksLikeProject,
		entries: [...folderEntries, ...fileEntries],
	};
}
