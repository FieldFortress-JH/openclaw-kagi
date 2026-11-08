# openclaw-kagi

Privacy-first web search powered by [Kagi](https://kagi.com) for [OpenClaw](https://openclaw.ai).

Uses your existing Kagi subscription through a Kagi Session Link, so no API key or extra cost is needed.

Fork of [its-clawdia/openclaw-kagi](https://github.com/its-clawdia/openclaw-kagi), updated for OpenClaw 2026.11.

## Requirements

- OpenClaw 2026.11.2 or newer
- Node 22 or newer (for building)

## Install

OpenClaw installs plugin dependencies with `--ignore-scripts`, so it never builds TypeScript. Build a package tarball and install that:

```bash
git clone https://github.com/FieldFortress-JH/openclaw-kagi
cd openclaw-kagi
npm ci
npm test
npm pack                      # runs the build, writes openclaw-kagi-<version>.tgz
openclaw plugins install npm-pack:./openclaw-kagi-1.1.0.tgz
```

Don't use `openclaw plugins install openclaw-kagi` or `clawhub:openclaw-kagi`. Those install the upstream package, not this fork.

## Setup

1. Go to https://kagi.com/settings/user_details and copy your **Session Link**.
2. Send this to OpenClaw:

   ```
   /kagi session https://kagi.com/search?token=...
   ```

3. Select Kagi as the search provider:

   ```json5
   {
     tools: {
       web: {
         search: {
           provider: "kagi",
         },
       },
     },
   }
   ```

The Session Link logs in to your whole Kagi account. Set it with `/kagi session` rather than pasting it into a normal chat message, because a normal message stays in the conversation history and goes to the model provider.

It's stored in `$OPENCLAW_STATE_DIR/kagi.config.json` (default `~/.openclaw/kagi.config.json`), and only the owner can read it (mode `0600`). As a fallback, the plugin also reads `plugins.entries.kagi.config.webSearch.apiKey`, which is what the OpenClaw setup wizard writes. If both are set, the `/kagi session` store wins.

## Commands

| Command | Description |
|---------|-------------|
| `/kagi session <session-link>` | Save your Kagi Session Link |
| `/kagi status` | Check whether a Session Link is configured |
| `/kagi clear` | Delete the saved Session Link |

## Supported parameters

| Parameter | Support |
|-----------|---------|
| `query` | ✅ |
| `count` | ✅ (1-10, default 5) |
| `country` | ❌ |
| `language` | ❌ |
| `freshness` | ❌ |

`tools.web.search.timeoutSeconds` (default 30) and `tools.web.search.cacheTtlMinutes` (default 15, `0` turns the cache off) apply.

## Notes

- Session Links expire after 90 days of inactivity, or when you log out of the session they came from. When a link expires, the plugin tells the agent to ask for a new one.
- The plugin reads Kagi's HTML results page. If Kagi changes its markup, searches return `parse_breakage` until `src/search/selectors.json` is updated.
- OpenClaw only allows bundled or verified official search providers for sandboxed agents, so this plugin works for non-sandboxed agents only.

## Development

```bash
npm ci
npm run build
npm test
```

Tests use a temporary `OPENCLAW_STATE_DIR` and never touch your real Session Link.

## License

MIT
