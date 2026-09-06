# @drop2run/mcp

An MCP server that publishes to [Drop2Run](https://dropto.run) from inside a chat. Three tools:

| Tool | What it does |
|---|---|
| `publish_html` | Takes one HTML document, publishes it as a whole site, returns the URL |
| `publish_dir` | Takes an absolute folder path and publishes it |
| `list_sites` | Lists the account's sites, so a publish can go to one of them |

## Getting a token

The server authenticates with a personal access token — there is no browser in a chat, so there is no
cookie to use. Create one at <https://dropto.run/account/tokens>. It is shown once and stored as a hash,
so it cannot be recovered afterwards.

Then either put it in the environment:

```
DROP2RUN_TOKEN=d2r_...
```

or in `~/.config/drop2run/config.json`:

```json
{ "token": "d2r_..." }
```

The environment wins. That file is deliberately the same one the `drop2run` CLI reads, so
`drop2run login` covers both — and so the two can never disagree about which account is yours.

Point it at a different API with `DROP2RUN_API_URL`, or `apiBaseUrl` in the same file.

## Wiring it up

```json
{
	"mcpServers": {
		"drop2run": {
			"command": "npx",
			"args": ["-y", "@drop2run/mcp"]
		}
	}
}
```

That is the whole configuration — `npx` fetches the package, and there is nothing to install globally.

To run it from a checkout instead, build first, because `dist/` is not in the repository:

```bash
cd packages/mcp && npm run build
node bin/drop2run-mcp.mjs
```

## Two decisions worth knowing about

**Publishing without naming a site creates a new one.** The obvious alternative — reuse the most recent —
would silently replace whatever the account last published, and a tool a model calls on somebody's
behalf is the worst place for that default. "Put this online" is not "and overwrite my last site".

**A token never reaches the storage host.** The bearer credential goes to the control plane only. The
file uploads are PUTs to presigned URLs on another host, which need nothing from us — a token attached
there would be an account credential handed to a service that never asked. There is a test for it,
because it is the kind of thing a later refactor tidies into a shared header helper.

## What the tarball contains

`bin/` and `dist/` only. `dist/index.js` is a bundle: the publish engine this package shares with the
`drop2run` CLI is folded in at build time, so nothing in the published files imports a package npm
cannot fetch.

The two real dependencies — the MCP SDK and zod — stay external and are installed by npm. Inlining an
SDK would mean shipping a copy that never gets a security update.
