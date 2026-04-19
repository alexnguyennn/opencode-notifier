import { describe, test, expect } from "bun:test"
import { resolveMacBackend } from "./notify"

// These tests cover the non-PATH-dependent branches of resolveMacBackend.
//
// Skipped (documented):
//   - resolveMacBackend("auto", "osascript") when terminal-notifier is NOT on PATH
//     → depends on the module-local `cachedTerminalNotifier` cache + the
//       runtime PATH. We intentionally do not expose a reset helper to keep
//       the public API clean; these paths are better covered by integration
//       tests.
//   - resolveMacBackend("terminal-notifier", "osascript") fallback when NOT
//     on PATH → same reason.

describe("resolveMacBackend", () => {
  test("auto + ghostty short-circuits to ghostty (no PATH lookup)", () => {
    expect(resolveMacBackend("auto", "ghostty")).toBe("ghostty")
  })

  test("explicit osascript returns osascript regardless of legacy setting", () => {
    expect(resolveMacBackend("osascript", "osascript")).toBe("osascript")
    expect(resolveMacBackend("osascript", "node-notifier")).toBe("osascript")
    expect(resolveMacBackend("osascript", "ghostty")).toBe("osascript")
  })

  test("explicit node-notifier returns node-notifier", () => {
    expect(resolveMacBackend("node-notifier", "osascript")).toBe("node-notifier")
    expect(resolveMacBackend("node-notifier", "ghostty")).toBe("node-notifier")
  })
})
