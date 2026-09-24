import type { Context, Plugin } from "@opencode/plugin/promise/plugin"
import { createNotifierV2Hooks, notifyV2Completion } from "./index"
import { PaneRegistry, paneContext, type PaneRegistration } from "./v2-pane-registry"
import { paneRPC } from "./v2-pane-rpc"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const fields = "\x1f"
// RPC routes are global to the server, while plugin setup runs per location.
// Whichever location receives an update must share its owner with the instance
// that receives the session's completion event.
const serverState = globalThis as typeof globalThis & { __opencodeNotifierV2Panes?: PaneRegistry }
const panes = serverState.__opencodeNotifierV2Panes ??= new PaneRegistry()

/** Resolve the pane on its own tmux socket at emission time; never trust stale registration metadata. */
async function resolvePane(owner: PaneRegistration) {
  try {
    const { stdout } = await execFileAsync("tmux", ["-S", owner.socketPath, "display-message", "-p", "-t", owner.paneID,
      ["#{socket_path}", "#{pane_id}", "#{pane_current_command}", "#{window_id}", "#{session_id}", "#{session_name}", "#{window_index}", "#{window_name}"].join(fields)], { timeout: 1000 })
    const [socket, paneID, command, windowID, sessionID, sessionName, index, windowName] = stdout.trim().split(fields)
    if (socket !== owner.socketPath || paneID !== owner.paneID || !["opencode", "opencode-v2"].includes(command) || !windowID || !sessionID) return null
    return paneContext(owner, { paneID, windowID, sessionID, sessionName, label: `${sessionName}:${index} ${windowName}` })
  } catch {
    return null
  }
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** The server event stream is global even when the plugin instance is location-scoped. */
async function belongsToLocation(event: unknown, context: Context): Promise<boolean> {
  const source = record(event)
  const directory = string(record(source?.location)?.directory)
  if (directory) return directory === context.location.directory
  const sessionID = string(record(source?.data)?.sessionID)
  if (!sessionID) return false
  try {
    const info = await context.session.get({ sessionID: sessionID as never })
    return info.location.directory === context.location.directory
  } catch {
    return false
  }
}

/** Convert notifier-relevant OpenCode V2 events to the V1 hook event shape. */
export function normalizeV2Event(event: unknown): UnknownRecord | null {
  const source = record(event)
  const type = string(source?.type)
  const data = record(source?.data)
  if (!type || !data) return null

  switch (type) {
    case "session.created":
      return {
        type,
        properties: {
          info: {
            id: data.sessionID,
            title: data.title,
            parentID: data.parentID,
          },
        },
      }
    case "session.renamed":
      return {
        type: "session.updated",
        properties: {
          info: {
            id: data.sessionID,
            title: data.title,
          },
        },
      }
    case "session.deleted":
      return {
        type,
        properties: { info: { id: data.sessionID } },
      }
    case "permission.asked":
      return {
        type,
        properties: {
          id: data.id,
          sessionID: data.sessionID,
        },
      }
    case "permission.replied":
      return {
        type,
        properties: {
          sessionID: data.sessionID,
          requestID: data.requestID,
        },
      }
    // V2 has a durable terminal execution event. The ephemeral idle event is
    // deliberately ignored so the same completion cannot notify twice.
    case "session.idle":
      return null
    case "session.status":
      return {
        type,
        properties: {
          sessionID: data.sessionID,
          status: data.status,
        },
      }
    case "session.execution.failed":
      return {
        type: "session.error",
        properties: {
          sessionID: data.sessionID,
          error: data.error,
        },
      }
    case "session.execution.interrupted":
      return {
        type: "session.error",
        properties: {
          sessionID: data.sessionID,
          error: { name: "MessageAbortedError", reason: data.reason },
        },
      }
    case "session.inbox.enqueued": {
      const item = record(data.item)
      if (item?.type !== "user") return null
      return {
        type: "message.updated",
        properties: {
          info: {
            role: "user",
            sessionID: data.sessionID,
          },
        },
      }
    }
    default:
      return null
  }
}

function createV1Client(context: Context): unknown {
  return {
    session: {
      messages: async ({ path }: { path: { id: string } }) => {
        const messages = await context.session.context({ sessionID: path.id as never })
        return {
          data: messages.map((message) => ({
            info: {
              role: message.type,
              time: message.time,
            },
          })),
        }
      },
      get: async ({ path }: { path: { id: string } }) => ({
        data: await context.session.get({ sessionID: path.id as never }),
      }),
    },
    permission: {
      list: async ({ sessionID }: { sessionID: string }) => ({
        data: await context.permission.list({ sessionID: sessionID as never }),
      }),
    },
  }
}

export const NotifierPluginV2: Plugin = {
  id: "opencode-notifier",
  setup: setupNotifierV2,
}

export async function setupNotifierV2(
  context: Context,
  createHooks: typeof createNotifierV2Hooks = createNotifierV2Hooks,
  dependencies: { resolvePane: typeof resolvePane; notify: typeof notifyV2Completion } = { resolvePane, notify: notifyV2Completion }
): Promise<() => Promise<void>> {
  const resolveContext = async (sessionID: string | null) => {
    const seen = new Set<string>()
    while (sessionID && !seen.has(sessionID)) {
      seen.add(sessionID)
      const owner = panes.owner(sessionID)
      if (owner) {
        const target = await dependencies.resolvePane(owner)
        if (target) return target
      }
      const session = await context.session.get({ sessionID: sessionID as never }).catch(() => null)
      sessionID = session?.parentID ?? null
    }
    return null
  }
  const hooks = await createHooks({
    client: createV1Client(context),
    directory: context.location.directory,
  } as never, resolveContext)

  const rpc = await context.rpc.register(paneRPC, {
    update: async (input) => { panes.update(input as PaneRegistration); return true },
    remove: async (input) => { panes.remove((input as { clientID: string }).clientID); return true },
  })

  const pendingBeforeFeed = new Map<string, number>()
  const promptHook = await context.session.hook("prompt", async (input) => {
    pendingBeforeFeed.set(input.sessionID, Date.now())
  })
  const controller = new AbortController()
  const notify = async (sessionID: string, eventID: string) => {
    const target = await resolveContext(sessionID)
    await dependencies.notify(createV1Client(context) as never, context.location.directory, sessionID, eventID, target)
  }
  const eventLoop = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        if (event.type === "server.connected") {
          // The SSE endpoint starts only after plugin setup has returned. A
          // fast first run can finish in that gap; reconcile only prompts
          // observed by this plugin during startup, not historical sessions.
          for (const [sessionID, started] of pendingBeforeFeed) {
            const info = await context.session.get({ sessionID: sessionID as never }).catch(() => null)
            pendingBeforeFeed.delete(sessionID)
            if (info?.location.directory === context.location.directory && info.outcome === "succeeded" && typeof info.time.idle === "number" && info.time.idle >= started) {
              await notify(sessionID, `catchup:${sessionID}:${info.time.idle}`)
            }
          }
          continue
        }
        if (!(await belongsToLocation(event, context))) continue
        if (event.type === "session.execution.succeeded") {
          const sessionID = string(record(event.data)?.sessionID)
          const eventID = string(record(event)?.id)
          if (sessionID) {
            pendingBeforeFeed.delete(sessionID)
            await notify(sessionID, eventID ?? `${sessionID}:${Date.now()}`)
          }
          continue
        }
        const normalized = normalizeV2Event(event)
        if (normalized) {
          await hooks.event?.({ event: normalized } as never)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("[opencode-notifier] V2 event subscription stopped", error)
      }
    }
  })()

  let toolHook: Awaited<ReturnType<Context["tool"]["hook"]>> | undefined
  try {
    toolHook = await context.tool.hook("execute.before", async (event) => {
      if (!(await belongsToLocation({ data: { sessionID: event.sessionID } }, context))) return
      await hooks["tool.execute.before"]?.(
        {
          tool: event.tool,
          sessionID: event.sessionID,
          callID: event.id,
        },
        { args: event.input }
      )
    })
  } catch (error) {
    controller.abort()
    await toolHook?.dispose()
    await promptHook.dispose()
    await eventLoop
    await rpc.dispose()
    throw error
  }

  return async () => {
    controller.abort()
    await toolHook?.dispose()
    await promptHook.dispose()
    await rpc.dispose()
    await eventLoop
  }
}

export default NotifierPluginV2
