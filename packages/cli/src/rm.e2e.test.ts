import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateSchema, type WorkflowRun } from "@yok/sdk";
import { seedRuns } from "./test-runs.ts";

const CLI = join(import.meta.dir, "index.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// Project demo at a temp git repo with finished run fix-login, whose terminal names a session
// on a tmux socket nobody started, as a run left after its session ended.
const setup = async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-rm-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  const home = mkdtempSync(join(tmpdir(), "yok-rm-home-"));
  const runDir = join(cwd, ".yok", "fix-login");
  mkdirSync(runDir, { recursive: true });
  const run: WorkflowRun = {
    id: "r-1a2b3c4d",
    project: "demo",
    workflow: "ok",
    workflowPath: join(cwd, "ok.yaml"),
    inputs: {},
    cwd,
    sessions: [],
    name: "fix-login",
    terminal: "claude-fix-login-3c4d",
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const state = StateSchema.parse({
    schemaVersion: 1,
    lastEventSeq: 0,
    runId: run.id,
    runName: "fix-login",
    runDir,
    version: "1",
    workflow: { name: "ok", path: "artifacts/ok.yaml" },
    input: {},
    scope: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:10:00.000Z",
    status: "completed",
    workspace: {
      type: "mono",
      path: cwd,
      repositories: { r: { path: cwd, git: { branch: "b", baseBranch: "main", startSha: "s" } } },
    },
    nodeRuns: {},
    activeSessions: [],
    tiers: null,
    eventHandlers: {},
    subscribers: {},
  });
  await seedRuns(home, [run], { [run.id]: state });
  const { YOK_RUN_ID: _session, ...parentEnv } = process.env;
  const env = { ...parentEnv, YOK_HOME: home, YOK_TMUX_SOCKET: `yok-rm-${randomUUID()}` };
  const rm = () => {
    const result = spawnSync("bun", [CLI, "rm", "fix-login"], { cwd, encoding: "utf8", env });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  cleanups.push(() => {
    spawnSync("bun", [CLI, "server", "stop"], { cwd, env });
    rmSync(home, { recursive: true, force: true });
  });
  return { rm, runDir };
};

describe("yok rm", () => {
  test('SC620: yok rm fix-login deletes the finished run through the server and its .yok folder, and a second yok rm finds no run named "fix-login"', async () => {
    const { rm, runDir } = await setup();

    const first = rm();
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("removed r-1a2b3c4d\n");
    expect(existsSync(runDir)).toBe(false);

    const second = rm();
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('no run named "fix-login"');
  }, 40_000);
});
