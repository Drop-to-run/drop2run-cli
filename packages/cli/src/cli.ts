import {
	type CommandResult,
	deployCommand,
	list,
	login,
	logout,
	where,
	whoami,
} from "./commands.js";

/**
 * Parses the command line and runs the matching command.
 *
 * <b>No argument-parsing library.</b> The surface is four commands and three flags, and the whole
 * parser is the function below. A library would be a dependency in a package people install globally and
 * hand a credential to, which is the last place to add code nobody in this repository reads.
 *
 * `login` covers the loopback flow only. There is no `--device` yet, so an environment where no browser
 * can reach this machine's loopback — a remote container, a plain SSH session — still needs a token
 * created by hand, and the help text says so rather than offering a flag that does nothing.
 */

/** What the CLI prints when asked, and when it does not understand. */
const HELP = `drop2run — publish a static site from the command line

  drop2run login                               Sign in through a browser and store a token
  drop2run logout                              Remove the stored token
  drop2run deploy [dir] [--site <subdomain>]   Publish a folder (default: .)
  drop2run ls                                  List your sites
  drop2run whoami                              Check the token and whose it is
  drop2run where                               Show which token source is in use
  drop2run --version                           Print the version

Flags
  --json      Print machine-readable output instead of text
  --site X    Publish over an existing site rather than creating one

Signing in without a browser
  \`login\` opens a browser and listens on 127.0.0.1, so it needs both on this
  machine. For CI, or a remote shell, create a token at
  https://dropto.run/account/tokens and either set DROP2RUN_TOKEN in your
  environment or put it in ~/.config/drop2run/config.json as {"token": "d2r_..."}.
`;

/**
 * Pulls a `--flag value` out of the arguments.
 *
 * @param args Remaining arguments.
 * @param flag Flag to look for.
 * @returns The value, or undefined.
 */
function flagValue(args: readonly string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	if (at === -1) return undefined;

	const value = args[at + 1];

	// A flag with nothing after it, or followed by another flag, is a typo rather than an empty value.
	return value === undefined || value.startsWith("-") ? undefined : value;
}

/**
 * Runs the CLI.
 *
 * @param argv Arguments after the program name.
 * @returns What to print and the exit code.
 */
export async function run(argv: readonly string[]): Promise<CommandResult> {
	const json = argv.includes("--json");
	const positional = argv.filter((argument) => !argument.startsWith("-"));
	const [command, ...rest] = positional;

	if (argv.includes("--version")) {
		// Read from the manifest rather than written here, so the two cannot disagree about what shipped.
		const { version } = await import("../package.json", { with: { type: "json" } }).then(
			(module) => module.default as { version: string },
		);

		return { text: version, json: { version }, code: 0 };
	}

	// Asking for help succeeds; being run with nothing at all does not. The two used to share one branch
	// and `command === undefined` decided the code, which made `drop2run --help` exit 1 — help is not a
	// positional argument, so it looked identical to no arguments. A CLI whose --help fails is a CLI that
	// fails a `set -e` script written to check it.
	const askedForHelp = argv.includes("--help") || argv.includes("-h") || command === "help";

	if (askedForHelp) return { text: HELP, json: { help: HELP }, code: 0 };
	if (command === undefined) return { text: HELP, json: { help: HELP }, code: 1 };

	const site = flagValue(argv, "--site");
	const result = await dispatch(command, rest, site, json);

	return json ? { ...result, text: JSON.stringify(result.json, null, 2) } : result;
}

/**
 * Picks the command.
 *
 * @param command First positional argument.
 * @param rest Remaining positional arguments.
 * @param site Value of `--site`, if given.
 * @param json Whether `--json` was asked for, which decides whether progress may be printed. Only
 * `login` needs it: it is the one command that says something while it waits, and prose interleaved with
 * a JSON document is not JSON.
 * @returns The command's result.
 */
async function dispatch(
	command: string,
	rest: readonly string[],
	site: string | undefined,
	json: boolean,
): Promise<CommandResult> {
	switch (command) {
		case "login":
			// Progress goes to stderr, so a shell reading stdout gets only the result even without --json.
			return await login(json ? () => {} : (line) => console.error(line));
		case "logout":
			return logout();
		case "deploy":
			return await deployCommand(rest[0] ?? ".", site);
		case "ls":
		case "list":
			return await list();
		case "whoami":
			return await whoami();
		case "where":
			return where();
		default:
			return {
				text: `Unknown command "${command}".\n\n${HELP}`,
				json: { error: `Unknown command "${command}".` },
				code: 1,
			};
	}
}
