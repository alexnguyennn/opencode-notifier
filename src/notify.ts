import os from "os"
import { exec, execFile, execFileSync } from "child_process"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import notifier from "node-notifier"
import type { TmuxContext } from "./tmux-context"
import type { MacNotifier } from "./config"

const DEBOUNCE_MS = 1000

const platform = os.type()

let platformNotifier: any

if (platform === "Linux" || platform.match(/BSD$/)) {
  const { NotifySend } = notifier
  platformNotifier = new NotifySend({ withFallback: false })
} else if (platform === "Windows_NT") {
  const { WindowsToaster } = notifier
  platformNotifier = new WindowsToaster({ withFallback: false })
} else if (platform !== "Darwin") {
  platformNotifier = notifier
}

const lastNotificationTime: Record<string, number> = {}

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
  return value.replace(/[;\x07\x1b\n\r]/g, "")
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
  grouping: boolean = true
): Promise<void> {
  return new Promise((resolve) => {
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

export interface SendNotificationOptions {
  /** macOS-only: when present + backend resolves to terminal-notifier, clicking the notification runs the focus-tmux helper against this context. */
  tmuxContext?: TmuxContext | null
  /** macOS-only override. Defaults to legacy `notificationSystem` mapping for backward compat. */
  macNotifier?: MacNotifier
  /** Group id for collapsing stale notifications (terminal-notifier `-group`). */
  groupId?: string | null
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
  if (lastNotificationTime[message] && now - lastNotificationTime[message] < DEBOUNCE_MS) {
    return
  }
  lastNotificationTime[message] = now

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
            const executeCmd = `${sq(script)} ${sq(ctx.target)} ${sq(ctx.appName ?? "")} ${sq(ctx.weztermPaneId ?? "")}`
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
      const escapedMessage = message.replace(/"/g, '\\"')
      const escapedTitle = title.replace(/"/g, '\\"')
      exec(
        `osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"'`,
        () => {
          resolve()
        }
      )
    })
  }

  if (platform === "Linux" || platform.match(/BSD$/)) {
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
      "app-name": "opencode",
    }

    platformNotifier.notify(
      notificationOptions,
      () => {
        resolve()
      }
    )
  })
}
