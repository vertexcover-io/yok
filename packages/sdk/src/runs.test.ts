import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ITerminal, ITerminalHost } from "./agent.ts";
import { ConfigSchema } from "./config.ts";
import type { State } from "./contracts.ts";
import type { RunRef } from "./events.ts";
import type { RunDraft, WorkflowRun } from "./registry.ts";
import type { IStorage } from "./repositories.ts";
import {
  closingLine,
  findConfigRoot,
  findRunPane,
  loadCheckoutConfig,
  loadNamedConfig,
  loadPickedConfig,
  loadRunConfig,
  pickRun,
  requireRun,
} from "./runs.ts";
import { createState } from "./state.ts";
import { memoryStorage } from "./storage.ts";

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "sdk-runs-")));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeRepo = (dir = tempDir()): string => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\n.yok/\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const addWorktree = (main: string, branch = "dev"): string => {
  const dir = join(main, ".worktrees", branch);
  git(main, "worktree", "add", "-q", "-b", branch, dir);
  return realpathSync(dir);
};

const writeConfig = (dir: string, config: object, file = "orchestrate.config.json"): string => {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ version: 2, ...config }));
  return path;
};

const DEFAULT_CONFIG = ConfigSchema.parse({ version: 2 });

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const errorOf = (result: { ok: true } | { ok: false; error: string }): string =>
  result.ok ? "" : result.error;

describe("findConfigRoot", () => {
  test("a linked worktree's config folder is the worktree itself, not the main checkout", async () => {
    const main = makeRepo();
    const worktree = addWorktree(main);

    expect(await findConfigRoot(join(worktree))).toEqual({ ok: true, value: worktree });
    expect(await findConfigRoot(main)).toEqual({ ok: true, value: main });
  });

  test("a sub-repo that a multi-layout meta folder lists answers with the meta folder", async () => {
    const meta = tempDir();
    writeConfig(meta, { workspace: { layout: "multi" }, packages: { api: { path: "api" } } });
    const api = makeRepo(join(meta, "api"));
    mkdirSync(join(api, "src"));

    expect(await findConfigRoot(join(api, "src"))).toEqual({ ok: true, value: meta });
  });

  test("a folder outside any git repo is an error naming it", async () => {
    const dir = tempDir();

    expect(errorOf(await findConfigRoot(dir))).toContain(dir);
  });
});

describe("loadCheckoutConfig", () => {
  test("a worktree with its own config gets that config, its path and the worktree as root", async () => {
    const main = makeRepo();
    writeConfig(main, { env: { FROM: "main" } });
    const worktree = addWorktree(main);
    const path = writeConfig(worktree, { env: { FROM: "worktree" } });

    const loaded = unwrap(await loadCheckoutConfig(worktree));

    expect(loaded.config.env).toEqual({ FROM: "worktree" });
    expect(loaded.path).toBe(path);
    expect(loaded.root).toBe(worktree);
  });

  test("a worktree with no config gets the default config, never main's", async () => {
    const main = makeRepo();
    writeConfig(main, { env: { FROM: "main" } });
    const worktree = addWorktree(main);

    expect(await loadCheckoutConfig(worktree)).toEqual({
      ok: true,
      value: { config: DEFAULT_CONFIG, path: null, root: worktree },
    });
  });

  test("a named file is loaded wherever it lives, and its folder is the root", async () => {
    const repo = makeRepo();
    writeConfig(repo, { env: { FROM: "repo" } });
    const elsewhere = tempDir();
    const path = writeConfig(elsewhere, { env: { FROM: "file" } }, "custom.json");

    const loaded = unwrap(await loadNamedConfig(path));

    expect(loaded.config.env).toEqual({ FROM: "file" });
    expect(loaded.path).toBe(path);
    expect(loaded.root).toBe(elsewhere);
  });

  test("a named file that is missing or invalid is an error naming it", async () => {
    const repo = makeRepo();
    const missing = join(repo, "missing.yaml");
    const broken = join(repo, "broken.json");
    writeFileSync(broken, "{");

    expect(errorOf(await loadNamedConfig(missing))).toContain(missing);
    expect(errorOf(await loadNamedConfig(broken))).toContain(broken);
  });
});

// A storage holding project "repo" at CWD and the given runs, each initialized with its state.
const storageWith = async (
  cwd: string,
  runs: readonly (readonly [RunDraft, (State | undefined)?])[],
): Promise<IStorage> => {
  const storage = memoryStorage();
  const addedAt = new Date().toISOString();
  await storage.projects.add("repo", { path: cwd, addedBy: { channel: "cli" }, addedAt });
  for (const [draft, state] of runs) {
    if (state === undefined || draft.name === null) {
      await storage.runs.addRun(draft);
      continue;
    }
    await storage.runs.addRun({ ...draft, name: null });
    const claimed = await storage.runs.initRun(draft.id, draft.name, state);
    if (!claimed.ok) throw new Error(claimed.error);
  }
  return storage;
};

