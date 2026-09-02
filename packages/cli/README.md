# drop2run

Publish a static site to [Drop2Run](https://dropto.run) from the command line.

```bash
npm i -g drop2run
drop2run login
drop2run deploy dist
```

Node 20 or newer. That is the whole of it: `login` opens a browser and stores a token, `deploy` prints the
URL. Full documentation at [dropto.run/docs/cli](https://dropto.run/docs/cli).

```
drop2run login [--device]                    Sign in and store a token
drop2run logout                              Remove the stored token
drop2run init [dir] [--site <subdomain>]     Tie this folder to a site
drop2run deploy [dir] [--site <subdomain>]   Publish a folder
drop2run ls                                  List your sites
drop2run open [site]                         Open a site in a browser
drop2run rollback <deployId> [--site X]      Put an earlier version back live
drop2run rm <site> --yes                     Delete a site and everything on it
drop2run token list                          List your access tokens
drop2run whoami                              Check the token and whose it is
drop2run where                               Show which token source is in use
```

`--json` on any command prints machine-readable output instead of text.

## Which site a command acts on

`--site`, then `drop2run.json`, then a new one. `init` writes that file, so this is the whole of a
normal project:

```bash
drop2run init dist        # creates a site, writes drop2run.json
drop2run deploy           # publishes dist to it, no arguments
```

The order is not a convenience. A `deploy` that created a site while a project file sat next to it would
leave the real site untouched and the person looking at a URL they did not expect.

`rm` is the one command that will not act on what it worked out: it prints the site it would delete and
stops, and only runs with `--yes`. There is no undo — the files go and the subdomain is released — and a
terminal has no confirmation dialog, so the flag is the dialog.

`token create` and `token revoke` do not exist; see below.

## Signing in

`drop2run login` opens a browser, waits on `127.0.0.1`, and stores the token it is handed in
`~/.config/drop2run/config.json` with mode `0600`.

Two things about it are worth knowing, because they decide when it works:

- **It needs a browser and loopback on the same machine.** The token is delivered by a redirect to a
  temporary server this process opens on `127.0.0.1`, which is what keeps it out of clipboards and
  scrollback. A remote shell whose browser is on another machine cannot complete that redirect — use
  `--device` there.
- **It uses PKCE, so there is no client secret.** A verifier is generated per sign-in and never leaves the
  process; only its SHA-256 travels through the browser. A code intercepted anywhere along the way cannot
  be exchanged without the verifier.

### `--device`, for a machine with no browser

`drop2run login --device` prints a short code and waits. Enter it at <https://dropto.run/device> from any
machine you are signed in on — a phone will do — and the terminal picks up its token.

The short code is not the credential: it names the pending request, and approving it releases a long code
that never left the waiting process. Somebody reading it over your shoulder learns which sign-in is
waiting, not how to collect its token. It lasts fifteen minutes and works once.

For CI, neither flow applies — nothing there can open a browser or approve anything. Create a token at
<https://dropto.run/account/tokens> and either set it in the environment:

```
DROP2RUN_TOKEN=d2r_...
```

or put it in `~/.config/drop2run/config.json`:

```json
{ "token": "d2r_..." }
```

The environment wins. That is the same file and the same precedence `@drop2run/mcp` uses, so signing in
once covers both.

`drop2run where` says which source is in force without ever printing the token. That is deliberate: the
output of a command line ends up in issue reports, terminal recordings and CI logs, and "why is it using
the wrong account" is answerable without showing the secret.

## What `token create` is not

The brief's §5 lists `token create|list|revoke`. **Create and revoke cannot exist here**, and that is a
decision rather than an omission: a token that can mint tokens is not a leaked credential but a permanent
one — whoever takes it makes a second, and revoking the first changes nothing because the replacement is
one the owner never made and will not recognise. Both endpoints require a browser session. `gh` and
`vercel` draw the line in the same place.

`token list` does exist, and answers the question a terminal can answer: which machines are holding a
credential, and which of them has not used it since it was made. It prints prefixes, never secrets.
`token revoke` is refused with a message rather than treated as `list` — somebody will type it, and
listing instead would read as having worked.

---

Everything below is for whoever maintains this package. It is here rather than in the monorepo's docs
because it is about this directory — but it is on the npm page too, so it says who it is for.

## Releasing

**`0.1.0` is on npm, published 02/09/2026** — the first version worth installing. `0.0.0` is also there
and is not a release: it held the bare name `drop2run` (brief §9.1) and predates `login` entirely.

Verified from outside rather than from the publish output, because the failure mode worth ruling out is a
tarball with no `dist`:

```
$ npx drop2run@0.1.0 --version
0.1.0
```

The next one is the same command:

```bash
cd packages/cli && npm publish
```

`prepublishOnly` builds and runs the tests first, and that is load-bearing rather than tidy: `files` is
`["bin", "dist"]`, `dist` is gitignored, and `bin/drop2run.mjs` imports `../dist/index.js`. A publish from
a checkout that had not been built would ship a package that throws on its first line — at a version
number that can never be reused, because npm burns one even after `unpublish`.

**No `--provenance`, and not by oversight.** It needs a public repository, and this is a private monorepo;
the flag fails locally with `Automatic provenance generation not supported for provider: null` and would
fail in Actions too. Provenance arrives with the `drop2run-cli` split in brief §9.2 — which has its own
precondition, a `gitleaks` sweep of the whole history rather than of HEAD.

Two release chores still outstanding, neither blocking: changesets across `core` → `node` → `cli`, whose
versions have to move in that order, and the fact that this package is the only one of the four with a
licence field.

The bundle itself works. `@drop2run/core` and `@drop2run/node` are resolved by build aliases rather than
installed, and `vite build` folds both into `dist/index.js`, so the tarball has no import pointing at
something npm cannot fetch.

## Running it from the monorepo

```bash
cd packages/cli && npm run build
node bin/drop2run.mjs --help
```
