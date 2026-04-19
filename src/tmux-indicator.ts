import { execFile, execFileSync } from "child_process"
import type { TmuxContext } from "./tmux-context"

/**
 * Waiting-indicator backend:
 *   - "auto"          prefer workmux if on PATH, else window-option
 *   - "workmux"       always call workmux CLI
 *   - "window-option" always set tmux @opencode_waiting window option
 *   - "off"           never touch the tmux status line
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

let cachedResolvedBackend: Exclude<TmuxIndicatorBackend, "auto"> | null = null

function resolveBackend(preference: TmuxIndicatorBackend): Exclude<TmuxIndicatorBackend, "auto"> {
  if (preference !== "auto") return preference
  if (cachedResolvedBackend !== null) return cachedResolvedBackend
  // If workmux is present, defer to it (user's existing workmux-status.ts
  // plugin is probably already driving it).
  cachedResolvedBackend = hasBin("workmux") ? "workmux" : "window-option"
  return cachedResolvedBackend
}

function runDetached(bin: string, args: string[]): void {
  // Fire-and-forget to avoid blocking the event loop.
  execFile(bin, args, { timeout: 1000 }, () => {
    /* swallow errors - indicator is best-effort */
  })
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

  const backend = resolveBackend(preference)

  if (backend === "workmux") {
    // workmux-status.ts already handles these; our call is a no-op write in
    // that case. When running standalone (no workmux-status.ts loaded), we
    // still drive the indicator.
    const mapped =
      state === "waiting" ? "waiting" :
      state === "working" ? "working" :
      "done"
    runDetached("workmux", ["set-window-status", mapped])
    return
  }

  // window-option backend: set / unset `@opencode_waiting` on the window
  // opencode was launched in (pinned via captured windowId).
  if (state === "waiting") {
    runDetached("tmux", ["set-window-option", "-q", "-t", ctx.windowId, WAITING_OPTION, WAITING_SYMBOL])
  } else {
    runDetached("tmux", ["set-window-option", "-q", "-u", "-t", ctx.windowId, WAITING_OPTION])
  }
}

/** Used by tests to reset module-scoped memoisation. */
export function __resetIndicatorForTests(): void {
  lastState = null
  cachedResolvedBackend = null
}
