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
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  ERROR_MESSAGE_LIMIT,
  type JsonValue,
  runDirOf,
  type SavedPolicies,
  type WorkflowRun,
} from "@yok/sdk";
import { appendRunEvent, jsonlEventStore, RegistryFileSchema } from "@yok/sdk/internal";
import { validateTicketDir } from "../../../skills/ticket-fetcher/scripts/ticket.ts";
import { DEMO_STAGES, type DemoStage, writeStages } from "./workflow/test-stages.ts";

const CLI = join(import.meta.dir, "..", "..", "cli", "src", "index.ts");

// One --artifact value for a file the node wrote, named after its type.
const fileArtifact = (type: string, path: string): string =>
  JSON.stringify({ type, name: type, path });

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "orchestrate-")));

const makeRepo = (dir: string, ignored: string): string => {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ignored);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const tempRepo = (): string => makeRepo(tempDir(), ".worktrees/\n.yok/\n");

const savedRun = (cwd: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => {
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(
    workflowPath,
    'name: ok\nnodes:\n  - { id: a, type: exec, input: null, runtime: sh, script: "true" }\n',
  );
  return {
    id: "r-1",
    workflow: "ok",
    workflowPath,
    inputs: { prompt: "hi" },
    cwd,
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
};

const writeRegistry = (home: string, runs: readonly WorkflowRun[]): void => {
  mkdirSync(home, { recursive: true });
  const file = { version: 1, runs: Object.fromEntries(runs.map((run) => [run.id, run])) };
  writeFileSync(join(home, "registry.json"), JSON.stringify(file));
};

const readRegistry = (home: string) =>
  RegistryFileSchema.parse(JSON.parse(readFileSync(join(home, "registry.json"), "utf8")));

// An initialized run named NAME in cwd, as `orchestrate init` leaves it.
const initializedRun = (home: string, cwd: string, name = "feat-x"): WorkflowRun => {
  const run = savedRun(cwd, { name });
  writeRegistry(home, [run]);
  mkdirSync(runDirOf(cwd, name), { recursive: true });
  return run;
};

const eventsOf = (cwd: string, name = "feat-x") => jsonlEventStore(runDirOf(cwd, name)).read();

type Env = Readonly<Record<string, string | undefined>>;

// A run id or yok home from the shell running the tests must never reach a real registry.
const orchestrate = (
  cwd: string,
  home: string,
  args: readonly string[],
  env: Env = {},
  input = "",
) => {
  const run = spawnSync("bun", ["--no-env-file", CLI, "orchestrate", ...args], {
    cwd,
    encoding: "utf8",
    input,
    // A FORCE_COLOR in the caller's shell would color the error text the tests parse as JSON.
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      YOK_RUN_ID: undefined,
      YOK_HOME: home,
      ...env,
    },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

const orchestrateAsync = async (
  cwd: string,
  home: string,
  args: readonly string[],
  env: Env = {},
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> => {
  const child = Bun.spawn(["bun", "--no-env-file", CLI, "orchestrate", ...args], {
    cwd,
    // A FORCE_COLOR in the caller's shell would color the error text the tests parse as JSON.
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      YOK_RUN_ID: undefined,
      YOK_HOME: home,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

describe("SC26: orchestrate init", () => {
  test("SC23: init NAME --run-id prints { runId, name, dir }, writes state.json there, and names the run in the registry", () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login", "--run-id", "r-1"]);

    expect(init.code).toBe(0);
    const dir = join(repo, ".yok", "fix-login");
    expect(JSON.parse(init.stdout)).toEqual({ runId: "r-1", name: "fix-login", dir });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(readRegistry(home).runs["r-1"]?.name).toBe("fix-login");
  });

  test("init --derived with a taken name prints the name it gave the run, NAME plus the run id's last 4 characters", () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo, { id: "r-0a1b2c3d" })]);
    mkdirSync(runDirOf(repo, "fix-login"), { recursive: true });

    const init = orchestrate(repo, home, ["init", "fix-login", "--derived"], {
      YOK_RUN_ID: "r-0a1b2c3d",
    });

    expect([init.code, init.stderr]).toEqual([0, ""]);
    const dir = join(repo, ".yok", "fix-login-2c3d");
    expect(JSON.parse(init.stdout)).toEqual({ runId: "r-0a1b2c3d", name: "fix-login-2c3d", dir });
    expect(readRegistry(home).runs["r-0a1b2c3d"]?.name).toBe("fix-login-2c3d");
  });

  test("SC24: init with no --run-id and no YOK_RUN_ID exits 1 with the no-run message", () => {
    const init = orchestrate(tempRepo(), tempDir(), ["init", "fix-login"]);

    expect(init.code).toBe(1);
    expect(init.stderr.trim()).not.toBe("");
  });
});

describe("SC26: orchestrate link-session", () => {
  test("SC22: link-session --run NAME records the session once and prints the run's sessions", () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const args = ["link-session", "--run", "feat-x", "--agent", "codex", "--session-id", "s2"];

    const first = orchestrate(repo, home, args);
    const second = orchestrate(repo, home, args);

    expect(first.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual([{ agent: "codex", sessionId: "s2" }]);
    expect(readRegistry(home).runs["r-1"]?.sessions).toEqual([{ agent: "codex", sessionId: "s2" }]);
  });
});

describe("SC26: orchestrate emit", () => {
  test("SC22: emit --run NAME stores the event under the run's id and prints it", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);

    const emit = orchestrate(repo, home, [
      "emit",
      "custom.review.note",
      "--run",
      "feat-x",
      "--source",
      "review-skill",
      "--payload",
      '{"files":3}',
      "--node-id",
      "review",
      "--node-run-id",
      "review",
      "--stage",
      "review",
      "--id",
      "note-1",
    ]);

    expect(emit.code).toBe(0);
    const printed = JSON.parse(emit.stdout);
    expect(printed).toMatchObject({
      type: "custom.review.note",
      source: "review-skill",
      runId: "r-1",
      payload: { files: 3 },
      nodeId: "review",
      nodeRunId: "review",
      stage: "review",
      id: "note-1",
    });
    expect((await eventsOf(repo)).at(-1)).toEqual(printed);
  });

  test("SC28: emit to a name no run has exits 1 naming it", () => {
    const repo = tempRepo();

    const emit = orchestrate(repo, tempDir(), [
      "emit",
      "custom.x.y",
      "--run",
      "ghost",
      "--source",
      "x",
    ]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain('no run named "ghost"');
  });

  test("emit cannot bypass stage completion verification with a lifecycle event", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const before = (await eventsOf(repo)).length;
    const attempted = orchestrate(repo, home, [
      "emit",
      "workflow.node.completed",
      "--run",
      "feat-x",
      "--source",
      "stage",
      "--node-id",
      "make",
      "--node-run-id",
      "nr-1",
      "--payload",
      '{"nodeType":"agent","attempts":1}',
    ]);
    expect(attempted.code).toBe(1);
    expect(attempted.stderr).toContain("workflow.node.completed");
    expect(await eventsOf(repo)).toHaveLength(before);
  });

  test("SC519: emit policy.applied with a valid payload exits 1 as engine-written and stores nothing", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const before = await eventsOf(repo);
    const payload = { policy: "interaction", effect: "auto-approved", path: "artifacts/design.md" };
    const attempted = orchestrate(repo, home, [
      "emit",
      "policy.applied",
      "--run",
      "feat-x",
      "--source",
      "design",
      "--payload",
      JSON.stringify(payload),
    ]);
    expect(attempted.code).not.toBe(0);
    expect(attempted.stderr).toContain("policy.applied is written only by the engine");
    expect(await eventsOf(repo)).toEqual(before);
  });

  test.each([
    ["SC24: a payload that is not JSON", ["--source", "s", "--payload", "{oops"], "--payload"],
    ["SC30: no --source", [], "--source"],
  ])("%s exits 1 naming the flag and stores nothing", async (_label, flags, flag) => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);

    const emit = orchestrate(repo, home, ["emit", "custom.x.y", "--run", "feat-x", ...flags]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain(flag);
    expect(await eventsOf(repo)).toEqual([]);
  });
});

const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
};

const DEMO_SKILL = `---
name: demo
description: A demo skill.
mode: inline
allowed-tools: [Bash]
tier: fast
inputs:
  description: Anything.
  schema: demo.input.v1
outputs:
  description: Anything.
  schema: demo.output.v1
protocols: []
scopes: []
references:
  notes:
    path: notes.md
    description: Notes.
---
`;

const demoSkills = (): string => {
  const skillsDir = tempDir();
  mkdirSync(join(skillsDir, "demo"));
  writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
  writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
  return skillsDir;
};

const configuredRepo = (config: object): string => {
  const root = tempRepo();
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
  return root;
};

describe("SC26: orchestrate skill", () => {
  test("WS32 — skill ref with an extend prints the base text, a blank line, then the extension", () => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({
      extensions: { demo: { references: { notes: { extend: "notes-extra.md" } } } },
    });
    writeFileSync(join(root, "notes-extra.md"), "extension text\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "demo.notes"], {
      YOK_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("base text\n\nextension text\n");
  });

  test.each([
    [
      "the skill's own file",
      {},
      (skillsDir: string, _root: string) => join(skillsDir, "demo/notes.md"),
    ],
    [
      "the project's file when it replaces the reference",
      { demo: { references: { notes: { replace: "my-notes.md" } } } },
      (_skillsDir: string, root: string) => join(root, "my-notes.md"),
    ],
  ])("skill ref --path prints the path of %s", (_case, extensions, expected) => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({ extensions });
    writeFileSync(join(root, "my-notes.md"), "project text\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "--path", "demo.notes"], {
      YOK_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(expected(skillsDir, root));
  });

  test("skill ref with no YOK_SKILLS_DIR reads the yok repo's own skills folder", () => {
    const shipped = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "skills",
      "create-workspace",
      "references",
      "select-repos.md",
    );

    const run = orchestrate(
      configuredRepo({}),
      tempDir(),
      ["skill", "ref", "create-workspace.select-repos"],
      {
        YOK_SKILLS_DIR: undefined,
      },
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(readFileSync(shipped, "utf8"));
  });

  test("skill ref --list SKILL prints the skill's references and the project's added ones as JSON", () => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({
      extensions: {
        demo: { references: { jira: { add: "jira.md", description: "Jira issues." } } },
      },
    });
    writeFileSync(join(root, "jira.md"), "jira\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "--list", "demo"], {
      YOK_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { name: "notes", description: "Notes." },
      { name: "jira", description: "Jira issues." },
    ]);
  });

  test.each([
    ["without a dot between skill and reference shows the form", {}, "baseline", "STAGE.REF"],
    ["WS33 — for a skill that does not exist names the skill", {}, "missing.notes", "missing"],
    [
      "on a reference the project made a command points at skill run",
      { demo: { references: { notes: { command: "echo hi" } } } },
      "demo.notes",
      "demo.notes is a command; run it with skill run",
    ],
  ])("skill ref %s and exits 1", (_case, extensions, ref, message) => {
    const run = orchestrate(configuredRepo({ extensions }), tempDir(), ["skill", "ref", ref], {
      YOK_SKILLS_DIR: demoSkills(),
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
  });

  test("skill extension prints the project's extension doc for the skill, and nothing without one", () => {
    const skillsDir = demoSkills();
    const root = configuredRepo({ extensions: { demo: { skill: "demo-extra.md" } } });
    writeFileSync(join(root, "demo-extra.md"), "use pnpm\n");
    const env = { YOK_SKILLS_DIR: skillsDir };

    const run = orchestrate(root, tempDir(), ["skill", "extension", "demo"], env);
    const none = orchestrate(configuredRepo({}), tempDir(), ["skill", "extension", "demo"], env);

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("use pnpm\n");
    expect([none.code, none.stdout]).toEqual([0, ""]);
  });

  test("inside a run, skill ref review.x reads the project skill the run's workflow names review", () => {
    const { repo, home } = startedRun(
      "name: r\nnodes:\n  - { id: check, type: agent, stage: stages/review, input: {} }\n",
      undefined,
      {},
      {
        stages: { review: { references: "{ x: { path: x.md, description: X. } }" } },
        files: { "stages/review/x.md": "review x\n" },
      },
    );

    const run = orchestrate(repo, home, ["skill", "ref", "review.x"], {
      YOK_RUN_ID: "r-1",
      YOK_SKILLS_DIR: tempDir(),
    });

    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("review x\n");
  });
});

