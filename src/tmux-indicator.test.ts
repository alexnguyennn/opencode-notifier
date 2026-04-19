import { describe, test, expect, beforeEach } from "bun:test"
import { setIndicator, __resetIndicatorForTests } from "./tmux-indicator"
import type { TmuxContext } from "./tmux-context"

function makeCtx(overrides: Partial<TmuxContext> = {}): TmuxContext {
  return {
    paneId: "%1",
    windowId: "@1",
    sessionId: "$1",
    sessionName: "test",
    target: "$1:@1.%1",
    label: "test:0 win",
    appName: null,
    weztermPaneId: null,
    ...overrides,
  }
}

describe("setIndicator", () => {
  beforeEach(() => {
    __resetIndicatorForTests()
  })

  test("null ctx is a no-op (does not throw)", () => {
    expect(() => setIndicator(null, "waiting", "window-option")).not.toThrow()
  })

  test("preference=off never writes and is a no-op", () => {
    const ctx = makeCtx()
    expect(() => setIndicator(ctx, "waiting", "off")).not.toThrow()
    expect(() => setIndicator(ctx, "working", "off")).not.toThrow()
    expect(() => setIndicator(ctx, "done", "off")).not.toThrow()
    expect(() => setIndicator(ctx, null, "off")).not.toThrow()
  })

  test("window-option backend with ctx runs without throwing", () => {
    const ctx = makeCtx()
    expect(() => setIndicator(ctx, "waiting", "window-option")).not.toThrow()
    expect(() => setIndicator(ctx, "done", "window-option")).not.toThrow()
  })

  test("window-option backend with null ctx is a no-op", () => {
    expect(() => setIndicator(null, "waiting", "window-option")).not.toThrow()
    expect(() => setIndicator(null, "done", "window-option")).not.toThrow()
  })

  test("idempotence: calling twice with the same state does not throw", () => {
    // The internal lastState guard short-circuits on the second call. We can't
    // observe the execFile call directly without mocking child_process, but we
    // can at least confirm the guard path doesn't blow up and the state
    // tracking survives repeated calls.
    const ctx = makeCtx()
    expect(() => {
      setIndicator(ctx, "waiting", "window-option")
      setIndicator(ctx, "waiting", "window-option")
      setIndicator(ctx, "waiting", "window-option")
    }).not.toThrow()
  })

  test("state transitions: waiting -> done -> waiting cycles without throwing", () => {
    const ctx = makeCtx()
    expect(() => {
      setIndicator(ctx, "waiting", "window-option")
      setIndicator(ctx, "done", "window-option")
      setIndicator(ctx, "waiting", "window-option")
    }).not.toThrow()
  })

  test("__resetIndicatorForTests allows re-running same state after reset", () => {
    const ctx = makeCtx()
    expect(() => {
      setIndicator(ctx, "waiting", "window-option")
      __resetIndicatorForTests()
      // After reset, lastState is null, so this call will take the write path
      // again rather than being short-circuited.
      setIndicator(ctx, "waiting", "window-option")
    }).not.toThrow()
  })
})