const initializedRun = async (
  cwd: string,
  config?: Readonly<{ path: string | null; root: string }>,
): Promise<Readonly<{ run: RunRef; storage: IStorage }>> => {
  const run = { id: "r-1", cwd, name: "feat-x" };
  const runDir = join(cwd, ".yok", run.name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "workflow.yaml"), "name: ok\nnodes: []\n");
  const state = await createState({
    runId: run.id,
    runDir,
    version: "1.0.0",
    eventHandlers: {},
    config,
  });
  const storage = await storageWith(cwd, [[savedRun(run.id, run.name), state]]);
  return { run, storage };
};

describe("loadRunConfig", () => {
  test("reads the config file the run's state recorded, with its recorded root", async () => {
    const repo = makeRepo();
    const elsewhere = tempDir();
    const path = writeConfig(elsewhere, { env: { FROM: "recorded" } }, "custom.json");
    writeConfig(repo, { env: { FROM: "checkout" } });
    const { run, storage } = await initializedRun(repo, { path, root: elsewhere });

    const loaded = unwrap(await loadRunConfig(run, storage));

    expect(loaded).toMatchObject({ path, root: elsewhere, config: { env: { FROM: "recorded" } } });
  });

  test("a recorded null path keeps the default config, even after a config file appears", async () => {
    const repo = makeRepo();
    const { run, storage } = await initializedRun(repo, { path: null, root: repo });
    writeConfig(repo, { env: { FROM: "late" } });

    expect(await loadRunConfig(run, storage)).toEqual({
      ok: true,
      value: { config: DEFAULT_CONFIG, path: null, root: repo },
    });
  });

  test("a recorded file that was deleted is an error naming it, not a fallback", async () => {
    const repo = makeRepo();
    const path = writeConfig(repo, {});
    const { run, storage } = await initializedRun(repo, { path, root: repo });
    rmSync(path);

    expect(errorOf(await loadRunConfig(run, storage))).toContain(path);
  });

  test("a state.json from before config was recorded searches the run's checkout", async () => {
    const main = makeRepo();
    writeConfig(main, { env: { FROM: "main" } });
    const worktree = addWorktree(main);
    const path = writeConfig(worktree, { env: { FROM: "worktree" } });
    const { run, storage } = await initializedRun(worktree);

    const loaded = unwrap(await loadRunConfig(run, storage));

    expect(loaded).toMatchObject({ path, root: worktree, config: { env: { FROM: "worktree" } } });
  });
});

const savedRun = (id: string, name: string | null): RunDraft => ({
  id,
  project: "repo",
  workflow: "demo",
  workflowPath: "/abs/workflow.yaml",
  inputs: {},
  sessions: [],
  name,
  terminal: null,
  config: null,
  tiers: null,
  createdAt: new Date().toISOString(),
});

describe("pickRun", () => {
  test("SC217: --run-id wins over --run, which wins over $YOK_RUN_ID; nothing named picks none; two names for two runs, an unknown id or an unnamed run is an error", async () => {
    const repo = makeRepo();
    const storage = await storageWith(repo, [
      [savedRun("r-1", "feat-x")],
      [savedRun("r-2", "feat-y")],
      [savedRun("r-new", null)],
    ]);
    mkdirSync(join(repo, ".yok", "feat-x"), { recursive: true });
    mkdirSync(join(repo, ".yok", "feat-y"), { recursive: true });
    const pick = (flags: { name?: string; id?: string }, env: Record<string, string> = {}) =>
      pickRun({ storage, ...flags, env, cwd: repo });
    const x = { id: "r-1", cwd: repo, name: "feat-x" };
    const y = { id: "r-2", cwd: repo, name: "feat-y" };

    expect(await pick({ id: "r-2", name: "feat-y" })).toEqual({ ok: true, value: y });
    expect(await pick({ id: "r-1" }, { YOK_RUN_ID: "r-2" })).toEqual({ ok: true, value: x });
    expect(await pick({ name: "feat-x" }, { YOK_RUN_ID: "r-2" })).toEqual({ ok: true, value: x });
    expect(await pick({}, { YOK_RUN_ID: "r-2" })).toEqual({ ok: true, value: y });
    expect(await pick({})).toEqual({ ok: true, value: undefined });
    expect(await pick({}, { YOK_RUN_ID: "" })).toEqual({ ok: true, value: undefined });
    const error = errorOf(await pick({ id: "r-2", name: "feat-x" }));
    expect(error).toContain("r-2");
    expect(error).toContain("feat-x");
    expect(errorOf(await pick({ id: "r-ghost" }))).toContain("run r-ghost not found");
    expect(errorOf(await pick({ id: "r-new" }))).toBe(
      "run r-new is not initialized; run orchestrate init",
    );
  });
});

