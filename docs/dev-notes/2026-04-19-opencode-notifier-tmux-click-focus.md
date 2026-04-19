# Investigation - opencode-notifier: tmux click-to-focus (local fork)

> Generated 2026-04-19

## Request
- Input mode: search
- Original input: "opencode-notifier click-on-notification focuses default osa editor instead of
  the tmux session that stopped. Clone locally, implement click-to-focus. Also integrate
  'stopped' tmux indicators per https://blog.oponomarov.com/posts/opencode-tmux-notifications/"

## Context Sources
- Ponomarov blog post + shmileee gist - full reference implementation of tmux
  `@opencode_waiting` window-status indicator and session.idle notification wiring
- mohak34/opencode-notifier `src/` - current plugin architecture, `notify.ts` macOS
  dispatch paths (osascript / node-notifier / ghostty OSC 9), `focus.ts` terminal-app
  detection map
- terminal-notifier 2.0.0 CLI reference - `-execute` + `-group` flags are the
  click-to-focus primitive (osascript's `display notification` cannot do this; clicks
  open Script Editor)
- tmux(1) man page - `switch-client -t <session>:<window>.<pane>` works cross-session
  when target contains `:` `.` or `%`
- Local config: `~/.config/opencode/opencode.jsonc` pins `@mohak34/opencode-notifier@0.2.2`;
  `~/.config/opencode/plugins/opentmux.ts` already demonstrates the local-clone shim
  pattern we will mirror

## Mapping
- Service: alex local dev (opencode plugins)
- Confidence: high
- Repositories: mohak34/opencode-notifier (to be forked to ~/bench/dev/opencode-notifier)
- Pipelines: n/a (local Bun build)
- Kubernetes: n/a
- Jira defaults: none (personal tooling)

## Findings

### Root cause
`src/notify.ts` on macOS shells out to `osascript -e 'display notification …'`. macOS
always routes clicks on those banners to Script Editor (the "sender" app) - there is no
way to attach a click handler from osascript. This is the documented behaviour, not a
bug in the plugin.

### Fix approach
Switch the macOS dispatch path to `terminal-notifier -execute <focus-cmd>` when (a)
`terminal-notifier` is on PATH and (b) we have tmux context captured at plugin init.
Fall back to the existing osascript path otherwise.

### Tmux context required for targeting
Must be captured **once at plugin load**, never at event time (by then the attached
tmux client may have moved, so `tmux display-message` with no `-t` returns the wrong
pane). Required fields:

| Field | Source | Purpose |
|---|---|---|
| `TMUX_PANE` env | `process.env.TMUX_PANE` | Seed for `display-message -t` |
| `session_id` | `tmux display-message -p -t $TMUX_PANE '#{session_id}'` | Stable across renames |
| `window_id` | same | Stable across window renumber |
| `pane_id` | same | Stable for pane lifetime |
| `session_name` / `window_name` | same | Human-readable notification body |
| Terminal app name | `TERM_PROGRAM` + Alacritty/Kitty env fallbacks | For `osascript activate` |

Target string for `switch-client -t`: `${session_id}:${window_id}.${pane_id}` e.g.
`$0:@3.%42`.

### Waiting indicator strategy (2-tier)
User already has a `workmux` CLI (driven by `~/.config/opencode/plugin/workmux-status.ts`).
The new plugin will:

1. Detect `workmux` on PATH. If present, call `workmux set-window-status waiting`
   (on idle/permission) and `workmux set-window-status working` (on busy).
2. Otherwise fall back to the blog-post `@opencode_waiting` pattern:
   `tmux set-window-option -q -t <window_id> @opencode_waiting '●'` and
   `tmux set-window-option -q -u -t <window_id> @opencode_waiting` to clear.

### Coexistence with workmux-status.ts
`workmux-status.ts` drives the same workmux CLI on the same events. To avoid double
writes we will gate the new plugin's indicator behind a config flag `tmuxIndicator`
with values `auto` (default, writes only if workmux **not** on PATH), `workmux`
(always use workmux), `window-option` (always use the @opencode_waiting fallback),
`off`. With the current local setup (`workmux` is on PATH), `auto` resolves to "do
nothing - let workmux-status.ts handle it" and we avoid duplicate calls. When
workmux is absent we take over.

