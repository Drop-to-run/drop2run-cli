import type { ProgressEvent } from "@drop2run/core";

/**
 * Turns deploy progress into something a terminal can show.
 *
 * <b>Why this exists at all.</b> The engine has reported every stage since the browser needed a bar to
 * draw, and the CLI threw all of it away: `drop2run deploy` printed nothing between being run and being
 * finished. On a folder of a few hundred files that is thirty seconds of a cursor sitting still, which
 * is indistinguishable from a hang — and the one question somebody has in that half-minute, "is it
 * moving, and how far", is exactly what the events already answer.
 *
 * <b>Two ways of writing, one format.</b> Attached to a terminal, a single line is rewritten in place so
 * the deploy occupies one row rather than a screenful. Redirected to a file or a pipe, carriage returns
 * are noise nobody can read back, so only stage changes are written and each gets its own line.
 */

/** Written per stage, and rewritten within a stage where the stream is a terminal. */
export interface ProgressWriter {
	/** Emits one line of progress. */
	(event: ProgressEvent): void;
	/** Clears whatever is on the current line, before anything else is printed. */
	done(): void;
}

/**
 * A writer that shows nothing, for `--json` and for tests.
 *
 * Given to commands as the default so progress is opt-in at the call site: the only caller that should
 * print is the one that knows a person is watching, and every other path — a test, a JSON consumer —
 * gets silence without having to ask for it.
 */
export const silentProgress: ProgressWriter = Object.assign(() => {}, { done: () => {} });

/** Bytes per step of the units below. */
const STEP = 1024;

/** Units {@link formatBytes} counts in, smallest first. */
const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * Renders a byte count for a person.
 *
 * @param bytes How many.
 * @returns The count with a unit, at one decimal place above kilobytes.
 */
export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;

	while (value >= STEP && unit < UNITS.length - 1) {
		value /= STEP;
		unit += 1;
	}

	return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Shortens a path so the line it goes on cannot wrap.
 *
 * A wrapped line defeats the whole point of rewriting one in place: the terminal scrolls, the next
 * rewrite lands on the wrong row, and what is left behind is a column of half-drawn progress.
 *
 * @param path Path relative to the site root.
 * @param width How many characters it may occupy.
 * @returns The path, or its tail behind an ellipsis.
 */
export function shortenPath(path: string, width: number): string {
	if (path.length <= width) return path;

	return `…${path.slice(path.length - width + 1)}`;
}

/**
 * Describes one stage in one line.
 *
 * <b>Counts are of the whole deploy, not of the upload.</b> `uploading` already arrives with the files
 * the server is reusing folded into `done`, so a redeploy of five hundred files that changed three
 * reads as "498 of 500" rather than "1 of 3" — the second is true of the upload and false of everything
 * somebody means by "how far along is this".
 *
 * @param event What the engine reported.
 * @param width Characters available, used to decide whether a filename fits.
 * @returns The line, or null for an event that ends the deploy and is reported by the command itself.
 */
export function describe(event: ProgressEvent, width = 80): string | null {
	switch (event.type) {
		case "collecting":
			return `Collected ${event.files.toLocaleString()} ${event.files === 1 ? "file" : "files"}`;
		case "hashing":
			return `Hashing ${event.done.toLocaleString()}/${event.total.toLocaleString()}`;
		case "preparing":
			return "Asking the server which files it already has";
		case "uploading": {
			const counted = `Uploading ${event.done.toLocaleString()}/${event.total.toLocaleString()}`;
			const reused = event.reused === 0 ? "" : ` (${event.reused.toLocaleString()} already there)`;
			const head = `${counted}${reused} · ${formatBytes(event.bytes)}`;

			// The filename is the first thing dropped when the line is tight: knowing the deploy is at
			// 200 of 500 is worth more than knowing which of the five hundred landed last.
			const room = width - head.length - 3;

			return event.path === undefined || room < 12
				? head
				: `${head} · ${shortenPath(event.path, room)}`;
		}
		case "completing":
			return "Publishing";
		// Both end the deploy, and the command prints the URL from the result it returns. Saying it here
		// as well would print it twice, once on stderr and once on stdout.
		case "done":
		case "unchanged":
		case "error":
			return null;
	}
}

/**
 * Builds the writer a deploy reports through.
 *
 * @param write Receives the exact characters to emit, carriage returns included.
 * @param isTerminal Whether the stream redraws, which decides between one rewritten line and one line
 * per stage.
 * @param width Terminal width, used to pad over what the previous line left behind.
 * @returns The writer.
 */
export function progressWriter(
	write: (text: string) => void,
	isTerminal: boolean,
	width = 80,
): ProgressWriter {
	// The line is cleared by padding to the width of what it replaces rather than by an escape code, so
	// a terminal that does not understand the escape does not get it printed as text.
	let painted = 0;
	let lastStage: ProgressEvent["type"] | null = null;

	const writer = ((event: ProgressEvent) => {
		const line = describe(event, width - 1);
		if (line === null) return;

		if (!isTerminal) {
			// One line per stage. A file-by-file account of an upload is thousands of lines in a CI log,
			// which is how a progress report becomes the reason nobody reads the log.
			if (event.type === lastStage) return;

			lastStage = event.type;
			write(`${line}\n`);

			return;
		}

		lastStage = event.type;
		write(`\r${line}${" ".repeat(Math.max(0, painted - line.length))}`);
		painted = line.length;
	}) as ProgressWriter;

	writer.done = () => {
		if (!isTerminal || painted === 0) return;

		write(`\r${" ".repeat(painted)}\r`);
		painted = 0;
	};

	return writer;
}
