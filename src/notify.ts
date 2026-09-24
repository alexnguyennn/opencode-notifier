import os from "os"
import { exec, execFile, execFileSync, spawn } from "child_process"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import notifier from "node-notifier"
import isWsl from "is-wsl"
import type { TmuxContext } from "./tmux-context"
import type { MacNotifier } from "./config"

const DEBOUNCE_MS = 1000

const platform = os.type()

let platformNotifier: any

if (platform === "Windows_NT" || isWsl) {
  const { WindowsToaster } = notifier
  platformNotifier = new WindowsToaster({ withFallback: false })
} else if (platform === "Linux" || platform.match(/BSD$/)) {
  const { NotifySend } = notifier
  platformNotifier = new NotifySend({ withFallback: false })
} else if (platform !== "Darwin") {
  platformNotifier = notifier
}

export type NotificationAction = "focus" | "close"

const LINUX_FOCUS_ACTION_KEY = "focus-terminal"
const LINUX_FOCUS_ACTION_LABEL = "Jump to terminal"

const lastNotificationTime: Record<string, number> = {}
let notificationsSincePrune = 0

let lastLinuxNotificationId: number | null = null
let linuxNotifySendSupportsReplace: boolean | null = null

/** Cached absolute path to `terminal-notifier`, or null if unavailable. */
let cachedTerminalNotifier: string | null | undefined = undefined

function resolveTerminalNotifier(): string | null {
  if (cachedTerminalNotifier !== undefined) return cachedTerminalNotifier
  try {
    const found = execFileSync("/usr/bin/command", ["-v", "terminal-notifier"], {
      timeout: 500,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    cachedTerminalNotifier = found.length > 0 ? found : null
  } catch {
    cachedTerminalNotifier = null
  }
  return cachedTerminalNotifier
}

/** Absolute path to the bundled focus-tmux shell helper. */
function resolveFocusScript(): string {
  // When bundled by Bun the module lives at `dist/index.js`. The script sits
  // at `scripts/opencode-focus-tmux.sh` one directory above.
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "scripts", "opencode-focus-tmux.sh")
}

/**
 * Decide which macOS backend to use based on config + environment. Returns
 * one of the concrete backends (never "auto").
 */
export function resolveMacBackend(
  macNotifier: MacNotifier,
  legacyNotificationSystem: "osascript" | "node-notifier" | "ghostty"
): "terminal-notifier" | "osascript" | "node-notifier" | "ghostty" {
  // ghostty OSC 9 is a write-to-stdout path and doesn't care about macNotifier.
  if (legacyNotificationSystem === "ghostty" && macNotifier === "auto") {
    return "ghostty"
  }
  if (macNotifier === "auto") {
    if (resolveTerminalNotifier()) return "terminal-notifier"
    return legacyNotificationSystem
  }
  if (macNotifier === "terminal-notifier") {
    return resolveTerminalNotifier() ? "terminal-notifier" : legacyNotificationSystem
  }
  return macNotifier
}

function sanitizeGhosttyField(value: string): string {
  return value.replace(/[;\u0000-\u001f\u007f-\u009f]/g, "")
}

export function formatGhosttyNotificationSequence(
  title: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const escapedTitle = sanitizeGhosttyField(title)
  const escapedMessage = sanitizeGhosttyField(message)
  const payload = `\x1b]9;${escapedTitle}: ${escapedMessage}\x07`

  if (env.TMUX) {
    return `\x1bPtmux;\x1b${payload}\x1b\\`
  }

  return payload
}

function detectNotifySendCapabilities(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("notify-send", ["--version"], (error, stdout) => {
      if (error) {
        resolve(false)
        return
      }
      const match = stdout.match(/(\d+)\.(\d+)/)
      if (match) {
        const major = parseInt(match[1], 10)
        const minor = parseInt(match[2], 10)
        resolve(major > 0 || (major === 0 && minor >= 8))
        return
      }
      resolve(false)
    })
  })
}

