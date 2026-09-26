import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNotifierV2Hooks } from "./index"
import { normalizeV2Event, NotifierPluginV2, resolvePane, setupNotifierV2 } from "./v2"

describe("OpenCode V2 adapter", () => {
  test("Herdr owner resolves only while its exact terminal and session are live", async () => {
    const owner = {
      clientID: "herdr-viewer", sessionID: "ses_one", socketPath: "", paneID: "",
      appName: "WezTerm", weztermPaneID: "0", herdrPaneID: "w3:p1",
      herdrSocketPath: "/private/herdr.sock", herdrTerminalID: "term_one",
      weztermUnixSocket: "/private/gui-sock-123",
    }
    const live = { paneID: "w3:p1", terminalID: "term_one", sessionID: "ses_one" }
    expect(await resolvePane(owner, async () => live)).toMatchObject({
      herdrPaneID: "w3:p1", herdrTerminalID: "term_one", herdrSessionID: "ses_one",
      weztermUnixSocket: "/private/gui-sock-123", target: "", weztermPaneId: "0",
    })
    expect(await resolvePane(owner, async () => ({ ...live, terminalID: "term_replaced" }))).toBeNull()
    expect(await resolvePane(owner, async () => ({ ...live, sessionID: "ses_other" }))).toBeNull()
    expect(await resolvePane(owner, async () => null)).toBeNull()
  })

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

  test("does not treat V2 idle as a second completion", () => {
    expect(normalizeV2Event({ type: "session.idle", data: { sessionID: "ses_1" } })).toBeNull()
  })

  test("question, plan, permission and error alerts resolve their session's pane", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notifier-v2-hooks-"))
    const configPath = join(directory, "config.json")
    writeFileSync(configPath, JSON.stringify({ sound: false, notification: false, command: { enabled: false } }))
    const previous = process.env.OPENCODE_NOTIFIER_CONFIG_PATH
    process.env.OPENCODE_NOTIFIER_CONFIG_PATH = configPath
    const resolved: Array<string | null> = []
    try {
      const hooks = await createNotifierV2Hooks({ client: {} as never, directory } as never, async (sessionID) => {
        resolved.push(sessionID)
        return null
      })
      await hooks["tool.execute.before"]?.({ tool: "question", sessionID: "ses_question", callID: "call_1" }, { args: {} })
      await hooks["tool.execute.before"]?.({ tool: "plan_exit", sessionID: "ses_plan", callID: "call_2" }, { args: {} })
      await hooks.event?.({ event: { type: "permission.asked", properties: { sessionID: "ses_permission" } } } as never)
      await hooks.event?.({ event: { type: "session.error", properties: { sessionID: "ses_error", error: { name: "ProviderError" } } } } as never)
      expect(resolved).toEqual(["ses_question", "ses_plan", "ses_permission", "ses_error"])
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_NOTIFIER_CONFIG_PATH
      else process.env.OPENCODE_NOTIFIER_CONFIG_PATH = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("recovers a successful prompt that finishes before the event feed connects", async () => {
    let connect!: () => void
    let prompt!: (input: { sessionID: string }) => Promise<void>
    const notified: string[] = []
    const context = {
      location: { directory: "/project" },
      rpc: { register: async () => ({ dispose: async () => {} }) },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      session: {
        hook: async (_name: string, handler: typeof prompt) => { prompt = handler; return { dispose: async () => {} } },
        get: async () => ({ outcome: "succeeded", time: { idle: Date.now() }, location: { directory: "/project" } }),
      },
      permission: {},
      event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => { connect = resolve })
        yield { type: "server.connected", data: {} }
        await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      } },
    }
    const cleanup = await setupNotifierV2(context as never, (async () => ({ event: async () => {} })) as never, {
      resolvePane: async () => null,
      notify: async (_client, _directory, sessionID) => { notified.push(sessionID) },
    })
    await prompt({ sessionID: "ses_cold" })
    connect()
    for (let i = 0; i < 10 && notified.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(notified).toEqual(["ses_cold"])
    await cleanup()
  })

  test("one succeeded event per session uses its registered pane, with a server-only fallback", async () => {
    let update: (input: any) => Promise<unknown> = async () => false
    const notifications: Array<{ sessionID: string; eventID: string; target: unknown }> = []
    let send: (event: unknown) => void = () => {}
    const events: unknown[] = []
    const context = {
      location: { directory: "/same/folder" },
      rpc: { register: async (_definition: unknown, handlers: any) => {
        update = handlers.update
        return { dispose: async () => {} }
      } },
      event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        yield { type: "server.connected", data: {} }
        while (!signal.aborted) {
          if (!events.length) await new Promise<void>((resolve) => { send = resolve; signal.addEventListener("abort", resolve, { once: true }) })
          while (events.length) yield events.shift()
        }
      } },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      session: {
        hook: async () => ({ dispose: async () => {} }),
        get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: sessionID === "ses_3" ? "/same/folder" : "/other" } }),
      }, permission: {},
    }
    const cleanup = await setupNotifierV2(context as never, (async () => ({ event: async () => {} })) as never, {
      resolvePane: async (owner) => ({ paneId: owner.paneID } as never),
      notify: async (_client, _directory, sessionID, eventID, target) => {
        notifications.push({ sessionID, eventID, target })
      },
    })
    await update({ clientID: "one", sessionID: "ses_1", socketPath: "/tmp/tmux", paneID: "%3", appName: "WezTerm", weztermPaneID: "20" })
    events.push({ type: "session.execution.succeeded", id: "evt_1", location: { directory: "/same/folder" }, data: { sessionID: "ses_1" } })
    events.push({ type: "session.idle", id: "evt_idle", location: { directory: "/same/folder" }, data: { sessionID: "ses_1" } })
    events.push({ type: "session.execution.succeeded", id: "evt_other", location: { directory: "/other" }, data: { sessionID: "ses_elsewhere" } })
    events.push({ type: "session.execution.succeeded", id: "evt_2", location: { directory: "/same/folder" }, data: { sessionID: "ses_2" } })
    events.push({ type: "session.execution.succeeded", id: "evt_other_without_location", data: { sessionID: "ses_elsewhere" } })
    events.push({ type: "session.execution.succeeded", id: "evt_3", data: { sessionID: "ses_3" } })
    send()
    for (let i = 0; i < 10 && notifications.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(notifications).toEqual([
      { sessionID: "ses_1", eventID: "evt_1", target: { paneId: "%3" } },
      { sessionID: "ses_2", eventID: "evt_2", target: null },
      { sessionID: "ses_3", eventID: "evt_3", target: null },
    ])
    await cleanup()
  })

  test("registration routed to another location still focuses the session's pane", async () => {
    let update!: (input: unknown) => Promise<unknown>
    let resolveViewer!: (sessionID: string | null) => Promise<unknown>
    let send!: () => void
    const events: unknown[] = []
    const notifications: unknown[] = []
    const makeContext = (directory: string) => ({
      location: { directory },
      rpc: { register: async (_definition: unknown, handlers: any) => {
        if (directory === "/other") update = handlers.update
        return { dispose: async () => {} }
      } },
      session: {
        hook: async () => ({ dispose: async () => {} }),
        get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory }, parentID: sessionID === "ses_child" ? "ses_cross" : undefined }),
      },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      permission: {},
      event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        yield { type: "server.connected", data: {} }
        if (directory === "/other") {
          await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }))
          return
        }
        while (!signal.aborted) {
          if (!events.length) await new Promise<void>((resolve) => { send = resolve; signal.addEventListener("abort", resolve, { once: true }) })
          while (events.length) yield events.shift()
        }
      } },
    })
    const dependencies = {
      resolvePane: async (owner: { paneID: string }) => ({ paneId: owner.paneID } as never),
      notify: async (_client: unknown, directory: string, sessionID: string, _eventID: string, target: unknown) => {
        notifications.push({ directory, sessionID, target })
      },
    }
    const createHooks = (async (_input: unknown, resolver: typeof resolveViewer) => {
      if (!resolveViewer) resolveViewer = resolver
      return {}
    }) as never
    const cleanupOther = await setupNotifierV2(makeContext("/other") as never, createHooks, dependencies as never)
    const cleanupSession = await setupNotifierV2(makeContext("/same/folder") as never, createHooks, dependencies as never)
    await update({ clientID: "cross-location", sessionID: "ses_cross", socketPath: "/tmp/tmux", paneID: "%9", appName: "WezTerm", weztermPaneID: "5" })
    expect(await resolveViewer("ses_child")).toEqual({ paneId: "%9" })
    events.push({ type: "session.execution.succeeded", id: "evt_cross", location: { directory: "/same/folder" }, data: { sessionID: "ses_cross" } })
    send()
    for (let i = 0; i < 10 && notifications.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(notifications).toEqual([{ directory: "/same/folder", sessionID: "ses_cross", target: { paneId: "%9" } }])
    await cleanupSession()
    await cleanupOther()
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
          yield { type: "server.connected", data: {} }
          yield { type: "session.status", location: { directory: "/tmp/project" }, data: { sessionID: "ses_1", status: { type: "busy" } } }
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
      rpc: { register: async () => ({ dispose: async () => {} }) },
      session: {
        hook: async () => ({ dispose: async () => {} }),
        get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: sessionID === "ses_1" ? "/tmp/project" : "/other" } }),
      },
      permission: {},
    }
    const createHooks = async () => ({
      event: async ({ event }: { event: unknown }) => { receivedEvents.push(event) },
      "tool.execute.before": async (input: unknown, output: unknown) => {
        receivedTools.push({ input, output })
      },
    })

    const cleanup = await setupNotifierV2(context as never, createHooks as never)
    for (let i = 0; i < 10 && receivedEvents.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(receivedEvents).toEqual([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
    ])

    await toolCallback?.({ tool: "question", sessionID: "ses_1", id: "call_1", input: { prompt: "ok?" } })
    await toolCallback?.({ tool: "question", sessionID: "ses_elsewhere", id: "call_other", input: { prompt: "other?" } })
    expect(receivedTools).toEqual([{
      input: { tool: "question", sessionID: "ses_1", callID: "call_1" },
      output: { args: { prompt: "ok?" } },
    }])

    await cleanup()
    expect(toolDisposed).toBe(true)
    expect(releaseSubscription).toBeDefined()
  })
})