describe("requireRun", () => {
  test("picks the run like pickRun, and refuses when nothing names one", async () => {
    const repo = makeRepo();
    const storage = await storageWith(repo, [[savedRun("r-1", "feat-x")]]);
    mkdirSync(join(repo, ".yok", "feat-x"), { recursive: true });
    const require = (env: Record<string, string>) => requireRun({ storage, env, cwd: repo });

    expect(await require({ YOK_RUN_ID: "r-1" })).toEqual({
      ok: true,
      value: { id: "r-1", cwd: repo, name: "feat-x" },
    });
    expect(errorOf(await require({}))).toBe(
      "no run: pass --run or --run-id, or run inside a yok session",
    );
  });
});

describe("loadPickedConfig", () => {
  test("a picked run gets its recorded config; no run gets the folder's checkout config", async () => {
    const repo = makeRepo();
    const checkout = writeConfig(repo, { env: { FROM: "checkout" } });
    const elsewhere = tempDir();
    const recorded = writeConfig(elsewhere, { env: { FROM: "recorded" } }, "custom.json");
    const { run, storage } = await initializedRun(repo, { path: recorded, root: elsewhere });

    expect(unwrap(await loadPickedConfig(run, repo, storage)).path).toBe(recorded);
    expect(unwrap(await loadPickedConfig(undefined, repo)).path).toBe(checkout);
  });
});

describe("closingLine", () => {
  test.each([
    ["failed", "Run demo failed. Retry it from the failed step with: yok retry demo"],
    ["completed", "Run demo completed. Resume it with: yok resume demo"],
  ] as const)("SC11: a %s run's closing line reads %s", (status, line) => {
    expect(closingLine("demo", status)).toBe(line);
  });
});

// A pane that answers isAlive as told; findRunPane only asks that and hands it back.
const fakePane = (alive: boolean): ITerminal => ({
  sendText: async () => ({ ok: true, value: undefined }),
  sendKeys: async () => ({ ok: true, value: undefined }),
  capture: async () => ({ ok: true, value: "" }),
  isAlive: async () => alive,
  kill: async () => ({ ok: true, value: undefined }),
  rename: async () => ({ ok: true, value: undefined }),
  respawn: async () => ({ ok: true, value: undefined }),
  attachCommand: () => ["tmux", "attach-session", "-t", "=demo-pane:"],
});

const fakeHost = (pane: ITerminal, asked: string[] = []): ITerminalHost => ({
  checks: [],
  create: async () => ({ ok: true, value: pane }),
  find: (name) => {
    asked.push(name);
    return pane;
  },
  list: async () => [],
});

const runState = (cwd: string, status: State["status"]): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "demo",
  runDir: join(cwd, ".yok", "demo"),
  version: "1",
  workflow: { name: "demo", path: "workflow.yaml" },
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
});

// The stored run r-1 named demo, with its pane named demo-pane and the given state, if any.
const paneRun = async (
  cwd: string,
  status?: State["status"],
): Promise<Readonly<{ run: WorkflowRun; storage: IStorage }>> => {
  const draft = { ...savedRun("r-1", "demo"), terminal: "demo-pane" };
  const state = status === undefined ? undefined : runState(cwd, status);
  const storage = await storageWith(cwd, [[draft, state]]);
  const run = await storage.runs.findRun("r-1");
  if (run === undefined) throw new Error("no run");
  return { run, storage };
};

describe("findRunPane", () => {
  test("SC1: a run with no terminal is refused with the attach wording, without asking the host", async () => {
    const asked: string[] = [];

    const storage = await storageWith(tempDir(), [[savedRun("r-1", "demo")]]);
    const run = await storage.runs.findRun("r-1");
    if (run === undefined) throw new Error("no run");

    const pane = await findRunPane(fakeHost(fakePane(true), asked), run, storage);

    expect(errorOf(pane)).toBe("run r-1 has no terminal yet");
    expect(asked).toEqual([]);
  });

  test.each([
    ["failed", "Run demo failed. Retry it from the failed step with: yok retry demo"],
    ["completed", "Run demo completed. Resume it with: yok resume demo"],
    ["running", "Run demo has no running session. Resume it with: yok resume demo"],
    ["missing", "Run demo has no running session. Resume it with: yok resume demo"],
  ] as const)("SC2: a dead session of a run whose state is %s reads %s", async (status, line) => {
    const { run, storage } = await paneRun(tempDir(), status === "missing" ? undefined : status);

    expect(errorOf(await findRunPane(fakeHost(fakePane(false)), run, storage))).toBe(line);
  });

  test("SC3: a live session returns its own pane", async () => {
    const asked: string[] = [];
    const { run, storage } = await paneRun(tempDir());

    const pane = unwrap(await findRunPane(fakeHost(fakePane(true), asked), run, storage));

    expect(pane.attachCommand()).toEqual(["tmux", "attach-session", "-t", "=demo-pane:"]);
    expect(asked).toEqual(["demo-pane"]);
  });
});
