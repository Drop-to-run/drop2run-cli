/**
 * The one table that says what Drop2Run does with a file extension.
 *
 * <b>Why this file exists.</b> Four facts about an extension — is a folder of these a documents site,
 * can the viewer render it, does a link to it open the reader, what media type is it served as, can
 * the dashboard editor open it — used to live in seven places across three languages, mirrored by
 * hand. Three doc comments warned about it; none of them could stop it. Every warning was written
 * while the list held three entries, and the list is about to grow.
 *
 * <b>What this file is and is not.</b> It is the declared source: when the table and a copy disagree,
 * the table is right and the copy is the bug. It is not a mechanism that removes the copies. Two
 * consumers can import it (`limits.ts` here, and the dashboard through the `@drop2run/core` alias);
 * three cannot — the Worker bundles without a path alias, the viewer ships a first-paint budget, and
 * C# cannot read TypeScript at all. Those three keep their own copies and are held to this table by a
 * test each, named in {@link FILE_TYPES}.
 *
 * <b>Why not generate the copies.</b> Considered and rejected. The repo's one generation path runs the
 * other way — C# is the source, `generate-openapi.sh` and `gen:api` produce the TypeScript — so a
 * TypeScript-to-C# generator would be new machinery: a script, a generated file to commit, another
 * `git diff --exit-code` in CI, and a step every contributor has to remember. What it buys over a test
 * is "cannot drift while you are typing" rather than "cannot merge while drifted", for a flat list of
 * strings. See `docs/briefs/FILE-TYPES-BRIEF.md` F10.
 */

/**
 * How the documents viewer displays one file.
 *
 * ⚠️ Mirrors `FileKind` in `apps/viewer/src/paths.ts`. `binary` means the viewer offers it as a
 * download rather than rendering it, which is also what makes {@link VIEWABLE_EXTENSIONS} derivable
 * rather than a column of its own.
 */
export type FileKind =
	| "markdown"
	| "pdf"
	| "image"
	| "code"
	| "text"
	| "html"
	| "docx"
	| "xlsx"
	| "epub"
	| "binary";

/** One extension, and every decision that hangs off it. */
export interface FileType {
	/** The extension, lowercase and including its dot. */
	readonly ext: string;
	/**
	 * Media type the Worker serves it as, or null to fall back to `application/octet-stream`.
	 *
	 * Null is a real answer, not a gap to be filled in passing: a type added here changes what a
	 * browser does with a published file, and invariant I10 exists because that decision belongs to
	 * the extension rather than to whatever a client claimed at upload time.
	 */
	readonly mime: string | null;
	/** How the viewer renders it. */
	readonly kind: FileKind;
	/**
	 * Whether a folder containing one of these is a documents site, at any depth.
	 *
	 * Deliberately tiny. The question is not "can the viewer show it" but "is a folder of these
	 * something a person publishes on purpose" — nearly every web project holds a `.json` or a `.css`,
	 * so a wider set here would take a `dist/assets/` dropped by mistake and publish it as a documents
	 * site listing JavaScript bundles, instead of refusing it and naming the folder to drop.
	 */
	readonly document: boolean;
	/**
	 * Whether a navigation to this file inside a documents site opens the reader.
	 *
	 * Independent of {@link kind}, and the gaps are the interesting part. `.html` is false because a
	 * customer's page is a page and wrapping it in our chrome would bury it; images are false because
	 * following a link straight to a `.png` should show the `.png`. Meanwhile `.json` is true, since
	 * inside a folder of notes a config file is something to read.
	 */
	readonly reader: boolean;
	/** Whether the dashboard's editor can open it as text. */
	readonly editable: boolean;
}

/**
 * Every extension Drop2Run treats as anything other than opaque bytes.
 *
 * <b>Three copies are checked against this array</b>, each by a test that exercises the copy's real
 * behaviour rather than reading its source:
 *
 * - `apps/router/test/unit/fileTypes.test.ts` — `isReaderPath` against {@link FileType.reader}, and
 *   the `Content-Type` out of `buildHeaders` against {@link FileType.mime};
 * - `apps/viewer/test/unit/fileTypes.test.ts` — `kindOf` against {@link FileType.kind};
 * - `apps/api/tests/.../Domain/FileTypeTableTests.cs` — `SiteModeDetection` against
 *   {@link FileType.document} and the derived {@link VIEWABLE_EXTENSIONS}, plus the editor's list in
 *   `GetDeployFile.cs`. That one reads this file from disk, because C# has no other way in.
 *
 * Add a row and one of those three turns red until its copy is updated. That is the whole mechanism,
 * and it is worth stating plainly that it catches the copy going stale, not this table being wrong.
 *
 * Rows are grouped by what they are for, and ordered inside a group the way somebody would list them.
 * Nothing reads the order.
 */
