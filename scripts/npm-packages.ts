import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Lays out the npm packages for a release, from the binaries the release job built:
 * one package per platform holding its binary, and @vertexcover/yok, whose launcher runs the
 * one npm installed. npm skips the platform packages whose os and cpu do not match.
 *   node scripts/npm-packages.ts DIST_DIR VERSION OUT_DIR
 */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const

const SCOPE = "@vertexcover"
const LAUNCHER = fileURLToPath(new URL("npm-launcher.cjs", import.meta.url))

const common = {
  license: "UNLICENSED",
  homepage: "https://github.com/vertexcover-io/yok",
  repository: { type: "git", url: "git+https://github.com/vertexcover-io/yok.git" },
}

const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

const writePlatform = (dist: string, version: string, out: string, platform: string): void => {
  const [os, cpu] = platform.split("-")
  const dir = join(out, `yok-${platform}`)
  mkdirSync(join(dir, "bin"), { recursive: true })
  copyFileSync(join(dist, `yok-${platform}`), join(dir, "bin", "yok"))
  chmodSync(join(dir, "bin", "yok"), 0o755)
  writeJson(join(dir, "package.json"), {
    name: `${SCOPE}/yok-${platform}`,
    version,
    description: `The yok binary for ${platform}`,
    ...common,
    os: [os],
    cpu: [cpu],
    files: ["bin"],
  })
}

const writeLauncher = (version: string, out: string): void => {
  const dir = join(out, "yok")
  mkdirSync(join(dir, "bin"), { recursive: true })
  copyFileSync(LAUNCHER, join(dir, "bin", "yok.js"))
  chmodSync(join(dir, "bin", "yok.js"), 0o755)
  writeJson(join(dir, "package.json"), {
    name: `${SCOPE}/yok`,
    version,
    description: "Run coding agents through a workflow, from ticket to PR",
    ...common,
    bin: { yok: "bin/yok.js" },
    files: ["bin"],
    optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [`${SCOPE}/yok-${p}`, version])),
  })
}

export const writeNpmPackages = (dist: string, version: string, out: string): void => {
  const missing = PLATFORMS.map((p) => `yok-${p}`).filter((name) => !existsSync(join(dist, name)))
  if (missing.length > 0) throw new Error(`${dist} has no ${missing.join(", ")}`)
  for (const platform of PLATFORMS) writePlatform(dist, version, out, platform)
  writeLauncher(version, out)
}

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  const [dist, version, out] = process.argv.slice(2)
  if (dist === undefined || version === undefined || out === undefined) {
    console.error("usage: node scripts/npm-packages.ts DIST_DIR VERSION OUT_DIR")
    process.exit(2)
  }
  writeNpmPackages(dist, version, out)
  console.log(`wrote ${PLATFORMS.length + 1} packages to ${out}`)
}
