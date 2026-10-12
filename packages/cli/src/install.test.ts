import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetName,
  checksumFor,
  githubToken,
  installedBy,
  managedUpdate,
  pickRelease,
  removeInstall,
  runUpdate,
} from "./install.ts";

const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const release = (tag: string, assets: readonly string[], extra: Record<string, boolean> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: assets.map((name) => ({ name, url: `https://api.example/assets/${name}` })),
  ...extra,
});

const ALL = ["yok-darwin-arm64", "yok-darwin-x64", "yok-linux-x64", "yok-linux-arm64"];

describe("release lookup", () => {
  test("SC134: picks the newest non-draft release carrying the asset, pre-releases only when asked", () => {
    const releases = [
      release("v0.0.4", ALL, { draft: true }),
      release("v0.0.3-rc.1", ALL, { prerelease: true }),
      release(
        "v0.0.2",
        ALL.filter((name) => name !== "yok-linux-arm64"),
      ),
      release("v0.0.1", ALL),
    ];
    expect(pickRelease(releases, "yok-darwin-arm64", false)).toBe("v0.0.2");
    expect(pickRelease(releases, "yok-linux-arm64", false)).toBe("v0.0.1");
    expect(pickRelease(releases, "yok-darwin-arm64", true)).toBe("v0.0.3-rc.1");
    expect(pickRelease(releases, "yok-sunos-sparc", true)).toBeNull();
  });

  test("SC135: finds yok-linux-x64's hash by whole name, not yok-linux-x64-baseline's", () => {
    const text = "aaa  yok-linux-x64-baseline\nbbb  yok-linux-x64\n";
    expect(checksumFor(text, "yok-linux-x64")).toBe("bbb");
    expect(checksumFor(text, "yok-darwin-arm64")).toBeNull();
  });

  test("SC136: names the four builds and throws for win32-x64", () => {
    const pairs = [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ] as const;
    expect(pairs.map(([os, cpu]) => assetName(os, cpu))).toEqual([
      "yok-darwin-arm64",
      "yok-darwin-x64",
      "yok-linux-arm64",
      "yok-linux-x64",
    ]);
    expect(() => assetName("win32", "x64")).toThrow("no yok build for win32-x64");
  });
});

const ASSET = assetName(process.platform, process.arch);

// A stand-in yok: logs "VERSION ARGS" and exits with `code`.
const fakeYok = (version: string, log: string, code = 0): string =>
  `#!/bin/sh\necho "${version} $*" >> "${log}"\nexit ${code}\n`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

type Published = Readonly<{ tag: string; script: string; checksum?: string }>;

const TOKEN = "t0k";

// A private repo's API: the release list and each asset answer 404 without the token, and an
// asset redirects to storage that must not receive it, as GitHub's does.
const serveReleases = (published: Published) => {
  const stored: Record<string, string> = {
    [`/storage/${ASSET}`]: published.script,
    "/storage/checksums.txt": `${published.checksum ?? sha256(published.script)}  ${ASSET}\n`,
  };
  const tokensAtStorage: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { origin, pathname: path } = new URL(request.url);
      if (path.startsWith("/storage/")) {
        tokensAtStorage.push(request.headers.get("authorization"));
        const body = stored[path];
        return body === undefined ? new Response("", { status: 404 }) : new Response(body);
      }
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return new Response("", { status: 404 });
      }
      if (path === "/releases") {
        const assets = [ASSET, "checksums.txt"].map((name) => ({
          name,
          url: `${origin}/assets/${name}`,
        }));
        return Response.json([{ ...release(published.tag, []), assets }]);
      }
      const name = path.replace("/assets/", "");
      if (request.headers.get("accept") !== "application/octet-stream") {
        return Response.json({ name });
      }
      return Response.redirect(`${origin}/storage/${name}`, 302);
    },
  });
  servers.push(server);
  return { target: { releasesUrl: `${server.url}releases`, token: TOKEN }, tokensAtStorage };
};

const installed = (log: string) => {
  const execPath = join(temp("yok-update-"), "yok");
  writeFileSync(execPath, fakeYok("0.0.1", log));
  chmodSync(execPath, 0o755);
  return execPath;
};

const logLines = (log: string): readonly string[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];

