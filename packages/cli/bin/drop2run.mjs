#!/usr/bin/env node
/**
 * Entry point for `drop2run`.
 *
 * Thin on purpose: the shebang and the executable bit are the two things that have to survive being
 * published, and `.gitignore` has already eaten this directory once — see the commit that added the
 * negation for bin directories under packages.
 */
import { main } from "../dist/index.js";

await main(process.argv.slice(2));
