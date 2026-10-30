import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-ls-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  const home = mkdtempSync(join(tmpdir(), "yok-ls-home-"));
  writeFileSync(join(home, ".keep"), "");
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
  const registry = createRegistry(registryPath(home));
  await registry.addRun(record);
  // This pipeline exports YOK_RUN_ID; left in, it would leak this run's session into the CLI.
  const { YOK_RUN_ID: _session, ...parentEnv } = process.env;
  const env = { ...parentEnv, YOK_HOME: home };
  const ls = (...args: string[]) => {
    const result = spawnSync("bun", [CLI, "ls", ...args], { cwd, encoding: "utf8", env });
    return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  cleanups.push(() => {
    spawnSync("bun", [CLI, "server", "stop"], { cwd, env });
    rmSync(home, { recursive: true, force: true });
  });
  const addOlderRun = (id: string) =>
    registry.addRun({ ...record, id, name: id, createdAt: "2020-01-01T00:00:00.000Z" });
  return { ls, addOlderRun };
};

describe("yok ls", () => {
  test("SC5010: piped, prints the table alone with the run's PROJECT as -, and --json prints total 1 with one run", async () => {
    const { ls, addOlderRun } = await setup();

    const table = ls();
    expect(table.code).toBe(0);
    const lines = table.stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("ID");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[1]).toStartWith("r-1a2b3c4d");
    expect(lines[1]?.split(/\s{2,}/).slice(0, 3)).toEqual(["r-1a2b3c4d", "fix-login", "-"]);

    const json = ls("--json");
    expect(json.code).toBe(0);
    const parsed: { total: number; runs: unknown[] } = JSON.parse(json.stdout);
    expect(parsed.total).toBe(1);
    expect(parsed.runs).toHaveLength(1);

    await addOlderRun("r-older");
    const idsOf = (...args: string[]) =>
      ls(...args)
        .stdout.split("\n")
        .slice(1)
        .map((line) => line.split(/\s{2,}/)[0]);
    expect(idsOf()).toEqual(["r-1a2b3c4d", "r-older"]);
    expect(idsOf("--limit", "1")).toEqual(["r-1a2b3c4d"]);
    expect(idsOf("--all")).toEqual(["r-1a2b3c4d", "r-older"]);
    expect(idsOf("--status", "missing")).toEqual(["r-1a2b3c4d", "r-older"]);
    expect(idsOf("--status", "completed")).toEqual([]);
    expect(ls("--status", "bogus").code).not.toBe(0);
    expect(ls("--all", "--limit", "1").code).not.toBe(0);
  }, 40_000);
});