describe("runUpdate", () => {
  test("SC146: swaps in v0.0.2 and returns the exit code of its plugin install, with the binary ready even when that install fails", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const script = fakeYok("0.0.2", log, 3);
    const { target, tokensAtStorage } = serveReleases({ tag: "v0.0.2", script });

    const { code, binaryReady } = await runUpdate(
      { ...target, execPath, version: "0.0.1" },
      ["claude"],
      false,
    );

    expect(readFileSync(execPath, "utf8")).toBe(script);
    expect(tokensAtStorage).toEqual([null, null]);
    expect(existsSync(`${execPath}.new`)).toBe(false);
    expect(logLines(log)).toEqual(["0.0.2 plugin install --agent claude"]);
    expect(code).toBe(3);
    expect(binaryReady).toBe(true);
  });

  test("SC147: keeps the 0.0.1 binary and runs no plugin install when the checksum is wrong", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const { target } = serveReleases({
      tag: "v0.0.2",
      script: fakeYok("0.0.2", log),
      checksum: "0".repeat(64),
    });
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    const { code, binaryReady } = await runUpdate(
      { ...target, execPath, version: "0.0.1" },
      ["claude"],
      false,
    );

    const printed = errors.mock.calls.flat();
    errors.mockRestore();
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(existsSync(`${execPath}.new`)).toBe(false);
    expect(printed).toContain(`checksum mismatch for ${ASSET}; the installed yok is unchanged`);
    expect(code).toBe(1);
    expect(binaryReady).toBe(false);
    expect(logLines(log)).toEqual([]);
  });

  test("SC148: on the newest release keeps the binary and still runs its plugin install", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const { target } = serveReleases({ tag: "v0.0.1", script: before });
    const lines = spyOn(console, "log").mockImplementation(() => undefined);

    const { code, binaryReady } = await runUpdate(
      { ...target, execPath, version: "0.0.1" },
      ["claude"],
      false,
    );

    const printed = lines.mock.calls.flat();
    lines.mockRestore();
    expect(code).toBe(0);
    expect(binaryReady).toBe(true);
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(printed).toContain("yok 0.0.1 is up to date: the newest release is v0.0.1");
    expect(logLines(log)).toEqual(["0.0.1 plugin install --agent claude"]);
  });

  test("on a pre-release newer than the newest stable release keeps the binary", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const { target } = serveReleases({ tag: "v0.0.1", script: fakeYok("0.0.1-old", log) });
    const lines = spyOn(console, "log").mockImplementation(() => undefined);

    const { code, binaryReady } = await runUpdate(
      { ...target, execPath, version: "0.0.2-rc.1" },
      ["claude"],
      false,
    );

    const printed = lines.mock.calls.flat();
    lines.mockRestore();
    expect(code).toBe(0);
    expect(binaryReady).toBe(true);
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(printed).toContain("yok 0.0.2-rc.1 is up to date: the newest release is v0.0.1");
  });

  test("without a token, a private repo's 404 says how to get access and leaves the binary", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const { target } = serveReleases({ tag: "v0.0.2", script: fakeYok("0.0.2", log) });
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    const { code, binaryReady } = await runUpdate(
      { ...target, token: null, execPath, version: "0.0.1" },
      ["claude"],
      false,
    );

    const printed = errors.mock.calls.flat().join("\n");
    errors.mockRestore();
    expect(code).toBe(1);
    expect(binaryReady).toBe(false);
    expect(printed).toContain("could not list releases: HTTP 404");
    expect(printed).toContain("gh auth login");
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(logLines(log)).toEqual([]);
  });
});

const INSTALL_SH = join(import.meta.dir, "..", "..", "..", "install.sh");

describe("removeInstall", () => {
  test("deletes the yok home with its binary and the PATH line install.sh added, keeping the rest of the rc file", async () => {
    const root = temp("yok-uninstall-");
    const home = join(root, ".yok");
    mkdirSync(join(home, "bin"), { recursive: true });
    const execPath = join(home, "bin", "yok");
    writeFileSync(execPath, "binary");
    writeFileSync(join(home, "registry.json"), "{}");
    const pathLine = /^\s*line='(.*)'$/m.exec(readFileSync(INSTALL_SH, "utf8"))?.[1];
    const rc = join(root, ".zshrc");
    writeFileSync(rc, `alias ll='ls -l'\n\n${pathLine}\nexport EDITOR=vim\n`);
    const missing = join(root, ".bashrc");

    const done = await removeInstall({ execPath, installDir: home, rcFiles: [rc, missing] });

    expect(pathLine).toContain(".yok/bin");
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(rc, "utf8")).toBe("alias ll='ls -l'\nexport EDITOR=vim\n");
    expect(existsSync(missing)).toBe(false);
    expect(done).toEqual([`removed ${home}`, `removed the yok PATH line from ${rc}`]);
  });

  test("deletes a binary installed outside the yok home as well", async () => {
    const root = temp("yok-uninstall-");
    const home = join(root, ".yok");
    mkdirSync(home);
    const execPath = join(root, "yok");
    writeFileSync(execPath, "binary");

    const done = await removeInstall({ execPath, installDir: home, rcFiles: [] });

    expect(existsSync(execPath)).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(done).toEqual([`removed ${execPath}`, `removed ${home}`]);
  });
});

