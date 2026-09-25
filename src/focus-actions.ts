import { randomBytes } from "node:crypto"
import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TmuxContext } from "./tmux-context"

const TOKEN = /^[a-f0-9]{12}$/
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function focusActionDirectory(home = homedir()): string {
  return join(home, ".local", "state", "opencode-notifier", "focus-actions")
}

export function newFocusToken(): string {
  return randomBytes(6).toString("hex")
}

export function focusMessage(message: string, token: string): string {
  if (!TOKEN.test(token)) throw new Error("invalid focus token")
  return `${message} · [focus:${token}]`
}

export async function saveFocusAction(token: string, script: string, ctx: TmuxContext, directory = focusActionDirectory(), context: { sessionTitle?: string | null; projectName?: string | null } = {}): Promise<void> {
  if (!TOKEN.test(token)) throw new Error("invalid focus token")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = join(directory, `${token}.json`)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      script,
      target: ctx.target,
      paneID: ctx.paneId,
      appName: ctx.appName ?? "",
      weztermPaneID: ctx.weztermPaneId ?? "",
      socketPath: ctx.socketPath ?? "",
      sessionTitle: context.sessionTitle?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "",
      projectName: context.projectName?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
    }), { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function removeFocusAction(token: string, directory = focusActionDirectory()): Promise<void> {
  if (TOKEN.test(token)) await unlink(join(directory, `${token}.json`)).catch(() => undefined)
}

export async function pruneFocusActions(directory = focusActionDirectory(), now = Date.now()): Promise<void> {
  for (const name of await readdir(directory).catch(() => [])) {
    if (!TOKEN.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue
    const path = join(directory, name)
    const info = await stat(path).catch(() => null)
    if (info && now - info.mtimeMs > MAX_AGE_MS) await unlink(path).catch(() => undefined)
  }
}
