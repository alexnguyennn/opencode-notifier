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
    //   "auto"          → workmux if the binary is on PATH, else window-option
    //   "workmux"       → always call `workmux set-window-status <state>`
    //   "window-option" → set tmux @opencode_waiting window option (see below)
    //   "off"           → never touch tmux
    "indicator": "auto"
  }
}
```

## `@opencode_waiting` fallback (tmux.conf)

When the `window-option` indicator backend is active (i.e. no `workmux` on
PATH), the plugin sets the tmux user-option `@opencode_waiting` to `●` on the
window where opencode is waiting. Render it in your status line by adding
these lines to `tmux.conf`:

```tmux
# Waiting indicator for opencode (from the opencode-notifier plugin).
# The format conditional `#{?@opencode_waiting,…,}` shows the symbol +
# styling only when the user-option is set on the window.
setw -g window-status-current-format ' #{?@opencode_waiting,#[fg=colour153]#{@opencode_waiting} ,}#I:#W#F '
setw -g window-status-format         ' #{?@opencode_waiting,#[fg=colour153]#{@opencode_waiting} ,}#I:#W#F '

# Auto-clear the marker when the user lands on the window, even if opencode
# didn't emit an event.
set-hook -g after-select-window    'set-window-option -q -u @opencode_waiting'
set-hook -g session-window-changed 'set-window-option -q -u @opencode_waiting'
set-hook -g client-focus-in        'set-window-option -q -u @opencode_waiting'
```

If you use Home Manager / Nix to manage tmux, port these lines into your
module (the exact location is tool-specific — e.g. `programs.tmux.extraConfig`).

If `workmux` is on PATH the plugin's default `"auto"` indicator backend
defers to `workmux set-window-status` and you do not need the tmux.conf
snippet above.

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
