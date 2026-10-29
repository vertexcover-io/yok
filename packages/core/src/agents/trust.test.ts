import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, codexConfigPath, trustFolder, trustRoot } from "./trust.ts";

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "yok-trust-")));

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
};

const repo = (): string => {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("trustRoot", () => {
  test("a folder outside any repository is trusted as itself", async () => {
    const dir = tempDir();
    expect(await trustRoot(dir)).toBe(dir);
  });

  test("a folder inside a repository is trusted as the repository root", async () => {
    const root = repo();
    mkdirSync(join(root, "sub"));
    expect(await trustRoot(join(root, "sub"))).toBe(root);
  });

  test("a linked worktree is trusted as its main checkout", async () => {
    const root = repo();
    const worktree = join(tempDir(), "wt");
    git(root, "worktree", "add", "-q", worktree);
    expect(await trustRoot(worktree)).toBe(root);
  });

  test("a symlinked folder is trusted under its real path", async () => {
    const dir = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);
    expect(await trustRoot(link)).toBe(dir);
  });
});

describe("config paths", () => {
  test("CLAUDE_CONFIG_DIR and CODEX_HOME win over HOME", () => {
    const env = { HOME: "/h", CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" };
    expect(claudeConfigPath(env)).toBe("/c/.claude.json");
    expect(codexConfigPath(env)).toBe("/x/config.toml");
  });

  test("without them both files sit under HOME", () => {
    expect(claudeConfigPath({ HOME: "/h" })).toBe("/h/.claude.json");
    expect(codexConfigPath({ HOME: "/h" })).toBe("/h/.codex/config.toml");
  });
});

describe("trustFolder claude", () => {
  test("adds the folder to an existing config and keeps every other key", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    const before = {
      numStartups: 4,
      projects: { "/other": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } },
    };
    writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    const folder = tempDir();

    expect(await trustFolder("claude", folder, { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: "added",
    });

    expect(readJson(file)).toEqual({
      ...before,
      projects: { ...before.projects, [folder]: { hasTrustDialogAccepted: true } },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("keeps the folder's own keys when it was seen but never trusted", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    const folder = tempDir();
    writeFileSync(file, JSON.stringify({ projects: { [folder]: { allowedTools: ["Read"] } } }));

    await trustFolder("claude", folder, { CLAUDE_CONFIG_DIR: home });

    expect(readJson(file)).toEqual({
      projects: { [folder]: { allowedTools: ["Read"], hasTrustDialogAccepted: true } },
    });
  });

  test("creates the config under HOME when none exists", async () => {
    const home = tempDir();
    const folder = tempDir();

    await trustFolder("claude", folder, { HOME: home });

    expect(readJson(join(home, ".claude.json"))).toEqual({
      projects: { [folder]: { hasTrustDialogAccepted: true } },
    });
  });

  test("leaves the file byte for byte when the folder is already trusted", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    const folder = tempDir();
    const text = `{"projects":{${JSON.stringify(folder)}:{"hasTrustDialogAccepted":true}}}`;
    writeFileSync(file, text);

    expect(await trustFolder("claude", folder, { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: "present",
    });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("refuses a config that is not JSON and leaves it alone", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, "{oops");

    const result = await trustFolder("claude", tempDir(), { CLAUDE_CONFIG_DIR: home });

    expect(result.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });

  test("writes through a symlinked config instead of replacing the link", async () => {
    const home = tempDir();
    const real = join(tempDir(), "claude.json");
    writeFileSync(real, "{}");
    symlinkSync(real, join(home, ".claude.json"));
    const folder = tempDir();

    await trustFolder("claude", folder, { CLAUDE_CONFIG_DIR: home });

    expect(readJson(real)).toEqual({ projects: { [folder]: { hasTrustDialogAccepted: true } } });
  });

  test("runs started at once each keep their folder", async () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), "{}");
    const folders = Array.from({ length: 8 }, () => tempDir());

    await Promise.all(
      folders.map((folder) => trustFolder("claude", folder, { CLAUDE_CONFIG_DIR: home })),
    );

    const config = readJson(join(home, ".claude.json")) as { projects: object };
    expect(Object.keys(config.projects).sort()).toEqual([...folders].sort());
  });

  test("waits for Claude's own lock on the config", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, "{}");
    mkdirSync(`${file}.lock`);
    const folder = tempDir();

    const pending = trustFolder("claude", folder, { CLAUDE_CONFIG_DIR: home });
    await Bun.sleep(100);
    expect(readJson(file)).toEqual({});
    execFileSync("rmdir", [`${file}.lock`]);

    expect(await pending).toEqual({ ok: true, value: "added" });
  });

  test("takes over a lock its holder stopped refreshing", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, "{}");
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);

    expect(await trustFolder("claude", tempDir(), { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: "added",
    });
  });
});

describe("trustFolder codex", () => {
  test("appends a trusted project table and keeps the rest of the file as written", async () => {
    const home = tempDir();
    const file = join(home, "config.toml");
    const before = '# mine\nmodel = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"';
    writeFileSync(file, before);
    const folder = tempDir();

    expect(await trustFolder("codex", folder, { CODEX_HOME: home })).toEqual({
      ok: true,
      value: "added",
    });

    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(Bun.TOML.parse(after)).toEqual({
      model: "gpt-5",
      projects: { "/other": { trust_level: "trusted" }, [folder]: { trust_level: "trusted" } },
    });
  });

  test("creates the config under HOME when none exists", async () => {
    const home = tempDir();
    const folder = tempDir();

    await trustFolder("codex", folder, { HOME: home });

    expect(Bun.TOML.parse(readFileSync(join(home, ".codex", "config.toml"), "utf8"))).toEqual({
      projects: { [folder]: { trust_level: "trusted" } },
    });
  });

  test("leaves a folder the person marked untrusted alone and says so", async () => {
    const home = tempDir();
    const file = join(home, "config.toml");
    const folder = tempDir();
    const text = `[projects.${JSON.stringify(folder)}]\ntrust_level = "untrusted"\n`;
    writeFileSync(file, text);

    const result = await trustFolder("codex", folder, { CODEX_HOME: home });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("untrusted") });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("leaves the file alone when the folder is already trusted", async () => {
    const home = tempDir();
    const file = join(home, "config.toml");
    const folder = tempDir();
    const text = `[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`;
    writeFileSync(file, text);

    expect(await trustFolder("codex", folder, { CODEX_HOME: home })).toEqual({
      ok: true,
      value: "present",
    });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("refuses a file where an appended table would not parse, and leaves it alone", async () => {
    const home = tempDir();
    const file = join(home, "config.toml");
    const text = 'projects = { "/other" = { trust_level = "trusted" } }\n';
    writeFileSync(file, text);

    const result = await trustFolder("codex", tempDir(), { CODEX_HOME: home });

    expect(result.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("runs started at once each keep their folder", async () => {
    const home = tempDir();
    const folders = Array.from({ length: 8 }, () => tempDir());

    await Promise.all(folders.map((folder) => trustFolder("codex", folder, { CODEX_HOME: home })));

    const config = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as {
      projects: object;
    };
    expect(Object.keys(config.projects).sort()).toEqual([...folders].sort());
  });
});
