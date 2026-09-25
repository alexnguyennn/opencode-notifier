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
#   $4  tmux socket path     for V2 TUI registration (may be empty)
#   $5  expected pane id    for persisted picker targets (may be empty)
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
TMUX_SOCKET="${4:-}"
EXPECTED_PANE_ID="${5:-}"

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
TMUX_ARGS=()
if [[ -n "$TMUX_SOCKET" ]]; then
  TMUX_ARGS=(-S "$TMUX_SOCKET")
fi

# Picker records outlive TUI leases. Never reuse an old target if its pane
# disappeared or now runs something other than OpenCode. Native NC clicks do
# not pass $5 and keep their existing behavior.
if [[ -n "$EXPECTED_PANE_ID" ]]; then
  [[ -n "$TARGET" && -n "$TMUX_BIN" ]] || exit 1
  PANE_STATE=$("$TMUX_BIN" "${TMUX_ARGS[@]}" display-message -p -t "$TARGET" '#{pane_id} #{pane_current_command}' 2>/dev/null) || exit 1
  [[ "$PANE_STATE" == "$EXPECTED_PANE_ID opencode" || "$PANE_STATE" == "$EXPECTED_PANE_ID opencode-v2" ]] || exit 1
fi

# WezTerm is commonly drag-and-dropped into /Applications without adding
# `wezterm` to PATH, so probe the canonical bundle path as a fallback.
WEZTERM_BIN=$(find_cmd wezterm \
  /opt/homebrew/bin/wezterm \
  /usr/local/bin/wezterm \
  /etc/profiles/per-user/$USER/bin/wezterm \
  /run/current-system/sw/bin/wezterm \
  /Applications/WezTerm.app/Contents/MacOS/wezterm) || true

# A long-lived tmux/OpenCode process can retain a GUI socket from an old
# WezTerm launch. Let the CLI discover the current GUI when that socket is gone.
if [[ -n "${WEZTERM_UNIX_SOCKET:-}" && ! -S "$WEZTERM_UNIX_SOCKET" ]]; then
  unset WEZTERM_UNIX_SOCKET
fi

OSASCRIPT_BIN=/usr/bin/osascript

# ---------- resolve LIVE wezterm pane from tmux session ----------
#
# Extract the session id from the target (everything before the first `:`).
# Ask tmux which tty currently has a client attached to that session.
# Match that tty against wezterm cli list -> pane_id.
#
# Outputs (global vars):
#   RESOLVED_WEZTERM_PANE  numeric wezterm pane id, or empty
#   RESOLVED_WEZTERM_WINDOW_TITLE unique native window title, or empty
#   RESOLVED_CLIENT_TTY    tmux client tty (/dev/ttysNN), or empty

RESOLVED_WEZTERM_PANE=""
RESOLVED_WEZTERM_TAB=""
RESOLVED_WEZTERM_WINDOW_TITLE=""
RESOLVED_CLIENT_TTY=""