### Gotchas (from research)
- `terminal-notifier -execute` runs via `/bin/sh -c` with a **minimal env**. Every
  binary in the focus command must be an absolute path (`/usr/bin/osascript`,
  `/etc/profiles/per-user/alex/bin/tmux`, `/run/current-system/sw/bin/terminal-notifier`).
- `-sender` disables `-execute`. Don't combine.
- `terminal-notifier` needs notification permission granted once in System Settings.
- `switch-client` errors if no client is attached; fall back to `attach-session -t`.
- `osascript tell application "X" to activate` **launches** the app if it's not
  running. Prefer `System Events → tell process → set frontmost true` to fail silently.
- Plugin must early-return all tmux logic when `TMUX_PANE` is unset (opencode started
  outside tmux).

## Likely Explanations
1. `src/notify.ts` uses `osascript display notification` by default. macOS routes all
   clicks on those to Script Editor - nothing the plugin can do from that path.
2. No tmux context is captured anywhere in the plugin, so even if click handling
   worked, the plugin wouldn't know which tmux session to focus.

## Gaps
- The plugin's config schema needs extending for `tmuxIndicator` and a new `backend:
  "terminal-notifier"` option on macOS. Upstream PR-worthy.
- `terminal-notifier` is a mac-only path. Linux/Windows continue with `node-notifier` /
  `notify-send`; only indicator wiring applies cross-platform.
- Behaviour when the user has multiple concurrent opencode sessions in different tmux
  windows: `-group "opencode-<session_id>"` collapses per opencode-session, so the most
  recent click still lands on the right pane. Good enough.

## Recommendations (execution plan)

Five stages. Each stage ends with a committed, compilable state.

### Stage 1 - Local fork + shim scaffolding
- `git clone https://github.com/mohak34/opencode-notifier.git ~/bench/dev/opencode-notifier`
- `git checkout -b feat/tmux-click-focus`
- `bun install && bun run build` to confirm upstream builds cleanly
- Create shim `~/.config/opencode/plugins/opencode-notifier.ts` that re-exports from
  `~/bench/dev/opencode-notifier/dist/index.js` (mirrors `opentmux.ts`)
- Comment out `"@mohak34/opencode-notifier@0.2.2"` in `opencode.jsonc` with a note
  pointing at the local checkout

### Stage 2 - Tmux context capture
- New file `src/tmux-context.ts`:
  - `captureTmuxContext()` - reads `TMUX_PANE`, resolves session/window/pane IDs via
    one `tmux display-message` call, derives terminal app name from `TERM_PROGRAM` +
    Alacritty/Kitty fallbacks
  - Returns `null` if not in tmux (early-return sentinel)
- Call from `src/index.ts` constructor, store module-scoped

### Stage 3 - Focus helper script
- New file `scripts/opencode-focus-tmux.sh`:
  - Args: `$1` target (`session:window.pane`), `$2` app name
  - `tmux switch-client -t "$TARGET"` with `attach-session -t "$SESSION"` fallback
  - `osascript -e 'tell application "System Events" to tell process "$APP" to set
    frontmost to true'` (silent failure) then `tell application "$APP" to activate`
    as fallback
  - Absolute paths to all binaries
  - `chmod +x` in `package.json` postinstall or via build step
- Resolved at plugin init; path stored for use in notification `-execute`

### Stage 4 - terminal-notifier dispatch path + indicator
- Extend `src/notify.ts`:
  - Detect `terminal-notifier` on PATH (cached at init). If present + tmux context +
    macOS, use it with `-group opencode-<session_id> -execute "<focus-script>
    '<target>' '<app>'"`
  - Otherwise unchanged (osascript / node-notifier / ghostty OSC 9)
- New file `src/tmux-indicator.ts`:
  - `setWaiting(ctx)` / `clearWaiting(ctx)`
  - Backend selection: config flag `tmuxIndicator` → `auto | workmux | window-option | off`
  - `auto` = workmux if on PATH else window-option
  - Guard against state churn (only write when value changes)
- Wire into `index.ts` event handler:
  - `session.idle` / `permission.asked` → `setWaiting`
  - `session.status` busy / `permission.replied` / `message.updated` (user role) →
    `clearWaiting`

