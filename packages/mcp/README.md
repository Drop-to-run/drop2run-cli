# @drop2run/mcp

An MCP server that lets Claude — or any MCP client — publish a static site to
[Drop2Run](https://dropto.run). Give it a folder or an HTML document; it returns a live HTTPS URL.

Full documentation at [dropto.run/docs/mcp](https://dropto.run/docs/mcp).

## Setup

**Claude Desktop** — download [`drop2run.mcpb`](https://dropto.run/drop2run.mcpb) and open it. Claude
shows an install dialog; that is the whole of it. No terminal, no config file to edit, and nothing to
install first — Claude for macOS and Windows ships the node this runs on.

**Claude Code** — one command:

```bash
claude mcp add drop2run -s user -- npx -y @drop2run/mcp
```

**Claude Desktop, from npm instead** — if you would rather run the published package than the bundle,
add this to `claude_desktop_config.json` and restart the app:

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

Ask for a publish. If there is no token yet, Claude calls the `login` tool, a browser tab opens, you
approve the sign-in, and the publish carries on. Nothing to install, nothing to paste.

The token lands in `~/.config/drop2run/config.json` with mode `0600` — the same file the `drop2run`
CLI uses, so signing in once covers both. It is read on every call rather than at startup, so it takes
effect without restarting the client.

**No browser on this machine?** In a container, over SSH, on a remote host, `login_code` gives a short
code to enter at <https://dropto.run/device> from any other device.

**Or set a token yourself.** Create one at <https://dropto.run/account/tokens> and either put it in
`~/.config/drop2run/config.json` as `{"token": "d2r_..."}`, which needs no restart, or set
`DROP2RUN_TOKEN` in the environment the client starts the server in. The environment takes precedence
over the file — and because it is read once at startup, setting it in a shell afterwards changes
nothing until the client restarts the server.

A token is shown once and stored as a hash, so it cannot be read back later — create a new one if you
lose it.

## The tools

| Tool | What it does |
|---|---|
| `login` | Signs in through a browser on this machine and stores the token |
| `login_code` | Signs in with a short code approved elsewhere, where no browser can be opened |
| `publish_files` | Publishes files Claude wrote — a page, a markdown note, several files together |
| `publish_dir` | Publishes a folder, given its absolute path |
| `list_sites` | Lists the sites on the account |
| `delete_site` | Deletes a site permanently, subdomain included — requires the subdomain repeated as `confirm` |

Both publish tools take an optional `site` — a subdomain or site id to publish over. Leave it out and a
new site is created.

Both sign-in tools answer "not approved yet" rather than failing while they wait, and calling them
again keeps waiting on the same sign-in. Neither replaces a token that is already stored unless asked
to with `replace`.

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

**"No Drop2Run access token."** — the server is running but has no token. Ask Claude to sign in, which
calls `login`; or run `npx drop2run login` yourself. Either writes the same file, and no restart is
needed.

**The browser never opened.** `login` says so and returns the URL instead — open it anywhere on this
machine, then ask Claude to call `login` again. The URL stays valid. On a machine with no browser at
all, use `login_code`.

**You signed in but publishing is still refused.** Check for `DROP2RUN_TOKEN` in the environment the
client started the server in: it outranks the file that was just written. `login` says so when it finds
one.

**Claude Desktop cannot start it** — Desktop does not inherit your shell's `PATH`. Use the absolute path
to `npx` (`which npx`) as `command`.

Needs Node 20 or newer. MIT licensed.
