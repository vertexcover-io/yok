import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { PLATFORMS, writeNpmPackages } from "./npm-packages.ts"

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"))

// Stand-in release binaries: each prints its platform and arguments, then exits with $YOK_EXIT.
const fakeDist = (): string => {
  const dist = temp("yok-dist-")
  for (const platform of PLATFORMS) {
    writeFileSync(join(dist, `yok-${platform}`), `#!/bin/sh\necho "${platform} $*"\nexit "\${YOK_EXIT:-0}"\n`)
  }
  return dist
}

describe("writeNpmPackages", () => {
  test("writes one package per platform, holding its binary, and a launcher package that depends on all of them", () => {
    const out = temp("yok-npm-")
    writeNpmPackages(fakeDist(), "1.2.3-rc.1", out)

    for (const platform of PLATFORMS) {
      const [os, cpu] = platform.split("-")
      const manifest = readJson(join(out, `yok-${platform}`, "package.json"))
      assert.equal(manifest.name, `@vertexcover/yok-${platform}`)
      assert.equal(manifest.version, "1.2.3-rc.1")
      assert.deepEqual(manifest.os, [os])
      assert.deepEqual(manifest.cpu, [cpu])
      assert.equal(statSync(join(out, `yok-${platform}`, "bin", "yok")).mode & 0o111, 0o111)
    }

    const main = readJson(join(out, "yok", "package.json"))
    assert.equal(main.name, "@vertexcover/yok")
    assert.deepEqual(main.bin, { yok: "bin/yok.js" })
    assert.deepEqual(
      main.optionalDependencies,
      Object.fromEntries(PLATFORMS.map((p) => [`@vertexcover/yok-${p}`, "1.2.3-rc.1"])),
    )
  })

  // npm trusted publishing rejects a package whose repository does not match the publishing repo.
  test("names the GitHub repo in every package, so trusted publishing accepts it", () => {
    const out = temp("yok-npm-")
    writeNpmPackages(fakeDist(), "1.2.3", out)

    for (const name of [...PLATFORMS.map((p) => `yok-${p}`), "yok"]) {
      assert.deepEqual(readJson(join(out, name, "package.json")).repository, {
        type: "git",
        url: "git+https://github.com/vertexcover-io/yok.git",
      })
    }
  })

  test("fails when a platform binary is missing, before writing anything", () => {
    const dist = temp("yok-dist-")
    const out = join(temp("yok-npm-"), "packages")
    assert.throws(() => writeNpmPackages(dist, "1.2.3", out), /yok-darwin-arm64/)
    assert.throws(() => statSync(out))
  })
})

describe("the launcher", () => {
  // Lays the packages out the way npm installs them, then runs the launcher with node.
  const installed = (exit: string) => {
    const out = temp("yok-npm-")
    writeNpmPackages(fakeDist(), "1.2.3", out)
    const scope = join(temp("yok-prefix-"), "node_modules", "@vertexcover")
    mkdirSync(scope, { recursive: true })
    const platform = `${process.platform}-${process.arch}`
    cpSync(join(out, "yok"), join(scope, "yok"), { recursive: true })
    cpSync(join(out, `yok-${platform}`), join(scope, `yok-${platform}`), { recursive: true })
    chmodSync(join(scope, `yok-${platform}`, "bin", "yok"), 0o755)
    return spawnSync("node", [join(scope, "yok", "bin", "yok.js"), "run", "--flag"], {
      encoding: "utf8",
      env: { ...process.env, YOK_EXIT: exit },
    })
  }

  test("runs this platform's binary with the same arguments", () => {
    const result = installed("0")
    assert.equal(result.stdout, `${process.platform}-${process.arch} run --flag\n`)
    assert.equal(result.status, 0)
  })

  test("exits with the binary's exit code", () => {
    assert.equal(installed("3").status, 3)
  })

  test("names the missing package when npm skipped this platform's binary", () => {
    const out = temp("yok-npm-")
    writeNpmPackages(fakeDist(), "1.2.3", out)
    const result = spawnSync("node", [join(out, "yok", "bin", "yok.js")], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`@vertexcover/yok-${process.platform}-${process.arch}`))
  })
})
