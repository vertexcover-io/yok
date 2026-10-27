import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, type WorkflowRun } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";

const CLI = join(import.meta.dir, "index.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const runRecord = (cwd: string, id: string, name: string): WorkflowRun => ({
  id,
  workflow: "ok",
  workflowPath: join(cwd, "ok.yaml"),
  inputs: {},
  cwd,
  sessions: [],
  name,
  terminal: null,
  config: null,
  tiers: null,
  createdAt: new Date().toISOString(),
});

const setup = async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-build-plan-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  const home = mkdtempSync(join(tmpdir(), "yok-build-plan-home-"));
  cleanups.push(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const artifacts = join(cwd, ".yok", "feat-x", "artifacts");
  mkdirSync(join(artifacts, "phases"), { recursive: true });
  writeFileSync(join(artifacts, "plan.md"), "# Plan: Feature X\n\nThe plan.\n");
  writeFileSync(join(artifacts, "phases", "phase-1.md"), "# Phase 1: First\n");
  mkdirSync(join(cwd, ".yok", "bare", "artifacts"), { recursive: true });
  const registry = createRegistry(registryPath(home));
  await registry.addRun(runRecord(cwd, "r-feat0001", "feat-x"));
  await registry.addRun(runRecord(cwd, "r-bare0001", "bare"));
  // This pipeline exports YOK_RUN_ID; left in, build-plan would build that run instead.
  const { YOK_RUN_ID: _session, ...parentEnv } = process.env;
  const env = { ...parentEnv, YOK_HOME: home };
  const buildPlan = (...args: string[]) => {
    const result = spawnSync("bun", [CLI, "build-plan", ...args], { cwd, encoding: "utf8", env });
    return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  return { buildPlan, artifacts };
};

describe("yok build-plan", () => {
  test("SC710: writes the named run's artifacts/plan.html and prints its path, and fails naming an unknown run or a missing plan.md", async () => {
    const { buildPlan, artifacts } = await setup();

    const built = buildPlan("feat-x");
    expect(built.code).toBe(0);
    expect(built.stdout).toBe(join(artifacts, "plan.html"));
    expect(readFileSync(built.stdout, "utf8")).toContain('<article id="plan" class="doc" hidden>');

    const missing = buildPlan("missing-run");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("missing-run");

    const bare = buildPlan("bare");
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("plan.md");
  }, 40_000);
});
