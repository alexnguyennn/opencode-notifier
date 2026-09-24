import { expect, test } from "bun:test"
import { PaneRegistry } from "./v2-pane-registry"

const pane = (clientID: string, sessionID: string) => ({
  clientID, sessionID, socketPath: "/tmp/tmux-socket", paneID: `%${clientID}`,
  appName: "WezTerm", weztermPaneID: clientID,
})

test("independent sessions in the same project retain independent pane owners", () => {
  const registry = new PaneRegistry()
  registry.update(pane("1", "ses_1"), 100)
  registry.update(pane("2", "ses_2"), 100)
  expect(registry.owner("ses_1", 200)?.paneID).toBe("%1")
  expect(registry.owner("ses_2", 200)?.paneID).toBe("%2")
  registry.update(pane("1", "ses_3"), 300)
  expect(registry.owner("ses_1", 400)).toBeNull()
  expect(registry.owner("ses_3", 400)?.paneID).toBe("%1")
})

test("latest viewer wins without heartbeat reshuffling; disposal and expiry remove stale owners", () => {
  const registry = new PaneRegistry()
  registry.update(pane("1", "ses_1"), 100)
  registry.update(pane("2", "ses_1"), 200)
  registry.update(pane("1", "ses_1"), 300)
  expect(registry.owner("ses_1", 400)?.paneID).toBe("%2")
  registry.remove("2")
  expect(registry.owner("ses_1", 400)?.paneID).toBe("%1")
  expect(registry.owner("ses_1", 4300)).toBeNull()
})