function sendLinuxNotificationDirect(
  title: string,
  message: string,
  timeout: number,
  iconPath?: string,
  grouping: boolean = true,
  onAction?: (action: NotificationAction) => void
): Promise<void> {
  return new Promise((resolve) => {
    if (onAction) {
      sendLinuxNotificationWithActions(title, message, timeout, iconPath, grouping, onAction)
        .then(() => resolve())
        .catch(() => resolve())
      return
    }

    const args: string[] = []

    args.push("--app-name", "opencode")

    if (iconPath) {
      args.push("--icon", iconPath)
    }

    args.push("--expire-time", String(timeout * 1000))

    if (grouping && lastLinuxNotificationId !== null) {
      args.push("--replace-id", String(lastLinuxNotificationId))
    }

    if (grouping) {
      args.push("--print-id")
    }

    args.push("--", title, message)

    execFile("notify-send", args, (error, stdout) => {
      if (!error && grouping && stdout) {
        const id = parseInt(stdout.trim(), 10)
        if (!isNaN(id)) {
          lastLinuxNotificationId = id
        }
      }
      resolve()
    })
  })
}

async function sendLinuxNotificationWithActions(
  title: string,
  message: string,
  timeout: number,
  iconPath?: string,
  grouping: boolean = true,
  onAction?: (action: NotificationAction) => void
): Promise<void> {
  const args: string[] = ["--app-name", "opencode"]

  if (iconPath) {
    args.push("--icon", iconPath)
  }

  args.push("--expire-time", String(timeout * 1000))

  if (grouping && lastLinuxNotificationId !== null) {
    args.push("--replace-id", String(lastLinuxNotificationId))
  }

  // Always print ID so we can resolve early (before user clicks)
  // and still keep replace-id working.
  args.push("--print-id")

  args.push("--action", `${LINUX_FOCUS_ACTION_KEY}=${LINUX_FOCUS_ACTION_LABEL}`)

  args.push("--", title, message)

  return new Promise((resolve) => {
    const child = spawn("notify-send", args, { stdio: ["ignore", "pipe", "pipe"] })

    let stdout = ""

    const consumeStdout = () => {
      const lines = stdout.split(/\r?\n/)
      // Keep the last partial line buffered.
      stdout = lines.pop() ?? ""

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) {
          continue
        }

        const parsed = parseNotifySendOutputLine(line)
        if (!parsed) {
          continue
        }

        if (parsed.type === "id") {
          if (grouping) {
            lastLinuxNotificationId = parsed.id
          }
          continue
        }

        if (onAction) {
          if (parsed.action === "focus") {
            onAction("focus")
          } else if (parsed.action === "close") {
            onAction("close")
          }
        }
      }
    }

    child.stdout?.on("data", (data) => {
      stdout += data.toString()
      consumeStdout()
    })

    child.on("close", () => {
      // Flush any remaining buffered stdout when process exits.
      if (stdout.trim().length > 0) {
        stdout += "\n"
        consumeStdout()
      }
      resolve()
    })

    child.on("error", () => {
      resolve()
    })
  })
}

export function parseNotifySendOutputLine(
  line: string
): { type: "id"; id: number } | { type: "action"; action: NotificationAction } | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d+$/.test(trimmed)) {
    const id = parseInt(trimmed, 10)
    if (!isNaN(id)) {
      return { type: "id", id }
    }
  }

  if (trimmed === LINUX_FOCUS_ACTION_KEY) {
    return { type: "action", action: "focus" }
  }

  if (trimmed === "close") {
    return { type: "action", action: "close" }
  }

  return null
}

