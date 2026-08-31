import type { CollectedFile } from "./types.js";

/**
 * Reads a display name for a site out of the `index.html` it was published from.
 *
 * A site is addressed by its subdomain, which is generated and says nothing about what it holds — a
 * list of `brave-otter-4f2a` and `quiet-heron-91cd` is unreadable the moment somebody has more than
 * two. The page being published already carries the name its author chose, in the same tag the browser
 * tab shows, so this takes it from there instead of asking a question at the one moment the product is
 * meant to ask none.
 *
 * Only a suggestion. The name is stored once, never overwritten by a later deploy, and editable on the
 * site's settings page — so a wrong guess here costs one field of typing, not a wrong site.
 *
 * ⚠️ Nothing in `pipeline/` may import React, and this file must run in a Web Worker and under node
 * (see `types.ts`), which is why parsing goes through `DOMParser` only when there is one.
 */

/**
 * Longest name that is stored. Matches the column and the server's own cap.
 *
 * Long enough for a real page title and short enough to sit in a heading beside a status badge. A
 * title past this is cut rather than rejected: the alternative is publishing with no name at all
 * because a page's `<title>` happened to be a sentence.
 */
export const MAX_NAME_LENGTH = 60;

/**
 * How much of `index.html` is parsed.
 *
 * `<head>` is at the top of any document by definition, so the rest is bytes nobody here reads. A
 * hand-written page is a few kilobytes and a bundler's output can be megabytes of inlined CSS — this
 * keeps both costing the same.
 */
const HEAD_BYTES = 64 * 1024;

/**
 * Suffixes a title picks up from a site generator, removed when the part before them is usable.
 *
 * `Home | Acme Docs` is the whole tab title but the site is called `Acme Docs`, and `About - Acme` is
 * the same shape. Only the last separator is split on, and only when both sides survive trimming, so a
 * title that merely contains a dash keeps it.
 */
const TITLE_SEPARATORS = ["|", "·", "—", "–", " - "];

/**
 * Picks a name for a site from the files about to be published.
 *
 * Never throws and never rejects: a drop with no readable title is published with no name, which is
 * exactly what happened before this existed. A failure here must not be able to fail a deploy.
 *
 * @param files The collected files, as they are about to be hashed.
 * @returns The suggested name, or null when the drop offers none.
 */
export function suggestSiteName(
	files: readonly CollectedFile[],
): string | null {
	const index = files.find((file) => file.path === "index.html");
	if (index === undefined) return null;

	try {
		return nameFromHtml(decodeHead(index.bytes));
	} catch {
		return null;
	}
}

/**
 * Reads the start of an HTML file as text.
 *
 * Decoded as UTF-8 with malformed sequences replaced rather than throwing, because the file is
 * whatever the user dropped: a page in another encoding produces mojibake in the title, and
 * {@link nameFromHtml} then either finds something usable or does not. Slicing mid-character is fine
 * for the same reason — the damage is confined to one glyph at a boundary 64 KB into a document whose
 * `<head>` ended long before.
 *
 * @param bytes The file's contents.
 * @returns The decoded head of the document.
 */
function decodeHead(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(
		bytes.subarray(0, HEAD_BYTES),
	);
}

/**
 * Extracts a name from an HTML document, in the order a human would read one.
 *
 * `og:site_name` first because it names the *site* and the other two name the *page*: a blog's home
 * page is titled "Home" far more often than it is titled after the blog. `<title>` next, since every
 * page has one. `<h1>` last, for a hand-written page that never got a title.
 *
 * @param html The document, or as much of it as was read.
 * @returns The name, or null when none of the three yields anything usable.
 */
function nameFromHtml(html: string): string | null {
	const document = parse(html);

	const candidates = document
		? [
				document
					.querySelector('meta[property="og:site_name"]')
					?.getAttribute("content"),
				document.querySelector("title")?.textContent,
				document.querySelector("h1")?.textContent,
			]
		: [matchOgSiteName(html), matchTag(html, "title"), matchTag(html, "h1")];

	for (const candidate of candidates) {
		const name = clean(candidate);
		if (name !== null) return name;
	}

	return null;
}

/**
 * Parses a document, when the runtime has a parser.
 *
 * `DOMParser` is the right tool and a safe one: it builds a detached document, so no script in the
 * dropped page runs, no resource it references is fetched, and nothing it contains reaches the page
 * this code is running on. It is absent under node — where the pipeline's tests run, and where the
 * Phase 3 CLI will — hence the caller's regex fallback rather than a hard dependency on it.
 *
 * @param html The document text.
 * @returns The parsed document, or null when the runtime cannot parse one.
 */
function parse(html: string): ParsedDocument | null {
	const parser = (globalThis as { DOMParser?: new () => DomParserLike }).DOMParser;
	if (parser === undefined) return null;

	try {
		return new parser().parseFromString(html, "text/html");
	} catch {
		return null;
	}
}

/**
 * The three calls this file makes against a parsed document, and nothing more.
 *
 * <b>Why the shape is declared here rather than taken from the DOM library.</b> This package must
 * typecheck without `lib: ["DOM"]`, because the CLI and the MCP server compile against node and
 * loading the DOM types there would let a real browser API slip in and typecheck cleanly — the one
 * mistake the split exists to prevent. Naming the two methods it actually uses keeps the runtime
 * behaviour identical and states the dependency exactly.
 */
