import type { TmuxContext } from "./tmux-context"

export interface PaneRegistration {
  clientID: string
  sessionID: string
  socketPath: string
  paneID: string
  appName: string
  weztermPaneID: string
  herdrPaneID?: string
  herdrSocketPath?: string
  herdrTerminalID?: string
  weztermUnixSocket?: string
}

interface Viewer extends PaneRegistration {
  expiresAt: number
  activated: number
}

export const PANE_LEASE_MS = 4000

export class PaneRegistry {
  private viewers = new Map<string, Viewer>()
  private activation = 0

  update(input: PaneRegistration, now = Date.now()): void {
    const old = this.viewers.get(input.clientID)
    this.viewers.set(input.clientID, {
      ...input,
      expiresAt: now + PANE_LEASE_MS,
      activated: old && old.sessionID === input.sessionID && old.socketPath === input.socketPath && old.paneID === input.paneID && old.herdrPaneID === input.herdrPaneID && old.herdrSocketPath === input.herdrSocketPath && old.herdrTerminalID === input.herdrTerminalID
        ? old.activated
        : ++this.activation,
    })
  }

  remove(clientID: string): void {
    this.viewers.delete(clientID)
  }

  owner(sessionID: string, now = Date.now()): PaneRegistration | null {
    for (const [id, viewer] of this.viewers) {
      if (viewer.expiresAt <= now) this.viewers.delete(id)
    }
    const candidates = [...this.viewers.values()].filter((viewer) => viewer.sessionID === sessionID)
    candidates.sort((a, b) => b.activated - a.activated || a.clientID.localeCompare(b.clientID))
    return candidates[0] ?? null
  }
}

export function paneContext(owner: PaneRegistration, resolved: {
  paneID: string
  windowID: string
  sessionID: string
  sessionName: string
  label: string
}): TmuxContext {
  return {
    paneId: resolved.paneID,
    windowId: resolved.windowID,
    sessionId: resolved.sessionID,
    sessionName: resolved.sessionName,
    target: `${resolved.sessionID}:${resolved.windowID}.${resolved.paneID}`,
    label: resolved.label,
    appName: owner.appName || null,
    weztermPaneId: owner.weztermPaneID || null,
    socketPath: owner.socketPath,
  }
}
