import { spawnSync } from "node:child_process"
import { expect, test } from "bun:test"

// Run inside a yok session, `orchestrate init` in a test renamed that live session's tmux pane.
test("a test, and every process it starts, sees no host tmux pane or yok run", () => {
  const host = ["TMUX", "TMUX_PANE", "YOK_RUN_ID"]
  const child = spawnSync("env", [], { encoding: "utf8" }).stdout
  for (const name of host) {
    expect(process.env[name]).toBeUndefined()
    expect(child).not.toMatch(new RegExp(`^${name}=`, "m"))
  }
})
