import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { agreedVersion, nextVersion, readVersion, setRef, setVersion } from "./version.ts"

describe("SC123: nextVersion", () => {
  test("bumps, takes an explicit version, and counts pre-releases", () => {
    const cases: readonly (readonly [string, string | undefined, boolean, string])[] = [
      ["1.2.3", "patch", false, "1.2.4"],
      ["1.2.3", "minor", false, "1.3.0"],
      ["1.2.3", "major", false, "2.0.0"],
      ["1.2.3", "2.0.0", false, "2.0.0"],
      ["1.2.3", "1.3.0-rc.1", false, "1.3.0-rc.1"],
      ["1.2.3", "1.3.0+build.5", false, "1.3.0+build.5"],
      ["1.2.3", "1.3.0-rc.1+build.5", false, "1.3.0-rc.1+build.5"],
      ["1.31.1", "patch", true, "1.31.2-rc.1"],
      ["1.31.1", "minor", true, "1.32.0-rc.1"],
      ["1.31.1", "major", true, "2.0.0-rc.1"],
      ["1.32.0-rc.1", undefined, true, "1.32.0-rc.2"],
      ["1.32.0-rc.9", undefined, true, "1.32.0-rc.10"],
      ["1.32.0-rc.2", "minor", true, "1.32.0-rc.3"],
      ["1.32.0-rc.2", "major", true, "2.0.0-rc.1"],
      ["1.32.0-rc.2", "minor", false, "1.32.0"],
      ["1.32.0-rc.2", "patch", false, "1.32.0"],
      ["1.32.0-rc.2", "major", false, "2.0.0"],
      ["2.0.0-rc.1", "major", false, "2.0.0"],
      ["1.31.2-rc.1", "patch", false, "1.31.2"],
    ]
    cases.forEach(([current, bump, preRelease, expected]) =>
      assert.equal(nextVersion(current, bump, { preRelease }), expected, `${current} ${bump} pre=${preRelease}`),
    )
  })

  test("rejects a bad bump, a bad current version, or a contradictory request", () => {
    const cases: readonly (readonly [string, string | undefined, boolean, RegExp | ErrorConstructor])[] = [
      ["1.2.3", "sideways", false, Error],
      ["nightly", "patch", false, Error],
      ["1.2.3", '1.3.0-"rc"', false, Error],
      ["1.2.3", "1.3.0-rc\\", false, Error],
      ["1.2.3", "1.3.0-rc 1", false, Error],
      ["1.31.1", undefined, true, /major, minor or patch/],
      ["1.31.1", undefined, false, /usage/],
      ["1.31.1", "1.32.0", true, /either/],
    ]
    cases.forEach(([current, bump, preRelease, message]) =>
      assert.throws(() => nextVersion(current, bump, { preRelease }), message, `${current} ${bump} pre=${preRelease}`),
    )
  })
})

describe("SC123: agreedVersion", () => {
  test("returns the version the manifests that declare one share, or 0.0.0 when none does", () => {
    assert.equal(agreedVersion(['{"version": "1.30.0"}', '{"version": "1.30.0"}']), "1.30.0")
    assert.equal(agreedVersion(['{"version": "1.30.0"}', '{"name": "yok"}']), "1.30.0")
    assert.equal(agreedVersion(['{"name": "yok"}']), "0.0.0")
  })

  test("refuses to bump manifests that have already drifted", () => {
    assert.throws(
      () => agreedVersion(['{"version": "1.30.0"}', '{"version": "1.31.0"}']),
      /drifted/,
    )
  })
})

describe("SC123: setVersion", () => {
  test("rewrites an existing version and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "yok",\n  "version": "1.30.0",\n  "private": true\n}\n'
    assert.equal(
      setVersion(source, "1.31.0"),
      '{\n  "name": "yok",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("inserts a version after the name when the manifest has none", () => {
    const source = '{\n  "name": "yok",\n  "private": true\n}\n'
    assert.equal(
      setVersion(source, "1.31.0"),
      '{\n  "name": "yok",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("rejects a manifest with neither field", () => {
    assert.throws(() => setVersion('{\n  "private": true\n}\n', "1.31.0"))
  })
})

describe("SC123: setRef", () => {
  test("repins the marketplace to the new tag and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "main",\n  "source": {\n    "repo": "a/b",\n    "ref": "v1.31.1"\n  }\n}\n'
    assert.equal(
      setRef(source, "v1.32.0-rc.1"),
      '{\n  "name": "main",\n  "source": {\n    "repo": "a/b",\n    "ref": "v1.32.0-rc.1"\n  }\n}\n',
    )
  })

  test("rejects a marketplace that pins nothing", () => {
    assert.throws(() => setRef('{\n  "source": "./"\n}\n', "v1.32.0"), /ref/)
  })
})

const repoDir = fileURLToPath(new URL("..", import.meta.url))

const PACKAGE_MANIFESTS = readdirSync(join(repoDir, "packages"))
  .map((name) => `packages/${name}/package.json`)
  .filter((manifest) => existsSync(join(repoDir, manifest)))

const MANIFESTS = ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ...PACKAGE_MANIFESTS]
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]
const RELEASE_FILES = ["scripts/version.ts", "scripts/check-release-tag.sh", "bun.lock", ...MANIFESTS, ...MARKETPLACES]

