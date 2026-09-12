#!/usr/bin/env node
/**
 * Builds `drop2run.mcpb`, the one-click bundle for Claude on macOS and Windows.
 *
 * <b>What a bundle is.</b> A zip holding a `manifest.json` and a local MCP server, opened rather than
 * installed: the host unpacks it and runs the entry point with the node it already ships, so nothing
 * on the person's machine has to exist first. That is the whole reason this format is worth carrying
 * beside the npm package — the npm path asks for a terminal, or for hand-edited JSON in
 * `claude_desktop_config.json`, and the people this product is for do not do either.
 *
 * <b>Why the checks below rather than a bare `mcpb pack`.</b> Three of the four ways this bundle can be
 * wrong produce an archive that packs cleanly and fails on somebody else's machine: a manifest whose
 * version has drifted from the package, an entry point the manifest names and the build did not write,
 * and a tool list that no longer matches the server. The fourth — a privacy policy URL that 404s — is
 * a rejection at review rather than a crash, and is warned about rather than failed on, because the
 * bundle is publishable from our own site long before it is submitted anywhere.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `packages/mcp` directory, resolved from this file rather than from the caller's cwd. */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the bundle's contents are assembled before they are zipped. */
const STAGE_DIR = join(PACKAGE_DIR, "mcpb");

/** The finished bundle. */
const OUTPUT = join(PACKAGE_DIR, "drop2run.mcpb");

/** Files copied into the bundle beside the built server. */
const COPIED = ["manifest.json", "icon.png", "README.md", "LICENSE"];

/**
 * Prints a step as it starts, so a failure is attributed to the thing that was running.
 *
 * @param message What is about to happen.
 */
function step(message) {
	console.log(`\n[1m${message}[0m`);
}

/**
 * Stops the build with a message that names the fix rather than the symptom.
 *
 * @param message What is wrong.
 */
function fail(message) {
	console.error(`\n[31m${message}[0m`);
	process.exit(1);
}

step("Building the single-file server");
// The npm build leaves the SDK external; this config inlines it. See vite.mcpb.config.ts for why the
// two distributions disagree on that.
execFileSync("npx", ["vite", "build", "--config", "vite.mcpb.config.ts"], {
	cwd: PACKAGE_DIR,
	stdio: "inherit",
});

step("Checking the manifest against the package");
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));

if (manifest.version !== pkg.version) {
	fail(
		`manifest.json is version ${manifest.version} and package.json is ${pkg.version}.\n` +
			"Nothing reads both, so they drift silently. Set them to the same number.",
	);
}

const entry = join(STAGE_DIR, manifest.server.entry_point);
if (!existsSync(entry)) {
	fail(
		`The manifest names ${manifest.server.entry_point}, which the build did not write.\n` +
			"A bundle that packs without its entry point installs and then does nothing.",
	);
}

step("Checking the manifest's tools against the server's");
// Read from the built artifact rather than from the source: what ships is what a reviewer sees, and a
// tool added to src without a rebuild would pass a source-level check.
const declared = (manifest.tools ?? []).map((tool) => tool.name).sort();
const built = readFileSync(entry, "utf8");
const missing = declared.filter((name) => !built.includes(`"${name}"`));
if (missing.length > 0) {
	fail(
		`The manifest declares tools the built server does not register: ${missing.join(", ")}.\n` +
			"The listing a person reads before installing would promise something that is not there.",
	);
}

step("Staging");
for (const file of COPIED) {
	const source = join(PACKAGE_DIR, file);
	if (!existsSync(source)) fail(`${file} is missing from packages/mcp, and the bundle needs it.`);
	copyFileSync(source, join(STAGE_DIR, file));
}

step("Packing");
rmSync(OUTPUT, { force: true });
execFileSync("npx", ["-y", "@anthropic-ai/mcpb@2", "pack", STAGE_DIR, OUTPUT], {
	cwd: PACKAGE_DIR,
	stdio: "inherit",
});

const size = statSync(OUTPUT).size;
console.log(`\n[32mdrop2run.mcpb — ${(size / 1024).toFixed(0)} KiB[0m`);
console.log(`  ${OUTPUT}`);

// Warned about rather than failed on: the bundle is worth shipping from our own site before any of it
// is submitted, and the policy only has to resolve by the time it is.
//
// The status code is not the check, and a first version of this used it and passed on a URL that did
// not exist. dropto.run is a single-page app behind `try_files {path} {path}.html /index.html`, so
// every path answers 200 with the home page — `/privacy` looked fine and was the marketing site. What
// separates a real page from the fallback is that the prerenderer gives each route its own title, so
// the test is whether this URL is a different document from the site root.
const policy = (manifest.privacy_policies ?? [])[0];
if (policy) {
	/**
	 * Reads a page's title.
	 *
	 * @param url The page.
	 * @returns The title, or null if the page could not be read.
	 */
	const titleOf = async (url) => {
		const response = await fetch(url).catch(() => null);
		if (!response?.ok) return null;

		return /<title>([^<]*)<\/title>/.exec(await response.text())?.[1] ?? null;
	};

	const [policyTitle, rootTitle] = await Promise.all([
		titleOf(policy),
		titleOf(new URL("/", policy).href),
	]);

	if (policyTitle === null || policyTitle === rootTitle) {
		console.warn(
			`\n[33mWarning: ${policy} is not a page of its own.[0m\n` +
				`  It answers with ${policyTitle === null ? "nothing" : `the site's own title, "${rootTitle}"`},\n` +
				"  which is what an unrouted path looks like on this site rather than a policy.\n" +
				"  The bundle is fine to hand out. Submission is not: a missing or incomplete privacy\n" +
				"  policy is an immediate rejection, not a review comment.",
		);
	} else {
		console.log(`\nPrivacy policy: ${policy} — "${policyTitle}"`);
	}
}

console.log("\nInstall it by opening the file with Claude for macOS or Windows.");