interface ParsedDocument {
	/**
	 * Finds the first matching element.
	 *
	 * @param selector CSS selector.
	 * @returns The element, or null.
	 */
	querySelector(selector: string): ParsedElement | null;
}

/** The parts of an element this file reads. */
interface ParsedElement {
	/** Its text, or null. */
	readonly textContent: string | null;

	/**
	 * Reads an attribute.
	 *
	 * @param name Attribute name.
	 * @returns Its value, or null.
	 */
	getAttribute(name: string): string | null;
}

/** The one method of `DOMParser` this file calls. */
interface DomParserLike {
	/**
	 * Parses a document.
	 *
	 * @param html The document text.
	 * @param type MIME type, always `text/html` here.
	 * @returns The parsed document.
	 */
	parseFromString(html: string, type: string): ParsedDocument;
}

/**
 * Finds the text of the first `<title>` or `<h1>` without a parser.
 *
 * Deliberately narrow. This runs only where {@link parse} found no `DOMParser`, and it is not trying
 * to be an HTML parser — it looks for one tag, takes what is between it and its close, and lets
 * {@link clean} throw away anything that still holds markup.
 *
 * @param html The document text.
 * @param tag Tag name to look for.
 * @returns The tag's contents, or null.
 */
function matchTag(html: string, tag: string): string | null {
	const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(
		html,
	);

	return match?.[1] ?? null;
}

/**
 * Finds an `og:site_name` content value without a parser.
 *
 * Both attribute orders are tried, because a `<meta>` may be written either way round and matching
 * only one of them would make the fallback disagree with {@link parse} about the same document.
 *
 * @param html The document text.
 * @returns The value, or null.
 */
function matchOgSiteName(html: string): string | null {
	const patterns = [
		/<meta[^>]*property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']*)["']/i,
		/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:site_name["']/i,
	];

	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (match?.[1] !== undefined) return match[1];
	}

	return null;
}

/**
 * Code points removed before a name is stored.
 *
 * Two groups, both invisible and both a problem in a heading rather than in a document: C0/C1 control
 * characters, and the bidirectional and zero-width formatting characters. A right-to-left override
 * sitting in a site's name would reorder the text rendered *around* it in the dashboard, which is a
 * display bug the owner of that site chose and every other reader inherits.
 *
 * Built with {@link String.fromCharCode} rather than written as literals so the source file stays
 * plain ASCII — a literal `U+202E` in this file would do to this file exactly what it is here to
 * prevent.
 */
const INVISIBLE = new RegExp(
	`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}` +
		`${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}` +
		`${String.fromCharCode(0x2028)}-${String.fromCharCode(0x202e)}` +
		`${String.fromCharCode(0x2060)}-${String.fromCharCode(0x2064)}` +
		`${String.fromCharCode(0x2066)}-${String.fromCharCode(0x206f)}` +
		`${String.fromCharCode(0xfeff)}]`,
	"g",
);

/**
 * Turns raw tag text into a name worth storing, or rejects it.
 *
 * Invisible characters go first — see {@link INVISIBLE}. Whitespace is then collapsed, since a
 * `<title>` is routinely written across three indented lines and means one line of text.
 *
 * A name that is only a generator's placeholder is refused: falling through to the subdomain is more
 * useful than a list of sites all called "Document".
 *
 * @param raw The candidate text, or null/undefined when the tag was absent.
 * @returns The cleaned name, or null when there is nothing worth keeping.
 */
function clean(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined) return null;

	// Anything that still looks like markup came from a document this cannot parse properly, and
	// guessing at it would put tag text into somebody's site name.
	if (raw.includes("<") || raw.includes(">")) return null;

	const collapsed = raw.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();

	const name = trimSuffix(collapsed);
	if (name.length === 0) return null;
	if (PLACEHOLDERS.has(name.toLowerCase())) return null;

	return name.length > MAX_NAME_LENGTH
		? name.slice(0, MAX_NAME_LENGTH).trimEnd()
		: name;
}

/**
 * Titles that name a template rather than a site.
 *
 * Every one of these is what a starter emits when nobody has filled the title in, so storing them
 * would give a site a name that is worse than no name — it looks deliberate and it is not.
 */
const PLACEHOLDERS = new Set([
	"document",
	"untitled",
	"untitled document",
	"index",
	"home",
	"new page",
	"my site",
	"vite app",
	"vite + react",
	"react app",
	"create next app",
	"svelte app",
	"webpack app",
	"hello world",
	"title",
]);

/**
 * Drops a page-name prefix from a title that carries one.
 *
 * Split on the last separator rather than the first, because the site name is conventionally the
 * trailing part: `Docs | Guides | Acme` is published by Acme. Both sides must survive trimming, so
 * `Acme | ` and a title merely containing a dash are left as they are.
 *
 * @param title A cleaned title.
 * @returns The site part, or the whole title when it holds no separator.
 */
function trimSuffix(title: string): string {
	for (const separator of TITLE_SEPARATORS) {
		const at = title.lastIndexOf(separator);
		if (at <= 0) continue;

		const before = title.slice(0, at).trim();
		const after = title.slice(at + separator.length).trim();

		if (before.length > 0 && after.length > 0) return after;
	}

	return title;
}
