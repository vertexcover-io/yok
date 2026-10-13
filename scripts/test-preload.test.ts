import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
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

// Thousands of leftover temp folders in the system temp folder slowed every bun a test started.
test("a test run gets its own temp folder, and the processes it starts see it", { skip }, () => {
  const child = spawnSync("sh", ["-c", 'printf %s "$TMPDIR"'], { encoding: "utf8" }).stdout
  assert.match(tmpdir(), /\/yok-test-[^/]+$/)
  assert.equal(child, tmpdir())
})
