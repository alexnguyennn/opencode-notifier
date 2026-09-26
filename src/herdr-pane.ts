import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface HerdrAgent {
  paneID: string
  terminalID: string
  sessionID: string
}

export function parseHerdrAgent(value: unknown, paneID: string): HerdrAgent | null {
  if (!value || typeof value !== "object") return null
  const result = (value as { result?: { agent?: Record<string, unknown> } }).result
  const agent = result?.agent
  const session = agent?.agent_session as { value?: unknown } | undefined
  if (agent?.agent !== "opencode" || agent.pane_id !== paneID || typeof agent.terminal_id !== "string" || !agent.terminal_id || typeof session?.value !== "string" || !session.value) return null
  return { paneID, terminalID: agent.terminal_id, sessionID: session.value }
}

export async function getHerdrAgent(paneID: string, socketPath: string): Promise<HerdrAgent | null> {
  if (!/^w\d+:p\d+$/.test(paneID) || !isAbsolute(socketPath)) return null
  try {
    const { stdout } = await execFileAsync("herdr", ["agent", "get", paneID], {
      timeout: 1000,
      env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    })
    return parseHerdrAgent(JSON.parse(stdout), paneID)
  } catch {
    return null
  }
}
