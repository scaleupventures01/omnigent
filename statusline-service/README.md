# Omnigent statusline service

This service reads `~/.claude/statusline-data.json` and serves it as JSON at `http://127.0.0.1:6789/statusline`. It allows CORS requests from `http://localhost:6767` so the omnigent SPA can fetch business metrics across origins.

The files in this directory are the source of truth. The running copies are installed in `~/Library/Application Support/omni-statusline/` and `~/Library/LaunchAgents/`.

From the repository root, reinstall edited files with:

```sh
mkdir -p "$HOME/Library/Application Support/omni-statusline"
cp statusline-service/serve-statusline.mjs "$HOME/Library/Application Support/omni-statusline/serve-statusline.mjs"
cp statusline-service/com.calvin.omni-statusline.plist "$HOME/Library/LaunchAgents/com.calvin.omni-statusline.plist"
```

Reload the service in this exact order:

```sh
launchctl bootout gui/$(id -u)/com.calvin.omni-statusline
sleep 3
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.calvin.omni-statusline.plist"
```

The `sleep 3` is required. Running bootout and bootstrap back to back races and fails with `Bootstrap failed: 5: Input/output error`, which leaves the service down.

Do not re-point the plist at this repository because a branch checkout could delete the script out from under launchd.
