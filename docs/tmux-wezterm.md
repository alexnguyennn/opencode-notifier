# Tmux + WezTerm click-to-focus

This fork of `@mohak34/opencode-notifier` adds two capabilities on macOS:

1. **Click-to-focus** — clicking a notification brings the terminal back to
   the foreground and switches tmux to the session/window/pane where opencode
   is running. Also works when the host terminal is WezTerm (with or without
   tmux).
2. **Waiting indicator** — the tmux window that contains a waiting agent gets
   a visible status marker that clears automatically when the window is
   focused or when opencode resumes work.

Both features are macOS-only. Outside macOS the plugin falls back to the
existing `node-notifier` / `notify-send` paths.

## How click-to-focus works

On macOS, `osascript display notification` notifications cannot carry a click
handler — clicking them always opens Script Editor. The fork replaces the
macOS dispatch path with
[`terminal-notifier`](https://github.com/julienXX/terminal-notifier) and uses
its `-execute` flag to run a small shell helper on click. The helper does, in
order:

1. `wezterm cli activate-pane --pane-id <id>` if the host is WezTerm, to raise
   the correct WezTerm window and select the hosting pane.
2. `tmux switch-client -t '<session>:<window>.<pane>'` to switch the tmux
   client to the pane opencode was launched in.
3. `osascript` activation of the terminal app as a belt-and-braces step.

All context (tmux pane id, WezTerm pane id, terminal app name) is captured
**once at plugin init**. Polling later would give wrong answers because the
attached tmux client or the focused WezTerm pane may have moved.

## Requirements

- **terminal-notifier** on PATH: `brew install terminal-notifier`
  (or the nix package).
- **Grant notification permission** to terminal-notifier the first time it
  runs, via `System Settings → Notifications → terminal-notifier`. The first
  notification may be silently dropped before permission is granted.

## Configuration

Add to `~/.config/opencode/opencode-notifier.json`:

```jsonc
{
  // macOS dispatch backend. "auto" (default) picks terminal-notifier when on
  // PATH (click-to-focus works) and falls back to osascript otherwise.
  "macNotifier": "auto",

  "tmux": {
    // Clicking a notification runs the focus-tmux helper. Default true.
    "clickToFocus": true,

    // Waiting-indicator backend:
    //   "auto"          → write BOTH @opencode_waiting (always) and call
    //                     workmux set-window-status (if workmux on PATH).
    //                     Pair with the tmux format conditional below to
    //                     render workmux's glyph when set and the opencode
    //                     fallback otherwise. Recommended.
    //   "workmux"       → only call `workmux set-window-status`; don't
    //                     write @opencode_waiting. Use when you fully
    //                     trust workmux and don't want the fallback.
    //   "window-option" → only set @opencode_waiting; don't call workmux.
    //                     Use when workmux isn't installed at all.
    //   "off"           → never touch the tmux status line.
    "indicator": "auto"
  }
}
```

## `tmux.conf` changes (drop-in block)

With the default `"auto"` indicator backend, the plugin **always** writes
the tmux user-option `@opencode_waiting` on the window where opencode is
waiting, **and** — if the `workmux` CLI is on PATH — additionally calls
`workmux set-window-status` so workmux's own glyph (`@workmux_status`)
can win when it fires. That way you get a reliable fallback whenever
workmux doesn't manage to set a symbol (which happens intermittently).

Three places can render the indicator:

1. the **status line** on each window tab,
2. the **session picker** (`prefix s` / `choose-tree -Zs`) — a dot next
   to any session that contains a waiting window,
3. the **window picker** (`prefix w` / `choose-tree -Zw`) — a dot next
   to the waiting window inside the expanded session.

Copy this block verbatim into `tmux.conf`. It's self-contained: if you
don't use workmux the `@workmux_status` branches render nothing and only
the opencode dot shows; if you do, workmux wins and opencode is the
fallback. Plays nicely with existing workmux keybindings like
`bind a run-shell "workmux last-done"` — those live elsewhere in your
config and don't interact with formats.

```tmux
# =======================================================================
# opencode-notifier + workmux waiting-indicator integration
# Docs: docs/tmux-wezterm.md in
# https://github.com/alexnguyennn/opencode-notifier
# =======================================================================

# --- 1. status line ----------------------------------------------------
# Prefer workmux's glyph when it set one; fall back to the opencode
# waiting dot (set by the plugin even when workmux is installed).
# Style to taste. The example below uses tmux-power defaults so you can
# adapt colour codes to whatever theme you run.
setw -g window-status-current-format '#[fg=#262626,bg=colour3]#[fg=#262626,bg=colour3,bold] #I:#W#F #[fg=colour3,bg=#262626,nobold]#{?@workmux_status, #{@workmux_status},#{?@opencode_waiting,#[fg=colour153] #{@opencode_waiting},}}'
setw -g window-status-format         '#[fg=#262626,bg=#3a3a3a]#[fg=colour3,bg=#3a3a3a] #I:#W#F #[fg=#3a3a3a,bg=#262626]#{?@workmux_status, #{@workmux_status},#{?@opencode_waiting,#[fg=colour153] #{@opencode_waiting},}}'

# --- 2. choose-tree: session + window pickers --------------------------
# Rebind prefix-s / prefix-w to the format-aware variants. We extend
# tmux's built-in three-branch default format (pane / window / session)
# with two additions:
#   - session row: trailing " ●" iff ANY window in the session has
#     @opencode_waiting set (aggregated via #{W:...}).
#   - window row:  trailing " ●" for the waiting window itself.
# Workmux doesn't touch the picker, so this is purely additive.
bind-key s choose-tree -Zs -F "#{?pane_format,\
#{?pane_marked,#[reverse],}#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,},\
#{?window_format,\
#{?window_marked_flag,#[reverse],}#{window_name}#{window_flags}#{?@opencode_waiting, #{@opencode_waiting},},\
#{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}#{?#{W:#{?@opencode_waiting,1,}}, ●,}\
}}"
bind-key w choose-tree -Zw -F "#{?pane_format,\
#{?pane_marked,#[reverse],}#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,},\
#{?window_format,\
#{?window_marked_flag,#[reverse],}#{window_name}#{window_flags}#{?@opencode_waiting, #{@opencode_waiting},},\
#{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}#{?#{W:#{?@opencode_waiting,1,}}, ●,}\
}}"

# --- 3. auto-clear on focus --------------------------------------------
# Drop the opencode marker the moment you land on the window, even if
# opencode didn't emit an event. Matches workmux's own auto-clear-on-
# focus behaviour so the two cooperate.
set-hook -g after-select-window    'set-window-option -q -u @opencode_waiting'
set-hook -g session-window-changed 'set-window-option -q -u @opencode_waiting'
set-hook -g client-focus-in        'set-window-option -q -u @opencode_waiting'

# =======================================================================
# End opencode-notifier block.
# =======================================================================
```

Reload tmux (`tmux source-file ~/.tmux.conf` or `tmux kill-server` +
re-enter) and you're done.

### Nix / Home Manager users

If tmux is generated by Nix, paste the above block into whichever module
drives `programs.tmux.extraConfig` (nix-darwin / home-manager) and
rebuild. The backslash line-continuations survive Nix string escaping
fine inside `extraConfig = '' ... ''` (which disables interpolation).

### Existing custom `window-status-format`?

If you already have a styled `window-status-format` (common with
tmux-power, tmux-powerline, etc.), don't wholesale replace it — just
**extend** the format conditional that renders workmux. Example turning
this:

```tmux
window-status-format "#[fg=colour3,bg=#3a3a3a] #I:#W#F #{?@workmux_status, #{@workmux_status},}"
```

into this:

```tmux
window-status-format "#[fg=colour3,bg=#3a3a3a] #I:#W#F #{?@workmux_status, #{@workmux_status},#{?@opencode_waiting, #{@opencode_waiting},}}"
```

(and identically for `window-status-current-format`). The key
structural change is the nested conditional in the "else" branch:
`#{?@workmux_status,<workmux glyph>,<opencode dot>}`.

### Test without waiting for opencode

```bash
# Mark the current window as waiting:
tmux set-window-option @opencode_waiting '●'
# All three indicators should now show:
#   - the window tab on the status line  → ●
#   - prefix s picker, current session   → ● at end of line
#   - prefix w picker, current window    → ● next to window name
#
# Clean up:
tmux set-window-option -u @opencode_waiting
```

### Opting out / opting in harder

- Don't want the fallback at all, only workmux? Set
  `"tmux": { "indicator": "workmux" }` in `opencode-notifier.json`.
- Don't have workmux and want only the `@opencode_waiting` path? Set
  `"tmux": { "indicator": "window-option" }`.
- Don't want any tmux writes? Set `"tmux": { "indicator": "off" }`.

## Troubleshooting

### Click does nothing / opens Script Editor

Notifications emitted via `osascript` always behave that way. Check:

```bash
which terminal-notifier   # must resolve
```

If absent, install and restart opencode.

### Wrong pane gets focused

The helper resolves the correct WezTerm pane **at click time**, not at
plugin init. It asks tmux which client tty is currently attached to the
notifying session, then matches that tty against the `tty_name` field of
`wezterm cli list` to find the exact WezTerm pane. So if you started
opencode in one WezTerm pane and later detached / re-attached the tmux
session from a different WezTerm pane, the click still focuses the live
pane.

If resolution fails (tmux session not currently attached to any WezTerm
pane, or `wezterm cli` unavailable), the helper falls back to the
`WEZTERM_PANE` that was captured when opencode started. That's the only
case where the pane can be wrong — usually when the hosting pane was
closed and a new pane took over the tmux session. Restart opencode in
the new pane to re-capture.

Verify resolution with the debug env var:

```bash
OPENCODE_FOCUS_DEBUG=/tmp/opencode-focus.log \
  ~/bench/dev/opencode-notifier/scripts/opencode-focus-tmux.sh \
  '<session_id>:<window_id>.<pane_id>' WezTerm "$WEZTERM_PANE"

tail -40 /tmp/opencode-focus.log
# look for lines:
#   + RESOLVED_WEZTERM_PANE=<n>
#   + RESOLVED_CLIENT_TTY=/dev/ttys<nn>
#   + tmux switch-client -c /dev/ttys<nn> -t '...'
```

### Wrong wezterm window takes the tmux switch

Before the client-tty fix, calling `tmux switch-client` without `-c`
picked an arbitrary attached client, so a WezTerm window you weren't
thinking about could have its tmux session switched out from under it.
The helper now passes `-c <client_tty>` so exactly the resolved client
is switched. If you see this regress, enable `OPENCODE_FOCUS_DEBUG` and
check for the `-c` flag in the `switch-client` invocation.

### Manual test of the helper

```bash
# Simulate a click. Replace values with your own from `tmux display -p`.
~/bench/dev/opencode-notifier/scripts/opencode-focus-tmux.sh \
  '$0:@1.%1' \
  WezTerm \
  "$WEZTERM_PANE"

# Simulate a notification (then click it):
terminal-notifier \
  -title opencode \
  -message 'click me' \
  -execute "$HOME/bench/dev/opencode-notifier/scripts/opencode-focus-tmux.sh '$0:@1.%1' 'WezTerm' '$WEZTERM_PANE'"
```