resolve_live_pane() {
  [[ -n "$TARGET" && -n "$TMUX_BIN" && -n "$WEZTERM_BIN" ]] || return 0

  local session_id=${TARGET%%:*}

  # Ask tmux which client ttys are currently on this session. There may be
  # 0 (detached), 1 (typical), or >1 (shared session) attached clients.
  # Prefer the registered host pane; if it moved, use the sole attached
  # client. V1 keeps its historical first-client fallback.
  local ttys
  ttys=$("$TMUX_BIN" "${TMUX_ARGS[@]}" list-clients -t "$session_id" -F '#{client_tty}' 2>/dev/null) || return 0
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
    # Extract pane and tab ids for the registered WezTerm pane on this tty.
    # jq would be cleanest but we can't count on it; use a one-liner
    # python fallback that's on macOS by default.
    local pane_info
    pane_info=$(/usr/bin/env python3 -c "
import json, sys
want = sys.argv[1]
preferred = sys.argv[3]
panes = json.loads(sys.argv[2])
for p in panes:
    if p.get('tty_name') == want and str(p.get('pane_id', '')) == preferred:
        title = p.get('window_title', '')
        unique = title and len({v.get('window_id') for v in panes if v.get('window_title') == title}) == 1
        print(str(p.get('pane_id', '')) + '\t' + str(p.get('tab_id', '')) + '\t' + (title if unique else ''))
        break
" "$tty" "$wezterm_json" "$WEZTERM_PANE_ID_FALLBACK" 2>/dev/null) || continue
    if [[ -n "$pane_info" ]]; then
      IFS=$'\t' read -r RESOLVED_WEZTERM_PANE RESOLVED_WEZTERM_TAB RESOLVED_WEZTERM_WINDOW_TITLE <<< "$pane_info"
      RESOLVED_CLIENT_TTY=$tty
      return 0
    fi
  done <<< "$ttys"

  # A shared tmux session can have several attached clients. A V2 registration
  # must not choose another client's pane merely because it appears first.
  if [[ -n "$TMUX_SOCKET" ]]; then
    local count=0
    local tty
    while IFS= read -r tty; do
      [[ -n "$tty" ]] && ((count+=1))
    done <<< "$ttys"
    if (( count != 1 )); then return 0; fi
  fi

  while IFS= read -r tty; do
    [[ -n "$tty" ]] || continue
    local pane_info
    pane_info=$(/usr/bin/env python3 -c "
import json, sys
panes = json.loads(sys.argv[2])
for p in panes:
    if p.get('tty_name') == sys.argv[1]:
        title = p.get('window_title', '')
        unique = title and len({v.get('window_id') for v in panes if v.get('window_title') == title}) == 1
        print(str(p.get('pane_id', '')) + '\t' + str(p.get('tab_id', '')) + '\t' + (title if unique else ''))
        break
" "$tty" "$wezterm_json" 2>/dev/null) || continue
    if [[ -n "$pane_info" ]]; then
      IFS=$'\t' read -r RESOLVED_WEZTERM_PANE RESOLVED_WEZTERM_TAB RESOLVED_WEZTERM_WINDOW_TITLE <<< "$pane_info"
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
  if [[ -n "$RESOLVED_WEZTERM_TAB" ]]; then
    "$WEZTERM_BIN" cli activate-tab --tab-id "$RESOLVED_WEZTERM_TAB" >/dev/null 2>&1 || true
  fi
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
  if [[ -n "$TMUX_SOCKET" ]]; then
    # V2 has a verified pane and socket. Never switch an arbitrary client or
    # start an invisible attach-session when the host client cannot be found.
    if [[ -n "$RESOLVED_CLIENT_TTY" ]]; then
      "$TMUX_BIN" "${TMUX_ARGS[@]}" switch-client -c "$RESOLVED_CLIENT_TTY" -t "$SESSION" 2>/dev/null || true
    fi
    "$TMUX_BIN" "${TMUX_ARGS[@]}" select-window -t "$TARGET" 2>/dev/null || true
    "$TMUX_BIN" "${TMUX_ARGS[@]}" select-pane -t "$TARGET" 2>/dev/null || true
  elif [[ -n "$RESOLVED_CLIENT_TTY" ]]; then
    # Fast path: we know exactly which client to target. This also
    # confirms that client is attached, so no attach-session fallback
    # is needed.
    "$TMUX_BIN" "${TMUX_ARGS[@]}" switch-client -c "$RESOLVED_CLIENT_TTY" -t "$TARGET" 2>/dev/null || true
  else
    # Fallback: no resolved client. Try the generic switch-client; if no
    # client is attached at all, attempt attach-session in the background
    # so the next terminal that opens picks it up.
    if ! "$TMUX_BIN" "${TMUX_ARGS[@]}" switch-client -t "$TARGET" 2>/dev/null; then
      "$TMUX_BIN" "${TMUX_ARGS[@]}" has-session -t "$SESSION" 2>/dev/null && \
        "$TMUX_BIN" "${TMUX_ARGS[@]}" attach-session -d -t "$TARGET" >/dev/null 2>&1 &
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
      # CLI tab/pane activation does not raise a different native WezTerm
      # window. Only use a title if it identifies exactly one mux window.
      if [[ -n "$RESOLVED_WEZTERM_WINDOW_TITLE" ]]; then
        "$OSASCRIPT_BIN" -e 'on run argv' \
          -e 'tell application "System Events" to tell process "wezterm-gui"' \
          -e 'set frontmost to true' \
          -e 'perform action "AXRaise" of (first window whose name is item 1 of argv)' \
          -e 'end tell' -e 'end run' "$RESOLVED_WEZTERM_WINDOW_TITLE" >/dev/null 2>&1 || true
      fi
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
