import type { NewSite } from "@drop2run/node";
import {
	type CommandResult,
	deployCommand,
	folders,
	info,
	init,
	list,
	login,
	loginWithDevice,
	logout,
	open,
	pauseOrResume,
	remove,
	rollback,
	set,
	tokens,
	unset,
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
  drop2run init|deploy --subdomain <name>      Create a new site under a name you pick
  drop2run init|deploy --folder <path>         File the new site in one of your folders
  drop2run ls                                  List your sites
  drop2run folders                             List your folders, as --folder takes them
  drop2run open [site]                         Open a site in a browser
  drop2run info [site]                         Show a site's settings and versions
  drop2run set <setting> <value> [--site X]    Change one setting (see Settings below)
  drop2run unset name|password|expires         Clear a name, a password or a takedown
  drop2run pause [site]                        Take a site off the air, keeping its files
  drop2run resume [site]                       Put a paused site back on the air
  drop2run rollback <deployId> [--site X]      Put an earlier version back live
  drop2run rm <site> --yes                     Delete a site and everything on it
  drop2run token list                          List your access tokens
  drop2run whoami                              Check the token and whose it is
  drop2run where                               Show which token source is in use
  drop2run --version                           Print the version

Flags
  --json         Print machine-readable output instead of text
  --site X       Act on an existing site rather than the one in drop2run.json
  --subdomain X  Create a new site under this name (init and deploy only)
  --folder X     File the new site in this folder: a path such as Clients/Acme,
                 or a folder id (init and deploy only)
  --device       Sign in by approving a code on another machine
  --yes          Confirm a deletion, which cannot be undone
  --then X       What \`set expires\` does when the date arrives: pause
                 (the default, keeps the files) or delete (needs --yes)

Settings
  set name <text>               What the dashboard calls the site; put a
                                name with words starting "-" after --
  set mode static|spa|docs      static answers 404 for a missing path, spa
                                falls back to index.html, docs uses the viewer
  set password                  Typed at a hidden prompt, or piped in:
                                printf %s "$PW" | drop2run set password
  set forms on|off              Whether its forms accept submissions
  set expires <ISO 8601>        Take it down then, e.g. 2026-12-31T09:00:00Z
  set folder <path|id|root>     Move it to a folder, or root for the top level

  \`set\` and \`unset\` act on --site, else the site in drop2run.json. A
  setting your plan does not include is refused with the reason, and
  \`info\` says which ones those are.

Where a site comes from
  --subdomain creates one under the name you give. Otherwise: --site, then
  drop2run.json, then a new site with a generated name. \`init\` writes that
  file, so \`deploy\` in the same folder needs no arguments at all.

  --site only ever finds a site you already have; it never creates one, so a
  subdomain typed wrong fails instead of quietly becoming a second site.

  --folder only applies to a site being created. It never creates a folder
  and never moves an existing site; make and rearrange folders in the
  dashboard.

Signing in
  \`login\` opens a browser and listens on 127.0.0.1, so it needs both on this
  machine. Over SSH, in a container or under WSL, use \`login --device\`: it
  prints a short code to enter at https://app.dropto.run/device from anywhere.

  For CI, neither flow applies — create a token at
  https://app.dropto.run/account/tokens and either set DROP2RUN_TOKEN in your
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
 * Flags that take a value, so the word after them is theirs and not a positional argument.
 *
 * Kept as one list because the parser has two questions about a flag — what its value is, and whether
 * the next word belongs to it — and answering them from two lists is how they disagree.
 */
const VALUE_FLAGS = ["--site", "--subdomain", "--folder", "--then"];

/**
 * Pulls out the positional arguments, leaving flags and the values that belong to them behind.
 *
 * <b>What it fixes.</b> Filtering on "does not start with a dash" keeps the value of every flag, so
 * `deploy --subdomain my-docs` read `my-docs` as the folder to publish and failed on a path that does
 * not exist. `--site` had it too, and had it from the start: `deploy --site calm-cedar` published a
 * directory called `calm-cedar`, which is why every example in the documentation names the folder
 * first — the bug was invisible as long as a positional came before the flag.
 *
 * @param argv Arguments after the program name.
 * @returns The positional arguments, in order.
 */
function positionals(argv: readonly string[]): string[] {
	const found: string[] = [];

	for (let at = 0; at < argv.length; at++) {
		const argument = argv[at];
		if (argument === undefined) continue;

		if (VALUE_FLAGS.includes(argument)) {
			const value = argv[at + 1];

			// Only skip a real value. A flag at the end, or one followed by another flag, has none — and
			// swallowing the next word there would eat the command itself.
			if (value !== undefined && !value.startsWith("-")) at++;
			continue;
		}

		if (!argument.startsWith("-")) found.push(argument);
	}

	return found;
}

/** How one flag that describes a new site is named in its refusals. */
interface NewSiteFlag {
	/** The flag as typed, such as `--subdomain`. */
	readonly flag: string;
	/** A value to show in the example when the flag was given without one. */
	readonly example: string;
	/** What the flag does to the new site, completing "`--site` publishes to a site you already have, and …". */
	readonly effect: string;
	/** Appended when the flag reaches a command that cannot create a site, or empty for nothing. */
	readonly elsewhere: (command: string) => string;
}

/** `--subdomain`: the name of the site being created. */
const SUBDOMAIN_FLAG: NewSiteFlag = {
	flag: "--subdomain",
	example: "my-docs",
	effect: "`--subdomain` creates a new one",
	elsewhere: (command) => ` Use \`--site\` to tell \`${command}\` which of your sites to act on.`,
};

