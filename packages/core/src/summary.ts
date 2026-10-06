import { extensionOf, GALLERY_EXTENSIONS } from "./fileTypes.js";
import {
	canPublish,
	isDocumentPath,
	nestedIndexOf,
	predictedModeOf,
	renameOfLoneHtmlPage,
	type ServingMode,
} from "./limits.js";
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
	 * How the server will serve this drop, unless its owner has chosen a mode by hand.
	 *
	 * The same rule as `SiteModeDetection.IsDocs` (see {@link predictedModeOf}), asked of the paths as
	 * they will be sent. Shown before the upload so a drop that is about to go live as documents says so.
	 */
	readonly mode: ServingMode;
	/**
	 * The folder holding an `index.html` in a drop that will be served as documents, or null.
	 *
	 * The case to warn about: a website one folder down, beside something else, so no wrapper could be
	 * peeled off — see {@link nestedIndexOf}.
	 */
	readonly nestedIndex: string | null;
	/**
	 * How many `.md`, `.markdown` or `.pdf` files there are, at any depth.
	 *
	 * A drop with no `index.html` is still publishable when it has one of these — it goes up as a
	 * documents site. Counted rather than flagged so the screen can say what kind of drop this is
	 * instead of only that it is allowed.
	 */
	readonly documents: number;
	/**
	 * How many pictures there are, at any depth.
	 *
	 * Counted for the same reason as {@link documents} and used for the same kind of sentence: a drop
	 * with no `index.html` and no markdown can still be publishable, as a folder of pictures, and the
	 * screen should say which of the two it is rather than only that it is allowed. Whether the drop
	 * really is a gallery is `publishable`'s business — a picture beside a script is a build output,
	 * and this count alone cannot tell the difference.
	 */
	readonly pictures: number;
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

/** A dropped `.zip`, described by its name and size and, once its index has been read, its contents. */
export interface ArchiveSummary {
	readonly kind: "archive";
	readonly name: string;
	readonly bytes: number;
	/**
	 * What the archive holds, from its central directory, or null when that has not been read.
	 *
	 * Reading the directory costs two small slices from the end of the file and no expansion, so the
	 * confirmation screen can list a zip and say how it will be served exactly as it does for a folder.
	 * A zip used to show only its name and compressed size, which is how a drop with its `index.html` two
	 * folders down went live as documents with nothing on screen to warn about it.
	 */
	readonly contents: FolderSummary | null;
}

/** One file of a drop as the summary needs it: where it is, and how big. */
export interface SummaryFile {
	/** Normalized path, as it will be sent. */
	readonly path: string;
	/** Size in bytes. */
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
		return { kind: "archive", name: file.name, bytes: file.size, contents: null };
	}

	return summariseFiles(
		(payload as readonly DroppedFile[]).map((entry) => ({
			path: entry.path,
			bytes: entry.file.size,
		})),
	);
}

/**
 * Describes a list of paths and sizes, which is all a summary ever reads.
 *
 * Split from {@link summarise} so an archive's index can be described the same way as a folder: the
 * zip's central directory yields names and sizes, never `File`s.
 *
 * @param dropped The files, with paths as they will be sent.
 * @returns The folder summary.
 */
export function summariseFiles(dropped: readonly SummaryFile[]): FolderSummary {
	const folders = new Map<string, { files: number; bytes: number }>();
	const files: { name: string; bytes: number }[] = [];
	let bytes = 0;
	let hasIndexHtml = false;
	let documents = 0;
	let pictures = 0;

	for (const entry of dropped) {
		bytes += entry.bytes;

		// At any depth, matching how `checkLimits` looks for one — a documents site is a folder of
		// markdown, and requiring the markdown to be at the root would refuse most of them.
		if (isDocumentPath(entry.path)) documents += 1;
		if (GALLERY_EXTENSIONS.includes(extensionOf(entry.path))) pictures += 1;

		const slash = entry.path.indexOf("/");

		if (slash === -1) {
			files.push({ name: entry.path, bytes: entry.bytes });
			// Compared exactly, as the server's `SiteModeDetection.RootIndex` is. It was lower-cased, so a
			// root `Index.HTML` read here as a website while the server published it as documents.
			if (entry.path === "index.html") hasIndexHtml = true;
			continue;
		}

		const top = entry.path.slice(0, slash);
		const seen = folders.get(top);

		if (seen === undefined) {
			folders.set(top, { files: 1, bytes: entry.bytes });
		} else {
			seen.files += 1;
			seen.bytes += entry.bytes;
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
	const sent = renamedToIndex === null ? paths : ["index.html"];
	const publishable = canPublish(sent);
	const mode = predictedModeOf(sent);
	const nestedIndex = nestedIndexOf(sent);

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
		mode,
		nestedIndex,
		documents,
		pictures,
		publishable,
		renamedToIndex,
		looksLikeProject,
		entries: [...folderEntries, ...fileEntries],
	};
}
