import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

  test("packs a live run whose files appear and vanish while it reads them", async () => {
    const { pack, cwd } = await setup();
    const runDir = join(cwd, ".yok", "fix-login");
    // Writes and removes temp files and lock folders in a loop, the way a running run does.
    const churn = spawn("bun", [
      "-e",
      `const fs = require("node:fs");
       for (let i = 0; ; i++) {
         const tmp = ${JSON.stringify(runDir)} + "/.state." + i + ".tmp";
         const lock = ${JSON.stringify(runDir)} + "/locks/" + i;
         fs.writeFileSync(tmp, "x".repeat(4096));
         fs.mkdirSync(lock, { recursive: true });
         fs.writeFileSync(lock + "/owner", "1");
         fs.rmSync(tmp);
         fs.rmSync(lock, { recursive: true });
       }`,
    ]);
    cleanups.unshift(() => churn.kill());
    await Bun.sleep(300);

    const results = Array.from({ length: 15 }, () => pack("fix-login"));

    expect(results.filter((result) => result.code !== 0)).toEqual([]);
    expect(unzip("-Z1", join(cwd, ".yok", "fix-login.zip"))).toContain("fix-login/state.json");
  }, 60_000);

  test("a file dated before 1980, which a zip cannot store, is packed as 1980-01-01", async () => {
    const { pack, cwd } = await setup();
    utimesSync(join(cwd, ".yok", "fix-login", "state.json"), 0, 0);
    const zipPath = join(cwd, ".yok", "fix-login.zip");

    expect(pack("fix-login").code).toBe(0);
    expect(unzip("-t", zipPath)).toContain("No errors detected");
    expect(unzip("-Z", "-T", zipPath, "fix-login/state.json")).toContain("19800101.000000");
  }, 30_000);

  test("leaves out what a symlinked folder points at, inside or outside the run folder", async () => {
    const { pack, cwd } = await setup();
    const outside = mkdtempSync(join(tmpdir(), "yok-pack-outside-"));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "id_ed25519"), "secret");
    const artifacts = join(cwd, ".yok", "fix-login", "artifacts");
    symlinkSync(outside, join(artifacts, "ssh"));
    symlinkSync("..", join(artifacts, "loop"));
    const zipPath = join(cwd, ".yok", "fix-login.zip");

    expect(pack("fix-login")).toEqual({ code: 0, stdout: zipPath, stderr: "" });
    expect(unzip("-Z1", zipPath).trim().split("\n").sort()).toEqual([
      "fix-login/artifacts/design/notes.md",
      "fix-login/artifacts/empty.txt",
      "fix-login/state.json",
    ]);
  }, 30_000);

  test("an unknown run name exits 1 naming the run, and writes no zip", async () => {
    const { pack, cwd } = await setup();

    const unknown = pack("no-such-run");

    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no-such-run");
    expect(existsSync(join(cwd, ".yok", "no-such-run.zip"))).toBe(false);
  }, 30_000);
});