/** `--folder`: where the site being created is filed. */
const FOLDER_FLAG: NewSiteFlag = {
	flag: "--folder",
	example: "Clients/Acme",
	effect: "`--folder` only files a new one — move an existing site with `drop2run set folder`",
	elsewhere: (command) =>
		command === "ls" || command === "list" ? " `drop2run folders` lists them." : "",
};

/**
 * Says why a flag describing a new site cannot be honoured as typed, if it cannot.
 *
 * <b>Three ways to get it wrong, and each is refused rather than absorbed.</b> A flag with nothing after
 * it parses as undefined, which would otherwise be indistinguishable from not passing it — and the
 * silent outcome of that is a site created under a generated name, or at the top level, by somebody who
 * typed a flag specifically to avoid that. Given with `--site` it contradicts it: `--site` names a site
 * that must already exist, and both `--subdomain` and `--folder` describe one that does not yet. Given
 * to a command that only ever acts on an existing site, it has nothing to do, and ignoring it would read
 * as having worked.
 *
 * @param argv Every argument, needed to tell a flag with no value from an absent flag.
 * @param command First positional argument.
 * @param site Value of `--site`, if given.
 * @param value Value of the flag, if given with one.
 * @param described Which flag, and how its refusals word it.
 * @returns The refusal to print, or undefined when the flag is fine.
 */
function newSiteFlagProblem(
	argv: readonly string[],
	command: string,
	site: string | undefined,
	value: string | undefined,
	described: NewSiteFlag,
): string | undefined {
	const { flag, example, effect, elsewhere } = described;

	if (!argv.includes(flag)) return undefined;

	if (value === undefined) {
		return `\`${flag}\` needs a value after it, for example \`${flag} ${example}\`.`;
	}

	if (site !== undefined) {
		return (
			`\`--site\` and \`${flag}\` cannot both be given: \`--site\` publishes to a site you already ` +
			`have, and ${effect}. Drop whichever is not what you meant.`
		);
	}

	if (command !== "init" && command !== "deploy") {
		return (
			`\`${flag}\` only applies to \`init\` and \`deploy\`, which can create a site.` +
			elsewhere(command)
		);
	}

	return undefined;
}

/**
 * Runs the CLI.
 *
 * <b>`--` ends the flags.</b> Every word after it is positional, so `set name -- -draft` names a site
 * "-draft" instead of losing the word as an unknown flag. Flags are read only from what comes before it.
 *
 * @param commandLine Arguments after the program name.
 * @returns What to print and the exit code.
 */
export async function run(commandLine: readonly string[]): Promise<CommandResult> {
	const end = commandLine.indexOf("--");
	const argv = end === -1 ? commandLine : commandLine.slice(0, end);
	const literal = end === -1 ? [] : commandLine.slice(end + 1);
	const json = argv.includes("--json");
	const positional = [...positionals(argv), ...literal];
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
	const subdomain = flagValue(argv, "--subdomain");
	const folder = flagValue(argv, "--folder");

	const refusal =
		newSiteFlagProblem(argv, command, site, subdomain, SUBDOMAIN_FLAG) ??
		newSiteFlagProblem(argv, command, site, folder, FOLDER_FLAG);
	if (refusal !== undefined) {
		const failed = { text: refusal, json: { error: refusal }, code: 1 };

		return json ? { ...failed, text: JSON.stringify(failed.json, null, 2) } : failed;
	}

	// Checked here for the reason `--subdomain` is: a flag typed with no value would otherwise be read
	// as absent, and the absent case of this one is the pause somebody typed `--then` to avoid.
	const then = flagValue(argv, "--then");
	if (argv.includes("--then") && then === undefined) {
		const message = "`--then` needs a value: `--then pause` or `--then delete`.";
		const failed = { text: message, json: { error: message }, code: 1 };

		return json ? { ...failed, text: JSON.stringify(failed.json, null, 2) } : failed;
	}

	const result = await dispatch(
		command,
		rest,
		site,
		json,
		argv.includes("--device"),
		argv.includes("--yes"),
		{ subdomain, folder },
		then,
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
 * @param newSite Values of `--subdomain` and `--folder`, already checked against the command and `--site`.
 * @param then Value of `--then`, which only `set expires` reads.
 * @returns The command's result.
 */
async function dispatch(
	command: string,
	rest: readonly string[],
	site: string | undefined,
	json: boolean,
	device: boolean,
	confirmed: boolean,
	newSite: NewSite = {},
	then: string | undefined = undefined,
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
			return await init(rest[0] ?? ".", site, newSite);
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
			return await deployCommand(rest[0], site, report, newSite);
		}
		case "ls":
		case "list":
			return await list();
		case "folders":
			return await folders();
		case "open":
			return await open(rest[0] ?? site);
		case "info":
			return await info(rest[0] ?? site);
		case "set":
			// The site comes from `--site` only: the positions after `set` are the setting and its value,
			// and a name may be several words.
			return await set(site, rest[0], rest.slice(1), { then, confirmed });
		case "unset":
			return await unset(site, rest[0], rest.slice(1));
		case "pause":
		case "resume":
			return await pauseOrResume(command, rest[0] ?? site);
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
							"a token need a browser session, at https://app.dropto.run/account/tokens.",
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
