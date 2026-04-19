import { execFileSync } from "child_process"

/**
 * Tmux / host-terminal context captured ONCE at plugin startup.
 *
 * Rationale: `TMUX_PANE` and `WEZTERM_PANE` are set in the pane where
 * opencode launched. Resolving them to stable IDs has to happen immediately,
 * because once opencode is running the attached tmux client or focused
 * wezterm pane may have moved — a later `tmux display-message` / wezterm
 * lookup without `-t`/`--pane-id` would report a different pane.
 *
 * `paneId/windowId/sessionId/target/label/sessionName` are populated only
 * when inside tmux. `weztermPaneId` / `appName` may be populated even when
 * not in tmux (bare WezTerm with opencode running directly in the pane) so
 * click-to-focus still works for that path.
 */
export interface TmuxContext {
  /** %NN tmux pane id. Empty string if not in tmux. */
  paneId: string
  /** @NN tmux window id. Empty string if not in tmux. */
  windowId: string
  /** $NN tmux session id. Empty string if not in tmux. */
  sessionId: string
  /** tmux session name (renamable). Empty string if not in tmux. */
  sessionName: string
  /** "session:window.pane" target for `tmux switch-client -t`. Empty string if not in tmux. */
  target: string
  /** Human-readable label: "session:windowIndex windowName" (or just "WezTerm pane N" outside tmux). */
  label: string
  /** macOS terminal app name for `osascript ... activate`, or null if undetectable. */
  appName: string | null
  /** WezTerm pane id (string of the numeric value), or null if host isn't WezTerm. */
  weztermPaneId: string | null
}

const MAC_TERM_PROGRAM_TO_APP: Record<string, string> = {
  apple_terminal: "Terminal",
  iterm: "iTerm",
  iterm2: "iTerm",
  ghostty: "Ghostty",
  // WezTerm's CFBundleName is "WezTerm"; `tell application "WezTerm" to
  // activate` is the correct AppleScript form. The System-Events fallback
  // uses the process name "wezterm-gui" (see scripts/opencode-focus-tmux.sh).
  wezterm: "WezTerm",
  warpterminal: "Warp",
  vscode: "Visual Studio Code",
  hyper: "Hyper",
  tabby: "Tabby",
  cursor: "Cursor",
  zed: "Zed",
  rio: "Rio",
}

function execTmux(args: string[], timeoutMs = 500): string | null {
  try {
    return execFileSync("tmux", args, {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

export function deriveMacAppName(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "darwin") return null

  const raw = (env.TERM_PROGRAM ?? "").toLowerCase()
  // Inside tmux, TERM_PROGRAM is often just "tmux". Prefer
  // LC_TERMINAL (iTerm2 sets it) or fall back to env probes.
  if (raw && raw !== "tmux" && raw !== "screen" && MAC_TERM_PROGRAM_TO_APP[raw]) {
    return MAC_TERM_PROGRAM_TO_APP[raw]
  }

  const lcTerminal = (env.LC_TERMINAL ?? "").toLowerCase()
  if (lcTerminal && MAC_TERM_PROGRAM_TO_APP[lcTerminal]) {
    return MAC_TERM_PROGRAM_TO_APP[lcTerminal]
  }

  // Fallbacks for terminals that don't set TERM_PROGRAM.
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_LOG || env.ALACRITTY_SOCKET) {
    return "Alacritty"
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) {
    return "kitty"
  }
  if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE) {
    return "WezTerm"
  }
  if (env.GHOSTTY_RESOURCES_DIR) {
    return "Ghostty"
  }

  return null
}

/**
 * Capture the tmux + wezterm context for the pane opencode was launched in.
 * Returns null only when we can't detect any useful host (neither tmux nor
 * a recognised terminal), so there'd be nothing to click-to-focus.
 */
export function captureTmuxContext(env: NodeJS.ProcessEnv = process.env): TmuxContext | null {
  const appName = deriveMacAppName(env)

  // WezTerm pane (may be set even outside tmux, or inside tmux - WezTerm
  // exports WEZTERM_PANE to the tmux server's env so every tmux pane
  // inherits it).
  const weztermPaneRaw = env.WEZTERM_PANE
  const weztermPaneId = weztermPaneRaw && weztermPaneRaw.length > 0 ? weztermPaneRaw : null

  const paneEnv = env.TMUX_PANE
  const inTmux = Boolean(paneEnv && env.TMUX)

  if (!inTmux) {
    // Not in tmux. If we still have a WezTerm pane id (or an app name), we
    // can at least focus the WezTerm pane / activate the app on click.
    if (!weztermPaneId && !appName) return null
    return {
      paneId: "",
      windowId: "",
      sessionId: "",
      sessionName: "",
      target: "",
      label: weztermPaneId ? `${appName ?? "terminal"} pane ${weztermPaneId}` : (appName ?? "terminal"),
      appName,
      weztermPaneId,
    }
  }

  // Inside tmux: resolve all stable identifiers + human label.
  const fmt = "#{pane_id}\t#{window_id}\t#{session_id}\t#{session_name}\t#{session_name}:#{window_index} #{window_name}"
  const raw = execTmux(["display-message", "-p", "-t", paneEnv!, fmt])
  if (!raw) {
    // tmux exists but we can't introspect. Preserve weztermPaneId so click
    // still focuses the host pane.
    if (!weztermPaneId && !appName) return null
    return {
      paneId: "",
      windowId: "",
      sessionId: "",
      sessionName: "",
      target: "",
      label: appName ?? "terminal",
      appName,
      weztermPaneId,
    }
  }

  const [paneId, windowId, sessionId, sessionName, label] = raw.split("\t")
  if (!paneId || !windowId || !sessionId || !sessionName) {
    return null
  }

  const target = `${sessionId}:${windowId}.${paneId}`
  return {
    paneId,
    windowId,
    sessionId,
    sessionName,
    target,
    label: label ?? sessionName,
    appName,
    weztermPaneId,
  }
}
