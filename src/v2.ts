import type { Context, Plugin } from "@opencode/plugin/promise/plugin"
import { NotifierPlugin } from "./index"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
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
    case "session.idle":
      return { type, properties: { sessionID: data.sessionID } }
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
  createHooks: typeof NotifierPlugin = NotifierPlugin
): Promise<() => Promise<void>> {
  const hooks = await createHooks({
    client: createV1Client(context),
    directory: context.location.directory,
  } as never)

  const controller = new AbortController()
  const eventLoop = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
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

  let toolHook: Awaited<ReturnType<Context["tool"]["hook"]>>
  try {
    toolHook = await context.tool.hook("execute.before", async (event) => {
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
    await eventLoop
    throw error
  }

  return async () => {
    controller.abort()
    await toolHook.dispose()
    await eventLoop
  }
}

export default NotifierPluginV2
