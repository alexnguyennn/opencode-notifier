import { describe, expect, test } from "bun:test"
import { normalizeV2Event, NotifierPluginV2, setupNotifierV2 } from "./v2"

describe("OpenCode V2 adapter", () => {
  test("exports a native V2 plugin definition", () => {
    expect(NotifierPluginV2.id).toBe("opencode-notifier")
    expect(typeof NotifierPluginV2.setup).toBe("function")
  })

  test("normalizes permission events", () => {
    expect(
      normalizeV2Event({
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_1" },
      })
    ).toEqual({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1" },
    })
  })

  test("normalizes session execution failures", () => {
    expect(
      normalizeV2Event({
        type: "session.execution.failed",
        data: { sessionID: "ses_1", error: { name: "ProviderError" } },
      })
    ).toEqual({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "ProviderError" } },
    })
  })

  test("normalizes user inbox events and ignores non-user items", () => {
    expect(
      normalizeV2Event({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_1", item: { type: "user" } },
      })
    ).toEqual({
      type: "message.updated",
      properties: { info: { role: "user", sessionID: "ses_1" } },
    })
    expect(
      normalizeV2Event({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_1", item: { type: "synthetic" } },
      })
    ).toBeNull()
  })

  test("forwards events and tools, then disposes the V2 registrations", async () => {
    let releaseSubscription: (() => void) | undefined
    let toolCallback: ((event: any) => Promise<void>) | undefined
    let toolDisposed = false
    const receivedEvents: unknown[] = []
    const receivedTools: unknown[] = []

    const context = {
      location: { directory: "/tmp/project" },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          yield { type: "session.idle", data: { sessionID: "ses_1" } }
          await new Promise<void>((resolve) => {
            releaseSubscription = resolve
            signal.addEventListener("abort", resolve, { once: true })
          })
        },
      },
      tool: {
        hook: async (_name: string, callback: (event: any) => Promise<void>) => {
          toolCallback = callback
          return { dispose: async () => { toolDisposed = true } }
        },
      },
      session: {},
      permission: {},
    }
    const createHooks = async () => ({
      event: async ({ event }: { event: unknown }) => { receivedEvents.push(event) },
      "tool.execute.before": async (input: unknown, output: unknown) => {
        receivedTools.push({ input, output })
      },
    })

    const cleanup = await setupNotifierV2(context as never, createHooks as never)
    await Promise.resolve()
    expect(receivedEvents).toEqual([
      { type: "session.idle", properties: { sessionID: "ses_1" } },
    ])

    await toolCallback?.({ tool: "question", sessionID: "ses_1", id: "call_1", input: { prompt: "ok?" } })
    expect(receivedTools).toEqual([{
      input: { tool: "question", sessionID: "ses_1", callID: "call_1" },
      output: { args: { prompt: "ok?" } },
    }])

    await cleanup()
    expect(toolDisposed).toBe(true)
    expect(releaseSubscription).toBeDefined()
  })
})
