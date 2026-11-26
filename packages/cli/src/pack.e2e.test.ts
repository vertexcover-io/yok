import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-pack-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  const home = mkdtempSync(join(tmpdir(), "yok-pack-home-"));
  const runDir = join(cwd, ".yok", "fix-login");
  mkdirSync(join(runDir, "artifacts", "design"), { recursive: true });
  writeFileSync(join(runDir, "state.json"), '{"status":"running"}');
  writeFileSync(join(runDir, "artifacts", "design", "notes.md"), "# Notes\n".repeat(200));
  writeFileSync(join(runDir, "artifacts", "empty.txt"), "");
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
  const { YOK_RUN_ID: _session, ...parentEnv } = process.env;
  const env = { ...parentEnv, YOK_HOME: home };
  const pack = (...args: string[]) => {
    const result = spawnSync("bun", [CLI, "pack", ...args], { cwd, encoding: "utf8", env });
    return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  cleanups.push(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { pack, cwd, record };
};

const unzip = (...args: string[]) => execFileSync("unzip", args, { encoding: "utf8" });

describe("yok pack", () => {
  test("zips every file of the run's folder into .yok/NAME.zip, by name or run id, and prints its path", async () => {
    const { pack, cwd, record } = await setup();
    const zipPath = join(cwd, ".yok", "fix-login.zip");

    const byName = pack("fix-login");
    expect(byName).toEqual({ code: 0, stdout: zipPath, stderr: "" });
    expect(unzip("-t", zipPath)).toContain("No errors detected");
    expect(unzip("-Z1", zipPath).trim().split("\n").sort()).toEqual([
      "fix-login/artifacts/design/notes.md",
      "fix-login/artifacts/empty.txt",
      "fix-login/state.json",
    ]);
    expect(unzip("-p", zipPath, "fix-login/artifacts/design/notes.md")).toBe(
      "# Notes\n".repeat(200),
    );

    writeFileSync(join(cwd, ".yok", "fix-login", "state.json"), '{"status":"completed"}');
    const byId = pack("--run-id", record.id);
    expect(byId).toEqual({ code: 0, stdout: zipPath, stderr: "" });
    expect(unzip("-p", zipPath, "fix-login/state.json")).toBe('{"status":"completed"}');
  }, 30_000);

  test("an unknown run name exits 1 naming the run, and writes no zip", async () => {
    const { pack, cwd } = await setup();

    const unknown = pack("no-such-run");

    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no-such-run");
    expect(existsSync(join(cwd, ".yok", "no-such-run.zip"))).toBe(false);
  }, 30_000);
});