// A run named feat-x in a fresh repo, started from SOURCE the way `yok run` + init leave it.
// init compiles the workflow, so env must name the skills folder its stages come from, stages
// holds the project stages it names under stages/ and files what else it reads (schema modules,
// included workflows, extensions), by path in the repo.
const startedRun = (
  source: string,
  config?: object,
  overrides: Partial<WorkflowRun> = {},
  {
    env = { YOK_SKILLS_DIR: STAGE_SKILLS },
    files = {},
    stages = {},
  }: Readonly<{
    env?: Env;
    files?: Readonly<Record<string, string>>;
    stages?: Readonly<Record<string, DemoStage>>;
  }> = {},
): Readonly<{ repo: string; home: string }> => {
  const repo = config === undefined ? tempRepo() : configuredRepo(config);
  const home = tempDir();
  const workflowPath = join(repo, "steps.yaml");
  writeFileSync(workflowPath, source);
  if (Object.keys(stages).length > 0) writeStages(join(repo, "stages"), stages);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  writeRegistry(home, [savedRun(repo, { workflowPath, ...overrides })]);
  const init = orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"], env);
  if (init.code !== 0) throw new Error(init.stderr);
  return { repo, home };
};

const stateOf = (repo: string) =>
  JSON.parse(readFileSync(join(runDirOf(repo, "feat-x"), "state.json"), "utf8"));

const STEPS = `name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: sh
    script: printf '{"n":1}'
    output: { zodSchema: Json }
    input: {}
  - id: w
    type: wait
    durationMs: 10
    dependsOn: [a]
    input: "{{ nodes.a.output }}"
  - id: b
    type: exec
    runtime: sh
    script: cat
    dependsOn: [w]
    input: "{{ nodes.w.output }}"
`;

const WORKTREE_CONFIG = {
  extensions: {
    producer: { skill: "docs/producer-ext.md", references: { demo: { add: "docs/demo.md" } } },
  },
};

// A run started in a linked worktree of a repo whose main checkout has a config without the
// worktree's extensions, initialized the way yok run + init leave it.
const worktreeRun = (runOverrides: Partial<WorkflowRun> = {}) => {
  const main = configuredRepo({});
  const worktree = join(main, ".worktrees", "dev");
  execFileSync("git", ["worktree", "add", "-q", "-b", "dev", worktree], { cwd: main });
  writeFileSync(
    join(worktree, "orchestrate.config.json"),
    JSON.stringify({ version: 2, ...WORKTREE_CONFIG }),
  );
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "docs/demo.md"), "worktree-only reference\n");
  writeFileSync(join(worktree, "docs/producer-ext.md"), "producer rules\n");
  const home = tempDir();
  const workflowPath = join(worktree, "stages.yaml");
  writeFileSync(workflowPath, STAGES_WORKFLOW);
  writeRegistry(home, [savedRun(worktree, { workflowPath, ...runOverrides })]);
  const env = { YOK_SKILLS_DIR: stageSkills() };
  const init = orchestrate(worktree, home, ["init", "feat-x", "--run-id", "r-1"], env);
  if (init.code !== 0) throw new Error(init.stderr);
  return { main, worktree, home, env };
};

describe("SC26: a run started in a linked worktree", () => {
  test("VER-289: skill ref and next, given no flags inside the run's session, read the worktree's config that main lacks", () => {
    const { main, worktree, home, env } = worktreeRun();
    const session = { ...env, YOK_RUN_ID: "r-1" };

    const ref = orchestrate(main, home, ["skill", "ref", "producer.demo"], session);
    const next = orchestrate(main, home, ["next"], session);

    expect(ref.stdout).toBe("worktree-only reference\n");
    expect(ref.code).toBe(0);
    expect(next.code).toBe(0);
    const reply = JSON.parse(next.stdout);
    expect(reply.extension).toBe(join(worktree, "docs/producer-ext.md"));
    expect(reply.done).toBe(`yok orchestrate done ${reply.nodeRunId} --run feat-x`);
  });
});

describe("SC26: picking the run", () => {
  test("--run-id picks the run from a folder outside any repo", () => {
    const { home, env } = worktreeRun();

    const next = orchestrate(tempDir(), home, ["next", "--run-id", "r-1"], env);

    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout).nodeId).toBe("make");
  });

  test("SC11: next finds its run from $YOK_RUN_ID, a --run-id flag wins over it, and the old variable is not read", () => {
    const { worktree, home, env } = worktreeRun();
    const workflowPath = join(worktree, "stages.yaml");
    writeRegistry(home, [
      ...Object.values(readRegistry(home).runs),
      savedRun(worktree, { id: "r-2", workflowPath }),
    ]);
    expect(orchestrate(worktree, home, ["init", "feat-y", "--run-id", "r-2"], env).code).toBe(0);
    const runOf = (result: ReturnType<typeof orchestrate>) => JSON.parse(result.stdout).done;

    const fromEnv = orchestrate(worktree, home, ["next"], { ...env, YOK_RUN_ID: "r-1" });
    const fromFlag = orchestrate(worktree, home, ["next", "--run-id", "r-2"], {
      ...env,
      YOK_RUN_ID: "r-1",
    });
    // Split so the sweep for the old product name (SC10) does not flag this test.
    const oldOnly = orchestrate(worktree, home, ["next"], {
      ...env,
      [`${["HAR", "NESS"].join("")}_RUN_ID`]: "r-1",
    });

    expect(runOf(fromEnv)).toContain("--run feat-x");
    expect(runOf(fromFlag)).toContain("--run feat-y");
    expect(oldOnly.code).toBe(1);
    expect(oldOnly.stderr).toContain("no run: pass --run or --run-id");
  });

  test("done's refusal names the run id that picked a run it cannot find", () => {
    const { worktree, home } = worktreeRun();

    const done = orchestrate(
      worktree,
      home,
      ["done", "nr-1", "--summary", "Did the work.", "--output", "x"],
      {
        YOK_RUN_ID: "r-ghost",
      },
    );

    expect(done.code).toBe(1);
    expect(JSON.parse(done.stderr)).toMatchObject({
      kind: "configuration",
      code: "run",
      path: "r-ghost",
      message: "run r-ghost not found",
    });
  });
});

describe("SC26: orchestrate next and exec", () => {
  test("IW10 — next and exec, called in turn, take an exec, wait and exec workflow from init to finished", async () => {
    const { repo, home } = startedRun(STEPS);
    const handedOut = ["a", "w", "b"].map((nodeId) => {
      const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);
      expect(next.code).toBe(0);
      const reply = JSON.parse(next.stdout);
      expect(reply).toEqual({
        kind: "exec",
        nodeRunId: expect.stringMatching(/^nr-[0-9a-f]{16}$/),
        nodeId,
        mode: "inline",
        command: `yok orchestrate exec ${reply.nodeRunId} --run feat-x`,
      });
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(exec.code).toBe(0);
      expect(JSON.parse(exec.stdout)).toEqual({
        nodeRunId: reply.nodeRunId,
        nodeId,
        status: "completed",
        attempts: 1,
      });
      return reply.nodeRunId;
    });

    const last = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(JSON.parse(last.stdout)).toEqual({ kind: "finished", status: "completed" });
    const state = stateOf(repo);
    expect(state).toMatchObject({ runId: "r-1", runName: "feat-x", status: "completed" });
    expect(state.nodeRuns.w.nodeRunId).toBe(handedOut[1]);
    expect(state.nodeRuns.w.output).toEqual({ n: 1 });
    expect(state.nodeRuns.b).toMatchObject({ nodeType: "exec", output: '{"n":1}' });
    expect(state.nodeRuns.b).not.toHaveProperty("process");
    const ended = (await eventsOf(repo)).find(
      (event) => event.nodeRunId === handedOut[2] && event.type === "workflow.node.completed",
    );
    expect(ended?.payload).toMatchObject({
      output: '{"n":1}',
      process: { stdout: '{"n":1}', stderr: "", exitCode: 0 },
    });
  });

  const execAll = (repo: string, home: string, count: number) =>
    Array.from({ length: count }, () => {
      const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(exec.stderr).toBe("");
      expect(exec.code).toBe(0);
      return reply.nodeId;
    });

  test("SC87: a runtime: bun exec node runs through yok orchestrate script from a file in the run's scripts folder, reused for the same text", () => {
    const node = (id: string, extra = "") => `  - id: ${id}
    type: exec
    runtime: bun
    output: { zodSchema: Json }
    input: { id: ${id} }${extra}
    script: |
      import { appendFileSync } from "node:fs";
      const input = await Bun.stdin.json();
      appendFileSync(process.cwd() + "/argv.txt", process.argv[1] + "\\n");
      process.stdout.write(JSON.stringify({ n: 1, seen: Object.keys(input).length }));
`;
    const { repo, home } = startedRun(
      `name: steps\ninputs:\n  prompt: { type: string, required: true }\nnodes:\n${node("a")}${node("b", "\n    dependsOn: [a]")}`,
    );

    expect(execAll(repo, home, 2)).toEqual(["a", "b"]);

    const state = stateOf(repo);
    expect(state.nodeRuns.a.output).toEqual({ n: 1, seen: 1 });
    const [first, second] = readFileSync(join(repo, "argv.txt"), "utf8").trim().split("\n");
    expect(first).toStartWith(`${join(runDirOf(repo, "feat-x"), "scripts")}/`);
    expect(first).toEndWith(".ts");
    expect(second).toBe(first);
  });

  test("SC96: an inline bun script outside the checkout imports @yok/sdk and zod with no node_modules", () => {
    const { repo, home } = startedRun(`name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: bun
    input: {}
    script: |
      import { NonEmptyStringSchema } from "@yok/sdk";
      import { z } from "zod";
      NonEmptyStringSchema.parse("x");
      z.string().parse("y");
      process.stdout.write("ok");
`);
    expect(existsSync(join(repo, "node_modules"))).toBe(false);

    expect(execAll(repo, home, 1)).toEqual(["a"]);

    expect(stateOf(repo).nodeRuns.a).toMatchObject({ status: "completed", output: "ok" });
  });

  test("IW11 — a script that keeps failing is retried as configured, exec exits 1, and the run ends failed", async () => {
    const { repo, home } = startedRun(`name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: sh
    script: exit 3
    retry: { maxAttempts: 2 }
    input: {}
`);
    const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(exec.code).toBe(1);
    expect(JSON.parse(exec.stdout)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: { kind: "exit" },
    });
    expect(JSON.parse(exec.stdout).error).not.toHaveProperty("stack");
    const failed = (await eventsOf(repo)).find((event) => event.type === "workflow.node.failed");
    expect(failed?.payload).toMatchObject({ process: { stdout: "", stderr: "", exitCode: 3 } });
    expect(failed?.payload).not.toHaveProperty("output");
    expect(stateOf(repo).nodeRuns.a.output).toEqual({
      kind: "exit",
      message: `${reply.nodeRunId} exited with code 3`,
    });
    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(JSON.parse(next.stdout)).toEqual({ kind: "finished", status: "failed" });
  });

  test("IW12 — exec refuses a node run that already ended or does not exist, recording only the refused calls", async () => {
    const { repo, home } = startedRun(STEPS);
    const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    const before = (await eventsOf(repo)).length;
    const stateBefore = stateOf(repo);

    const again = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(reply.nodeRunId);
    const unknown = orchestrate(repo, home, ["exec", "nr-00000000", "--run", "feat-x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nr-00000000");
    const added = (await eventsOf(repo)).slice(before);
    expect(added.map((event) => event.payload)).toEqual([
      {
        input: { nodeRunId: reply.nodeRunId },
        output: { kind: "error", message: again.stderr.trim() },
      },
      {
        input: { nodeRunId: "nr-00000000" },
        output: { kind: "error", message: unknown.stderr.trim() },
      },
    ]);
    expect(added.map((event) => event.type)).toEqual(["orchestrate.exec", "orchestrate.exec"]);
    expect(stateOf(repo)).toEqual({ ...stateBefore, lastEventSeq: before + 2 });
  });
});