const copyReleaseFiles = (extra: Readonly<Record<string, string>> = {}): string => {
  const copy = mkdtempSync(join(tmpdir(), "release-"))
  RELEASE_FILES.forEach((file) => {
    mkdirSync(dirname(join(copy, file)), { recursive: true })
    cpSync(join(repoDir, file), join(copy, file))
  })
  Object.entries(extra).forEach(([file, text]) => {
    mkdirSync(dirname(join(copy, file)), { recursive: true })
    writeFileSync(join(copy, file), text)
  })
  return copy
}

const releaseScript = (copy: string, ...args: string[]): void => {
  execFileSync(process.execPath, [join(copy, "scripts/version.ts"), ...args], { cwd: copy, stdio: "pipe" })
}

const releaseInCopy = (
  version: string,
  extra: Readonly<Record<string, string>> = {},
): { readonly copy: string; readonly read: (file: string) => string } => {
  const copy = copyReleaseFiles(extra)
  releaseScript(copy, version, "--no-git")
  return { copy, read: (file) => readFileSync(join(copy, file), "utf8") }
}

const checkTag = (copy: string, tag: string): { readonly code: number; readonly stderr: string } => {
  const result = spawnSync("bash", [join(copy, "scripts/check-release-tag.sh"), tag], { encoding: "utf8" })
  return { code: result.status ?? 1, stderr: result.stderr }
}

// The checkout's own version, so these tests keep passing after each real release bumps it.
const CURRENT_VERSION = readVersion(readFileSync(join(repoDir, "package.json"), "utf8")) ?? "0.0.0"

const EXTRA_PACKAGE = {
  "packages/extra/package.json": `{\n  "name": "@yok/extra",\n  "version": "${CURRENT_VERSION}"\n}\n`,
}

// A release cut on the wrong runtime once silently did nothing. process.execPath is the runtime
// running this suite, so test:scripts proves the script under Node and test:scripts:bun under Bun.
describe("the release script, run as a command", () => {
  test("SC120: a stable release writes its version to every manifest, a new package included, and pins both marketplaces", () => {
    const { copy, read } = releaseInCopy("99.99.99", EXTRA_PACKAGE)
    ;[...MANIFESTS, "packages/extra/package.json"].forEach((manifest) =>
      assert.match(read(manifest), /"version": "99\.99\.99"/, manifest),
    )
    assert.ok(PACKAGE_MANIFESTS.includes("packages/sdk/package.json"))
    assert.ok(PACKAGE_MANIFESTS.includes("packages/server/package.json"))
    MARKETPLACES.forEach((marketplace) => assert.match(read(marketplace), /"ref": "v99\.99\.99"/, marketplace))
    assert.equal(checkTag(copy, "v99.99.99").code, 0)
  })

  test("SC121: a pre-release pins both marketplaces to its own rc tag, the stable Claude one included", () => {
    const { copy, read } = releaseInCopy("99.99.99-rc.1")
    MARKETPLACES.forEach((marketplace) => assert.match(read(marketplace), /"ref": "v99\.99\.99-rc\.1"/, marketplace))
    assert.equal(checkTag(copy, "v99.99.99-rc.1").code, 0)
  })

  test("SC149: a release writes its version into bun.lock's workspace packages and commits the lock", () => {
    const copy = copyReleaseFiles()
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: copy, encoding: "utf8" })
    git("init", "-q", "-b", "main")
    // Stored in the repo, so the release script's own commit has an author on a CI machine with no git identity.
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    git("add", ".")
    git("commit", "-qm", "init")
    const rootEntry = (lock: string): string => lock.slice(lock.indexOf('"": {'), lock.indexOf('"packages/'))
    const rootBefore = rootEntry(readFileSync(join(copy, "bun.lock"), "utf8"))

    releaseScript(copy, "patch")

    const lock = readFileSync(join(copy, "bun.lock"), "utf8")
    const versions = [...lock.matchAll(/"packages\/[^"]+": \{\n\s+"name": "[^"]+",\n\s+"version": "([^"]*)"/g)]
    assert.equal(versions.length, PACKAGE_MANIFESTS.length)
    versions.forEach(([, version]) => assert.equal(version, nextVersion(CURRENT_VERSION, "patch")))
    assert.equal(rootEntry(lock), rootBefore)
    assert.match(git("show", "--name-only", "--format=", "HEAD"), /^bun\.lock$/m)
    execFileSync("bun", ["install"], { cwd: copy, stdio: "pipe" })
    assert.equal(readFileSync(join(copy, "bun.lock"), "utf8"), lock)
  })
})

describe("check-release-tag.sh", () => {
  test("SC122: names every manifest and marketplace that disagrees with the tag", () => {
    const { code, stderr } = checkTag(copyReleaseFiles(), "v99.99.99")
    assert.equal(code, 1)
    ;[...MANIFESTS, ...MARKETPLACES].forEach((file) =>
      assert.match(stderr, new RegExp(`^${file.replaceAll(".", "\\.")} `, "m"), file),
    )
  })

  test("SC123: refuses to run without a tag", () => {
    assert.notEqual(checkTag(copyReleaseFiles(), "").code, 0)
  })
})
