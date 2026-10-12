import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

// bunfig.toml loads the preload for `bun test` only; `node --test` runs this file without it.
const skip = process.versions.bun === undefined && "the preload runs under bun test only"

// Run inside a yok session, `orchestrate init` in a test renamed that live session's tmux pane.
test("a test, and every process it starts, sees no host tmux pane or yok run", { skip }, () => {
  const host = ["TMUX", "TMUX_PANE", "YOK_RUN_ID"]
  const child = spawnSync("env", [], { encoding: "utf8" }).stdout
  for (const name of host) {
    assert.equal(process.env[name], undefined)
    assert.doesNotMatch(child, new RegExp(`^${name}=`, "m"))
  }
})