// A skills folder holding the producer and consumer demo stages, for YOK_SKILLS_DIR.
const stageSkills = (produces = DEMO_STAGES.producer.produces): string => {
  const dir = tempDir();
  writeStages(dir, { ...DEMO_STAGES, producer: { produces } });
  return dir;
};

const STAGE_SKILLS = stageSkills();

const STAGES_WORKFLOW = `name: stages
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: make
    type: agent
    stage: producer
    input: { request: "{{ inputs.prompt }}" }
  - id: use
    type: agent
    stage: consumer
    dependsOn: [make]
    input: {}
`;

describe("SC26: subscribers", () => {
  test("SC116: a config subscriber on workflow.node.completed fires when done completes a node", async () => {
    const skills = stageSkills();
    const { repo, home } = startedRun(STAGES_WORKFLOW, {
      subscribers: { "workflow.node.completed": [{ name: "touch", command: "cat > fired.json" }] },
    });
    const step = (args: readonly string[]) =>
      orchestrate(repo, home, args, { YOK_SKILLS_DIR: skills });
    const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");

    const done = step([
      ...[
        "done",
        make.nodeRunId,
        "--run",
        "feat-x",
        "--summary",
        "Did the work.",
        "--output",
        "{}",
      ],
      ...["--artifact", fileArtifact("plan", "artifacts/plan.md")],
    ]);

    expect(done.code).toBe(0);
    const fired = JSON.parse(readFileSync(join(repo, "fired.json"), "utf8"));
    expect(fired.event).toMatchObject({ type: "workflow.node.completed", nodeId: "make" });
    expect(fired.state).toMatchObject({ runName: "feat-x", lastEventSeq: fired.event.seq });
    const calls = (await eventsOf(repo)).filter((event) => event.type === "subscriber.called");
    expect(calls.map((call) => call.payload)).toMatchObject([
      { subscriber: "touch", eventId: fired.event.id, status: "ok" },
    ]);
  });
});

