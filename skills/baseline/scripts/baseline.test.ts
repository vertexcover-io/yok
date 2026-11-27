import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { ConfigSchema, noopLogger, type RunRef, runDirOf, type State } from "@yok/sdk";
import { createState, withStorage } from "@yok/sdk/internal";
import { type Baseline, captureBaseline } from "./baseline.ts";

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "baseline-")));

type Setup = Readonly<{ root: string; home: string; run: RunRef; runDir: string }>;

// The run as init leaves it in HOME/yok.db, after its project's row.
const seedRun = (home: string, run: RunRef, state: State): Promise<void> =>
  withStorage(home, async (storage) => {
    const project = { path: run.cwd, addedBy: { channel: "cli" }, addedAt: state.startedAt };
    const added = await storage.projects.add("repo", project);
    if (!added.ok) throw new Error(added.error);
    await storage.runs.addRun({
      id: run.id,
      project: "repo",
      workflow: "task",
      workflowPath: join(run.cwd, "task.yaml"),
      inputs: {},
      sessions: [],
      name: null,
      terminal: null,
      config: null,
      tiers: null,
      createdAt: state.startedAt,
    });
    const named = await storage.runs.initRun(run.id, run.name, state);
    if (!named.ok) throw new Error(named.error);
  });

// workspace: the path the run's state records, in place of the repo root.
const setup = async (
  config: object,
  { state = true, workspace }: Readonly<{ state?: boolean; workspace?: string }> = {},
): Promise<Setup> => {
  const root = tempDir();
  const home = tempDir();
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
  const run = { id: "r-1", cwd: root, name: "feat-x" };
  const runDir = runDirOf(root, run.name);
  mkdirSync(runDir, { recursive: true });
  if (!state) return { root, home, run, runDir };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(runDir, "workflow.yaml"), "name: task\nnodes: []\n");
  const first = await createState({ runId: run.id, runDir, version: "1.0.0", eventHandlers: {} });
  const recorded =
    workspace === undefined
      ? first
      : { ...first, workspace: { ...first.workspace, path: workspace } };
  await seedRun(home, run, recorded);
  return { root, home, run, runDir };
};

// captureBaseline reads the run's state from YOK_HOME, as `yok orchestrate skill run` sets it.
const capture = async (
  { root, home, run }: Setup,
  options: { packages?: readonly string[]; dir?: string } = {},
  log = noopLogger,
) => {
  const before = process.env.YOK_HOME;
  process.env.YOK_HOME = home;
  try {
    return await captureBaseline({
      config: ConfigSchema.parse(
        JSON.parse(readFileSync(join(root, "orchestrate.config.json"), "utf8")),
      ),
      run,
      packages: options.packages ?? [],
      dir: options.dir,
      log,
    });
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, "YOK_HOME");
    else process.env.YOK_HOME = before;
  }
};

const baselineOf = (runDir: string): Baseline =>
  JSON.parse(readFileSync(join(runDir, "artifacts", "baseline.json"), "utf8"));

const eventsIn = (home: string) => withStorage(home, (storage) => storage.runs.readEvents("r-1"));

const pkg = (baseline: string | object | null | undefined, path = ".") => ({
  path,
  commands: baseline === undefined ? {} : { baseline },
});

