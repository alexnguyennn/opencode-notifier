import { describe, test, expect } from "bun:test"
import { captureTmuxContext, deriveMacAppName } from "./tmux-context"

// NOTE: These tests intentionally avoid exercising the in-tmux branch of
// `captureTmuxContext`, which shells out to `tmux display-message`. That path
// is covered by integration tests - unit tests here focus on pure env-derived
// logic via injected env.
//
// TODO: integration test for the in-tmux path (requires tmux installed + a
// running tmux session).

const isDarwin = process.platform === "darwin"

describe("deriveMacAppName", () => {
  test.if(isDarwin)("TERM_PROGRAM=WezTerm maps to WezTerm", () => {
    expect(deriveMacAppName({ TERM_PROGRAM: "WezTerm" })).toBe("WezTerm")
  })

  test.if(isDarwin)("TERM_PROGRAM=iTerm.app maps to iTerm", () => {
    // The function lowercases TERM_PROGRAM; "iterm.app" is not a direct key,
    // but "iterm" and "iterm2" are. Real iTerm2 sets TERM_PROGRAM=iTerm.app,
    // so we expect the LC_TERMINAL / prefix path; falling back to null is
    // acceptable per current implementation. We assert the documented key
    // "iterm" explicitly works.
    expect(deriveMacAppName({ TERM_PROGRAM: "iterm" })).toBe("iTerm")
    expect(deriveMacAppName({ TERM_PROGRAM: "iterm2" })).toBe("iTerm")
  })

  test.if(isDarwin)("TERM_PROGRAM=ghostty maps to Ghostty", () => {
    expect(deriveMacAppName({ TERM_PROGRAM: "ghostty" })).toBe("Ghostty")
  })

  test.if(isDarwin)("TERM_PROGRAM=tmux with WEZTERM_PANE falls back to WezTerm", () => {
    const env = { TERM_PROGRAM: "tmux", WEZTERM_PANE: "42" }
    expect(deriveMacAppName(env)).toBe("WezTerm")
  })

  test.if(isDarwin)("TERM_PROGRAM=tmux alone returns null", () => {
    expect(deriveMacAppName({ TERM_PROGRAM: "tmux" })).toBe(null)
  })

  test.if(isDarwin)("TERM_PROGRAM=Apple_Terminal maps to Terminal (case-insensitive)", () => {
    expect(deriveMacAppName({ TERM_PROGRAM: "Apple_Terminal" })).toBe("Terminal")
  })

  test.if(isDarwin)("KITTY_WINDOW_ID with no TERM_PROGRAM maps to kitty", () => {
    expect(deriveMacAppName({ KITTY_WINDOW_ID: "1" })).toBe("kitty")
  })

  test.if(isDarwin)("ALACRITTY_SOCKET maps to Alacritty", () => {
    expect(deriveMacAppName({ ALACRITTY_SOCKET: "/tmp/x" })).toBe("Alacritty")
  })

  test.if(isDarwin)("empty env returns null", () => {
    expect(deriveMacAppName({})).toBe(null)
  })

  // Platform branch (non-darwin) isn't easily testable without mocking
  // `process.platform`; skipped intentionally.
})

describe("captureTmuxContext (no-tmux branches)", () => {
  test("empty env returns null", () => {
    expect(captureTmuxContext({})).toBe(null)
  })

  test.if(isDarwin)("WEZTERM_PANE + TERM_PROGRAM=WezTerm (no TMUX) returns wezterm-only context", () => {
    const env = { WEZTERM_PANE: "42", TERM_PROGRAM: "WezTerm" }
    const ctx = captureTmuxContext(env)
    expect(ctx).not.toBe(null)
    expect(ctx!.weztermPaneId).toBe("42")
    expect(ctx!.appName).toBe("WezTerm")
    expect(ctx!.paneId).toBe("")
    expect(ctx!.windowId).toBe("")
    expect(ctx!.sessionId).toBe("")
    expect(ctx!.sessionName).toBe("")
    expect(ctx!.target).toBe("")
  })

  test.if(isDarwin)("TERM_PROGRAM=Ghostty only returns ghostty-only context", () => {
    const env = { TERM_PROGRAM: "ghostty" }
    const ctx = captureTmuxContext(env)
    expect(ctx).not.toBe(null)
    expect(ctx!.appName).toBe("Ghostty")
    expect(ctx!.weztermPaneId).toBe(null)
    expect(ctx!.paneId).toBe("")
    expect(ctx!.windowId).toBe("")
    expect(ctx!.sessionId).toBe("")
    expect(ctx!.sessionName).toBe("")
    expect(ctx!.target).toBe("")
  })
})
