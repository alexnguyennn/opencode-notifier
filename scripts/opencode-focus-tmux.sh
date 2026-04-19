#!/usr/bin/env bash
# opencode-focus-tmux: invoked by terminal-notifier -execute when a
# notification fires. Brings the opencode pane back into focus.
#
# Args:
#   $1  tmux target          e.g. "$0:@3.%42"  (session_id:window_id.pane_id)
#                            Empty string if opencode wasn't launched inside tmux.
#   $2  macOS app name       e.g. "Ghostty"    (may be empty)
#                            Pass either "WezTerm" (bundle name) or "wezterm-gui"
#                            (process name) for WezTerm; we try both forms.
#   $3  WezTerm pane id      e.g. "42"         (may be empty)
#                            When non-empty we call `wezterm cli activate-pane
#                            --pane-id $3` BEFORE tmux switch-client so the
#                            correct native WezTerm window is raised first.
#
# Notes:
#   * terminal-notifier -execute runs the command via /bin/sh -c with a
#     *minimal* PATH. Resolve all binaries ourselves.
#   * `tmux switch-client -t <target>` handles a pane-qualified target by
#     switching session + selecting window + pane in one step, but only
#     succeeds if a tmux client is currently attached. Fall back to
#     `attach-session` (inside a new terminal tab is another option but
#     out of scope here).
#   * For app activation we try System Events first (fails silently if the
#     app isn't running) and then fall back to `tell application "X" to
#     activate` which will launch it.
#   * Every step runs with `|| true` so one failing doesn't short-circuit
#     the others. Order is: WezTerm pane → tmux → macOS app activation.

set -u

TARGET="${1:-}"
APP="${2:-}"
WEZTERM_PANE_ID="${3:-}"

# ---------- locate binaries ----------

find_cmd() {
  # $1 name, $2... candidate paths
  local name=$1; shift
  local p
  for p in "$@"; do
    if [[ -x $p ]]; then
      printf '%s' "$p"
      return 0
    fi
  done
  # last resort: PATH lookup via /usr/bin/command (always present on macOS)
  if /usr/bin/command -v "$name" >/dev/null 2>&1; then
    /usr/bin/command -v "$name"
    return 0
  fi
  return 1
}

TMUX_BIN=$(find_cmd tmux \
  /opt/homebrew/bin/tmux \
  /usr/local/bin/tmux \
  /etc/profiles/per-user/$USER/bin/tmux \
  /run/current-system/sw/bin/tmux \
  /usr/bin/tmux) || true

# WezTerm is commonly drag-and-dropped into /Applications without adding
# `wezterm` to PATH, so probe the canonical bundle path as a fallback.
WEZTERM_BIN=$(find_cmd wezterm \
  /opt/homebrew/bin/wezterm \
  /usr/local/bin/wezterm \
  /etc/profiles/per-user/$USER/bin/wezterm \
  /run/current-system/sw/bin/wezterm \
  /Applications/WezTerm.app/Contents/MacOS/wezterm) || true

OSASCRIPT_BIN=/usr/bin/osascript

# ---------- 1. focus WezTerm pane FIRST (if applicable) ----------
#
# This raises the correct WezTerm native window and selects the pane that
# hosts the tmux client (or opencode directly, if no tmux). Must run before
# tmux switch-client: otherwise any tmux action happens in the currently
# focused WezTerm window, not the one opencode is in, and the user sees
# no visible change.

if [[ -n "$WEZTERM_PANE_ID" && -n "$WEZTERM_BIN" ]]; then
  "$WEZTERM_BIN" cli activate-pane --pane-id "$WEZTERM_PANE_ID" >/dev/null 2>&1 || true
fi

# ---------- 2. focus tmux target ----------

if [[ -n "$TARGET" && -n "$TMUX_BIN" ]]; then
  SESSION=${TARGET%%:*}
  # Try switch-client first (fast path when a client is attached).
  if ! "$TMUX_BIN" switch-client -t "$TARGET" 2>/dev/null; then
    # No attached client. We can't reliably spawn a new terminal window
    # from a non-interactive shell invoked by terminal-notifier, so just
    # try attach-session in the background - this at least ensures the
    # session exists and the next terminal that opens will pick it up.
    "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null && \
      "$TMUX_BIN" attach-session -d -t "$TARGET" >/dev/null 2>&1 &
  fi
fi

# ---------- 3. activate terminal app (belt-and-braces) ----------
#
# Even after wezterm cli activate-pane, macOS sometimes doesn't promote
# the app to frontmost if it was hidden or on another Space. Doing an
# explicit activate here catches those cases.

if [[ -n "$APP" && -x $OSASCRIPT_BIN ]]; then
  # Escape double-quotes in app name for AppleScript string literal.
  APP_ESCAPED=${APP//\"/\\\"}

  # WezTerm special-case: the app is registered as "WezTerm" (bundle
  # display name) but the macOS process is "wezterm-gui". tell application
  # requires the former; tell process requires the latter. Accept either
  # spelling from the caller and do the right thing.
  case "$APP" in
    wezterm-gui|WezTerm|wezterm)
      "$OSASCRIPT_BIN" -e 'tell application "WezTerm" to activate' >/dev/null 2>&1 || \
        "$OSASCRIPT_BIN" -e 'tell application "System Events" to tell process "wezterm-gui" to set frontmost to true' >/dev/null 2>&1 || \
        true
      ;;
    *)
      # Generic path: System Events process form first (silent if not running), then launch.
      "$OSASCRIPT_BIN" -e "tell application \"System Events\"
        if exists process \"$APP_ESCAPED\" then
          set frontmost of process \"$APP_ESCAPED\" to true
        else
          tell application \"$APP_ESCAPED\" to activate
        end if
      end tell" >/dev/null 2>&1 || \
        "$OSASCRIPT_BIN" -e "tell application \"$APP_ESCAPED\" to activate" >/dev/null 2>&1 || true
      ;;
  esac
fi

exit 0
