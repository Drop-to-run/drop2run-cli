# drop2run

Publish a static site to [Drop2Run](https://dropto.run) from the command line.

```bash
npm i -g drop2run
drop2run login
drop2run deploy dist
```

Node 20 or newer. `login` opens a browser and stores a token, `deploy` prints the URL. Full
documentation at [dropto.run/docs/cli](https://dropto.run/docs/cli).

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
drop2run --version                           Print the version
```

`--json` on any command prints machine-readable output instead of text.

## Which site a command acts on

`--site`, then `drop2run.json`, then a new one. `init` writes that file, so this is the whole of a
normal project:

```bash
drop2run init dist        # creates a site, writes drop2run.json
drop2run deploy           # publishes dist to it, no arguments
```

`deploy` never creates a second site while a `drop2run.json` sits next to it — that would leave the real
site untouched and you looking at a URL you did not expect.

`rm` prints the site it would delete and stops; it only runs with `--yes`. There is no undo — the files
go and the subdomain is released.

## Signing in

`drop2run login` opens a browser, waits on `127.0.0.1`, and stores the token it is handed in
`~/.config/drop2run/config.json` with mode `0600`. It uses PKCE, so there is no client secret to leak.

It needs a browser and loopback **on the same machine**: the token arrives by redirect to a temporary
server on `127.0.0.1`, which is what keeps it out of clipboards and scrollback. On a remote shell, use
`--device` instead.

### `--device`, for a machine with no browser

`drop2run login --device` prints a short code and waits. Enter it at <https://dropto.run/device> from any
machine you are already signed in on — a phone will do — and the terminal picks up its token.

The short code is not the credential; it names the pending request, so somebody reading it over your
shoulder learns which sign-in is waiting, not how to collect its token. It lasts fifteen minutes and
works once.

### CI

Neither flow works in CI — nothing there can open a browser or approve anything. Create a token at
<https://dropto.run/account/tokens> and set it in the environment:

```
DROP2RUN_TOKEN=d2r_...
```

The environment wins over `~/.config/drop2run/config.json`, and that is the same file and precedence
`@drop2run/mcp` uses, so signing in once covers both — in either direction. That server runs the same
two flows from its own `login` and `login_code` tools, so a sign-in done in a chat leaves this command
line signed in too.

`drop2run where` says which source is in force without printing the token, so "why is it using the wrong
account" is answerable in an issue report or a CI log.

## `token create` and `token revoke` do not exist

Both need a browser session, and that is deliberate rather than missing. A token that can mint tokens is
not a leaked credential but a permanent one: whoever takes it makes a second, and revoking the first
changes nothing. Make and revoke tokens at <https://dropto.run/account/tokens>.

`token list` does exist and answers what a terminal can answer — which machines hold a credential, and
which of them has not used it since it was made. It prints prefixes, never secrets.
