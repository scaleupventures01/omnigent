# Statusline patch

The `statusline` branch adds a business-metrics group to omnigent's existing in-session `ComposerStatusLine`.

## Files

- `web/src/pages/ChatPage.tsx` fetches the local statusline endpoint and renders the business metrics in the composer status line.
- `web/src/lib/statuslineMetrics.ts` defines the statusline metrics data handling and formatting helpers.
- `web/vite.config.ts` configures the web build, including its output directory and statusline-related build behavior.
- `statusline-service/` keeps versioned source copies of the local HTTP service and launchd plist, plus installation notes.

## Rebuild

```sh
NODE=/Users/calvinwilliamsjr/.volta/tools/image/node/24.19.0/bin/node
PNPM=/Users/calvinwilliamsjr/Library/pnpm/.tools/pnpm/11.15.1/node_modules/pnpm/bin/pnpm.mjs
cd web && "$NODE" "$PNPM" build
```

The default Node 20 is too old for this pnpm release and fails with the misleading `No such built-in module: node:sqlite` error. Use the absolute Node 24 path above.

## Re-apply on a future release

Fetch the new release tag from upstream, then rebase this branch onto it:

```sh
git fetch upstream tag <new-tag>
git rebase <new-tag>
```
