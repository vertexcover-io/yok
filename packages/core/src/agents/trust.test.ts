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
import { claudeConfigPath, trustClaudeFolder, trustRoot } from "./trust.ts";

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

  test("a folder whose .git file points into a repository that never added it is trusted as itself", async () => {
    const root = repo();
    const folder = tempDir();
    writeFileSync(join(folder, ".git"), `gitdir: ${join(root, ".git")}\n`);
    expect(await trustRoot(folder)).toBe(folder);
  });

  test("a symlinked folder is trusted under its real path", async () => {
    const dir = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);
    expect(await trustRoot(link)).toBe(dir);
  });
});

describe("claudeConfigPath", () => {
  test("CLAUDE_CONFIG_DIR wins over HOME", () => {
    expect(claudeConfigPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/.claude.json");
  });

  test("without it the file sits under HOME", () => {
    expect(claudeConfigPath({ HOME: "/h" })).toBe("/h/.claude.json");
  });
});

const MACHINE_FLAGS = {
  hasCompletedOnboarding: true,
  hasSeenAutoDefaultNotice: true,
  hasSeenAutoModeOutsideReadPrompt: true,
};
const PROJECT_FLAGS = {
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: true,
  hasClaudeMdExternalIncludesWarningShown: true,
};

describe("trustClaudeFolder", () => {
  test("SC701: a launch with no Claude config writes the three machine-wide flags and the folder's three project flags", async () => {
    const home = tempDir();
    const folder = tempDir();

    expect(await trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: true,
    });

    expect(readJson(join(home, ".claude.json"))).toEqual({
      ...MACHINE_FLAGS,
      projects: { [folder]: PROJECT_FLAGS },
    });
  });

  test("SC702: a machine-wide flag the user set to false stays false, the other two are added, and other keys and projects are unchanged", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    const before = {
      hasCompletedOnboarding: false,
      numStartups: 4,
      projects: { "/other": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } },
    };
    writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    const folder = tempDir();

    expect(await trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: true,
    });

    expect(readJson(file)).toEqual({
      ...before,
      hasSeenAutoDefaultNotice: true,
      hasSeenAutoModeOutsideReadPrompt: true,
      projects: { ...before.projects, [folder]: PROJECT_FLAGS },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("SC703: project flags Claude wrote as false become true, and the folder's allowedTools stays", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    const folder = tempDir();
    const record = {
      allowedTools: ["Read"],
      hasTrustDialogAccepted: false,
      hasClaudeMdExternalIncludesApproved: false,
    };
    writeFileSync(file, JSON.stringify({ projects: { [folder]: record } }));

    await trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home });

    expect(readJson(file)).toEqual({
      ...MACHINE_FLAGS,
      projects: { [folder]: { allowedTools: ["Read"], ...PROJECT_FLAGS } },
    });
  });

  test("creates the config under HOME when none exists", async () => {
    const home = tempDir();
    const folder = tempDir();

    await trustClaudeFolder(folder, { HOME: home });

    expect(readJson(join(home, ".claude.json"))).toEqual({
      ...MACHINE_FLAGS,
      projects: { [folder]: PROJECT_FLAGS },
    });
  });

  test("SC704: a compact config that already holds all six flags returns value false and stays byte for byte", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    const folder = tempDir();
    const text = JSON.stringify({ ...MACHINE_FLAGS, projects: { [folder]: PROJECT_FLAGS } });
    writeFileSync(file, text);

    expect(await trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: false,
    });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("refuses a config that is not JSON and leaves it alone", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, "{oops");

    const result = await trustClaudeFolder(tempDir(), { CLAUDE_CONFIG_DIR: home });

    expect(result.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });

  test("SC705: a config reading [1] is refused with an error naming its path, and still reads [1]", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, "[1]");

    const result = await trustClaudeFolder(tempDir(), { CLAUDE_CONFIG_DIR: home });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(file);
    expect(readFileSync(file, "utf8")).toBe("[1]");
  });

  test("writes through a symlinked config instead of replacing the link", async () => {
    const home = tempDir();
    const real = join(tempDir(), "claude.json");
    writeFileSync(real, "{}");
    symlinkSync(real, join(home, ".claude.json"));
    const folder = tempDir();

    await trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home });

    expect(readJson(real)).toEqual({ ...MACHINE_FLAGS, projects: { [folder]: PROJECT_FLAGS } });
  });

  test("runs started at once each keep their folder", async () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), "{}");
    const folders = Array.from({ length: 8 }, () => tempDir());

    await Promise.all(
      folders.map((folder) => trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home })),
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

    const pending = trustClaudeFolder(folder, { CLAUDE_CONFIG_DIR: home });
    await Bun.sleep(100);
    expect(readJson(file)).toEqual({});
    execFileSync("rmdir", [`${file}.lock`]);

    expect(await pending).toEqual({ ok: true, value: true });
  });

  test("takes over a lock its holder stopped refreshing", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, "{}");
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);

    expect(await trustClaudeFolder(tempDir(), { CLAUDE_CONFIG_DIR: home })).toEqual({
      ok: true,
      value: true,
    });
  });
});
