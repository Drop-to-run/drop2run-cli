#!/usr/bin/env node
/**
 * Placeholder entry point for the `drop2run` CLI.
 *
 * <b>Why this exists at all.</b> Creating the npm organisations reserved the `@drop2run` scope and
 * nothing else — measured rather than assumed: `registry.npmjs.org/drop2run` still answered 404 with all
 * three orgs in place. `docs/briefs/DEVTOOLS-BRIEF.md` §5 plans to publish the CLI under that unscoped
 * name so `npm i -g drop2run` works, and the only thing that reserves an unscoped name is a publish.
 *
 * So this is published once, as 0.0.0, and replaced by the real CLI in P2. It prints where the product
 * is and exits non-zero, because a command that installed and then did nothing at all would read as a
 * broken install rather than an unreleased one.
 *
 * ⚠️ Do not bump this version to release. A published version is burned permanently — `npm unpublish`
 * has a 72-hour window and the number cannot be reused afterwards either. 0.0.0 was chosen as the number
 * nobody would want; the first real release picks its own.
 */

console.error(
	[
		"",
		"drop2run is not released yet.",
		"",
		"This is a placeholder holding the name. Until the CLI ships, publish a site by",
		"dropping a folder at https://dropto.run.",
		"",
	].join("\n"),
);

process.exit(1);