describe("installedBy", () => {
  test("names Homebrew or npm when one of them put the binary in place, else nothing", () => {
    expect(installedBy("/opt/homebrew/Cellar/yok/1.2.3/bin/yok")).toBe("homebrew");
    expect(installedBy("/home/linuxbrew/.linuxbrew/Cellar/yok/1.2.3/bin/yok")).toBe("homebrew");
    expect(
      installedBy("/usr/local/lib/node_modules/@vertexcover-io/yok-darwin-arm64/bin/yok"),
    ).toBe("npm");
    expect(installedBy("/Users/me/.yok/bin/yok")).toBeNull();
  });
});

describe("managedUpdate", () => {
  test("upgrades Homebrew's formula and runs the binary its opt link points at", () => {
    expect(managedUpdate("homebrew", "/opt/homebrew/Cellar/yok/1.2.3/bin/yok", false)).toEqual({
      ok: true,
      value: { upgrade: ["brew", "upgrade", "yok"], binary: "/opt/homebrew/opt/yok/bin/yok" },
    });
  });

  test("installs npm's latest, or next for a pre-release, into the same path", () => {
    const binary = "/usr/local/lib/node_modules/@vertexcover-io/yok-darwin-arm64/bin/yok";
    expect(managedUpdate("npm", binary, false)).toEqual({
      ok: true,
      value: { upgrade: ["npm", "install", "-g", "@vertexcover-io/yok@latest"], binary },
    });
    expect(managedUpdate("npm", binary, true)).toEqual({
      ok: true,
      value: { upgrade: ["npm", "install", "-g", "@vertexcover-io/yok@next"], binary },
    });
  });

  test("refuses a pre-release from Homebrew, which ships stable releases only", () => {
    const update = managedUpdate("homebrew", "/opt/homebrew/Cellar/yok/1.2.3/bin/yok", true);
    expect(update.ok).toBe(false);
    expect(!update.ok && update.error).toContain("stable releases only");
  });
});

describe("githubToken", () => {
  test("takes GH_TOKEN, then GITHUB_TOKEN, then what gh prints, else none", () => {
    const gh = (printed: string | null) => () => printed;
    expect(githubToken({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, gh("c"))).toBe("a");
    expect(githubToken({ GITHUB_TOKEN: "b" }, gh("c"))).toBe("b");
    expect(githubToken({}, gh("c\n"))).toBe("c");
    expect(githubToken({ GH_TOKEN: "" }, gh(null))).toBeNull();
  });
});

const CLI = join(import.meta.dir, "index.ts");

// The CLI from source, with a fake claude first on PATH that logs every call.
const fromSource = (args: readonly string[]) => {
  const bin = temp("yok-fake-bin-");
  const log = join(bin, "claude.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const { YOK_CLAUDE_BIN: _claude, YOK_CODEX_BIN: _codex, ...env } = process.env;
  const result = spawnSync("bun", ["--no-env-file", CLI, ...args], {
    encoding: "utf8",
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, YOK_HOME: temp("yok-home-") },
  });
  return { code: result.status, output: result.stdout + result.stderr, calls: logLines(log) };
};

describe("the plugin, update and uninstall commands from source", () => {
  test("SC137: yok-dev refuses plugin install, update and uninstall, points at the checkout and runs no claude", () => {
    const install = fromSource(["plugin", "install", "--agent", "claude"]);
    expect(install.code).toBe(1);
    expect(install.output).toContain("claude --plugin-dir");
    expect(install.calls).toEqual([]);

    const update = fromSource(["update", "--agent", "claude"]);
    expect(update.code).toBe(1);
    expect(update.output).toContain("git pull");
    expect(update.calls).toEqual([]);

    const uninstall = fromSource(["uninstall", "--plugin"]);
    expect(uninstall.code).toBe(1);
    expect(uninstall.output).toContain("nothing to uninstall");
    expect(uninstall.calls).toEqual([]);
  }, 30_000);

  test("SC150: --agent foo is refused by plugin install and by update, before any agent runs", () => {
    for (const command of [["plugin", "install"], ["update"]]) {
      const result = fromSource([...command, "--agent", "foo"]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("expected claude or codex, got foo");
      expect(result.calls).toEqual([]);
    }
  }, 30_000);
});
