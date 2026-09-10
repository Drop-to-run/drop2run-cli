# drop2run-cli

Source for the two [Drop2Run](https://dropto.run) packages that run on your machine: the `drop2run`
command line tool and the `@drop2run/mcp` server.

Both are installed globally and then handed a credential. This repository exists so you can read what
you are giving that credential to.

```bash
npm i -g drop2run          # https://www.npmjs.com/package/drop2run
npx @drop2run/mcp          # https://www.npmjs.com/package/@drop2run/mcp
```

## What is in here

| Package | Published | What it is |
|---|---|---|
| `packages/cli` | [`drop2run`](https://www.npmjs.com/package/drop2run) | The command line tool: `login`, `deploy`, `ls`, `rollback`, `rm` |
| `packages/mcp` | [`@drop2run/mcp`](https://www.npmjs.com/package/@drop2run/mcp) | An MCP server, so an agent can publish what it just wrote |
| `packages/core` | no | The deploy engine — manifest, hashing, upload, go-live. No Node APIs, no browser APIs |
| `packages/node` | no | The parts that need `fs`: reading a folder, the config file, the token store |

`core` and `node` are not published. They are bundled into each package's `dist/` at build time, which
is why `drop2run` installs with **no runtime dependencies at all** — an intentional choice for
something that holds a token. `@drop2run/mcp` has two, both required by the protocol:
`@modelcontextprotocol/sdk` and `zod`.

## Building and testing

Each package stands alone — there is no workspace root, and internal imports resolve through the
relative `paths` in each `tsconfig.json`.

```bash
cd packages/cli     # or mcp, or node
npm ci
npm run typecheck
npm test
npm run build       # writes dist/, which is what npm ships
```

`packages/core` has no dependencies and no build of its own; it is typechecked by the packages that
bundle it.

## Where the rest is

This repository is an export of the four packages above, with their full history. The Drop2Run service
itself — the API, the edge router, the dashboard — is not here and is not open source. What that means
in practice: the code that decides what happens to a file after it leaves your machine is not something
this repository lets you audit. What it does let you audit is everything that happens to your files and
your token *before* that point, which is the part that runs with your privileges.

Issues about the CLI or the MCP server are welcome here. Anything about the hosted service belongs at
[dropto.run/contact](https://dropto.run/contact).

Pull requests are welcome too, with one thing worth knowing first: this repository is generated, so a
pull request is not merged **here**. The change is applied in the source repository and reaches this
one in the next export, with your commit and its authorship carried along; the pull request is then
closed with a link to the commit. Merging it here instead would put a commit in this history that no
future export contains, and the two would diverge on the very next update.

## Licence

MIT.
