import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDirOf, type WorkflowRun } from "@yok/sdk";
import { jsonlEventStore, RegistryFileSchema } from "@yok/sdk/internal";
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

export const writeRegistry = (home: string, runs: readonly WorkflowRun[]): void => {
  mkdirSync(home, { recursive: true });
  const file = { version: 1, runs: Object.fromEntries(runs.map((run) => [run.id, run])) };
  writeFileSync(join(home, "registry.json"), JSON.stringify(file));
};

export const readRegistry = (home: string) =>
  RegistryFileSchema.parse(JSON.parse(readFileSync(join(home, "registry.json"), "utf8")));

// An initialized run named NAME in cwd, as `orchestrate init` leaves it.
export const initializedRun = (home: string, cwd: string, name = "feat-x"): WorkflowRun => {
  const run = savedRun(cwd, { name });
  writeRegistry(home, [run]);
  mkdirSync(runDirOf(cwd, name), { recursive: true });
  return run;
};

export const eventsOf = (cwd: string, name = "feat-x") =>
  jsonlEventStore(runDirOf(cwd, name)).read();

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

export const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
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
export const startedRun = (
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