describe("SC26: the samskara upload", () => {
  // A samskara on PATH that records its arguments and refuses the session, as an unpaired CLI does.
  const failingSamskara = () => {
    const bin = tempDir();
    const argsFile = join(bin, "args.txt");
    writeFileSync(
      join(bin, "samskara"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\necho "Session s1 does not exist, or is not yours." >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    return { env: { PATH: `${bin}:${process.env.PATH}` }, argsFile };
  };

  const samskaraCalls = (repo: string) =>
    readFileSync(join(runDirOf(repo, "feat-x"), "event.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "subscriber.called")
      .filter((event) => event.payload.subscriber === "samskara");

  test("SC410: with samskara on, a completed node's failed upload is a failed subscriber.called naming exit 1, and next still hands out the following node", async () => {
    const samskara = failingSamskara();
    // init copies the registry's sessions into the state's activeSessions.
    const sessions = [{ agent: "claude" as const, sessionId: "s1" }];
    const { repo, home } = startedRun(STAGES_WORKFLOW, { samskara: {} }, { sessions });
    const step = (args: readonly string[]) =>
      orchestrate(repo, home, args, { YOK_SKILLS_DIR: STAGE_SKILLS, ...samskara.env });
    const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const runDir = runDirOf(repo, "feat-x");
    writeFileSync(join(runDir, "artifacts", "plan.md"), "plan\n");

    const done = step([
      ...["done", make.nodeRunId, "--run", "feat-x", "--summary", "Did the work."],
      ...["--output", "{}", "--artifact", fileArtifact("plan", "artifacts/plan.md")],
    ]);

    expect(done.code).toBe(0);
    await waitFor(() => samskaraCalls(repo).length > 0);
    const [call] = samskaraCalls(repo);
    expect(call.payload).toMatchObject({ status: "failed" });
    expect(call.payload.error.message).toContain("exit 1");
    const realRunDir = realpathSync(runDir);
    expect(readFileSync(samskara.argsFile, "utf8").trim().split("\n")).toEqual([
      ...["artifacts", "upload", "s1", join(realRunDir, "artifacts", "plan.md")],
      ...["--base-dir", realRunDir],
    ]);
    expect(JSON.parse(step(["next", "--run", "feat-x"]).stdout)).toMatchObject({ nodeId: "use" });
  }, 30_000);

  test("SC407: done on a node that ran in claude session s1 names s1 in its workflow.node.completed event", async () => {
    const sessions = [{ agent: "claude" as const, sessionId: "s1" }];
    const { repo, home } = startedRun(STAGES_WORKFLOW, undefined, { sessions });
    const step = (args: readonly string[]) =>
      orchestrate(repo, home, args, { YOK_SKILLS_DIR: STAGE_SKILLS });
    const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");

    step([
      ...["done", make.nodeRunId, "--run", "feat-x", "--summary", "Did the work."],
      ...["--output", "{}", "--artifact", fileArtifact("plan", "artifacts/plan.md")],
    ]);

    const completed = (await eventsOf(repo)).find(
      (event) => event.type === "workflow.node.completed",
    );
    expect(completed?.payload).toMatchObject({ session: { agent: "claude", sessionId: "s1" } });
  }, 30_000);
});

describe("SC26: stage verifiers", () => {
  const verifiedRun = (verifiers: string | undefined, workflow = STAGES_WORKFLOW) => {
    const skills = tempDir();
    writeStages(skills, {
      producer: { produces: DEMO_STAGES.producer.produces },
      consumer: { consumes: DEMO_STAGES.consumer.consumes, ...(verifiers ? { verifiers } : {}) },
    });
    const run = startedRun(workflow);
    const env = { YOK_SKILLS_DIR: skills };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    const artifactsDir = join(runDirOf(run.repo, "feat-x"), "artifacts");
    const finishProducer = () => {
      const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
      writeFileSync(join(artifactsDir, "plan.md"), "plan\n");
      const done = step([
        ...[
          "done",
          make.nodeRunId,
          "--run",
          "feat-x",
          "--summary",
          "Did the work.",
          "--output",
          "{}",
        ],
        ...["--artifact", fileArtifact("plan", "artifacts/plan.md")],
      ]);
      expect(done.code).toBe(0);
      return JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    };
    const finish = (nodeRunId: string) =>
      step([
        "done",
        nodeRunId,
        "--run",
        "feat-x",
        "--summary",
        "Did the work.",
        "--output",
        '{"ok":true}',
      ]);
    return { ...run, step, finishProducer, finish, artifactsDir };
  };

  const fn = (id: string, functionName: string, extra = "") =>
    `{ id: ${id}, module: ../verifiers.ts, functionName: ${functionName}${extra} }`;

  const refusal = (stderr: string) => JSON.parse(stderr);

  test("pass: false returns a retryable validation with the findings and keeps the node open", () => {
    const { repo, finishProducer, finish } = verifiedRun(`[${fn("lint", "fail")}]`);
    const use = finishProducer();
    const refused = finish(use.nodeRunId);
    expect(refused.code).toBe(1);
    expect(refusal(refused.stderr)).toEqual({
      kind: "validation",
      retryable: true,
      nodeRunId: use.nodeRunId,
      issues: [
        {
          kind: "verifier",
          verifier: "lint",
          findings: [{ message: "fail one", path: "a.ts", line: 3, hint: "fix a" }],
        },
      ],
    });
    expect(stateOf(repo).nodeRuns.use.status).toBe("running");
  });

  test("SC31: a function verifier receives its input, args and context", () => {
    const file = join(tempDir(), "seen.json");
    const args = `, args: { file: ${JSON.stringify(file)} }`;
    const workflow = STAGES_WORKFLOW.replace("input: {}", "input: { source: review, round: 2 }");
    const { repo, finishProducer, step } = verifiedRun(`[${fn("rec", "record", args)}]`, workflow);
    const use = finishProducer();
    const pr = { type: "pull-request", name: "api", url: "https://github.com/o/r/pull/1" };
    const done = step([
      ...["done", use.nodeRunId, "--run", "feat-x", "--summary", "Did the work."],
      ...["--output", '{"ok":true}', "--artifact", fileArtifact("plan", "artifacts/plan.md")],
      ...["--artifact", JSON.stringify(pr)],
    ]);
    expect(done.code).toBe(0);
    const seen = JSON.parse(readFileSync(file, "utf8"));
    expect(seen.input).toEqual({
      run: "feat-x",
      nodeRunId: use.nodeRunId,
      output: { ok: true },
      artifacts: [
        { type: "plan", name: "plan", path: join(runDirOf(repo, "feat-x"), "artifacts/plan.md") },
        pr,
      ],
      args: { file },
      nodeInput: { source: "review", round: 2 },
    });
    expect(seen.cwd).toBe(repo);
    expect(seen.attempt).toBe(1);
  });

  test("SC31: the third rejected done fails the node for good, whatever the rejections were, however long", async () => {
    const file = join(tempDir(), "seen.json");
    const record = fn("rec", "record", `, args: { file: ${JSON.stringify(file)} }`);
    const { repo, finishProducer, finish, step } = verifiedRun(
      `[${fn("lint", "failLong")}, ${record}]`,
    );
    const use = finishProducer();
    const show = () =>
      JSON.parse(step(["node", "show", "--run", "feat-x", "--node-run", use.nodeRunId]).stdout);
    const schemaRefusal = step([
      "done",
      use.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      "[]",
    ]);
    expect(refusal(schemaRefusal.stderr).retryable).toBe(true);
    expect(show().attempt).toBe(2);

    const second = finish(use.nodeRunId);
    expect(second.stderr.length).toBeGreaterThan(500);
    expect(refusal(second.stderr).retryable).toBe(true);
    const seen = JSON.parse(readFileSync(file, "utf8"));
    expect(seen.attempt).toBe(2);

    const last = finish(use.nodeRunId);
    expect(last.code).toBe(1);
    expect(refusal(last.stderr)).toMatchObject({
      kind: "verify-exhausted",
      retryable: false,
      nodeRunId: use.nodeRunId,
      issues: [{ kind: "verifier", verifier: "lint" }],
    });
    expect(stateOf(repo).nodeRuns.use.status).toBe("failed");
    const again = finish(use.nodeRunId);
    expect(refusal(again.stderr)).toMatchObject({ kind: "not-running", retryable: false });
    const next = step(["next", "--run", "feat-x"]);
    expect(JSON.parse(next.stdout)).toEqual({ kind: "finished", status: "failed" });
  });

  test("node show prints the node run's facts as JSON", () => {
    const { repo, finishProducer, step, artifactsDir } = verifiedRun(undefined);
    const use = finishProducer();
    const shown = step(["node", "show", "--run", "feat-x", "--node-run", use.nodeRunId]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual({
      nodeRunId: use.nodeRunId,
      nodeId: "use",
      stage: "consumer",
      input: {},
      attempt: 1,
      consumed: { plan: join(artifactsDir, "plan.md") },
      runDir: runDirOf(repo, "feat-x"),
      artifactsDir,
    });
    const unknown = step(["node", "show", "--run", "feat-x", "--node-run", "nr-nope"]);
    expect(unknown.code).toBe(1);
  });
});

describe("SC26: orchestrate next and done with stages", () => {
  const stageRun = (
    produces?: string,
    config?: object,
    files: Readonly<Record<string, string>> = {},
  ) => {
    const skills = stageSkills(produces);
    const run = startedRun(STAGES_WORKFLOW, config, {}, { files });
    const env = { YOK_SKILLS_DIR: skills };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    return { ...run, skills, step };
  };

  test("SC9: IW17, SC23 — next replies with the stage's skill path, the project's extension path, its input, a done command and mode inline only", () => {
    const { repo, skills, step } = stageRun(
      undefined,
      { extensions: { producer: { skill: "docs/producer-ext.md" } } },
      { "docs/producer-ext.md": "use short names\n" },
    );
    const next = step(["next", "--run", "feat-x"]);
    expect(next.code).toBe(0);
    const reply = JSON.parse(next.stdout);
    expect(reply).toEqual({
      kind: "stage",
      nodeRunId: expect.stringMatching(/^nr-[0-9a-f]{16}$/),
      nodeId: "make",
      mode: "inline",
      stage: "producer",
      skill: join(skills, "producer/SKILL.md"),
      extension: join(repo, "docs/producer-ext.md"),
      input: { request: "hi" },
      variables: {},
      policies: { interaction: true },
      done: `yok orchestrate done ${reply.nodeRunId} --run feat-x`,
    });
  });

  test("SC508: init copies the saved policies into state.json, and the stage and agent replies carry interaction false", () => {
    const POLICED = `name: policed
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: make, type: agent, stage: plain, input: {} }
  - { id: plan, type: agent, prompt: plan it, dependsOn: [make], input: {} }
`;
    const policies: SavedPolicies = {
      values: { interaction: false },
      sources: { interaction: "workflow" },
    };
    const run = startedRun(POLICED, undefined, { policies });
    const step = (args: readonly string[]) =>
      orchestrate(run.repo, run.home, args, { YOK_SKILLS_DIR: STAGE_SKILLS });
    expect(stateOf(run.repo).policies).toEqual(policies);

    const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(make).toMatchObject({ kind: "stage", policies: { interaction: false } });

    const summary = ["--summary", "Made it.", "--output", "{}"];
    expect(step(["done", make.nodeRunId, "--run", "feat-x", ...summary]).code).toBe(0);
    const plan = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(plan).toMatchObject({ kind: "agent", policies: { interaction: false } });

    const unsaved = startedRun(POLICED);
    const first = orchestrate(unsaved.repo, unsaved.home, ["next", "--run", "feat-x"], {
      YOK_SKILLS_DIR: STAGE_SKILLS,
    });
    expect(JSON.parse(first.stdout)).toMatchObject({ policies: { interaction: true } });
  });

  test("next hands a stage its summary hint, and done records the summary in state", () => {
    const run = startedRun(`name: hinted
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: edit, type: agent, stage: summarized, input: {} }
  - { id: check, type: agent, stage: plain, notify: false, dependsOn: [edit], input: {} }
`);
    const step = (args: readonly string[]) =>
      orchestrate(run.repo, run.home, args, { YOK_SKILLS_DIR: STAGE_SKILLS });
    const edit = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(edit).toMatchObject({ nodeId: "edit", summaryHint: "Say how many files changed." });

    const summary = ["--summary", "Changed three files."];
    expect(
      step(["done", edit.nodeRunId, "--run", "feat-x", ...summary, "--output", "{}"]).code,
    ).toBe(0);
    const check = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(check).not.toHaveProperty("summaryHint");

    const nodes = stateOf(run.repo).nodeRuns;
    expect(nodes.edit).toMatchObject({ notify: true, summary: "Changed three files." });
    expect(nodes.check).toMatchObject({ notify: false });
  });

  test("init returns a typed compile error for a workflow with a broken output schema and makes no run folder", () => {
    const repo = tempRepo();
    const home = tempDir();
    const workflowPath = join(repo, "broken.yaml");
    writeFileSync(
      workflowPath,
      `name: broken\nnodes:\n  - id: ask\n    type: agent\n    prompt: Ask\n    input: null\n    output: { module: ./missing-schema.ts, zodSchema: answer }\n`,
    );
    writeRegistry(home, [savedRun(repo, { workflowPath })]);

    const init = orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"]);

    expect(init.code).toBe(1);
    expect(JSON.parse(init.stderr)).toMatchObject({
      kind: "compile",
      retryable: false,
      code: "missing-module",
    });
    expect(existsSync(runDirOf(repo, "feat-x"))).toBe(false);
  });

  test("IW18 — done records a stage's output and artifacts, and refuses an artifact file that does not exist", async () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(reply).toMatchObject({ kind: "stage", nodeId: "make", extension: null });
    const done = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      '{"ok":true}',
    ];
    const artifact = ["--artifact", fileArtifact("plan", "artifacts/plan.md")];

    const omitted = step(done);
    expect(omitted.code).toBe(1);
    expect(JSON.parse(omitted.stderr)).toMatchObject({
      kind: "validation",
      retryable: true,
      nodeRunId: reply.nodeRunId,
      issues: [{ kind: "required-artifact", name: "plan" }],
    });
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");

    const missing = step([...done, ...artifact]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(join(runDirOf(repo, "feat-x"), "artifacts/plan.md"));
    expect((await eventsOf(repo)).map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.node.started",
      "orchestrate.next",
      "orchestrate.done",
      "orchestrate.done",
    ]);

    mkdirSync(join(runDirOf(repo, "feat-x"), "artifacts"), { recursive: true });
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts/plan.md"), "plan\n");
    const recorded = step([...done, ...artifact]);
    expect(recorded.code).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ nodeId: "make", status: "completed" });
    expect(stateOf(repo).nodeRuns.make).toMatchObject({
      nodeRunId: reply.nodeRunId,
      output: { ok: true },
      artifacts: [{ type: "plan", name: "plan", path: "artifacts/plan.md" }],
    });
  });

  test("a stage with invalid output stays running and can submit corrected output", async () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const artifactPath = join(runDirOf(repo, "feat-x"), "artifacts", "plan.md");
    writeFileSync(artifactPath, "plan\n");
    const command = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--artifact",
      fileArtifact("plan", "artifacts/plan.md"),
    ];
    const before = (await eventsOf(repo)).length;

    const invalid = step([...command, "--summary", "Did the work.", "--output", "[]"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      kind: "validation",
      retryable: true,
      issues: [{ kind: "output-schema", schema: "demo.output.v1" }],
    });
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");
    expect(await eventsOf(repo)).toHaveLength(before + 1);
    expect((await eventsOf(repo)).some((event) => event.type === "workflow.node.completed")).toBe(
      false,
    );

    const corrected = step([...command, "--summary", "Did the work.", "--output", '{"ok":true}']);
    expect(corrected.code).toBe(0);
    expect(stateOf(repo).nodeRuns.make).toMatchObject({
      status: "completed",
      output: { ok: true },
    });
  });

  test("concurrent done calls record exactly one completion", async () => {
    const { repo, home, skills, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");
    const args = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      '{"ok":true}',
      "--artifact",
      fileArtifact("plan", "artifacts/plan.md"),
    ];
    const results = await Promise.all([
      orchestrateAsync(repo, home, args, { YOK_SKILLS_DIR: skills }),
      orchestrateAsync(repo, home, args, { YOK_SKILLS_DIR: skills }),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const rejected = results.find((result) => result.code === 1);
    expect(JSON.parse(rejected?.stderr ?? "")).toMatchObject({
      kind: "not-running",
      retryable: false,
      nodeRunId: reply.nodeRunId,
    });
    expect(
      (await eventsOf(repo)).filter((event) => event.type === "workflow.node.completed"),
    ).toHaveLength(1);
  });

  test("SC10: yok orchestrate next prints a subagent prompt node with its mode", () => {
    const run = startedRun(`name: delegated
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: ask, type: agent, prompt: check it, mode: subagent, input: {} }
`);
    const next = orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]);
    expect(next.code, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      kind: "agent",
      mode: "subagent",
      prompt: "check it",
      input: {},
    });
  });

  test("IW30 — done reads --output - and --error - from stdin, keeping quotes and $(…) as plain text", () => {
    const { repo, home, skills } = stageRun();
    const env = { YOK_SKILLS_DIR: skills };
    const next = () => JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
    const make = next();
    const output = '{"note":"can\'t stop; $(touch PWNED)"}';
    mkdirSync(join(runDirOf(repo, "feat-x"), "artifacts"), { recursive: true });
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts/plan.md"), "plan\n");
    const artifact = ["--artifact", fileArtifact("plan", "artifacts/plan.md")];
    const doneArgs = [
      "done",
      make.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      "-",
      ...artifact,
    ];
    const done = orchestrate(repo, home, doneArgs, env, output);
    expect(done.code).toBe(0);
    expect(stateOf(repo).nodeRuns.make.output).toEqual({ note: "can't stop; $(touch PWNED)" });

    const use = next();
    const reason = "couldn't read the plan; `rm -rf x`\n";
    const failed = orchestrate(
      repo,
      home,
      ["done", use.nodeRunId, "--run", "feat-x", "--error", "-"],
      env,
      reason,
    );
    expect(failed.code).toBe(1);
    expect(stateOf(repo).nodeRuns.use.output).toEqual({
      kind: "exception",
      message: reason.trim(),
    });
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  test("IW20 — done refuses bad flags before touching the run, and done --error fails the node", async () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const done = ["done", reply.nodeRunId, "--run", "feat-x"];
    const before = (await eventsOf(repo)).length;
    const refusals = [
      {
        flags: ["--summary", "Did the work.", "--output", "{}", "--error", "no"],
        names: ["--output", "--error"],
      },
      { flags: [], names: ["--output", "--error"] },
      { flags: ["--error", "x", "--artifact", "plan"], names: ["--artifact", "plan"] },
      { flags: ["--error", "x", "--artifact", "artifacts/plan.md"], names: ["--artifact"] },
    ];
    for (const { flags, names } of refusals) {
      const refused = step([...done, ...flags]);
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "input", retryable: true });
      for (const name of names) expect(refused.stderr).toContain(name);
    }
    expect(await eventsOf(repo)).toHaveLength(before);

    const wrongCommand = step(["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(wrongCommand.code).toBe(1);
    expect(wrongCommand.stderr).toContain(reply.nodeRunId);

    const failed = step([...done, "--error", "could not"]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      status: "failed",
      error: { message: "could not" },
    });
  });

  const ALLOWED_TO_FAIL = `name: allowed
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: make, type: agent, stage: plain, allowFailure: true, input: {} }
  - { id: after, type: agent, prompt: go on, input: {} }
`;
  // Starts ALLOWED_TO_FAIL with OVERRIDES on its registry entry, and fails `make` with QUESTION.
  const failMake = (overrides: Partial<WorkflowRun>) => {
    const run = startedRun(ALLOWED_TO_FAIL, undefined, overrides);
    const step = (args: readonly string[], input = "") =>
      orchestrate(run.repo, run.home, args, { YOK_SKILLS_DIR: STAGE_SKILLS }, input);
    const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const question = "Which region? Only a person knows.";
    step(["done", make.nodeRunId, "--run", "feat-x", "--error", "-"], question);
    return { ...run, step, question };
  };

  test("SC516: with interaction off, done --error fails an allowFailure stage as needs-input and next ends the run failed", () => {
    const policies: SavedPolicies = {
      values: { interaction: false },
      sources: { interaction: "cli" },
    };
    const { repo, step, question } = failMake({ policies });

    expect(stateOf(repo).nodeRuns.make.output).toEqual({ kind: "needs-input", message: question });
    expect(JSON.parse(step(["next", "--run", "feat-x"]).stdout)).toEqual({
      kind: "finished",
      status: "failed",
    });
    expect(stateOf(repo).nodeRuns.after).toBeUndefined();
  });

  test("SC517: with no saved policies, done --error fails an allowFailure stage as exception and next starts the following node", () => {
    const { repo, step, question } = failMake({});

    expect(stateOf(repo).nodeRuns.make.output).toEqual({ kind: "exception", message: question });
    expect(JSON.parse(step(["next", "--run", "feat-x"]).stdout)).toMatchObject({
      kind: "agent",
      nodeId: "after",
    });
  });
});

