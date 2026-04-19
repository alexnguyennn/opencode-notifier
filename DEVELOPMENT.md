# DEVELOPMENT.md

Working notes for hacking on this fork.

- Upstream: https://github.com/mohak34/opencode-notifier
- This fork: https://github.com/alexnguyennn/opencode-notifier
- Active feature branch: `feat/tmux-click-focus`

## What the fork adds

See [README.md](README.md) ("Fork note" block) and
[docs/tmux-wezterm.md](docs/tmux-wezterm.md) for the user-facing summary.
Deep-dive research notes are in [docs/dev-notes/](docs/dev-notes/).

Quick architecture recap:

- `src/tmux-context.ts` — captures `TMUX_PANE` / `WEZTERM_PANE` / session-
  window-pane ids / terminal app name **once at plugin init**.
- `src/tmux-indicator.ts` — waiting-indicator backends (`workmux`,
  `window-option`, `off`). `auto` picks workmux when on PATH.
- `src/notify.ts` — new `resolveMacBackend()` + `terminal-notifier -execute`
  dispatch path that wraps `scripts/opencode-focus-tmux.sh`.
- `scripts/opencode-focus-tmux.sh` — on-click helper. Runs `wezterm cli
  activate-pane` → `tmux switch-client` → `osascript activate`, each step
  fire-and-forget.
- `src/config.ts` — `macNotifier` + `tmux.{clickToFocus,indicator}` keys.
- `src/index.ts` — captures tmux context at init, threads it through
  `handleEvent`, drives the indicator on session lifecycle events.

## Build, typecheck, test

```bash
bun install
bun run build        # → dist/index.js
bun run typecheck    # tsc --noEmit
bun test             # 74/74 at time of writing
```

`bun run build` is what the shim (see below) consumes via `dist/index.js`.
**Re-run it after every edit** or opencode will keep loading the old build.

## Run the local build from opencode (iteration loop)

There are two ways to point opencode at this checkout instead of the
published `@mohak34/opencode-notifier` npm package. Both survive
restarts; both require `bun run build` after every source edit.

### Option A — local plugin shim (recommended for active dev)

Create `~/.config/opencode/plugins/opencode-notifier.ts` that re-exports
the built module:

```ts
// ~/.config/opencode/plugins/opencode-notifier.ts
// @ts-ignore — path import into a sibling checkout
import NotifierPlugin from '/ABSOLUTE/PATH/TO/opencode-notifier/dist/index.js';

export { NotifierPlugin };
export default NotifierPlugin;
```

Then in `~/.config/opencode/opencode.json` (or `.jsonc`) comment out or
remove the npm entry for `@mohak34/opencode-notifier@<version>`. OpenCode
auto-loads every `.ts` / `.js` file under `~/.config/opencode/plugins/`
at startup, so no other config is needed.

Why this form: matches the pattern used for other in-flight plugin forks,
keeps the fork wholly under `~/bench/dev/…`, and doesn't touch
`~/.config/opencode/package.json`. It's also the easiest form to revert
(delete one file + uncomment the npm entry).

### Option B — npm `file:` dependency

Edit `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@mohak34/opencode-notifier": "file:/ABSOLUTE/PATH/TO/opencode-notifier"
  }
}
```

Then clear opencode's cached resolution and restart:

```bash
rm -rf ~/.cache/opencode/node_modules/@mohak34/opencode-notifier
```

This form is closer to what upstream publishing looks like — useful if
you want to catch issues that only surface through the real package
resolution path. Shim is less ceremonious, so prefer A during dev.

### Tight iteration loop

```bash
# terminal 1 — the fork
bun run build

# terminal 2 — opencode
#   (exit the TUI and reopen; there is no hot-reload)
```

If you edit only `scripts/opencode-focus-tmux.sh`, no rebuild is needed
— the helper is invoked by shell, not bundled. Just save and click a
notification to test.

## Tests you'll actually need

- `bun test` in the repo root. Covers config parsing, focus detection,
  permission dedupe, `deriveMacAppName`, indicator idempotence, and
  `resolveMacBackend`.
