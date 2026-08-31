# drop2run

Publish a static site to [Drop2Run](https://dropto.run) from the command line.

```
drop2run deploy [dir] [--site <subdomain>]   Publish a folder (default: .)
drop2run ls                                  List your sites
drop2run whoami                              Check the token and whose it is
drop2run where                               Show which token source is in use
```

`--json` on any command prints machine-readable output instead of text.

## Signing in

**There is no `drop2run login` yet.** It needs endpoints the API does not have — the loopback PKCE flow
in §4 of `docs/briefs/DEVTOOLS-BRIEF.md` — and a `login` that printed "not implemented" would be worse
than none, so the command does not exist rather than existing and lying.

Until then, create a token at <https://dropto.run/account/tokens> and either set it in the environment:

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

## Not published yet

`private: true`, because P2 is not finished: without `login` this is a tool that installs and then asks
you to go and paste a token by hand. The npm name `drop2run` is still unheld — a known risk, recorded in
§8 of the brief.

The bundle itself would work. `@drop2run/core` and `@drop2run/node` are resolved by build aliases rather
than installed, and `vite build` folds both into `dist/index.js`, so the tarball has no import pointing
at something npm cannot fetch. What is missing is a reason to release, not a way to.

## Running it from a checkout

```bash
cd packages/cli && npm run build
node bin/drop2run.mjs --help
```
