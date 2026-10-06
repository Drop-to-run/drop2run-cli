/**
 * Reading a password without putting it on the command line.
 *
 * <b>Why not a flag.</b> An argument lands in shell history and in the process list, where anybody on
 * the machine can read it while the command runs. So a site password arrives on stdin: piped in from a
 * secret store in CI, or typed at a prompt that does not echo it.
 */

/** The parts of a readable stream this needs, so a test can hand in its own. */
export interface SecretInput extends AsyncIterable<string | Buffer> {
	/** Whether a person is typing, rather than a pipe feeding it. */
	readonly isTTY?: boolean;
	/** Turns line editing and echo off, on a terminal. */
	setRawMode?(mode: boolean): unknown;
	/** Starts the flow of `data` events. */
	resume(): unknown;
	/** Stops it again, so the process can exit. */
	pause(): unknown;
	/** Decodes chunks as text. */
	setEncoding(encoding: BufferEncoding): unknown;
	/** Subscribes to typed characters. */
	on(event: "data", listener: (chunk: string) => void): unknown;
	/** Unsubscribes. */
	off(event: "data", listener: (chunk: string) => void): unknown;
}

/**
 * Reads one secret: the whole of stdin when it is piped, or one hidden line when a person is typing.
 *
 * Piped input loses one trailing newline and nothing else, because `echo secret | drop2run …` adds one
 * the person never meant as part of the password, while spaces inside it may well be meant.
 *
 * @param prompt What to ask, shown only on a terminal.
 * @param input Where to read from.
 * @param output Where the prompt goes — stderr, so stdout carries only the result.
 * @returns The secret.
 * @throws Error when the person presses Ctrl+C at the prompt.
 */
export async function readSecret(
	prompt: string,
	input: SecretInput = process.stdin,
	output: { write(text: string): unknown } = process.stderr,
): Promise<string> {
	if (input.isTTY !== true || input.setRawMode === undefined) {
		const parts: string[] = [];

		for await (const chunk of input)
			parts.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));

		return parts.join("").replace(/\r?\n$/, "");
	}

	const setRawMode = input.setRawMode.bind(input);

	output.write(prompt);
	setRawMode(true);
	input.setEncoding("utf8");
	input.resume();

	return await new Promise<string>((resolve, reject) => {
		const line = new HiddenLine();

		/**
		 * Puts the terminal back the way it was found.
		 */
		const finish = () => {
			setRawMode(false);
			input.pause();
			input.off("data", onData);
			output.write("\n");
		};

		/**
		 * Handles what was typed, since raw mode delivers keystrokes rather than lines.
		 *
		 * @param chunk The characters that arrived.
		 */
		function onData(chunk: string) {
			const outcome = line.type(chunk);
			if (outcome === "more") return;

			finish();
			if (outcome === "cancelled") reject(new Error("Cancelled."));
			else resolve(line.value);
		}

		input.on("data", onData);
	});
}

/**
 * The line being typed at a prompt that does not echo, built from raw keystrokes.
 *
 * <b>Only printable characters become part of it.</b> Raw mode hands over every key — arrows and Home
 * arrive as escape sequences, Tab and Ctrl+W as control characters — and a reader that kept them would
 * store a password the person never typed and cannot type again, locking every visitor out. Nothing is
 * echoed, so the person cannot see that it happened either.
 */
export class HiddenLine {
	/** What has been typed, one entry per code point, so Backspace never splits a surrogate pair. */
	private readonly characters: string[] = [];

	/** Where an escape sequence has got to: none, just after ESC, or inside a `CSI`/`SS3` sequence. */
	private escape: "none" | "started" | "sequence" = "none";

	/** The line so far. */
	get value(): string {
		return this.characters.join("");
	}

	/**
	 * Takes the characters one chunk of input carries.
	 *
	 * @param chunk What arrived.
	 * @returns `done` on Enter or Ctrl+D, `cancelled` on Ctrl+C, `more` otherwise.
	 */
	type(chunk: string): "done" | "cancelled" | "more" {
		for (const character of chunk) {
			const code = character.codePointAt(0) ?? 0;

			if (this.escape === "started") {
				// `ESC [` and `ESC O` open a sequence that runs to its final byte; ESC and any other key is
				// Alt+key, which is that one key and nothing more.
				this.escape = character === "[" || character === "O" ? "sequence" : "none";
				continue;
			}
			if (this.escape === "sequence") {
				if (code >= 0x40 && code <= 0x7e) this.escape = "none";
				continue;
			}

			if (character === "\r" || character === "\n" || character === "\u0004") return "done";
			if (character === "\u0003") return "cancelled";
			if (character === "\u001b") {
				this.escape = "started";
				continue;
			}
			if (character === "\u007f" || character === "\b") {
				this.characters.pop();
				continue;
			}
			// Ctrl+U clears the line, as it does at a shell prompt — somebody who pressed it meant to start
			// again, and typing on after it would otherwise append to what they meant to discard.
			if (character === "\u0015") {
				this.characters.length = 0;
				continue;
			}
			if (code < 0x20) continue;

			this.characters.push(character);
		}

		return "more";
	}
}
