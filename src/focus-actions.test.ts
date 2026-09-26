import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { focusMessage, pruneFocusActions, removeFocusAction, saveFocusAction, sessionMessage } from "./focus-actions"

test("persists separate actionable alerts without changing their titles or mixing focus targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notifier-focus-actions-"))
  const first = "0a1b2c3d4e5f"
  const second = "a1b2c3d4e5f6"
  const ctx = (paneID: string) => ({
    target: `$1:@2.${paneID}`, paneId: paneID, windowId: "@2", sessionId: "$1",
    sessionName: "test", label: "test", appName: "WezTerm", weztermPaneId: "7", socketPath: "/tmp/tmux.sock",
  })
  try {
    await saveFocusAction(first, "/focus-helper", ctx("%3"), directory, { sessionTitle: "  Fix\n picker  ", projectName: "demo" })
    await saveFocusAction(second, "/focus-helper", ctx("%4"), directory)
    expect(focusMessage("Session has finished", first)).toBe("Session has finished · [focus:0a1b2c3d4e5f]")
    expect(focusMessage("Session has finished", first, "  Fix\n picker  ")).toBe("Fix picker — Session has finished · [focus:0a1b2c3d4e5f]")
    expect(focusMessage("Fix picker — Session has finished", first, "Fix picker")).toBe("Fix picker — Session has finished · [focus:0a1b2c3d4e5f]")
    expect(sessionMessage("Session has finished", "Fix picker")).toBe("Fix picker — Session has finished")
    expect(sessionMessage("Fix picker — Session has finished", "Fix picker")).toBe("Fix picker — Session has finished")
    expect(sessionMessage("Session has finished", null)).toBe("Session has finished")
    expect(focusMessage("Done", first, "x".repeat(130))).toBe(`${"x".repeat(120)} — Done · [focus:0a1b2c3d4e5f]`)
    expect(JSON.parse(readFileSync(join(directory, `${first}.json`), "utf8")).target).toBe("$1:@2.%3")
    expect(JSON.parse(readFileSync(join(directory, `${first}.json`), "utf8")).sessionTitle).toBe("Fix picker")
    expect(JSON.parse(readFileSync(join(directory, `${first}.json`), "utf8")).projectName).toBe("demo")
    expect(JSON.parse(readFileSync(join(directory, `${second}.json`), "utf8")).target).toBe("$1:@2.%4")
    expect(statSync(join(directory, `${first}.json`)).mode & 0o777).toBe(0o600)
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    utimesSync(join(directory, `${first}.json`), old, old)
    await pruneFocusActions(directory)
    expect(() => readFileSync(join(directory, `${first}.json`))).toThrow()
    await removeFocusAction(second, directory)
    expect(() => readFileSync(join(directory, `${second}.json`))).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
