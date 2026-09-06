# @drop2run/mcp

An MCP server that lets Claude — or any MCP client — publish a static site to
[Drop2Run](https://dropto.run). Give it a folder or an HTML document; it returns a live HTTPS URL.

Full documentation at [dropto.run/docs/mcp](https://dropto.run/docs/mcp).

## Setup

**Claude Code** — one command:

```bash
claude mcp add drop2run -s user -- npx -y @drop2run/mcp
```

**Claude Desktop** — add this to `claude_desktop_config.json`, then restart the app:

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

That file is at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows.

Nothing is installed globally either way — `npx` fetches the package when the client starts it.

## Sign in

The server has no browser and no dashboard session, so it authenticates with a personal access token.
Two ways to give it one.

Through the CLI, which stores it in `~/.config/drop2run/config.json` with mode `0600`:

```bash
npx drop2run login
```

Or create a token at <https://dropto.run/account/tokens> and set it in the environment:

```
DROP2RUN_TOKEN=d2r_...
```

A token is shown once and stored as a hash, so it cannot be read back later — create a new one if you
lose it. The environment takes precedence over the file, and the file is the one the `drop2run` CLI
reads, so signing in once covers both.

The token is read on every call rather than at startup, so one added while the client is running takes
effect without a restart.

## The tools

| Tool | What it does |
|---|---|
| `publish_files` | Publishes files Claude wrote — a page, a markdown note, several files together |
| `publish_dir` | Publishes a folder, given its absolute path |
| `list_sites` | Lists the sites on the account |

Both publish tools take an optional `site` — a subdomain or site id to publish over. Leave it out and a
new site is created.

## Behaviour worth knowing

**Publishing without a `site` creates a new one.** It never replaces your most recent site by default:
"put this online" is not "and overwrite what I published last time".

**A site can be documents instead of a built site.** A publish needs an `index.html` at the top level,
or at least one `.md`, `.markdown` or `.pdf` file — those are served through the reader. So a single
note is a whole site, and Claude does not have to wrap it in HTML to publish it.

**`publish_files` is text.** A PDF or an image has to come off a disk with `publish_dir`, because these
files arrive as JSON strings.

**The URL comes back immediately; every edge has it in about a minute.** The reply also says whether a
new version was published, or every file already matched what the site serves.

**Default subdomains are not indexed.** Anything on `*.dropto.live` is served with
`X-Robots-Tag: noindex`. Attach a custom domain if you want the site in search results.

**Your token only ever reaches the Drop2Run API.** Files are uploaded to a separate storage host that
needs no credential from us, and none is sent there.

## Environment

| Variable | Effect |
|---|---|
| `DROP2RUN_TOKEN` | The personal access token. Takes precedence over the config file |
| `DROP2RUN_API_URL` | Point at a different API. Defaults to `https://dropto.run/api` |

## If something is wrong

**"No Drop2Run access token."** — the server is running but has no token. Run `npx drop2run login`, or
set `DROP2RUN_TOKEN`. No restart needed.

**Claude Desktop cannot start it** — Desktop does not inherit your shell's `PATH`. Use the absolute path
to `npx` (`which npx`) as `command`.

Needs Node 20 or newer. MIT licensed.
