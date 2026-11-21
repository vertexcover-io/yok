import { expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDirOf, type State, type WorkflowRun } from "@yok/sdk";
import { withStorage } from "@yok/sdk/internal";
import { DEMO_STAGES, type DemoStage, writeStages } from "./workflow/test-stages.ts";

const CLI = join(import.meta.dir, "..", "..", "cli", "src", "index.ts");

// One --artifact value for a file the node wrote, named after its type.
export const fileArtifact = (type: string, path: string): string =>
  JSON.stringify({ type, name: type, path });

export const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "orchestrate-")));

const makeRepo = (dir: string, ignored: string): string => {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ignored);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

export const tempRepo = (): string => makeRepo(tempDir(), ".worktrees/\n.yok/\n");

export const savedRun = (cwd: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => {
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(
    workflowPath,
    'name: ok\nnodes:\n  - { id: a, type: exec, input: null, runtime: sh, script: "true" }\n',
  );
  return {
    id: "r-1",
    project: "repo",
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

// Saves RUNS in HOME/yok.db as `yok run` leaves them, each after a project row holding its cwd.
export const seedRuns = (home: string, runs: readonly WorkflowRun[]): Promise<void> =>
  withStorage(home, async (storage) => {
    for (const { cwd, ...run } of runs) {
      const addedAt = new Date().toISOString();
      if ((await storage.projects.find(run.project)) === undefined) {
        await storage.projects.add(run.project, {
          path: cwd,
          addedBy: { channel: "cli" },
          addedAt,
        });
      }
      await storage.runs.addRun(run);
    }
  });

export const readRuns = (home: string): Promise<Readonly<Record<string, WorkflowRun>>> =>
  withStorage(home, async (storage) =>
    Object.fromEntries((await storage.runs.listRuns()).map((run) => [run.id, run])),
  );

// A run named NAME in cwd with its folder, as `orchestrate init` leaves the run row; its state
// stays empty until a test seeds one with seedState.
export const initializedRun = async (
  home: string,
  cwd: string,
  name = "feat-x",
): Promise<WorkflowRun> => {
  const run = savedRun(cwd, { name });
  await seedRuns(home, [run]);
  mkdirSync(runDirOf(cwd, name), { recursive: true });
  return run;
};

// Names a seeded, unnamed run and stores STATE as its first state, as init does.
export const seedState = (home: string, runId: string, name: string, state: State) =>
  withStorage(home, (storage) => storage.runs.initRun(runId, name, state));

export const eventsOf = (home: string, runId = "r-1") =>
  withStorage(home, (storage) => storage.runs.readEvents(runId));

export const stateOf = (home: string, runId = "r-1") =>
  withStorage(home, (storage) => storage.runs.readState(runId));

// The run's stored state, for a test that reads one only after init stored it.
export const stateIn = async (home: string, runId = "r-1"): Promise<State> => {
  const state = await stateOf(home, runId);
  if (state === null) throw new Error(`run ${runId} has no state`);
  return state;
};

// The one step a `next` reply hands out, or the reply itself when it hands out none.
export const parseStep = (stdout: string) => {
  const reply = JSON.parse(stdout);
  if (reply.kind !== "steps") return reply;
  expect(reply.steps).toHaveLength(1);
  return reply.steps[0];
};

export type Env = Readonly<Record<string, string | undefined>>;

// A run id or yok home from the shell running the tests must never reach a real registry.
export const orchestrate = (
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

export const orchestrateAsync = async (
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

export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
};

export const configuredRepo = (config: object): string => {
  const root = tempRepo();
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
  return root;
};

// A run named feat-x in a fresh repo, started from SOURCE the way `yok run` + init leave it.
// init compiles the workflow, so env must name the skills folder its stages come from, stages
// holds the project stages it names under stages/ and files what else it reads (schema modules,
// included workflows, extensions), by path in the repo.
export const startedRun = async (
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
): Promise<Readonly<{ repo: string; home: string }>> => {
  const repo = config === undefined ? tempRepo() : configuredRepo(config);
  const home = tempDir();
  const workflowPath = join(repo, "steps.yaml");
  writeFileSync(workflowPath, source);
  if (Object.keys(stages).length > 0) writeStages(join(repo, "stages"), stages);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  await seedRuns(home, [savedRun(repo, { workflowPath, ...overrides })]);
  const init = orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"], env);
  if (init.code !== 0) throw new Error(init.stderr);
  return { repo, home };
};

// A skills folder holding the producer and consumer demo stages, for YOK_SKILLS_DIR.
export const stageSkills = (produces = DEMO_STAGES.producer.produces): string => {
  const dir = tempDir();
  writeStages(dir, { ...DEMO_STAGES, producer: { produces } });
  return dir;
};

export const STAGE_SKILLS = stageSkills();

export const STAGES_WORKFLOW = `name: stages
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

export const withContext = (node: string) => `name: context
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: first, type: agent, prompt: one, input: {} }
  - { id: fresh, type: context, ${node}, dependsOn: [first] }
  - { id: second, type: agent, prompt: two, dependsOn: [fresh], input: {} }
`;
