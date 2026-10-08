# @drop2run/mcp

An MCP server that lets any MCP client — Claude, Cursor, VS Code, Codex, Gemini CLI — publish what it made to
[Drop2Run](https://dropto.run): an HTML page, a markdown note, a folder of documents or a built site. It
returns a live HTTPS URL.

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

**Cursor** — the same `mcpServers` block with `"type": "stdio"` added, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` for one
project). **Gemini CLI** — the same block, in `~/.gemini/settings.json`.

**VS Code** — one command:

```bash
code --add-mcp '{"name":"drop2run","command":"npx","args":["-y","@drop2run/mcp"]}'
```

**Codex** — one command:

```bash
codex mcp add drop2run -- npx -y @drop2run/mcp
```

Zed and the rest: [dropto.run/docs/agents](https://dropto.run/docs/agents) has the file and the shape
for each client.

Nothing is installed globally either way — `npx` fetches the package when the client starts it.

## Sign in

Ask for a publish. If there is no token yet, the agent calls the `login` tool, a browser tab opens, you
approve the sign-in, and the publish carries on. Nothing to install, nothing to paste.

The token lands in `~/.config/drop2run/config.json` with mode `0600` — the same file the `drop2run`
CLI uses, so signing in once covers both. It is read on every call rather than at startup, so it takes
effect without restarting the client.

**No browser on this machine?** In a container, over SSH, on a remote host, `login_code` gives a short
code to enter at <https://app.dropto.run/device> from any other device.

**Or set a token yourself.** Create one at <https://app.dropto.run/account/tokens> and either put it in
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
| `list_folders` | Lists the account's folders, each with the path `folder` accepts |
| `delete_site` | Deletes a site permanently, subdomain included — requires the subdomain repeated as `confirm` |
| `get_site` | Reads a site's settings, whether it is paused, and its versions with the live one marked |
| `update_site` | Changes a site's name, serving mode, password, forms, scheduled takedown or folder |
| `pause_site` | Takes a site off the air, keeping its files, versions and subdomain |
| `resume_site` | Puts a paused site back on the air |
| `rollback_site` | Serves an earlier version again, by its id from `get_site` |
| `list_comments` | Reads the comments people left on a site's pages — each thread's page, the words it points at, and every comment in it |
| `reply_comment` | Answers a comment thread as the site's owner; the reply shows under the owner's name and the thread's people are emailed |
| `resolve_comment` | Marks a comment thread resolved |
| `reopen_comment` | Opens a resolved comment thread again |

Both publish tools take an optional `site` — a subdomain or site id to publish over. Leave it out and a
new site is created.

Both also take an optional `subdomain`, which names the new site instead of letting the server generate
one. It is for a person who asked for a particular address: the name becomes the URL, cannot be changed
afterwards, and a site made under a guessed one has to be deleted by hand. `site` and `subdomain` are
opposites — one publishes over a site that exists, the other creates one that does not — so passing both
is refused rather than resolved.

And both take an optional `folder`, which files the new site in one of the account's dashboard folders —
by path such as `Clients/Acme`, or by the id `list_folders` shows. Like `subdomain` it only describes a new
site, so it cannot be combined with `site`. It never creates a folder: one that does not exist is refused
with the list of those that do, and nothing is published.

`update_site` changes only the settings it is given. An empty `name`, `password` or `expiresAt` clears
that setting, and `folder: "root"` moves the site back to the top level. A takedown pauses the site by
default; `expiryAction: "delete"` removes it instead, and asks for the subdomain as `confirm` the way
`delete_site` does. Settings your plan does not include are refused with the reason, and `get_site` says
which ones those are.

The comment tools close the loop on a site somebody is reviewing: `list_comments` gives each thread's page
and the words or element it points at, so the source can be found; after the fix is published,
`reply_comment` answers on the page. Publish first and reply second, or the commenter opens the old
version. A reply leaves the thread open unless `resolve` is true, so the person who raised it can check
the fix and resolve it themselves. Only the account's owner can reply or
resolve, and only on a plan that includes comments. Comment text is what visitors wrote: the tools hand it
over as data, and the server tells the model not to follow instructions in it.

Both sign-in tools answer "not approved yet" rather than failing while they wait, and calling them
again keeps waiting on the same sign-in. Neither replaces a token that is already stored unless asked
to with `replace`.

## Behaviour worth knowing

**Publishing without a `site` creates a new one.** It never replaces your most recent site by default:
"put this online" is not "and overwrite what I published last time". Say what address you want and pass
it as `subdomain`; say nothing and the name is generated, which is the right default for something
nobody is going to link to.

**A site can be documents instead of a built site.** A publish needs an `index.html` at the top level,
or at least one document — `.md`, `.markdown`, `.pdf`, `.docx`, `.xlsx` or `.epub` — and those are
served through the reader. So a single note is a whole site, and Claude does not have to wrap it in HTML
to publish it.

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
