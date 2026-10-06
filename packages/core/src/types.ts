import type { ServingMode } from "./limits.js";

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
	/**
	 * The source is reading what was dropped. Sent once with zeros the moment a deploy starts, so a
	 * caller is never left showing nothing while a large zip is read and expanded, and then as the
	 * source reports bytes. `total` is 0 while the size is not known yet.
	 */
	| { type: "reading"; bytes: number; total: number }
	| { type: "collecting"; files: number }
	| { type: "hashing"; done: number; total: number }
	| { type: "preparing" }
	| {
			type: "uploading";
			done: number;
			total: number;
			/**
			 * Bytes sent so far, including the part of each file still in flight where the transport can
			 * see it. Can step back when a stalled upload is restarted, because the bytes of the abandoned
			 * attempt no longer count.
			 */
			bytes: number;
			/** Bytes this deploy has to send: the files the server asked for, not the ones it reused. */
			totalBytes: number;
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
	/**
	 * One file's upload failed or stalled and is being tried again. Not a stage of its own: the deploy
	 * is still uploading, and this exists so a caller can say why the numbers stopped moving.
	 */
	| {
			type: "retrying";
			path: string;
			/** The attempt about to start, counting the first as 1. */
			attempt: number;
			/** Every attempt this file will get, the first included. */
			attempts: number;
			/** Whether the last attempt stopped sending rather than failing outright. */
			stalled: boolean;
	  }
	| { type: "completing"; reused: number }
	/**
	 * Published. `name` is what the site is called now, or null when it has none — the server's answer,
	 * not the title the drop offered, since a redeploy leaves an existing name alone. `mode` is how the
	 * site is now served and `modeIsManual` whether its owner chose that, both as the server reports them.
	 */
	| {
			type: "done";
			url: string;
			name: string | null;
			mode: ServingMode;
			modeIsManual: boolean;
	  }
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

/**
 * A file's contents: in memory, or a `Blob` still on disk.
 *
 * A file out of a zip has to be in memory — it only exists once decompressed. A file from a dropped
 * folder does not: it is already on disk, and reading every one into memory before hashing was a
 * folder's whole size held for the whole deploy. As a `Blob` it is read once to hash and then sent
 * straight from disk, so a 250 MB folder costs about its largest file.
 */
export type FileContent = Uint8Array | Blob;

/** One file gathered from a folder drop or a zip, before it has been hashed. */
export interface CollectedFile {
	/** Path relative to the drop root, always `/`-separated and never starting with `/`. */
	readonly path: string;
	/**
	 * File contents, in memory or on disk — see {@link FileContent}. Measure with {@link sizeOf} and read
	 * with {@link bytesOf}, never `.length`, which a `Blob` does not have.
	 */
	readonly bytes: FileContent;
}

/**
 * How many bytes a file's contents hold.
 *
 * @param content In memory or on disk.
 * @returns The size in bytes.
 */
export function sizeOf(content: FileContent): number {
	// `ArrayBuffer.isView` rather than `instanceof Uint8Array`: a test environment can hand over a typed
	// array from another realm, and `instanceof` is false for every one of those.
	return ArrayBuffer.isView(content) ? content.byteLength : content.size;
}

/**
 * A file's contents as bytes, reading them if they are still on disk.
 *
 * @param content In memory or on disk.
 * @returns The bytes. In-memory contents come back as they are, not copied.
 */
export async function bytesOf(content: FileContent): Promise<Uint8Array> {
	return ArrayBuffer.isView(content)
		? (content as Uint8Array)
		: new Uint8Array(await content.arrayBuffer());
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
	/**
	 * The browser could not hold what was dropped in memory. Raised when allocating the buffer for a
	 * large zip or file fails, which a browser reports as a `RangeError` rather than as anything that
	 * names memory.
	 */
	OutOfMemory: "out_of_memory",
	/**
	 * A dropped file could not be read when it came to be hashed. Files from a folder stay on disk until
	 * then, so one moved, deleted or changed after the drop fails here rather than at the drop.
	 */
	ReadFailed: "read_failed",
	/**
	 * A control-plane call got no answer: the connection failed before a response arrived, or the
	 * request timeout passed. Distinct from an HTTP error, which is an answer — this one says nothing
	 * about whether the server acted, which is why only an idempotent call may retry on it.
	 */
	NetworkFailed: "network_failed",
} as const;

/**
 * Describes a thrown value together with its chain of causes, as one line.
 *
 * Node's `fetch` reports every connection failure as `TypeError: fetch failed` and keeps the reason —
 * `other side closed`, `ECONNRESET` — in `cause`. Serialized as it is, that error is `{}`, and a stress
 * run's only failure once read `"detail": {}`: the one question it raised was the one it could not
 * answer. Each link's `code` is kept because it is the part worth searching for.
 *
 * @param error Whatever was caught.
 * @returns The messages from the outermost error inwards, e.g. `fetch failed ← other side closed (UND_ERR_SOCKET)`.
 */
export function describeError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;

	// Bounded, because a cause chain is only a convention and nothing stops one from pointing at itself.
	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
		if (current instanceof Error) {
			const code = (current as { code?: unknown }).code;
			parts.push(typeof code === "string" ? `${current.message} (${code})` : current.message);
			current = (current as { cause?: unknown }).cause;
		} else {
			parts.push(String(current));
			break;
		}
	}

	return parts.join(" ← ");
}

/** One of the {@link ClientErrorCode} values. */
export type ClientErrorCode = (typeof ClientErrorCode)[keyof typeof ClientErrorCode];