### Stage 5 - Docs + tmux.conf snippet + build + verify
- README section: "Local fork: tmux click-to-focus" with the shim pattern
- `docs/tmux.md` snippet with `@opencode_waiting` tmux.conf block for fallback users
- `bun run build` produces fresh `dist/index.js`
- Smoke test checklist (see Test Instructions below)

## Jira Draft
n/a - personal tooling, no ticket needed unless you want to track the upstream PR.

## Execution Outcome

**Status:** ✅ shipped to `feat/tmux-click-focus` branch in `~/bench/dev/opencode-notifier`.

- Commit: `b21c197 feat(tmux+wezterm): click-to-focus notifications + waiting indicator`
- 12 files changed, 949 insertions(+), 29 deletions(-).
- All 74 unit tests pass (52 pre-existing + 22 new).
- TypeScript compiles clean (`tsc --noEmit` → exit 0).
- Build: `dist/index.js` 52 KB, parses via `node --check`.
- Shim installed at `~/.config/opencode/plugins/opencode-notifier.ts`.
- `@mohak34/opencode-notifier@0.2.2` commented out in `opencode.jsonc` with
  explanatory note.

**WezTerm support:** added in the same branch. Context capture now records
`WEZTERM_PANE` (available even inside tmux because WezTerm exports it to
the tmux server env), and the focus helper runs `wezterm cli activate-pane
--pane-id <N>` **before** `tmux switch-client` so the correct WezTerm
native window is raised first. AppleScript activation special-cases
WezTerm because its bundle name is `WezTerm` but the process name is
`wezterm-gui` (the helper tries both forms).

## Planning Handoff
- Problem statement: Notifications from `@mohak34/opencode-notifier` on macOS are
  dispatched via `osascript display notification`, which cannot carry click
  handlers. Clicking a notification opens Script Editor instead of focusing the
  tmux session where opencode is waiting. Must also work for users who run
  opencode inside WezTerm (with or without tmux).
- Constraints: Must coexist with existing workmux-based status indicators. Must
  not regress when opencode runs outside tmux. Must stay upstreamable (clean
  config flag, backward-compatible defaults). No new npm deps.
- Candidate workstreams: (a) local fork with terminal-notifier -execute click
  path + WezTerm activate-pane, (b) new sibling plugin — chose (a) to allow a
  clean upstream PR and single source of truth for notification behaviour.

---

## Test Instructions (to follow after build)

### Pre-reqs (verified present on this machine)
```bash
which terminal-notifier tmux osascript wezterm    # all should resolve
# Grant terminal-notifier notification permission if it hasn't already:
terminal-notifier -message "perm check" -title opencode-notifier
#   -> allow in System Settings → Notifications → terminal-notifier
```

### Verify the local build is healthy
```bash
cd ~/bench/dev/opencode-notifier
git log --oneline feat/tmux-click-focus -3
# expect: b21c197 feat(tmux+wezterm): click-to-focus notifications + waiting indicator

bun test 2>&1 | tail -3
# expect: 74 pass, 0 fail

./node_modules/.bin/tsc --noEmit
echo "tsc=$?"    # expect: 0

ls -l dist/index.js    # built artifact, ~52 KB
```

### Verify the shim is wired up
```bash
cat ~/.config/opencode/plugins/opencode-notifier.ts
# should import from /Users/alex/bench/dev/opencode-notifier/dist/index.js

grep -n mohak34 ~/.config/opencode/opencode.jsonc
# should show the @mohak34/opencode-notifier@0.2.2 entry is commented out
```

### Smoke test 1 — click-to-focus (tmux + WezTerm)
1. In WezTerm, open two tmux windows inside one session. In window A, run
   `opencode`. In window B leave your shell.
2. In opencode (window A) send a prompt that takes >5 s to finish.
3. Switch to window B *inside* tmux (or switch to a different WezTerm tab
   entirely, or switch to another macOS app — all three should work).
4. When opencode's notification appears, click it.
5. **Expected:** the WezTerm window comes forward, the correct WezTerm pane
   is focused, tmux switches back to window A, and opencode's pane is
   active. No Script Editor.

### Smoke test 2 — click-to-focus (tmux without WezTerm)
1. Open Ghostty (or iTerm2). Inside it, start tmux and run opencode in a
   pane.