export const FILE_TYPES: readonly FileType[] = [
	// Documents. The three extensions that make a folder a documents site.
	{
		ext: ".md",
		mime: "text/markdown; charset=utf-8",
		kind: "markdown",
		document: true,
		reader: true,
		editable: true,
	},
	{
		ext: ".markdown",
		mime: "text/markdown; charset=utf-8",
		kind: "markdown",
		document: true,
		reader: true,
		editable: true,
	},
	{
		ext: ".pdf",
		mime: "application/pdf",
		kind: "pdf",
		document: true,
		reader: true,
		editable: false,
	},

	// Office documents and ebooks. Each has its own kind because each needs its own renderer, loaded
	// only when one is opened — `.docx` through mammoth, `.xlsx` through read-excel-file, `.epub`
	// through foliate-js.
	{
		ext: ".docx",
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		kind: "docx",
		document: true,
		reader: true,
		editable: false,
	},
	{
		ext: ".xlsx",
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		kind: "xlsx",
		document: true,
		reader: true,
		editable: false,
	},
	{
		ext: ".epub",
		mime: "application/epub+zip",
		kind: "epub",
		document: true,
		reader: true,
		editable: false,
	},

	// Prose the reader shows preformatted.
	{
		ext: ".txt",
		mime: "text/plain; charset=utf-8",
		kind: "text",
		document: false,
		reader: true,
		editable: true,
	},
	{
		ext: ".log",
		mime: "text/plain; charset=utf-8",
		kind: "text",
		document: false,
		reader: true,
		editable: false,
	},
	{
		ext: ".csv",
		mime: "text/csv; charset=utf-8",
		kind: "text",
		document: false,
		reader: true,
		editable: true,
	},

	// Structured text. Read through the reader inside a folder of notes, which is why these carry
	// `reader: true` while the source formats below do not.
	{
		ext: ".json",
		mime: "application/json",
		kind: "code",
		document: false,
		reader: true,
		editable: true,
	},
	{
		ext: ".yaml",
		mime: "text/yaml; charset=utf-8",
		kind: "code",
		document: false,
		reader: true,
		editable: true,
	},
	{
		ext: ".yml",
		mime: "text/yaml; charset=utf-8",
		kind: "code",
		document: false,
		reader: true,
		editable: true,
	},
	{
		// No registered media type, so it takes text/plain rather than an invented one. The point is
		// only that a browser shows it instead of downloading it.
		ext: ".toml",
		mime: "text/plain; charset=utf-8",
		kind: "code",
		document: false,
		reader: true,
		editable: true,
	},

	// Source the viewer highlights. A link straight to one of these hands over the file.
	{
		ext: ".css",
		mime: "text/css; charset=utf-8",
		kind: "code",
		document: false,
		reader: false,
		editable: true,
	},
	{
		ext: ".js",
		mime: "text/javascript; charset=utf-8",
		kind: "code",
		document: false,
		reader: false,
		editable: true,
	},
	{
		ext: ".ts",
		mime: null,
		kind: "code",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".tsx",
		mime: null,
		kind: "code",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".jsx",
		mime: null,
		kind: "code",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".sh",
		mime: null,
		kind: "code",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".xml",
		mime: "application/xml",
		kind: "code",
		document: false,
		reader: false,
		editable: true,
	},

	// Pictures, shown with an img element.
	{
		ext: ".png",
		mime: "image/png",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".jpg",
		mime: "image/jpeg",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".jpeg",
		mime: "image/jpeg",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".gif",
		mime: "image/gif",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".webp",
		mime: "image/webp",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".avif",
		mime: "image/avif",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},
	{
		// Text, hand-edited in practice, and script-carrying. Editable anyway: the Worker derives the
		// type at serve time (I10) and already serves whatever was uploaded, so withholding the edit
		// would withhold nothing else.
		ext: ".svg",
		mime: "image/svg+xml",
		kind: "image",
		document: false,
		reader: false,
		editable: true,
	},
	{
		ext: ".ico",
		mime: "image/x-icon",
		kind: "image",
		document: false,
		reader: false,
		editable: false,
	},

	// A customer's own pages. Never rendered inside the reader.
	{
		ext: ".html",
		mime: "text/html; charset=utf-8",
		kind: "html",
		document: false,
		reader: false,
		editable: true,
	},
	{
		// ⚠️ No media type, and that is the state of the code rather than a decision: `TYPES` in
		// `headers.ts` has never held `htm`, so a published `.htm` is served as octet-stream and
		// downloads instead of rendering. Recorded here rather than fixed, because this table was
		// introduced as a refactor and a refactor that changes what a URL answers is not one.
		ext: ".htm",
		mime: null,
		kind: "html",
		document: false,
		reader: false,
		editable: true,
	},

	// Everything below renders as nothing — the viewer offers a download — but still needs a media
	// type, because these are the files a static site is built out of.
	{
		ext: ".mjs",
		mime: "text/javascript; charset=utf-8",
		kind: "binary",
		document: false,
		reader: false,
		editable: true,
	},
	{
		ext: ".cjs",
		mime: null,
		kind: "binary",
		document: false,
		reader: false,
		editable: true,
	},
	{
		ext: ".map",
		mime: "application/json",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".wasm",
		mime: "application/wasm",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".woff2",
		mime: "font/woff2",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".woff",
		mime: "font/woff",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".ttf",
		mime: "font/ttf",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".mp4",
		mime: "video/mp4",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
	{
		ext: ".webm",
		mime: "video/webm",
		kind: "binary",
		document: false,
		reader: false,
		editable: false,
	},
];

/**
 * Collects the extensions whose row satisfies a predicate.
 *
 * @param include Which rows to take.
 * @returns Their extensions, in table order.
 */
function extensionsWhere(include: (type: FileType) => boolean): readonly string[] {
	return FILE_TYPES.filter(include).map((type) => type.ext);
}

/**
 * Extensions that make a drop with no `index.html` publishable as a documents site, at any depth.
 *
 * ⚠️ Mirrored by `_documentExtensions` in `apps/api`. The server holds the authority; this copy exists
 * so a drop that will be refused is refused before it is hashed and uploaded.
 */
export const DOCUMENT_EXTENSIONS: readonly string[] = extensionsWhere((type) => type.document);

/**
 * Extensions the viewer can render, which make a drop of **exactly one file** publishable.
 *
 * Derived rather than declared: anything the viewer renders as something is viewable, and `binary` is
 * the kind that means it does not. Keeping it derived is what stops the two from disagreeing — the
 * pair used to be two hand-written lists whose relationship was stated in a comment.
 *
 * The bound to one file is the point rather than an omission. At any larger size these extensions
 * describe the inside of a website, and counting them would turn a mis-dropped build folder into a
 * site instead of an error naming the mistake. One file has no such ambiguity.
 */
export const VIEWABLE_EXTENSIONS: readonly string[] = extensionsWhere(
	(type) => type.kind !== "binary",
);

/**
 * Extensions that open the reader when a link inside a documents site points at them.
 *
 * ⚠️ Mirrored by `VIEWABLE` in `apps/router/src/docs.ts`, which the Worker consults per request.
 */
export const READER_EXTENSIONS: readonly string[] = extensionsWhere((type) => type.reader);

/**
 * Extensions the dashboard's editor opens as text.
 *
 * ⚠️ Mirrored by `EditableExtensions` in `apps/api`, which enforces it. The asymmetry is the danger
 * here: a text type missing from the list is an editor declining to open something it could have,
 * while a binary type wrongly present is a file rendered as mojibake into a textarea that can publish
 * it back — which destroys it.
 */
export const EDITABLE_EXTENSIONS: readonly string[] = extensionsWhere((type) => type.editable);

/**
 * Extensions whose presence means the drop is the inside of a website rather than a set of pictures.
 *
 * <b>The guard on {@link GALLERY_EXTENSIONS}, and the reason a folder of images can be published at
 * all.</b> Without it, a `dist/assets/` dragged in place of `dist/` — no `index.html`, because the
 * person picked the folder below the one they meant — would publish as a gallery of sprites and
 * favicons instead of being refused with the name of the folder to drop. With it, the same drop still
 * gets that refusal, because a build output has scripts and stylesheets in it and a camera roll does
 * not.
 *
 * Deliberately not "everything that is not an image". A folder of generated pictures beside a `.json`
 * of prompts is still a folder of pictures; it is scripts, stylesheets and pages that say somebody
 * dropped a website.
 */
export const WEB_ASSET_EXTENSIONS: readonly string[] = [
	".html",
	".htm",
	".js",
	".mjs",
	".cjs",
	".css",
];

/**
 * Extensions that count towards a drop being a folder of pictures.
 *
 * Derived from the kind rather than listed again, so a picture format added to the table is a picture
 * here too. Only meaningful together with {@link WEB_ASSET_EXTENSIONS}: the rule is "some of these and
 * none of those", and either half alone is the wrong rule.
 */
export const GALLERY_EXTENSIONS: readonly string[] = extensionsWhere(
	(type) => type.kind === "image",
);

/**
 * Media type for each extension that has one.
 *
 * ⚠️ Mirrored by `TYPES` in `apps/router/src/headers.ts`. Extensions whose {@link FileType.mime} is
 * null are absent here and are served as `application/octet-stream`.
 */
export const MEDIA_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
	FILE_TYPES.filter((type) => type.mime !== null).map((type) => [type.ext, type.mime as string]),
);

/**
 * The extension of a path, lowercased, or an empty string when it has none.
 *
 * Taken after the last slash so a dot in a directory name does not become the extension of a file
 * that has none — `v1.2/README` is not a `.2/README` file.
 *
 * @param path A path or a file name.
 * @returns The extension including its dot, or an empty string.
 */
export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");

	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
