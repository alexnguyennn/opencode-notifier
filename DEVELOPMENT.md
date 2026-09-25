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
- `scripts/opencode-focus-tmux.sh` — on-click helper. Resolves the live
  WezTerm tab/pane and tmux client from the registered socket, activates
  the tab/pane and exact tmux target, then raises WezTerm.
- `src/config.ts` — `macNotifier` + `tmux.{clickToFocus,indicator}` keys.
- `src/index.ts` — captures tmux context at init, threads it through
  `handleEvent`, drives the indicator on session lifecycle events.
- `src/v2.ts` and `src/v2-tui.ts` — adapt OpenCode V2 events and register
  the visible session's pane without changing the published V1 entrypoint.

## Build, typecheck, test

```bash
mise x bun@1.3.13 -- bun install
mise x bun@1.3.13 -- bun run build      # → dist/index.js, dist/v2.js, dist/v2-tui.js
mise x bun@1.3.13 -- bun run typecheck  # tsc --noEmit
mise x bun@1.3.13 -- bun test
```

`mise x bun@1.3.13 -- bun run build` is what the shims below consume.
**Re-run it after every edit** or opencode will keep loading the old build.

## Run the local build from opencode (iteration loop)

There are two ways to point opencode at this checkout instead of the
published `@mohak34/opencode-notifier` npm package. Both survive
restarts; both require `mise x bun@1.3.13 -- bun run build` after every
source edit.

### Option A — local plugin shim (recommended for active dev)

For OpenCode V2, create `~/.config/opencode/plugin/opencode-notifier.ts`
(singular `plugin`) with a native V2 definition that lazily loads the bundle:

```ts
// ~/.config/opencode/plugin/opencode-notifier.ts
export default {
  id: 'opencode-notifier',
  async setup(context: unknown) {
    const { default: notifier } = await import(
      '/ABSOLUTE/PATH/TO/opencode-notifier/dist/v2.js'
    );
    return notifier.setup(context as never);
  },
};
```

For OpenCode V1, use the same pattern under the legacy `plugins/` directory
and import `dist/index.js` as the default export instead.

Then in `~/.config/opencode/opencode.json` (or `.jsonc`) comment out or
remove the npm entry for `@mohak34/opencode-notifier@<version>`. OpenCode
auto-loads local plugin files at startup, so no other config is needed.

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
mise x bun@1.3.13 -- bun run build

