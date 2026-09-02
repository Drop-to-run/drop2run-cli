# drop2run

Publish a static site to [Drop2Run](https://dropto.run) from the command line.

```
drop2run login [--device]                    Sign in and store a token
drop2run logout                              Remove the stored token
drop2run deploy [dir] [--site <subdomain>]   Publish a folder (default: .)
drop2run ls                                  List your sites
drop2run whoami                              Check the token and whose it is
drop2run where                               Show which token source is in use
```

`--json` on any command prints machine-readable output instead of text.

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

## Releasing

`0.0.0` is on npm, published to hold the bare name `drop2run` (brief §9.1). It is not a release: the
version says so, and what was on the registry at that point had no `login` at all.

`login` closes the reason there was nothing worth releasing. What still stands between here and a real
version is the release mechanics rather than the code — `npm pack --dry-run` on every publish, changesets
across `core` → `node` → `cli`, provenance, and a licence field on `core`, `node` and `mcp`, none of which
declare one. Brief §9.3 has the list and why each item is on it.

The bundle itself works. `@drop2run/core` and `@drop2run/node` are resolved by build aliases rather than
installed, and `vite build` folds both into `dist/index.js`, so the tarball has no import pointing at
something npm cannot fetch.

## Running it from a checkout

```bash
cd packages/cli && npm run build
node bin/drop2run.mjs --help
```
