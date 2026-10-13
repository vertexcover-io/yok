import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, type WorkflowRun } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";

const CLI = join(import.meta.dir, "index.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const setup = async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-view-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  const home = mkdtempSync(join(tmpdir(), "yok-view-home-"));
  writeFileSync(join(home, ".keep"), "");
  mkdirSync(join(cwd, ".yok", "fix-login"), { recursive: true });
  const record: WorkflowRun = {
    id: "r-1a2b3c4d",
    workflow: "ok",
    workflowPath: join(cwd, "ok.yaml"),
    inputs: {},
    cwd,
    sessions: [],
    name: "fix-login",
    terminal: null,
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
  };
  await createRegistry(registryPath(home)).addRun(record);
  // This pipeline exports YOK_RUN_ID; left in, yok view would open that run instead of the list.
  const { YOK_RUN_ID: _session, ...parentEnv } = process.env;
  const env = { ...parentEnv, YOK_HOME: home };
  const view = (...args: string[]) => {
    const result = spawnSync("bun", [CLI, "view", ...args], { cwd, encoding: "utf8", env });
    return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  cleanups.push(() => {
    spawnSync("bun", [CLI, "server", "stop"], { cwd, env });
    rmSync(home, { recursive: true, force: true });
  });
  return { view, record };
};

describe("yok view", () => {
  test("SC12, SC109: prints the runs page URL with no target, a run's page URL by name, and refuses unknown or ambiguous targets", async () => {
    const { view, record } = await setup();

    const list = view("--print");
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^http:\/\/localhost:\d+\/$/);

    const printed = view("fix-login", "--print");
    expect(printed.code).toBe(0);
    expect(printed.stdout).toMatch(new RegExp(`^http://localhost:\\d+/runs/${record.id}$`));

    const unknown = view("no-such-run", "--print");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no-such-run");

    const mismatched = view("other-run", "--run-id", record.id, "--print");
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toContain("name different runs");
  }, 40_000);
});
