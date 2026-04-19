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

## `@opencode_waiting` fallback (tmux.conf)

With the default `"auto"` indicator backend, the plugin **always** writes
the tmux user-option `@opencode_waiting` on the window where opencode is
waiting, **and** — if the `workmux` CLI is on PATH — additionally calls
`workmux set-window-status` so workmux's own glyph can win when it fires.
That way you get a reliable fallback whenever workmux doesn't manage to
set a symbol (which happens intermittently).

Recommended tmux format conditional: prefer workmux, fall back to the
`@opencode_waiting` dot. Tell tmux to render **one** of them, not both.

```tmux
# Render workmux's status if it set one, otherwise opencode's waiting dot,
# otherwise nothing. Drop this into your window-status formats. Style to
# taste - the example below uses cyan for the opencode fallback so it's
# visually distinct from workmux's glyph.
setw -g window-status-current-format '#{?@workmux_status,#[fg=colour3] #{@workmux_status},#{?@opencode_waiting,#[fg=colour153] #{@opencode_waiting},}} #I:#W#F '
setw -g window-status-format         '#{?@workmux_status,#[fg=colour3] #{@workmux_status},#{?@opencode_waiting,#[fg=colour153] #{@opencode_waiting},}} #I:#W#F '

# Auto-clear the opencode marker when the user focuses the window, even if
# opencode didn't emit an event. Matches workmux's own auto-clear-on-focus
# behaviour so the two cooperate.
set-hook -g after-select-window    'set-window-option -q -u @opencode_waiting'
set-hook -g session-window-changed 'set-window-option -q -u @opencode_waiting'
set-hook -g client-focus-in        'set-window-option -q -u @opencode_waiting'
```

If your existing tmux.conf already has a `window-status-format` that
renders workmux, you only need to **extend the conditional** to check
`@opencode_waiting` as a second branch. Example, turning this:

```tmux
window-status-format "#[fg=colour3,bg=#3a3a3a] #I:#W#F #{?@workmux_status, #{@workmux_status},}"
```

into this:

```tmux
window-status-format "#[fg=colour3,bg=#3a3a3a] #I:#W#F #{?@workmux_status, #{@workmux_status},#{?@opencode_waiting, #{@opencode_waiting},}}"
```

(And identically for `window-status-current-format`.)

If you use Home Manager / Nix to manage tmux, port these lines into your
module (the exact location is tool-specific — e.g. `programs.tmux.extraConfig`).

### Opting out / opting in harder

- Don't want the fallback at all, only workmux? Set
  `"tmux": { "indicator": "workmux" }` in `opencode-notifier.json`.
- Don't have workmux and want only the `@opencode_waiting` path? Set
  `"tmux": { "indicator": "window-option" }`.
- Don't want any tmux writes? Set `"tmux": { "indicator": "off" }`.

## Session picker (`choose-tree`) indicator

The same `@opencode_waiting` window option can light up the `prefix s`
session picker: tmux's format language includes a per-session window
iterator, `#{W:…}`, which concatenates the inner template once per window
in that session. Pairing it with the empty-string-as-false conditional
lets you render a dot next to any session that contains at least one
waiting window. Workmux doesn't touch the picker, so this is purely
additive.

Default keybinding for the picker on a stock tmux install is:

```tmux
bind-key s choose-tree -Zs
bind-key w choose-tree -Zw
```

Replace them with the format-aware versions (multi-line braces used here
for readability — tmux accepts them verbatim):

```tmux
bind-key s choose-tree -Zs -F "#{?pane_format,\
#{?pane_marked,#[reverse],}#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,},\
#{?window_format,\
#{?window_marked_flag,#[reverse],}#{window_name}#{window_flags},\
#{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}#{?#{W:#{?@opencode_waiting,1,}}, ●,}\
}}"

bind-key w choose-tree -Zw -F "#{?pane_format,\
#{?pane_marked,#[reverse],}#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,},\
#{?window_format,\
#{?window_marked_flag,#[reverse],}#{window_name}#{window_flags}#{?@opencode_waiting, #{@opencode_waiting},},\
#{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}#{?#{W:#{?@opencode_waiting,1,}}, ●,}\
}}"
```

What those formats are: tmux's three-branch `WINDOW_TREE_DEFAULT_FORMAT`
(pane branch / window branch / session branch) with two small additions:

- **Session branch** (the row you see in `-Zs` mode or a collapsed
  session in `-Zw` mode): append
  `#{?#{W:#{?@opencode_waiting,1,}}, ●,}`. This expands to ` ●` iff at
  least one window under that session has `@opencode_waiting` set.
- **Window branch** (expanded rows under a session): append
  `#{?@opencode_waiting, #{@opencode_waiting},}` so the dot also shows
  next to the window whose agent is waiting.

### Test it without waiting for opencode

```bash
# Manually mark the current window as waiting:
tmux set-window-option @opencode_waiting '●'
# Open the picker:
tmux choose-tree -Zs
#   → the session you're in should have ` ●` appended.
# Clean up:
tmux set-window-option -u @opencode_waiting
```

## Troubleshooting

### Click does nothing / opens Script Editor

Notifications emitted via `osascript` always behave that way. Check:

```bash
which terminal-notifier   # must resolve
```

If absent, install and restart opencode.

### Wrong pane gets focused

The plugin captures context only once at plugin init. If you started opencode
outside tmux and later attached from tmux, the context is stale — restart
opencode inside the target tmux pane.

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
