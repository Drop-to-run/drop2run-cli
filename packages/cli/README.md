# drop2run

Command-line deploys for [Drop2Run](https://dropto.run). **Not released yet** — this package currently
holds the name and nothing else.

Publishing a site today means dropping a folder at <https://dropto.run>. The CLI is P2 of
`docs/briefs/DEVTOOLS-BRIEF.md`; its planned surface is in §5 of that file.

## Why a placeholder was published

Creating the npm organisations reserved the `@drop2run` **scope**. It did not reserve the unscoped name,
which was measured rather than assumed — `registry.npmjs.org/drop2run` answered 404 with all three orgs
already in place. npm documents that an org name cannot collide with an existing package, but the
direction that matters here is the opposite one, and it is not answerable from outside. §5 wants
`npm i -g drop2run` to work, and the only thing that certainly reserves an unscoped name is a publish.

## Before publishing anything from here

```bash
npm pack --dry-run
```

Read the file list it prints. `files` is a whitelist (`["bin"]`) rather than an `.npmignore` blacklist,
so the tarball should contain the bin script, this README and `package.json` — nothing from `apps/`,
`docs/` or `.claude/`. Publishing a repository private is fine; publishing the wrong files out of it is
not undoable.

⚠️ **A published version is burned permanently.** `npm unpublish` has a 72-hour window and conditions,
and the number cannot be reused even after a successful unpublish. `0.0.0` is deliberately the number
nobody would want for a release. Do not bump it to ship the real CLI — that release picks its own first
version.
