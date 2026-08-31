import { run } from "./cli.js";

/**
 * Runs the CLI and prints its result.
 *
 * Failure text goes to stderr and success to stdout, so `drop2run ls --json | jq` works and an error
 * does not end up inside the JSON somebody is piping.
 */
export async function main(argv: readonly string[]): Promise<never> {
	const result = await run(argv);

	if (result.code === 0) console.log(result.text);
	else console.error(result.text);

	process.exit(result.code);
}
