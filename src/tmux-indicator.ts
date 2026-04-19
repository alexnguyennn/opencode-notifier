import { execFile, execFileSync } from "child_process"
import type { TmuxContext } from "./tmux-context"

/**
 * Waiting-indicator backend strategy. Defaults to `"auto"` which means:
 *
 *   - ALWAYS set/unset the `@opencode_waiting` window option. This gives
 *     your tmux.conf a reliable signal it can render as a last-resort
 *     indicator, regardless of whether workmux is installed or reliable.
 *   - If `workmux` is on PATH, ALSO call `workmux set-window-status` so
 *     workmux's own glyph wins when it's working. Your tmux format
 *     conditional should render workmux first, opencode as a fallback,
 *     e.g.:
 *
 *         #{?@workmux_status,#{@workmux_status},#{?@opencode_waiting,#{@opencode_waiting},}}
 *
 *     That way you get exactly one glyph: workmux when it wrote one,
 *     opencode when workmux was silent. Both auto-clear on window focus
 *     (see tmux.conf snippet in docs/tmux-wezterm.md).
 *
 * Explicit overrides:
 *
 *   - `"workmux"`       only call workmux; don't write `@opencode_waiting`
 *   - `"window-option"` only set `@opencode_waiting`; don't call workmux
 *   - `"off"`           never touch the tmux status line
 */
export type TmuxIndicatorBackend = "auto" | "workmux" | "window-option" | "off"

const WAITING_OPTION = "@opencode_waiting"
const WAITING_SYMBOL = "●"

type IndicatorState = "waiting" | "working" | "done" | null

let lastState: IndicatorState = null

function hasBin(name: string): boolean {
  try {
    execFileSync("/usr/bin/command", ["-v", name], {
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

let cachedWorkmuxAvailable: boolean | null = null
function workmuxAvailable(): boolean {
  if (cachedWorkmuxAvailable !== null) return cachedWorkmuxAvailable
  cachedWorkmuxAvailable = hasBin("workmux")
  return cachedWorkmuxAvailable
}

function runDetached(bin: string, args: string[]): void {
  // Fire-and-forget to avoid blocking the event loop.
  execFile(bin, args, { timeout: 1000 }, () => {
    /* swallow errors - indicator is best-effort */
  })
}

function writeWorkmux(state: Exclude<IndicatorState, null>): void {
  // workmux's own state vocabulary matches ours 1:1.
  runDetached("workmux", ["set-window-status", state])
}

function writeWindowOption(ctx: TmuxContext, state: IndicatorState): void {
  if (!ctx.windowId) return
  if (state === "waiting") {
    runDetached("tmux", ["set-window-option", "-q", "-t", ctx.windowId, WAITING_OPTION, WAITING_SYMBOL])
  } else {
    // working, done, or null -> clear the option.
    runDetached("tmux", ["set-window-option", "-q", "-u", "-t", ctx.windowId, WAITING_OPTION])
  }
}

export function setIndicator(
  ctx: TmuxContext | null,
  state: IndicatorState,
  preference: TmuxIndicatorBackend = "auto"
): void {
  if (!ctx) return
  if (preference === "off") return
  if (state === lastState) return
  lastState = state

  switch (preference) {
    case "workmux":
      if (state !== null) writeWorkmux(state)
      return
    case "window-option":
      writeWindowOption(ctx, state)
      return
    case "auto":
    default: {
      // Always set the window option — acts as a reliable fallback when
      // workmux's own symbols don't fire (which is the reported failure
      // mode). Writing it is cheap and idempotent.
      writeWindowOption(ctx, state)
      // Additionally tell workmux, if installed, so its richer glyph wins
      // in the format conditional when it's working. If a workmux-status
      // plugin already wrote the same value this call is a no-op net
      // effect (workmux writes the same option value).
      if (state !== null && workmuxAvailable()) {
        writeWorkmux(state)
      }
      return
    }
  }
}

/** Used by tests to reset module-scoped memoisation. */
export function __resetIndicatorForTests(): void {
  lastState = null
  cachedWorkmuxAvailable = null
}