- The in-tmux path of `captureTmuxContext` isn't unit-tested (needs a
  live tmux server). Cover it with the smoke tests below.

## Smoke test matrix (macOS)

Pre-reqs:

```bash
which terminal-notifier tmux osascript wezterm
# Allow terminal-notifier once via System Settings → Notifications.
terminal-notifier -message "perm check" -title opencode-notifier
```

Sanity-check the helper without opencode:

```bash
# From an opencode-hosting pane:
scripts/opencode-focus-tmux.sh \
    "$(tmux display -p '#{session_id}:#{window_id}.#{pane_id}')" \
    "WezTerm" \
    "$WEZTERM_PANE"
```

Full simulation — run from a DIFFERENT pane / app than the one you want
focused, then click the notification:

```bash
terminal-notifier \
    -title opencode \
    -message 'click me' \
    -execute "$PWD/scripts/opencode-focus-tmux.sh '$(tmux display -p '#{session_id}:#{window_id}.#{pane_id}')' 'WezTerm' '$WEZTERM_PANE'"
```

End-to-end via opencode:

| # | Host terminal | tmux? | Expected on click |
|---|---|---|---|
| 1 | WezTerm | yes | WezTerm pane + tmux pane both focused |
| 2 | WezTerm | no  | WezTerm pane focused |
| 3 | Ghostty / iTerm2 / Terminal.app | yes | terminal activates, tmux switches |
| 4 | Ghostty / iTerm2 / Terminal.app | no  | terminal activates |

Waiting indicator:

- With `workmux` on PATH and `tmux.indicator = "auto"` (default): should
  drive whatever the `workmux` CLI drives on your status line.
- With `tmux.indicator = "window-option"`: `●` appears next to the
  window name when opencode is waiting, clears on window focus. Needs
  the tmux.conf snippet from [docs/tmux-wezterm.md](docs/tmux-wezterm.md).

## Debugging on-click helper failures

`terminal-notifier -execute` runs the command via `/bin/sh -c` with a
**minimal env**, so `$PATH` is stripped. That's why the helper resolves
binaries itself. To debug:

```bash
# Run through bash -x and redirect trace to a file:
terminal-notifier -title opencode -message test \
    -execute "/bin/bash -x $PWD/scripts/opencode-focus-tmux.sh '$0:@1.%1' WezTerm '$WEZTERM_PANE' 2>>/tmp/opencode-focus.log"

tail -f /tmp/opencode-focus.log
# now click the notification
```

Common failures:

- **Click opens Script Editor** — `terminal-notifier` not on PATH at
  opencode-start time, so plugin fell back to `osascript display
  notification`. Install it and restart opencode.
- **Wrong pane focused** — context captured while you were in a
  different pane. Plugin captures once at init; restart opencode from
  inside the target pane.
- **WezTerm window raises but wrong pane** — `WEZTERM_PANE` wasn't set.
  Check `echo $WEZTERM_PANE` in the opencode-hosting pane.
- **tmux errors silently** — `tmux switch-client` fails without an
  attached client. Helper falls back to `attach-session` in the
  background; acceptable. If it's the only behaviour you see, you
  detached from the session — re-attach manually.

## Remotes

```bash
origin    git@github.com:alexnguyennn/opencode-notifier.git   (this fork)
upstream  https://github.com/mohak34/opencode-notifier.git    (original)
```

Sync with upstream:

```bash
git fetch upstream
git rebase upstream/main   # or main/master depending on upstream default
```

## Upstream PR

When the branch is ready to propose upstream:

```bash
git push -u origin feat/tmux-click-focus
gh pr create \
    --repo mohak34/opencode-notifier \
    --title "feat(tmux+wezterm): click-to-focus notifications + waiting indicator" \
    --body-file docs/tmux-wezterm.md
```

## Rollback

Disable the fork and go back to the published npm version:

1. Delete / rename `~/.config/opencode/plugins/opencode-notifier.ts`.
2. Re-enable the `@mohak34/opencode-notifier@<version>` entry in
   `~/.config/opencode/opencode.json`.
3. Restart opencode.
