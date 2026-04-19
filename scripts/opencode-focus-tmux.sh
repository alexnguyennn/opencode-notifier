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
#                            FALLBACK wezterm pane, used when we can't discover
#                            a live pane hosting the target tmux session. When
#                            non-empty we use `wezterm cli activate-pane
#                            --pane-id $3` as a last resort.
#
# Focus resolution strategy (when $1 is a tmux target):
#
#   1. Ask tmux which client tty is currently attached to the target
#      session. If the user detached+reattached from a different WezTerm
#      pane after opencode captured its context, this returns the LIVE
#      pane's tty - not the stale captured one.
#   2. Match that tty against `wezterm cli list` output's `tty_name`.
#      If we find a match: activate THAT wezterm pane, and aim tmux
#      switch-client at THAT specific client (via -c).
#   3. If no match (e.g. tmux session isn't currently attached to any
#      WezTerm pane, or wezterm CLI unavailable): fall back to the
#      captured $3 wezterm pane id + plain tmux switch-client against
#      whatever client tmux picks.
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
#     the others. Order is: WezTerm pane -> tmux -> macOS app activation.
#   * Set OPENCODE_FOCUS_DEBUG=/path/to/log to write a bash -x trace.

set -u

if [[ -n "${OPENCODE_FOCUS_DEBUG:-}" ]]; then
  exec 2>>"$OPENCODE_FOCUS_DEBUG"
  set -x
fi

TARGET="${1:-}"
APP="${2:-}"
WEZTERM_PANE_ID_FALLBACK="${3:-}"

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

# ---------- resolve LIVE wezterm pane from tmux session ----------
#
# Extract the session id from the target (everything before the first `:`).
# Ask tmux which tty currently has a client attached to that session.
# Match that tty against wezterm cli list -> pane_id.
#
# Outputs (global vars):
#   RESOLVED_WEZTERM_PANE  numeric wezterm pane id, or empty
#   RESOLVED_CLIENT_TTY    tmux client tty (/dev/ttysNN), or empty

RESOLVED_WEZTERM_PANE=""
RESOLVED_CLIENT_TTY=""

resolve_live_pane() {
  [[ -n "$TARGET" && -n "$TMUX_BIN" && -n "$WEZTERM_BIN" ]] || return 0

  local session_id=${TARGET%%:*}

  # Ask tmux which client ttys are currently on this session. There may be
  # 0 (detached), 1 (typical), or >1 (shared session) attached clients.
  # Take the first non-empty line.
  local ttys
  ttys=$("$TMUX_BIN" list-clients -t "$session_id" -F '#{client_tty}' 2>/dev/null) || return 0
  [[ -n "$ttys" ]] || return 0

  # For each attached tty, find a wezterm pane with matching tty_name.
  # wezterm cli list --format json emits an array of pane objects with
  # `pane_id` (int) and `tty_name` (string).
  local wezterm_json
  wezterm_json=$("$WEZTERM_BIN" cli list --format json 2>/dev/null) || return 0
  [[ -n "$wezterm_json" ]] || return 0

  local tty
  while IFS= read -r tty; do
    [[ -n "$tty" ]] || continue
    # Extract pane_id for the wezterm pane whose tty_name == $tty.
    # jq would be cleanest but we can't count on it; use a one-liner
    # python fallback that's on macOS by default.
    local pane_id
    pane_id=$(/usr/bin/env python3 -c "
import json, sys
want = sys.argv[1]
for p in json.loads(sys.argv[2]):
    if p.get('tty_name') == want:
        print(p.get('pane_id', ''))
        break
" "$tty" "$wezterm_json" 2>/dev/null) || continue
    if [[ -n "$pane_id" ]]; then
      RESOLVED_WEZTERM_PANE=$pane_id
      RESOLVED_CLIENT_TTY=$tty
      return 0
    fi
  done <<< "$ttys"

  return 0
}

resolve_live_pane

# ---------- 1. focus the right WezTerm pane ----------
#
# If we resolved a live pane, use that. Otherwise fall back to the captured
# $3 pane id (current behaviour). This raises the correct WezTerm native
# window and selects the pane that hosts the tmux client (or opencode
# directly, if no tmux). Must run before tmux switch-client: otherwise any
# tmux action happens in the currently focused WezTerm window, not the one
# opencode is in, and the user sees no visible change.

WEZTERM_PANE_TO_USE=""
if [[ -n "$RESOLVED_WEZTERM_PANE" ]]; then
  WEZTERM_PANE_TO_USE=$RESOLVED_WEZTERM_PANE
elif [[ -n "$WEZTERM_PANE_ID_FALLBACK" ]]; then
  WEZTERM_PANE_TO_USE=$WEZTERM_PANE_ID_FALLBACK
fi

if [[ -n "$WEZTERM_PANE_TO_USE" && -n "$WEZTERM_BIN" ]]; then
  "$WEZTERM_BIN" cli activate-pane --pane-id "$WEZTERM_PANE_TO_USE" >/dev/null 2>&1 || true
fi

# ---------- 2. focus tmux target ----------
#
# If we resolved a live client tty, point tmux switch-client at THAT
# specific client via -c. Without -c tmux picks the "current" client -
# which is non-deterministic when the user has multiple WezTerm panes with
# tmux clients attached, and leads to "some arbitrary wezterm window gets
# switched out from under me" behaviour.

if [[ -n "$TARGET" && -n "$TMUX_BIN" ]]; then
  SESSION=${TARGET%%:*}
  if [[ -n "$RESOLVED_CLIENT_TTY" ]]; then
    # Fast path: we know exactly which client to target. This also
    # confirms that client is attached, so no attach-session fallback
    # is needed.
    "$TMUX_BIN" switch-client -c "$RESOLVED_CLIENT_TTY" -t "$TARGET" 2>/dev/null || true
  else
    # Fallback: no resolved client. Try the generic switch-client; if no
    # client is attached at all, attempt attach-session in the background
    # so the next terminal that opens picks it up.
    if ! "$TMUX_BIN" switch-client -t "$TARGET" 2>/dev/null; then
      "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null && \
        "$TMUX_BIN" attach-session -d -t "$TARGET" >/dev/null 2>&1 &
    fi
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