const MIXED = `name: mixed
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 3 }}"
    maxIterations: 5
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: cat, input: "pass {{ iteration.index }}" }
  - id: decide
    type: switch
    dependsOn: [fix]
    expression: "{{ inputs.prompt }}"
    input: {}
    cases:
      - id: hello
        value: hi
        nodes:
          - { id: greet, type: exec, runtime: sh, script: echo hello-case, input: {} }
    default:
      - { id: greet, type: exec, runtime: sh, script: echo default-case, input: {} }
  - { id: sub, type: include, workflow: child.yaml, dependsOn: [decide], input: {} }
  - id: last
    type: exec
    runtime: sh
    script: cat
    dependsOn: [sub, fix]
    input: "{{ nodes.sub.output }} / {{ nodes.fix.output }}"
`;

const CHILD = `name: child
inputs:
  word: { type: string, default: hi }
nodes:
  - { id: say, type: exec, runtime: sh, script: cat, input: "{{ inputs.word }}" }
`;

describe("SC26: orchestrate next and exec with containers", () => {
  test("an exec node with a summary template posts, fills it from its output, and one without stays quiet", () => {
    const { repo, home } = startedRun(`name: lint
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: lint
    type: exec
    runtime: sh
    script: printf '{"errors":2}'
    output: { zodSchema: Json }
    summary: "Lint found {{ nodes.lint.output.errors }} errors"
    input: {}
  - { id: tidy, type: exec, runtime: sh, script: "true", dependsOn: [lint], input: {} }
`);
    for (const nodeId of ["lint", "tidy"]) {
      const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      expect(reply).toMatchObject({ kind: "exec", nodeId });
      orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    }
    const nodes = stateOf(repo).nodeRuns;
    expect(nodes.lint).toMatchObject({ notify: true, summary: "Lint found 2 errors" });
    expect(nodes.tidy).toMatchObject({ notify: false });
    expect(nodes.tidy).not.toHaveProperty("summary");
  });

  test("IW28 — next and exec run a workflow mixing a loop, a switch and an include to finished", () => {
    const { repo, home } = startedRun(MIXED, undefined, {}, { files: { "child.yaml": CHILD } });
    const handedOut = ["test", "test", "test", "greet", "say", "last"].map((nodeId) => {
      const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      expect(reply).toMatchObject({ kind: "exec", nodeId });
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(JSON.parse(exec.stdout)).toMatchObject({ nodeId, status: "completed" });
      return reply.nodeRunId;
    });
    const last = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(JSON.parse(last.stdout)).toEqual({ kind: "finished", status: "completed" });
    const nodes = stateOf(repo).nodeRuns;
    expect(nodes.decide.nodes.greet).toMatchObject({ nodeRunId: handedOut[3] });
    expect(nodes.decide).toMatchObject({
      output: "hello-case\n",
      nodes: { greet: { output: "hello-case\n" } },
    });
    expect(nodes.fix).toMatchObject({ iteration: 3, output: '"pass 3"' });
    expect(nodes.sub.output).toBe('"hi"');
    expect(nodes.last.input).toBe('"hi" / "pass 3"');
  }, 10_000);
});

const ONE_EXEC = `name: one
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: a, type: exec, runtime: sh, script: printf done, input: {} }
`;

const AGENT = `name: asked
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: ask, type: agent, prompt: check it, input: {} }
`;

const callsOf = async (repo: string) =>
  (await eventsOf(repo))
    .filter((event) => event.type.startsWith("orchestrate."))
    .map(({ type, source, payload }) => ({ type, source, payload }));

const call = (type: string, input: JsonValue, output: JsonValue, status?: string) => ({
  type: `orchestrate.${type}`,
  source: "orchestrate",
  payload: { input, output, ...(status === undefined ? {} : { status }) },
});

describe("SC26: orchestrate call log", () => {
  test("OL1 — next and exec each log their input and whole reply, after the engine events the call recorded", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    const step = (args: readonly string[]) => JSON.parse(orchestrate(repo, home, args).stdout);

    const exec = step(["next", "--run", "feat-x"]);
    const report = step(["exec", exec.nodeRunId, "--run", "feat-x"]);
    const finished = step(["next", "--run", "feat-x"]);

    expect(exec).toMatchObject({ kind: "exec", nodeId: "a" });
    expect(finished).toEqual({ kind: "finished", status: "completed" });
    expect(await callsOf(repo)).toEqual([
      call("next", {}, exec),
      call("exec", { nodeRunId: exec.nodeRunId }, report),
      call("next", {}, finished),
    ]);
    expect((await eventsOf(repo)).map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.node.started",
      "orchestrate.next",
      "workflow.node.completed",
      "orchestrate.exec",
      "workflow.completed",
      "orchestrate.next",
    ]);
  });

  test("OL2 — a stage reply, a refused done, a completed done and the next stage are logged", async () => {
    const run = startedRun(STAGES_WORKFLOW);
    const env = { YOK_SKILLS_DIR: stageSkills() };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    const stage = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const done = ["done", stage.nodeRunId, "--run", "feat-x"];

    const refused = step([
      ...done,
      "--summary",
      "Did the work.",
      "--output",
      '{"ok":true}',
      "--artifact",
      fileArtifact("plan", "artifacts/plan.md"),
    ]);
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "plan.md"), "plan\n");
    const report = JSON.parse(
      step([
        ...done,
        "--summary",
        "Did the work.",
        "--output",
        '{"ok":true}',
        "--artifact",
        fileArtifact("plan", "artifacts/plan.md"),
      ]).stdout,
    );
    const following = JSON.parse(step(["next", "--run", "feat-x"]).stdout);

    expect(refused.code).toBe(1);
    expect(stage).toMatchObject({ kind: "stage", nodeId: "make" });
    expect(following).toMatchObject({ kind: "stage", nodeId: "use" });
    const artifacts = [{ type: "plan", name: "plan", path: "artifacts/plan.md" }];
    expect(await callsOf(run.repo)).toEqual([
      call("next", {}, stage),
      call(
        "done",
        { nodeRunId: stage.nodeRunId, output: '{"ok":true}', summary: "Did the work.", artifacts },
        { kind: "error", message: refused.stderr.trim().slice(0, ERROR_MESSAGE_LIMIT) },
        "rejected",
      ),
      call(
        "done",
        { nodeRunId: stage.nodeRunId, output: '{"ok":true}', summary: "Did the work.", artifacts },
        report,
        "completed",
      ),
      call("next", {}, following),
    ]);
  });

  test("OL3 — an agent reply and a done --error log the error as the agent reported it", async () => {
    const { repo, home } = startedRun(AGENT);
    const agent = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const failed = orchestrate(repo, home, [
      "done",
      agent.nodeRunId,
      "--run",
      "feat-x",
      "--error",
      "could not",
    ]);

    expect(agent).toMatchObject({ kind: "agent", prompt: "check it" });
    expect(await callsOf(repo)).toEqual([
      call("next", {}, agent),
      call(
        "done",
        { nodeRunId: agent.nodeRunId, error: "could not", artifacts: [] },
        JSON.parse(failed.stdout),
        "failed",
      ),
    ]);
  });

  test("OL4 — a next that throws logs the error with its stack, fails as before, and leaves state.json alone but for lastEventSeq", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    writeFileSync(join(runDirOf(repo, "feat-x"), "workflow.yaml"), "name: one\nnodes: 3\n");
    const before = stateOf(repo);

    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);

    expect(next.code).toBe(1);
    expect(next.stdout).toBe("");
    expect(await callsOf(repo)).toEqual([
      call(
        "next",
        {},
        {
          kind: "error",
          message: expect.stringContaining("nodes: Invalid input"),
          stack: expect.stringContaining("workflow/compile.ts"),
        },
      ),
    ]);
    expect(stateOf(repo)).toEqual({ ...before, lastEventSeq: before.lastEventSeq + 1 });
  });

  test("OL5 — a next refused over a config broken after init is logged", async () => {
    const { repo, home } = startedRun(ONE_EXEC, {});
    writeFileSync(join(repo, "orchestrate.config.json"), "{");

    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);

    expect(next.code).toBe(1);
    expect(next.stderr).toContain("orchestrate.config.json: invalid YAML");
    expect(await callsOf(repo)).toEqual([
      call(
        "next",
        {},
        {
          kind: "error",
          message: expect.stringContaining("orchestrate.config.json: invalid YAML"),
        },
      ),
    ]);
  });

  test("OL6 — exec and done refuse an empty node run id before touching the run", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    const before = (await eventsOf(repo)).length;

    const exec = orchestrate(repo, home, ["exec", "", "--run", "feat-x"]);
    const done = orchestrate(repo, home, [
      "done",
      "",
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      "{}",
    ]);

    for (const refused of [exec, done]) {
      expect(refused.code).toBe(1);
      expect(refused.stderr.trim()).toBe("nodeRunId must not be empty");
    }
    expect(await eventsOf(repo)).toHaveLength(before);
  });
});

const ONE_AGENT = `name: one
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: plan
    type: agent
    prompt: plan it
    input: {}
`;

