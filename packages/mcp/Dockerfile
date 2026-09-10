# Runs the MCP server in a container.
#
# Not how anybody is meant to run it — `npx -y @drop2run/mcp` is — and not, as this comment first
# claimed, a requirement of any directory. It was written for Glama's verification step, and then
# Glama turned out to generate its own Dockerfile from a form: base image, build steps, CMD. The
# equivalent there is `["npm --prefix packages/mcp ci", "npm --prefix packages/mcp run build"]` and
# `["node", "packages/mcp/bin/drop2run-mcp.mjs"]`, run against a clone of the whole repository.
#
# Kept because it still answers a real question — how do you start this thing somewhere unattended,
# with nothing installed — and because it is the one form of that answer that has been run rather
# than described.
#
# The build context is the repository root, not this directory. `packages/mcp` imports `@drop2run/core`
# and `@drop2run/node` through relative tsconfig paths, so a context of this directory alone cannot
# resolve them — the bundler folds both into dist/index.js and needs their sources present to do it.
#
# Introspection works without a credential on purpose. Every tool refuses without a token, but the
# token is read per call rather than at boot (see src/server.ts), so a client — or a directory's
# checker — can connect and list the three tools without one. A server that exited at startup for a
# missing token would fail this check while working perfectly for its users.
#
# Measured on 2026-09-10, against a filtered export rather than against the monorepo, because the
# export is the context a directory actually gets: the image builds at 62 MB, and piping an
# initialize / initialized / tools-list exchange into `docker run -i` with no environment at all
# returns serverInfo `drop2run` 0.2.0 and all three tools. stderr stayed empty and stdout carried
# nothing but the two JSON-RPC responses — the second half of working, since stdout is the transport
# and a stray line on it corrupts the protocol rather than turning up in a log.

FROM node:22-alpine AS build

WORKDIR /src

# The two internal packages first: they are sources rather than dependencies, and the bundle cannot be
# produced without them.
COPY packages/core ./packages/core
COPY packages/node ./packages/node
COPY packages/mcp ./packages/mcp

WORKDIR /src/packages/mcp

# `npm ci` rather than `npm install`: the lock file is committed, and a directory's check should build
# what was published rather than whatever resolves today.
RUN npm ci
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

# Only the real dependencies. `@modelcontextprotocol/sdk` and `zod` stay external to the bundle by
# design — vite.config.ts says why: inlining an SDK ships a copy that never gets a security update.
COPY packages/mcp/package.json packages/mcp/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /src/packages/mcp/dist ./dist
COPY --from=build /src/packages/mcp/bin ./bin

# stdio transport: the process talks MCP on stdin/stdout and must not be wrapped in a shell that could
# write anything of its own to stdout, which would corrupt the protocol rather than log somewhere.
ENTRYPOINT ["node", "bin/drop2run-mcp.mjs"]