# terminal 2 — opencode
#   (exit the TUI and reopen; there is no hot-reload)
```

If you edit only `scripts/opencode-focus-tmux.sh`, no rebuild is needed
— the helper is invoked by shell, not bundled. Just save and click a
notification to test.

## Tests you'll actually need

### V2 session-to-pane notifications (2026-09-24)

The server bundle (`dist/v2.js`) listens for durable `session.execution.succeeded` events and sends one completion per event, grouped by **session ID**. `session.idle` is ignored for V2 to prevent double alerts. The separate TUI bundle (`dist/v2-tui.js`) registers its inherited, validated tmux pane and currently visible root session via the `opencode-notifier-pane` RPC; leases expire after four seconds and refresh every second. With duplicate viewers the most recently registered/activated one wins, and routine lease refreshes do not change that ordering. The server validates the pane/socket again at notification time. Session-scoped question, permission, plan-review, error and other V2 alerts resolve the same pane (following parent sessions for subagents). No valid viewer means a session-unique notification without a click target; it never guesses from the server's ambient tmux environment.

The V2 setup registers a `session.prompt` hook before returning. The SSE feed can only connect after setup returns, so on its `server.connected` handshake it checks prompts observed during that gap and catches up successful completions. A first fast `opencode run` on a cold location otherwise can finish before the feed subscribes; a subsequent run already on that location does notify. Never await `server.connected` inside setup: that deadlocks activation in OpenCode 2.0.14.

The V2 event SSE is global, even though each server plugin instance belongs to one location. Events must be matched to their payload/session location before processing. Without that filter, an unrelated location can win the event-ID debounce and label a stop alert with the wrong project (and a null or wrong pane). V2's legacy hook adapter is explicitly given no ambient tmux context; only the registered TUI owner can add a click target to a completion alert.

The pane RPC route is also global: updates can land on `/Users/alex` while completion events are handled by another location. OpenCode loads separate copies of the V2 bundle for those locations, so a module-level registry is insufficient; `globalThis.__opencodeNotifierV2Panes` shares leases between copies in the server process. The tool hook must filter its session's location just like SSE events, or question alerts can be emitted under the wrong project. Already-delivered alerts cannot acquire a click action retroactively, and a server restart requires reopening each TUI to restore registrations.

The focus helper clears a stale `WEZTERM_UNIX_SOCKET`, maps the registered tmux client's tty to a live WezTerm pane **and tab**, activates both, selects the exact tmux window/pane, then raises the terminal. `activate-pane` alone leaves another WezTerm tab visible. The active Hammerspoon notification picker now leaves Notification Center closure to a successful notification action, rather than sending Escape shortly after activation.

For non-consuming Hammerspoon focus, terminal-notifier alerts with a pane now carry a short body token. `src/focus-actions.ts` saves the corresponding target in private files under `~/.local/state/opencode-notifier/focus-actions/`; the picker reads that record and invokes the helper without clicking the NC item. The helper's fifth argument checks that a saved tmux pane still runs OpenCode. The native `-execute` action remains available for consuming clicks. WezTerm tab/pane activation does not raise a *different native WezTerm window*; the helper also raises the window matching a uniquely identified live mux window title.

The focus record also carries optional session title and project name for a readable picker row. These fields are presentation-only; the 12-hex token stays in the native notification body for identity but is hidden in the chooser. `Command-Backspace` dismisses one selected item and refreshes the visible chooser so several alerts can be triaged in sequence.

The active profile loads `plugin/opencode-notifier.ts` for the server and `plugins/opencode-notifier-pane/tui.ts` for the TUI. Build all three bundles with `mise x bun@1.3.13 -- bun run build`, then restart the shared service and each TUI to load both entrypoints. For another installation, provide both a V2 server entrypoint loading `dist/v2.js` and a V2 TUI entrypoint loading `dist/v2-tui.js`.

Live smoke matrix (after restarting; keep the server shared):

1. Start two tmux/WezTerm TUIs in the **same folder**, each showing a different root session. Submit a prompt to both. Each completion should create its own notification, even if the messages and completion times coincide; click/Enter on each should activate that session's WezTerm/tmux pane.
2. Open the same root session in both panes. A completion should create one notification; its click target should be the most recently registered viewer. Switch a pane to another session and repeat to confirm the former session no longer routes there.
3. Complete a server-created session with no TUI viewer. It should still notify with no focus action. Close a TUI or wait over four seconds after disconnect and repeat to check lease expiry.
4. Repeat with a non-default tmux socket (`tmux -L ...`) to confirm the click helper passes the registered socket to tmux.

Progress board: delivery and cross-location focus bridge implemented; same-folder two-session delivery and isolated-socket completion click verified through native Notification Center and the Hammerspoon picker. A fresh question alert in the user's reopened TUI focused its exact pane (`%110`). Non-consuming Enter focus (with alert retained), consuming Command-Return/right-click, and individual Command-Backspace dismissal were live-proven with disposable alerts; cross-window WezTerm focus was also verified. Follow-up on 2026-09-25: the picker now stays open after consecutive dismissals, re-applies its search via `refreshChoicesCallback(true)`, hides body tokens, and shows saved session titles; identical native test alerts with different saved titles were live-tested, then dismissed in sequence. Question/plan/permission/error resolver and subagent-parent tests pass. The shared service restarted again at 12:07 on 2026-09-25 with the rebuilt notifier; `opencode service status` returned `http://127.0.0.1:49374`, and `opencode plugin list` in the active profile included `opencode-notifier`. Existing TUI pane registrations may need reopening after that restart. A fresh permission click and two-TUI same-session viewer-switch smoke remain follow-up checks.

- `mise x bun@1.3.13 -- bun test` in the repo root. Covers config parsing, focus detection,
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
# Run through bash -x and redirect trace to a file. Either use bash -x
# directly (catches a crash before the script even starts) or set the
# OPENCODE_FOCUS_DEBUG env var to a log path (script self-enables -x):
terminal-notifier -title opencode -message test \
    -execute "/bin/bash -x $PWD/scripts/opencode-focus-tmux.sh '$0:@1.%1' WezTerm '$WEZTERM_PANE' 2>>/tmp/opencode-focus.log"

# Or (preferred - works inside opencode too since terminal-notifier
# inherits env from the opencode process):
OPENCODE_FOCUS_DEBUG=/tmp/opencode-focus.log \
    $PWD/scripts/opencode-focus-tmux.sh '$0:@1.%1' WezTerm '$WEZTERM_PANE'

tail -f /tmp/opencode-focus.log
# now click the notification
```

Common failures:

- **Click opens Script Editor** — `terminal-notifier` not on PATH at
  opencode-start time, so plugin fell back to `osascript display
  notification`. Install it and restart opencode.
- **Wrong wezterm window takes the tmux switch** — happens when you
  have multiple WezTerm panes with tmux clients attached to different
  sessions. The helper resolves this at click time by querying
  `tmux list-clients -t <session>` for the LIVE client tty, matching
  it against `wezterm cli list` to find the pane, and passing
  `switch-client -c <tty>` to tmux so exactly that client is switched
  (not an arbitrarily-chosen one). If the resolution fails (e.g. tmux
  session not currently attached), falls back to the captured initial
  `WEZTERM_PANE` from plugin init.
- **Wrong pane focused** — if the above resolution fails entirely,
  context captured at plugin init is used. That's stale if you started
  opencode outside tmux and later attached from tmux. Restart opencode
  inside the target pane to re-capture.
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

1. Delete / rename `~/.config/opencode/plugin/opencode-notifier.ts` (V2) or
   `~/.config/opencode/plugins/opencode-notifier.ts` (V1).
2. Re-enable the `@mohak34/opencode-notifier@<version>` entry in
   `~/.config/opencode/opencode.json`.
3. Restart opencode.