describe("SC26: orchestrate hook stop", () => {
  const STOP = JSON.stringify({ session_id: "s1", stop_hook_active: false });
  const RUN_ENV = { YOK_RUN_ID: "r-1" };

  // A run whose claude session s1 was handed node plan by next and has not run done.
  const openNodeRun = () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const next = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });
    return run;
  };

  const stop = (run: Readonly<{ repo: string; home: string }>, input = STOP, env: Env = RUN_ENV) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      env,
      input,
    );

  test("SC20 — the hook blocks a turn that left an agent node open, and logs the call", async () => {
    const run = openNodeRun();

    const first = stop(run);

    expect(first.code).toBe(0);
    const reply = JSON.parse(first.stdout);
    expect(reply).toEqual({
      decision: "block",
      reason: expect.stringContaining("orchestrate done"),
    });
    const last = (await eventsOf(run.repo)).at(-1);
    expect(last).toMatchObject({
      type: "hooks.stop.called",
      payload: {
        agent: "claude",
        sessionId: "s1",
        decision: "continue",
        reason: "node-not-done",
        blockStreak: 1,
        message: reply.reason,
      },
    });
    expect(stateOf(run.repo).stopHook).toEqual({ blockStreak: 1, seq: last?.seq });
  });

  // A run between nodes, and a Claude transcript whose last lines are PROMPT and then COMMAND, if any.
  const betweenNodes = (prompt: string, command?: string) => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const transcript = join(tempDir(), "s1.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: prompt } },
      ...(command === undefined
        ? [{ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }]
        : [
            {
              type: "assistant",
              message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
            },
          ]),
    ];
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n"));
    return { run, input: JSON.stringify({ session_id: "s1", transcript_path: transcript }) };
  };

  test("a turn that ran orchestrate but not next is sent back with the next command", () => {
    const { run, input } = betweenNodes("go", "yok orchestrate done n1 --run feat-x");

    const reply = JSON.parse(stop(run, input).stdout);

    expect(reply.reason).toContain("yok orchestrate next --run feat-x");
  });

  test("SC23 — a broken state.json lets the turn end", () => {
    const run = openNodeRun();
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "state.json"), '{"schemaVersion":2}');

    expect(stop(run)).toMatchObject({ code: 0, stdout: "" });
  });

  describe("orchestrate await-approval", () => {
    const awaitingRun = () => {
      const run = openNodeRun();
      mkdirSync(join(runDirOf(run.repo, "feat-x"), "artifacts"), { recursive: true });
      writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "design.md"), "# Design\n");
      const nodeRunId: string = stateOf(run.repo).nodeRuns.plan.nodeRunId;
      return { ...run, nodeRunId };
    };
    const awaitApproval = (
      run: Readonly<{ repo: string; home: string }>,
      nodeRunId: string,
      file: string,
    ) =>
      orchestrate(run.repo, run.home, [
        "await-approval",
        nodeRunId,
        "--run",
        "feat-x",
        "--file",
        file,
      ]);
    const approvalRequests = async (repo: string) =>
      (await eventsOf(repo)).filter((event) => event.type === "artifact.approval.requested");

    test("SC5: await-approval on the open agent node records the request, and the next stop is let through as awaiting-approval", async () => {
      const run = awaitingRun();

      const reply = awaitApproval(run, run.nodeRunId, "artifacts/design.md");

      expect(reply.code).toBe(0);
      expect(JSON.parse(reply.stdout)).toEqual({
        nodeRunId: run.nodeRunId,
        path: "artifacts/design.md",
      });
      expect(await approvalRequests(run.repo)).toEqual([
        expect.objectContaining({
          nodeId: "plan",
          nodeRunId: run.nodeRunId,
          payload: { path: "artifacts/design.md" },
        }),
      ]);
      expect(stop(run)).toMatchObject({ code: 0, stdout: "" });
      expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
        type: "hooks.stop.called",
        payload: { decision: "allow", reason: "awaiting-approval", nodeRunId: run.nodeRunId },
      });
    });

    test("SC6: await-approval refuses an unknown node run, a missing file, a file outside artifacts/ and a directory under it, writing no request", async () => {
      const run = awaitingRun();
      writeFileSync(join(runDirOf(run.repo, "feat-x"), "notes.md"), "notes\n");
      mkdirSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "drafts"));

      const replies = [
        awaitApproval(run, "nr-unknown", "artifacts/design.md"),
        awaitApproval(run, run.nodeRunId, "artifacts/missing.md"),
        awaitApproval(run, run.nodeRunId, "notes.md"),
        awaitApproval(run, run.nodeRunId, "artifacts/drafts"),
      ];

      expect(replies.map((reply) => reply.code)).toEqual([1, 1, 1, 1]);
      expect(replies[0]?.stderr).toContain("nr-unknown");
      expect(replies[1]?.stderr).toContain("artifacts/missing.md");
      expect(replies[2]?.stderr).toContain("notes.md");
      expect(replies[3]?.stderr).toContain("artifacts/drafts");
      expect(await approvalRequests(run.repo)).toEqual([]);
    });

    test("SC518: with interaction off, await-approval approves at once, records policy.applied, and done then completes the node", async () => {
      const policies: SavedPolicies = {
        values: { interaction: false },
        sources: { interaction: "cli" },
      };
      const run = startedRun(ONE_AGENT, undefined, { policies });
      const next = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
      mkdirSync(join(runDirOf(run.repo, "feat-x"), "artifacts"), { recursive: true });
      writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "design.md"), "# Design\n");

      const reply = awaitApproval(run, next.nodeRunId, "artifacts/design.md");

      expect(reply.code).toBe(0);
      expect(JSON.parse(reply.stdout)).toEqual({
        nodeRunId: next.nodeRunId,
        path: "artifacts/design.md",
        autoApproved: true,
      });
      expect(stateOf(run.repo).nodeRuns.plan.awaitingApproval).toBeUndefined();
      expect(stateOf(run.repo).autoApproved).toEqual(["artifacts/design.md"]);
      const events = await eventsOf(run.repo);
      expect(events.filter((event) => event.type === "policy.applied")).toEqual([
        expect.objectContaining({
          nodeRunId: next.nodeRunId,
          payload: {
            policy: "interaction",
            effect: "auto-approved",
            nodeId: "plan",
            path: "artifacts/design.md",
          },
        }),
      ]);
      expect(await approvalRequests(run.repo)).toEqual([]);
      const finish = ["--summary", "Planned.", "--output", "{}"];
      const done = ["done", next.nodeRunId, "--run", "feat-x", ...finish];
      expect(orchestrate(run.repo, run.home, done).code).toBe(0);
      expect(stateOf(run.repo).nodeRuns.plan.status).toBe("completed");
    });
  });
});

describe("SC26: orchestrate hook pre-tool-use", () => {
  const RUN_ENV = { YOK_RUN_ID: "r-1" };

  const openNodeRun = () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const next = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });
    return run;
  };

  const preToolUse = (
    run: Readonly<{ repo: string; home: string }>,
    toolName: string,
    toolInput: Record<string, unknown>,
    handler = "record-guard",
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "pre-tool-use", "--agent", "claude", "--handler", handler],
      RUN_ENV,
      JSON.stringify({
        session_id: "s1",
        tool_name: toolName,
        tool_input: toolInput,
        cwd: run.repo,
      }),
    );

  test("SC16 — the hook command refuses a shell write to state.json and logs it", async () => {
    const run = openNodeRun();

    const result = preToolUse(run, "Bash", {
      command: "mv /tmp/s .yok/feat-x/state.json",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("yok orchestrate next --run feat-x"),
    });
    const events = await eventsOf(run.repo);
    expect(events.at(-1)).toMatchObject({
      type: "hooks.pre-tool-use.called",
      payload: { handler: "record-guard", decision: "deny" },
    });
    expect(stateOf(run.repo)).toMatchObject({ runName: "feat-x", lastEventSeq: events.length });
  });

  test("SC144: after the real stop-failure hook blocks the run on an agent error, a Bash call through the real record-resumed hook puts state.json back to running with no blocker", async () => {
    const run = openNodeRun();
    const failed = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop-failure", "--agent", "claude", "--handler", "record-agent-error"],
      RUN_ENV,
      JSON.stringify({ session_id: "s1", error: "authentication_failed" }),
    );
    expect(failed).toMatchObject({ code: 0, stdout: "" });
    expect(stateOf(run.repo)).toMatchObject({
      status: "blocked",
      blocker: { reason: "agent-error", node: "plan" },
    });

    const result = preToolUse(run, "Bash", { command: "bun test" }, "record-resumed");

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "agent.resumed",
      payload: { agent: "claude", sessionId: "s1", reason: "agent-error", tool: "Bash" },
    });
    const state = stateOf(run.repo);
    expect(state.status).toBe("running");
    expect(state).not.toHaveProperty("blocker");
  });

  test("an unknown handler prints nothing, so no agent is ever trapped", () => {
    const run = openNodeRun();

    const result = preToolUse(run, "Bash", { command: "rm .yok/feat-x/state.json" }, "nope");

    expect(result).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("SC26: the task workflow's ticket-fetcher stage", () => {
  const TASK = readFileSync(
    join(import.meta.dir, "..", "..", "..", "workflows", "task.yaml"),
    "utf8",
  );
  const TICKET = {
    schemaVersion: 1,
    provider: "linear",
    id: "id-1",
    key: "ENG-1",
    url: "https://linear.app/x/issue/ENG-1",
    title: "Add export",
    body: "Export to CSV",
    properties: {},
    comments: [],
    references: [],
    assets: [],
    complete: true,
    fetchedAt: "2026-09-30T12:00:00Z",
  };

  // Registered with no tiers, so its stages need no model switch; they are the yok's own skills.
  const taskRun = (prompt: string) => {
    const run = startedRun(TASK, {}, {}, { env: { YOK_SKILLS_DIR: undefined } });
    const registry = readRegistry(run.home);
    writeRegistry(run.home, [
      ...Object.values(registry.runs).map((r) => ({ ...r, inputs: { prompt } })),
    ]);
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args);
    return { ...run, step };
  };

  const finishFetcher = (
    step: (args: readonly string[]) => ReturnType<typeof orchestrate>,
    output: unknown,
    artifact: readonly string[] = [],
  ) => {
    const fetcher = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(fetcher).toMatchObject({
      nodeId: "ticket-fetcher",
      input: expect.anything(),
      variables: { provider: "auto" },
    });
    const done = step([
      "done",
      fetcher.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      JSON.stringify(output),
      ...artifact,
    ]);
    expect(done.stderr).toBe("");
    expect(done.code).toBe(0);
    return JSON.parse(step(["next", "--run", "feat-x"]).stdout);
  };

  test("a ticket bundle registers as an artifact and its task text reaches create-workspace", async () => {
    const { repo, step } = taskRun("work on ENG-1");
    const dir = join(runDirOf(repo, "feat-x"), "artifacts", "ticket");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ticket.json"), JSON.stringify(TICKET));
    expect(await validateTicketDir(dir)).toMatchObject({ ok: true });
    const task = "Add export\n\nExport to CSV";

    const workspace = finishFetcher(
      step,
      {
        task,
        ticket: {
          provider: "linear",
          key: "ENG-1",
          url: TICKET.url,
          path: "artifacts/ticket/ticket.json",
          complete: true,
        },
      },
      ["--artifact", fileArtifact("ticket", "artifacts/ticket/ticket.json")],
    );

    expect(workspace).toMatchObject({ nodeId: "create-workspace", input: { request: task } });
  });
});

describe("SC26: a question blocks the run", () => {
  test("SC136: the real AskUserQuestion hooks block the run on the make stage in state.json, and its answer unblocks it", () => {
    const run = startedRun(STAGES_WORKFLOW);
    const env = { YOK_SKILLS_DIR: stageSkills() };
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link, env).code).toBe(0);
    const next = JSON.parse(
      orchestrate(run.repo, run.home, ["next", "--run", "feat-x"], env).stdout,
    );
    expect(next).toMatchObject({ kind: "stage", nodeId: "make" });

    const question = "Ship the plan as is?";
    const toolInput = {
      questions: [
        { question, header: "Plan", options: [{ label: "Approve" }, { label: "Revise" }] },
      ],
    };
    const call = { session_id: "s1", tool_name: "AskUserQuestion", tool_use_id: "tu-1" };
    const hook = (event: string, handler: string, input: Record<string, unknown>) =>
      orchestrate(
        run.repo,
        run.home,
        ["hook", event, "--agent", "claude", "--handler", handler],
        { YOK_RUN_ID: "r-1" },
        JSON.stringify({ ...call, ...input }),
      );

    expect(
      hook("pre-tool-use", "question-notice", { tool_input: toolInput, cwd: run.repo }).code,
    ).toBe(0);
    expect(stateOf(run.repo)).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "question",
        node: "make",
        details: { questions: [{ question, header: "Plan", options: ["Approve", "Revise"] }] },
      },
    });

    const answered = hook("post-tool-use", "answer-notice", {
      tool_input: toolInput,
      tool_response: { answers: { [question]: "Approve" } },
    });
    expect(answered.code).toBe(0);
    const state = stateOf(run.repo);
    expect(state.status).toBe("running");
    expect(state).not.toHaveProperty("blocker");
  });
});

