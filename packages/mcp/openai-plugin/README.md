# Drop2Run plugin for ChatGPT and Codex

The package OpenAI's plugin directory takes: the hosted MCP server at `https://mcp.dropto.run/mcp`, one skill,
the listing and the review cases. It is the Codex manifest format (`.codex-plugin/plugin.json`), which OpenAI
accepts for both ChatGPT and Codex.

```
.codex-plugin/plugin.json   listing (interface), review cases and release notes (extensions.com.openai)
.mcp.json                   the one remote MCP server
skills/publish/SKILL.md     how to publish, update and act on comments; also the onboarding skill
assets/                     logo.png (180×180) and icon.svg (square viewBox)
```

## Build the ZIP

The manifest must sit at the ZIP's root, so zip the folder's contents, not the folder:

```bash
cd packages/mcp/openai-plugin && zip -r ../drop2run-openai-plugin.zip . -x README.md
```

## Not in the ZIP, entered in the portal

- **Reviewer credentials**: `review@dropto.run` and its password from the password manager, in *Review
  details*. The ZIP refuses `test_credentials`. The account has no 2FA and is seeded with `npm run
  seed:review` in `apps/e2e`; the review cases name its `review-*` sites.
- **Demo recording**: `review.demo_recording_url` is left out until the walkthrough video exists.
- **Domain verification**: the token the portal shows goes in `OPENAI_APPS_CHALLENGE` in
  `apps/mcp/wrangler.jsonc`, served at `https://mcp.dropto.run/.well-known/openai-apps-challenge`.

## Rules the listing follows

- `displayName` and `shortDescription` are 30 characters at most. Neither one says "MCP" or "Plugin", and no
  listing text mentions prices, plans or trials.
- There are no screenshots, because the server returns no UI and OpenAI refuses screenshots without one.
  There are no hooks, `apps` or server `headers`, because each of those blocks a public submission.
- The MCP server's origin can never change for this plugin. A new origin means a new plugin.
