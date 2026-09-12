/**
 * Types shared across the deploy pipeline.
 *
 * ⚠️ Nothing in this package may import React, or anything else that assumes a browser. Two reasons,
 * both real constraints rather than style: it runs inside a Web Worker, because hashing and unzipping a
 * large drop on the main thread freezes the UI completely; and the CLI and the MCP server import it
 * directly. Enforced by `apps/web/test/isolation.test.ts`.
 */

/** Progress reported to the caller as a deploy moves through its stages. */
export type ProgressEvent =
	| { type: "collecting"; files: number }
	| { type: "hashing"; done: number; total: number }
	| { type: "preparing" }
	| {
			type: "uploading";
			done: number;
			total: number;
			bytes: number;
			reused: number;
			/**
			 * Path of the file that just landed, where the reporter knows it. Uploads run several at a
			 * time, so this is the most recent one to finish rather than the only one in flight — enough
			 * for a terminal to show what is moving, not a log of the order things happened in.
			 *
			 * Optional because a caller that only draws a bar has no use for it.
			 */
			path?: string;
	  }
	| { type: "completing"; reused: number }
	/**
	 * Published. `name` is what the site is called now, or null when it has none — the server's answer,
	 * not the title the drop offered, since a redeploy leaves an existing name alone.
	 */
	| { type: "done"; url: string; name: string | null }
	/**
	 * The dropped folder is byte-for-byte what the site already serves, so no version was published.
	 * A success, not a failure — but a different one from `done`, because nothing changed.
	 */
	| { type: "unchanged"; url: string }
	| { type: "error"; code: string; message: string; detail?: unknown };

/** Receives every {@link ProgressEvent} in order. */
export type ProgressListener = (event: ProgressEvent) => void;

/**
 * One dropped file, named but not yet read.
 *
 * This is the shape that crosses into the Web Worker. `FileSystemEntry` cannot: it carries methods, so
 * `postMessage` rejects it with a DataCloneError. A `File` is a lazy handle to bytes on disk and clones
 * fine, which is why enumeration happens on the main thread and everything expensive happens in the
 * Worker.
 */
export interface DroppedFile {
	/** Path relative to the drop root, already normalized and filtered. */
	readonly path: string;
	/** Handle to the file's bytes; not read until the Worker asks for them. */
	readonly file: File;
}

/** One file gathered from a folder drop or a zip, before it has been hashed. */
export interface CollectedFile {
	/** Path relative to the drop root, always `/`-separated and never starting with `/`. */
	readonly path: string;
	/** File contents. */
	readonly bytes: Uint8Array;
}

/** One file after hashing, in the shape the API's manifest expects. */
export interface ManifestFile extends CollectedFile {
	/** Lowercase hex SHA-256 of {@link CollectedFile.bytes}, 64 characters. */
	readonly sha256: string;
}

/**
 * A failure the user can act on.
 *
 * The pipeline throws this rather than a bare `Error` so the UI can tell a quota rejection from a
 * network problem without parsing message strings.
 */
export class DeployError extends Error {
	/**
	 * @param code Stable code, either an API error type (`quota_exceeded`, `unsafe_path`, …) or one of
	 *   the client-side codes in {@link ClientErrorCode}.
	 * @param message Text safe to show the user.
	 * @param detail Anything extra worth logging, such as the RFC 9457 body from the API.
	 */
	constructor(
		readonly code: string,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = "DeployError";
	}
}

/** Codes the client raises on its own, without asking the API. */
export const ClientErrorCode = {
	/** The drop held no files once junk was filtered out. */
	Empty: "empty_drop",
	/** No `index.html` at the root of the drop. */
	MissingIndex: "missing_index",
	/** The drop is larger than the plan allows; the server enforces this too. */
	TooLarge: "too_large",
	/** A single file is larger than the plan allows. */
	FileTooLarge: "file_too_large",
	/** More files than the plan allows. */
	TooManyFiles: "too_many_files",
	/**
	 * A zip claims to expand to more than the plan allows.
	 *
	 * Distinct from {@link TooLarge}, which is about a drop whose files have already been read. This one
	 * is raised from the archive's own directory before anything is decompressed, so the numbers in it
	 * are what the zip declared rather than what was measured.
	 */
	ZipTooLarge: "zip_too_large",
	/** The user cancelled. */
	Cancelled: "cancelled",
	/** An upload kept failing after every retry. */
	UploadFailed: "upload_failed",
} as const;

/** One of the {@link ClientErrorCode} values. */
export type ClientErrorCode =
	(typeof ClientErrorCode)[keyof typeof ClientErrorCode];
