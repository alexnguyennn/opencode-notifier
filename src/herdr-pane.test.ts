import { expect, test } from "bun:test"
import { parseHerdrAgent } from "./herdr-pane"

const agent = (overrides: Record<string, unknown> = {}) => ({
  result: { agent: {
    agent: "opencode", pane_id: "w3:p1", terminal_id: "term_one",
    agent_session: { value: "ses_one" }, ...overrides,
  } },
})

test("accepts an exact live OpenCode occupant for the registered pane", () => {
  expect(parseHerdrAgent(agent(), "w3:p1")).toEqual({ paneID: "w3:p1", terminalID: "term_one", sessionID: "ses_one" })
})

test("rejects replaced, mismatched or unrecognized pane occupants", () => {
  expect(parseHerdrAgent(agent({ pane_id: "w3:p2" }), "w3:p1")).toBeNull()
  expect(parseHerdrAgent(agent({ agent: "codex" }), "w3:p1")).toBeNull()
  expect(parseHerdrAgent(agent({ terminal_id: "" }), "w3:p1")).toBeNull()
  expect(parseHerdrAgent({ error: { code: "not_found" } }, "w3:p1")).toBeNull()
})