describe("SC26: orchestrate hook session-start", () => {
  const RUN_ENV = { YOK_RUN_ID: "r-1" };
  const START = JSON.stringify({ session_id: "B", source: "clear", cwd: "/x" });

  const sessionStart = (
    run: Readonly<{ repo: string; home: string }>,
    input = START,
    env: Env = RUN_ENV,
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "session-start", "--agent", "claude", "--handler", "link-session"],
      env,
      input,
    );

  test("SC10: a new session id after /clear is linked to its run and its Stop hook call is recognized", async () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);

    const result = sessionStart(run);

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(run.home).runs["r-1"]?.sessions).toEqual([
      { agent: "claude", sessionId: "A" },
      { agent: "claude", sessionId: "B" },
    ]);
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "hooks.session-start.called",
      payload: { agent: "claude", sessionId: "B", source: "clear" },
    });
    const stop = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      RUN_ENV,
      JSON.stringify({ session_id: "B" }),
    );
    expect(stop.code).toBe(0);
    expect((await eventsOf(run.repo)).at(-1)?.type).toBe("hooks.stop.called");
  });

  test("SC11: a session with no run is left alone, and one on a run with no name yet is linked without an event", async () => {
    const run = startedRun(ONE_AGENT);
    const before = (await eventsOf(run.repo)).length;
    const registryBefore = readRegistry(run.home);

    expect(sessionStart(run, START, {})).toMatchObject({ code: 0, stdout: "" });
    expect(sessionStart(run, START, { YOK_RUN_ID: "unknown" })).toMatchObject({
      code: 0,
      stdout: "",
    });

    expect(readRegistry(run.home)).toEqual(registryBefore);
    expect(await eventsOf(run.repo)).toHaveLength(before);

    const home = tempDir();
    writeRegistry(home, [savedRun(run.repo)]);
    expect(sessionStart({ repo: run.repo, home })).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(home).runs["r-1"]?.sessions).toEqual([{ agent: "claude", sessionId: "B" }]);
    expect(await eventsOf(run.repo)).toHaveLength(before);
  });

  test("SC12: input that is not JSON prints nothing and exits 0", () => {
    const run = startedRun(ONE_AGENT);

    expect(sessionStart(run, "not json")).toMatchObject({ code: 0, stdout: "" });
  });
});

const withContext = (node: string) => `name: context
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: first, type: agent, prompt: one, input: {} }
  - { id: fresh, type: context, ${node}, dependsOn: [first] }
  - { id: second, type: agent, prompt: two, dependsOn: [fresh], input: {} }
`;

const FAKE_AGENT = join(import.meta.dir, "agents", "fixtures", "fake-agent.ts");
const RESUME = "/yok:orchestrate --resume feat-x";

// A run whose agent is the fake agent in a private tmux pane, on session A; ENV goes to every call.
const runInPane = async (
  source: string,
  socket: string,
  overrides: Partial<WorkflowRun> = {},
  env: Env = {},
) => {
  const run = startedRun(source, undefined, overrides, {
    env: { YOK_SKILLS_DIR: STAGE_SKILLS, ...env },
  });
  const out = join(tempDir(), "agent.jsonl");
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  tmux(
    ...["new-session", "-d", "-s", "agent", "-x", "200", "-y", "50", "-c", run.repo],
    ...["-e", `FAKE_AGENT_OUT=${out}`, "--", "bun", FAKE_AGENT],
  );
  const socketPath = tmux("display-message", "-p", "-t", "agent", "#{socket_path}").trim();
  const pane = tmux("display-message", "-p", "-t", "agent", "#{pane_id}").trim();
  const inPane = {
    TMUX: `${socketPath},1,0`,
    TMUX_PANE: pane,
    YOK_CLAUDE_BIN: FAKE_AGENT,
  };
  const step = (args: readonly string[], extra: Env = {}, input = "") =>
    orchestrate(run.repo, run.home, args, { YOK_RUN_ID: "r-1", ...env, ...extra }, input);
  const next = () => JSON.parse(step(["next", "--run", "feat-x"]).stdout);
  const records = (): Array<Record<string, unknown>> =>
    existsSync(out)
      ? readFileSync(out, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];
  const typed = () =>
    records()
      .map((record) => record.line)
      .filter((line): line is string => typeof line === "string");
  const launches = () => records().filter((record) => Array.isArray(record.argv));

  expect(
    step(["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"]).code,
  ).toBe(0);
  await waitFor(() => launches().length === 1);
  await Bun.sleep(300);
  const stop = () =>
    step(
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      inPane,
      JSON.stringify({ session_id: "A" }),
    );
  // What Claude does once a new session starts or a compact finishes: run its SessionStart hook.
  const sessionStart = (sessionId: string, source: string) =>
    step(
      ["hook", "session-start", "--agent", "claude", "--handler", "link-session"],
      inPane,
      JSON.stringify({ session_id: sessionId, source }),
    );
  return { run, step, next, stop, sessionStart, typed, launches };
};

// A run in a tmux pane (runInPane), driven to its context node.
const runToContextNode = async (
  node: string,
  socket: string,
  overrides: Partial<WorkflowRun> = {},
  header = "",
) => {
  const flow = await runInPane(header + withContext(node), socket, overrides);
  const first = flow.next();
  expect(
    flow.step([
      "done",
      first.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      "{}",
    ]).code,
  ).toBe(0);
  return { ...flow, context: flow.next() };
};

const contextOutput = async (repo: string) =>
  (await eventsOf(repo)).find(
    (event) => event.type === "workflow.node.completed" && event.nodeId === "fresh",
  )?.payload;

describe("SC26: context node through a real tmux pane", () => {
  test("new: the helper restarts the agent in its pane on a new session, whose SessionStart completes the node", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runToContextNode("action: new", socket);
      expect(flow.context).toMatchObject({ kind: "context", action: "new", nodeId: "fresh" });

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.launches().length === 2);

      const argv = flow.launches()[1]?.argv as string[];
      const sessionId = argv[argv.indexOf("--session-id") + 1] ?? "";
      expect(argv.at(-1)).toBe(RESUME);
      expect(await contextOutput(flow.run.repo)).toBeUndefined();
      expect(flow.sessionStart(sessionId, "startup")).toMatchObject({ code: 0, stdout: "" });
      expect(flow.launches()[1]?.runId).toBe("r-1");
      expect(flow.typed()).toEqual([]);
      expect(stateOf(flow.run.repo).activeSessions).toEqual([{ agent: "claude", sessionId }]);
      expect(await contextOutput(flow.run.repo)).toMatchObject({
        output: { action: "new", applied: true, sessionId },
      });
      expect(flow.next()).toMatchObject({ kind: "agent", nodeId: "second" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);

  test.each([
    [
      "with no switch made, on the default tier's model and effort",
      { default: "deep", models: { deep: { model: "opus", effort: "high" as const } } },
      undefined,
      { "--model": "opus", "--effort": "high" },
      undefined,
    ],
    [
      "SC18: after a switch from the default fast tier's sonnet-x to opus-x is applied, with --model opus-x",
      { default: "fast", models: { fast: { model: "sonnet-x" } } },
      "opus-x",
      { "--model": "opus-x" },
      "sonnet-x",
    ],
  ])(
    "new: the restarted session launches %s",
    async (_case, tiers, switchTo, flags, absent) => {
      const socket = `yok-e2e-${crypto.randomUUID()}`;
      try {
        const flow = await runToContextNode("action: new", socket, { tiers });
        if (switchTo !== undefined) {
          // emit refuses engine-owned events, so the switch is stored the way next and the helper do
          const run = { id: "r-1", cwd: flow.run.repo, name: "feat-x" };
          const record = (type: string, payload: JsonValue) =>
            appendRunEvent(run, { type, source: "orchestrate", payload });
          const request = { node: "second", model: switchTo };
          const requested = await record("workflow.model.requested", request);
          if (!requested.ok) throw new Error(requested.error);
          const requestSeq = requested.value.event.seq;
          expect(
            await record("workflow.model.applied", { ...request, requestSeq, applied: true }),
          ).toMatchObject({ ok: true });
        }

        expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
        await waitFor(() => flow.launches().length === 2);

        const argv = flow.launches()[1]?.argv as string[];
        const launched = Object.keys(flags).map((flag) => [flag, argv[argv.indexOf(flag) + 1]]);
        expect(Object.fromEntries(launched)).toEqual(flags);
        expect(argv.filter((arg) => arg === absent)).toEqual([]);
      } finally {
        spawnSync("tmux", ["-L", socket, "kill-server"]);
      }
    },
    30_000,
  );

  test("model: before a deep stage on a run launched on fast, next asks for opus-x; the stop's helper resumes session A on it, and its SessionStart records the switch", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runInPane(
        `name: tiered
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: think, type: agent, stage: thinker, input: {} }
`,
        socket,
        {
          tiers: {
            default: "fast",
            models: { fast: { model: "sonnet-x" }, deep: { model: "opus-x" } },
          },
        },
        { YOK_SKILLS_DIR: stageSkills() },
      );
      expect(flow.next()).toEqual({ kind: "model", nodeId: "think", model: "opus-x" });

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.launches().length === 2);

      const argv = flow.launches()[1]?.argv as string[];
      expect(argv.slice(0, 4)).toEqual(["--resume", "A", "--model", "opus-x"]);
      expect(argv.at(-1)).toBe(RESUME);
      expect(flow.sessionStart("A", "resume")).toMatchObject({ code: 0, stdout: "" });
      const modelEvents = async () =>
        (await eventsOf(flow.run.repo)).filter((event) => event.type.startsWith("workflow.model."));
      const deadline = Date.now() + 10_000;
      while ((await modelEvents()).length < 2 && Date.now() < deadline) await Bun.sleep(50);
      const [requested, applied] = await modelEvents();
      expect(applied?.payload).toEqual({
        requestSeq: requested?.seq ?? 0,
        node: "think",
        model: "opus-x",
        applied: true,
      });
      expect(flow.next()).toMatchObject({ kind: "stage", nodeId: "think" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);

  test("compact: the helper types /compact; the compact's SessionStart completes the node and types the resume prompt", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runToContextNode('action: compact, prompt: "keep the plan"', socket);
      expect(flow.context).toMatchObject({ kind: "context", action: "compact" });
      const sessionsBefore = stateOf(flow.run.repo).activeSessions;

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.typed().includes("/compact keep the plan"));
      expect(flow.sessionStart("A", "compact")).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.typed().includes(RESUME));

      expect(flow.typed()).toEqual(["/compact keep the plan", RESUME]);
      expect(stateOf(flow.run.repo).activeSessions).toEqual(sessionsBefore);
      expect(await contextOutput(flow.run.repo)).toMatchObject({
        output: { action: "compact", applied: true, sessionId: "A" },
      });
      expect(flow.next()).toMatchObject({ kind: "agent", nodeId: "second" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);
});

describe("SC26: orchestrate hook stop-failure", () => {
  // The test itself may run inside tmux; the helper must not find this pane and type into it.
  const RUN_ENV = { YOK_RUN_ID: "r-1", TMUX: undefined, TMUX_PANE: undefined };

  test("a usage limit is logged as agent.limit.reached and its detached wait starts, which with no terminal only logs why it cannot type", async () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);

    const result = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop-failure", "--agent", "claude", "--handler", "resume-after-limit"],
      RUN_ENV,
      JSON.stringify({
        session_id: "A",
        error: "rate_limit",
        last_assistant_message: "resets 3pm (UTC)",
      }),
    );

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "agent.limit.reached",
      payload: {
        agent: "claude",
        sessionId: "A",
        error: "rate_limit",
        message: "resets 3pm (UTC)",
      },
    });
    const log = join(runDirOf(run.repo, "feat-x"), "limit-wait.log");
    await waitFor(
      () => existsSync(log) && readFileSync(log, "utf8").includes("no terminal to type into"),
    );
  }, 20_000);
});

