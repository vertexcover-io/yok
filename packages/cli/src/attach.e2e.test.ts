import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, type WorkflowRun } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";

const CLI = join(import.meta.dir, "index.ts");

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "yok-attach-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
};

const runFolder = (cwd: string, name: string): void => {
  mkdirSync(join(cwd, ".yok", name), { recursive: true });
};

// A state.json that parses, for the run named fix-login, at the given status.
const writeState = (cwd: string, status: "running" | "completed"): void => {
  const runDir = join(cwd, ".yok", "fix-login");
  const state = {
    schemaVersion: 1,
    lastEventSeq: 0,
    runId: "r-1a2b3c4d",
    runName: "fix-login",
    runDir,
    version: "1",
    workflow: { name: "ok", path: "artifacts/ok.yaml" },
    input: {},
    scope: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    status,
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
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
};

const TMUX = ["-L", "attach-test"];

// The run's terminal, alive on the test's own tmux socket.
const startSession = (name: string): void => {
  execFileSync("tmux", [...TMUX, "new-session", "-d", "-s", name]);
};

const run = (id: string, name: string, cwd: string, terminal: string | null): WorkflowRun => ({
  id,
  workflow: "ok",
  workflowPath: join(cwd, "ok.yaml"),
  inputs: {},
  cwd,
  sessions: [],
  name,
  terminal,
  config: null,
  tiers: null,
  createdAt: new Date().toISOString(),
});

const attach = (cwd: string, home: string, ...args: string[]) => {
  const result = spawnSync("bun", [CLI, "attach", "--print", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, YOK_HOME: home, YOK_TMUX_SOCKET: "attach-test" },
  });
  return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

describe("yok attach", () => {
  afterEach(() => {
    spawnSync("tmux", [...TMUX, "kill-server"]);
  });

  test("SC7: finds a run by name, and refuses unknown names and runs without a terminal", async () => {
    const cwd = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "yok-attach-home-"));
    writeFileSync(join(home, ".keep"), "");
    const registry = createRegistry(registryPath(home));
    await registry.addRun(run("r-1a2b3c4d", "fix-login", cwd, "claude-fix-login-3c4d"));
    await registry.addRun(run("r-5e6f7a8b", "pending", cwd, null));
    runFolder(cwd, "fix-login");
    runFolder(cwd, "pending");
    startSession("claude-fix-login-3c4d");

    const found = attach(cwd, home, "fix-login");
    expect(found.code).toBe(0);
    expect(found.stdout).toEndWith("attach-session -t =claude-fix-login-3c4d:");

    const unknown = attach(cwd, home, "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nope");

    const noTerminal = attach(cwd, home, "pending");
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.stderr).toContain("no terminal yet");
  }, 40_000);

  test("takes a run id only through --run-id, and refuses a name and --run-id that disagree", async () => {
    const cwd = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "yok-attach-home-"));
    const registry = createRegistry(registryPath(home));
    await registry.addRun(run("r-1a2b3c4d", "fix-login", cwd, "claude-fix-login-3c4d"));
    runFolder(cwd, "fix-login");
    startSession("claude-fix-login-3c4d");

    const byId = attach(cwd, home, "--run-id", "r-1a2b3c4d");
    expect(byId.code).toBe(0);
    expect(byId.stdout).toEndWith("attach-session -t =claude-fix-login-3c4d:");

    const idAsName = attach(cwd, home, "r-1a2b3c4d");
    expect(idAsName.code).toBe(1);
    expect(idAsName.stderr).toContain('no run named "r-1a2b3c4d"');

    const unknownId = attach(cwd, home, "--run-id", "r-00000000");
    expect(unknownId.code).toBe(1);
    expect(unknownId.stderr).toContain("r-00000000");

    expect(attach(cwd, home).code).toBe(1);
    const mismatched = attach(cwd, home, "other-run", "--run-id", "r-1a2b3c4d");
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toContain("name different runs");
  }, 40_000);

  test.each([
    ["completed", "Run fix-login completed. Resume it with: yok resume fix-login"],
    ["running", "Run fix-login has no running session. Resume it with: yok resume fix-login"],
  ] as const)(
    "SC815: attaching to a %s run whose tmux session is gone exits 1 saying %s",
    async (status, message) => {
      const cwd = makeRepo();
      const home = mkdtempSync(join(tmpdir(), "yok-attach-home-"));
      const registry = createRegistry(registryPath(home));
      await registry.addRun(run("r-1a2b3c4d", "fix-login", cwd, "claude-fix-login-3c4d"));
      runFolder(cwd, "fix-login");
      writeState(cwd, status);

      const gone = attach(cwd, home, "fix-login");

      expect(gone.code).toBe(1);
      expect(gone.stderr).toContain(message);
    },
    40_000,
  );
});
