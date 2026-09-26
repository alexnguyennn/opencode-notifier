import type { Context } from "@opencode/plugin/tui/plugin"
import { paneRPC } from "./v2-pane-rpc"
import { deriveMacAppName } from "./tmux-context"
import { getHerdrAgent } from "./herdr-pane"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const separator = "\x1f"
const format = ["#{socket_path}", "#{pane_id}", "#{pane_current_command}"].join(separator)

async function inheritedPane() {
  if (process.env.HERDR_ENV === "1") {
    const paneID = process.env.HERDR_PANE_ID ?? ""
    const socket = process.env.HERDR_SOCKET_PATH ?? ""
    const agent = await getHerdrAgent(paneID, socket)
    if (!agent) return null
    return {
      socketPath: "", paneID: "", herdrPaneID: paneID,
      herdrSocketPath: socket, herdrTerminalID: agent.terminalID,
      weztermUnixSocket: process.env.WEZTERM_UNIX_SOCKET ?? "",
    }
  }
  const paneID = process.env.TMUX_PANE
  if (!paneID || !process.env.TMUX) return null
  try {
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", paneID, format], { timeout: 1000 })
    const output = stdout.trim()
    const [socketPath, resolved, command] = output.split(separator)
    if (!socketPath || resolved !== paneID || !["opencode", "opencode-v2"].includes(command)) return null
    return { socketPath, paneID }
  } catch {
    return null
  }
}

export default {
  id: "opencode-notifier-pane",
  setup(context: Context) {
    const clientID = crypto.randomUUID()
    const rpc = context.client.rpc(paneRPC)
    let disposed = false
    let registered = false
    let queue = Promise.resolve()
    let pane: Awaited<ReturnType<typeof inheritedPane>>
    let warning = ""
    const warn = (message: string) => {
      if (message === warning) return
      warning = message
      console.warn(`[opencode-notifier-pane] ${message}`)
    }

    const reconcile = async () => {
      if (disposed) return
      pane ??= await inheritedPane()
      if (!pane) {
        return
      }
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      if (!sessionID) {
        if (registered) {
          await rpc.remove({ clientID })
          registered = false
        }
        return
      }
      const root = context.data.session.root(sessionID)
      if (pane.herdrPaneID) {
        const agent = await getHerdrAgent(pane.herdrPaneID, pane.herdrSocketPath ?? "")
        if (agent?.terminalID !== pane.herdrTerminalID || agent?.sessionID !== root) {
          if (registered) { await rpc.remove({ clientID }); registered = false }
          return
        }
      }
      await rpc.update({
        clientID, sessionID: root, ...pane,
        appName: deriveMacAppName(process.env) ?? "",
        weztermPaneID: process.env.WEZTERM_PANE ?? "",
      })
      registered = true
      warning = ""
    }

    const schedule = () => {
      if (disposed) return
      queue = queue.then(reconcile, reconcile).catch((error) => {
        registered = false
        warn(`registration failed: ${String(error)}`)
      })
    }
    const stop = context.data.listen(schedule)
    const heartbeat = setInterval(schedule, 1000)
    schedule()
    return async () => {
      disposed = true
      stop()
      clearInterval(heartbeat)
      await queue
      if (registered) await rpc.remove({ clientID }).catch(() => undefined)
    }
  },
}