describe("SC26: orchestrate statusline", () => {
  const runWithRunningNode = () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);
    orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"]);
    const dir = runDirOf(repo, "feat-x");
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.nodeRuns = {
      design: {
        nodeRunId: "nr-1",
        nodeType: "agent",
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        artifacts: [],
      },
    };
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(
      join(dir, "workflow.yaml"),
      "name: ok\nnodes:\n  - id: design\n    type: agent\n    input: {}\n    prompt: do it\n  - id: plan\n    type: agent\n    input: {}\n    prompt: do it\n",
    );
    return { repo, home, statePath };
  };

  test("SC9: prints the run and its running node from Claude's stdin, and exits 0", () => {
    const { repo, home } = runWithRunningNode();
    const stdin = JSON.stringify({ model: { display_name: "Opus" } });

    const result = orchestrate(repo, home, ["statusline"], { YOK_RUN_ID: "r-1" }, stdin);

    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toMatch(
      /^yok feat-x ▸ design \[░░░░░░░░░░\] 0\/2 · \d+s · Opus\n$/,
    );
  });

  test("SC14, SC17: --run-id prints the running node of that run with empty stdin and no YOK_RUN_ID", () => {
    const { repo, home } = runWithRunningNode();

    const result = orchestrate(repo, home, ["statusline", "--run-id", "r-1"], {}, "");

    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toMatch(
      /^yok feat-x ▸ design \[░░░░░░░░░░\] 0\/2 · \d+s\n$/,
    );
  });

  test.each([
    ["with YOK_RUN_ID unset it prints nothing", {}, false, ""],
    [
      "a corrupt registry prints the starting line",
      { YOK_RUN_ID: "r-1" },
      true,
      "yok · starting\n",
    ],
  ])("SC9: %s and exits 0", (_case, env, corrupt, stdout) => {
    const { repo, home } = runWithRunningNode();
    if (corrupt) writeFileSync(join(home, "registry.json"), "{ corrupt");

    const result = orchestrate(repo, home, ["statusline"], env, "{}");

    expect(result).toMatchObject({ code: 0, stdout });
  });
});

describe("SC26: orchestrate hook --agent codex", () => {
  const RUN_ENV = { YOK_RUN_ID: "r-1" };
  const common = { cwd: "/x", hook_event_name: "X", model: "gpt-5", permission_mode: "default" };

  const hook = (
    run: Readonly<{ repo: string; home: string }>,
    event: string,
    handler: string,
    stdin: Record<string, unknown>,
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", event, "--agent", "codex", "--handler", handler],
      RUN_ENV,
      JSON.stringify({ ...common, transcript_path: null, ...stdin }),
    );

  test("SC12: session-start links the Codex session, pre-tool-use denies a state.json write, stop blocks an open node", async () => {
    const run = startedRun(ONE_AGENT);

    const start = hook(run, "session-start", "link-session", {
      session_id: "c1",
      source: "startup",
    });
    expect(start).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(run.home).runs["r-1"]?.sessions).toEqual([
      { agent: "codex", sessionId: "c1" },
    ]);

    const next = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });

    const denied = hook(run, "pre-tool-use", "record-guard", {
      session_id: "c1",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: .yok/feat-x/state.json\n*** End Patch",
      },
      cwd: run.repo,
    });
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("orchestrate next --run feat-x"),
    });

    const stopped = hook(run, "stop", "continue-workflow", {
      session_id: "c1",
      stop_hook_active: false,
      last_assistant_message: "done",
      turn_id: "t1",
    });
    expect(JSON.parse(stopped.stdout)).toEqual({
      decision: "block",
      reason: expect.stringContaining("orchestrate done"),
    });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "hooks.stop.called",
      payload: { agent: "codex", sessionId: "c1", decision: "continue" },
    });
  });
});

describe("SC26: orchestrate comments", () => {
  test("SC27: the agent lists open comments and replies from the command line", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const anchor = { quote: "one file", before: "a", after: "b", lines: [14, 16] };
    const base = { file: "artifacts/design.md", kind: "comment", text: "Why?", anchor };
    const user = { by: "user", text: "Why?", at: "2026-01-01T00:00:00.000Z" };
    const at = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      join(runDirOf(repo, "feat-x"), "comments.json"),
      JSON.stringify({
        version: 1,
        comments: [
          { ...base, id: "c1", status: "delivered", createdAt: at, thread: [user] },
          { ...base, id: "c2", status: "answered", createdAt: at, thread: [user] },
        ],
      }),
    );
    const ids = (stdout: string): string[] =>
      JSON.parse(stdout).comments.map((c: { id: string }) => c.id);

    const open = orchestrate(repo, home, ["comments", "list", "--run", "feat-x"]);
    const all = orchestrate(repo, home, ["comments", "list", "--run", "feat-x", "--all"]);
    const reply = orchestrate(
      repo,
      home,
      ["comments", "reply", "--run", "feat-x", "--id", "c1", "--status", "changed", "--text", "-"],
      {},
      "Bundled it.\n",
    );
    const missing = orchestrate(repo, home, [
      "comments",
      "reply",
      "--run",
      "feat-x",
      "--id",
      "c9",
      "--status",
      "answered",
      "--text",
      "x",
    ]);
    const badStatus = orchestrate(repo, home, [
      "comments",
      "reply",
      "--run",
      "feat-x",
      "--id",
      "c1",
      "--status",
      "maybe",
      "--text",
      "x",
    ]);

    expect([ids(open.stdout), ids(all.stdout)]).toEqual([["c1"], ["c1", "c2"]]);
    expect(reply.code).toBe(0);
    expect(JSON.parse(reply.stdout)).toMatchObject({ id: "c1", status: "changed" });
    const replied = (await eventsOf(repo)).filter((e) => e.type === "artifact.comment.replied");
    expect(replied.map((e) => e.payload)).toEqual([
      {
        id: "c1",
        by: "agent",
        status: "changed",
        text: "Bundled it.",
        file: "artifacts/design.md",
        anchor,
      },
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("c9");
    expect(badStatus.code).toBe(1);
  });
});

describe("SC26: orchestrate resume", () => {
  const env = { YOK_SKILLS_DIR: STAGE_SKILLS };
  const nodeEventTypes = async (repo: string) =>
    (await eventsOf(repo))
      .map((event) => event.type)
      .filter((type) => type.startsWith("workflow.node."));

  test("SC311: resume interrupts the open stage, records it as an event, and next hands the stage out again under a new id", async () => {
    const { repo, home } = startedRun(STAGES_WORKFLOW);
    const first = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);

    const resumed = orchestrate(repo, home, ["resume", "--run", "feat-x"], env);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual({
      interrupted: [{ nodeRunId: first.nodeRunId, nodeId: "make" }],
    });
    const interrupted = (await eventsOf(repo)).filter(
      (event) => event.type === "workflow.node.interrupted",
    );
    expect(interrupted).toEqual([
      expect.objectContaining({ nodeId: "make", nodeRunId: first.nodeRunId }),
    ]);
    expect(stateOf(repo).nodeRuns.make.status).toBe("interrupted");

    const again = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
    expect(again).toMatchObject({ kind: "stage", nodeId: "make" });
    expect(again.nodeRunId).not.toBe(first.nodeRunId);
  });

  test("SC312: resume with no step open prints an empty list and records no node event", async () => {
    const { repo, home } = startedRun(STAGES_WORKFLOW);
    const before = await nodeEventTypes(repo);

    const resumed = orchestrate(repo, home, ["resume", "--run", "feat-x"], env);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual({ interrupted: [] });
    expect(await nodeEventTypes(repo)).toEqual(before);
  });

  test("SC313: resume leaves an open context step running, since its helper finishes it", async () => {
    const { repo, home } = startedRun(withContext("action: new"));
    const first = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
    const done = [
      "done",
      first.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did it.",
      "--output",
      "-",
    ];
    expect(orchestrate(repo, home, done, env, "ok").code).toBe(0);
    const context = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
    expect(context).toMatchObject({ kind: "context", nodeId: "fresh" });

    const resumed = orchestrate(repo, home, ["resume", "--run", "feat-x"], env);
    expect(JSON.parse(resumed.stdout)).toEqual({ interrupted: [] });
    expect(stateOf(repo).nodeRuns.fresh).toMatchObject({
      nodeRunId: context.nodeRunId,
      status: "running",
    });
  });

  test("SC315: a late exec result for an interrupted run is refused and leaves the newer run open", async () => {
    const { repo, home } = startedRun(`name: slow
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: a, type: exec, runtime: sh, script: "touch started; until [ -f go ]; do sleep 0.05; done", input: {} }
`);
    const first = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const late = orchestrateAsync(repo, home, ["exec", first.nodeRunId, "--run", "feat-x"]);
    await waitFor(() => existsSync(join(repo, "started")));
    orchestrate(repo, home, ["resume", "--run", "feat-x"]);
    const again = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(repo, "go"), "");

    const refused = await late;
    expect(refused.code).toBe(1);
    expect(refused.stderr.length).toBeGreaterThan(0);
    expect(stateOf(repo).nodeRuns.a).toMatchObject({
      nodeRunId: again.nodeRunId,
      status: "running",
    });
  });

  test("SC318: resume interrupts a step inside a loop in place, and next hands it out again in the same pass", () => {
    const { repo, home } = startedRun(`name: looped
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 2 }}"
    maxIterations: 2
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: cat, input: "pass {{ iteration.index }}" }
`);
    const step = (args: readonly string[]) => orchestrate(repo, home, args, env);
    const first = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(step(["exec", first.nodeRunId, "--run", "feat-x"]).code).toBe(0);
    const second = JSON.parse(step(["next", "--run", "feat-x"]).stdout);

    expect(JSON.parse(step(["resume", "--run", "feat-x"]).stdout)).toEqual({
      interrupted: [{ nodeRunId: second.nodeRunId, nodeId: "test" }],
    });
    const nodes = stateOf(repo).nodeRuns;
    expect(Object.keys(nodes)).toEqual(["fix"]);
    expect(nodes.fix).toMatchObject({ status: "running", iteration: 2 });
    expect(nodes.fix.nodes.test).toMatchObject({
      nodeRunId: second.nodeRunId,
      status: "interrupted",
    });

    const again = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(again).toMatchObject({ kind: "exec", nodeId: "test" });
    expect(again.nodeRunId).not.toBe(second.nodeRunId);
    expect(stateOf(repo).nodeRuns.fix.nodes.test).toMatchObject({
      nodeRunId: again.nodeRunId,
      status: "running",
      input: "pass 2",
    });
  });

  test("SC314: done for a node run that resume interrupted is refused as not running", () => {
    const { repo, home } = startedRun(STAGES_WORKFLOW);
    const first = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
    orchestrate(repo, home, ["resume", "--run", "feat-x"], env);

    const done = [
      "done",
      first.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did it.",
      "--output",
      "-",
    ];
    const late = orchestrate(repo, home, done, env, "{}");
    expect(late.code).toBe(1);
    expect(JSON.parse(late.stderr)).toMatchObject({ kind: "not-running", retryable: false });
  });
});
