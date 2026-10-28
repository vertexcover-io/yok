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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assetName,
  checksumFor,
  githubToken,
  installedBy,
  managedUpdate,
  pickRelease,
  removeInstall,
  runUpdate,
  updateYok,
} from "./install.ts";
import { installAll, installPlugins, updateAgents } from "./plugin.ts";

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

  test("SC148: writes the yok-remote shortcut beside the swapped binary, as install.sh does, and leaves none on a wrong checksum", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const shortcut = join(dirname(execPath), "yok-remote");
    const { target } = serveReleases({ tag: "v0.0.2", script: fakeYok("0.0.2", log) });

    await runUpdate({ ...target, execPath, version: "0.0.1" }, ["claude"], false);

    expect(readFileSync(shortcut, "utf8")).toBe(
      '#!/bin/sh\nexec "$(dirname "$0")/yok" --remote "$@"\n',
    );
    expect(statSync(shortcut).mode & 0o777).toBe(0o755);

    const stale = installed(log);
    const { target: bad } = serveReleases({
      tag: "v0.0.2",
      script: fakeYok("0.0.2", log),
      checksum: "0".repeat(64),
    });
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    await runUpdate({ ...bad, execPath: stale, version: "0.0.1" }, ["claude"], false);
    errors.mockRestore();
    expect(existsSync(join(dirname(stale), "yok-remote"))).toBe(false);
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

  test("SC643: hands the named agents to the new binary's plugin install, and no --agent when none was named", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const { target } = serveReleases({ tag: "v0.0.2", script: fakeYok("0.0.2", log) });
    const lines = spyOn(console, "log").mockImplementation(() => undefined);

    const named = await runUpdate(
      { ...target, execPath, version: "0.0.1" },
      ["claude", "codex"],
      false,
    );
    const bare = await runUpdate({ ...target, execPath, version: "0.0.1" }, undefined, false);

    lines.mockRestore();
    expect(named.code).toBe(0);
    expect(bare.code).toBe(0);
    expect(logLines(log)).toEqual([
      "0.0.2 plugin install --agent claude --agent codex",
      "0.0.2 plugin install",
    ]);
  });
});

// A directory holding an executable stub for each of `names`.
const binDir = (names: readonly string[]): string => {
  const dir = temp("yok-path-");
  for (const name of names) {
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
};

describe("updateAgents", () => {
  test.each([
    ["only claude", () => ({ PATH: binDir(["claude"]) }), ["claude"]],
    ["only codex", () => ({ PATH: binDir(["codex"]) }), ["codex"]],
    ["both", () => ({ PATH: binDir(["claude", "codex"]) }), ["claude", "codex"]],
    [
      "nothing, with YOK_CLAUDE_BIN naming an executable",
      () => ({ PATH: binDir([]), YOK_CLAUDE_BIN: join(binDir(["my-claude"]), "my-claude") }),
      ["claude"],
    ],
  ] as const)(
    "SC640: without --agent, PATH holding %s targets those agents",
    (_label, env, expected) => {
      expect(updateAgents(undefined, env())).toEqual({ ok: true, value: expected });
    },
  );

  test("SC641: with --agent, targets exactly the named agents whatever is on PATH", () => {
    expect(updateAgents(["codex"], { PATH: binDir(["claude"]) })).toEqual({
      ok: true,
      value: ["codex"],
    });
  });

  test("SC642: with no agent on PATH and no --agent, refuses and names --agent", () => {
    const result = updateAgents(undefined, { PATH: binDir([]) });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("--agent");
  });
});

describe("updateYok", () => {
  test("without --agent and with only claude on PATH, the new binary's plugin install gets no --agent and picks the agents itself", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const { target } = serveReleases({ tag: "v0.0.2", script: fakeYok("0.0.2", log) });
    const lines = spyOn(console, "log").mockImplementation(() => undefined);

    const { code, binaryReady } = await updateYok(
      {
        agent: undefined,
        preRelease: false,
        env: { PATH: binDir(["claude"]), GH_TOKEN: TOKEN },
        target: { releasesUrl: target.releasesUrl, execPath, version: "0.0.1" },
      },
      true,
    );

    lines.mockRestore();
    expect(code).toBe(0);
    expect(binaryReady).toBe(true);
    expect(logLines(log)).toEqual(["0.0.2 plugin install"]);
  });

  test("a Homebrew install with neither gh on PATH nor a token runs brew upgrade, then the upgraded binary's plugin install", async () => {
    const log = join(temp("yok-log-"), "log");
    const prefix = temp("yok-brew-");
    const execPath = join(prefix, "Cellar/yok/0.0.1/bin/yok");
    const upgraded = join(prefix, "opt/yok/bin/yok");
    for (const [path, script] of [
      [execPath, fakeYok("0.0.1", log)],
      [upgraded, fakeYok("0.0.2", log)],
      [join(prefix, "bin/brew"), `#!/bin/sh\necho "brew $*" >> "${log}"\n`],
    ] as const) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, script);
      chmodSync(path, 0o755);
    }
    const saved = { ...process.env };
    process.env.PATH = join(prefix, "bin");

    // Nothing listens on port 1, so a release download would fail instead of reaching brew.
    const { code, binaryReady } = await updateYok(
      {
        agent: undefined,
        preRelease: false,
        env: { PATH: binDir(["claude"]) },
        target: { releasesUrl: "http://127.0.0.1:1/releases", execPath, version: "0.0.1" },
      },
      true,
    ).finally(() => {
      process.env = saved;
    });

    expect(code).toBe(0);
    expect(binaryReady).toBe(true);
    expect(logLines(log)).toEqual(["brew upgrade yok", "0.0.2 plugin install"]);
  });

  test("without --agent and with an empty PATH, exits 1 naming --agent and downloads nothing", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    // Nothing listens on port 1, so any fetch would throw instead of returning.
    const { code, binaryReady } = await updateYok(
      {
        agent: undefined,
        preRelease: false,
        env: { PATH: binDir([]) },
        target: {
          releasesUrl: "http://127.0.0.1:1/releases",
          execPath,
          version: "0.0.1",
        },
      },
      true,
    );

    const printed = errors.mock.calls.flat().join("\n");
    errors.mockRestore();
    expect(code).toBe(1);
    expect(binaryReady).toBe(false);
    expect(printed).toContain("--agent");
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(logLines(log)).toEqual([]);
  });
});