2. Send a long prompt, switch tmux away (or switch to another app).
3. Click the notification.
4. **Expected:** terminal app activates, tmux switches back to opencode's
   pane.

### Smoke test 3 — click-to-focus (WezTerm without tmux)
1. In WezTerm, open two panes. In pane A, start `opencode` directly (no
   tmux). In pane B, leave your shell.
2. Send a long prompt, focus pane B (or another app).
3. Click the notification.
4. **Expected:** WezTerm raises and activates pane A.

### Smoke test 4 — waiting indicator (workmux path)
1. Confirm `which workmux` resolves.
2. In tmux, kick off a long prompt in opencode. Switch away.
3. **Expected:** the existing workmux waiting glyph appears (driven by
   both this plugin and `workmux-status.ts`; writes are idempotent).
4. When opencode finishes, indicator clears.

### Smoke test 5 — waiting indicator (window-option fallback)
1. Force the window-option backend by writing to
   `~/.config/opencode/opencode-notifier.json`:
   ```json
   { "tmux": { "indicator": "window-option" } }
   ```
2. Add the tmux.conf snippet from
   `~/bench/dev/opencode-notifier/docs/tmux-wezterm.md` to your
   home-manager tmux module; `home-manager switch` (or
   `darwin-rebuild switch`).
3. Reload tmux: `tmux kill-server`, re-enter tmux.
4. Kick off a long opencode prompt, switch tmux away.
5. **Expected:** `●` appears next to the window name in tmux's status
   line. Clears when you select the window or when opencode resumes.
6. Revert the config change.

### Smoke test 6 — non-tmux, non-WezTerm fallback
1. In Apple Terminal or iTerm2 (no tmux), start opencode.
2. Kick off a long prompt, move focus away.
3. Click the notification.
4. **Expected:** the terminal app activates. No tmux errors in logs.

### Smoke test 7 — running opencode bare (no terminal, no tmux)
1. Start opencode from a context where `TMUX_PANE` and `WEZTERM_PANE` are
   both unset (e.g. a Ghostty pane directly with opencode).
2. Observe: a notification fires. Clicking activates Ghostty but does no
   pane-level focus. Nothing breaks.

### Manual script test (fast iteration without opencode)
```bash
# Verify the helper itself works:
~/bench/dev/opencode-notifier/scripts/opencode-focus-tmux.sh \
    "$(tmux display -p '#{session_id}:#{window_id}.#{pane_id}')" \
    "WezTerm" \
    "$WEZTERM_PANE"

# Full simulation — run from a DIFFERENT terminal/app than the one you
# want focused, then click the notification:
terminal-notifier \
    -title opencode \
    -message 'click me' \
    -execute "$HOME/bench/dev/opencode-notifier/scripts/opencode-focus-tmux.sh '$(tmux display -p '#{session_id}:#{window_id}.#{pane_id}')' 'WezTerm' '$WEZTERM_PANE'"
```

### Logs to check on failure
```bash
# opencode plugin logs:
tail -n 200 -f ~/.local/state/opencode/log/*.log 2>/dev/null | grep -iE 'notifier|tmux|wezterm'

# Bash trace of the helper on click:
terminal-notifier -title opencode -message test \
    -execute "/bin/bash -x $HOME/bench/dev/opencode-notifier/scripts/opencode-focus-tmux.sh '$0:@1.%1' WezTerm '$WEZTERM_PANE' 2>>/tmp/opencode-focus-tmux.log"
# then `tail -f /tmp/opencode-focus-tmux.log` and click the notification.
```

### Pick up changes after editing the clone
```bash
cd ~/bench/dev/opencode-notifier && bun run build
# Then restart opencode (exit the TUI and reopen).
```

### Rollback
- Edit `~/.config/opencode/opencode.jsonc`: uncomment
  `"@mohak34/opencode-notifier@0.2.2"`.
- Delete or rename `~/.config/opencode/plugins/opencode-notifier.ts`.
- Restart opencode.

### Open a PR upstream (optional)
```bash
cd ~/bench/dev/opencode-notifier
gh repo fork mohak34/opencode-notifier --remote=true
git push -u origin feat/tmux-click-focus
gh pr create --title "feat(tmux+wezterm): click-to-focus notifications + waiting indicator" \
    --body-file docs/tmux-wezterm.md
```
