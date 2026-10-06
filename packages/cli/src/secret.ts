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
		let value = "";

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
		 * Handles what was typed, character by character, since raw mode delivers no lines.
		 *
		 * @param chunk The characters that arrived.
		 */
		function onData(chunk: string) {
			for (const character of chunk) {
				if (character === "\r" || character === "\n" || character === "\u0004") {
					finish();
					resolve(value);
					return;
				}
				if (character === "\u0003") {
					finish();
					reject(new Error("Cancelled."));
					return;
				}
				if (character === "\u007f" || character === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				value += character;
			}
		}

		input.on("data", onData);
	});
}
