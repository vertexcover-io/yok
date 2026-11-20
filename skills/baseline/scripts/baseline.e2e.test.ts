import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDirOf, type State } from "@yok/sdk";
import { createState, type RunDraft, withStorage } from "@yok/sdk/internal";

const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
const BASELINE = ["--no-env-file", CLI, "orchestrate", "skill", "run", "baseline.script"];

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "baseline-e2e-")));

const WORKFLOW =
  'name: ok\nnodes:\n  - { id: a, type: exec, input: null, runtime: sh, script: "true" }\n';

// A repo holding orchestrate.config.json with `baseline`, and a run named feat-x in YOK_HOME's
// yok.db, as `orchestrate init` leaves it; config is the config file its state records.
const baselineRun = async (
  baseline: string | undefined,
  config?: State["config"],
): Promise<Readonly<{ repo: string; home: string }>> => {
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(repo, "orchestrate.config.json"), JSON.stringify({ version: 2, baseline }));
  const workflowPath = join(repo, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  const run: RunDraft = {
    id: "r-1",
    project: "repo",
    workflow: "ok",
    workflowPath,
    inputs: { prompt: "hi" },
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
  };
  const home = tempDir();
  const runDir = runDirOf(repo, "feat-x");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "workflow.yaml"), WORKFLOW);
  const recorded = config === undefined ? {} : { config };
  const state = await createState({
    runId: "r-1",
    runDir,
    version: "1.0.0",
    eventHandlers: {},
    ...recorded,
  });
  await withStorage(home, async (storage) => {
    const project = { path: repo, addedBy: { channel: "cli" }, addedAt: run.createdAt };
    const added = await storage.projects.add("repo", project);
    if (!added.ok) throw new Error(added.error);
    await storage.runs.addRun(run);
    const named = await storage.runs.initRun("r-1", "feat-x", state);
    if (!named.ok) throw new Error(named.error);
  });
  return { repo, home };
};

// A run id or yok home from the shell running the tests must never reach a real registry.
const env = (home: string) => ({ ...process.env, YOK_RUN_ID: undefined, YOK_HOME: home });

const baseline = (
  cwd: string,
  home: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) => {
  const run = spawnSync("bun", [...BASELINE, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env(home), ...extra },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
};

describe("SC48: yok orchestrate skill run baseline.script with no extension, as baseline.ts did", () => {
  test("runs the configured script and writes artifacts/baseline.json", async () => {
    const { repo, home } = await baselineRun(`echo '{"tests":3}'`);

    const run = baseline(repo, home, ["--run", "feat-x", "--dir", repo]);

    expect(run.code).toBe(0);
    const path = join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json");
    expect(JSON.parse(run.stdout)).toEqual({ path, workspace: 0, packages: {} });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      workspace: { command: `echo '{"tests":3}'`, exitCode: 0, output: { tests: 3 } },
      packages: {},
    });
  });

  test("with no baseline script configured, it prints a null path and no exit codes", async () => {
    const { repo, home } = await baselineRun(undefined);

    const run = baseline(repo, home, ["--run", "feat-x", "--dir", repo]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ path: null, workspace: null, packages: {} });
  });

  test("a run whose state records a config file runs that file's baseline, not the repo's", async () => {
    const elsewhere = tempDir();
    const file = join(elsewhere, "custom.json");
    writeFileSync(file, JSON.stringify({ version: 2, baseline: "echo from-run-config" }));
    const { repo, home } = await baselineRun("echo from-repo-config", {
      path: file,
      root: elsewhere,
    });
    const runDir = runDirOf(repo, "feat-x");

    const run = baseline(repo, home, ["--run", "feat-x", "--dir", repo]);

    expect(run.code).toBe(0);
    const recorded = JSON.parse(readFileSync(join(runDir, "artifacts", "baseline.json"), "utf8"));
    expect(recorded.workspace.command).toBe("echo from-run-config");
  });

  test("$YOK_RUN_ID picks the run with no flag, and --run-id picks it from outside the repo", async () => {
    const { repo, home } = await baselineRun("echo ok");
    const path = join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json");

    const fromSession = baseline(repo, home, ["--dir", repo], { YOK_RUN_ID: "r-1" });
    const byId = baseline(tempDir(), home, ["--run-id", "r-1", "--dir", repo]);

    expect(fromSession.code).toBe(0);
    expect(JSON.parse(fromSession.stdout).path).toBe(path);
    expect(byId.code).toBe(0);
    expect(JSON.parse(byId.stdout).path).toBe(path);
  });

  test("SIGTERM kills the running baseline script, exits 143 and writes nothing", async () => {
    const { repo, home } = await baselineRun("echo $$ > pid; sleep 30");
    const pidFile = join(repo, "pid");
    const child = Bun.spawn(["bun", ...BASELINE, "--run", "feat-x", "--dir", repo], {
      cwd: repo,
      env: env(home),
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    child.kill("SIGTERM");

    expect(await child.exited).toBe(143);
    await waitFor(() => !isAlive(pid), 2000);
    expect(existsSync(join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json"))).toBe(false);
  });
});