describe("installAll", () => {
  test("with claude's plugin install failing, still tries codex, prints both failures and the --agent hint, and returns 1", async () => {
    const dir = temp("yok-agents-");
    const log = join(dir, "log");
    for (const name of ["claude", "codex"]) {
      writeFileSync(
        join(dir, name),
        `#!/bin/sh\necho "${name} $*" >> "${log}"\necho broken >&2\nexit 1\n`,
      );
      chmodSync(join(dir, name), 0o755);
    }
    const env = { YOK_CLAUDE_BIN: join(dir, "claude"), YOK_CODEX_BIN: join(dir, "codex") };
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    const code = await installAll(["claude", "codex"], env);

    const printed = errors.mock.calls.flat().join("\n");
    errors.mockRestore();
    expect(code).toBe(1);
    expect(logLines(log)).toEqual(["claude plugin list --json", "codex plugin list --json"]);
    expect(printed).toContain(`${env.YOK_CLAUDE_BIN} plugin list --json failed: broken`);
    expect(printed).toContain(`${env.YOK_CODEX_BIN} plugin list --json failed: broken`);
    expect(printed).toContain("limit it with --agent NAME");
  });

  test("with claude printing a plugin list it cannot parse, still installs for codex and returns 1", async () => {
    const dir = temp("yok-agents-");
    const log = join(dir, "log");
    writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "claude $*" >> "${log}"\necho not-json\n`);
    writeFileSync(
      join(dir, "codex"),
      [
        "#!/bin/sh",
        `echo "codex $*" >> "${log}"`,
        `[ "$*" = "plugin list --json" ] && echo '{"installed":[]}'`,
        `[ "$*" = "plugin marketplace list --json" ] && echo '{"marketplaces":[]}'`,
        "exit 0",
      ].join("\n"),
    );
    for (const name of ["claude", "codex"]) chmodSync(join(dir, name), 0o755);
    const env = { YOK_CLAUDE_BIN: join(dir, "claude"), YOK_CODEX_BIN: join(dir, "codex") };
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const logs = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const code = await installAll(["claude", "codex"], env);

      expect(code).toBe(1);
      expect(logLines(log)).toContain("codex plugin add yok --marketplace yok");
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });
});

// A codex stub whose plugin list and marketplace list answers parse, logging every call.
const codexStub = (log: string): string =>
  [
    "#!/bin/sh",
    `echo "codex $*" >> "${log}"`,
    `[ "$*" = "plugin list --json" ] && echo '{"installed":[]}'`,
    `[ "$*" = "plugin marketplace list --json" ] && echo '{"marketplaces":[]}'`,
    "exit 0",
  ].join("\n");

describe("installPlugins", () => {
  test("without --agent and with only codex on PATH, installs for codex alone", async () => {
    const dir = binDir([]);
    const log = join(dir, "log");
    writeFileSync(join(dir, "codex"), codexStub(log));
    chmodSync(join(dir, "codex"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = dir;
    const logs = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const code = await installPlugins(undefined, { PATH: dir });

      expect(code).toBe(0);
      expect(logLines(log)).toContain("codex plugin add yok --marketplace yok");
      expect(logLines(log).every((line) => line.startsWith("codex "))).toBe(true);
    } finally {
      process.env.PATH = saved;
      logs.mockRestore();
    }
  });

  test("without --agent, YOK_CODEX_BIN naming a binary outside PATH is installed for", async () => {
    const dir = binDir([]);
    const log = join(dir, "log");
    writeFileSync(join(dir, "my-codex"), codexStub(log));
    chmodSync(join(dir, "my-codex"), 0o755);
    const logs = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const code = await installPlugins(undefined, {
        PATH: binDir([]),
        YOK_CODEX_BIN: join(dir, "my-codex"),
      });

      expect(code).toBe(0);
      expect(logLines(log)).toContain("codex plugin add yok --marketplace yok");
    } finally {
      logs.mockRestore();
    }
  });

  test("without --agent and with no agent found, exits 0 with a hint and runs nothing", async () => {
    const logs = spyOn(console, "log").mockImplementation(() => undefined);
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const code = await installPlugins(undefined, { PATH: binDir([]) });

      expect(code).toBe(0);
      expect(errors).not.toHaveBeenCalled();
      expect(logs.mock.calls.flat().join("\n")).toContain("yok plugin install");
    } finally {
      logs.mockRestore();
      errors.mockRestore();
    }
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

  test.each([
    ["inside the yok home", (root: string) => join(root, ".yok", "bin"), false],
    ["in a folder outside the yok home", (root: string) => join(root, "bin"), true],
  ] as const)(
    "SC4017: with yok and yok-remote %s, both are gone along with the yok home",
    async (_layout, binDir, listed) => {
      const root = temp("yok-uninstall-");
      const home = join(root, ".yok");
      mkdirSync(home);
      mkdirSync(binDir(root), { recursive: true });
      const execPath = join(binDir(root), "yok");
      const shortcut = join(binDir(root), "yok-remote");
      writeFileSync(execPath, "binary");
      writeFileSync(shortcut, "shortcut");

      const done = await removeInstall({ execPath, installDir: home, rcFiles: [] });

      expect(existsSync(execPath)).toBe(false);
      expect(existsSync(shortcut)).toBe(false);
      expect(existsSync(home)).toBe(false);
      expect(done).toEqual([
        ...(listed ? [`removed ${execPath}`, `removed ${shortcut}`] : []),
        `removed ${home}`,
      ]);
    },
  );
});

describe("installedBy", () => {
  test("names Homebrew or npm when one of them put the binary in place, else nothing", () => {
    expect(installedBy("/opt/homebrew/Cellar/yok/1.2.3/bin/yok")).toBe("homebrew");
    expect(installedBy("/home/linuxbrew/.linuxbrew/Cellar/yok/1.2.3/bin/yok")).toBe("homebrew");
    expect(installedBy("/usr/local/lib/node_modules/@vertexcover/yok-darwin-arm64/bin/yok")).toBe(
      "npm",
    );
    expect(installedBy("/Users/me/.yok/bin/yok")).toBeNull();
  });
});

describe("managedUpdate", () => {
  const brewed = "/opt/homebrew/Cellar/yok/1.2.3/bin/yok";
  const npmBinary = "/usr/local/lib/node_modules/@vertexcover/yok-darwin-arm64/bin/yok";

  test.each([
    [
      "Homebrew upgrades its formula and runs the binary its opt link points at",
      "homebrew",
      brewed,
      false,
      {
        ok: true,
        value: { upgrade: ["brew", "upgrade", "yok"], binary: "/opt/homebrew/opt/yok/bin/yok" },
      },
    ],
    [
      "npm installs latest into the same path",
      "npm",
      npmBinary,
      false,
      {
        ok: true,
        value: {
          upgrade: ["npm", "install", "-g", "@vertexcover/yok@latest"],
          binary: npmBinary,
        },
      },
    ],
    [
      "npm installs next for a pre-release into the same path",
      "npm",
      npmBinary,
      true,
      {
        ok: true,
        value: { upgrade: ["npm", "install", "-g", "@vertexcover/yok@next"], binary: npmBinary },
      },
    ],
    [
      "Homebrew refuses a pre-release, since it ships stable releases only",
      "homebrew",
      brewed,
      true,
      { ok: false, error: expect.stringContaining("stable releases only") },
    ],
  ] as const)("%s", (_label, manager, binary, prerelease, expected) => {
    expect(managedUpdate(manager, binary, prerelease)).toEqual(expected);
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

  test("SC644: update and plugin install both accept a bare call", () => {
    const update = fromSource(["update"]);
    expect(update.code).toBe(1);
    expect(update.output).toContain("git pull");
    expect(update.calls).toEqual([]);

    const install = fromSource(["plugin", "install"]);
    expect(install.code).toBe(1);
    expect(install.output).toContain("claude --plugin-dir");
    expect(install.calls).toEqual([]);
  }, 30_000);
});