describe("captureBaseline", () => {
  test("BL1: the workspace and package scripts combine into one file, and no event is recorded", async () => {
    const run = await setup({
      baseline: `echo '{"a":1}'`,
      packages: { core: pkg(`echo '{"b":2}'`) },
    });

    const result = await capture(run);

    const expected = {
      workspace: { command: `echo '{"a":1}'`, exitCode: 0, output: { a: 1 } },
      packages: { core: { command: `echo '{"b":2}'`, exitCode: 0, output: { b: 2 } } },
    };
    expect(result).toEqual({
      ok: true,
      value: { path: join(run.runDir, "artifacts", "baseline.json"), baseline: expected },
    });
    expect(baselineOf(run.runDir)).toEqual(expected);
    expect(await eventsIn(run.home)).toEqual([]);
  });

  test("CMD3: a baseline object runs in its cwd, relative to the workspace folder", async () => {
    const run = await setup({
      baseline: { command: "pwd", cwd: "tools" },
      packages: { core: pkg({ command: "pwd", cwd: "packages/core" }) },
    });
    mkdirSync(join(run.root, "tools"));
    mkdirSync(join(run.root, "packages", "core"), { recursive: true });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace?.output).toBe(join(run.root, "tools"));
    expect(result.value.baseline.packages.core?.output).toBe(join(run.root, "packages", "core"));
  });

  test("CMD4: a baseline object's timeoutSeconds replaces the default timeout", async () => {
    const run = await setup({ baseline: { command: "echo partial; sleep 5", timeoutSeconds: 1 } });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace).toMatchObject({ exitCode: 124, output: "partial" });
  });

  test("CMD5: a baseline cwd that is not a folder stops with CONFIG_STALE and writes nothing", async () => {
    const run = await setup({ packages: { core: pkg({ command: "pwd", cwd: "nope" }) } });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_STALE");
    expect(result.error.message).toContain(join(run.root, "nope"));
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL3: packages with no baseline key or a null one are not run and not listed", async () => {
    const run = await setup({
      packages: {
        core: pkg("echo core"),
        missing: pkg(undefined),
        off: { path: ".", commands: { baseline: null, test: "touch marker" } },
      },
    });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(Object.keys(result.value.baseline.packages)).toEqual(["core"]);
    expect(result.value.baseline.workspace).toBeNull();
    expect(existsSync(join(run.root, "marker"))).toBe(false);
  });

  test("BL5: a command that cannot start stops with CONFIG_STALE and writes nothing", async () => {
    const run = await setup({ packages: { core: pkg("definitely-not-a-command") } });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_STALE");
    expect(result.error.message).toContain("definitely-not-a-command");
    expect(result.error.message).toContain("core");
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test.each([
    ["bun's missing script", `echo 'error: Script not found "baseline"' >&2; exit 1`],
    ["bun's empty filter", `echo "error: No packages matched the filter" >&2; exit 1`],
    ["npm's missing script", `echo "error: Missing script: baseline" >&2; exit 1`],
  ])("BL5: %s stops with CONFIG_STALE and writes nothing", async (_, command) => {
    const run = await setup({ packages: { core: pkg(command) } });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_STALE");
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL5: a red suite whose stderr mentions a missing command is recorded as a result", async () => {
    const command = `echo "1 failing"; echo "sh: foo: command not found" >&2; exit 1`;
    const run = await setup({ packages: { core: pkg(command) } });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.packages.core).toEqual({
      command,
      exitCode: 1,
      output: "1 failing",
    });
  });

  test("BL6: a package script past its timeout is killed and recorded as 124 with its output so far", async () => {
    const run = await setup({
      packages: { core: { ...pkg("echo partial; sleep 5"), timeoutSeconds: 1 } },
    });
    const started = Date.now();

    const result = await capture(run);

    expect(Date.now() - started).toBeLessThan(5000);
    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.packages.core).toMatchObject({ exitCode: 124, output: "partial" });
  });

  test("BL7: named packages run with the workspace script; an unknown name stops with PACKAGE_UNKNOWN", async () => {
    const run = await setup({
      baseline: "echo ws",
      packages: { core: pkg("echo core"), cli: pkg("touch cli-ran") },
    });

    const result = await capture(run, { packages: ["core"] });

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace?.output).toBe("ws");
    expect(Object.keys(result.value.baseline.packages)).toEqual(["core"]);
    expect(existsSync(join(run.root, "cli-ran"))).toBe(false);

    const unknown = await capture(run, { packages: ["nope"] });
    if (unknown.ok) throw new Error("expected a failure");
    expect(unknown.error.code).toBe("PACKAGE_UNKNOWN");
    expect(unknown.error.message).toContain("nope");
  });

  test("BL8: with no baseline script anywhere, nothing runs or is written", async () => {
    const run = await setup({ packages: { core: pkg(undefined) } });

    const result = await capture(run);

    expect(result).toEqual({ ok: true, value: null });
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL9: --dir wins over the recorded workspace.path", async () => {
    const run = await setup({
      baseline: "pwd > where",
      packages: { core: pkg("pwd > where-core") },
    });
    const dir = tempDir();

    const result = await capture(run, { dir });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "where"), "utf8").trim()).toBe(dir);
    expect(readFileSync(join(dir, "where-core"), "utf8").trim()).toBe(dir);
    expect(existsSync(join(run.root, "where"))).toBe(false);
  });

  test("BL9: with no --dir and no stored state, it stops with STATE_MISSING", async () => {
    const run = await setup({ baseline: "echo hi" }, { state: false });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("STATE_MISSING");
    expect(result.error.message).toContain("--dir");
  });

  test.each([
    ["a --dir that does not exist", (dir: string) => join(dir, "gone"), false],
    [
      "a --dir that is a file, not a folder",
      (dir: string) => {
        writeFileSync(join(dir, "a-file"), "");
        return join(dir, "a-file");
      },
      false,
    ],
    [
      "a recorded workspace.path that no longer exists",
      (dir: string) => join(dir, "removed"),
      true,
    ],
  ])("BL9: %s stops with WORKTREE_MISSING naming it", async (_label, missing, inState) => {
    const gone = missing(tempDir());
    const run = await setup(
      { packages: { core: pkg("echo core") } },
      inState ? { workspace: gone } : {},
    );

    const result = await capture(run, inState ? {} : { dir: gone });

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKTREE_MISSING", message: `no run folder at ${gone}` },
    });
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL9: in multi layout a package script runs in its own folder under the workspace", async () => {
    const run = await setup({
      workspace: { layout: "multi" },
      packages: { api: pkg("pwd > where", "api") },
    });
    const dir = tempDir();
    mkdirSync(join(dir, "api"));

    await capture(run, { dir });

    expect(readFileSync(join(dir, "api", "where"), "utf8").trim()).toBe(join(dir, "api"));
  });

  const multiWithoutWeb = async () => {
    const run = await setup({
      workspace: { layout: "multi" },
      baseline: "touch ws-ran",
      packages: { api: pkg("echo api", "api"), web: pkg("echo web", "web") },
    });
    const dir = tempDir();
    mkdirSync(join(dir, "api"));
    return { run, dir };
  };

  test("BL13: in multi layout a default run skips a package with no worktree", async () => {
    const { run, dir } = await multiWithoutWeb();

    const result = await capture(run, { dir });

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(Object.keys(result.value.baseline.packages)).toEqual(["api"]);
  });

  test("BL13: in multi layout a named package with no worktree stops with WORKTREE_MISSING before anything runs", async () => {
    const { run, dir } = await multiWithoutWeb();

    const result = await capture(run, { dir, packages: ["web"] });

    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toEqual({
      code: "WORKTREE_MISSING",
      message: `web: no worktree at ${join(dir, "web")}`,
    });
    expect(existsSync(join(dir, "ws-ran"))).toBe(false);
  });
});
