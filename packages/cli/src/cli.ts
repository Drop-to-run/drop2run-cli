import {
	type CommandResult,
	deployCommand,
	init,
	list,
	login,
	loginWithDevice,
	logout,
	open,
	remove,
	rollback,
	tokens,
	where,
	whoami,
} from "./commands.js";
import { progressWriter, silentProgress } from "./progress.js";

/**
 * Parses the command line and runs the matching command.
 *
 * <b>No argument-parsing library.</b> The surface is four commands and three flags, and the whole
 * parser is the function below. A library would be a dependency in a package people install globally and
 * hand a credential to, which is the last place to add code nobody in this repository reads.
 *
 * `login` has two flows and `--device` picks between them. They are not variations of one thing: the
 * default opens a browser and a local port, and `--device` opens neither and waits for somebody to approve
 * a code on another machine. Which one is right is decided by where the browser is, so it is a flag rather
 * than something the command could work out.
 */

/** What the CLI prints when asked, and when it does not understand. */
const HELP = `drop2run — publish a static site from the command line

  drop2run login [--device]                    Sign in and store a token
  drop2run logout                              Remove the stored token
  drop2run init [dir] [--site <subdomain>]     Tie this folder to a site (writes drop2run.json)
  drop2run deploy [dir] [--site <subdomain>]   Publish a folder (default: . or drop2run.json)
  drop2run ls                                  List your sites
  drop2run open [site]                         Open a site in a browser
  drop2run rollback <deployId> [--site X]      Put an earlier version back live
  drop2run rm <site> --yes                     Delete a site and everything on it
  drop2run token list                          List your access tokens
  drop2run whoami                              Check the token and whose it is
  drop2run where                               Show which token source is in use
  drop2run --version                           Print the version

Flags
  --json      Print machine-readable output instead of text
  --site X    Act on an existing site rather than the one in drop2run.json
  --device    Sign in by approving a code on another machine
  --yes       Confirm a deletion, which cannot be undone

Where a site comes from
  --site, then drop2run.json, then a new one. \`init\` writes that file, so
  \`deploy\` in the same folder needs no arguments at all.

Signing in
  \`login\` opens a browser and listens on 127.0.0.1, so it needs both on this
  machine. Over SSH, in a container or under WSL, use \`login --device\`: it
  prints a short code to enter at https://dropto.run/device from anywhere.

  For CI, neither flow applies — create a token at
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
	const result = await dispatch(
		command,
		rest,
		site,
		json,
		argv.includes("--device"),
		argv.includes("--yes"),
	);

	return json ? { ...result, text: JSON.stringify(result.json, null, 2) } : result;
}

/**
 * Picks the command.
 *
 * @param command First positional argument.
 * @param rest Remaining positional arguments.
 * @param site Value of `--site`, if given.
 * @param json Whether `--json` was asked for, which decides whether progress may be printed. `login`
 * and `deploy` need it: they are the commands that say something while they work, and prose interleaved
 * with a JSON document is not JSON.
 * @param device Whether `--device` was given, which picks between the two sign-in flows.
 * @param confirmed Whether `--yes` was given, which is the only confirmation a deletion gets.
 * @returns The command's result.
 */
async function dispatch(
	command: string,
	rest: readonly string[],
	site: string | undefined,
	json: boolean,
	device: boolean,
	confirmed: boolean,
): Promise<CommandResult> {
	switch (command) {
		case "login": {
			// Progress goes to stderr, so a shell reading stdout gets only the result even without --json.
			const print = json ? () => {} : (line: string) => console.error(line);

			// `--device` is read here rather than inside the command, because the two are different flows
			// rather than one flow with a flag: one opens a browser and a local port, the other opens
			// neither and waits on somebody else's machine.
			return device ? await loginWithDevice(print) : await login(print);
		}
		case "logout":
			return logout();
		case "init":
			return await init(rest[0] ?? ".", site);
		case "deploy": {
			// Progress on stderr, for the same reason `login` puts it there: a shell reading stdout gets
			// the URL and nothing else, with or without --json. Suppressed entirely under --json, where
			// carriage returns interleaved with a JSON document are not a JSON document.
			const report = json
				? silentProgress
				: progressWriter(
						(text) => process.stderr.write(text),
						process.stderr.isTTY === true,
						process.stderr.columns ?? 80,
					);

			// Undefined rather than "." so `deployCommand` can tell "no folder given" from "this folder",
			// which is what lets drop2run.json supply one.
			return await deployCommand(rest[0], site, report);
		}
		case "ls":
		case "list":
			return await list();
		case "open":
			return await open(rest[0] ?? site);
		case "rollback":
			return await rollback(rest[0], site);
		case "rm":
			return await remove(rest[0] ?? site, confirmed);
		case "token":
		case "tokens":
			// One subcommand, and an unknown one is refused rather than treated as `list`: `token revoke`
			// is a thing somebody will type, and silently listing instead would read as having worked.
			return rest[0] === undefined || rest[0] === "list"
				? await tokens()
				: {
						text:
							`\`token ${rest[0]}\` does not exist. Only \`token list\` does: creating and revoking ` +
							"a token need a browser session, at https://dropto.run/account/tokens.",
						json: { error: `Unknown token subcommand "${rest[0]}".` },
						code: 1,
					};
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