export function buildOsascriptNotificationArgs(title: string, message: string): string[] {
  return [
    "-e",
    "on run argv\n display notification (item 1 of argv) with title (item 2 of argv)\nend run",
    message,
    title,
  ]
}
export interface SendNotificationOptions {
  /** macOS-only: when present + backend resolves to terminal-notifier, clicking the notification runs the focus-tmux helper against this context. */
  tmuxContext?: TmuxContext | null
  /** macOS-only override. Defaults to legacy `notificationSystem` mapping for backward compat. */
  macNotifier?: MacNotifier
  /** Group id for collapsing stale notifications (terminal-notifier `-group`). */
  groupId?: string | null
  /** Stable event identity: unrelated same-message sessions must not debounce each other. */
  dedupeKey?: string
  /** Linux notification action and fallback node-notifier click callback. */
  onClick?: () => void
  /** Windows application id passed to node-notifier. */
  windowsAppID?: string
}
export async function sendNotification(
  title: string,
  message: string,
  timeout: number,
  iconPath?: string,
  notificationSystem: "osascript" | "node-notifier" | "ghostty" = "osascript",
  linuxGrouping: boolean = true,
  options: SendNotificationOptions = {}
): Promise<void> {
  const now = Date.now()
  const dedupeKey = options.dedupeKey ?? (options.groupId ? `${options.groupId}\x1f${message}` : message)
  if (lastNotificationTime[dedupeKey] && now - lastNotificationTime[dedupeKey] < DEBOUNCE_MS) {
    return
  }
  lastNotificationTime[dedupeKey] = now
  if (++notificationsSincePrune >= 256) {
    notificationsSincePrune = 0
    for (const [key, time] of Object.entries(lastNotificationTime)) {
      if (now - time >= DEBOUNCE_MS) delete lastNotificationTime[key]
    }
  }

  if (notificationSystem === "ghostty") {
    return new Promise((resolve) => {
      const sequence = formatGhosttyNotificationSequence(title, message)
      process.stdout.write(sequence, () => {
        resolve()
      })
    })
  }

  if (platform === "Darwin") {
    const macBackend = resolveMacBackend(options.macNotifier ?? "auto", notificationSystem)

    if (macBackend === "ghostty") {
      return new Promise((resolve) => {
        const sequence = formatGhosttyNotificationSequence(title, message)
        process.stdout.write(sequence, () => resolve())
      })
    }

    if (macBackend === "terminal-notifier") {
      const tn = resolveTerminalNotifier()
      if (tn) {
        return new Promise((resolve) => {
          const args = ["-title", title, "-message", message]
          if (options.groupId) {
            args.push("-group", options.groupId)
          }
          if (iconPath) {
            args.push("-appIcon", iconPath)
          }
          if (options.tmuxContext) {
            const script = resolveFocusScript()
            // terminal-notifier passes -execute verbatim to /bin/sh -c, so
            // single-quote args. Escape any embedded single quotes.
            const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
            const ctx = options.tmuxContext
            const executeCmd = `${sq(script)} ${sq(ctx.target)} ${sq(ctx.appName ?? "")} ${sq(ctx.weztermPaneId ?? "")} ${sq(ctx.socketPath ?? "")}`
            args.push("-execute", executeCmd)
          }
          execFile(tn, args, { timeout: 5000 }, () => resolve())
        })
      }
      // fell through - no terminal-notifier available; fall back to osascript
    }

    if (macBackend === "node-notifier") {
      return new Promise((resolve) => {
        const notificationOptions: any = {
          title: title,
          message: message,
          timeout: timeout,
          icon: iconPath,
        }

        notifier.notify(notificationOptions, () => {
          resolve()
        })
      })
    }

    // osascript fallback (legacy behaviour, no click-to-focus)
    return new Promise((resolve) => {
      execFile("osascript", buildOsascriptNotificationArgs(title, message), () => {
        resolve()
      })
    })
  }

  if ((platform === "Linux" || platform.match(/BSD$/)) && !isWsl) {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return

    if (options.onClick) {
      if (linuxGrouping) {
        if (linuxNotifySendSupportsReplace === null) {
          linuxNotifySendSupportsReplace = await detectNotifySendCapabilities()
        }
        if (linuxNotifySendSupportsReplace) {
          return sendLinuxNotificationDirect(title, message, timeout, iconPath, true, () => options.onClick?.())
        }
      }

      // Fallback without grouping so action click still works
      // even when --replace-id is unavailable or disabled.
      return sendLinuxNotificationDirect(title, message, timeout, iconPath, false, () => options.onClick?.())
    }

    if (linuxGrouping) {
      if (linuxNotifySendSupportsReplace === null) {
        linuxNotifySendSupportsReplace = await detectNotifySendCapabilities()
      }
      if (linuxNotifySendSupportsReplace) {
        return sendLinuxNotificationDirect(title, message, timeout, iconPath, true)
      }
    }
  }

  return new Promise((resolve) => {
    const notificationOptions: any = {
      title: title,
      message: message,
      timeout: timeout,
      icon: iconPath,
      appName: options.windowsAppID ?? "opencode",
    }

    platformNotifier.notify(
      notificationOptions,
      (err: any, response: any, metadata: any) => {
        if (options.onClick && metadata?.activationType === "default") {
          options.onClick()
        }
        resolve()
      }
    )
  })
}
